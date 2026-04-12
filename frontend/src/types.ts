export type TransactionType = 'payment' | 'income' | 'transfer' | 'balance';

export interface ZaimRow {
  date: string;
  type: TransactionType;
  category: string;
  subcategory: string;
  from: string;
  to: string;
  item: string;
  memo: string;
  shop: string;
  currency: string;
  income: number;
  expense: number;
  transfer: number;
  balanceAdjustment: number;
  originalAmount: number;
  aggregation: string;
}

// DB に保存する形式（フロント↔バックエンド共通）
export interface Transaction {
  userId: string;
  txId: string; // {date}#{uuid}
  date: string;
  type: TransactionType;
  category: string;
  subcategory: string;
  shop: string;
  income: number;
  expense: number;
  transfer: number;
  aggregation: string;
}
