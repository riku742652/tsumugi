import { getIdToken, signOut } from './auth';
import type { Transaction } from './types';

const API_BASE = '/api/transactions';

async function handleUnauthorized(res: Response, context: string): Promise<never> {
  if (res.status === 401) {
    try {
      await signOut();
    } finally {
      window.location.href = '/';
    }
  }
  throw new Error(`${context}: ${res.status}`);
}

export async function uploadTransactions(
  rows: Transaction[]
): Promise<{ saved: number }> {
  const token = await getIdToken();
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ transactions: rows }),
  });
  if (!res.ok) return handleUnauthorized(res, 'Upload failed');
  return res.json();
}

export async function fetchTransactions(
  from?: string,
  to?: string
): Promise<Transaction[]> {
  const token = await getIdToken();
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${API_BASE}${query}`, {
    headers: { 'X-Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return handleUnauthorized(res, 'Fetch failed');
  const data: { transactions: Transaction[] } = await res.json();
  return data.transactions;
}
