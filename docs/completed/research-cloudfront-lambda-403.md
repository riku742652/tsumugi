# Research: cloudfront-lambda-403

## Relevant Files

- `infra/modules/cloudfront/main.tf`
  - CloudFront distribution, Lambda origin OAC, and the only current Lambda resource policy grant for CloudFront (`aws_lambda_permission.cloudfront`).
- `infra/modules/lambda/main.tf`
  - Lambda Function URL auth mode (`authorization_type = "NONE"`) and Lambda function outputs consumed by CloudFront module.
- `infra/envs/prod/cloudfront/terragrunt.hcl`
  - Wires `lambda_function_url` and `lambda_function_name` from lambda dependency into cloudfront module.
- `infra/envs/prod/lambda/terragrunt.hcl`
  - Lambda module dependency wiring and image source; relevant for apply ordering and drift risk.
- `.github/workflows/terraform-apply.yml`
  - Defines production apply order (`Group 1` then `Group 2+3`) and where lambda/cloudfront are applied together.
- `frontend/src/api.ts`
  - Client sends JWT via `X-Authorization` (not `Authorization`) to survive CloudFront OAC signing behavior.
- `backend/app/auth.py`
  - Backend auth dependency expects `X-Authorization`; confirms 403 occurs before backend if missing invoke permission.
- `backend/app/main.py`
  - CORS behavior and API router mount `/api/transactions`; useful to confirm request path enters CloudFront `/api/*` behavior.
