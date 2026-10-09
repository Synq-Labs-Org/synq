import { z } from 'zod';

export const UINT256_MAX = (1n << 256n) - 1n;
export const AmountSchema = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)$/)
  .pipe(z.string().refine((v) => BigInt(v) <= UINT256_MAX, 'uint256 overflow'));
export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase() as `0x${string}`);
export const HashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase() as `0x${string}`);
export const SelectorSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/)
  .transform((v) => v.toLowerCase() as `0x${string}`);
export const IdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
export const TimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const ChainIdSchema = z.union([
  z.literal(31337),
  z.literal(10143),
  z.literal(143),
]);
export const ProfileSchema = z.enum(['local', 'testnet', 'mainnet']);
export const NetworkProfileSchema = z
  .strictObject({
    profile: ProfileSchema,
    chainId: ChainIdSchema,
    providerEnvironment: z.enum(['local', 'sandbox', 'production']),
  })
  .refine(
    (v) =>
      ({ local: 31337, testnet: 10143, mainnet: 143 })[v.profile] ===
        v.chainId &&
      { local: 'local', testnet: 'sandbox', mainnet: 'production' }[
        v.profile
      ] === v.providerEnvironment,
    'network/profile mismatch',
  );
export const AssetSchema = z
  .strictObject({
    canonicalAssetId: z.string(),
    chainId: ChainIdSchema,
    address: AddressSchema,
    symbol: z.enum(['AUSD', 'USDC', 'MON', 'WMON', 'PERPL_TEST_USD', 'OTHER']),
    decimals: z.number().int().min(0).max(36),
  })
  .refine(
    (v) => v.canonicalAssetId === `eip155:${v.chainId}/erc20:${v.address}`,
    'canonical asset mismatch',
  );
export const ActionKindSchema = z.enum([
  'TRANSFER',
  'SPOT_TRADE',
  'PERP_HEDGE',
  'CARD_PAYMENT',
  'X402_PAYMENT',
  'CROSS_CHAIN_FUND',
  'SUBSCRIPTION',
  'CONVERSION',
]);
export const ActionIntentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    intentId: IdSchema,
    groupId: IdSchema,
    mandateId: IdSchema,
    mandateVersion: z.number().int().positive(),
    action: ActionKindSchema,
    network: NetworkProfileSchema,
    chainId: ChainIdSchema,
    account: AddressSchema,
    operator: AddressSchema,
    pluginId: IdSchema,
    target: AddressSchema,
    selector: SelectorSchema,
    calldataHash: HashSchema,
    inputAsset: AssetSchema,
    maxInputAmount: AmountSchema.refine((v) => BigInt(v) > 0n),
    outputAsset: AssetSchema.nullable(),
    minOutputAmount: AmountSchema,
    nativeValue: AmountSchema,
    maxSlippageBps: z.number().int().min(0).max(10000),
    leverageBps: z.number().int().min(0).max(1000000),
    validAfter: TimestampSchema,
    validUntil: TimestampSchema,
    nonce: AmountSchema,
    evidenceHash: HashSchema,
    riskPacketHash: HashSchema,
  })
  .refine(
    (v) =>
      v.validUntil > v.validAfter &&
      v.network.chainId === v.chainId &&
      v.inputAsset.chainId === v.chainId &&
      (v.outputAsset === null ||
        v.action === 'CROSS_CHAIN_FUND' ||
        v.outputAsset.chainId === v.chainId) &&
      (v.outputAsset !== null || v.minOutputAmount === '0'),
    'invalid time/asset/network envelope',
  );
