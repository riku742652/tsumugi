# Research: Frontend Deploy (S3 + CloudFront Invalidation) GitHub Actions Workflow

## Relevant Files

- `frontend/package.json` — `build` スクリプトは `tsc && vite build`
- `frontend/vite.config.ts` — `outDir: 'dist'`
- `frontend/src/main.ts` — `import.meta.env.VITE_COGNITO_USER_POOL_ID` / `VITE_COGNITO_CLIENT_ID` を参照
- `infra/modules/cloudfront/main.tf` — `output "frontend_bucket"` (`zaim-csv-frontend`)、`output "distribution_id"`
- `infra/envs/prod/cloudfront/terragrunt.hcl` — `app_name = "zaim-csv"`
- `.github/workflows/terraform-apply.yml` — 既存 CI の認証・アクションバージョン参照元

---

## Existing Patterns

- AWS 認証: `aws-actions/configure-aws-credentials@v4`、OIDC (`role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}`)
- アクションバージョン: `actions/checkout@v4`、`aws-actions/configure-aws-credentials@v4`
- `AWS_REGION: "ap-northeast-1"` をトップレベル `env:` で定義
- `permissions: id-token: write, contents: read`

---

## Key Findings

**S3 バケット名:** `zaim-csv-frontend` — `app_name` + `-frontend` で静的に決定可能。

**CloudFront Distribution ID:** 静的不明。取得方法:
1. GitHub Secret `CF_DISTRIBUTION_ID` に手動登録（最もシンプル）
2. CI 内で `terragrunt output -raw distribution_id` を動的取得（Terraform/Terragrunt インストールが必要）

**Vite 環境変数 (重要):** `frontend/src/main.ts` が以下を参照:
- `VITE_COGNITO_USER_POOL_ID`
- `VITE_COGNITO_CLIENT_ID`

ビルド時に GitHub Secrets または Terragrunt output から注入が必要。

**デプロイフロー:**
1. `npm ci && npm run build` → `frontend/dist/` 生成
2. `aws s3 sync frontend/dist/ s3://zaim-csv-frontend --delete`
3. `aws cloudfront create-invalidation --distribution-id <ID> --paths "/*"`

---

## Constraints & Gotchas

- Node.js 20 以上が必要 (`vite@^5.2.12`)。`actions/setup-node@v4` で指定。
- `AWS_DEPLOY_ROLE_ARN` に `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`, `cloudfront:CreateInvalidation` が必要。
- S3 バケットはパブリックアクセスブロック有効 (OAC 経由 CloudFront のみ)。`aws s3 sync` は IAM 権限で動作。
- `tsc && vite build` は TypeScript エラーで CI が落ちる。

---

## Open Questions (Plan フェーズで解決)

1. **Distribution ID の取得方法** — Secret 手動登録 vs `terragrunt output` 動的取得
2. **VITE_* 変数の供給元** — GitHub Secrets 手動登録 vs Terragrunt output 動的取得
3. **トリガー** — `workflow_dispatch` のみ vs `frontend/**` push でも自動発火