- `claude-progress.txt`
  - Historical record of previous 403 incidents and fixes (#10, #11, #14) and migration sequencing.
- `features.json`
  - Confirms cloudfront-oac-iam migration marked done, useful when evaluating config-vs-state mismatch.
- `docs/completed/research-zaim-csv.md`
  - Original architecture rationale (CloudFront in front of Function URL).
- `docs/completed/plan-zaim-csv.md`
  - Historical decision record for Function URL + CloudFront security model.
- `docs/completed/research-ecr.md`
  - Dependency chain documentation (`cognito/dynamodb -> lambda -> cloudfront`) used by current apply flow.
- `docs/completed/plan-ecr.md`
  - Historical deployment-order details for grouped terragrunt apply.
- `memories/repo/lambda-403.md`
  - Repository memory summary of expected request path and header conventions.

## Existing Patterns

- CloudFront is the only intended public entrypoint for API traffic:
  - Distribution routes `/api/*` to Lambda Function URL origin (`infra/modules/cloudfront/main.tf:113-132`).
- Lambda Function URL auth mode is currently `NONE`:
  - `resource "aws_lambda_function_url" "api" { authorization_type = "NONE" }` in `infra/modules/lambda/main.tf:130-133`.
- CloudFront->Lambda permission in Terraform currently defines only `lambda:InvokeFunctionUrl`:
  - `aws_lambda_permission.cloudfront` in `infra/modules/cloudfront/main.tf:154-161`.
- JWT transport convention is `X-Authorization` end-to-end:
  - Frontend sends header in `frontend/src/api.ts:14,32`.
  - Backend reads it in `backend/app/auth.py:39-45`.
- Terragrunt dependency wiring for cloudfront module depends on lambda outputs:
  - `infra/envs/prod/cloudfront/terragrunt.hcl:9-22`.
- Apply flow is staged, with lambda/cloudfront in final group:
  - `.github/workflows/terraform-apply.yml:104-113`.

## Entry Points

- External user traffic:
  - `https://d11tzwdbun5b5c.cloudfront.net/api/transactions`
- CloudFront behavior entry:
  - `ordered_cache_behavior` path `/api/*` -> origin `lambda-api` (`infra/modules/cloudfront/main.tf:113-132`).
- Lambda invocation authorization gate (resource policy):
  - `aws_lambda_permission.cloudfront` (`infra/modules/cloudfront/main.tf:154-161`).
- Backend auth entry (only after Lambda invocation succeeds):
  - `get_current_user` in `backend/app/auth.py:39-73`.

## Evidence Collected (Current Incident)

### Live response evidence

Observed from terminal on 2026-04-18:

- `GET /api/transactions` via CloudFront returns:
  - `HTTP/2 403`
  - `x-amzn-errortype: AccessDeniedException`
  - body: `{"Message":"Forbidden. For troubleshooting Function URL authorization issues, see: https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html"}`
- `OPTIONS /api/transactions` with CORS preflight headers returns the same `AccessDeniedException`.

Interpretation:
- Error is from Lambda Function URL authorization layer, not backend JWT validation.
- Backend route code is not reached in this failure mode.

### Historical commit evidence

Relevant history for this same path:

- `c3cdf7d` (#10): added `lambda:InvokeFunctionUrl` permission for Function URL.
- `7db98b8` (#11): added `lambda:InvokeFunction` because removal caused 403 after AWS Oct 2025 behavior change.
- `5add5fe` (#12): OAC + AWS_IAM migration removed prior wildcard permissions and moved auth model.
- `5614472` (#14): reverted Function URL auth back to `NONE` and aligned permission `function_url_auth_type` to `NONE` to fix 403.

Critical observation in HEAD:
- Current Terraform defines only one CloudFront permission statement (`lambda:InvokeFunctionUrl`) and does not define a companion `lambda:InvokeFunction` statement.

## Exact Terraform Resources/Policies Controlling CloudFront -> Lambda Function URL Invocation

Current controlling resources in source:

1. Lambda Function URL auth mode:

```hcl
# infra/modules/lambda/main.tf:130-133
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}
```

2. CloudFront Lambda origin with OAC SigV4:

```hcl
# infra/modules/cloudfront/main.tf:37-43
resource "aws_cloudfront_origin_access_control" "lambda" {
  name                              = "${var.app_name}-lambda-oac"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# infra/modules/cloudfront/main.tf:84-96
origin {
  origin_id                = "lambda-api"
  domain_name              = local.lambda_origin_domain
  origin_access_control_id = aws_cloudfront_origin_access_control.lambda.id
  custom_origin_config {
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "https-only"
    origin_ssl_protocols   = ["TLSv1.2"]
  }
}
```

3. API routing from CloudFront to Lambda origin:

```hcl
# infra/modules/cloudfront/main.tf:113-132
ordered_cache_behavior {
  path_pattern           = "/api/*"
  target_origin_id       = "lambda-api"
  viewer_protocol_policy = "https-only"
  allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
  forwarded_values {
    query_string = true
    headers      = ["Origin", "X-Authorization", "Content-Type"]
    cookies { forward = "none" }
  }
}
```

4. Resource-based policy grant from Lambda side (currently single statement):

```hcl
# infra/modules/cloudfront/main.tf:154-161
resource "aws_lambda_permission" "cloudfront" {
  statement_id           = "AllowCloudFrontInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = var.lambda_function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.main.arn
  function_url_auth_type = "NONE"
}
```

No Terraform resource in HEAD currently grants:
- `action = "lambda:InvokeFunction"` for the same CloudFront principal/source.

## Root Cause Hypothesis and Confidence

Hypothesis:
- 403 `AccessDeniedException` is caused by an incomplete Lambda resource policy for Function URL invocation under current `authorization_type = NONE` model: Terraform grants `lambda:InvokeFunctionUrl` but not `lambda:InvokeFunction`.
- This matches repository history (#11) that documented both actions are required (post-Oct 2025 behavior) and verified 403 when one is removed.

Confidence:
- 0.84 (high, but not absolute).

Why not 1.0:
- There is known risk of state drift/manual changes in this repository history.
- Without running `get-policy` against live Lambda and comparing to state, we cannot exclude drift as a co-cause.

Alternative/secondary hypotheses:
- Terraform state drift or partial apply left mismatched policy statements in AWS.
- CloudFront distribution ARN in permission `source_arn` does not match live distribution due to recreation (less likely, but possible after replacements).

## Minimal IaC Change Needed (Design-Preserving)

Target design constraints to preserve:
- CloudFront-only access.
- Function URL `authorization_type = NONE`.
- JWT continues in `X-Authorization`.

Minimal change candidate:
- Add a second `aws_lambda_permission` statement for the same function and CloudFront source:
  - `action = "lambda:InvokeFunction"`
  - `principal = "cloudfront.amazonaws.com"`
  - `source_arn = aws_cloudfront_distribution.main.arn`
- Keep existing `aws_lambda_permission.cloudfront` (`lambda:InvokeFunctionUrl`) unchanged.
- Do not reintroduce wildcard `principal = "*"`.
- Do not change header flow (`X-Authorization`) or Function URL auth mode (`NONE`).

Likely placement:
- `infra/modules/cloudfront/main.tf` (where existing CloudFront->Lambda permission already lives).

Rationale for this placement:
- Keeps CloudFront-origin permissions co-located with CloudFront distribution ARN ownership.
- Avoids splitting a single authorization concern across multiple modules.

## Dependency / Order Considerations

- Terragrunt functional dependency is already correct:
  - cloudfront depends on lambda outputs (`infra/envs/prod/cloudfront/terragrunt.hcl:9-22`).
- CI apply order already places lambda/cloudfront in same final group (`.github/workflows/terraform-apply.yml:104-113`).
- For this fix, single-module apply of `cloudfront` can be sufficient because permission resource is in cloudfront module.
- If live drift exists in lambda policy, verify policy immediately after apply (see validation commands).

## Validation Commands (No code changes; for Plan/Implement phases)

1. Confirm failing behavior before apply:

```bash
curl -i -sS https://d11tzwdbun5b5c.cloudfront.net/api/transactions | head -n 40
curl -i -sS -X OPTIONS https://d11tzwdbun5b5c.cloudfront.net/api/transactions \
  -H 'Origin: https://d11tzwdbun5b5c.cloudfront.net' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: x-authorization,content-type' | head -n 60
```

2. Inspect live Function URL config and resource policy:

```bash
aws lambda get-function-url-config --function-name zaim-csv-api --region ap-northeast-1
aws lambda get-policy --function-name zaim-csv-api --region ap-northeast-1 | jq -r '.Policy' | jq
```

3. Verify both required actions exist and are CloudFront-scoped:

```bash
aws lambda get-policy --function-name zaim-csv-api --region ap-northeast-1 \
  | jq -r '.Policy' | jq '.Statement[] | {Sid,Action,Principal,Condition}'
```

4. Terraform/Terragrunt verification (after fix implementation in next phase):

```bash
cd infra/envs/prod/cloudfront
terragrunt plan
terragrunt apply --terragrunt-non-interactive
terragrunt plan  # expect no diff
```

5. Re-test endpoint:

```bash
curl -i -sS https://d11tzwdbun5b5c.cloudfront.net/api/transactions | head -n 40
```

Expected post-fix behavior:
- 403 should change from `AccessDeniedException` to backend-layer auth response (typically 401 if JWT missing/invalid).

## Constraints & Gotchas

- CloudFront OAC uses `Authorization` for SigV4; JWT must remain `X-Authorization`.
- API 403 responses must not be rewritten by SPA fallback; current config correctly rewrites only 404 (`infra/modules/cloudfront/main.tf:144-150`).
- Repository has prior history of manual permission changes and import/state mismatch; always validate live policy after apply.
- `.terragrunt-cache` contains stale generated copies; use source under `infra/modules/**` and `infra/envs/**` as truth.
- Existing tests are effectively absent in repository:
  - `pytest -q` result: `no tests ran`.
  - No frontend test scripts/files detected.

## Open Questions

1. Is live AWS policy currently drifted from Terraform state (manual edits/import mismatch)?
2. Should the second permission include additional conditions beyond `source_arn` (provider capability-dependent)?
3. Should future migration back to `authorization_type = AWS_IAM` be re-scoped only after CORS/update-function-url-config issue is fully resolved and documented?

Research complete. Review docs/completed/research-cloudfront-lambda-403.md before starting the Plan phase.
