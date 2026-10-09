import type { ProjectionConfig } from './config.js';
import { fail } from './errors.js';
import {
  FACTORY_EVENTS,
  MODULE_EVENTS,
  REGISTRY_EVENTS,
  SAFE_EVENTS,
  compareEvents,
  type ChainEvent,
  type ChainEventOf,
  type EventName,
} from './events.js';
import { Tables, rowKey, type GroupRow, type Hex } from './tables.js';

export type ScopeKey = `g:${Hex}` | `a:${Hex}`;
export interface Scope {
  groups: ReadonlySet<Hex>;
  accounts: ReadonlySet<Hex>;
}
export interface LoadRequest {
  groups: Hex[];
  accounts: Hex[];
  grantNonces: [Hex, string][];
  grantIntents: [Hex, Hex][];
  cancelledNonces: [Hex, string][];
}

const includes = <T extends string>(list: readonly T[], v: string): v is T =>
  (list as readonly string[]).includes(v);
const isGroupEvent = (
  e: ChainEvent,
): e is Extract<ChainEvent, { payload: { groupId: Hex } }> =>
  'groupId' in e.payload;

export function loadRequest(
  events: readonly ChainEvent[],
  config: ProjectionConfig,
): LoadRequest {
  const groups = new Set<Hex>();
  const accounts = new Set<Hex>(config.observedAccounts.map((o) => o.account));
  const grantNonces: [Hex, string][] = [];
  const grantIntents: [Hex, Hex][] = [];
  const cancelledNonces: [Hex, string][] = [];
  for (const e of events) {
    if (isGroupEvent(e)) {
      groups.add(e.payload.groupId);
      accounts.add(e.payload.account);
    }
    if (e.eventName === 'Transfer') {
      accounts.add(e.payload.from);
      accounts.add(e.payload.to);
    }
    if (includes(SAFE_EVENTS, e.eventName)) accounts.add(e.contract);
    if (e.eventName === 'GrantExecuted') {
      grantNonces.push([e.payload.groupId, e.payload.nonce]);
      grantIntents.push([e.payload.groupId, e.payload.intentHash]);
    }
    if (e.eventName === 'NonceCancelled')
      cancelledNonces.push([e.payload.groupId, e.payload.nonce]);
  }
  return {
    groups: [...groups],
    accounts: [...accounts],
    grantNonces,
    grantIntents,
    cancelledNonces,
  };
}

export interface ApplyResult {
  scopes: Map<string, ScopeKey[]>;
  touchedGroups: Set<Hex>;
}

export class Projection {
  constructor(
    readonly config: ProjectionConfig,
    readonly tables: Tables,
  ) {}

  seedObservedAccounts(): void {
    for (const o of this.config.observedAccounts) {
      if (this.tables.get('tracked_account', o.account)) continue;
      this.tables.put('tracked_account', {
        account: o.account,
        kind: 'OBSERVED',
        group_id: null,
      });
      for (const asset of this.config.treasuryAssets) {
        const baseline = o.baselineBalances[asset] ?? '0';
        this.tables.put('balance', {
          account: o.account,
          asset,
          balance: baseline,
          baseline_block: o.baselineBlock,
          baseline_balance: baseline,
          last_block: o.baselineBlock,
        });
      }
    }
  }

  apply(
    events: readonly ChainEvent[],
    generation: number,
    scope?: Scope,
  ): ApplyResult {
    const sorted = [...events].sort(compareEvents);
    const scopes = new Map<string, ScopeKey[]>();
    const touched = new Set<Hex>();
    const pending = new Map<string, ChainEvent[]>();
    const bindingsInTx = new Map<string, Hex>();
    for (const e of sorted)
      if (e.eventName === 'GroupBound')
        bindingsInTx.set(
          `${e.transactionHash}:${e.payload.account}`,
          e.payload.groupId,
        );
    for (const e of sorted) {
      if (e.chainId !== this.config.chainId)
        fail('UNTRUSTED_SOURCE', `chain ${e.chainId}`);
      const keys = this.applyOne(e, scope, touched, pending, bindingsInTx);
      scopes.set(`${e.transactionHash}:${e.logIndex}`, keys);
    }
    for (const [tx, list] of pending)
      if (list.length)
        fail('UNBOUND_ACCOUNT_EVENT', `${tx} ${list[0]?.eventName}`);
    for (const groupId of touched) {
      const g = this.tables.get('group', groupId);
      if (g) this.tables.put('group', { ...g, revision: generation });
    }
    return { scopes, touchedGroups: touched };
  }

