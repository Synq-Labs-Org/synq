import { keccak256, stringToHex } from 'viem';
import { canonicalJson } from './events.js';

export type Hex = `0x${string}`;
export type AccountingStatus = 'OPEN' | 'FROZEN';
export type MandateStatus = 'ACTIVE' | 'REVOKED';

export interface GroupRow {
  group_id: Hex;
  account: Hex;
  registry: Hex;
  module: Hex;
  creator: Hex | null;
  salt: Hex | null;
  threshold: string | null;
  guard: Hex | null;
  paused: boolean;
  accounting_status: AccountingStatus;
  created_block: number;
  created_tx: Hex;
  revision: number;
}
export interface OwnerRow {
  group_id: Hex;
  owner: Hex;
  since_block: number;
}
export interface SafeModuleRow {
  group_id: Hex;
  module: Hex;
  enabled: boolean;
  updated_block: number;
}
export interface ExecutorRow {
  group_id: Hex;
  executor: Hex;
  allowed: boolean;
  updated_block: number;
}
export interface MandateRow {
  group_id: Hex;
  mandate_id: Hex;
  status: MandateStatus;
  current_version: string;
  min_valid_version: string;
  spent_token: string;
  spent_native: string;
}
export interface MandateVersionRow {
  group_id: Hex;
  mandate_id: Hex;
  version: string;
  mandate_hash: Hex;
  token: Hex;
  max_token_per_action: string;
  max_native_per_action: string;
  cumulative_token_cap: string;
  cumulative_native_cap: string;
  valid_after: string;
  valid_until: string;
  call_targets: readonly string[];
  call_selectors: readonly string[];
  recipients: readonly string[];
  security_sensitive: boolean | null;
  configured_block: number;
  configured_tx: Hex;
}
export interface SpendRow {
  tx_hash: Hex;
  log_index: number;
  group_id: Hex;
  mandate_id: Hex;
  version: string;
  token_amount: string;
  native_amount: string;
  spent_token: string;
  spent_native: string;
  block_number: number;
}
export interface GrantRow {
  group_id: Hex;
  nonce: string;
  intent_hash: Hex;
  mandate_id: Hex;
  mandate_version: string;
  executor: Hex;
  plugin_id: Hex;
  grant_hash: Hex;
  target: Hex;
  selector: Hex;
  token: Hex;
  recipient: Hex;
  token_amount: string;
  native_value: string;
  output_amount: string;
  tx_hash: Hex;
  log_index: number;
  block_number: number;
}
export interface CancelledNonceRow {
  group_id: Hex;
  nonce: string;
  block_number: number;
}
export interface TrackedAccountRow {
  account: Hex;
  kind: 'GROUP' | 'OBSERVED';
  group_id: Hex | null;
}
export interface BalanceRow {
  account: Hex;
  asset: Hex;
  balance: string;
  baseline_block: number;
  baseline_balance: string;
  last_block: number;
}

