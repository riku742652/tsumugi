# Plan: zaim-csv

## Overview

Zaim の CSV をアップロードして家計をグラフで可視化する Web アプリ。
AWS 上に構築し、Cognito でログイン、DynamoDB にトランザクションを永続化する。
フロントエンドは Vite + TypeScript、バックエンドは Lambda + API Gateway。

**スタック:**

| レイヤー | 技術 |
|---------|------|
| フロント | Vite + TypeScript + Chart.js + PapaParse + aws-amplify |
| API | AWS Lambda (Node.js 22) + API Gateway (HTTP API) |
| 認証 | Amazon Cognito User Pools |
| DB | Amazon DynamoDB |
| ストレージ | Amazon S3（生CSV + フロント配信） |
| CDN | CloudFront |
| IaC | Terraform + Terragrunt |

---

## ディレクトリ構成

```
tsumugi/
├── frontend/          # Vite + TypeScript
│   ├── src/
│   │   ├── types.ts
│   │   ├── parser.ts
│   │   ├── api.ts
│   │   ├── auth.ts
│   │   ├── charts.ts
│   │   └── main.ts
│   ├── index.html
│   └── package.json
├── backend/           # Lambda functions
│   ├── src/
│   │   ├── handlers/
│   │   │   ├── upload.ts       # CSV アップロード → DynamoDB
│   │   │   └── transactions.ts # トランザクション取得
│   │   └── types.ts
│   └── package.json
└── infra/             # Terraform + Terragrunt
    ├── modules/
    │   ├── cognito/    # User Pool + App Client
    │   ├── dynamodb/   # テーブル + GSI
    │   ├── lambda/     # 関数 + IAM ロール
    │   ├── api_gateway/ # HTTP API + JWT オーソライザー
    │   └── frontend/   # S3 + CloudFront
    └── envs/
        ├── terragrunt.hcl          # ルート設定（backend S3 など）
        └── prod/
            ├── terragrunt.hcl      # 環境変数・モジュール呼び出し
            └── terraform.tfvars
```

---

## Tasks

### Task 1: IaC（Terraform + Terragrunt）— AWS リソース定義

- **File(s):** `infra/modules/*/main.tf`, `infra/envs/prod/terragrunt.hcl`
- **Change:** 以下のリソースを Terraform モジュールで定義し、Terragrunt で環境管理する
  - `modules/cognito` — User Pool + App Client
  - `modules/dynamodb` — テーブル `zaim-transactions`（PK: `userId`, SK: `txId`）、GSI: `userId-date-index`
  - `modules/lambda` — 関数 × 2（upload, transactions）+ IAM ロール
  - `modules/api_gateway` — HTTP API + Cognito JWT オーソライザー
  - `modules/frontend` — S3 バケット + CloudFront ディストリビューション + OAC
  - ルート `terragrunt.hcl` で Terraform state を S3 + DynamoDB（state lock）に設定
- **Why:** Terragrunt でモジュールの依存関係（`dependency` ブロック）を管理し、環境ごとの設定を DRY に保つ

---

### Task 2: 共通型定義

- **File(s):** `frontend/src/types.ts`, `backend/src/types.ts`
- **Change:**

  ```typescript
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
    txId: string;      // {date}#{uuid}
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
  ```
- **Why:** フロントとバックエンドで型を共有してズレを防ぐ

---

### Task 3: フロント — CSV パーサー

- **File(s):** `frontend/src/parser.ts`
- **Change:**
  ```typescript
  export function parseZaimCsv(file: File): Promise<ZaimRow[]>
  // PapaParse でパース → ZaimRow[] に変換
  // type === 'balance' は常に除外
  // aggregation === '集計に含めない' はオプション引数で除外可（デフォルト: 除外）
  ```
- **Why:** CSV → 型付きオブジェクトへの変換を分離する

---

### Task 4: バックエンド — upload Lambda

- **File(s):** `backend/src/handlers/upload.ts`
- **Change:**
  - リクエスト: `{ transactions: Transaction[] }`（JWT から `userId` を取得）
  - DynamoDB の `batchWrite` で一括保存
  - 同じ `txId` がある場合は上書き（冪等性）
  - レスポンス: `{ saved: number }`
- **Why:** CSV データをサーバーサイドで永続化する

---

### Task 5: バックエンド — transactions Lambda