  private group(groupId: Hex, account?: Hex): GroupRow {
    const g = this.tables.get('group', groupId);
    if (!g) fail('UNKNOWN_GROUP', groupId);
    if (account && g.account !== account)
      fail('INVALID_TRANSITION', `account mismatch for ${groupId}`);
    return g;
  }

  private applyOne(
    e: ChainEvent,
    scope: Scope | undefined,
    touched: Set<Hex>,
    pending: Map<string, ChainEvent[]>,
    bindingsInTx: Map<string, Hex>,
  ): ScopeKey[] {
    const name: EventName = e.eventName;
    if (name === 'Transfer') return this.transfer(e as never, scope, touched);
    if (includes(SAFE_EVENTS, name)) {
      const tracked = this.tables.get('tracked_account', e.contract);
      if (!tracked || tracked.kind !== 'GROUP' || !tracked.group_id) {
        const groupId = bindingsInTx.get(`${e.transactionHash}:${e.contract}`);
        if (
          groupId &&
          (e.eventName === 'SafeSetup' || e.eventName === 'EnabledModule')
        ) {
          if (scope && !scope.groups.has(groupId)) return [`g:${groupId}`];
          const list = pending.get(e.transactionHash) ?? [];
          list.push(e);
          pending.set(e.transactionHash, list);
          return [`g:${groupId}`];
        }
        fail('UNBOUND_ACCOUNT_EVENT', `${name} from ${e.contract}`);
      }
      const groupId = tracked.group_id;
      if (scope && !scope.groups.has(groupId)) return [`g:${groupId}`];
      this.safeEvent(e, this.group(groupId, e.contract));
      touched.add(groupId);
      return [`g:${groupId}`];
    }
    if (!isGroupEvent(e)) fail('INVALID_EVENT', name);
    const expected = includes(FACTORY_EVENTS, name)
      ? this.config.factory
      : includes(REGISTRY_EVENTS, name)
        ? this.config.registry
        : includes(MODULE_EVENTS, name)
          ? this.config.module
          : null;
    if (!expected || e.contract !== expected)
      fail('UNTRUSTED_SOURCE', `${name} from ${e.contract}`);
    const groupId = e.payload.groupId;
    const keys: ScopeKey[] = [`g:${groupId}`];
    if (name === 'GroupBound') keys.push(`a:${e.payload.account}`);
    if (scope && !scope.groups.has(groupId)) return keys;
    touched.add(groupId);
    switch (e.eventName) {
      case 'GroupBound':
        this.bind(e);
        break;
      case 'GroupCreated':
        this.created(e, pending.get(e.transactionHash) ?? []);
        pending.delete(e.transactionHash);
        break;
      case 'GroupModuleChanged': {
        const g = this.group(groupId, e.payload.account);
        if (g.module !== e.payload.previousModule)
          fail('INVALID_TRANSITION', 'module change from unexpected module');
        this.tables.put('group', { ...g, module: e.payload.newModule });
        break;
      }
      case 'MandateConfigured':
        this.configured(e);
        break;
      case 'MandateSuperseded':
        this.superseded(e);
        break;
      case 'MandateRevoked': {
        this.group(groupId, e.payload.account);
        const m = this.mandate(groupId, e.payload.mandateId);
        if (m.status !== 'ACTIVE' || m.current_version !== e.payload.version)
          fail('INVALID_TRANSITION', 'revocation of inactive mandate/version');
        this.tables.put('mandate', { ...m, status: 'REVOKED' });
        break;
      }
      case 'SpendRecorded':
        this.spend(e);
        break;
      case 'ExecutorSet':
        this.group(groupId, e.payload.account);
        this.tables.put('executor', {
          group_id: groupId,
          executor: e.payload.executor,
          allowed: e.payload.allowed,
          updated_block: e.blockNumber,
        });
        break;
      case 'Paused':
      case 'Unpaused': {
        const g = this.group(groupId, e.payload.account);
        const paused = e.eventName === 'Paused';
        if (g.paused === paused)
          fail('INVALID_TRANSITION', `${e.eventName} while paused=${g.paused}`);
        this.tables.put('group', { ...g, paused });
        break;
      }
      case 'NonceCancelled': {
        this.group(groupId, e.payload.account);
        const key = rowKey('cancelled_nonce', {
          group_id: groupId,
          nonce: e.payload.nonce,
        });
        if (this.tables.get('cancelled_nonce', key))
          fail('INVALID_TRANSITION', 'nonce cancelled twice');
        this.tables.put('cancelled_nonce', {
          group_id: groupId,
          nonce: e.payload.nonce,
          block_number: e.blockNumber,
        });
        break;
      }
      case 'GrantExecuted':
        this.grant(e);
        break;
      default:
        fail('INVALID_EVENT', name);
    }
    return keys;
  }

