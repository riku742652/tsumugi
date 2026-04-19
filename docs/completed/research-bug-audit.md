# Research: Bug Audit

## Relevant Files

| File | Role |
|------|------|
| `frontend/src/main.ts` | Auth flow, CSV upload, filter UI, chart orchestration |
| `frontend/src/parser.ts` | PapaParse CSV parsing, column mapping, filtering |
| `frontend/src/api.ts` | HTTP calls to backend with JWT token |
| `frontend/src/auth.ts` | Cognito Amplify wrapper — signIn/signOut/getIdToken |
| `frontend/src/types.ts` | Shared TypeScript types |
| `frontend/src/charts.ts` | Chart.js aggregation and rendering |
| `frontend/index.html` | DOM structure |
| `backend/app/main.py` | FastAPI app, CORS middleware, router registration |
| `backend/app/auth.py` | JWT extraction/validation from X-Authorization header |
| `backend/app/models.py` | Pydantic Transaction model |
| `backend/app/routers/upload.py` | POST /api/transactions — DynamoDB batch write |
| `backend/app/routers/transactions.py` | GET /api/transactions — DynamoDB GSI query |
| `backend/Dockerfile` | Lambda Web Adapter container |
| `backend/requirements.txt` | Python dependency versions |
| `infra/modules/cloudfront/main.tf` | CloudFront distribution, S3/Lambda origins, permissions |
| `infra/modules/lambda/main.tf` | Lambda function, IAM role, Function URL |
| `infra/modules/dynamodb/main.tf` | DynamoDB table and GSI definition |
| `infra/modules/cognito/main.tf` | Cognito user pool and app client |
| `infra/envs/prod/cloudfront/terragrunt.hcl` | CloudFront Terragrunt wiring |
| `infra/envs/prod/lambda/terragrunt.hcl` | Lambda Terragrunt wiring |

---

## Bug Findings

---

### BUG-01: Token expiry — no automatic retry on 401

**Severity:** High  
**File:** `frontend/src/api.ts` (all fetch calls), `frontend/src/auth.ts`

**Root cause:**  
`getIdToken()` calls `fetchAuthSession()` from aws-amplify. By default, `fetchAuthSession()` returns the cached session and does NOT force-refresh if the ID token has expired. Amplify only refreshes automatically when `forceRefresh: true` is passed. Because the app fetches the token once per request without any retry logic, an expired ID token will silently produce a Bearer token that is rejected with 401 by the backend. The `api.ts` error handling translates this to `throw new Error("Fetch failed: 401")` — no refresh attempt is made, and the user is left stuck until they manually log out and back in.

**Specific location:**
- `frontend/src/auth.ts` line 26: `fetchAuthSession()` — no `{ forceRefresh: true }` or expiry check
- `frontend/src/api.ts` lines 9, 26: token fetched but 401 is not caught and retried

**Reproduction:** Log in, wait for the Cognito ID token to expire (default 60 minutes), then click "データ取得" — the fetch returns 401 and shows a raw error to the user.

---

### BUG-02: CSV encoding — Shift-JIS files silently produce mojibake

**Severity:** High  
**File:** `frontend/src/parser.ts`

**Root cause:**  
Zaim CSV exports are commonly saved in Shift-JIS (CP932) encoding, especially when opened and re-saved in Excel on Windows or macOS. `Papa.parse(file, ...)` receives the `File` object without specifying an encoding. PapaParse defaults to reading the file as UTF-8 via the FileReader API. A Shift-JIS file parsed as UTF-8 will produce garbage Japanese text (mojibake) for all string columns — the parse itself succeeds without error, so `error()` is never called. All transactions will be stored with corrupted `category`, `subcategory`, `shop`, etc. fields.

**Specific location:**
- `frontend/src/parser.ts` line 9: `Papa.parse<string[]>(file, { skipEmptyLines: true, ... })` — missing `encoding: 'Shift-JIS'` or auto-detection logic

**Note:** PapaParse supports an `encoding` option that passes through to `FileReader.readAsText`. The correct fix would be to auto-detect (BOM, chardet) or always request Shift-JIS since Zaim is a Japanese product.

---

### BUG-03: Date filter uses `-31` for month-end — invalid for short months

**Severity:** Medium  
**File:** `frontend/src/main.ts` line 164

**Root cause:**  
```ts
const to = toFilter.value ? toFilter.value + '-31' : undefined;
```
`toFilter.value` is a `YYYY-MM` string from an `<input type="month">`. Appending `-31` produces `YYYY-MM-31`, which is an invalid date for February (max 28/29) and for 30-day months (April, June, September, November). The string is passed directly to the DynamoDB `Key("date").lte(to_date)` comparison in `transactions.py`. Because DynamoDB uses lexicographic string comparison on `date`, `"2024-02-31"` is lexicographically greater than any valid February date, so the filter happens to work correctly for months with fewer than 31 days. However, this relies on an undefined/invalid date string being usable in lexicographic sort, and the backend does no validation of the date strings — any validation library added later could reject the invalid date. It is also confusing to developers and testers.

