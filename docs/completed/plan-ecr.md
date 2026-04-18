# Plan: ECR Repository Management via Terraform/Terragrunt

## Overview

Add a dedicated ECR Terraform module and Terragrunt env config for the `zaim-csv-api` container repository, refactor the Lambda module to accept the ECR ARN as an explicit variable (removing the fragile string-parsing locals block), wire a formal Terragrunt `dependency "ecr"` in the Lambda env config so `run-all apply` respects ordering, add `ecr` to the CI Terraform workflow, and introduce a new `ecr-push.yml` GitHub Actions workflow that builds and pushes the Docker image on `backend/**` changes or manual trigger. This makes the ECR repository a first-class infrastructure resource instead of an implicit contract baked into a URI string.

---

## Tasks

### Task 1: Create infra/modules/ecr/main.tf

- **File:** `infra/modules/ecr/main.tf`
- **Change:** New file. Follows the single-file module convention (variables, resource, outputs all in one file). No provider or backend blocks — those are injected by Terragrunt root config.

**Full file content (new):**

```hcl
variable "app_name" {
  type = string
}

variable "repo_name" {
  type        = string
  description = "ECR repository name (e.g. zaim-csv-api)"
}

resource "aws_ecr_repository" "this" {
  name                 = var.repo_name
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    app = var.app_name
  }
}

output "repository_url" {
  value = aws_ecr_repository.this.repository_url
}

output "repository_arn" {
  value = aws_ecr_repository.this.arn
}
```

- **Why:** Creates the ECR repository as a tracked resource. Outputs `repository_url` (used by Lambda env to construct `image_uri`) and `repository_arn` (used by Lambda module for the IAM policy). `MUTABLE` is required because the `:latest` tag is reused on every push.

---

### Task 2: Create infra/envs/prod/ecr/terragrunt.hcl

- **File:** `infra/envs/prod/ecr/terragrunt.hcl`
- **Change:** New file. No `dependency` blocks (ECR has zero dependencies in the graph). Passes `app_name` and `repo_name`.

**Full file content (new):**

```hcl
include "root" {
  path = find_in_parent_folders("terragrunt.hcl")
}

terraform {
  source = "../../../modules/ecr"
}

inputs = {
  app_name  = "zaim-csv"
  repo_name = "zaim-csv-api"
}
```

- **Why:** Instantiates the ECR module in the prod environment. State key becomes `prod/ecr/terraform.tfstate` under the `tsumugi-tfstate` S3 bucket (derived from `path_relative_to_include()`).

---

### Task 3: Modify infra/modules/lambda/main.tf — remove locals block, add variable, use variable in IAM policy

- **File:** `infra/modules/lambda/main.tf`
- **Change:** Add `variable "ecr_repository_arn"`, remove the `locals` block (lines 34–37) and the two `data` sources that support it, replace `local.ecr_repo_arn` with `var.ecr_repository_arn` in the IAM policy resource.

**Before (lines 1–96, showing the affected sections):**

```hcl
variable "app_name" {
  type = string
}

variable "image_uri" {
  type        = string
  description = "ECR image URI for the Lambda function"
}

variable "dynamodb_table_arn" {
  type = string
}

variable "dynamodb_table_name" {
  type = string
}

variable "cognito_issuer" {
  type = string
}

variable "cognito_client_id" {
  type = string
}

variable "cloudfront_domain" {
  type    = string
  default = ""
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  ecr_repo_name = split(":", split("/", var.image_uri)[1])[0]
  ecr_repo_arn  = "arn:aws:ecr:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:repository/${local.ecr_repo_name}"
}

# ... (rest of file unchanged until the ecr policy resource)

resource "aws_iam_role_policy" "ecr" {
  name = "ecr-access"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = local.ecr_repo_arn
      },
    ]
  })
}
```

**After (full file content):**

