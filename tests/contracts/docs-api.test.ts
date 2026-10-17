import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '@synq/contracts';
import { generateApiDocs, root } from '../../scripts/docs-api-reference.js';

describe('API reference docs', () => {
  it('matches the committed Markdown (run `corepack pnpm docs:api` to refresh)', async () => {
    const generated = await generateApiDocs();
    expect(readdirSync(root).sort()).toEqual(Object.keys(generated).sort());
    for (const [name, text] of Object.entries(generated))
      expect(readFileSync(join(root, name), 'utf8')).toBe(text);
  });

  it('documents every route exactly once outside the schemas page', async () => {
    const generated = await generateApiDocs();
    const body = Object.entries(generated)
      .filter(([n]) => n.endsWith('.md') && !n.includes('schemas'))
      .map(([, t]) => t)
      .join('\n');
    for (const r of ROUTES) {
      const heading = `### ${r.method} ${r.path}\n`;
      expect(body.split(heading).length - 1).toBe(1);
    }
  });
});