  private bind(e: ChainEventOf<'GroupBound'>): void {
    const p = e.payload;
    if (this.tables.get('group', p.groupId))
      fail('INVALID_TRANSITION', `group ${p.groupId} bound twice`);
    if (this.tables.get('tracked_account', p.account))
      fail('INVALID_TRANSITION', `account ${p.account} already tracked`);
    this.tables.put('group', {
      group_id: p.groupId,
      account: p.account,
      registry: e.contract,
      module: p.module,
      creator: null,
      salt: null,
      threshold: null,
      guard: null,
      paused: false,
      accounting_status: 'OPEN',
      created_block: e.blockNumber,
      created_tx: e.transactionHash,
      revision: 0,
    });
    this.tables.put('tracked_account', {
      account: p.account,
      kind: 'GROUP',
      group_id: p.groupId,
    });
    for (const asset of this.config.treasuryAssets)
      this.tables.put('balance', {
        account: p.account,
        asset,
        balance: '0',
        baseline_block: e.blockNumber,
        baseline_balance: '0',
        last_block: e.blockNumber,
      });
  }

  private created(
    e: ChainEventOf<'GroupCreated'>,
    setup: readonly ChainEvent[],
  ): void {
    const p = e.payload;
    const g = this.group(p.groupId, p.account);
    if (g.created_tx !== e.transactionHash || g.creator !== null)
      fail('INVALID_TRANSITION', 'GroupCreated without same-transaction bind');
    if (p.registry !== this.config.registry || p.module !== g.module)
      fail('UNTRUSTED_SOURCE', 'GroupCreated registry/module mismatch');
    const owners = new Set(p.owners);
    const threshold = BigInt(p.threshold);
    if (owners.size !== p.owners.length || threshold < 1n)
      fail('INVALID_TRANSITION', 'invalid owner set');
    if (threshold > BigInt(owners.size))
      fail('INVALID_TRANSITION', 'threshold above owner count');
    for (const s of setup) {
      if (s.eventName === 'SafeSetup') {
        const same =
          s.payload.owners.length === p.owners.length &&
          s.payload.owners.every((o) => owners.has(o)) &&
          s.payload.threshold === p.threshold;
        if (!same) fail('INCONSISTENT_PROOF', 'SafeSetup/GroupCreated differ');
      } else if (s.eventName === 'EnabledModule') {
        if (s.payload.module !== p.module)
          fail('INCONSISTENT_PROOF', 'setup enabled unexpected module');
      }
    }
    this.tables.put('group', {
      ...g,
      creator: p.creator,
      salt: p.salt,
      threshold: p.threshold,
    });
    for (const owner of p.owners)
      this.tables.put('owner', {
        group_id: p.groupId,
        owner,
        since_block: e.blockNumber,
      });
    this.tables.put('safe_module', {
      group_id: p.groupId,
      module: p.module,
      enabled: true,
      updated_block: e.blockNumber,
    });
  }

