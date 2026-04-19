# Research: cloudfront-lambda-aws-iam-cors

## Relevant Files

- `infra/modules/cloudfront/main.tf`
  CloudFront distribution, Lambda OAC, forwarded headers in ordered_cache_behavior, and both current Lambda resource policy grants.
- `infra/modules/lambda/main.tf`
  Lambda Function URL with `authorization_type = "NONE"` (current). Comment marks AWS_IAM migration deferred.
- `infra/envs/prod/cloudfront/terragrunt.hcl`
  Wires `lambda_function_url` and `lambda_function_name` from lambda dependency into cloudfront module.
- `infra/envs/prod/lambda/terragrunt.hcl`
  Dependency chain and apply order for lambda; no cloudfront_domain input currently.
- `backend/app/main.py`
  FastAPI CORSMiddleware with `allow_credentials=False`, `allow_methods=["*"]`, `allow_headers=["*"]`. Reads `CLOUDFRONT_DOMAIN` env var to constrain `allow_origins`.
- `backend/app/auth.py`
  JWT extraction from `X-Authorization` header only. Backend never sees `Authorization`.
- `backend/app/routers/upload.py`
  POST route using `get_current_user` (reads `X-Authorization`).
- `backend/app/routers/transactions.py`
  GET route using `get_current_user` (reads `X-Authorization`).
- `frontend/src/api.ts`
  Client sends JWT in `X-Authorization` header. Also sends `X-Amz-Content-Sha256` on POST. Does NOT send `Authorization`.
- `.github/workflows/terraform-apply.yml`
  Staged apply: Group 1 (cognito/dynamodb/ecr), ECR build/push, Group 2+3 (lambda/cloudfront). Triggers on workflow_dispatch.