```hcl
variable "app_name" {
  type = string
}

variable "image_uri" {
  type        = string
  description = "ECR image URI for the Lambda function"
}

variable "ecr_repository_arn" {
  type        = string
  description = "ARN of the ECR repository that holds the Lambda container image"
}

variable "dynamodb_table_arn" {
  type = string
}

variable "dynamodb_table_name" {
  type = string
}

variable "cognito_issuer" {
  type = string
}

variable "cognito_client_id" {
  type = string
}

variable "cloudfront_domain" {
  type    = string
  default = ""
}

# Secrets Manager: X-Origin-Secret
resource "random_password" "origin_secret" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "origin_secret" {
  name                    = "${var.app_name}/origin-secret"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "origin_secret" {
  secret_id     = aws_secretsmanager_secret.origin_secret.id
  secret_string = random_password.origin_secret.result
}

# IAM role for Lambda
resource "aws_iam_role" "lambda" {
  name = "${var.app_name}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "ecr" {
  name = "ecr-access"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = var.ecr_repository_arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "dynamodb" {
  name = "dynamodb-access"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:PutItem",
        "dynamodb:BatchWriteItem",
        "dynamodb:GetItem",
        "dynamodb:Query",
      ]
      Resource = [
        var.dynamodb_table_arn,
        "${var.dynamodb_table_arn}/index/*",
      ]
    }]
  })
}

resource "aws_iam_role_policy" "secrets" {
  name = "secrets-access"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.origin_secret.arn
    }]
  })
}

# Lambda function
resource "aws_lambda_function" "api" {
  function_name = "${var.app_name}-api"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = var.image_uri
  timeout       = 30
  memory_size   = 512

  depends_on = [
    aws_iam_role_policy_attachment.lambda_basic,
    aws_iam_role_policy.ecr,
    aws_iam_role_policy.dynamodb,
    aws_iam_role_policy.secrets,
  ]

  environment {
    variables = {
      AWS_LWA_PORT      = "8080"
      DYNAMODB_TABLE    = var.dynamodb_table_name
      COGNITO_ISSUER    = var.cognito_issuer
      COGNITO_CLIENT_ID = var.cognito_client_id
      ORIGIN_SECRET_ARN = aws_secretsmanager_secret.origin_secret.arn
      CLOUDFRONT_DOMAIN = var.cloudfront_domain
    }
  }
}

# Lambda Function URL (auth: NONE — protected by X-Origin-Secret)
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"

  cors {
    allow_credentials = false
    allow_origins     = ["*"]
    allow_methods     = ["*"]
    allow_headers     = ["*"]
    max_age           = 0
  }
}

output "function_url" {
  value = aws_lambda_function_url.api.function_url
}

output "function_arn" {
  value = aws_lambda_function.api.arn
}

output "origin_secret_arn" {
  value = aws_secretsmanager_secret.origin_secret.arn
}

output "origin_secret_value" {
  value     = random_password.origin_secret.result
  sensitive = true
}
```

- **Why:** Removes the string-parsing `locals` block and the two `data` sources (`aws_region`, `aws_caller_identity`) that existed solely to reconstruct the ECR ARN from the URI string. The ARN is now supplied directly as `var.ecr_repository_arn`, making the module's contract explicit and eliminating the implicit coupling to a particular URI format.

---

### Task 4: Modify infra/envs/prod/lambda/terragrunt.hcl — add ecr dependency, remove run_cmd locals, derive image_uri and pass ecr_repository_arn

- **File:** `infra/envs/prod/lambda/terragrunt.hcl`
- **Change:** Remove the `locals` block containing `run_cmd`, add `dependency "ecr"` with appropriate mock outputs, update `inputs` to derive `image_uri` from the ECR output and pass `ecr_repository_arn`.

**Before:**

```hcl
include "root" {
  path = find_in_parent_folders("terragrunt.hcl")
}

terraform {
  source = "../../../modules/lambda"
}

locals {
  account_id = run_cmd("--terragrunt-quiet", "aws", "sts", "get-caller-identity", "--query", "Account", "--output", "text")
}

dependency "cognito" {
  config_path = "../cognito"
  mock_outputs = {
    issuer    = "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_mock"
    client_id = "mockclientid"
  }
}

dependency "dynamodb" {
  config_path = "../dynamodb"
  mock_outputs = {
    table_arn  = "arn:aws:dynamodb:ap-northeast-1:123456789012:table/zaim-transactions"
    table_name = "zaim-transactions"
  }
}

inputs = {
  app_name            = "zaim-csv"
  image_uri           = "${local.account_id}.dkr.ecr.ap-northeast-1.amazonaws.com/zaim-csv-api:latest"
  dynamodb_table_arn  = dependency.dynamodb.outputs.table_arn
  dynamodb_table_name = dependency.dynamodb.outputs.table_name
  cognito_issuer      = dependency.cognito.outputs.issuer
  cognito_client_id   = dependency.cognito.outputs.client_id
}
```

**After:**

