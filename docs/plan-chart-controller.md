# Plan: Fix Chart.js controller registration

## Goal
`"bar" is not a registered controller.` を解消し、既存4チャートを再描画可能にする。

## Scope
- 変更対象: `frontend/src/charts.ts` のみ
- 非対象: API/バックエンド/インフラ

## Tasks
1. `frontend/src/charts.ts` の import に controller を追加
   - 追加: `BarController`, `DoughnutController`, `LineController`
2. `Chart.register(...)` に上記 controller を追加
3. `npm run build` で型エラー/ビルドエラーがないことを確認

## Before / After snippet
### Before
```ts
import {
  Chart,
  BarElement,
  LineElement,
  ArcElement,
  CategoryScale,
  LinearScale,
  PointElement,
  Tooltip,
  Legend,
} from 'chart.js';

Chart.register(
  BarElement,
  LineElement,
  ArcElement,
  CategoryScale,
  LinearScale,
  PointElement,
  Tooltip,
  Legend
);
```

### After
```ts
import {
  Chart,
  BarController,
  DoughnutController,
  LineController,
  BarElement,
  LineElement,
  ArcElement,
  CategoryScale,
  LinearScale,
  PointElement,
  Tooltip,
  Legend,
} from 'chart.js';

Chart.register(
  BarController,
  DoughnutController,
  LineController,
  BarElement,
  LineElement,
  ArcElement,
  CategoryScale,
  LinearScale,
  PointElement,
  Tooltip,
  Legend
);
```

## Trade-offs
- 明示登録の利点: 必要な機能だけ登録でき、バンドル肥大を抑えやすい。
- 一括登録(`registerables`)の利点: 設定漏れを防げる。欠点は不要コンポーネントも含みやすい。

## Validation
- `npm run build` が成功
- ブラウザで CSV 読み込み後に 4 チャートが描画される

## Rollback
- 変更は `charts.ts` の import/register のみなので、単一コミットの revert で戻せる。