- **File(s):** `backend/src/handlers/transactions.ts`
- **Change:**
  - クエリパラメータ: `?from=2026-01&to=2026-03`（省略時は全件）
  - DynamoDB の GSI `userId-date-index` でレンジクエリ
  - レスポンス: `{ transactions: Transaction[] }`
- **Why:** 保存済みデータをフロントに返す

---

### Task 6: フロント — 認証（Cognito）

- **File(s):** `frontend/src/auth.ts`
- **Change:**
  ```typescript
  // aws-amplify を使って Cognito と連携
  export function signIn(email: string, password: string): Promise<void>
  export function signOut(): Promise<void>
  export function getCurrentUser(): Promise<{ userId: string; email: string } | null>
  export function getIdToken(): Promise<string>  // API リクエストに付与
  ```
- **Why:** ログイン・ログアウト・トークン取得を1箇所にまとめる

---

### Task 7: フロント — API クライアント

- **File(s):** `frontend/src/api.ts`
- **Change:**
  ```typescript
  export async function uploadTransactions(rows: Transaction[]): Promise<{ saved: number }>
  export async function fetchTransactions(from?: string, to?: string): Promise<Transaction[]>
  // 各関数は getIdToken() で JWT を取得して Authorization ヘッダーに付与
  ```
- **Why:** API 通信を1ファイルに集約し、認証ヘッダー付与を統一する

---

### Task 8: フロント — UI（ファイル取り込み + グラフ）

- **File(s):** `frontend/src/main.ts`, `frontend/index.html`, `frontend/src/style.css`
- **Change:**
  - ログイン画面: メール・パスワード入力 → `signIn()`
  - メイン画面:
    - ドラッグ&ドロップ / ファイル選択で CSV 取り込み → `parseZaimCsv()` → `uploadTransactions()`
    - ページ読み込み時に `fetchTransactions()` で保存済みデータ取得
    - 月フィルター `<select>` で期間を絞り込み
    - 集計の設定フィルター（「集計外を含む」トグル）
  - レスポンシブ、ダークモード対応
- **Why:** ユーザーが操作する唯一の画面

---

### Task 9: フロント — グラフ描画

- **File(s):** `frontend/src/charts.ts`
- **Change:**
  ```typescript
  export function renderMonthlyExpense(canvas: HTMLCanvasElement, data: Transaction[]): void    // ① 月別支出（棒）
  export function renderCategoryBreakdown(canvas: HTMLCanvasElement, data: Transaction[]): void // ② カテゴリ内訳（ドーナツ）
  export function renderIncomeVsExpense(canvas: HTMLCanvasElement, data: Transaction[]): void   // ③ 収支（積み上げ棒）
  export function renderCategoryTrend(canvas: HTMLCanvasElement, data: Transaction[]): void     // ④ カテゴリ推移（折れ線）
  // 集計ロジックは各関数内で Transaction[] から計算する
  ```
- **Why:** グラフ種別ごとに関数を分離して差し替えやすくする

---

## Task Order

```
1 (CDK)
  ↓
2 (型定義)
  ↓
┌─────────────────┐
│ 3 (parser)      │  ← フロント系
│ 4 (upload λ)   │  ← バックエンド系（並行可）
│ 5 (fetch λ)    │
└────────┬────────┘
         ↓
┌─────────────────┐
│ 6 (auth)        │
│ 7 (api client)  │  ← 並行可
└────────┬────────┘
         ↓
         8 (UI)
         ↓
         9 (charts)
```

---

## Trade-offs & Alternatives

- **DynamoDB vs RDS:** 集計はすべて Lambda またはフロントで行うため、RDB の JOIN は不要。DynamoDB の方がサーバーレスとの相性が良くコストも低い。
- **Lambda vs ECS:** リクエスト頻度が低い家計アプリにはサーバーレスが適切。
- **Amplify UI vs 自前ログイン画面:** Amplify UI は簡単だが見た目の自由度が低い。今回は `aws-amplify` のロジックだけ使い、UI は自前で実装する。
- **CDK vs Terraform+Terragrunt:** CDK は TypeScript で書けるが Terraform エコシステムとの統一性がない。Terragrunt でモジュールを分割することで各リソースを独立して `plan` / `apply` できる。

---

## Out of Scope

- Zaim API 連携（手動 CSV 取り込みのみ）
- 複数ユーザー間のデータ共有
- カテゴリ編集・トランザクション一覧表示
- CI/CD パイプライン