```hcl
include "root" {
  path = find_in_parent_folders("terragrunt.hcl")
}

terraform {
  source = "../../../modules/lambda"
}

dependency "ecr" {
  config_path = "../ecr"
  mock_outputs = {
    repository_url = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/zaim-csv-api"
    repository_arn = "arn:aws:ecr:ap-northeast-1:123456789012:repository/zaim-csv-api"
  }
}

dependency "cognito" {
  config_path = "../cognito"
  mock_outputs = {
    issuer    = "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_mock"
    client_id = "mockclientid"
  }
}

dependency "dynamodb" {
  config_path = "../dynamodb"
  mock_outputs = {
    table_arn  = "arn:aws:dynamodb:ap-northeast-1:123456789012:table/zaim-transactions"
    table_name = "zaim-transactions"
  }
}

inputs = {
  app_name            = "zaim-csv"
  image_uri           = "${dependency.ecr.outputs.repository_url}:latest"
  ecr_repository_arn  = dependency.ecr.outputs.repository_arn
  dynamodb_table_arn  = dependency.dynamodb.outputs.table_arn
  dynamodb_table_name = dependency.dynamodb.outputs.table_name
  cognito_issuer      = dependency.cognito.outputs.issuer
  cognito_client_id   = dependency.cognito.outputs.client_id
}
```

- **Why:** Removes the `run_cmd` call that shells out to the AWS CLI at plan time (fragile, requires AWS credentials on the Terragrunt host during `init`). The ECR `repository_url` output already contains the fully-qualified registry hostname including account ID and region, so appending `:latest` produces the correct `image_uri`. The formal `dependency "ecr"` block also ensures that `run-all apply` will not proceed to Lambda until ECR state is available.

---

### Task 5: Modify .github/workflows/terraform-apply.yml — 単一ワークフローでECR apply + image push + 残モジュール apply を完結させる

- **File:** `.github/workflows/terraform-apply.yml`
- **Change:** `ecr` をモジュール選択肢に追加し、`module=all` の場合は以下の3段階に分割する:
  1. Group 1 apply: `cognito` / `dynamodb` / `ecr` を `run-all` で並列適用
  2. ECR Login + Docker build/push (Group 1 完了後)
  3. Group 2+3 apply: `lambda` / `cloudfront` を `run-all` で適用

  `ecr-push.yml` は不要になるため作成しない。

**Before:**

```yaml
    inputs:
      module:
        description: "Module to apply (cognito / dynamodb / lambda / cloudfront / all)"
        required: true
        default: "all"
        type: choice
        options:
          - all
          - cognito
          - dynamodb
          - lambda
          - cloudfront
```

and:

```yaml
      - name: Terragrunt run-all apply (all modules)
        if: inputs.module == 'all'
        run: |
          terragrunt run-all init --terragrunt-non-interactive
          terragrunt run-all apply --terragrunt-non-interactive -auto-approve \
            --terragrunt-include-dir cognito \
            --terragrunt-include-dir dynamodb \
            --terragrunt-include-dir lambda \
            --terragrunt-include-dir cloudfront
```

**After (full file):**

```yaml
name: Terraform Apply

on:
  workflow_dispatch:
    inputs:
      module:
        description: "Module to apply (cognito / dynamodb / ecr / lambda / cloudfront / all)"
        required: true
        default: "all"
        type: choice
        options:
          - all
          - cognito
          - dynamodb
          - ecr
          - lambda
          - cloudfront
      env:
        description: "Environment"
        required: true
        default: "prod"
        type: choice
        options:
          - prod

permissions:
  id-token: write   # OIDC
  contents: read

env:
  TF_VERSION: "1.7.5"
  TG_VERSION: "0.55.18"
  AWS_REGION: "ap-northeast-1"
  ECR_REPOSITORY: "zaim-csv-api"

jobs:
  apply:
    name: "terragrunt apply (${{ inputs.module }})"
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: infra/envs/${{ inputs.env }}

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: ${{ env.TF_VERSION }}
          terraform_wrapper: false

      - name: Setup Terragrunt
        run: |
          curl -sL "https://github.com/gruntwork-io/terragrunt/releases/download/v${{ env.TG_VERSION }}/terragrunt_linux_amd64" \
            -o /usr/local/bin/terragrunt
          chmod +x /usr/local/bin/terragrunt
          terragrunt --version

      # --- single module ---
      - name: Terragrunt init + apply (single module)
        if: inputs.module != 'all'
        working-directory: infra/envs/${{ inputs.env }}/${{ inputs.module }}
        run: |
          terragrunt init --terragrunt-non-interactive
          terragrunt apply --terragrunt-non-interactive -auto-approve

      # --- all modules: Group 1 (cognito / dynamodb / ecr) ---
      - name: "Apply Group 1 — cognito / dynamodb / ecr"
        if: inputs.module == 'all'
        run: |
          terragrunt run-all init --terragrunt-non-interactive \
            --terragrunt-include-dir cognito \
            --terragrunt-include-dir dynamodb \
            --terragrunt-include-dir ecr
          terragrunt run-all apply --terragrunt-non-interactive -auto-approve \
            --terragrunt-include-dir cognito \
            --terragrunt-include-dir dynamodb \
            --terragrunt-include-dir ecr

      # --- all modules: build & push image (requires ECR to exist) ---
      - name: Login to Amazon ECR
        if: inputs.module == 'all'
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push Docker image
        if: inputs.module == 'all'
        env:
          REGISTRY: ${{ steps.login-ecr.outputs.registry }}
        run: |
          docker build \
            -t "$REGISTRY/$ECR_REPOSITORY:latest" \
            backend/
          docker push "$REGISTRY/$ECR_REPOSITORY:latest"

      # --- all modules: Group 2+3 (lambda / cloudfront) ---
      - name: "Apply Group 2+3 — lambda / cloudfront"
        if: inputs.module == 'all'
        run: |
          terragrunt run-all init --terragrunt-non-interactive \
            --terragrunt-include-dir lambda \
            --terragrunt-include-dir cloudfront
          terragrunt run-all apply --terragrunt-non-interactive -auto-approve \
            --terragrunt-include-dir lambda \
            --terragrunt-include-dir cloudfront
```

