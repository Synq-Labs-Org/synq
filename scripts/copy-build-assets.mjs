import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/packages/read-model/sql', { recursive: true });
cpSync('packages/read-model/sql', 'dist/packages/read-model/sql', {
  recursive: true,
});
