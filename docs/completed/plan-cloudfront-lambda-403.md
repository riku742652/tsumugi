# Plan: cloudfront-lambda-403

## Overview
CloudFront -> Lambda Function URL path currently returns 403 AccessDeniedException before backend auth is reached. Based on docs/completed/research-cloudfront-lambda-403.md, the minimal architecture-preserving fix is to keep Function URL authorization_type = NONE and add the missing CloudFront-scoped Lambda resource policy action (lambda:InvokeFunction) alongside the existing lambda:InvokeFunctionUrl permission. This plan intentionally avoids auth model migration, header convention changes, or broader infrastructure refactors.

## Feature Status Check
- `features.json` currently has no `cloudfront-lambda-403` entry.
- For this phase, implementation scope stays focused on the 403 fix; feature tracker updates can be handled in implementation/session bookkeeping per AGENTS.md.

## Tasks

### Task 1: Add missing CloudFront-scoped Lambda invoke permission
- **File(s):** `infra/modules/cloudfront/main.tf`
- **Terraform resource(s):**
  - Existing: `aws_lambda_permission.cloudfront`
  - New: `aws_lambda_permission.cloudfront_invoke_function`
- **Change:** Keep the existing `lambda:InvokeFunctionUrl` statement and add a second Lambda permission statement for `lambda:InvokeFunction` with the same CloudFront principal and distribution `source_arn`.

**Before**
```hcl
resource "aws_lambda_permission" "cloudfront" {
  statement_id           = "AllowCloudFrontInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = var.lambda_function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.main.arn
  function_url_auth_type = "NONE"
}
```

**After**
```hcl
resource "aws_lambda_permission" "cloudfront" {
  statement_id           = "AllowCloudFrontInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = var.lambda_function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.main.arn
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "cloudfront_invoke_function" {
  statement_id  = "AllowCloudFrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.main.arn
}
```
- **Why:** Research and prior repository history show CloudFront Function URL invocation path can require both actions. Current state only grants `lambda:InvokeFunctionUrl`, which matches the observed 403 `AccessDeniedException` failure mode.

### Task 2: Validate live policy and endpoint behavior after apply
- **File(s):** no source file edits; operational validation against deployed resources
- **AWS resources:**
  - Lambda function policy on `zaim-csv-api`
  - CloudFront distribution for `d11tzwdbun5b5c.cloudfront.net`
- **Change:** Execute targeted verification commands before and after apply.

**Before (expected failure evidence)**
```bash
curl -i -sS https://d11tzwdbun5b5c.cloudfront.net/api/transactions | head -n 40
# Expect: HTTP 403 + x-amzn-errortype: AccessDeniedException
```

**After (expected behavior shift)**
```bash
aws lambda get-policy --function-name zaim-csv-api --region ap-northeast-1 \
  | jq -r '.Policy' | jq '.Statement[] | {Sid,Action,Principal,Condition}'
# Expect actions include both:
# - lambda:InvokeFunctionUrl
# - lambda:InvokeFunction

curl -i -sS https://d11tzwdbun5b5c.cloudfront.net/api/transactions | head -n 40
# Expect: no AccessDeniedException from Function URL layer.
# Likely transitions to backend-layer auth response (e.g., 401 without valid JWT).
```
- **Why:** The fix is policy-level; correctness is proven by both policy inspection and CloudFront endpoint behavior change.

## Task Order
1. Update `infra/modules/cloudfront/main.tf` with the additional Lambda permission.
2. Run `terragrunt plan` in `infra/envs/prod/cloudfront` to confirm only intended permission delta.
3. Apply the cloudfront stack (`terragrunt apply --terragrunt-non-interactive`).
4. Re-run `terragrunt plan` to confirm clean state.
5. Run post-apply policy and endpoint checks.

Order rationale:
- Permission must exist before endpoint behavior can recover.
- Plan/apply/plan sequence confirms minimal change and avoids hidden drift in this targeted scope.

## Trade-offs & Alternatives
- **Alternative A: Re-migrate Function URL to `AWS_IAM`**
  - Rejected for this fix: broader auth/CORS behavior changes and higher regression risk; not minimal.
- **Alternative B: Restore wildcard principal permissions (`principal = "*"`)**
  - Rejected: weakens security posture and violates CloudFront-only access design.
- **Alternative C: Move permission resources into lambda module**
  - Rejected for now: larger module-boundary refactor; current ownership in cloudfront module is already established and references distribution ARN directly.
- **Chosen approach trade-off:**
  - Adds one extra policy statement but preserves existing architecture, deployment topology, and header/auth conventions.

## Validation Steps
1. Pre-check current failure signature (403 AccessDeniedException) via CloudFront `/api/transactions`.
2. Run `terragrunt plan` in `infra/envs/prod/cloudfront`; verify only new `aws_lambda_permission.cloudfront_invoke_function` is introduced.
3. Apply changes with `terragrunt apply --terragrunt-non-interactive`.
4. Confirm Lambda policy contains both invoke actions scoped to `cloudfront.amazonaws.com` and CloudFront distribution `source_arn`.
5. Re-test GET and OPTIONS to `/api/transactions` through CloudFront and confirm Function URL-layer 403 is gone.
6. Run final `terragrunt plan` to ensure no remaining drift for this module.

## Out of Scope
- Changes to `infra/modules/lambda/main.tf` authorization mode.
- Any frontend/backend code updates (`frontend/src/api.ts`, `backend/app/auth.py`, `backend/app/main.py`).
- CI workflow changes in `.github/workflows/terraform-apply.yml`.
- Unrelated feature tracking or multi-feature refactoring.
- Migration of CloudFront cache behavior or CORS redesign.
