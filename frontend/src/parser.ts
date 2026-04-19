import Papa from 'papaparse';
import type { ZaimRow, TransactionType } from './types';

async function detectEncoding(file: File): Promise<string> {
  const probe = await file.slice(0, 4096).arrayBuffer();
  const bytes = new Uint8Array(probe);

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'UTF-8';
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(probe);
    return 'UTF-8';
  } catch {
    return 'Shift-JIS';
  }
}

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
