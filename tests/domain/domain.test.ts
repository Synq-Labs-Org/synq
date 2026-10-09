import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AmountSchema,
  AssetSchema,
  NetworkProfileSchema,
  PluginManifestSchema,
  UINT256_MAX,
} from '../../packages/schemas/src/index.js';
import {
  ACTION_STATES,
  UniqueIds,
  delegateCapabilities,
  formatDecimal,
  fromAmount,
  newId,
  parseDecimal,
  toAmount,
  transition,
} from '../../packages/domain/src/index.js';
import {
  PluginRegistry,
  type SynqPlugin,
} from '../../packages/plugin-sdk/src/index.js';
import { asset, intent, mandate, network } from '../kernel/fixtures.js';

describe('Canonical domain boundaries', () => {
  it('DOM-001 rejects unknown/nested fields and unsupported economic inputs', () => {
    for (const patch of [
      { extra: true },
      { chainId: 1 },
      { action: 'OWNER_CHANGE' },
      { maxInputAmount: 25 },
      { maxInputAmount: '-1' },
      { maxInputAmount: '01' },
      { maxInputAmount: '1.5' },
      { target: '0x123' },
      { validUntil: 900 },
      { inputAsset: { ...asset, secret: 'PAN' } },
    ])
      expect(() => intent(patch)).toThrow();
    expect(() => mandate({ quorum: 4 })).toThrow();
    expect(() => mandate({ perActionCap: '201' })).toThrow();
    expect(() => mandate({ unknown: 'field' })).toThrow();
  });
  it('DOM-002 losslessly serializes uint256 and decimal money', () => {
    expect(fromAmount(JSON.parse(JSON.stringify(toAmount(UINT256_MAX))))).toBe(
      UINT256_MAX,
    );
    expect(() => AmountSchema.parse((UINT256_MAX + 1n).toString())).toThrow();
    expect(() => toAmount(-1n)).toThrow();
    expect(parseDecimal('999999999999.123456', 6)).toBe(999999999999123456n);
    expect(() => parseDecimal('1.0000001', 6)).toThrow('DECIMAL_PRECISION');
    expect(() => parseDecimal('1e5', 6)).toThrow();
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: UINT256_MAX }),
        fc.integer({ min: 0, max: 36 }),
        (value, decimals) => {
          expect(parseDecimal(formatDecimal(value, decimals), decimals)).toBe(
            value,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
  it('DOM-003 permits canonical mock lifecycle and blocks skipped custody states', () => {
    const path = ACTION_STATES.slice(0, 15);
    for (let i = 0; i < path.length - 1; i++)
      expect(transition(path[i]!, path[i + 1]!)).toBe(path[i + 1]);
    expect(() => transition('PROPOSED', 'SIGNED')).toThrow();
    expect(() => transition('EXPIRED', 'AUTHORIZED')).toThrow();
    expect(() => transition('CANCELLED', 'SUBMITTED')).toThrow();
  });
  it('DOM-004 requires exact network/asset identity', () => {
    expect(NetworkProfileSchema.parse(network)).toEqual(network);
    expect(() =>
      NetworkProfileSchema.parse({ ...network, chainId: 143 }),
    ).toThrow();
    expect(() =>
      NetworkProfileSchema.parse({
        ...network,
        providerEnvironment: 'production',
      }),
    ).toThrow();
    expect(() =>
      AssetSchema.parse({
        ...asset,
        canonicalAssetId: 'eip155:143/erc20:' + asset.address,
      }),
    ).toThrow();
  });
  it('DOM-005 generates unique branded identifiers and rejects replay insert', () => {
    const values = Array.from({ length: 500 }, () => newId('intent'));
    expect(new Set(values).size).toBe(values.length);
    const store = new UniqueIds();
    store.claim(values[0]!);
    expect(() => store.claim(values[0]!)).toThrow('DUPLICATE_ID');
  });
  it('enforces delegable subsets and immutable plugin registration boundaries', () => {
    expect(
      delegateCapabilities(
        ['READ_MARKET', 'PROPOSE_ACTION'],
        ['PROPOSE_ACTION'],
      ),
    ).toEqual(['PROPOSE_ACTION']);
    expect(() => delegateCapabilities(['SIGN'], ['SIGN'])).toThrow();
    expect(() => delegateCapabilities(['READ_MARKET'], ['QUOTE'])).toThrow();
    const manifest = PluginManifestSchema.parse({
      id: 'local',
      version: '1.0.0',
      capabilities: ['READ_MARKET'],
      chains: [31337],
      environments: ['local'],
      riskClass: 'READ_ONLY',
      requiresSimulation: false,
      maxGrantTtlSeconds: 60,
      sourceDocs: ['https://example.com/docs'],
    });
    const plugin: SynqPlugin = {
      manifest,
      health: async () => ({ available: true, checkedAt: 1000 }),
    };
    const registry = new PluginRegistry();
    registry.register(plugin);
    expect(() => registry.register(plugin)).toThrow('PLUGIN_CONFLICT');
    expect(() =>
      registry.register({
        ...plugin,
        manifest: {
          ...manifest,
          id: 'mutator',
          riskClass: 'FINANCIAL_EXECUTION',
          requiresSimulation: true,
        },
      }),
    ).toThrow('PLUGIN_MUTATOR_INCOMPLETE');
    expect(() =>
      PluginManifestSchema.parse({ ...manifest, capabilities: ['SIGN'] }),
    ).toThrow();
  });
});
