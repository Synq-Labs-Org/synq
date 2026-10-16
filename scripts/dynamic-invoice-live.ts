import { boundedWorkspaceSigner } from '@synq/execution-worker/workspace-signing';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import {
  erc20Abi,
  parseTransaction,
  recoverTransactionAddress,
  keccak256,
  toHex,
  type Hex,
  type TransactionSerialized,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { token, contract } from '@synq/chain-registry/arc';
import { money } from '@synq/domain';
import {
  decide,
  mandateTypedData,
  type PaymentMandate,
} from '@synq/kernel/arc';
import { VaultSetupSchema } from '@synq/kernel/arc-vault-setup';
import { connectChain, prepareTransfer } from '@synq/execution-worker/arc';
import { payGrantOnce, recover } from '@synq/execution-worker/arc-outbox';
import {
  PostgresOutboxStore,
  PostgresGrantFence,
} from '@synq/execution-worker/pg-outbox';
import { readWorkspaceAuthority } from '@synq/execution-worker/workspace-authority';
import {
  PostgresWorkspaceStore,
  WorkspaceVaultSetups,
  loginTypedData,
} from '@synq/workspaces';
import { WorkspaceFinance } from '@synq/workspaces/finance';
import { WorkspaceInvoices } from '@synq/workspaces/invoices';
import { WorkspaceReceipts } from '@synq/workspaces/receipts';
import { InvoiceService, PostgresInvoiceStore, payCall } from '@synq/invoices';
import { issueTypedData } from '@synq/invoices/invoice-data';
import {
  Ledger,
  PostgresLedgerStore,
  viemIndexerChain,
  walletTag,
} from '@synq/ledger';
import { WorkspaceIndexer } from '../apps/demo/src/workspace-indexer.js';

const runId = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/)
  .parse(process.env.SYNQ_DYNAMIC_RUN_ID);
