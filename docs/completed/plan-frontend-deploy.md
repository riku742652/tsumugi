# Plan: frontend-deploy

## Overview

`frontend/**` への push または手動トリガーで Vite フロントエンドをビルドし、
S3 バケット `zaim-csv-frontend` へ同期後 CloudFront キャッシュを無効化する
独立した GitHub Actions ワークフロー `.github/workflows/frontend-deploy.yml` を新規追加する。
既存の `terraform-apply.yml` の認証パターン（OIDC、`aws-actions/configure-aws-credentials@v4`）に統一し、
Terraform/Terragrunt への依存は持たない。

---

## Tasks

### Task 1: `.github/workflows/frontend-deploy.yml` を新規作成する

- **File:** `.github/workflows/frontend-deploy.yml`
- **Change:** 以下の完成形 YAML をそのまま配置する。

```yaml
name: Frontend Deploy

on:
  workflow_dispatch:
  push:
    paths:
      - "frontend/**"

permissions:
  id-token: write   # OIDC
  contents: read

env:
  AWS_REGION: "ap-northeast-1"
  S3_BUCKET: "zaim-csv-frontend"

jobs:
  deploy:
    name: "build & deploy frontend"
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: frontend/package-lock.json

      - name: Install dependencies
        working-directory: frontend
        run: npm ci

      - name: Build
        working-directory: frontend
        env:
          VITE_COGNITO_USER_POOL_ID: ${{ secrets.VITE_COGNITO_USER_POOL_ID }}
          VITE_COGNITO_CLIENT_ID: ${{ secrets.VITE_COGNITO_CLIENT_ID }}
        run: npm run build

      - name: Sync to S3
        run: |
          aws s3 sync frontend/dist/ s3://${{ env.S3_BUCKET }} --delete

      - name: Invalidate CloudFront cache
        run: |
          aws cloudfront create-invalidation \
            --distribution-id ${{ secrets.CF_DISTRIBUTION_ID }} \
            --paths "/*"
```

- **Why:** フロントエンドのデプロイを Terraform apply から分離することで、コード変更のたびに Terraform を動かすコストとリスクをなくす。OIDC・アクションバージョンを既存ワークフローと揃えることで、ロール・バージョン管理の一元化を維持する。

---

### Task 2: GitHub Secrets に 3 つの値を登録する

- **File:** GitHub リポジトリ設定（コードファイルではない）
- **Change:** Settings → Secrets and variables → Actions → New repository secret で以下を追加する。

| Secret 名 | 値の取得方法 |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | 既存登録済み — 変更不要 |
| `CF_DISTRIBUTION_ID` | AWS コンソール → CloudFront → Distributions → `zaim-csv` の Distribution ID 列（`E` から始まる文字列）をコピー。または `aws cloudfront list-distributions --query "DistributionList.Items[?Origins.Items[?DomainName=='zaim-csv-frontend.s3.ap-northeast-1.amazonaws.com']].Id" --output text` |
| `VITE_COGNITO_USER_POOL_ID` | AWS コンソール → Cognito → User Pools → zaim-csv → "User pool ID"（例: `ap-northeast-1_XXXXXXXXX`）。または `aws cognito-idp list-user-pools --max-results 10 --query "UserPools[?Name=='zaim-csv'].Id" --output text` |
| `VITE_COGNITO_CLIENT_ID` | Cognito → zaim-csv → App clients → クライアント ID。または `aws cognito-idp list-user-pool-clients --user-pool-id <上記ID> --query "UserPoolClients[0].ClientId" --output text` |

- **Why:** VITE_* 変数はビルド時に静的埋め込みされるため、CI が Secret として注入しなければ実行時に `undefined` になる。Distribution ID は Terraform state に存在するが、Terraform/Terragrunt をインストールせずに取得する最もシンプルな手段が Secret 手動登録である。

---

### Task 3: IAM ロール `AWS_DEPLOY_ROLE_ARN` にインラインポリシーを追加する

- **File:** IAM コンソール / 既存 Terraform ロール定義（コード管理しているなら `infra/` 内の IAM リソース）
- **Change:** `AWS_DEPLOY_ROLE_ARN` が assume するロールに以下の権限を付与する。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3FrontendDeploy",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetObject"
      ],
      "Resource": [
        "arn:aws:s3:::zaim-csv-frontend",
        "arn:aws:s3:::zaim-csv-frontend/*"
      ]
    },
    {
      "Sid": "CloudFrontInvalidation",
      "Effect": "Allow",
      "Action": "cloudfront:CreateInvalidation",
      "Resource": "arn:aws:cloudfront::<ACCOUNT_ID>:distribution/<CF_DISTRIBUTION_ID>"
    }
  ]
}
```

- `<ACCOUNT_ID>` と `<CF_DISTRIBUTION_ID>` は実際の値に置き換える。
- `s3:GetObject` は `aws s3 sync --delete` が削除対象を特定するために必要。
- 既存ロールが Terraform apply 用に S3 State バケットへの広い権限を持っている場合でも、フロントエンドバケットへの明示的な許可を確認すること。
- **Why:** S3 バケットはパブリックアクセスブロックが有効（OAC 専用）なため、IAM 権限なしでは `aws s3 sync` が `403 AccessDenied` で失敗する。CloudFront のキャッシュ無効化も明示的な許可が必要。

---

## Task Order

1. **Task 3 → Task 2 → Task 1** の順が安全。
   - IAM 権限を先に付与しておかないとワークフロー初回実行が失敗する。
   - Secret を登録してからワークフローファイルをマージすれば、マージ直後の自動トリガー（`push` on `frontend/**`）でも即座に成功する。
   - ただし、YAML ファイルは PR ブランチで `frontend/**` 以外のパスにあるため、ファイル追加自体はトリガーを発火させない（`frontend/**` path filter に引っかからない）。安全にマージ後 `workflow_dispatch` で初回動作確認ができる。

---

## Trade-offs & Alternatives

| 選択肢 | 採用理由 / 却下理由 |
|---|---|
| Distribution ID を `terragrunt output` で動的取得 | Terraform/Terragrunt インストールステップが必要になり、ワークフローが複雑化する。Secret 手動登録のほうがシンプルで、Distribution ID は変わらない値のため採用しない。 |
| VITE_* を Terragrunt output から取得 | 同上。Cognito の Pool ID・Client ID も静的値であり、Secret 登録で十分。 |
| terraform-apply.yml に組み込む | フロントエンドコード変更のたびに Terraform apply が走り、インフラ変更リスクが生じる。関心分離の観点から採用しない。 |
| `push` トリガーのみ（`workflow_dispatch` なし） | 初回動作確認や緊急の手動再デプロイができなくなるため、両方を併用する。 |
| Node.js キャッシュなし | `npm ci` は毎回ネットワークアクセスが発生し遅い。`actions/setup-node@v4` の `cache: "npm"` で `~/.npm` をキャッシュし高速化する。 |

---

## Out of Scope

- Terraform / Terragrunt による S3・CloudFront リソース自体の変更（既存 `terraform-apply.yml` の責務）
- バックエンド（Lambda/ECR）のデプロイ
- ステージング環境対応（現時点では prod のみ）
- E2E テストや Lighthouse CI の組み込み
- `features.json` の更新（Planner の責務外）
