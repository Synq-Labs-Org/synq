import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApplicationFailure } from '@temporalio/common';
import { z } from 'zod';
import {
  EconomicGrantAuthority,
  EconomicMandateSchema,
  type EconomicMandate,
} from '@synq/kernel';
import {
  EnvVaultKeyProvider,
  GiftCodeVault,
  ProfileDirectory,
  PostgresProfileStore,
  ProfileDecryptor,
  type ProfileSqlPool,
} from '@synq/profile-vault';
import type { HttpFetch, RealMoneyGate } from '@synq/plugin-commerce';
import {
  PostgresEconomicGrantLedger,
  PostgresReservationStore,
  PostgresSettlementFabricStore,
  SettlementFabric,
  type SettlementPolicy,
  type SettlementSqlPool,
} from '@synq/settlement';
import type {
  ApprovalLedger,
  Asset,
  MembershipDirectory,
  VerifiedApproval,
} from '@synq/schemas';
import { createBookingActivities } from '../activities/booking.js';
import type { BookingActivities } from '../activities/booking-types.js';
import {
  commerceProvidersFromEnv,
  type CommerceProviders,
  type ProviderRuntimeStatus,
} from './providers.js';
import { PostgresBookingRecords } from './records.js';
import { bitrefillRealMoneyGate } from './real-money.js';

type Env = Readonly<Record<string, string | undefined>>;

export const ECONOMIC_GRANT_KEY_ENV = 'SYNQ_ECONOMIC_GRANT_KEY';

export type CommerceIdentityPorts = {
  ledger: ApprovalLedger;
  directory: MembershipDirectory;
  /** Identity-verified approvals stored under a draft digest (the Kernel request hash). */
  approvalsFor(requestHash: string): Promise<VerifiedApproval[]>;
};

export type CommerceTreasuryPort = {
  core: Asset;
  edge: Asset;
  account(groupId: string): Promise<`0x${string}` | null>;
  /** Confirmed on-chain balance of the group account, or null when unknown. */
  confirmed(groupId: string, asset: Asset): Promise<bigint | null>;
};

export type CommerceRuntimeStatus = {
  booking: 'READY' | 'BLOCKED';
  reason: string | null;
  providers: ProviderRuntimeStatus[];
  bitrefillApprovals: 'DENY_ALL' | 'KERNEL_GRANT';
};

export type CommerceRuntime = {
  activities: BookingActivities;
  status: CommerceRuntimeStatus;
  authority: EconomicGrantAuthority | null;
  fabric: SettlementFabric;
  reservations: PostgresReservationStore;
  profiles: PostgresProfileStore;
  records: PostgresBookingRecords;
  providers: CommerceProviders;
  bitrefillGate: RealMoneyGate;
};

/** Sandbox-only rails; no conversion (cap 0) and no mainnet rail is executable. */
export function commerceSettlementPolicy(core: Asset): SettlementPolicy {
  return {
    allowedRails: ['PROVIDER_BALANCE', 'SCOPED_CARD'],
    allowedSourceAssets: [core.canonicalAssetId],
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
  };
}

function grantKey(env: Env): Uint8Array | null {
  const raw = (env[ECONOMIC_GRANT_KEY_ENV] ?? '').trim().replace(/^0x/, '');
  return /^[0-9a-fA-F]{64,}$/.test(raw) && raw.length % 2 === 0
    ? new Uint8Array(Buffer.from(raw, 'hex'))
    : null;
}

/**
 * Installs operator-provided economic mandates. A stored version at or above
 * the file's is kept as-is, and a revoked mandate id stays revoked whatever
 * version the file carries.
 */
async function installMandates(
  authority: EconomicGrantAuthority,
  ledger: PostgresEconomicGrantLedger,
  path: string | undefined,
): Promise<EconomicMandate[]> {
  if (!path) return [];
  const list = z
    .array(EconomicMandateSchema)
    .parse(JSON.parse(readFileSync(resolve(path), 'utf8')));
  for (const m of list) {
    const stored = await ledger.mandate(m.mandateId);
    if (stored && stored.version >= m.version) continue;
    // A revoked mandate id is never re-activated by bumping its version in
    // the file; the group installs a new mandate id instead.
    if (stored?.status === 'REVOKED') continue;
    await authority.install(m);
  }
  return list;
}

const BOOKING_ACTIVITY_NAMES = [
  'revalidateBookingCandidate',
  'reserveBookingFunds',
  'authorizeBooking',
  'bookingStepUpRequirement',
  'verifyBookingStepUp',
  'executeBooking',
  'holdBookingFunds',
  'reconcileBooking',
  'settleBooking',
  'releaseBookingFunds',
  'cancelProviderBooking',
] as const satisfies readonly (keyof BookingActivities)[];

/** Booking Activities that refuse without side effects when the Kernel authority is absent. */
export function unconfiguredBooking(reason: string): BookingActivities {
  const refuse = async (): Promise<never> => {
    throw ApplicationFailure.nonRetryable(
      `booking is not configured on this worker: ${reason}`,
      'NOT_CONFIGURED',
    );
  };
  return Object.fromEntries(
    BOOKING_ACTIVITY_NAMES.map((n) => [n, refuse]),
  ) as unknown as BookingActivities;
}

