import { getIdToken } from './auth';
import type { Transaction } from './types';

const API_BASE = '/api/transactions';

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
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
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
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const data: { transactions: Transaction[] } = await res.json();
  return data.transactions;
}
