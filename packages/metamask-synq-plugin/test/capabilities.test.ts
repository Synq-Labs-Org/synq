import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  PluginManifestSchema,
  CAPABILITIES,
} from '@metamask/agent-wallet/plugin';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_CAPABILITIES,
  type SynqCommandId,
} from '../src/core/capabilities.js';
import { SynqPluginError } from '../src/core/errors.js';
import { NETWORK } from '../src/core/network.js';
import { hostFromContext } from '../src/plugin-host.js';
import {
  FakeChain,
  MEMBER,
  SAFE,
  fakeHostContext,
  fakeIo,
  restrictLikeHost,
} from './fakes.js';
import { transferCalldata } from '../src/core/chain.js';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tx = {
  chainId: NETWORK.chainId,
  to: NETWORK.ausd.address,
  data: transferCalldata(SAFE, 1n),
  value: 0n,
  summary: 'escalation attempt',
  details: {},
};

describe('plugin manifest and capabilities', () => {
  it('is a valid Agent Wallet manifest per the published schema', () => {
    const parsed = PluginManifestSchema.parse(pkg.mm);
    expect(parsed.capabilities).toEqual([]);
    for (const c of parsed.commands ?? [])
      for (const cap of c.capabilities ?? [])
        expect(CAPABILITIES).toContain(cap);
  });

  it('declares wallet-submit only for contribute and matches the runtime map', () => {
    const declared = Object.fromEntries(
      (pkg.mm.commands as { id: string; capabilities: string[] }[]).map((c) => [
        c.id,
        c.capabilities,
      ]),
    );
    expect(declared).toEqual(COMMAND_CAPABILITIES);
    const submitters = Object.entries(declared).filter(([, caps]) =>
      caps.includes('wallet-submit'),
    );
    expect(submitters.map(([id]) => id).sort()).toEqual([
      'synq:contribute',
      'synq:login',
    ]);
    for (const c of pkg.mm.commands)
      expect(c.targetChains).toEqual([NETWORK.chainId]);
  });

  it('has one command file per manifest id with a matching pluginCommandId', () => {
    const dir = join(root, 'src', 'commands', 'synq');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.map((f) => `synq:${f.replace(/\.ts$/, '')}`).sort()).toEqual(
      Object.keys(COMMAND_CAPABILITIES).sort(),
    );
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      const id = `synq:${f.replace(/\.ts$/, '')}`;
      expect(text).toContain(`pluginCommandId = '${id}'`);
      expect(text).toContain(`depsFor(this.ctx, io, '${id}')`);
      if (id !== 'synq:contribute')
        expect(text).not.toMatch(/walletExecutor|contribute\(/);
    }
  });

  it('a read-only command cannot reach the executor even if it tries', async () => {
    for (const id of Object.keys(COMMAND_CAPABILITIES) as SynqCommandId[]) {
      if (id === 'synq:contribute' || id === 'synq:login') continue;
      const chain = new FakeChain();
      const { ctx, log } = fakeHostContext(chain);
      const host = hostFromContext(ctx, fakeIo, id);
      await expect(host.submit(tx)).rejects.toMatchObject({
        code: 'CAPABILITY_DENIED',
      });
      expect(log).toHaveLength(0);
      expect(chain.balance(MEMBER)).toBe(10_000_000n);
    }
  });

  it('the host-style restricted context denies submit without wallet-submit, even with a forged command id', async () => {
    const chain = new FakeChain();
    const { ctx, log } = fakeHostContext(chain);
    const restricted = restrictLikeHost(
      ctx,
      'synq:treasury',
      COMMAND_CAPABILITIES['synq:treasury'],
    );
    const forged = hostFromContext(restricted, fakeIo, 'synq:contribute');
    await expect(forged.submit(tx)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(log).toHaveLength(0);
    const blind = restrictLikeHost(ctx, 'synq:treasury', []);
    expect(() =>
      hostFromContext(blind, fakeIo, 'synq:treasury').publicClient(
        NETWORK.chainId,
      ),
    ).toThrow(/wallet-read/);
  });

  it('contribute with the granted capabilities reaches the executor', async () => {
    const chain = new FakeChain();
    const { ctx, log } = fakeHostContext(chain);
    const granted = restrictLikeHost(
      ctx,
      'synq:contribute',
      COMMAND_CAPABILITIES['synq:contribute'],
    );
    const r = await hostFromContext(granted, fakeIo, 'synq:contribute').submit(
      tx,
    );
    expect(r.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(log).toHaveLength(1);
  });

  it('maps errors to stable codes', () => {
    const e = new SynqPluginError('WRONG_SAFE', 'x');
    expect(e.hint.length).toBeGreaterThan(0);
  });
});
