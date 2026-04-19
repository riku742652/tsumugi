# Plan: bug-high (BUG-01 + BUG-02)

## Overview

Two HIGH severity bugs exist in the frontend that silently corrupt user data or block access.
BUG-01: when a Cognito ID token expires the API call fails with 401 and the user is stuck — there is
no refresh attempt and no re-login prompt. BUG-02: Zaim CSV files saved in Shift-JIS encoding (common
on Windows/Excel) are parsed as UTF-8 by PapaParse, producing mojibake in every Japanese string column
that is then stored silently into DynamoDB. Both bugs are frontend-only, require no backend changes,
and can be fixed independently.

---

## Tasks

### Task 1: Force-refresh the Cognito session before returning the token (auth.ts)

- **File:** `frontend/src/auth.ts`
- **Line:** 26
- **Change:** Pass `{ forceRefresh: true }` to `fetchAuthSession()` so Amplify always exchanges the
  refresh token for a fresh ID token before the caller uses it. Amplify throws if the refresh token
  itself is expired or the session does not exist, which is the correct signal to re-authenticate.

Before (line 26):
```ts
const session = await fetchAuthSession();
```

After:
```ts
const session = await fetchAuthSession({ forceRefresh: true });
```

- **Why:** Without `forceRefresh`, Amplify returns the in-memory cached session, which can contain an
  expired ID token. The backend rejects the token with 401, but the frontend has no retry logic, so
  the user is silently stuck. Forcing a refresh on every API call is cheap (a single Cognito token
  endpoint call) and eliminates the silent failure entirely.

---

### Task 2: Catch 401 in api.ts, clear the session, and redirect to login (api.ts)

- **File:** `frontend/src/api.ts`
- **Lines:** 18, 34 (the two `if (!res.ok) throw` guards)
- **Change:** Add a shared helper that checks for 401 specifically, signs the user out, and redirects
  to the root page (which triggers the login flow in `main.ts`). Apply it to both `uploadTransactions`
  and `fetchTransactions`.

Before (line 18):
```ts
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
```

Before (line 34):
```ts
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
```

After — add a helper at the top of the file (after the imports), then update both guards:
```ts
import { getIdToken, signOut } from './auth';

async function handleUnauthorized(res: Response, context: string): Promise<never> {
  if (res.status === 401) {
    await signOut();
    window.location.href = '/';
  }
  throw new Error(`${context}: ${res.status}`);
}
```

```ts
  // uploadTransactions, line 18:
  if (!res.ok) return handleUnauthorized(res, 'Upload failed');
```

```ts
  // fetchTransactions, line 34:
  if (!res.ok) return handleUnauthorized(res, 'Fetch failed');
```

- **Why:** Even with `forceRefresh: true` in Task 1, a 401 can still arrive if the refresh token is
  expired (session is fully dead) or if Cognito rejects the token for another reason. Without an
  explicit 401 handler the user is shown a raw error string with no path back. Signing out and
  redirecting to `/` drops the dead session and lets the user log in again cleanly.
- **Note:** `signOut` is already exported from `auth.ts` (line 12). The import on line 1 of `api.ts`
  must be updated from `import { getIdToken }` to `import { getIdToken, signOut }`.

---

### Task 3: Detect Shift-JIS encoding before parsing and re-parse with correct encoding (parser.ts)

- **File:** `frontend/src/parser.ts`
- **Line:** 9 (the `Papa.parse` call)
- **Change:** Read the first 4 KB of the file as an `ArrayBuffer`, use `TextDecoder` to probe for
  Shift-JIS by checking for a UTF-8 BOM (`0xEF 0xBB 0xBF`) or for byte sequences that are invalid
  in UTF-8 but valid in Shift-JIS. If Shift-JIS is detected, pass `encoding: 'Shift-JIS'` to
  PapaParse (which forwards it to `FileReader.readAsText`); otherwise use the default (UTF-8).

No new npm dependencies are required — `TextDecoder` is available in all modern browsers and in the
Vite build target, and PapaParse 5 already accepts an `encoding` option natively.

Before (lines 8-11):
```ts
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete(results) {
```

After:
```ts
  return new Promise((resolve, reject) => {
    detectEncoding(file).then((encoding) => {
      Papa.parse<string[]>(file, {
        skipEmptyLines: true,
        encoding,
        complete(results) {
```

Add the `detectEncoding` helper above `parseZaimCsv` (no imports needed):

```ts
/**
 * Returns 'Shift-JIS' when the file begins with a Shift-JIS BOM (0x82 0xEF...)
 * or contains byte sequences that are illegal in UTF-8.
 * Falls back to 'UTF-8' (PapaParse default) otherwise.
 */
async function detectEncoding(file: File): Promise<string> {
  const probe = await file.slice(0, 4096).arrayBuffer();
  const bytes = new Uint8Array(probe);

  // UTF-8 BOM: EF BB BF — already UTF-8
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'UTF-8';
  }

  // Shift-JIS BOM (rare but possible): 82 EF ...
  // More reliable: try decoding as UTF-8 with fatal=true; if it throws the file is not UTF-8.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(probe);
    return 'UTF-8';
  } catch {
    return 'Shift-JIS';
  }
}
```

- **Why:** `TextDecoder('utf-8', { fatal: true })` throws a `TypeError` on the first byte sequence
  that is not valid UTF-8. Shift-JIS double-byte sequences (e.g., `0x82 0xA0` for ã) are never
  valid UTF-8, so any Shift-JIS file with Japanese content will be detected correctly. A file that
  happens to be valid ASCII (no multi-byte characters) will be classified as UTF-8, which is also
  correct — ASCII is a strict subset of both encodings. The probe is limited to 4 KB to avoid reading
  large files entirely into memory.
