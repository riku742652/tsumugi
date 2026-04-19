# Plan: cloudfront-lambda-aws-iam-cors

## Overview

Switch the Lambda Function URL from `authorization_type = "NONE"` to `"AWS_IAM"` so that CloudFront OAC SigV4 signing is properly validated end-to-end. The current config is architecturally inconsistent: CloudFront OAC is configured with `signing_behavior = always` (SigV4 on every request) but the Function URL ignores that signature because NONE mode disables verification. AWS documents that Lambda OAC requires AWS_IAM on the target Function URL. The fix is exactly two line changes in two Terraform module files. No backend, frontend, CI, or Terragrunt env-config changes are needed.

---

## Tasks

### Task 1: Set `authorization_type = "AWS_IAM"` on the Lambda Function URL

- **File:** `infra/modules/lambda/main.tf`
- **Change:** Lines 127–133. Change `authorization_type` and update the comment that notes the migration as deferred.

  Before:
  ```hcl
  # Lambda Function URL (auth: NONE — public endpoint protected only by CloudFront OAC permission)
  # CORS is omitted: handled by FastAPI middleware instead.
  # AWS_IAM migration deferred until CORS / UpdateFunctionUrlConfig issue is resolved.
  resource "aws_lambda_function_url" "api" {
    function_name      = aws_lambda_function.api.function_name
    authorization_type = "NONE"
  }
  ```

  After:
  ```hcl
  # Lambda Function URL (auth: AWS_IAM — CloudFront OAC SigV4 is validated by Lambda)
  # CORS is omitted: handled by FastAPI CORSMiddleware instead.
  # No cors {} block allowed when authorization_type = AWS_IAM (AWS rejects UpdateFunctionUrlConfig).
  resource "aws_lambda_function_url" "api" {
    function_name      = aws_lambda_function.api.function_name
    authorization_type = "AWS_IAM"
  }
  ```

- **Why:** `authorization_type = "NONE"` makes Lambda ignore the OAC SigV4 signature that CloudFront injects on every request. With `signing_behavior = always` on the OAC, AWS requires the target Function URL to have `AWS_IAM` set, otherwise CloudFront itself may return 403 before the request reaches Lambda. This is the root cause of the recurring `AccessDeniedException`.

### Task 2: Set `function_url_auth_type = "AWS_IAM"` on the CloudFront Lambda permission

- **File:** `infra/modules/cloudfront/main.tf`
- **Change:** Line 160. Change `function_url_auth_type` on `aws_lambda_permission.cloudfront` from `"NONE"` to `"AWS_IAM"`.

  Before:
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

  After:
  ```hcl
  resource "aws_lambda_permission" "cloudfront" {
    statement_id           = "AllowCloudFrontInvoke"
    action                 = "lambda:InvokeFunctionUrl"
    function_name          = var.lambda_function_name
    principal              = "cloudfront.amazonaws.com"
    source_arn             = aws_cloudfront_distribution.main.arn
    function_url_auth_type = "AWS_IAM"
  }
  ```

  The `aws_lambda_permission.cloudfront_invoke_function` resource (`lambda:InvokeFunction`, lines 163–169) has no `function_url_auth_type` attribute and requires no change. Leave it untouched.

- **Why:** The `function_url_auth_type` attribute on a `lambda:InvokeFunctionUrl` permission must match the live Function URL's `authorization_type`. A mismatch causes the policy statement to be invalid or Terraform to fail. Keeping it at `"NONE"` while the Function URL moves to `AWS_IAM` would leave a broken policy statement in the Lambda resource policy.

### Task 3: Verify plan before applying

- **File:** none (validation step)
- **Change:** Run `terragrunt plan` in both env directories and confirm only the two expected attribute changes appear.

  ```bash
  # From repo root
  cd infra/envs/prod/lambda && terragrunt plan
  # Expected: ~ aws_lambda_function_url.api — authorization_type: "NONE" -> "AWS_IAM"

  cd infra/envs/prod/cloudfront && terragrunt plan
  # Expected: ~ aws_lambda_permission.cloudfront — function_url_auth_type: "NONE" -> "AWS_IAM"
  ```