export const MemberSchema = z.strictObject({
  memberId: IdSchema,
  signer: AddressSchema,
  active: z.boolean(),
});
export const MandateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    mandateId: IdSchema,
    groupId: IdSchema,
    version: z.number().int().positive(),
    status: z.enum(['ACTIVE', 'REVOKED']),
    network: NetworkProfileSchema,
    account: AddressSchema,
    operators: z.array(AddressSchema).min(1),
    plugins: z.array(IdSchema).min(1),
    actions: z.array(ActionKindSchema).min(1),
    targets: z.array(AddressSchema).min(1),
    selectors: z.array(SelectorSchema).min(1),
    inputAsset: AssetSchema,
    outputAssets: z.array(AssetSchema),
    allowNewOutputAssets: z.boolean(),
    perActionCap: AmountSchema,
    cumulativeBudget: AmountSchema,
    maxNativeValue: AmountSchema,
    maxSlippageBps: z.number().int().min(0).max(10000),
    maxReferenceDeviationBps: z.number().int().min(0).max(10000),
    maxLeverageBps: z.number().int().min(0).max(1000000),
    autoCap: AmountSchema,
    reviewCap: AmountSchema,
    quorum: z.number().int().positive(),
    members: z.array(MemberSchema).min(1),
    validAfter: TimestampSchema,
    validUntil: TimestampSchema,
    quoteTtlSeconds: z.number().int().positive(),
    evidenceTtlSeconds: z.number().int().positive(),
    simulationTtlSeconds: z.number().int().positive(),
    maxGrantTtlSeconds: z.number().int().positive(),
    minIntervalSeconds: z.number().int().nonnegative(),
    maxExecutions: z.number().int().positive(),
  })
  .refine(
    (v) =>
      v.validUntil > v.validAfter &&
      v.inputAsset.chainId === v.network.chainId &&
      /^(0|[1-9][0-9]*)$/.test(v.autoCap) &&
      /^(0|[1-9][0-9]*)$/.test(v.reviewCap) &&
      /^(0|[1-9][0-9]*)$/.test(v.perActionCap) &&
      /^(0|[1-9][0-9]*)$/.test(v.cumulativeBudget) &&
      BigInt(v.autoCap) <= BigInt(v.reviewCap) &&
      BigInt(v.reviewCap) <= BigInt(v.perActionCap) &&
      BigInt(v.perActionCap) <= BigInt(v.cumulativeBudget) &&
      v.quorum <= v.members.filter((m) => m.active).length &&
      new Set(v.members.map((m) => m.memberId)).size === v.members.length &&
      new Set(v.members.map((m) => m.signer)).size === v.members.length,
    'invalid mandate envelope',
  );
export const ApprovalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  groupId: IdSchema,
  mandateId: IdSchema,
  mandateVersion: z.number().int().positive(),
  intentHash: HashSchema,
  memberId: IdSchema,
  signer: AddressSchema,
  expiresAt: TimestampSchema,
  nonce: AmountSchema,
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]{130}$/)
    .transform((v) => v as `0x${string}`),
});
export const EvidenceSchema = z.strictObject({
  source: IdSchema,
  retrievedAt: TimestampSchema,
  chainId: ChainIdSchema,
  artifactHash: HashSchema,
  untrusted: z.boolean(),
});
export const RiskPacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  intentHash: HashSchema,
  evaluatedAt: TimestampSchema,
  quoteAt: TimestampSchema,
  quoteExpiresAt: TimestampSchema,
  slippageBps: z.number().int().min(0).max(10000),
  referenceDeviationBps: z.number().int().min(0).max(10000),
  maxReferenceDeviationBps: z.number().int().min(0).max(10000),
  blocked: z.boolean(),
  evidence: z.array(EvidenceSchema).min(1),
});
export const SimulationSchema = z.strictObject({
  intentHash: HashSchema,
  calldataHash: HashSchema,
  chainId: ChainIdSchema,
  account: AddressSchema,
  target: AddressSchema,
  succeeded: z.boolean(),
  simulatedAt: TimestampSchema,
  blockNumber: AmountSchema,
  artifactHash: HashSchema,
});
export const ExecutionGrantSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    grantId: HashSchema,
    intentHash: HashSchema,
    groupId: IdSchema,
    mandateId: IdSchema,
    mandateVersion: z.number().int().positive(),
    operator: AddressSchema,
    pluginId: IdSchema,
    chainId: ChainIdSchema,
    account: AddressSchema,
    target: AddressSchema,
    selector: SelectorSchema,
    calldataHash: HashSchema,
    inputAsset: AssetSchema,
    maxInputAmount: AmountSchema,
    outputAsset: AssetSchema.nullable(),
    minOutputAmount: AmountSchema,
    nativeValue: AmountSchema,
    validAfter: TimestampSchema,
    validUntil: TimestampSchema,
    nonce: AmountSchema,
    evidenceHash: HashSchema,
    riskPacketHash: HashSchema,
    simulationHash: HashSchema,
    tier: z.enum(['AUTO', 'REVIEW', 'CONSENSUS']),
  })
  .refine((v) => v.validUntil > v.validAfter, 'invalid grant validity');
