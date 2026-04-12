import {
  Chart,
  BarElement,
  LineElement,
  ArcElement,
  CategoryScale,
  LinearScale,
  PointElement,
  Tooltip,
  Legend,
} from 'chart.js';
import type { Transaction } from './types';

Chart.register(
  BarElement,
  LineElement,
  ArcElement,
  CategoryScale,
  LinearScale,
  PointElement,
  Tooltip,
  Legend
);

// Track chart instances so they can be destroyed on re-render
const chartInstances = new Map<HTMLCanvasElement, Chart>();

function destroyIfExists(canvas: HTMLCanvasElement): void {
  const existing = chartInstances.get(canvas);
  if (existing) {
    existing.destroy();
    chartInstances.delete(canvas);
  }
}

// Returns sorted unique YYYY-MM strings from data
function getMonths(data: Transaction[]): string[] {
  const months = new Set(data.map((t) => t.date.slice(0, 7)));
  return [...months].sort();
}

// ① 月別支出合計（棒グラフ）
export function renderMonthlyExpense(
  canvas: HTMLCanvasElement,
  data: Transaction[]
): void {
  destroyIfExists(canvas);
  const months = getMonths(data);
  const totals = months.map((m) =>
    data
      .filter((t) => t.date.startsWith(m) && t.type === 'payment')
      .reduce((sum, t) => sum + t.expense, 0)
  );
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [{ label: '支出合計', data: totals, backgroundColor: '#1976d2' }],
    },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });
  chartInstances.set(canvas, chart);
}

// ② カテゴリ別内訳（ドーナツグラフ）
export function renderCategoryBreakdown(
  canvas: HTMLCanvasElement,
  data: Transaction[]
): void {
  destroyIfExists(canvas);
  const payments = data.filter((t) => t.type === 'payment');
  const totals = new Map<string, number>();
  for (const t of payments) {
    totals.set(t.category, (totals.get(t.category) ?? 0) + t.expense);
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const labels = sorted.map(([k]) => k);
  const values = sorted.map(([, v]) => v);
  const palette = [
    '#1976d2', '#388e3c', '#f57c00', '#7b1fa2', '#c62828',
    '#00838f', '#558b2f', '#4527a0', '#ef6c00', '#2e7d32',
  ];
  const chart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: palette.slice(0, labels.length) }],
    },
    options: { responsive: true },
  });
  chartInstances.set(canvas, chart);
}

// ③ 収入 vs 支出（積み上げ棒グラフ）
export function renderIncomeVsExpense(
  canvas: HTMLCanvasElement,
  data: Transaction[]
): void {
  destroyIfExists(canvas);
  const months = getMonths(data);
  const incomes = months.map((m) =>
    data
      .filter((t) => t.date.startsWith(m) && t.type === 'income')
      .reduce((sum, t) => sum + t.income, 0)
  );
  const expenses = months.map((m) =>
    data
      .filter((t) => t.date.startsWith(m) && t.type === 'payment')
      .reduce((sum, t) => sum + t.expense, 0)
  );
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [
        { label: '収入', data: incomes, backgroundColor: '#388e3c', stack: 'stack' },
        { label: '支出', data: expenses, backgroundColor: '#c62828', stack: 'stack' },
      ],
    },
    options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true } } },
  });
  chartInstances.set(canvas, chart);
}

// ④ カテゴリ別月次推移（折れ線グラフ、上位5カテゴリ）
export function renderCategoryTrend(
  canvas: HTMLCanvasElement,
  data: Transaction[]
): void {
  destroyIfExists(canvas);
  const months = getMonths(data);
  const payments = data.filter((t) => t.type === 'payment');

  // Find top-5 categories by total expense
  const totals = new Map<string, number>();
  for (const t of payments) {
    totals.set(t.category, (totals.get(t.category) ?? 0) + t.expense);
  }
  const top5 = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat]) => cat);

  const colors = ['#1976d2', '#388e3c', '#f57c00', '#7b1fa2', '#c62828'];

  const datasets = top5.map((cat, i) => ({
    label: cat,
    data: months.map((m) =>
      payments
        .filter((t) => t.date.startsWith(m) && t.category === cat)
        .reduce((sum, t) => sum + t.expense, 0)
    ),
    borderColor: colors[i],
    backgroundColor: colors[i] + '33',
    fill: false,
    tension: 0.3,
  }));

  const chart = new Chart(canvas, {
    type: 'line',
    data: { labels: months, datasets },
    options: { responsive: true },
  });
  chartInstances.set(canvas, chart);
}