  private safeEvent(e: ChainEvent, g: GroupRow): void {
    const groupId = g.group_id;
    const owners = () =>
      this.tables.where('owner', (o) => o.group_id === groupId);
    switch (e.eventName) {
      case 'SafeSetup':
        fail('INVALID_TRANSITION', 'SafeSetup on an existing group');
        break;
      case 'AddedOwner': {
        const key = rowKey('owner', {
          group_id: groupId,
          owner: e.payload.owner,
        });
        if (this.tables.get('owner', key))
          fail('INVALID_TRANSITION', 'owner added twice');
        this.tables.put('owner', {
          group_id: groupId,
          owner: e.payload.owner,
          since_block: e.blockNumber,
        });
        break;
      }
      case 'RemovedOwner': {
        const key = rowKey('owner', {
          group_id: groupId,
          owner: e.payload.owner,
        });
        if (!this.tables.get('owner', key))
          fail('INVALID_TRANSITION', 'removing unknown owner');
        this.tables.remove('owner', key);
        break;
      }
      case 'ChangedThreshold': {
        if (BigInt(e.payload.threshold) > BigInt(owners().length))
          fail('INVALID_TRANSITION', 'threshold above owner count');
        this.tables.put('group', { ...g, threshold: e.payload.threshold });
        break;
      }
      case 'EnabledModule':
      case 'DisabledModule':
        this.tables.put('safe_module', {
          group_id: groupId,
          module: e.payload.module,
          enabled: e.eventName === 'EnabledModule',
          updated_block: e.blockNumber,
        });
        break;
      case 'ChangedGuard':
        this.tables.put('group', {
          ...g,
          guard:
            e.payload.guard === '0x0000000000000000000000000000000000000000'
              ? null
              : e.payload.guard,
        });
        break;
      default:
        fail('INVALID_EVENT', e.eventName);
    }
  }

  private mandate(groupId: Hex, mandateId: Hex) {
    const m = this.tables.get(
      'mandate',
      rowKey('mandate', { group_id: groupId, mandate_id: mandateId }),
    );
    if (!m) fail('INVALID_TRANSITION', `unknown mandate ${mandateId}`);
    return m;
  }

  private configured(e: ChainEventOf<'MandateConfigured'>): void {
    const p = e.payload;
    this.group(p.groupId, p.account);
    if (p.callTargets.length !== p.callSelectors.length)
      fail('INVALID_EVENT', 'call list length mismatch');
    const key = rowKey('mandate', {
      group_id: p.groupId,
      mandate_id: p.mandateId,
    });
    const existing = this.tables.get('mandate', key);
    if (p.version === '1') {
      if (existing) fail('INVALID_TRANSITION', 'mandate configured twice');
      this.tables.put('mandate', {
        group_id: p.groupId,
        mandate_id: p.mandateId,
        status: 'ACTIVE',
        current_version: '1',
        min_valid_version: '1',
        spent_token: '0',
        spent_native: '0',
      });
    } else {
      if (!existing || existing.status !== 'ACTIVE')
        fail('INVALID_TRANSITION', 'supersession of inactive mandate');
      if (BigInt(p.version) !== BigInt(existing.current_version) + 1n)
        fail('INVALID_TRANSITION', 'mandate version gap');
    }
    this.tables.put('mandate_version', {
      group_id: p.groupId,
      mandate_id: p.mandateId,
      version: p.version,
      mandate_hash: p.mandateHash,
      token: p.token,
      max_token_per_action: p.maxTokenPerAction,
      max_native_per_action: p.maxNativePerAction,
      cumulative_token_cap: p.cumulativeTokenCap,
      cumulative_native_cap: p.cumulativeNativeCap,
      valid_after: p.validAfter,
      valid_until: p.validUntil,
      call_targets: p.callTargets,
      call_selectors: p.callSelectors,
      recipients: p.recipients,
      security_sensitive: p.version === '1' ? false : null,
      configured_block: e.blockNumber,
      configured_tx: e.transactionHash,
    });
  }

  private superseded(e: ChainEventOf<'MandateSuperseded'>): void {
    const p = e.payload;
    this.group(p.groupId, p.account);
    const m = this.mandate(p.groupId, p.mandateId);
    const vKey = rowKey('mandate_version', {
      group_id: p.groupId,
      mandate_id: p.mandateId,
      version: p.newVersion,
    });
    const v = this.tables.get('mandate_version', vKey);
    if (
      m.status !== 'ACTIVE' ||
      m.current_version !== p.previousVersion ||
      !v ||
      v.configured_tx !== e.transactionHash
    )
      fail('INVALID_TRANSITION', 'supersession without configured version');
    const minValid = BigInt(p.minValidVersion);
    if (
      minValid < BigInt(m.min_valid_version) ||
      minValid > BigInt(p.newVersion) ||
      (p.securitySensitive && minValid !== BigInt(p.newVersion))
    )
      fail('INVALID_TRANSITION', 'invalid minimum valid version');
    this.tables.put('mandate', {
      ...m,
      current_version: p.newVersion,
      min_valid_version: p.minValidVersion,
    });
    this.tables.put('mandate_version', {
      ...v,
      security_sensitive: p.securitySensitive,
    });
  }

