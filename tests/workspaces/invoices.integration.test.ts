import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  keccak256,
  toHex,
} from 'viem';
import { token, contract } from '@synq/chain-registry/arc';
import {
  InvoiceService,
  PostgresInvoiceStore,
  payCall,
  MEMO_ABI,
} from '@synq/invoices';
import { issueTypedData } from '@synq/invoices/invoice-data';
import {
  Ledger,
  PostgresLedgerStore,
  ArcChainIndexer,
  PostgresArcIndexStore,
  type IndexedEvent,
  type IndexerChain,
} from '@synq/ledger';
import { PostgresWorkspaceStore, loginTypedData } from '@synq/workspaces';
import {
  WorkspaceFinance,
  type WorkspaceAuthority,
} from '@synq/workspaces/finance';
import { WorkspaceInvoices } from '@synq/workspaces/invoices';
import { WorkspaceInvoiceViewSchema } from '@synq/workspaces/invoice-contracts';
import { payPathFor } from '../../apps/api/src/invoice-routes.js';
import { WorkspaceNotifications } from '../../apps/demo/src/workspace-notifications.js';
import type { WorkspaceChannelLinks } from '@synq/workspaces';
import type { WorkspacePayouts } from '@synq/workspaces/payouts';
import { memoSink } from '../../apps/api/src/arc-indexer.js';
import { testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from './pg.js';
import { WorkspaceReceipts } from '@synq/workspaces/receipts';
import { WorkspaceIndexer } from '../../apps/demo/src/workspace-indexer.js';
import { forkableChain, TOKEN_CODE } from '../durable/fake-indexer-chain.js';
let pool: Pool;
const actor = () => privateKeyToAccount(generatePrivateKey());
beforeAll(async () => {
  pool = await workspacePool(
    testDatabaseUrl(
      'SYNQ_WORKSPACE_INVOICE_TEST_DATABASE_URL',
      'synq_m2_workspace_invoices',
    ),
  );
  await new PostgresWorkspaceStore(pool, 'https://synq.test').migrate();
  await new PostgresLedgerStore(pool).migrate();
});
afterAll(async () => {
  await pool?.end();
});
async function fixture() {
  const now = 2_000_000_000,
    store = new PostgresWorkspaceStore(pool, 'https://synq.test', () => now),
    owner = actor(),
    payer = actor(),
    vault = actor().address,
    policy = actor().address;
  const c = await store.challenge({ wallet: owner.address });
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
  const { workspace: w } = await store.create(auth.principalId, {
    displayName: 'Invoice workspace',
    kind: 'BUSINESS',
  });
  await pool.query(
    "UPDATE synq_workspaces SET status='ACTIVE',vault=$2,policy=$3,threshold=1 WHERE id=$1",
    [w.id, vault, policy],
  );
  let authority: WorkspaceAuthority = {
    vault,
    policy,
    token: token('arc-testnet', 'USDC').address,
    policyCodeHash: toHex(randomBytes(32)),
    owners: [owner.address],
    threshold: 1,
    nonce: 0n,
    blockNumber: 1n,
  };
  const finance = new WorkspaceFinance(store, async () => authority);
  await finance.migrate();
  const ledger = new Ledger(new PostgresLedgerStore(pool));
  const service: InvoiceService = new InvoiceService(
    new PostgresInvoiceStore(pool),
    ledger,
    store.now,
    (i) => invoices.authorizeIssue(i),
  );
  const key = randomBytes(32);
  const invoices: WorkspaceInvoices = new WorkspaceInvoices(
    finance,
    service,
    (i) => payPathFor(key, i),
  );
  const draft = () =>
    invoices.create(w.id, auth.principalId, {
      number: `INV-${randomBytes(6).toString('hex')}`,
      payerName: 'Outside customer',
      dueDate: new Date((now + 86400) * 1000).toISOString().slice(0, 10),
      lineItems: [
        { description: 'Accepted work', quantity: 1, unitPrice: '50000' },
      ],
      taxRateBps: 0,
    });
  const issue = async (d: Awaited<ReturnType<typeof draft>>) => {
    const stored = (await service.store.get(d.invoiceId))!;
    return invoices.issue(
      w.id,
      auth.principalId,
      d.invoiceId,
      await owner.signTypedData(issueTypedData(stored.invoice)),
    );
  };
  return {
    store,
    finance,
    owner,
    payer,
    authority,
    w,
    auth,
    invoices,
    service,
    ledger,
    draft,
    issue,
    drift: () => {
      authority = { ...authority, owners: [payer.address] };
    },
  };
}
describe('G1/G8 workspace invoices — LOCAL_FIXTURE with Postgres', () => {
  it('derives issuer and payout vault from the workspace and isolates invoice reads', async () => {
    const f = await fixture(),
      other = await fixture(),
      d = await f.draft();
    expect(WorkspaceInvoiceViewSchema.parse(d)).toMatchObject({
      workspaceId: f.w.id,
      issuer: { wallet: f.owner.address, payoutAddress: f.authority.vault },
      checkoutPath: null,
      status: 'DRAFT',
    });
    await expect(
      other.invoices.get(other.w.id, other.auth.principalId, d.invoiceId),
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    await expect(
      f.invoices.get(f.w.id, other.auth.principalId, d.invoiceId),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    const issued = await f.issue(d);
    expect(issued.checkoutPath).toMatch(/^\/pay\/inv_/);
    expect(issued.status).toBe('ISSUED');
    expect(
      (await f.service.store.get(d.invoiceId))!.invoice.issuer.payoutAddress,
    ).toBe(f.authority.vault);
  });
  it('refuses issuer substitution, invalid calendar dates and integer overflow', async () => {
    const f = await fixture(),
      base = {
        number: 'Validation',
        payerName: 'Customer',
        dueDate: '2033-02-28',
        lineItems: [{ description: 'Work', quantity: 1, unitPrice: '1' }],
      };
    for (const overrides of [
      { issuer: { wallet: f.payer.address } },
      { dueDate: '2033-02-30' },
      { lineItems: [{ description: 'Work', quantity: 1, unitPrice: 0.05 }] },
    ])
      await expect(
        f.invoices.create(f.w.id, f.auth.principalId, {
          ...base,
          ...overrides,
        }),
      ).rejects.toThrow();
    await expect(
      f.invoices.create(f.w.id, f.auth.principalId, {
        ...base,
        lineItems: [
          {
            description: 'Work',
            quantity: 2,
            unitPrice: String(2n ** 256n - 1n),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_AMOUNT_OVERFLOW' });
  });
  it('rechecks current Safe authority through both the workspace and public issuance service entry points', async () => {
    const f = await fixture(),
      d = await f.draft(),
      stored = (await f.service.store.get(d.invoiceId))!;
    const wrong = await f.payer.signTypedData(issueTypedData(stored.invoice));
    await expect(
      f.invoices.issue(f.w.id, f.auth.principalId, d.invoiceId, wrong),
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_ISSUER' });
    const signature = await f.owner.signTypedData(
      issueTypedData(stored.invoice),
    );
    f.drift();
    await expect(f.service.issue(d.invoiceId, signature)).rejects.toMatchObject(
      { code: 'ONCHAIN_AUTHORITY_CHANGED' },
    );
    expect((await f.service.store.get(d.invoiceId))?.invoice.status).toBe(
      'DRAFT',
    );
    expect(await f.ledger.store.entries(f.w.id)).toHaveLength(0);
  });
  it('settles an unlinked outside payer through the indexer Memo sink, survives restart and books once', async () => {
    const f = await fixture(),
      issued = await f.issue(await f.draft()),
      invoice = (await f.service.store.get(issued.invoiceId))!.invoice;
    const txHash = toHex(randomBytes(32)),
      usdc = token('arc-testnet', 'USDC'),
      memo = contract('arc-testnet', 'MEMO').address,
      call = payCall(invoice, 50000n);
    const logs = [
      {
        address: usdc.address,
        topics: encodeEventTopics({
          abi: erc20Abi,
          eventName: 'Transfer',
          args: { from: f.payer.address, to: f.authority.vault },
        }),
        data: encodeAbiParameters([{ type: 'uint256' }], [50000n]),
        logIndex: 0,
      },
      {
        address: memo,
        topics: encodeEventTopics({
          abi: MEMO_ABI,
          eventName: 'Memo',
          args: {
            sender: f.payer.address,
            target: usdc.address,
            memoId: invoice.paymentRef!,
          },
        }),
        data: encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'bytes' }, { type: 'uint256' }],
          [keccak256(call.data), call.memoData, 0n],
        ),
        logIndex: 1,
      },
    ];
    const blockHash = toHex(randomBytes(32));
    const chain = {
      receiptLogs: async () => ({
        status: 'success',
        logs: logs.map((l) => ({
          ...l,
          transactionHash: txHash,
          blockHash,
          blockNumber: 1n,
          removed: false,
        })),
      }),
    } as unknown as IndexerChain;
    const event = {
      txHash,
      removed: false,
      data: { memoId: invoice.paymentRef!, sender: f.payer.address },
    } as unknown as IndexedEvent;
    const sink = memoSink({
      chain,
      service: f.service,
      chainId: usdc.chainId,
      token: usdc.address,
      memoContract: memo,
    });
    const receiptEvent: IndexedEvent = {
      chainId: usdc.chainId,
      emitter: usdc.address,
      kind: 'TRANSFER',
      txHash,
      blockHash,
      blockNumber: 1n,
      logIndex: 0,
      removed: false,
      data: { from: f.payer.address, to: f.authority.vault, value: '50000' },
    };
    const issueEntry = (await f.ledger.store.entries(f.w.id))[0]!;
    for (let n = 0; n < 25; n++)
      await pool.query(
        'INSERT INTO synq_event_outbox(event_id,entry_id,topic,payload) VALUES($1,$2,$3,$4)',
        [
          `invoice.payment_applied:fixture-unbound-${n}`,
          issueEntry.entryId,
          'invoice.payment_applied',
          {
            workspaceId: f.w.id,
            invoiceId: invoice.invoiceId,
            occurredAt: f.store.now(),
            card: {},
          },
        ],
      );
    const receipts = new WorkspaceReceipts(f.finance, f.service, f.ledger);
    expect(await receipts.apply(f.w.id, chain, receiptEvent)).toBe(
      `INVOICE:${invoice.invoiceId}`,
    );
    expect(await sink(event)).toBe(`DUPLICATE:${invoice.invoiceId}`);
    const restarted = new InvoiceService(
      new PostgresInvoiceStore(pool),
      new Ledger(new PostgresLedgerStore(pool)),
      f.store.now,
    );
    expect(
      await memoSink({
        chain,
        service: restarted,
        chainId: usdc.chainId,
        token: usdc.address,
        memoContract: memo,
      })(event),
    ).toBe(`DUPLICATE:${invoice.invoiceId}`);
    const paid = (await f.service.store.get(invoice.invoiceId))!.invoice;
    expect(paid.status).toBe('PAID');
    expect(paid.payments[0]?.payer).toBe(f.payer.address);
    expect(paid.payments).toHaveLength(1);
    expect(await f.ledger.store.entries(f.w.id)).toHaveLength(2);
    expect(
      (await f.invoices.get(f.w.id, f.auth.principalId, invoice.invoiceId))
        .paid,
    ).toBe('50000');
    expect(await sink({ ...event, removed: true })).toBe('REVIEW_REORGED_MEMO');
    // A verified delivery binding is supplied by the fixture; no live recipient is contacted.
    const links = { workspaces: f.store } as unknown as WorkspaceChannelLinks;
    const notices = new WorkspaceNotifications(
      links,
      {} as WorkspacePayouts,
      'LOCAL_FIXTURE',
    );
    await notices.queue.migrate();
    await pool.query(
      "INSERT INTO synq_ws_channel_bindings(channel,channel_digest,workspace_id,link_id,destination,identity_link_id) VALUES('telegram',$1,$2,$3,$4,$5)",
      [
        randomBytes(20).toString('hex'),
        f.w.id,
        randomBytes(20).toString('hex'),
        { channel: 'telegram', kind: 'DIRECT', chatId: '12345' },
        'fixture-proof',
      ],
    );
    notices.authorized = async () => true;
    await notices.relayInvoices();
    await notices.relayInvoices();
    const deliveries = await notices.queue.status(f.w.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.state).toBe('QUEUED');
    expect(await f.ledger.store.entries(f.w.id)).toHaveLength(2);
    await receipts.apply(f.w.id, chain, { ...receiptEvent, removed: true });
    expect(
      (await f.invoices.get(f.w.id, f.auth.principalId, invoice.invoiceId))
        .reconciliation,
    ).toBe('REVIEW');
    let sent = 0;
    await notices.queue.pump(
      {
        channel: 'telegram',
        send: async () => ({ messageId: String(++sent) }),
      },
      (ws, dest, eventId) => notices.deliveryAuthorized(ws, dest, eventId),
    );
    expect(sent).toBe(0);
    expect((await notices.queue.status(f.w.id))[0]?.state).toBe('REVOKED');
  });
  it('G6/G8 discovers new vaults, replays committed events after a crash, and never credits the native mirror', async () => {
    const f = await fixture(),
      receipts = new WorkspaceReceipts(f.finance, f.service, f.ledger);
    const { chain, api } = forkableChain();
    const usdc = token('arc-testnet', 'USDC');
    api.mine([
      {
        from: f.payer.address,
        to: f.authority.vault,
        value: 50000n,
        sender: f.payer.address,
      },
    ]);
    const tx = api.txsAt(1)[0]!,
      block = await chain.block(1n);
    const receiptChain: IndexerChain = {
      ...chain,
      receiptLogs: async (hash) => ({
        status: 'success',
        from: f.payer.address,
        feeWei: 1n,
        logs: (
          await chain.logs({
            address: usdc.address,
            topics: [],
            fromBlock: 1n,
            toBlock: 1n,
          })
        ).filter((l) => l.transactionHash === hash),
      }),
    };
    const indexer = new WorkspaceIndexer(receipts, [receiptChain], {
      token: { address: usdc.address, codeHash: keccak256(TOKEN_CODE) },
      memo: null,
      batchSize: 10n,
      confirmations: 0,
    });
    await indexer.migrate();
    // Discovery initially sees no factory-proven vault, then sees a newly activated one.
    expect((await indexer.tick()).some((v) => v.workspaceId === f.w.id)).toBe(
      false,
    );
    await pool.query(
      "INSERT INTO synq_ws_vault_setups(workspace_id,setup_hash,data,state,evidence,created_at) VALUES($1,$2,'{}','ACTIVE',$3,$4)",
      [
        f.w.id,
        toHex(randomBytes(32)),
        { safe: f.authority.vault, blockNumber: '1' },
        f.store.now(),
      ],
    );
    const cfg = {
      stream: `workspace:${f.w.id}`,
      chainId: usdc.chainId,
      token: { address: usdc.address, codeHash: keccak256(TOKEN_CODE) },
      memo: null,
      wallets: [f.authority.vault],
      startBlock: 1n,
      batchSize: 10n,
      confirmations: 0,
    };
    // Process dies after durable ingestion and before booking.
    const first = new ArcChainIndexer(
      receiptChain,
      new PostgresArcIndexStore(pool),
      cfg,
    );
    await first.step();
    expect(await f.ledger.store.entries(f.w.id)).toHaveLength(0);
    api.sloppy = true;
    expect(await indexer.tick()).toContainEqual({
      workspaceId: f.w.id,
      state: 'INDEXED',
    });
    await indexer.tick();
    await indexer.tick();
    const rows = await pool.query(
      'SELECT * FROM synq_ws_receipts WHERE workspace_id=$1',
      [f.w.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      state: 'PENDING_POLICY',
      invoice_id: null,
      data: { amount: '50000' },
    });
    expect(await f.ledger.store.entries(f.w.id)).toHaveLength(1);
    expect(await f.ledger.balance(f.w.id, 'CASH_ARC_USDC', usdc.assetId)).toBe(
      50000n,
    );
    expect(
      await f.ledger.balance(f.w.id, 'UNAPPLIED_RECEIPTS', usdc.assetId),
    ).toBe(-50000n);
    const event: IndexedEvent = {
      chainId: usdc.chainId,
      kind: 'TRANSFER',
      emitter: usdc.address,
      txHash: tx.hash,
      logIndex: 0,
      blockHash: block.hash,
      blockNumber: 1n,
      data: { from: f.payer.address, to: f.authority.vault, value: '50000' },
      removed: false,
    };
    expect(
      await Promise.all([
        receipts.apply(f.w.id, receiptChain, event),
        receipts.apply(f.w.id, receiptChain, event),
      ]),
    ).toEqual(['DUPLICATE', 'DUPLICATE']);
    await expect(
      receipts.apply(f.w.id, receiptChain, {
        ...event,
        data: { ...event.data, value: '50001' },
      }),
    ).rejects.toThrow('RECEIPT_PROVENANCE_MISMATCH');
    expect(
      await receipts.apply(f.w.id, receiptChain, { ...event, removed: true }),
    ).toBe('REVIEW_REORGED_RECEIPT');
    expect(
      (
        await pool.query(
          'SELECT state FROM synq_ws_receipts WHERE workspace_id=$1',
          [f.w.id],
        )
      ).rows[0].state,
    ).toBe('REVIEW');
    expect(await f.ledger.store.entries(f.w.id)).toHaveLength(1);
  });
});
