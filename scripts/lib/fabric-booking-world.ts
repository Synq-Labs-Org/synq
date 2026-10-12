import { randomBytes } from 'node:crypto';
import { officialAssets } from '@synq/chain-registry';
import {
  EconomicGrantAuthority,
  MemoryEconomicGrantLedger,
} from '@synq/kernel';
import {
  ProviderCapabilityGraph,
  type FulfillmentReceipt,
  type OfferProvider,
  type ProviderBookingPort,
  type ProviderCapability,
} from '@synq/offer-exchange';
import {
  MemoryReservationStore,
  MemorySettlementFabricStore,
  SettlementFabric,
  type RailDescriptor,
  type SettlementFabricStore,
  type TreasuryReservationStore,
} from '@synq/settlement';
import type { Asset } from '@synq/schemas';
import { createBookingActivities } from '../../workers/workflow/src/activities/booking.js';
import {
  approval,
  approvalPorts,
} from '../../tests/kernel/economic-fixtures.js';

export const AUSD = officialAssets.testnetAUSD as Asset;
export const USDC = officialAssets.testnetUSDC as Asset;
export const usd = (cents: number) => ({
  amount: String(cents),
  currency: 'USD',
  decimals: 2,
});

/**
 * One group, one mandate, one provider: Kernel economic authority with
 * fixture-signed (LOCAL_FIXTURE, EIP-712) approvals, treasury reservations,
 * the v1.3 Settlement Fabric and the booking activities. Used by the
 * workflow tests and the provider sandbox evidence scripts.
 */
export async function fabricBookingWorld(input: {
  groupId: string;
  mandateId: string;
  providerId: string;
  host: string;
  capability: ProviderCapability;
  provider: OfferProvider;
  port: ProviderBookingPort;
  rail: RailDescriptor;
  perActionCapCents: number;
  autoApproveCents?: number;
  members?: string[];
  now: () => number;
  reservations?: TreasuryReservationStore;
  fabricStore?: SettlementFabricStore;
}) {
  const members = input.members ?? ['alice', 'bob', 'carol'];
  const now = input.now;
  const reservations = input.reservations ?? new MemoryReservationStore();
  for (const asset of [AUSD, USDC])
    await reservations.setConfirmedBalance({
      groupId: input.groupId,
      assetId: asset.canonicalAssetId,
      confirmed: 10_000n * 10n ** BigInt(asset.decimals),
      asOf: now(),
    });
  const fabric = new SettlementFabric(
    input.fabricStore ?? new MemorySettlementFabricStore(),
    reservations,
    now,
  );
  const authority = new EconomicGrantAuthority({
    key: new Uint8Array(randomBytes(32)),
    reservations,
    ledger: new MemoryEconomicGrantLedger(),
    approvals: approvalPorts(members, { groupId: input.groupId }),
  });
  await authority.install({
    approverKinds: ['LOCAL_FIXTURE'],
    mandateId: input.mandateId,
    groupId: input.groupId,
    version: 1,
    status: 'ACTIVE',
    domains: ['COMMERCE'],
    providers: [input.providerId],
    hosts: [input.host],
    perActionCap: usd(input.perActionCapCents),
    cumulativeBudget: usd(input.perActionCapCents * 4),
    autoApproveMax: usd(input.autoApproveCents ?? 0),
    quorum: 2,
    members,
    maxQuoteAgeSeconds: 900,
    grantTtlSeconds: 900,
    environment: 'SANDBOX',
    validUntil: now() + 86_400,
  });
  const receipts: FulfillmentReceipt[] = [];
  const incidents: string[] = [];
  const free = async (asset: Asset) =>
    BigInt(
      (await reservations.free(input.groupId, asset.canonicalAssetId)).free,
    );
  const activities = createBookingActivities({
    now,
    graph: new ProviderCapabilityGraph([input.capability]),
    providers: { [input.providerId]: input.provider },
    ports: { [input.providerId]: input.port },
    reservations,
    settlement: {
      treasury: async () => ({
        account: '0x00000000000000000000000000000000000a11ce',
        core: { asset: AUSD, free: await free(AUSD) },
        edge: { asset: USDC, free: await free(USDC) },
      }),
      rails: [input.rail],
      policy: {
        allowedRails: [input.rail.rail],
        allowedSourceAssets: [AUSD.canonicalAssetId],
        fxBufferBps: 0,
        conversion: {
          maxSlippageBps: 50,
          maxDepegBps: 100,
          maxReferenceAgeSeconds: 600,
          perConversionCap: 0n,
          autoApproveMax: 0n,
          verifiedVenues: [],
        },
        quoteTtlSeconds: 900,
      },
      reference: async () => null,
      reservationTtlSeconds: 3_600,
    },
    authority,
    approvals: {
      verify: async ({ tokens, requestHash }) =>
        Promise.all(
          tokens.flatMap((t) => {
            const [kind, member, hash] = t.split(':');
            return kind === 'fixture-verified' &&
              member &&
              members.includes(member) &&
              hash === requestHash
              ? [
                  approval(member, requestHash, {
                    groupId: input.groupId,
                    mandateId: input.mandateId,
                  }),
                ]
              : [];
          }),
        ),
    },
    travelers: { resolve: async () => [] },
    receipts: { write: async (r) => void receipts.push(r) },
    incidents: { open: async (i) => void incidents.push(i.code) },
    fabric,
  });
  return { activities, reservations, fabric, authority, receipts, incidents };
}