- **Note:** PapaParse's `encoding` option is forwarded verbatim to `FileReader.readAsText(file, encoding)`.
  The string `'Shift-JIS'` is the IANA-registered label accepted by browsers. `'CP932'` is not
  universally accepted; use `'Shift-JIS'`.

---

### Task 4: Close the Promise correctly after adding the encoding detection wrapper (parser.ts)

- **File:** `frontend/src/parser.ts`
- **Lines:** 41-46 (the closing braces/parens of the `Papa.parse` call and the outer Promise)
- **Change:** The `Papa.parse` call moves inside the `.then()` callback of `detectEncoding`. The
  outer Promise's closing brace must wrap the `.then()` call, and the `.catch(reject)` must be
  chained to handle rejection from both `detectEncoding` and PapaParse's own `error` callback.

Complete final state of `parseZaimCsv` after Tasks 3 and 4:

```ts
export function parseZaimCsv(
  file: File,
  excludeNonAggregated = true
): Promise<ZaimRow[]> {
  return new Promise((resolve, reject) => {
    detectEncoding(file)
      .then((encoding) => {
        Papa.parse<string[]>(file, {
          skipEmptyLines: true,
          encoding,
          complete(results) {
            // Drop header row
            const [, ...rows] = results.data;

            const parsed: ZaimRow[] = rows.map((cols) => ({
              date: cols[0] ?? '',
              type: (cols[1] ?? '') as TransactionType,
              category: cols[2] ?? '',
              subcategory: cols[3] ?? '',
              from: cols[4] ?? '',
              to: cols[5] ?? '',
              item: cols[6] ?? '',
              memo: cols[7] ?? '',
              shop: cols[8] ?? '',
              currency: cols[9] ?? '',
              income: Number(cols[10] ?? 0),
              expense: Number(cols[11] ?? 0),
              transfer: Number(cols[12] ?? 0),
              balanceAdjustment: Number(cols[13] ?? 0),
              originalAmount: Number(cols[14] ?? 0),
              aggregation: cols[15] ?? '',
            }));

            const filtered = parsed.filter((row) => {
              if (row.type === 'balance') return false;
              if (excludeNonAggregated && row.aggregation === '集計に含めない') return false;
              return true;
            });

            resolve(filtered);
          },
          error(err) {
            reject(err);
          },
        });
      })
      .catch(reject);
  });
}
```

- **Why:** If `detectEncoding` rejects (which should be impossible since `arrayBuffer()` only fails
  on read errors), the outer Promise must also reject rather than hang. The `.catch(reject)` chain
  ensures this.

---

## Task Order

1. **Task 1** (auth.ts — forceRefresh) must be done first. It is the primary fix for BUG-01 and is
   a one-line change with no dependency on Task 2.
2. **Task 2** (api.ts — 401 handler) must follow Task 1 because it depends on the `signOut` export
   from `auth.ts` being present (it already is) and adds the fallback for fully-expired sessions.
   Tasks 1 and 2 together constitute the complete BUG-01 fix.
3. **Tasks 3 and 4** (parser.ts — encoding detection) are independent of Tasks 1-2 and fix BUG-02.
   They can be done in any order relative to Tasks 1-2, but Tasks 3 and 4 must be applied together
   as a single atomic edit to keep the file in a valid state.

---

## Trade-offs & Alternatives

### BUG-01

**Alternative A: Only add forceRefresh, no 401 handler.**
Simpler, but does not protect against fully-expired refresh tokens or other backend 401 causes. A
stuck user would still see a raw error string. Rejected — the user experience is still broken.

**Alternative B: Retry once on 401 without forceRefresh.**
On 401, call `fetchAuthSession({ forceRefresh: true })` and retry the request. More complex call
flow and could loop if the server returns 401 for non-token reasons (bad role, missing claim).
Rejected — proactively refreshing before each call (Task 1) is simpler and avoids the round-trip.

**Alternative C: Token expiry check using JWT decode before each call.**
Decode the JWT payload locally (base64), check `exp` against `Date.now()`, refresh only when
expired. Requires manually parsing the JWT or adding a library. PapaParse is already in-tree but
a JWT decode library is not. Rejected — `forceRefresh: true` is the officially supported Amplify
mechanism and avoids any clock-skew edge cases.

### BUG-02

**Alternative A: Always set `encoding: 'Shift-JIS'` unconditionally.**
Simplest possible fix. Works for all Zaim exports. Fails silently if the user uploads a UTF-8 CSV
(e.g., a CSV they edited and re-saved on macOS). UTF-8 characters outside the Shift-JIS range will
be corrupted. Rejected — too fragile for users who use different tools.

**Alternative B: Add `chardet` or a browser-side charset detection library.**
More accurate statistical detection. `chardet` (npm) supports many encodings but adds ~30 KB to
the bundle. For a two-encoding problem (Shift-JIS vs UTF-8) the `TextDecoder fatal` probe is 100%
accurate and adds zero bundle size. Rejected — unnecessary dependency.

**Alternative C: Show a UI selector to let the user choose encoding.**
Correct for edge cases but bad UX — most users do not know what Shift-JIS is. Rejected as
primary fix; could be added as a future enhancement.

---

## Out of Scope

- BUG-03 through BUG-11 (medium/low severity) — separate plan.
- Backend changes — no server-side work is required for either fix.
- UI loading states or error toasts — the redirect on 401 is sufficient for BUG-01; no UI change
  is needed for BUG-02 since the correct data will just appear.
- Unit/integration test files — the codebase has no existing test suite; adding tests is out of
  scope for this plan.
- `features.json` update — to be done by the developer after implementation is confirmed working.