  private spend(e: ChainEventOf<'SpendRecorded'>): void {
    const p = e.payload;
    this.group(p.groupId, p.account);
    const m = this.mandate(p.groupId, p.mandateId);
    const token = BigInt(m.spent_token) + BigInt(p.tokenAmount);
    const native = BigInt(m.spent_native) + BigInt(p.nativeAmount);
    if (
      token !== BigInt(p.spentToken) ||
      native !== BigInt(p.spentNative) ||
      m.status !== 'ACTIVE'
    )
      fail('INCONSISTENT_PROOF', 'cumulative spend does not reconcile');
    this.tables.put('mandate', {
      ...m,
      spent_token: p.spentToken,
      spent_native: p.spentNative,
    });
    this.tables.put('spend', {
      tx_hash: e.transactionHash,
      log_index: e.logIndex,
      group_id: p.groupId,
      mandate_id: p.mandateId,
      version: p.version,
      token_amount: p.tokenAmount,
      native_amount: p.nativeAmount,
      spent_token: p.spentToken,
      spent_native: p.spentNative,
      block_number: e.blockNumber,
    });
  }

  private grant(e: ChainEventOf<'GrantExecuted'>): void {
    const p = e.payload;
    const g = this.group(p.groupId, p.account);
    if (BigInt(p.chainId) !== BigInt(this.config.chainId))
      fail('INCONSISTENT_PROOF', 'grant for another chain');
    if (g.paused) fail('INCONSISTENT_PROOF', 'grant executed while paused');
    this.mandate(p.groupId, p.mandateId);
    const key = rowKey('grant_executed', {
      group_id: p.groupId,
      nonce: p.nonce,
    });
    if (this.tables.get('grant_executed', key))
      fail('INCONSISTENT_PROOF', 'grant nonce executed twice');
    if (
      this.tables.where(
        'grant_executed',
        (x) => x.group_id === p.groupId && x.intent_hash === p.intentHash,
      ).length
    )
      fail('INCONSISTENT_PROOF', 'intent executed twice');
    this.tables.put('grant_executed', {
      group_id: p.groupId,
      nonce: p.nonce,
      intent_hash: p.intentHash,
      mandate_id: p.mandateId,
      mandate_version: p.mandateVersion,
      executor: p.executor,
      plugin_id: p.pluginId,
      grant_hash: p.grantHash,
      target: p.target,
      selector: p.selector,
      token: p.token,
      recipient: p.recipient,
      token_amount: p.tokenAmount,
      native_value: p.nativeValue,
      output_amount: p.outputAmount,
      tx_hash: e.transactionHash,
      log_index: e.logIndex,
      block_number: e.blockNumber,
    });
  }

  private transfer(
    e: ChainEventOf<'Transfer'>,
    scope: Scope | undefined,
    touched: Set<Hex>,
  ): ScopeKey[] {
    if (!this.config.treasuryAssets.includes(e.contract))
      fail('UNTRUSTED_SOURCE', `transfer of untracked asset ${e.contract}`);
    const { from, to, value } = e.payload;
    const keys: ScopeKey[] = [];
    const sides: [Hex, bigint][] = [
      [from, -BigInt(value)],
      [to, BigInt(value)],
    ];
    for (const [account, delta] of sides) {
      const tracked = this.tables.get('tracked_account', account);
      if (!tracked) continue;
      keys.push(`a:${account}`);
      if (scope && !scope.accounts.has(account)) continue;
      const key = rowKey('balance', { account, asset: e.contract });
      const row = this.tables.get('balance', key);
      if (!row) fail('INCONSISTENT_PROOF', `no balance row for ${account}`);
      if (tracked.kind === 'OBSERVED' && e.blockNumber <= row.baseline_block)
        fail('INCONSISTENT_PROOF', 'transfer before account baseline');
      const balance = BigInt(row.balance) + delta;
      if (balance < 0n)
        fail('NEGATIVE_BALANCE', `${account} missing treasury history`);
      this.tables.put('balance', {
        ...row,
        balance: balance.toString(),
        last_block: e.blockNumber,
      });
      if (tracked.group_id) touched.add(tracked.group_id);
    }
    return [...new Set(keys)];
  }
}
