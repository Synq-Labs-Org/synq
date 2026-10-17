import { WorkspaceSplitWorker } from './workspace-splits.js';
import { readFileSync, statSync } from 'node:fs';
import {
  encodeAbiParameters,
  erc20Abi,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEventLogs,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerialized,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  OfacSdnScreening,
  unavailableScreening,
  type WalletScreeningPort,
} from '@synq/plugin-risk';
import { PostgresSdnSnapshotStore } from '@synq/plugin-risk/postgres';
import { contract, token, chainProfile } from '@synq/chain-registry/arc';
import { money } from '@synq/domain';
import { advertisedMoneyPolicy } from '@synq/governance';
import {
  decideVaultCreation,
  admitVaultCreationGrant,
  verifyGrant,
  type AuthorityConfig,
} from '@synq/kernel/arc';
import {
  vaultSetupHash,
  vaultSetupIntentId,
  vaultSetupValue,
  type VaultSetup,
} from '@synq/kernel/arc-vault-setup';
import {
  WorkspaceVaultSetups,
  WorkspaceError,
  type VaultSetupDefaults,
} from '@synq/workspaces';
import {
  ArcExecutionError,
  connectChain,
  transactionOf,
  verifyCode,
  type ArcChain,
  type PreparedTransfer,
  type TransferSigner,
} from './arc.js';
import type { OutboxRecord } from './arc-outbox.js';
import { PostgresOutboxStore } from './pg-outbox.js';
import { settleSignedCall } from './cctp.js';
import { readCustody } from './council-payout.js';
import { readWorkspaceAuthority } from './workspace-authority.js';
import { WorkspaceFinance } from '@synq/workspaces/finance';
import { WorkspacePayoutExecutor } from './workspace-payout.js';
import { WorkspaceGovernanceExecutor } from './workspace-governance.js';
import {
  VAULT_FACTORY_ABI,
  readVault,
  verifySafeInfrastructure,
} from './vault.js';

export function workspaceVaultData(s: VaultSetup) {
  return encodeFunctionData({
    abi: VAULT_FACTORY_ABI,
    functionName: 'createVault',
    args: [
      {
        owners: s.owners.map((a) => getAddress(a)),
        threshold: BigInt(s.threshold),
        guardian: getAddress(s.guardian),
        operator: getAddress(s.operator),
        delay: BigInt(s.delay),
        recipients: [],
        perPaymentCap: BigInt(s.perPaymentCap),
        windowCap: BigInt(s.windowCap),
      },
      s.salt as Hex,
    ],
  });
}