export const ExecutionReceiptSchema = z.strictObject({
  grantId: HashSchema,
  intentHash: HashSchema,
  transactionHash: HashSchema,
  chainId: ChainIdSchema,
  actualInputAmount: AmountSchema,
  actualOutputAmount: AmountSchema,
  status: z.enum(['SUBMITTED', 'CONFIRMED', 'REVERTED', 'RECONCILED']),
  blockNumber: AmountSchema.nullable(),
});
export const ReservationSchema = z.strictObject({
  grantId: HashSchema,
  mandateId: IdSchema,
  groupId: IdSchema,
  asset: AssetSchema,
  amount: AmountSchema,
  expiresAt: TimestampSchema,
  status: z.enum(['RESERVED', 'CONSUMED', 'RELEASED', 'RECONCILED']),
});
export const TreasuryBalanceSchema = z.strictObject({
  account: AddressSchema,
  asset: AssetSchema,
  balance: AmountSchema,
});
export const PrincipalSchema = z.strictObject({
  principalId: IdSchema,
  kind: z.enum(['HUMAN', 'AGENT', 'SERVICE', 'SMART_ACCOUNT']),
  address: AddressSchema.nullable(),
});
export const GroupSchema = z.strictObject({
  groupId: IdSchema,
  account: AddressSchema,
  network: NetworkProfileSchema,
  coreTreasuryAsset: z.literal('AUSD'),
});
export const ProposalSchema = z.strictObject({
  proposalId: IdSchema,
  intent: ActionIntentSchema,
  status: z.enum(['PROPOSED', 'PENDING_APPROVAL', 'AUTHORIZED', 'REJECTED']),
});
export const DomainEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: IdSchema,
  aggregateId: IdSchema,
  sequence: z.number().int().positive(),
  type: IdSchema,
  occurredAt: TimestampSchema,
  actorId: IdSchema,
  evidenceHash: HashSchema,
});
export const WorldSnapshotSchema = z.strictObject({
  group: GroupSchema,
  members: z.array(MemberSchema),
  mandates: z.array(MandateSchema),
  proposals: z.array(ProposalSchema),
  approvals: z.array(ApprovalSchema),
  reservations: z.array(ReservationSchema),
  coreAsset: z.literal('AUSD'),
  generatedAt: TimestampSchema,
  chainHead: AmountSchema,
  indexedHead: AmountSchema,
});
export const CapabilitySchema = z.enum([
  'READ_MARKET',
  'QUOTE',
  'PROPOSE_ACTION',
  'TRANSFER',
  'SPOT_TRADE',
  'PERP_HEDGE',
  'CARD_PAYMENT',
  'X402_PAYMENT',
  'CROSS_CHAIN_FUND',
  'SUBSCRIPTION',
  'CONVERSION',
  'SIGN',
  'WITHDRAW',
  'CHANGE_OWNER',
  'CHANGE_THRESHOLD',
  'INSTALL_MODULE',
  'CHANGE_POLICY',
  'ISSUE_GRANT',
]);
export const PluginManifestSchema = z
  .strictObject({
    id: IdSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    capabilities: z.array(CapabilitySchema).min(1),
    chains: z.array(ChainIdSchema).min(1),
    environments: z.array(ProfileSchema).min(1),
    riskClass: z.enum(['READ_ONLY', 'FINANCIAL_EXECUTION']),
    requiresSimulation: z.boolean(),
    maxGrantTtlSeconds: z.number().int().positive(),
    sourceDocs: z.array(z.url()).min(1),
  })
  .refine(
    (v) =>
      new Set(v.capabilities).size === v.capabilities.length &&
      !v.capabilities.some((c) =>
        [
          'SIGN',
          'WITHDRAW',
          'CHANGE_OWNER',
          'CHANGE_THRESHOLD',
          'INSTALL_MODULE',
          'CHANGE_POLICY',
          'ISSUE_GRANT',
        ].includes(c),
      ) &&
      (v.riskClass !== 'FINANCIAL_EXECUTION' || v.requiresSimulation),
    'unsafe plugin manifest',
  );
export type ActionIntent = z.infer<typeof ActionIntentSchema>;
export type Mandate = z.infer<typeof MandateSchema>;
export type ExecutionGrant = z.infer<typeof ExecutionGrantSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type RiskPacket = z.infer<typeof RiskPacketSchema>;
export type Simulation = z.infer<typeof SimulationSchema>;
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;
export type Reservation = z.infer<typeof ReservationSchema>;
export type NetworkProfile = z.infer<typeof NetworkProfileSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>;
export type Member = z.infer<typeof MemberSchema>;
export type Principal = z.infer<typeof PrincipalSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type Proposal = z.infer<typeof ProposalSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
