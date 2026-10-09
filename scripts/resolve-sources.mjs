import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv, toCsv } from './csv.mjs';

const registryPath = 'sources/source_registry.csv';
const update = process.argv.includes('--update-registry');
const { header, rows } = parseCsv(readFileSync(registryPath, 'utf8'));
async function probe(row) {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(row.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'Synq-source-validation/0.2' },
    });
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      id: row.id,
      url: row.url,
      checkedAt,
      status: response.status,
      resolvedUrl: response.url,
      contentType: response.headers.get('content-type'),
      bytes: body.byteLength,
      ok: response.status >= 200 && response.status < 300,
    };
  } catch (error) {
    return {
      id: row.id,
      url: row.url,
      checkedAt,
      status: 'UNAVAILABLE',
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
}
const results = [];
for (let i = 0; i < rows.length; i += 8)
  results.push(...(await Promise.all(rows.slice(i, i + 8).map(probe))));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const directory = 'reports/evidence/source-resolution';
mkdirSync(directory, { recursive: true });
const evidence = join(directory, `${runId}.json`);
const failed = results.filter((r) => !r.ok);
writeFileSync(
  evidence,
  JSON.stringify(
    {
      test: 'P00-001',
      runId,
      checked: results.length,
      failed: failed.length,
      results,
    },
    null,
    2,
  ) + '\n',
);
if (update) {
  const today = runId.slice(0, 10);
  for (const row of rows)
    if (results.find((r) => r.id === row.id)?.ok) row.last_verified = today;
  writeFileSync(registryPath, toCsv(header, rows));
}
console.log(
  JSON.stringify(
    {
      evidence,
      checked: results.length,
      resolved: results.length - failed.length,
      failed: failed.map(({ id, url, status }) => ({ id, url, status })),
    },
    null,
    2,
  ),
);
if (failed.length) process.exitCode = 1;