- **Why:** `module=all` のフルデプロイを1ワークフローで完結させる。Group 1 apply でECRリポジトリが作成された後にdocker build/pushを行い、その後にlambda/cloudfrontを適用するという自然な依存順序をワークフローのステップ順で表現する。`run-all` を2回に分けることでbootstrap問題を回避しつつ、ファイルを1つに保てる。単一モジュール適用（`module != all`）は従来通り。

---

## Task Order

The tasks must be executed in this sequence:

1. **Task 1** (create ECR module) — must exist before any Terragrunt env config can reference it.
2. **Task 2** (create ECR env config) — depends on Task 1; no infrastructure dependencies.
3. **Task 3** (modify Lambda module) — can be done in parallel with Tasks 1–2; the new `ecr_repository_arn` variable must be in place before the Lambda env config passes it.
4. **Task 4** (modify Lambda env config) — depends on Tasks 2 and 3 both being complete; the `dependency "ecr"` block references the path created in Task 2, and `ecr_repository_arn` references the output/variable added in Tasks 1 and 3.
5. **Task 5** (modify terraform-apply.yml) — can be done in parallel with all other tasks; it is a CI configuration change only.

**Bootstrap sequence for first-time deployment** (handled automatically by `module=all`):

1. Apply code changes from all tasks to the repository (merge to main via PR).
2. Run `terraform-apply.yml` with `module=all` — the workflow applies ECR, pushes the image, then applies lambda/cloudfront in one run.

Note: On subsequent deployments with backend changes only, run `terraform-apply.yml` with `module=all` again. Lambda picks up the new image because the docker push step always runs before lambda apply in the same workflow.

---

## Trade-offs & Alternatives

**Alternative: Keep `run_cmd` for account ID, derive ARN in Lambda module**
The current approach of calling `aws sts get-caller-identity` at plan time works but requires AWS credentials available to the Terragrunt process during `init`, produces a value that is not tracked in state, and creates an implicit dependency on a specific URI format. Rejected in favour of the explicit `dependency` block, which is the idiomatic Terragrunt pattern.

**Alternative: Derive `image_uri` in Lambda module from repo name + data sources**
The Lambda module could accept only a `repo_name` variable and construct the full URI internally using `data "aws_caller_identity"` and `data "aws_region"`. This avoids the cross-module Terragrunt dependency at the cost of hiding the ECR URI construction inside the module. Rejected because it does not make the dependency graph explicit and still requires the data sources that the plan aims to remove.

**Alternative: Use `sha` tags instead of `latest`**
Tagging with the Git commit SHA would allow Lambda to always point at the exact image it was deployed with and would avoid the mutable-tag caveat. Rejected for now because it would require passing the tag through from CI to Terraform apply (or using a separate `aws lambda update-function-code` step), adding complexity out of scope for this feature.

**Alternative: Separate `ecr_push` IAM policy from `AWS_DEPLOY_ROLE_ARN`**
A dedicated role for image push only would follow least-privilege more strictly. Rejected as out of scope; the existing deploy role already has broad permissions and adding ECR push permissions to it is consistent with how the repo currently operates.

---

## Out of Scope

- ECR lifecycle policies (image expiration rules) — not required to make the feature work.
- ECR replication or cross-region setups.
- Multi-tag image builds (`:sha`, `:version`).
- Lambda alias or version management triggered by image pushes.
- A separate IAM role for the ECR push workflow.
- ECR repository policy (resource-based) to allow cross-account access.
- Staging or dev environment ECR configuration — only `prod` is in scope.
- Adding `ecr` to `features.json` — that is an implementation step, not a plan step.