- **Why:** This repo has a history of state drift and partial applies. Confirming the plan scope before touching live resources prevents surprises and confirms no stale manual policy statements have caused drift.

### Task 4: Pre-apply live state snapshot

- **File:** none (validation step)
- **Change:** Capture current AWS state before applying.

  ```bash
  # Confirm live Function URL auth mode
  aws lambda get-function-url-config \
    --function-name zaim-csv-api \
    --region ap-northeast-1 \
    | jq '{AuthorizationType, FunctionUrl}'

  # Confirm live resource policy statements
  aws lambda get-policy \
    --function-name zaim-csv-api \
    --region ap-northeast-1 \
    | jq -r '.Policy' | jq '.Statement[] | {Sid,Action,Principal,Condition}'
  ```

- **Why:** If the live state has extra manual policy statements or an unexpected `AuthorizationType`, the apply may fail or produce unexpected results. Capturing state first allows quick diagnosis if the apply produces errors.

### Task 5: Apply in correct module order

- **File:** none (apply step)
- **Change:** Apply lambda module first, then cloudfront module.

  **Option A — via GitHub Actions (preferred):**
  Push the branch and trigger the `terraform-apply` workflow (`workflow_dispatch`). The existing workflow applies Group 2 (lambda) before Group 3 (cloudfront), which is the correct order.

  **Option B — manual terragrunt:**
  ```bash
  cd infra/envs/prod/lambda && terragrunt apply -auto-approve
  cd infra/envs/prod/cloudfront && terragrunt apply -auto-approve
  ```

- **Why:** `aws_lambda_permission.cloudfront` in the cloudfront module references `var.lambda_function_name`. The Function URL `authorization_type` must be updated in AWS before the permission statement with `function_url_auth_type = "AWS_IAM"` is evaluated, otherwise Terraform may apply the permission against a Function URL that still has NONE mode, creating a transient mismatch. The existing Terragrunt dependency graph enforces this order when using `run-all apply`.

### Task 6: Post-apply validation

- **File:** none (validation step)
- **Change:** Run the following after apply completes.

  ```bash
  # 1. Confirm Function URL is now AWS_IAM
  aws lambda get-function-url-config \
    --function-name zaim-csv-api \
    --region ap-northeast-1 \
    | jq '{AuthorizationType, FunctionUrl}'
  # Expected: "AuthorizationType": "AWS_IAM"

  # 2. Confirm resource policy has correct function_url_auth_type
  aws lambda get-policy \
    --function-name zaim-csv-api \
    --region ap-northeast-1 \
    | jq -r '.Policy' | jq '.Statement[] | {Sid,Action,Principal,Condition}'
  # Expected: AllowCloudFrontInvoke has Condition with ArnLike source_arn and
  #           lambda:FunctionUrlAuthType = AWS_IAM

  # 3. Test CORS preflight via CloudFront
  curl -i -sS -X OPTIONS \
    https://d11tzwdbun5b5c.cloudfront.net/api/transactions \
    -H 'Origin: https://d11tzwdbun5b5c.cloudfront.net' \
    -H 'Access-Control-Request-Method: GET' \
    -H 'Access-Control-Request-Headers: x-authorization,content-type'
  # Expected: HTTP 200, Access-Control-Allow-Origin header present

  # 4. Test unauthenticated GET — expect 401 (JWT missing), NOT 403 (Lambda auth)
  curl -i -sS https://d11tzwdbun5b5c.cloudfront.net/api/transactions
  # Expected: HTTP 401 from FastAPI, not 403 AccessDeniedException from Lambda
  ```

- **Why:** Distinguishing a 401 (FastAPI JWT check) from a 403 (Lambda Function URL auth) confirms the OAC-to-Lambda authorization layer is working. A 403 with `{"Message":"Forbidden"}` or `{"Message":"AccessDenied"}` indicates the Lambda resource policy or auth type is still wrong.

### Task 7: Update `features.json`

