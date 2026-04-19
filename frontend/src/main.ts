import { Amplify } from 'aws-amplify';
import { signIn, signOut, getCurrentUser } from './auth';
import { parseZaimCsv } from './parser';
import { uploadTransactions, fetchTransactions } from './api';
import {
  renderMonthlyExpense,
  renderCategoryBreakdown,
  renderIncomeVsExpense,
  renderCategoryTrend,
} from './charts';
import type { Transaction } from './types';

// Configure Amplify — values injected at build time via Vite env vars
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID as string,
      userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID as string,
    },
  },
});

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const authScreen = document.getElementById('auth-screen') as HTMLDivElement;
const mainScreen = document.getElementById('main-screen') as HTMLDivElement;
const emailInput = document.getElementById('email') as HTMLInputElement;
const passwordInput = document.getElementById('password') as HTMLInputElement;
const loginBtn = document.getElementById('login-btn') as HTMLButtonElement;
const authError = document.getElementById('auth-error') as HTMLParagraphElement;
const logoutBtn = document.getElementById('logout-btn') as HTMLButtonElement;
const dropZone = document.getElementById('drop-zone') as HTMLDivElement;
const csvInput = document.getElementById('csv-input') as HTMLInputElement;
const statusMsg = document.getElementById('status-msg') as HTMLParagraphElement;
const fromFilter = document.getElementById('from-filter') as HTMLInputElement;
const toFilter = document.getElementById('to-filter') as HTMLInputElement;
const includeNonAggregated = document.getElementById('include-non-aggregated') as HTMLInputElement;
const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;

const canvasMonthly = document.getElementById('chart-monthly-expense') as HTMLCanvasElement;
const canvasCategory = document.getElementById('chart-category-breakdown') as HTMLCanvasElement;
const canvasIncome = document.getElementById('chart-income-vs-expense') as HTMLCanvasElement;
const canvasTrend = document.getElementById('chart-category-trend') as HTMLCanvasElement;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function init(): Promise<void> {
  const user = await getCurrentUser();
  if (user) {
    showMain();
    await loadAndRender();
  } else {
    showAuth();
  }
}

function showAuth(): void {
  authScreen.style.display = 'flex';
  mainScreen.style.display = 'none';
}

function showMain(): void {
  authScreen.style.display = 'none';
  mainScreen.style.display = 'block';
}

loginBtn.addEventListener('click', async () => {
  authError.textContent = '';
  try {
    await signIn(emailInput.value.trim(), passwordInput.value);
    showMain();
    await loadAndRender();
  } catch (err) {
    authError.textContent = err instanceof Error ? err.message : 'ログインに失敗しました';
  }
});

logoutBtn.addEventListener('click', async () => {
  await signOut();
  showAuth();
});

// ---------------------------------------------------------------------------
// CSV upload
// ---------------------------------------------------------------------------
async function makeTxId(row: import('./types').ZaimRow): Promise<string> {
  const raw = [
    row.date, row.type, row.category, row.subcategory,
    row.shop, row.item, row.memo,
    String(row.income), String(row.expense), String(row.transfer),
  ].join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
  return `${row.date}#${hex}`;
}

async function handleFile(file: File): Promise<void> {
  setStatus('パース中…');
  try {
    const excludeNonAgg = !includeNonAggregated.checked;
    const rows = await parseZaimCsv(file, excludeNonAgg);

    const transactions: Transaction[] = await Promise.all(
      rows.map(async (row) => ({
        txId: await makeTxId(row),
        date: row.date,
        type: row.type,
        category: row.category,
        subcategory: row.subcategory,
        shop: row.shop,
        income: row.income,
        expense: row.expense,
        transfer: row.transfer,
        aggregation: row.aggregation,
      }))
    );

    setStatus('アップロード中…');
    const result = await uploadTransactions(transactions);
    setStatus(`${result.saved} 件を保存しました`);
    await loadAndRender();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : 'エラーが発生しました', true);
  }
}

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file) handleFile(file);
});

csvInput.addEventListener('change', () => {
  const file = csvInput.files?.[0];
  if (file) handleFile(file);
});

// ---------------------------------------------------------------------------
// Load & render
// ---------------------------------------------------------------------------
async function loadAndRender(): Promise<void> {
  setStatus('データを取得中…');
  try {
    const from = fromFilter.value ? fromFilter.value + '-01' : undefined;
    const to = toFilter.value
      ? (() => {
          const [y, m] = toFilter.value.split('-').map(Number);
          const lastDay = new Date(y, m, 0).getDate(); // day 0 of month m+1 = last day of month m
          return `${toFilter.value}-${String(lastDay).padStart(2, '0')}`;
        })()
      : undefined;
    const transactions = await fetchTransactions(from, to);
    renderAll(transactions);
    setStatus(`${transactions.length} 件のデータを表示中`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : 'データ取得エラー', true);
  }
}

function renderAll(data: Transaction[]): void {
  renderMonthlyExpense(canvasMonthly, data);
  renderCategoryBreakdown(canvasCategory, data);
  renderIncomeVsExpense(canvasIncome, data);
  renderCategoryTrend(canvasTrend, data);
}

loadBtn.addEventListener('click', loadAndRender);

function setStatus(msg: string, isError = false): void {
  statusMsg.textContent = msg;
  statusMsg.className = isError ? 'error' : '';
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
init();
