import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MoneySchema,
  NAMED_SCHEMAS,
  ROUTES,
  UnitsSchema,
} from '@synq/contracts';
import { openApi, swiftModels } from '../../packages/contracts/src/codegen.js';
import { FIXTURES } from '../../packages/contracts/src/fixtures.js';

const generated = join(__dirname, '../../packages/contracts/generated');

describe('app API contract', () => {
  it('keeps the generated OpenAPI, Swift models and fixtures in step with the schemas', () => {
    expect(
      JSON.parse(readFileSync(join(generated, 'openapi.json'), 'utf8')),
    ).toEqual(openApi());
    expect(
      readFileSync(join(generated, 'swift/SynqContracts.swift'), 'utf8'),
    ).toBe(swiftModels());
    const files = readdirSync(join(generated, 'fixtures')).sort();
    expect(files).toEqual(
      Object.keys(FIXTURES)
        .map((n) => `${n}.json`)
        .sort(),
    );
    for (const [name, value] of Object.entries(FIXTURES))
      expect(
        JSON.parse(
          readFileSync(join(generated, 'fixtures', `${name}.json`), 'utf8'),
        ),
      ).toEqual(value);
  });

  it('has one route per id and per method and path, all under /v3', () => {
    expect(new Set(ROUTES.map((r) => r.id)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(
      ROUTES.length,
    );
    for (const r of ROUTES) {
      expect(r.path.startsWith('/v3/')).toBe(true);
      if (r.method === 'GET') expect(r.request).toBeUndefined();
      if (r.path.includes('{workspaceId}')) expect(r.auth).not.toBe('none');
    }
  });

  it('names every response and request schema so clients get a generated type', () => {
    const named = new Set(Object.values(NAMED_SCHEMAS));
    for (const r of ROUTES) {
      if (r.response !== 'text/event-stream')
        expect(named.has(r.response)).toBe(true);
      if (r.request) expect(named.has(r.request)).toBe(true);
    }
  });

  it('accepts every synthetic fixture with its schema', () => {
    for (const [name, value] of Object.entries(FIXTURES)) {
      const schema = NAMED_SCHEMAS[name];
      expect(schema, name).toBeDefined();
      expect(schema!.safeParse(value).success, name).toBe(true);
    }
  });

  it('carries money only as integer base-unit strings', () => {
    for (const bad of ['1.5', '-1', '01', '', '1e6'])
      expect(UnitsSchema.safeParse(bad).success).toBe(false);
    expect(
      MoneySchema.safeParse({
        assetId: 'arc-testnet:USDC',
        symbol: 'USDC',
        chainId: 5042002,
        decimals: 6,
        units: 40000000,
      }).success,
    ).toBe(false);
  });
});