**Specific location:**
- `frontend/src/main.ts` line 164: `toFilter.value + '-31'`

---

### BUG-04: `upload.py` overrides `userId` in item but model already contains it

**Severity:** Medium  
**File:** `backend/app/routers/upload.py` lines 37-39

**Root cause:**  
```python
items.append({
    k: (Decimal(str(v)) if isinstance(v, float) else v)
    for k, v in {**tx.model_dump(), "userId": user_id}.items()
})
```
The `Transaction` Pydantic model (from `models.py`) includes `userId` as a required field. The client sends `userId` in the JSON body (set in `main.ts` to `user.userId` from Cognito). The upload router merges `"userId": user_id` (from the verified JWT) into `tx.model_dump()`. Because dict merge order is `{**tx.model_dump(), "userId": user_id}`, the JWT-derived `user_id` always wins over the client-supplied value. This is the correct security behavior — but the design allows any client to send an arbitrary `userId` in the body, which is silently ignored. If the merging order were accidentally reversed (e.g., `{"userId": user_id, **tx.model_dump()}`), the client could store data under any user's partition key. This is a latent design risk rather than a currently-exploitable bug, but it is worth noting that `userId` should be removed from the client-facing `Transaction` model entirely.

**Specific location:**
- `backend/app/models.py` line 8: `userId: str` is a required field on the shared model
- `backend/app/routers/upload.py` line 39: `{**tx.model_dump(), "userId": user_id}` — correct order but fragile

---

### BUG-05: Chart rendering on empty data — `new Chart()` called with empty labels and datasets

**Severity:** Low  
**File:** `frontend/src/charts.ts`

**Root cause:**  
All four render functions call `new Chart(canvas, ...)` even when `data` is empty or when the filtered subset (e.g., only `type === 'payment'`) is empty. Chart.js will render an empty canvas with axes but no data, which is visually confusing (blank chart area, no legend). More specifically:

- `renderCategoryBreakdown` (line 63): filters to `payments`. If there are no payment transactions, `labels = []` and `values = []`. A doughnut chart with zero datasets renders as a blank grey circle.
- `renderCategoryTrend` (line 122): `top5 = []` when payments is empty → `datasets = []` → line chart renders with empty canvas and no legend.

There is no guard like `if (data.length === 0) { /* show placeholder */ return; }`.

**Specific location:**
- `frontend/src/charts.ts` lines 47, 62, 90, 119 — no empty-data guards before `new Chart(...)`

---

### BUG-06: Category doughnut palette is capped at 10 colors — overflow produces `undefined` backgroundColor

**Severity:** Low  
**File:** `frontend/src/charts.ts` lines 71-74, 79

**Root cause:**  
```ts
const palette = ['#1976d2', '#388e3c', ...]; // 10 colors
...
backgroundColor: palette.slice(0, labels.length)
```
`palette.slice(0, labels.length)` when `labels.length > 10` returns only 10 elements. Chart.js requires the `backgroundColor` array to match the number of data points. When there are more than 10 categories, the 11th+ slices get `undefined` as their background color, which Chart.js renders as transparent (invisible) segments. A user with more than 10 expense categories will see missing slices in the doughnut with no error.

**Specific location:**
- `frontend/src/charts.ts` line 79: `palette.slice(0, labels.length)` — palette length not extended for >10 categories

---

### BUG-07: CORS `allow_credentials=False` conflicts with `allow_origins=["*"]` — but also blocks real credential use

**Severity:** Low  
**File:** `backend/app/main.py` lines 25-31

**Root cause:**  
The CORS middleware is configured with `allow_credentials=False`. Since credentials (cookies, auth headers) are not needed for this app's CORS flow (the JWT is in `X-Authorization`, not a cookie), this is acceptable. However, this means any future use of `credentials: 'include'` in `fetch()` will be silently blocked by the browser, producing a CORS error that is hard to diagnose. Additionally, when `CLOUDFRONT_DOMAIN` is not set (e.g., local development), `origins = ["*"]` — this is a wildcard that would allow any origin to call the API. In production the env var is set, so this is only a risk in local/dev environments, but it means a developer running locally with a real `DYNAMODB_TABLE` env var has no origin protection.

**Specific location:**
- `backend/app/main.py` lines 22-31

---

### BUG-08: JWKS cached forever — no TTL, no refresh on key rotation

**Severity:** Low  
**File:** `backend/app/auth.py` lines 9-18

**Root cause:**  
```python
_jwks: dict | None = None

def _get_jwks() -> dict:
    global _jwks
    if _jwks is None:
        _jwks = requests.get(url, timeout=5).json()
    return _jwks
```
The JWKS is fetched once at startup and cached for the lifetime of the Lambda execution environment (potentially hours or days if the container is warm). Cognito rotates its signing keys periodically. If Cognito rotates its RSA keys while a Lambda container is warm, all new tokens signed with the new key will fail JWT verification because the old JWKS is in the in-memory cache. The Lambda will need to be cold-started (or redeployed) to pick up the new keys. This is a rare but possible failure mode in long-running warm containers.

