import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES } from '../packages/contracts/src/fixtures.js';
import { openApi, swiftModels } from '../packages/contracts/src/codegen.js';

// Writes the app API contract's OpenAPI document, Swift models and example
// responses (synthetic, for previews).
//   node --import tsx scripts/contracts-generate.ts
const root = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'contracts',
  'generated',
);
rmSync(join(root, 'fixtures'), { recursive: true, force: true });
mkdirSync(join(root, 'swift'), { recursive: true });
mkdirSync(join(root, 'fixtures'), { recursive: true });
writeFileSync(
  join(root, 'openapi.json'),
  `${JSON.stringify(openApi(), null, 2)}\n`,
);
writeFileSync(join(root, 'swift', 'SynqContracts.swift'), swiftModels());
for (const [name, value] of Object.entries(FIXTURES))
  writeFileSync(
    join(root, 'fixtures', `${name}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
  );
console.log(`wrote ${root}`);