- **File:** `features.json`
- **Change:** Add a new entry for this feature, marked `done` after successful post-apply validation.

  ```json
  "cloudfront-lambda-aws-iam-cors": {
    "id": "cloudfront-lambda-aws-iam-cors",
    "title": "Fix CloudFront OAC + Lambda AWS_IAM authorization and CORS",
    "status": "done",
    "notes": "Changed authorization_type to AWS_IAM on Lambda Function URL and function_url_auth_type to AWS_IAM on aws_lambda_permission.cloudfront. No CORS block in Function URL (incompatible with AWS_IAM). CORS handled entirely by FastAPI CORSMiddleware."
  }
  ```

- **Why:** The harness workflow requires `features.json` to be updated at session end to reflect current feature state.

---

## Task Order

1. **Task 3 (plan verification) and Task 4 (live state snapshot)** — run before any code changes to establish baseline and confirm scope.
2. **Task 1 (lambda/main.tf change)** — code edit.
3. **Task 2 (cloudfront/main.tf change)** — code edit. Can be done in parallel with Task 1 since both are file edits, but lambda must apply before cloudfront.
4. **Task 5 (apply)** — lambda env first, cloudfront env second. The existing CI workflow handles this automatically.
5. **Task 6 (post-apply validation)** — must run after Task 5 completes successfully.
6. **Task 7 (features.json update)** — after Task 6 confirms the fix is working.

---

## Trade-offs & Alternatives

**Alternative: Keep `authorization_type = "NONE"` and fix resource policy manually.**
Rejected. NONE + OAC `signing_behavior = always` is documented by AWS as an unsupported combination for Lambda OAC. It may appear to work in some regions or conditions but is architecturally incorrect and explains the recurring 403 failures across PRs #12–#16.

**Alternative: Switch OAC to `signing_behavior = "no-override"` and keep NONE.**
Rejected. `no-override` means CloudFront does not sign requests that already have an `Authorization` header. Browsers do not send `Authorization` (OAC owns that header). This would leave Lambda Function URL without any OAC-layer protection, requiring a different access control mechanism (e.g., shared secret header), which was the old design replaced in PR #12.

**Alternative: Remove OAC entirely and use `aws_lambda_permission` with a wildcard or per-IP condition.**
Rejected. OAC is the AWS-recommended approach for CloudFront-to-Lambda security. Removing it would require re-introducing a secret header or making the Function URL fully public.

**Alternative: Add CORS handling at CloudFront level (response headers policy) instead of FastAPI.**
Rejected. FastAPI's CORSMiddleware already handles OPTIONS responses correctly and is already deployed. A CloudFront response headers policy would add complexity and potentially conflict with FastAPI's headers. The current FastAPI approach is sufficient.

**Alternative: Wire `cloudfront_domain` to lambda terragrunt to restrict `allow_origins`.**
Deferred (not in scope). Adding cloudfront as a dependency of lambda creates a circular dependency (cloudfront already depends on lambda). The Function URL is protected by `authorization_type = AWS_IAM` — direct browser access to the Function URL is impossible without valid SigV4 credentials, so `allow_origins = ["*"]` in FastAPI is an acceptable posture.

---

## Out of Scope

- Changes to `backend/app/main.py`, `backend/app/auth.py`, `backend/app/routers/*.py` — no backend changes needed.
- Changes to `frontend/src/api.ts` — no frontend changes needed.
- Changes to `.github/workflows/terraform-apply.yml` — apply order is already correct.
- Changes to `infra/envs/prod/lambda/terragrunt.hcl` or `infra/envs/prod/cloudfront/terragrunt.hcl` — no input variable changes needed.
- Wiring `cloudfront_domain` into the lambda module to constrain `allow_origins` — deferred (circular dependency concern, not a security risk given AWS_IAM auth type).
- Removing `aws_lambda_permission.cloudfront_invoke_function` (`lambda:InvokeFunction`) — keep it; removing a working permission during a risky migration adds unnecessary risk, and post-Oct 2025 AWS behavior may require it.
- Any changes to the CloudFront OAC resource, cache behavior, forwarded headers, or cache policy — these are already correct.
