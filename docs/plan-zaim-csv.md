# Plan: zaim-csv

## Overview

Zaim の CSV ファイルをブラウザ上でドラッグ&ドロップまたはファイル選択して読み込み、
月別支出推移・カテゴリ内訳・収支バランスをインタラクティブに可視化する静的 Web アプリ。
全データはブラウザ内のみで処理し、外部サーバーには送信しない。

**スタック:** Vite + TypeScript + Chart.js + PapaParse

---

## Tasks

### Task 1: プロジェクト初期化

- **File(s):** `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`
- **Change:**
  ```
  npm create vite@latest . -- --template vanilla-ts
  npm install chart.js papaparse
  npm install -D @types/papaparse
  ```
- **Why:** Vite + TypeScript のボイラープレートを生成し、依存関係を追加する

---

### Task 2: Zaim CSV の型定義とパーサー

- **File(s):** `src/types.ts`, `src/parser.ts`
- **Change:**

  `src/types.ts`:
  ```typescript
  export type TransactionType = 'payment' | 'income' | 'transfer';

  export interface ZaimRow {
    date: string;          // YYYY-MM-DD
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
    aggregation: string;   // '集計に含めない' の行はグラフから除外
  }
  ```

  `src/parser.ts`:
  ```typescript
  import Papa from 'papaparse';
  import type { ZaimRow } from './types';

  export function parseZaimCsv(file: File): Promise<ZaimRow[]>
  // PapaParse で CSV をパース → ZaimRow[] に変換
  // 数値カラムは parseFloat（既に 0 が入っているため空文字対策は不要）
  // aggregation === '集計に含めない' の行はデフォルトで除外
  // 除外フラグを引数で切り替えられるようにする
  ```
- **Why:** CSV の生データを型付きオブジェクトに変換するレイヤーを分離する

---

### Task 3: 集計ロジック

- **File(s):** `src/aggregator.ts`
- **Change:**
  ```typescript
  // 月別支出合計: { '2024-03': 45000, '2024-04': 38000, ... }
  export function sumByMonth(rows: ZaimRow[]): Record<string, number>

  // カテゴリ別支出合計（指定月）: { '食費': 12000, '交通費': 5000, ... }
  export function sumByCategory(rows: ZaimRow[], month: string): Record<string, number>

  // 月別収支: { '2024-03': { income: 280000, expense: 120000 }, ... }
  export function incomeVsExpense(rows: ZaimRow[]): Record<string, { income: number; expense: number }>
  ```
- **Why:** 描画ロジックから集計ロジックを分離してテストしやすくする

---

### Task 4: UI — ファイル取り込みエリア

- **File(s):** `src/main.ts`, `src/style.css`, `index.html`
- **Change:**
  - ドラッグ&ドロップ + `<input type="file">` でCSVを受け取る
  - 読み込み中はスピナーを表示
  - 複数ファイルを選択した場合は全て結合して処理
  - ファイル名・件数をヘッダーに表示
- **Why:** ユーザーが CSV を操作する唯一の入口

---

### Task 5: グラフ描画

- **File(s):** `src/charts.ts`
- **Change:**

  以下の4チャートを Chart.js で描画。各関数は `canvas` 要素と集計データを受け取る。

  ```typescript
  // ① 月別支出合計（棒グラフ）
  export function renderMonthlyExpense(canvas: HTMLCanvasElement, data: Record<string, number>): void

  // ② カテゴリ別内訳（ドーナツグラフ）
  export function renderCategoryBreakdown(canvas: HTMLCanvasElement, data: Record<string, number>): void

  // ③ 収入 vs 支出（積み上げ棒グラフ）
  export function renderIncomeVsExpense(canvas: HTMLCanvasElement, data: Record<string, { income: number; expense: number }>): void

  // ④ カテゴリ別月次推移（折れ線グラフ、上位5カテゴリ）
  export function renderCategoryTrend(canvas: HTMLCanvasElement, rows: ZaimRow[]): void
  ```
- **Why:** グラフ種別ごとに関数を分けて差し替えやすくする

---

### Task 6: 月フィルター UI

- **File(s):** `src/main.ts`, `index.html`
- **Change:**
  - データ読み込み後、存在する月の一覧を `<select>` に表示
  - 月を変更するたびにカテゴリ内訳グラフ（Task 5 ②）を再描画
- **Why:** カテゴリ内訳は月単位で見るのが自然なため

---

### Task 7: スタイリング

- **File(s):** `src/style.css`
- **Change:**
  - ダークモード対応のシンプルな2カラムレイアウト
  - グラフカード: 白背景、角丸、shadow
  - ドロップゾーン: dashed border、hover でハイライト
  - レスポンシブ（モバイルでは1カラム）
- **Why:** 実用的に使えるデザインにする

---

## Task Order

1 → 2 → 3 → 4 → 5 → 6 → 7

Task 2 と 3 は依存なしなので並行可能。
Task 4 は Task 2 完了後。Task 5 は Task 3 完了後。

---

## Trade-offs & Alternatives

- **素の HTML vs Vite+TS:** TS を選択。ZaimRow の型が CSV のカラムと合っているかをコンパイル時に検証できる。
- **Chart.js vs D3.js:** Chart.js を選択。D3 は自由度が高いが今回の用途には過剰。
- **状態管理ライブラリ:** 使わない。データフローが「CSVロード → 集計 → 描画」の一方向なため不要。

---

## Out of Scope

- サーバーサイド処理・データ保存（IndexedDB 等）
- Zaim API 連携（手動 CSV 取り込みのみ）
- カテゴリ編集・トランザクション一覧表示
- PWA 化・オフライン対応
