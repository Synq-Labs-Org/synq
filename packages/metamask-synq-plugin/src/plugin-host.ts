import { readFile } from 'node:fs/promises';
import {
  CommandError,
  type CommandIO,
  type PluginCommandContext,
} from '@metamask/agent-wallet/plugin';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { allows, type SynqCommandId } from './core/capabilities.js';
import { SynqPluginError, fail } from './core/errors.js';
import { FileJournal } from './core/journal.js';
import type { Deps } from './core/group.js';
import type {
  SynqHost,
  TxRequest,
  TxSubmission,
  TypedDataRequest,
} from './core/host.js';
import { FileSessionStore, MemberSessions } from './core/session.js';
import { SynqApi, apiConfigFromEnv } from './core/synq-api.js';

/** The slice of the Agent Wallet plugin context Synq touches. */
export type HostContext = {
  publicClient: PluginCommandContext['publicClient'];
  walletExecutor: PluginCommandContext['walletExecutor'];
  walletStateManager: Pick<PluginCommandContext['walletStateManager'], 'read'>;
};

type WalletEntry = { address?: string; id?: string; name?: string };

const evmAddress = (r: WalletEntry) =>
  r.address && isAddress(r.address) ? getAddress(r.address) : null;

/** Resolve the host's selected wallet ref (address, id or name) to an EVM address. */
function selectedAddress(
  records: readonly WalletEntry[],
  ref: unknown,
): Address | null {
  if (!ref || typeof ref !== 'object') return null;
  const r = ref as WalletEntry;
  const match = records.find(
    (w) =>
      (r.address !== undefined &&
        w.address?.toLowerCase() === r.address.toLowerCase()) ||
      (r.id !== undefined && w.id === r.id) ||
      (r.name !== undefined && w.name === r.name),
  );
  return match
    ? evmAddress(match)
    : r.address && isAddress(r.address)
      ? getAddress(r.address)
      : null;
}

export function hostFromContext(
  ctx: HostContext,
  io: CommandIO,
  command: SynqCommandId,
): SynqHost {
  return {
    publicClient: (chainId) => ctx.publicClient(chainId),
    walletAddresses() {
      const state = ctx.walletStateManager.read();
      const records: WalletEntry[] = [
        ...state.remoteWallets,
        ...state.byokWallets,
      ];
      const all = [
        ...new Set(
          records.map(evmAddress).filter((a): a is Address => a !== null),
        ),
      ];
      return {
        selected: selectedAddress(records, state.selectedWallet?.ref),
        all,
      };
    },
    async submit(request: TxRequest): Promise<TxSubmission> {
      if (!allows(command, 'wallet-submit'))
        fail(
          'CAPABILITY_DENIED',
          `${command} is read-only and cannot submit transactions`,
        );
      const execute = await ctx.walletExecutor(io, command);
      const result = await execute(
        {
          kind: 'transaction',
          chainId: request.chainId,
          transaction: {
            to: request.to,
            data: request.data,
            value: request.value,
          },
          intent: {
            summary: request.summary,
            action: 'transfer',
            details: request.details,
          },
        },
        { waitForReceipt: true },
      );
      if (result.kind !== 'transaction')
        fail(
          'SUBMISSION_FAILED',
          'Agent Wallet returned a signature instead of a transaction',
        );
      const hash = /^0x[0-9a-fA-F]{64}$/.test(result.hash)
        ? (result.hash as Hex)
        : null;
      return {
        hash,
        status: result.status,
        failureCode: result.failureCode,
        failureDescription: result.failureDescription,
      };
    },
    async signTypedData(request: TypedDataRequest): Promise<Hex> {
      if (!allows(command, 'wallet-submit'))
        fail('CAPABILITY_DENIED', `${command} cannot request signatures`);
      const execute = await ctx.walletExecutor(io, command);
      const result = await execute({
        kind: 'typed-data',
        chainId: request.chainId,
        typedData: request.typedData,
        intent: { summary: request.summary, action: 'custom' },
      });
      if (
        result.kind !== 'signature' ||
        result.failureCode ||
        !/^0x[0-9a-fA-F]{130}$/.test(result.signature)
      )
        fail(
          'SUBMISSION_FAILED',
          `Agent Wallet did not sign (${result.status}${result.failureCode ? `: ${result.failureCode}` : ''})`,
        );
      return result.signature as Hex;
    },
  };
}

export function depsFor(
  ctx: HostContext,
  io: CommandIO,
  command: SynqCommandId,
  env: Record<string, string | undefined> = process.env,
): Deps {
  const host = hostFromContext(ctx, io, command);
  const api = new SynqApi(apiConfigFromEnv(env));
  const now = () => Date.now();
  return {
    host,
    api,
    sessions: new MemberSessions(
      api,
      FileSessionStore.fromEnv(env),
      host,
      now,
      allows(command, 'wallet-submit'),
    ),
    now,
  };
}

export const journalFromEnv = (
  env: Record<string, string | undefined> = process.env,
) => FileJournal.fromEnv(env);

export const groupList = (
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env,
) =>
  (flag || env.SYNQ_MM_GROUPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Surface Synq failures as Agent Wallet command errors with stable codes. */
export async function asCommand<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SynqPluginError)
      throw new CommandError(
        `SYNQ_${error.code}`,
        error.message,
        error.hint || 'See mm synq --help.',
      );
    throw error;
  }
}

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return fail(
      'INVALID_INPUT',
      `cannot read JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