export class WorkspaceVaultExecutor {
  readonly outbox: PostgresOutboxStore;
  constructor(
    readonly setups: WorkspaceVaultSetups,
    readonly chain: ArcChain,
    private readonly signer: TransferSigner,
    private readonly authority: AuthorityConfig,
    readonly dailyGasLimitWei: bigint,
  ) {
    this.outbox = new PostgresOutboxStore(setups.workspaces.pool);
  }
  async execute(workspaceId: string, afterRecord?: () => Promise<void>) {
    const sql = await this.setups.workspaces.pool.connect();
    const lock = `workspace-vault-sender:${this.signer.address.toLowerCase()}`;
    try {
      await sql.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
        lock,
      ]);
      const expectedChain = chainProfile('arc-testnet').chainId;
      if (
        this.chain.profile.chainId !== expectedChain ||
        !this.chain.profile.mutationEnabled ||
        (await this.chain.client.getChainId()) !== expectedChain
      )
        throw new ArcExecutionError('WRONG_CHAIN');
      const job = await this.setups.record(workspaceId);
      if (!job) throw new WorkspaceError('SETUP_NOT_FOUND', 404);
      const s = job.setup;
      const factory = contract('arc-testnet', 'SYNQ_ARC_VAULT_FACTORY');
      const usdc = token('arc-testnet', 'USDC');
      if (
        getAddress(s.factory) !== getAddress(factory.address) ||
        getAddress(s.token) !== getAddress(usdc.address) ||
        getAddress(s.sponsor) !== getAddress(this.signer.address) ||
        getAddress(s.operator) !== getAddress(this.signer.address)
      )
        throw new WorkspaceError('WORKER_SETUP_MISMATCH');
      const key = vaultSetupIntentId(s);
      let record = await this.outbox.get(key);
      if (!record) {
        if (job.state !== 'READY') throw new WorkspaceError('SETUP_NOT_READY');
        await verifySafeInfrastructure(this.chain);
        const codeHash = await verifyCode(
          this.chain,
          factory.address,
          factory.codeHash,
        );
        const boundToken = await this.chain.client.readContract({
          address: factory.address,
          abi: VAULT_FACTORY_ABI,
          functionName: 'token',
        });
        if (getAddress(boundToken) !== getAddress(usdc.address))
          throw new ArcExecutionError('TX_MISMATCH');
        const data = workspaceVaultData(s);
        await this.chain.client.call({
          account: this.signer.address,
          to: factory.address,
          data,
        });
        const gas =
          ((await this.chain.client.estimateGas({
            account: this.signer.address,
            to: factory.address,
            data,
          })) *
            130n +
            99n) /
          100n;
        const fees = await this.chain.client.estimateFeesPerGas();
        const floor = this.chain.profile.minMaxFeePerGasWei ?? 20_000_000_000n;
        const tip =
          fees.maxPriorityFeePerGas && fees.maxPriorityFeePerGas > 0n
            ? fees.maxPriorityFeePerGas
            : 1_000_000_000n;
        const maxFeePerGas = [fees.maxFeePerGas ?? 0n, floor, tip].reduce(
          (a, b) => (a > b ? a : b),
        );
        const cost = gas * maxFeePerGas;
        if (cost > BigInt(s.maxGasNativeWei))
          throw new ArcExecutionError('FEE_ABOVE_CAP');
        if (
          (await this.chain.client.getBalance({
            address: this.signer.address,
          })) < cost
        )
          throw new ArcExecutionError('INSUFFICIENT_GAS');
        const reservation = await this.setups.reserveGas(
          workspaceId,
          this.dailyGasLimitWei,
        );
        const decision = await decideVaultCreation({
          config: this.authority,
          setup: s,
          signatures: job.signatures,
          expected: {
            factory: factory.address,
            token: usdc.address as Address,
            sponsor: this.signer.address,
            operator: this.signer.address,
          },
          sponsorReservation: reservation,
          simulationOk: true,
          now: this.setups.workspaces.now(),
        });
        if (decision.outcome !== 'ALLOW')
          throw new WorkspaceError('KERNEL_DENIED', 403);
        const prepared: PreparedTransfer = Object.freeze({
          chain: 'arc-testnet',
          chainId: 5042002,
          from: this.signer.address,
          to: factory.address,
          token: factory.address,
          amount: money(usdc, 0n),
          data,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas: tip,
          maxGasCostWei: cost,
          nonce: await this.chain.client.getTransactionCount({
            address: this.signer.address,
            blockTag: 'pending',
          }),
          codeHash,
        });
        verifyGrant({
          grant: decision.grant,
          grantKey: this.authority.grantKey,
          call: vaultSetupValue(s),
          now: this.setups.workspaces.now(),
          mandateRevoked: false,
        });
        const raw = await this.signer.signTransaction(transactionOf(prepared));
        record = {
          key,
          state: 'SIGNED',
          prepared,
          raw,
          hash: keccak256(raw),
          evidence: null,
          note: `workspace-vault:${workspaceId}`,
          updatedAt: this.setups.workspaces.now(),
        };
        await this.assertRecord(record, s);
        const candidate = record;
        const outcome = await this.outbox.createAdmittingGrant(
          candidate,
          decision.grant,
          (fence) =>
            admitVaultCreationGrant({
              setup: s,
              grant: decision.grant,
              grantKey: this.authority.grantKey,
              now: this.setups.workspaces.now(),
              fence,
            }),
        );
        if (outcome === 'KEY_EXISTS') record = (await this.outbox.get(key))!;
        else await afterRecord?.();
      }
      await this.assertRecord(record, s);
      if (record.state === 'SIGNED')
        await this.setups.reserveGas(workspaceId, this.dailyGasLimitWei);
      if (record.state === 'FAILED' || record.state === 'NEEDS_REVIEW')
        return { state: record.state };
      const result = await settleSignedCall(this.chain, {
        chainId: s.chainId,
        from: this.signer.address,
        to: factory.address,
        nonce: record.prepared.nonce,
        raw: record.raw,
        hash: record.hash,
      });
      if (result === 'NONCE_CONSUMED') {
        if (record.state === 'SIGNED')
          await this.outbox.update({
            ...record,
            state: 'NEEDS_REVIEW',
            note: 'sender nonce consumed; never re-create the vault',
            updatedAt: this.setups.workspaces.now(),
          });
        await this.setups.workspaces.pool.query(
          "UPDATE synq_ws_vault_setups SET state='NEEDS_REVIEW' WHERE workspace_id=$1 AND state='READY'",
          [workspaceId],
        );
        return { state: 'NEEDS_REVIEW' };
      }
      const receipt = await this.chain.client.waitForTransactionReceipt({
        hash: record.hash,
        confirmations: this.chain.profile.confirmations,
      });
      if (
        receipt.to?.toLowerCase() !== s.factory.toLowerCase() ||
        receipt.from.toLowerCase() !== s.sponsor.toLowerCase()
      )
        throw new ArcExecutionError('TX_MISMATCH');
      const fee = receipt.gasUsed * receipt.effectiveGasPrice;
      await this.setups.settleGas(
        workspaceId,
        vaultSetupHash(s),
        record.hash,
        fee,
      );
      if (receipt.status !== 'success') {
        if (record.state === 'SIGNED')
          await this.outbox.update({
            ...record,
            state: 'FAILED',
            note: 'vault creation reverted',
            updatedAt: this.setups.workspaces.now(),
          });
        await this.setups.workspaces.pool.query(
          "UPDATE synq_ws_vault_setups SET state='REVERTED' WHERE workspace_id=$1 AND state='READY'",
          [workspaceId],
        );
        return { state: 'REVERTED' };
      }
      const events = parseEventLogs({
        abi: VAULT_FACTORY_ABI,
        eventName: 'VaultCreated',
        logs: receipt.logs,
      }).filter((l) => l.address.toLowerCase() === s.factory.toLowerCase());
      const event = events[0]?.args;
      const vaultId = keccak256(
        encodeAbiParameters(
          [
            { type: 'uint256' },
            { type: 'address' },
            { type: 'address' },
            { type: 'bytes32' },
          ],
          [
            BigInt(s.chainId),
            getAddress(s.factory),
            getAddress(s.sponsor),
            s.salt as Hex,
          ],
        ),
      );
      if (
        events.length !== 1 ||
        !event ||
        event.vaultId !== vaultId ||
        event.creator.toLowerCase() !== s.sponsor.toLowerCase() ||
        event.operator.toLowerCase() !== s.operator.toLowerCase() ||
        event.guardian.toLowerCase() !== s.guardian.toLowerCase() ||
        event.threshold !== BigInt(s.threshold) ||
        event.delay !== BigInt(s.delay) ||
        event.owners.map((a) => getAddress(a)).join() !== s.owners.join()
      )
        throw new ArcExecutionError(
          'TX_MISMATCH',
          'factory event differs from owner-signed setup',
        );
      const vault = await readVault(this.chain, event.safe);
      const custody = await readCustody(this.chain, event.safe, event.policy);
      if (
        !vault.healthy ||
        custody.guard !== getAddress(event.policy) ||
        custody.modules.length !== 1 ||
        !custody.modulesComplete ||
        custody.modules[0] !== getAddress(event.policy) ||
        custody.operator?.operator !== getAddress(s.operator) ||
        custody.operator.perPaymentCap !== BigInt(s.perPaymentCap) ||
        custody.operator.windowCap !== BigInt(s.windowCap)
      )
        throw new WorkspaceError('CUSTODY_MISMATCH');
      const policyCode = await this.chain.client.getCode({
        address: event.policy,
        blockNumber: receipt.blockNumber,
      });
      if (!policyCode || policyCode === '0x')
        throw new ArcExecutionError('NO_CODE');
      const evidence = {
        setupHash: vaultSetupHash(s),
        hash: record.hash,
        safe: getAddress(event.safe),
        policy: getAddress(event.policy),
        owners: custody.owners,
        threshold: custody.threshold,
        blockNumber: String(receipt.blockNumber),
        policyCodeHash: keccak256(policyCode),
        custody: advertisedMoneyPolicy(custody, null).custody,
      };
      await this.setups.activate(workspaceId, evidence);
      if (record.state === 'SIGNED')
        await this.outbox.update({
          ...record,
          state: 'CONFIRMED',
          note: `workspace-vault:${workspaceId};policy:${event.policy};block:${receipt.blockNumber}`,
          updatedAt: this.setups.workspaces.now(),
        });
      return { state: 'ACTIVE', ...evidence };
    } finally {
      let failed = false;
      try {
        await sql.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
          lock,
        ]);
      } catch {
        failed = true;
      } finally {
        sql.release(failed);
      }
    }
  }
  private async assertRecord(r: OutboxRecord, s: VaultSetup) {
    const tx = parseTransaction(r.raw);
    if (
      r.key !== vaultSetupIntentId(s) ||
      keccak256(r.raw) !== r.hash ||
      tx.chainId !== s.chainId ||
      tx.to?.toLowerCase() !== s.factory.toLowerCase() ||
      tx.data !== workspaceVaultData(s) ||
      (tx.value ?? 0n) !== 0n ||
      tx.nonce !== r.prepared.nonce ||
      (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n) > BigInt(s.maxGasNativeWei) ||
      tx.type !== 'eip1559' ||
      (
        await recoverTransactionAddress({
          serializedTransaction: r.raw as TransactionSerialized,
        })
      ).toLowerCase() !== s.sponsor.toLowerCase()
    )
      throw new ArcExecutionError(
        'TX_MISMATCH',
        'stored factory transaction differs from signed setup',
      );
  }
}