export interface TableRows {
  group: GroupRow;
  owner: OwnerRow;
  safe_module: SafeModuleRow;
  executor: ExecutorRow;
  mandate: MandateRow;
  mandate_version: MandateVersionRow;
  spend: SpendRow;
  grant_executed: GrantRow;
  cancelled_nonce: CancelledNonceRow;
  tracked_account: TrackedAccountRow;
  balance: BalanceRow;
}
export type TableName = keyof TableRows;
export interface TableSpec<T extends TableName> {
  pk: readonly (keyof TableRows[T] & string)[];
  columns: readonly (keyof TableRows[T] & string)[];
  numeric: readonly (keyof TableRows[T] & string)[];
  json: readonly (keyof TableRows[T] & string)[];
  bigint: readonly (keyof TableRows[T] & string)[];
  volatile: readonly (keyof TableRows[T] & string)[];
  groupColumn: (keyof TableRows[T] & string) | null;
}
function spec<T extends TableName>(s: TableSpec<T>): TableSpec<T> {
  return s;
}
export const TABLES: { [T in TableName]: TableSpec<T> } = {
  group: spec<'group'>({
    pk: ['group_id'],
    columns: [
      'group_id',
      'account',
      'registry',
      'module',
      'creator',
      'salt',
      'threshold',
      'guard',
      'paused',
      'accounting_status',
      'created_block',
      'created_tx',
      'revision',
    ],
    numeric: ['threshold'],
    json: [],
    bigint: ['created_block', 'revision'],
    volatile: ['revision'],
    groupColumn: 'group_id',
  }),
  owner: spec<'owner'>({
    pk: ['group_id', 'owner'],
    columns: ['group_id', 'owner', 'since_block'],
    numeric: [],
    json: [],
    bigint: ['since_block'],
    volatile: [],
    groupColumn: 'group_id',
  }),
  safe_module: spec<'safe_module'>({
    pk: ['group_id', 'module'],
    columns: ['group_id', 'module', 'enabled', 'updated_block'],
    numeric: [],
    json: [],
    bigint: ['updated_block'],
    volatile: [],
    groupColumn: 'group_id',
  }),
  executor: spec<'executor'>({
    pk: ['group_id', 'executor'],
    columns: ['group_id', 'executor', 'allowed', 'updated_block'],
    numeric: [],
    json: [],
    bigint: ['updated_block'],
    volatile: [],
    groupColumn: 'group_id',
  }),
  mandate: spec<'mandate'>({
    pk: ['group_id', 'mandate_id'],
    columns: [
      'group_id',
      'mandate_id',
      'status',
      'current_version',
      'min_valid_version',
      'spent_token',
      'spent_native',
    ],
    numeric: [
      'current_version',
      'min_valid_version',
      'spent_token',
      'spent_native',
    ],
    json: [],
    bigint: [],
    volatile: [],
    groupColumn: 'group_id',
  }),
  mandate_version: spec<'mandate_version'>({
    pk: ['group_id', 'mandate_id', 'version'],
    columns: [
      'group_id',
      'mandate_id',
      'version',
      'mandate_hash',
      'token',
      'max_token_per_action',
      'max_native_per_action',
      'cumulative_token_cap',
      'cumulative_native_cap',
      'valid_after',
      'valid_until',
      'call_targets',
      'call_selectors',
      'recipients',
      'security_sensitive',
      'configured_block',
      'configured_tx',
    ],
    numeric: [
      'version',
      'max_token_per_action',
      'max_native_per_action',
      'cumulative_token_cap',
      'cumulative_native_cap',
      'valid_after',
      'valid_until',
    ],
    json: ['call_targets', 'call_selectors', 'recipients'],
    bigint: ['configured_block'],
    volatile: [],
    groupColumn: 'group_id',
  }),
  spend: spec<'spend'>({
    pk: ['tx_hash', 'log_index'],
    columns: [
      'tx_hash',
      'log_index',
      'group_id',
      'mandate_id',
      'version',
      'token_amount',
      'native_amount',
      'spent_token',
      'spent_native',
      'block_number',
    ],
    numeric: [
      'version',
      'token_amount',
      'native_amount',
      'spent_token',
      'spent_native',
    ],
    json: [],
    bigint: ['log_index', 'block_number'],
    volatile: [],
    groupColumn: 'group_id',
  }),
  grant_executed: spec<'grant_executed'>({
    pk: ['group_id', 'nonce'],
    columns: [
      'group_id',
      'nonce',
      'intent_hash',
      'mandate_id',
      'mandate_version',
      'executor',
      'plugin_id',
      'grant_hash',
      'target',
      'selector',
      'token',
      'recipient',
      'token_amount',
      'native_value',
      'output_amount',
      'tx_hash',
      'log_index',
      'block_number',
    ],
    numeric: [
      'nonce',
      'mandate_version',
      'token_amount',
      'native_value',
      'output_amount',
    ],
    json: [],
    bigint: ['log_index', 'block_number'],
    volatile: [],
    groupColumn: 'group_id',
  }),
  cancelled_nonce: spec<'cancelled_nonce'>({
    pk: ['group_id', 'nonce'],
    columns: ['group_id', 'nonce', 'block_number'],
    numeric: ['nonce'],
    json: [],
    bigint: ['block_number'],
    volatile: [],
    groupColumn: 'group_id',
  }),
  tracked_account: spec<'tracked_account'>({
    pk: ['account'],
    columns: ['account', 'kind', 'group_id'],
    numeric: [],
    json: [],
    bigint: [],
    volatile: [],
    groupColumn: null,
  }),
  balance: spec<'balance'>({
    pk: ['account', 'asset'],
    columns: [
      'account',
      'asset',
      'balance',
      'baseline_block',
      'baseline_balance',
      'last_block',
    ],
    numeric: ['balance', 'baseline_balance'],
    json: [],
    bigint: ['baseline_block', 'last_block'],
    volatile: [],
    groupColumn: null,
  }),
};
export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