**Specific location:**
- `backend/app/auth.py` lines 9-18: `_jwks` never invalidated after initial fetch

---

### BUG-09: `parser.ts` does not validate date format — invalid dates stored in DynamoDB

**Severity:** Low  
**File:** `frontend/src/parser.ts` line 16

**Root cause:**  
```ts
date: cols[0] ?? '',
```
The `date` field is taken raw from column 0 of the CSV with no format validation. Zaim exports dates as `YYYY-MM-DD`, but if the user uploads a different CSV or a Zaim export with a malformed header row, the date could be empty string, a non-ISO format, or a header label. Empty date is particularly dangerous because:
1. `txId` is computed as `${row.date}#${hex}` in `main.ts` line 99 — an empty date produces a txId like `#abc123`, which is a valid DynamoDB string key.
2. DynamoDB GSI range key queries on `date` via `Key("date").gte(from_date)` will include empty-string dates since `""` lexicographically precedes all valid dates.

**Specific location:**
- `frontend/src/parser.ts` line 16
- `frontend/src/main.ts` line 99

---

### BUG-10: Lambda Function URL is publicly accessible — no network-level restriction to CloudFront

**Severity:** Medium (security/architecture)  
**File:** `infra/modules/cloudfront/main.tf` lines 157-170

**Root cause:**  
The Lambda Function URL `authorization_type = "NONE"` with `principal = "*"` for both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` means the Function URL is fully publicly accessible from any client, bypassing CloudFront entirely. The comment in the Terraform code correctly states that "security is enforced by JWT validation in FastAPI." However, this means:
1. Anyone who discovers the Lambda Function URL (e.g., via DNS enumeration or traffic inspection) can call it directly.
2. CORS origin checking in FastAPI (`allow_origins = [f"https://{cloudfront_domain}"]`) is bypassed if `CLOUDFRONT_DOMAIN` is empty or the request omits the `Origin` header.
3. Rate limiting / WAF applied at CloudFront does not protect the Lambda URL.

This was a deliberate trade-off (the `cloudfront-lambda-aws-iam-cors` feature is in-progress to migrate to `AWS_IAM`), but it is a meaningful security gap in the current state.

**Specific location:**
- `infra/modules/cloudfront/main.tf` lines 157-170
- `infra/modules/lambda/main.tf` line 133: `authorization_type = "NONE"`

---

### BUG-11: `transactions.py` queries on `date` GSI but primary table key is `txId` — duplicate dates per user cause GSI fan-out

**Severity:** Low (operational)  
**File:** `backend/app/routers/transactions.py`, `infra/modules/dynamodb/main.tf`

**Root cause:**  
The DynamoDB table uses `userId` (hash) + `txId` (range) as the primary key. The GSI `userId-date-index` uses `userId` (hash) + `date` (range). Multiple transactions on the same date have the same GSI range key value. DynamoDB GSI range keys are NOT unique within the index — multiple items with the same `(userId, date)` pair are all stored in the GSI and returned by a `between` query. This is correct behavior and the pagination loop handles it. However, it means that a date-range query can return very large result sets for users with many transactions on a single date, and there is no `Limit` parameter set. For large datasets this could cause the Lambda to hit its 6 MB response payload limit or 30-second timeout.

**Specific location:**
- `backend/app/routers/transactions.py` lines 37-49: no `Limit` on DynamoDB query

---

## Summary Table

| ID | Severity | Area | Title |
|----|----------|------|-------|
| BUG-01 | High | Frontend / Auth | Expired Cognito token causes silent 401 with no refresh |
| BUG-02 | High | Frontend / Parser | Shift-JIS CSV produces mojibake without error |
| BUG-03 | Medium | Frontend / Filter | Month-end date appended as `-31` — invalid for short months |
| BUG-04 | Medium | Backend / Upload | `userId` in client request body silently ignored but fragile design |
| BUG-05 | Low | Frontend / Charts | No empty-data guard — blank charts rendered without message |
| BUG-06 | Low | Frontend / Charts | Doughnut palette capped at 10 — >10 categories render transparent |
| BUG-07 | Low | Backend / CORS | Wildcard origin in local/dev environment; credentials config ambiguity |
| BUG-08 | Low | Backend / Auth | JWKS cached forever — key rotation breaks JWT validation in warm Lambdas |
| BUG-09 | Low | Frontend / Parser | No date format validation — empty/malformed dates stored silently |
| BUG-10 | Medium | Infra / Security | Lambda Function URL publicly accessible, bypasses CloudFront protection |
| BUG-11 | Low | Backend / DynamoDB | No query `Limit` — large result sets could hit Lambda payload/timeout limits |