/** Keys remain inside the execution worker; callers receive only a restricted port. */
export async function workspaceVaultRuntime(input: {
  setups: (defaults: VaultSetupDefaults) => WorkspaceVaultSetups;
  operatorKeyFile: string;
  grantKeyFile: string;
  rpcUrl?: string;
  dailyGasLimitWei: bigint;
  maxCreationGasWei: bigint;
  /**
   * `OFAC_SDN_LIST_ONLY` screens payout and split recipients against the US
   * Treasury SDN list (list-only, not full wallet screening). Anything else
   * leaves screening UNAVAILABLE, so execution fails closed.
   */
  screening?: string;
}) {
  const secret = (path: string) => {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error('WORKSPACE_KEY_PERMISSIONS');
    return readFileSync(path, 'utf8').trim();
  };
  const rawText = secret(input.operatorKeyFile);
  const raw = rawText.startsWith('0x') ? rawText : `0x${rawText}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw))
    throw new Error('WORKSPACE_OPERATOR_KEY_FORMAT');
  const account = privateKeyToAccount(raw as Hex);
  const grantHex = secret(input.grantKeyFile);
  if (!/^[0-9a-fA-F]{64}$/.test(grantHex))
    throw new Error('WORKSPACE_GRANT_KEY_FORMAT');
  const chain = await connectChain('arc-testnet', input.rpcUrl);
  const defaults: VaultSetupDefaults = {
    factory: contract('arc-testnet', 'SYNQ_ARC_VAULT_FACTORY').address,
    token: token('arc-testnet', 'USDC').address as Address,
    sponsor: account.address,
    operator: account.address,
    guardian: getAddress('0x0000000000000000000000000000000000000000'),
    maxGasNativeWei: String(input.maxCreationGasWei),
  };
  const setups = input.setups(defaults);
  const executor = new WorkspaceVaultExecutor(
    setups,
    chain,
    account,
    {
      operator: 'workspace-vault-worker',
      grantKey: Buffer.from(grantHex, 'hex'),
      grantTtlSeconds: 60,
      riskRequiredAbove: 0n,
    },
    input.dailyGasLimitWei,
  );
  await executor.outbox.migrate();
  const finance = new WorkspaceFinance(setups.workspaces, (id) =>
    readWorkspaceAuthority(chain, setups, id),
  );
  let screening: WalletScreeningPort = unavailableScreening();
  let sdnTimer: ReturnType<typeof setInterval> | undefined;
  if (input.screening === 'OFAC_SDN_LIST_ONLY') {
    const store = new PostgresSdnSnapshotStore(setups.workspaces.pool);
    await store.migrate();
    const sdn = new OfacSdnScreening(store, setups.workspaces.now);
    await sdn.load();
    // A failed download keeps the persisted snapshot while it is fresh; the
    // port reports UNAVAILABLE (fail closed) once it is stale or absent.
    await sdn.refresh();
    sdnTimer = setInterval(
      () => void sdn.refresh().catch(() => undefined),
      12 * 3600 * 1000,
    );
    sdnTimer.unref();
    screening = sdn;
  }
  const payouts = new WorkspacePayoutExecutor(
    finance,
    chain,
    account,
    {
      operator: 'workspace-payout-worker',
      grantKey: Buffer.from(grantHex, 'hex'),
      grantTtlSeconds: 60,
      riskRequiredAbove: 0n,
    },
    screening,
  );
  await payouts.migrate();
  const governance = new WorkspaceGovernanceExecutor(
    finance,
    chain,
    account,
    {
      operator: 'workspace-governance-worker',
      grantKey: Buffer.from(grantHex, 'hex'),
      grantTtlSeconds: 60,
      riskRequiredAbove: 0n,
    },
    screening,
  );
  const splits = new WorkspaceSplitWorker(
    finance,
    chain,
    account,
    {
      operator: 'workspace-split-worker',
      grantKey: Buffer.from(grantHex, 'hex'),
      grantTtlSeconds: 60,
      riskRequiredAbove: 0n,
    },
    payouts.screening,
  );
  await splits.migrate();
  let running = false;
  let stopped = false;
  const pump = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const rows = await setups.workspaces.pool.query(
        `SELECT s.workspace_id FROM synq_ws_vault_setups s LEFT JOIN synq_arc_payout_outbox o ON o.key='vault-setup:'||s.setup_hash
WHERE (s.state='READY' OR (s.state='ACTIVE' AND o.state='SIGNED')) AND s.next_attempt_at<=$1 ORDER BY s.created_at LIMIT 5`,
        [setups.workspaces.now()],
      );
      for (const row of rows.rows) {
        if (stopped) break;
        const claim = await setups.workspaces.pool.query(
          'UPDATE synq_ws_vault_setups SET attempts=attempts+1,next_attempt_at=$2 WHERE workspace_id=$1 AND next_attempt_at<=$3 RETURNING workspace_id',
          [
            row.workspace_id,
            setups.workspaces.now() + 30,
            setups.workspaces.now(),
          ],
        );
        if (!claim.rowCount) continue;
        try {
          await executor.execute(row.workspace_id);
        } catch (error) {
          const code =
            error instanceof WorkspaceError ||
            error instanceof ArcExecutionError
              ? error.code
              : 'EXECUTION_UNAVAILABLE';
          await setups.workspaces.pool.query(
            'UPDATE synq_ws_vault_setups SET last_error=$2 WHERE workspace_id=$1',
            [row.workspace_id, code],
          );
        }
      }
      const actions = await setups.workspaces.pool.query(
        "SELECT a.id FROM synq_ws_safe_actions a LEFT JOIN synq_arc_payout_outbox o ON o.key='workspace-action:'||a.id::text WHERE (a.state='READY' OR (a.state='CONFIRMED' AND o.state='SIGNED')) AND a.next_attempt_at<=$1 ORDER BY a.id LIMIT 5",
        [setups.workspaces.now()],
      );
      for (const action of actions.rows) {
        if (stopped) break;
        const claim = await setups.workspaces.pool.query(
          'UPDATE synq_ws_safe_actions SET next_attempt_at=$2 WHERE id=$1 AND next_attempt_at<=$3 RETURNING id',
          [action.id, setups.workspaces.now() + 30, setups.workspaces.now()],
        );
        if (!claim.rowCount) continue;
        try {
          await governance.execute(String(action.id));
        } catch (error) {
          const code =
            error instanceof WorkspaceError ||
            error instanceof ArcExecutionError
              ? error.code
              : 'EXECUTION_UNAVAILABLE';
          await setups.workspaces.pool.query(
            'UPDATE synq_ws_safe_actions SET last_error=$2 WHERE id=$1',
            [action.id, code],
          );
        }
      }
      const payments = await setups.workspaces.pool.query(
        "SELECT id FROM synq_ws_payouts WHERE state IN ('READY','SIGNED') AND COALESCE(data->>'route','VAULT_POLICY')='VAULT_POLICY' AND next_attempt_at<=$1 ORDER BY created_at LIMIT 5",
        [setups.workspaces.now()],
      );
      for (const p of payments.rows) {
        if (stopped) break;
        const claim = await setups.workspaces.pool.query(
          'UPDATE synq_ws_payouts SET attempts=attempts+1,next_attempt_at=$2 WHERE id=$1 AND next_attempt_at<=$3 RETURNING id',
          [p.id, setups.workspaces.now() + 30, setups.workspaces.now()],
        );
        if (!claim.rowCount) continue;
        try {
          await payouts.execute(String(p.id));
        } catch (error) {
          const code =
            error instanceof WorkspaceError ||
            error instanceof ArcExecutionError
              ? error.code
              : 'EXECUTION_UNAVAILABLE';
          await setups.workspaces.pool.query(
            'UPDATE synq_ws_payouts SET reason=$2 WHERE id=$1',
            [p.id, code],
          );
        }
      }
      if (!stopped) await splits.pump();
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void pump().catch(() => undefined);
  }, 5000);
  timer.unref();
  void pump().catch(() => undefined);
  return {
    setups,
    finance,
    payouts: payouts.payouts,
    governance: governance.governance,
    screening: () => payouts.screening.status(),
    readBalance: async (id: string) => {
      const a = await finance.authority(id);
      const amount = await chain.client.readContract({
        address: a.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [a.vault],
        blockNumber: a.blockNumber,
      });
      return { amount: String(amount), blockNumber: String(a.blockNumber) };
    },
    readIndexedBalance: async (id: string) => {
      const a = await finance.authority(id);
      const cursor = (
        await setups.workspaces.pool.query(
          'SELECT block_number FROM synq_arc_index_cursors WHERE stream=$1',
          [`workspace:${id}`],
        )
      ).rows[0];
      if (!cursor)
        throw new WorkspaceError('WORKSPACE_INDEXER_UNAVAILABLE', 503);
      const blockNumber = BigInt(cursor.block_number);
      const [finalized, block] = await Promise.all([
        chain.client.getBlock({ blockTag: 'finalized' }),
        chain.client.getBlock({ blockNumber }),
      ]);
      if (finalized.number === null || blockNumber > finalized.number)
        throw new WorkspaceError('INDEXED_BALANCE_NOT_FINAL');
      const amount = await chain.client.readContract({
        address: a.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [a.vault],
        blockNumber,
      });
      return {
        amount: String(amount),
        blockNumber: String(blockNumber),
        observedAt: Number(block.timestamp),
      };
    },
    readAuthority: (id: string) => readWorkspaceAuthority(chain, setups, id),
    execute: (workspaceId: string) => executor.execute(workspaceId),
    wake: () => {
      void pump().catch(() => undefined);
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (sdnTimer) clearInterval(sdnTimer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 100));
    },
  };
}
