# Research: zaim-csv

## Relevant Files

既存コードなし（新規プロジェクト）。本ドキュメントは Zaim CSV フォーマットと技術選定の調査結果。

---

## Zaim CSV エクスポートフォーマット

Zaim プレミアムの「設定 → ファイル入出力 → ダウンロード」から取得できる CSV。
文字コード: UTF-8（BOMなし）、区切り: カンマ。

### カラム一覧（実CSVより確認済み・16列）

| # | カラム名 | 型 | 説明 |
|---|---------|-----|------|
| 1 | 日付 | YYYY-MM-DD | 取引日 |
| 2 | 方法 | 文字列 | **`payment` / `income` / `transfer` / `balance`**（英語） |
| 3 | カテゴリ | 文字列 | 大カテゴリ（食費、交通費 など） |
| 4 | カテゴリの内訳 | 文字列 | 小カテゴリ（外食、電車 など） |
| 5 | 支払元 | 文字列 | 支出元の口座・財布名 |
| 6 | 入金先 | 文字列 | 収入・振替先の口座名 |
| 7 | 品目 | 文字列 | 商品名・品目（任意入力） |
| 8 | メモ | 文字列 | 自由記述メモ |
| 9 | お店 | 文字列 | 店舗名 |
| 10 | 通貨 | 文字列 | `JPY` など |
| 11 | 収入 | 数値 | 収入の場合の金額（0 if N/A） |
| 12 | 支出 | 数値 | 支出の場合の金額（0 if N/A） |
| 13 | 振替 | 数値 | 振替の場合の金額（0 if N/A） |
| 14 | 残高調整 | 数値 | `balance` 行のみ値が入る |
| 15 | 通貨変換前の金額 | 数値 | 外貨取引の元金額 |
| 16 | 集計の設定 | 文字列 | `常に集計に含める` / `集計に含めない` |

### 重要な注意点

- `方法` は英語: `payment` / `income` / `transfer` / `balance`
- 数値カラムは空でなく `0` が入る
- `balance` 行はカードの残高スナップショット → **`集計の設定` に関わらず常に除外**
- `集計の設定 = 集計に含めない` の行は家計外取引（株買付・口座移動など）→ **デフォルト除外、UIで切り替え可**
- カテゴリが `-` の行（balance・transfer）が存在する
- 同日に複数行存在する

### 除外ロジック（優先順位）

```
type === 'balance'           → 常に除外
aggregation === '集計に含めない' → デフォルト除外（UIで切り替え可）
```

---

## アーキテクチャ選定

**要件:** AWS デプロイ、ログイン機能、データ永続化

### 構成図

```
ブラウザ
  │
  ├─ CloudFront + S3          ← フロントエンド（Vite + TypeScript）
  │
  └─ API Gateway
       │
       ├─ Lambda              ← API ロジック（Node.js / TypeScript）
       │    │
       │    ├─ Cognito        ← 認証（User Pools + JWT）
       │    │
       │    └─ DynamoDB       ← トランザクション永続化
       │
       └─ S3                  ← アップロードされた生 CSV の保存
```

### 各サービスの選定理由

| サービス | 役割 | 代替案と却下理由 |
|---------|------|----------------|
| **Cognito User Pools** | ログイン・JWT発行 | Auth0（外部依存）、自前実装（セキュリティリスク） |
| **API Gateway + Lambda** | REST API | ECS（コスト高）、EC2（管理コスト高） |
| **DynamoDB** | トランザクション永続化 | RDS（集計クエリは Lambda 側で処理するため不要）、S3 Select（遅い） |
| **S3** | 生CSV保存・フロント配信 | — |
| **CloudFront** | CDN・HTTPS | — |

### DynamoDB データモデル

**テーブル名:** `zaim-transactions`

| 属性 | 型 | 役割 |
|-----|----|------|
| `userId` (PK) | String | Cognito の `sub` |
| `txId` (SK) | String | `{date}#{uuid}` |
| `date` | String | YYYY-MM-DD |
| `type` | String | payment / income / transfer / balance |
| `category` | String | |
| `subcategory` | String | |
| `shop` | String | |
| `income` | Number | |
| `expense` | Number | |
| `transfer` | Number | |
| `aggregation` | String | 集計の設定 |
| `rawCsvKey` | String | S3 の CSV ファイルキー（任意） |

GSI: `userId + date` でレンジクエリ（月別取得）

---

## フロントエンド技術選定

| 役割 | 選択 | 理由 |
|------|------|------|
| ビルド | Vite + TypeScript | 型安全、静的ビルド可能 |
| CSV パース | PapaParse | ブラウザ対応、日本語OK |
| グラフ | Chart.js | 軽量、棒・折れ線・ドーナツ対応 |
| API 通信 | fetch（標準） | ライブラリ不要 |
| 認証 | AWS Amplify JS (`aws-amplify`) | Cognito との統合が最も簡単 |

---

## 表示グラフ（案）

1. **月別支出合計** — 棒グラフ
2. **カテゴリ別内訳** — ドーナツグラフ（月フィルター付き）
3. **収入 vs 支出** — 積み上げ棒グラフ
4. **カテゴリ別月次推移** — 折れ線グラフ（上位5カテゴリ）

---

## Open Questions

1. **グラフの種類・優先度** — 4種すべて作るか？
2. **期間フィルター** — 月単位 / 年単位 / カスタム？
3. **複数CSVの統合** — 複数年分をまとめてアップロード可能にするか？
4. **IaC** — Terraform + Terragrunt（確定）
