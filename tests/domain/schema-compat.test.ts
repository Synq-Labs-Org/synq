import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ActionIntentSchema,
  BoundActionIntentSchema,
  PluginManifestSchema,
} from '@synq/schemas';

const fixtures = resolve('tests/fixtures/pack');
function referencePack(): string | null {
  for (let dir = resolve('.'); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = resolve(
      dir,
      '..',
      'Synq_Agent_Build_Pack_v1.2',
      'schemas',
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
const pack = referencePack();
const examples = [
  'action-intent.example.json',
  'plugin-manifest.example.json',
] as const;
const load = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(fixtures, name), 'utf8'));

describe('schema compatibility with the reference pack examples', () => {
  it.runIf(pack !== null)(
    'fixtures are byte-identical to the reference pack examples',
    () => {
      for (const name of examples)
        expect(readFileSync(resolve(fixtures, name), 'utf8')).toBe(
          readFileSync(resolve(pack!, name), 'utf8'),
        );
    },
  );
  it('DOM-001 pack ActionIntent example parses and round-trips with safe defaults', () => {
    const intent = ActionIntentSchema.parse(load(examples[0]));
    expect(intent).toMatchObject({
      schemaVersion: 1,
      action: 'SPOT_TRADE',
      chainId: 10143,
      maxInputAmount: '25000000',
      nativeValue: '0',
      maxSlippageBps: 0,
      leverageBps: 0,
    });
    expect(intent.selector).toBeUndefined();
    expect(intent.calldataHash).toBeUndefined();
    expect(
      ActionIntentSchema.parse(JSON.parse(JSON.stringify(intent))),
    ).toEqual(intent);
  });
  it('pack ActionIntent example carries no execution authority until bound', () => {
    const result = BoundActionIntentSchema.safeParse(load(examples[0]));
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((i) => i.path.join('.')) ?? [];
    for (const field of [
      'target',
      'selector',
      'calldataHash',
      'inputToken',
      'account',
      'operator',
    ])
      expect(paths).toContain(field);
  });
  it('PLG-005 pack PluginManifest example parses with defaults and rejects extras', () => {
    const raw = load(examples[1]);
    const manifest = PluginManifestSchema.parse(raw);
    expect(manifest).toMatchObject({
      id: 'kuru',
      riskClass: 'FINANCIAL_EXECUTION',
      environments: ['proof/monad-mainnet'],
      dependencies: {},
      sourceDocs: [],
      health: { maxStalenessSeconds: 60, checks: [] },
    });
    expect(
      PluginManifestSchema.safeParse({
        ...(raw as Record<string, unknown>),
        privateKey: 'x',
      }).success,
    ).toBe(false);
  });
  it('provider action kinds accept a provider reference target; on-chain kinds do not', () => {
    const base = load(examples[0]) as Record<string, unknown>;
    expect(
      ActionIntentSchema.parse({
        ...base,
        action: 'CARD_PAYMENT',
        target: 'immersve:card/abc-123',
      }).target,
    ).toBe('immersve:card/abc-123');
    expect(
      ActionIntentSchema.safeParse({
        ...base,
        action: 'SPOT_TRADE',
        target: 'kuru:market/mon-ausd',
      }).success,
    ).toBe(false);
    expect(
      ActionIntentSchema.safeParse({
        ...base,
        action: 'X402_PAYMENT',
        target: 'not a ref',
      }).success,
    ).toBe(false);
  });
});