if (process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
  throw new Error('MAINNET_FORBIDDEN');
if (process.env.SYNQ_DYNAMIC_INVOICE_LIVE !== '1') {
  process.stdout.write(
    'Read-only mode. No keys, signatures, files or transactions created.\n',
  );
} else {
  const dir = join(homedir(), '.synq');
  const secret = (path: string) => {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error('KEY_FILE_PERMISSIONS');
    return readFileSync(path, 'utf8').trim();
  };
  const account = (label: string) => {
    const raw = secret(join(dir, `e2e-user-${runId}-${label}.key`));
    return privateKeyToAccount(
      (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex,
    );
  };
  const payerPath = join(dir, `e2e-user-${runId}-payer.key`);
  if (!existsSync(payerPath))
    writeFileSync(payerPath, generatePrivateKey(), { mode: 0o600, flag: 'wx' });
  const operator = account('operator'),
    owner = account('owner'),
    payer = account('payer');
  const workspaceId = z
    .uuid()
    .parse(
      JSON.parse(secret(join(dir, `e2e-user-${runId}-run.json`))).workspaceId,
    );
  const manifestPath = join(dir, `e2e-user-${runId}-invoice.json`);
  type Manifest = {
    createdAt: number;
    invoiceId: string | null;
    raw: Hex | null;
    hash: Hex | null;
    payerBefore: string | null;
    operatorBefore: string | null;
    vaultBefore: string | null;
  };
  const now = () => Math.floor(Date.now() / 1000);
  const manifest: Manifest = existsSync(manifestPath)
    ? JSON.parse(secret(manifestPath))
    : {
        createdAt: now(),
        invoiceId: null,
        raw: null,
        hash: null,
        payerBefore: null,
        operatorBefore: null,
        vaultBefore: null,
      };
  const save = () =>
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const evidencePath = `bounty-evidence/arc/dynamic-invoice-${runId}.json`;
  const evidence: Record<string, unknown> = {
    runId,
    workspaceId,
    mode: 'LIVE_ARC_TESTNET',
    onboardingActors: 'LOCAL_FIXTURE_SOFTWARE_WALLETS',
    independentHumanUsers: 0,
  };
  const persist = () =>
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  const url =
    process.env.SYNQ_DYNAMIC_DATABASE_URL ??
    'postgresql://postgres@127.0.0.1:55433/synq_m2_dynamic';
  if (!/^synq_m2_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1)))
    throw new Error('TEST_DATABASE_REQUIRED');
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  const guard = await pool.connect();
  const runLock = `dynamic-invoice-run:${runId}`,
    senderLock = `workspace-vault-sender:${operator.address.toLowerCase()}`;
  try {
    await guard.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      runLock,
    ]);
    await guard.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      senderLock,
    ]);
    if (existsSync(manifestPath))
      Object.assign(manifest, JSON.parse(secret(manifestPath)));
    save();
    const chain = await connectChain('arc-testnet'),
      usdc = token('arc-testnet', 'USDC');
    const store = new PostgresWorkspaceStore(pool, 'https://synq.test');
    const setup = VaultSetupSchema.parse(
      (
        await pool.query(
          'SELECT data FROM synq_ws_vault_setups WHERE workspace_id=$1',
          [workspaceId],
        )
      ).rows[0]?.data,
    );
    const setups = new WorkspaceVaultSetups(store, setup),
      finance = new WorkspaceFinance(store, (id) =>
        readWorkspaceAuthority(chain, setups, id),
      );
    await finance.migrate();
    const a = await finance.authority(workspaceId);
    if (
      a.threshold !== 2 ||
      !a.owners.includes(owner.address) ||
      a.vault === payer.address
    )
      throw new Error('EXPECTED_EXISTING_TWO_OWNER_VAULT');
    if (
      (
        await pool.query(
          'SELECT 1 FROM synq_ws_principals WHERE lower(wallet)=lower($1)',
          [payer.address],
        )
      ).rowCount
    )
      throw new Error('PAYER_MUST_BE_OUTSIDE_WORKSPACE');
    const ledgerStore = new PostgresLedgerStore(pool);
    await ledgerStore.migrate();
    const ledger = new Ledger(ledgerStore),
      service = new InvoiceService(
        new PostgresInvoiceStore(pool),
        ledger,
        now,
        (i) => invoices.authorizeIssue(i),
      );
    const invoices: WorkspaceInvoices = new WorkspaceInvoices(
      finance,
      service,
      () => null,
    );
    const c = await store.challenge({
      wallet: owner.address,
      audience: 'native',
    });
    const auth = await store.login(
      c.id,
      await owner.signTypedData({
        ...loginTypedData(c),
        message: {
          ...loginTypedData(c).message,
          wallet: owner.address,
          expiresAt: BigInt(c.expiresAt),
        },
      }),
    );
    if (!manifest.invoiceId) {
      manifest.invoiceId = (
        await invoices.create(workspaceId, auth.principalId, {
          number: `ARC-${runId}`,
          payerName: 'Outside software-wallet payer',
          dueDate: new Date((now() + 86400) * 1000).toISOString().slice(0, 10),
          lineItems: [
            {
              description: 'Authorized testnet invoice proof',
              quantity: 1,
              unitPrice: '10000',
            },
          ],
        })
      ).invoiceId;
      save();
    }
    let invoice = (await service.store.get(manifest.invoiceId))!.invoice;
    if (invoice.status === 'DRAFT') {
      await invoices.issue(
        workspaceId,
        auth.principalId,
        invoice.invoiceId,
        await owner.signTypedData(issueTypedData(invoice)),
      );
      invoice = (await service.store.get(invoice.invoiceId))!.invoice;
    }
    if (!manifest.operatorBefore) {
      const [op, pay, vault] = await Promise.all([
        chain.client.getBalance({ address: operator.address }),
        chain.client.getBalance({ address: payer.address }),
        chain.client.readContract({
          address: usdc.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [a.vault],
        }),
      ]);
      if (op < 40_000_000_000_000_000n || pay !== 0n)
        throw new Error('FRESH_PAYER_OR_OPERATOR_BALANCE');
      manifest.operatorBefore = String(op);
      manifest.payerBefore = String(pay);
      manifest.vaultBefore = String(vault);
      save();
    }
    // Internal, self-controlled gas provisioning only; not a vendor screening claim.
    const outbox = new PostgresOutboxStore(pool);
    await outbox.migrate();
    const key = `dynamic-invoice-gas:${runId}`;
    let funding = await outbox.get(key);
    if (funding) funding = await recover(outbox, chain, funding, now);
    else {
      const mandate: PaymentMandate = {
        mandateId: key,
        version: 1,
        workspaceId,
        owner: operator.address,
        payer: operator.address,
        chainId: usdc.chainId,
        token: usdc.address,
        recipients: [payer.address],
        purposes: ['GROUP_EXPENSE'],
        perActionCap: 30000n,
        periodBudget: 30000n,
        periodSeconds: 86400,
        validFrom: manifest.createdAt - 60,
        validUntil: manifest.createdAt + 86400,
      };
      await prepareTransfer(chain, {
        from: operator.address,
        to: payer.address,
        amount: money(usdc, 30000n),
      });
      const grantKey = Buffer.from(
        secret(join(dir, `e2e-user-${runId}-grant.key`)),
        'hex',
      );
      const decision = await decide({
        config: {
          operator: 'invoice-self-controlled-gas-provisioning',
          grantKey,
          grantTtlSeconds: 120,
          riskRequiredAbove: 0n,
        },
        mandate,
        mandateSignature: await operator.signTypedData(
          mandateTypedData(mandate),
        ),
        state: { revoked: false, spends: [] },
        intent: {
          intentId: key,
          mandateId: key,
          mandateVersion: 1,
          chainId: usdc.chainId,
          token: usdc.address,
          payer: operator.address,
          recipient: payer.address,
          amount: 30000n,
          purpose: 'GROUP_EXPENSE',
          obligationRef: key,
          evidenceHash: keccak256(toHex(`owned-software-wallet:${runId}`)),
          proposedBy: 'authorized-testnet-proof',
        },
        risk: { available: true, flags: [] },
        simulationOk: true,
        now: now(),
      });
      if (decision.outcome !== 'ALLOW')
        throw new Error('INTERNAL_GAS_KERNEL_DENIED');
      funding = (
        await payGrantOnce({
          key,
          store: outbox,
          fence: new PostgresGrantFence(pool),
          chain,
          signer: boundedWorkspaceSigner(operator, 10_000_000_000_000_000n),
          grant: decision.grant,
          grantKey,
          mandateRevoked: false,
          transfer: {
            from: operator.address,
            to: payer.address,
            amount: money(usdc, 30000n),
          },
          now,
        })
      ).record;
    }
    if (funding.state !== 'CONFIRMED' || !funding.evidence)
      throw new Error('FUNDING_NOT_CONFIRMED');
    const call = payCall(invoice, 10000n);
    if (!manifest.raw) {
      if (
        invoice.paid !== 0n ||
        (await chain.client.getChainId()) !== usdc.chainId
      )
        throw new Error('INVOICE_ALREADY_PAID_OR_WRONG_CHAIN');
      await chain.client.call({
        account: payer.address,
        to: contract('arc-testnet', 'MEMO').address,
        data: call.calldata,
      });
      const fees = await chain.client.estimateFeesPerGas();
      const tx = {
        chainId: usdc.chainId,
        to: contract('arc-testnet', 'MEMO').address,
        data: call.calldata,
        value: 0n,
        nonce: await chain.client.getTransactionCount({
          address: payer.address,
          blockTag: 'pending',
        }),
        gas:
          ((await chain.client.estimateGas({
            account: payer.address,
            to: contract('arc-testnet', 'MEMO').address,
            data: call.calldata,
          })) *
            120n) /
          100n,
        maxFeePerGas: fees.maxFeePerGas!,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
      };
      if (tx.gas * tx.maxFeePerGas > 10_000_000_000_000_000n)
        throw new Error('PAYER_GAS_ABOVE_CAP');
      // External payer signs its own payment. This is not workspace payout authority.
      manifest.raw = await payer.signTransaction(tx);
      manifest.hash = keccak256(manifest.raw);
      save();
    }
    if (manifest.hash !== keccak256(manifest.raw))
      throw new Error('SIGNED_PAYMENT_HASH_MISMATCH');
    const signed = parseTransaction(manifest.raw);
    if (
      signed.chainId !== usdc.chainId ||
      signed.to?.toLowerCase() !==
        contract('arc-testnet', 'MEMO').address.toLowerCase() ||
      signed.data !== call.calldata ||
      (signed.value ?? 0n) !== 0n ||
      signed.gas === undefined ||
      signed.maxFeePerGas === undefined ||
      signed.gas * signed.maxFeePerGas > 10_000_000_000_000_000n ||
      (
        await recoverTransactionAddress({
          serializedTransaction: manifest.raw as TransactionSerialized,
        })
      ).toLowerCase() !== payer.address.toLowerCase()
    )
      throw new Error('SAVED_PAYMENT_TERMS_MISMATCH');

    const existing = await chain.client
      .getTransactionReceipt({ hash: manifest.hash })
      .catch(() => null);
    if (!existing)
      await chain.client.sendRawTransaction({
        serializedTransaction: manifest.raw as TransactionSerialized,
      });
    const receipt = await chain.client.waitForTransactionReceipt({
      hash: manifest.hash,
    });
    if (receipt.status !== 'success')
      throw new Error('PAYER_TRANSACTION_REVERTED');
    const indexer = new WorkspaceIndexer(
      new WorkspaceReceipts(finance, service, ledger),
      [viemIndexerChain(chain.client)],
    );
    await indexer.migrate();
    for (let n = 0; n < 80; n++) {
      await indexer.tick();
      if (
        (await invoices.get(workspaceId, auth.principalId, invoice.invoiceId))
          .reconciliation === 'FINALIZED'
      )
        break;
    }
    const result = await invoices.get(
      workspaceId,
      auth.principalId,
      invoice.invoiceId,
    );
    if (
      result.status !== 'PAID' ||
      result.reconciliation !== 'FINALIZED' ||
      result.paid !== '10000'
    )
      throw new Error('INDEXER_SETTLEMENT_PENDING');
    const [opAfter, payAfter, vaultAfter] = await Promise.all([
      chain.client.getBalance({ address: operator.address }),
      chain.client.getBalance({ address: payer.address }),
      chain.client.readContract({
        address: usdc.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [a.vault],
      }),
    ]);
    const payerFee = receipt.gasUsed * receipt.effectiveGasPrice;
    if (
      BigInt(manifest.operatorBefore) -
        opAfter -
        30_000_000_000_000_000n -
        funding.evidence.feeWei !==
        0n ||
      BigInt(manifest.payerBefore!) +
        30_000_000_000_000_000n -
        payAfter -
        10_000_000_000_000_000n -
        payerFee !==
        0n ||
      vaultAfter - BigInt(manifest.vaultBefore!) !== 10000n
    )
      throw new Error('CHAIN_RECONCILIATION_MISMATCH');
    const cash = (await ledger.store.entries(workspaceId))
      .flatMap((e) => e.postings)
      .filter(
        (p) =>
          p.account === 'CASH_ARC_USDC' &&
          p.counterpartyId === walletTag(a.vault),
      )
      .reduce((n, p) => n + p.amount, 0n);
    if (cash !== vaultAfter)
      throw new Error('VAULT_LEDGER_RECONCILIATION_MISMATCH');
    Object.assign(evidence, {
      status: 'PASS_INVOICE_INDEXER_ONLY',
      invoiceId: invoice.invoiceId,
      vault: a.vault,
      payer: payer.address,
      paymentHash: manifest.hash,
      fundingHash: funding.hash,
      amountBaseUnits: '10000',
      fundingBaseUnits: '30000',
      paymentFeeNativeWei: String(payerFee),
      fundingFeeNativeWei: String(funding.evidence.feeWei),
      vaultBalanceBaseUnits: String(vaultAfter),
      vaultCashLedgerBaseUnits: String(cash),
      reconciliationDifferenceWei: '0',
      automaticWaterfall:
        'BLOCKED_MISSING_LIVE_SCREENING_AND_ACTIVE_QUORUM_POLICY',
      chatDelivery: 'NOT_RUN_NO_VERIFIED_TEST_RECIPIENT',
      approvalScope:
        'External software payer signs own Memo payment; internal gas provisioning uses owner-signed mandate/Kernel/one-use grant/durable outbox. No customer payout.',
    });
    persist();
    process.stdout.write(
      `LIVE_ARC_TESTNET invoice ${invoice.invoiceId}; payment ${manifest.hash}; indexer finalized; reconciliation 0 wei\n`,
    );
  } catch (e) {
    evidence.lastAttempt = {
      at: now(),
      code:
        e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
          ? e.message
          : 'LIVE_INVOICE_UNAVAILABLE',
    };
    persist();
    process.stdout.write(`${JSON.stringify(evidence.lastAttempt)}\n`);
    process.exitCode = 1;
  } finally {
    let broken = false;
    try {
      await guard.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
        senderLock,
      ]);
      await guard.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
        runLock,
      ]);
    } catch {
      broken = true;
    }
    guard.release(broken);
    await pool.end();
  }
}