- `claude-progress.txt`
  Historical narrative of every 403 incident (#10, #11, #12, #13, #14) and what broke each time.
- `features.json`
  cloudfront-oac-iam and cloudfront-lambda-403 both marked done.
- `docs/completed/research-cloudfront-lambda-403.md`
  Prior research on the NONE-mode 403 (now resolved by adding lambda:InvokeFunction).
- `docs/completed/plan-cloudfront-lambda-403.md`
  Prior plan: add cloudfront_invoke_function permission, confirmed implemented in PR #16.

---

## PR History — What Broke Each Time

### PR #12 (5add5fe): Migrated to OAC + AWS_IAM

**Changes:**
- `infra/modules/lambda/main.tf`: `authorization_type = "AWS_IAM"`, added CORS block to Function URL (`allow_origins = ["*"]`, etc.), removed wildcard principal permissions and Secrets Manager.
- `infra/modules/cloudfront/main.tf`: added Lambda OAC (`signing_behavior = always`), attached OAC to lambda origin, added `aws_lambda_permission.cloudfront` with `function_url_auth_type = "AWS_IAM"`, forwarded headers changed to `["Origin", "X-Authorization", "Content-Type"]`.

**What failed:** AWS immediately rejected `UpdateFunctionUrlConfig` because **CORS config is incompatible with `authorization_type = AWS_IAM`**. AWS silently or loudly rejects this combination. The apply attempted to set both together.

Additionally, the `aws_lambda_permission.cloudfront` used `function_url_auth_type = "AWS_IAM"` which requires the Function URL to actually have that mode live in AWS. Since Terraform applies resources in dependency order and state may have been partially applied, this caused a 403 at the Lambda resource policy level when CloudFront sent a SigV4-signed request.

### PR #13 (98a9304): Removed CORS block from Function URL

**Change:** Removed `cors { ... }` block from `aws_lambda_function_url.api` (kept `authorization_type = "AWS_IAM"`).

**Outcome:** This was the correct direction — CORS block is incompatible with AWS_IAM. But by this point the overall state was already inconsistent: the permission resource still declared `function_url_auth_type = "AWS_IAM"` while the live Function URL may not have accepted the AWS_IAM mode correctly yet.

### PR #14 (5614472): Reverted to NONE

**Change:**
- `infra/modules/lambda/main.tf`: `authorization_type = "NONE"` (reverted)
- `infra/modules/cloudfront/main.tf`: `function_url_auth_type = "NONE"` on the permission

**Outcome:** Unblocked the deployment. But the 403 persisted because `lambda:InvokeFunction` was still missing (fixed later in PR #16 by adding `aws_lambda_permission.cloudfront_invoke_function`).

**Current state (HEAD after PR #16/17):**
- `authorization_type = "NONE"` (lambda/main.tf:130-133)
- `function_url_auth_type = "NONE"` on `aws_lambda_permission.cloudfront` (cloudfront/main.tf:160)
- Both `lambda:InvokeFunctionUrl` AND `lambda:InvokeFunction` granted to CloudFront (cloudfront/main.tf:154-169)
- OAC with `signing_behavior = always` is active on the lambda origin — CloudFront still signs all requests with SigV4

---

## Root Cause Analysis — The Current 403

The context description states there is still a 403 with `authorization_type = NONE` + OAC `signing_behavior = always`. This is a **fundamental architectural contradiction**:

When `authorization_type = NONE`, the Lambda Function URL **ignores the SigV4 signature** that CloudFront OAC injects. The resource policy grants are evaluated differently:
- With `authorization_type = NONE`: resource policy uses `function_url_auth_type = "NONE"`. CloudFront's OAC signature is appended but Lambda does not validate it. Access is controlled only by the resource policy `Principal/Condition`.
- With `authorization_type = AWS_IAM`: Lambda validates the OAC SigV4 signature against the resource policy. The `cloudfront.amazonaws.com` principal with matching `source_arn` is the authorization mechanism.

The prompt states the 403 is `AccessDeniedException` with body `{"Message":"Forbidden..."}` — this is the Lambda Function URL authorization layer rejecting the request.

**Why the OAC causes the 403 with NONE mode:**

When CloudFront OAC has `signing_behavior = always`, it rewrites the `Authorization` header to a SigV4 value. With `authorization_type = NONE`, Lambda does not verify this signature but the resource policy must still permit the caller. With `function_url_auth_type = "NONE"` on the permission, and both `lambda:InvokeFunctionUrl` + `lambda:InvokeFunction` granted to `cloudfront.amazonaws.com`, this should work — and indeed PR #16 was supposed to fix it.

**The actual remaining 403 cause is that AWS_IAM is the correct and necessary mode:**

From AWS documentation: CloudFront OAC for Lambda **requires** `authorization_type = AWS_IAM`. When `signing_behavior = always` is set, CloudFront signs the request with SigV4 using the CloudFront service's IAM identity. Lambda must be configured with `authorization_type = AWS_IAM` to authenticate this signature against the resource policy. With `authorization_type = NONE`, the Lambda resource policy may allow invocation BUT there are reports that OAC + NONE produces 403 because the OAC signing path on CloudFront's side for Lambda origins explicitly requires the target to have AWS_IAM set — otherwise CloudFront itself may return the 403 before the request reaches Lambda.

In other words: **AWS CloudFront Lambda OAC only works end-to-end when the target Function URL is `authorization_type = AWS_IAM`**. The current NONE configuration is architecturally incorrect for OAC.

---

## Why AWS_IAM + CORS Broke in PR #12

### Problem 1: CORS block in Function URL (incompatibility)

AWS Lambda Function URL CORS configuration (`cors { ... }` in `aws_lambda_function_url`) is **only supported when `authorization_type = NONE`**. Attempting `UpdateFunctionUrlConfig` with both `authorization_type = AWS_IAM` and a `cors` block causes the API to reject the request.

**Fix:** Do not put any `cors` block in `aws_lambda_function_url` when using AWS_IAM. CORS must be handled entirely by FastAPI's `CORSMiddleware`. This is already correct in the current backend (`backend/app/main.py:25-31`).

### Problem 2: CloudFront cache behavior does not forward the `Origin` header to Lambda

When CloudFront forwards a request to Lambda with a managed cache policy or `forwarded_values`, it only sends headers that are explicitly listed. The CORS preflight (`OPTIONS`) request from the browser carries an `Origin` header. If `Origin` is not in `forwarded_values.headers`, CloudFront strips it and FastAPI's CORSMiddleware never sees it — so the response has no `Access-Control-Allow-Origin` header, causing the browser to reject the response.

**Current state:** The `ordered_cache_behavior` for `/api/*` already lists `"Origin"` in `forwarded_values.headers` (cloudfront/main.tf:123). This was added in PR #12 and has not been reverted.

### Problem 3: `function_url_auth_type` mismatch on `aws_lambda_permission`

The `aws_lambda_permission` resource has a `function_url_auth_type` attribute that must match the live Function URL's `authorization_type`. If the permission declares `function_url_auth_type = "AWS_IAM"` but the Function URL is still at `authorization_type = "NONE"` (or vice versa), AWS will reject the permission update or the evaluation will fail.

**Fix:** When switching to `authorization_type = AWS_IAM`, the `aws_lambda_permission.cloudfront` must have `function_url_auth_type = "AWS_IAM"`. The `aws_lambda_permission.cloudfront_invoke_function` (for `lambda:InvokeFunction`) does not use `function_url_auth_type` — that attribute is only for `lambda:InvokeFunctionUrl`.

---

## Existing Patterns

### Header conventions (must preserve)
- JWT travels in `X-Authorization: Bearer <token>` end-to-end (frontend -> CloudFront -> Lambda -> FastAPI).
- `Authorization` header is owned by CloudFront OAC for SigV4.
- `X-Amz-Content-Sha256` is sent by frontend on POST for body integrity.
- Currently forwarded: `["Origin", "X-Authorization", "Content-Type"]`.

### CloudFront cache behavior for `/api/*`
- `min_ttl = 0`, `default_ttl = 0`, `max_ttl = 0` — effectively no caching (correct for an API).
- `allowed_methods` includes OPTIONS (required for CORS preflight).
- `query_string = true` (required for `?from=&to=` filters).

### CORS is entirely FastAPI's responsibility
- `CORSMiddleware` with `allow_credentials=False`, `allow_origins` set to CloudFront domain, `allow_methods=["*"]`, `allow_headers=["*"]`.
- `allow_credentials=False` is critical: when `False`, `Access-Control-Allow-Origin` can be `*` or the specific origin, and the browser does not require cookies/auth to be sent. This is compatible with JWT-in-header auth.

### Lambda Function URL CORS config
- No `cors` block present in `aws_lambda_function_url.api` (removed in PR #13).
- With `authorization_type = AWS_IAM`, no `cors` block is allowed or needed — correct.

### Resource policy grants
- Two permissions currently in cloudfront module: `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`, both scoped to `cloudfront.amazonaws.com` + distribution ARN.
- When switching to `authorization_type = AWS_IAM`: only `lambda:InvokeFunctionUrl` with `function_url_auth_type = "AWS_IAM"` is needed. The `lambda:InvokeFunction` with `principal = "cloudfront.amazonaws.com"` may still be required (post-Oct 2025 behavior) — keep it.

---

## Entry Points

1. Browser preflight: `OPTIONS /api/transactions` → CloudFront `/api/*` behavior → Lambda origin (with OAC SigV4 added) → FastAPI CORSMiddleware handles OPTIONS response.
2. Browser data request: `GET|POST /api/transactions` with `X-Authorization: Bearer <jwt>` → CloudFront adds SigV4 `Authorization` header → Lambda validates signature (with AWS_IAM) → FastAPI router → `get_current_user` reads `X-Authorization`.
3. Terraform apply: `infra/envs/prod/lambda` then `infra/envs/prod/cloudfront` (dependency order preserved).

---

## Exact Changes Needed

### 1. `infra/modules/lambda/main.tf`

Change `authorization_type` from `"NONE"` to `"AWS_IAM"`. No `cors` block.

```hcl
# Before:
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}

# After:
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "AWS_IAM"
}
```

Update the comment from "NONE — public endpoint protected only by CloudFront OAC permission" to reflect AWS_IAM.

### 2. `infra/modules/cloudfront/main.tf`

Change `function_url_auth_type` on the `aws_lambda_permission.cloudfront` from `"NONE"` to `"AWS_IAM"`.

```hcl
# Before:
resource "aws_lambda_permission" "cloudfront" {
  statement_id           = "AllowCloudFrontInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = var.lambda_function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.main.arn
  function_url_auth_type = "NONE"
}

# After:
resource "aws_lambda_permission" "cloudfront" {
  statement_id           = "AllowCloudFrontInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = var.lambda_function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.main.arn
  function_url_auth_type = "AWS_IAM"
}
```

The `aws_lambda_permission.cloudfront_invoke_function` (`lambda:InvokeFunction`) has no `function_url_auth_type` attribute and needs no change.

### 3. No changes needed to:
- `backend/app/main.py` — CORSMiddleware config is already correct
- `backend/app/auth.py` — X-Authorization extraction is already correct
- `frontend/src/api.ts` — already uses X-Authorization, not Authorization
- `infra/modules/cloudfront/main.tf` forwarded headers — Origin, X-Authorization, Content-Type already forwarded
- `infra/envs/prod/cloudfront/terragrunt.hcl` — no input changes needed
- `infra/envs/prod/lambda/terragrunt.hcl` — no input changes needed
- `.github/workflows/terraform-apply.yml` — apply order is correct

---

## Constraints & Gotchas

1. **CORS block forbidden with AWS_IAM.** Never add `cors { ... }` to `aws_lambda_function_url` when using `authorization_type = AWS_IAM`. AWS rejects `UpdateFunctionUrlConfig` if both are set. CORS must come from FastAPI middleware only.

2. **`function_url_auth_type` must match live Function URL.** The `aws_lambda_permission` with `action = "lambda:InvokeFunctionUrl"` has a `function_url_auth_type` attribute. This must match the actual `authorization_type` of the Function URL resource. A mismatch causes Terraform to fail or the policy statement to be invalid.

3. **Terraform apply order matters.** Lambda module must apply before cloudfront module because cloudfront's `aws_lambda_permission` references `var.lambda_function_name` (the function must exist). This is already enforced by the terragrunt dependency. However, if applying individually (not all), apply `lambda` first, then `cloudfront`.

4. **State drift risk.** This repo has a history of manual permission changes and `terragrunt import` operations. Before applying, run `aws lambda get-policy` and `aws lambda get-function-url-config` to confirm live state. If there are extra manual policy statements, they will not be removed by Terraform (it only manages what it knows about).

5. **`X-Amz-Content-Sha256` header from frontend.** The frontend sends this on POST. With AWS_IAM, CloudFront OAC computes its own `X-Amz-Content-Sha256` for SigV4. If the frontend-supplied value conflicts with the OAC-computed value, the signature verification may fail. Currently this header is NOT in `forwarded_values.headers` — CloudFront will strip it before signing, which is correct: OAC will compute the hash itself.

6. **OAC always-sign with NONE is incoherent.** The root cause of the repeated 403 failures is that the current config has `signing_behavior = always` (CloudFront signs every request) but `authorization_type = NONE` (Lambda ignores the signature). AWS documents that Lambda OAC requires AWS_IAM on the Function URL. The NONE workaround added in PR #14 was a temporary unblock, not a correct fix.

7. **`allow_credentials = False` in CORSMiddleware is required.** With `authorization_type = AWS_IAM`, direct browser requests to the Lambda URL would fail (the browser can't compute SigV4). But all traffic goes through CloudFront, so this is fine. `allow_credentials=False` means the browser doesn't need to send cookies; JWT is in a custom header, which is fine.

8. **`Authorization` header cannot be forwarded.** OAC overwrites it. Do not add `Authorization` to `forwarded_values.headers`. The current config correctly omits it.

9. **CloudFront OAC for Lambda + caching.** With `min_ttl=0`, `default_ttl=0`, `max_ttl=0`, CloudFront does not cache API responses. This is correct — the OAC signature includes a timestamp, so cached responses with stale signatures would fail.

10. **`cloudfront_domain` env var not passed to lambda module.** Looking at `infra/envs/prod/lambda/terragrunt.hcl`, there is no `cloudfront_domain` input. The Lambda module has `variable "cloudfront_domain" { default = "" }`. This means `CLOUDFRONT_DOMAIN` env var in Lambda is empty string, so `main.py` falls back to `origins = ["*"]` for CORSMiddleware. This is a pre-existing gap — CORS will work but allows any origin. This is acceptable given CloudFront is the only public entry point and direct Lambda URL access requires SigV4 (with AWS_IAM).

---

## Open Questions

1. **Is there a live state inconsistency?** The history shows multiple manual imports and partial applies. Before implementing the AWS_IAM switch, run `aws lambda get-function-url-config --function-name zaim-csv-api --region ap-northeast-1` to confirm the live `AuthorizationType` and `aws lambda get-policy` to confirm current policy statements. If the live Function URL is already at NONE and permissions are as Terraform defines, the apply should be clean.

2. **Does `lambda:InvokeFunction` remain required with AWS_IAM?** With `authorization_type = AWS_IAM`, the Function URL invocation path goes through IAM authorization. AWS's post-Oct 2025 requirement for `lambda:InvokeFunction` alongside `lambda:InvokeFunctionUrl` may or may not apply in the AWS_IAM path. Keep both permissions to be safe — removing the working `cloudfront_invoke_function` permission during an already-risky migration is unnecessary risk.

3. **`cloudfront_domain` not wired to lambda.** Should `infra/envs/prod/lambda/terragrunt.hcl` be updated to pass the CloudFront distribution domain to constrain `allow_origins` in FastAPI? This would require adding a cloudfront dependency to the lambda terragrunt config (creating a circular dependency since cloudfront depends on lambda). The safe resolution is to keep `allow_origins = ["*"]` in FastAPI since the Function URL is protected by AWS_IAM OAC and not directly accessible by browsers.

4. **OPTIONS preflight with OAC.** CloudFront OAC with `signing_behavior = always` will also sign OPTIONS preflight requests. With `authorization_type = AWS_IAM`, Lambda will verify the OAC signature on OPTIONS too, before passing to FastAPI. FastAPI's CORSMiddleware handles OPTIONS. This should work transparently since CloudFront generates valid SigV4 for all forwarded request methods. Verify this after deploy by testing the OPTIONS response.

---

## Validation Commands

```bash
# 1. Confirm current live Function URL auth mode
aws lambda get-function-url-config --function-name zaim-csv-api --region ap-northeast-1

# 2. Inspect current live resource policy
aws lambda get-policy --function-name zaim-csv-api --region ap-northeast-1 \
  | jq -r '.Policy' | jq '.Statement[] | {Sid,Action,Principal,Condition}'

# 3. After applying: verify Function URL is AWS_IAM
aws lambda get-function-url-config --function-name zaim-csv-api --region ap-northeast-1 \
  | jq '{AuthorizationType, FunctionUrl}'

# 4. Test CORS preflight via CloudFront
curl -i -sS -X OPTIONS https://d11tzwdbun5b5c.cloudfront.net/api/transactions \
  -H 'Origin: https://d11tzwdbun5b5c.cloudfront.net' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: x-authorization,content-type'
# Expect: 200, Access-Control-Allow-Origin header present, no AccessDeniedException

# 5. Test actual GET via CloudFront (no auth — should get 401 not 403)
curl -i -sS https://d11tzwdbun5b5c.cloudfront.net/api/transactions
# Expect: 401 (JWT missing) not 403 AccessDeniedException

# 6. Verify Terraform plan shows only expected changes
cd infra/envs/prod/lambda && terragrunt plan
cd infra/envs/prod/cloudfront && terragrunt plan
```

---

## Summary: Minimal Change Set

| File | Change |
|------|--------|
| `infra/modules/lambda/main.tf` | `authorization_type = "AWS_IAM"` (from `"NONE"`) |
| `infra/modules/cloudfront/main.tf` | `function_url_auth_type = "AWS_IAM"` on `aws_lambda_permission.cloudfront` (from `"NONE"`) |

No backend, frontend, CI, or terragrunt env config changes needed.

Apply order: `module=lambda` first, then `module=cloudfront` (or `module=all` with staged apply — existing workflow handles this correctly).