/**
 * Production booking and Settlement Fabric wiring for the workflow worker:
 * Postgres reservations, fabric, Kernel grant ledger, profile vault and
 * booking records (all migrated here, at startup), provider adapters from
 * env, and the Kernel economic authority keyed by SYNQ_ECONOMIC_GRANT_KEY.
 * Without that key the booking Activities refuse; nothing is ever paid.
 */
export async function openCommerceRuntime(options: {
  pool: SettlementSqlPool & ProfileSqlPool;
  schema?: string;
  env: Env;
  now: () => number;
  fetch?: HttpFetch;
  identity: CommerceIdentityPorts;
  treasury: CommerceTreasuryPort;
  workerId: string;
}): Promise<CommerceRuntime> {
  const { pool, env, now, identity, treasury } = options;
  const schema = options.schema ?? 'public';
  const reservations = new PostgresReservationStore(pool, schema);
  const fabricStore = new PostgresSettlementFabricStore(pool, schema);
  const ledger = new PostgresEconomicGrantLedger(pool, schema);
  const profiles = new PostgresProfileStore(pool, schema);
  const records = new PostgresBookingRecords(pool, schema);
  for (const store of [reservations, fabricStore, ledger, profiles, records])
    await store.migrate();
  const fabric = new SettlementFabric(fabricStore, reservations, now);

  let keys: EnvVaultKeyProvider | null = null;
  try {
    keys = new EnvVaultKeyProvider(env);
  } catch {
    keys = null;
  }
  const providers = commerceProvidersFromEnv(env, {
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    now,
    giftCodes: keys ? new GiftCodeVault(profiles, keys, now) : null,
    recipients: keys ? new ProfileDirectory(profiles, keys, now) : null,
  });

  const key = grantKey(env);
  const authority = key
    ? new EconomicGrantAuthority({
        key,
        reservations,
        ledger,
        approvals: { ledger: identity.ledger, directory: identity.directory },
      })
    : null;
  if (authority)
    await installMandates(authority, ledger, env.SYNQ_ECONOMIC_MANDATES_FILE);
  const bitrefill = bitrefillRealMoneyGate(env, authority);

  const status: CommerceRuntimeStatus = {
    booking: authority ? 'READY' : 'BLOCKED',
    reason: authority ? null : `${ECONOMIC_GRANT_KEY_ENV} not set`,
    providers: providers.status,
    bitrefillApprovals: bitrefill.verifier,
  };
  const base = {
    authority,
    fabric,
    reservations,
    profiles,
    records,
    providers,
    bitrefillGate: bitrefill.gate,
    status,
  };
  if (!authority)
    return { ...base, activities: unconfiguredBooking(status.reason!) };

  const decryptor = keys
    ? new ProfileDecryptor(profiles, keys, now, options.workerId)
    : null;
  const activities = createBookingActivities({
    now,
    graph: providers.graph,
    providers: providers.providers,
    ports: providers.ports,
    reservations,
    settlement: {
      async treasury(groupId) {
        const account = await treasury.account(groupId);
        if (!account)
          throw ApplicationFailure.nonRetryable(
            `unknown group ${groupId}`,
            'NOT_CONFIGURED',
          );
        const at = now();
        const view = async (asset: Asset) => {
          const confirmed = await treasury.confirmed(groupId, asset);
          if (confirmed !== null)
            await reservations.setConfirmedBalance({
              groupId,
              assetId: asset.canonicalAssetId,
              confirmed,
              asOf: at,
            });
          return {
            asset,
            free: BigInt(
              (await reservations.free(groupId, asset.canonicalAssetId)).free,
            ),
          };
        };
        return {
          account,
          core: await view(treasury.core),
          edge: await view(treasury.edge),
        };
      },
      rails: providers.rails,
      policy: commerceSettlementPolicy(treasury.core),
      reference: async () => null,
      reservationTtlSeconds: 3_600,
    },
    authority,
    approvals: {
      async verify({ groupId, requestHash, tokens }) {
        const wanted = new Set(tokens);
        return (await identity.approvalsFor(requestHash)).filter(
          (a) => a.groupId === groupId && wanted.has(a.approvalId),
        );
      },
    },
    travelers: {
      async resolve({ groupId, refs, purpose }) {
        if (!refs.length) return [];
        if (!decryptor)
          throw ApplicationFailure.nonRetryable(
            'SYNQ_PROFILE_VAULT_KEY not set',
            'NOT_CONFIGURED',
          );
        return Promise.all(
          refs.map((ref) =>
            decryptor.resolve({
              groupId,
              ref,
              kind: 'TRAVELER',
              purpose,
              fields: [
                'givenName',
                'familyName',
                'bornOn',
                'email',
                'phone',
                'title',
                'gender',
              ],
            }),
          ),
        );
      },
    },
    receipts: { write: (r) => records.writeReceipt(r) },
    incidents: {
      open: (i) => records.openIncident({ ...i, at: now() }),
    },
    fabric,
  });
  return { ...base, activities };
}
