# Research: Chart.js controller registration error

## Topic
`"bar" is not a registered controller.` が発生し、グラフが描画されない問題。

## Files inspected
- `frontend/src/charts.ts`
- `frontend/src/main.ts`
- `frontend/package.json`

## Findings
1. `frontend/package.json` では `chart.js` が `^4.4.3`。
2. `frontend/src/charts.ts` で `Chart.register(...)` しているのは以下のみ:
   - `BarElement`, `LineElement`, `ArcElement`
   - `CategoryScale`, `LinearScale`, `PointElement`
   - `Tooltip`, `Legend`
3. Chart.js v3+ は tree-shaking 前提で、チャート種別に対応する `Controller` が未登録だと実行時に `"<type>" is not a registered controller.` になる。
4. 現在は `type: 'bar'`, `type: 'doughnut'`, `type: 'line'` を使っているため、少なくとも次の controller 登録が必要:
   - `BarController`
   - `DoughnutController`
   - `LineController`

## Root cause
`charts.ts` で要素やスケールは登録しているが、`bar/doughnut/line` の controller を登録していない。

## Impact
- すべてのグラフ描画処理が `new Chart(...)` 実行時に失敗する可能性がある。
- データ取得/保存が成功していても、画面上は「描画されない」症状になる。

## Candidate fixes
- A. 必要な controller を明示的に import/register（最小差分）
- B. `registerables` を一括登録（実装簡単だがバンドルサイズ増加余地）

## Recommended approach
A. 明示登録（既存の tree-shaking 方針に合う、変更範囲が小さい）。