export function rowKey<T extends TableName>(
  table: T,
  row: Partial<TableRows[T]>,
): string {
  const values = row as Record<string, unknown>;
  return TABLES[table].pk.map((c) => String(values[c])).join('|');
}

export interface TableChanges {
  upserts: { [T in TableName]?: TableRows[T][] };
  deletes: { [T in TableName]?: TableRows[T][] };
}

export class Tables {
  private readonly data = new Map<TableName, Map<string, unknown>>();
  private readonly dirty = new Map<TableName, Map<string, unknown>>();
  private readonly removed = new Map<TableName, Map<string, unknown>>();
  private map<T extends TableName>(table: T): Map<string, TableRows[T]> {
    let m = this.data.get(table);
    if (!m) this.data.set(table, (m = new Map()));
    return m as Map<string, TableRows[T]>;
  }
  load<T extends TableName>(table: T, rows: readonly TableRows[T][]): void {
    const m = this.map(table);
    for (const row of rows) m.set(rowKey(table, row), row);
  }
  get<T extends TableName>(table: T, key: string): TableRows[T] | undefined {
    return this.map(table).get(key);
  }
  rows<T extends TableName>(table: T): TableRows[T][] {
    return [...this.map(table).values()];
  }
  where<T extends TableName>(
    table: T,
    predicate: (row: TableRows[T]) => boolean,
  ): TableRows[T][] {
    return this.rows(table).filter(predicate);
  }
  put<T extends TableName>(table: T, row: TableRows[T]): void {
    const key = rowKey(table, row);
    this.map(table).set(key, row);
    this.track(this.dirty, table).set(key, row);
    this.track(this.removed, table).delete(key);
  }
  remove<T extends TableName>(table: T, key: string): void {
    const row = this.map(table).get(key);
    if (!row) return;
    this.map(table).delete(key);
    this.track(this.dirty, table).delete(key);
    this.track(this.removed, table).set(key, row);
  }
  private track(
    target: Map<TableName, Map<string, unknown>>,
    table: TableName,
  ): Map<string, unknown> {
    let m = target.get(table);
    if (!m) target.set(table, (m = new Map()));
    return m;
  }
  changes(): TableChanges {
    const upserts: Record<string, unknown[]> = {};
    const deletes: Record<string, unknown[]> = {};
    for (const [t, m] of this.dirty) if (m.size) upserts[t] = [...m.values()];
    for (const [t, m] of this.removed) if (m.size) deletes[t] = [...m.values()];
    return { upserts, deletes } as TableChanges;
  }
  clearChanges(): void {
    this.dirty.clear();
    this.removed.clear();
  }
  merge(other: Tables): void {
    for (const t of TABLE_NAMES) this.load(t, other.rows(t));
  }
}

export function stateHash(
  tables: Tables,
  extra: Record<string, unknown> = {},
): Hex {
  const content: Record<string, unknown> = { ...extra };
  for (const t of TABLE_NAMES) {
    const s = TABLES[t] as TableSpec<TableName>;
    content[t] = tables
      .rows(t)
      .map((row) => {
        const copy: Record<string, unknown> = { ...row };
        for (const v of s.volatile) delete copy[v];
        return copy;
      })
      .sort((a, b) => {
        const ka = canonicalJson(s.pk.map((c) => a[c]));
        const kb = canonicalJson(s.pk.map((c) => b[c]));
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
  }
  return keccak256(stringToHex(canonicalJson(content)));
}
