import {
  hashTypedData,
  recoverTypedDataAddress,
  getAddress,
  isAddress,
  zeroAddress,
  type Hex,
} from 'viem';
import { z } from 'zod';

const address = z
  .string()
  .refine((v) => isAddress(v))
  .transform((v) => getAddress(v));
const owner = address.refine((v) => BigInt(v) > 1n);
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((v) => BigInt(v) < 2n ** 256n);
export const VaultSetupSchema = z
  .strictObject({
    workspaceId: z.string().uuid(),
    chainId: z.literal(5042002),
    factory: owner,
    token: owner,
    sponsor: owner,
    operator: owner,
    guardian: address,
    owners: z.array(owner).min(1).max(20),
    threshold: z.number().int().min(1).max(20),
    delay: z.number().int().min(3600).max(2592000),
    perPaymentCap: uint,
    windowCap: uint,
    maxGasNativeWei: uint.refine((v) => BigInt(v) > 0n),
    salt: z.string().regex(/^0x[0-9a-f]{64}$/),
    expiresAt: z.number().int().positive().safe(),
  })
  .superRefine((v, ctx) => {
    const unique = new Set(v.owners.map((a) => a.toLowerCase()));
    if (unique.size !== v.owners.length || v.threshold > v.owners.length)
      ctx.addIssue({ code: 'custom', message: 'invalid owner quorum' });
    if (
      unique.has(v.operator.toLowerCase()) ||
      v.guardian === v.operator ||
      unique.has(v.factory.toLowerCase()) ||
      unique.has(v.token.toLowerCase())
    )
      ctx.addIssue({ code: 'custom', message: 'invalid custody roles' });
    if (BigInt(v.windowCap) < BigInt(v.perPaymentCap))
      ctx.addIssue({
        code: 'custom',
        message: 'window cap is below payment cap',
      });
  });
export type VaultSetup = z.output<typeof VaultSetupSchema>;
export const SetupSignatureSchema = z.strictObject({
  owner,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export type SetupSignature = z.output<typeof SetupSignatureSchema>;

export function vaultSetupTypedData(s: VaultSetup) {
  return {
    domain: {
      name: 'Synq Workspace Vault Setup',
      version: '1',
      chainId: s.chainId,
      verifyingContract: getAddress(s.factory),
    },
    primaryType: 'VaultSetup' as const,
    types: {
      VaultSetup: [
        { name: 'workspaceId', type: 'string' },
        { name: 'token', type: 'address' },
        { name: 'sponsor', type: 'address' },
        { name: 'operator', type: 'address' },
        { name: 'guardian', type: 'address' },
        { name: 'owners', type: 'address[]' },
        { name: 'threshold', type: 'uint256' },
        { name: 'delay', type: 'uint256' },
        { name: 'perPaymentCap', type: 'uint256' },
        { name: 'windowCap', type: 'uint256' },
        { name: 'maxGasNativeWei', type: 'uint256' },
        { name: 'salt', type: 'bytes32' },
        { name: 'expiresAt', type: 'uint64' },
        { name: 'recipients', type: 'address[]' },
      ],
    },
    message: {
      workspaceId: s.workspaceId,
      token: getAddress(s.token),
      sponsor: getAddress(s.sponsor),
      operator: getAddress(s.operator),
      guardian: getAddress(s.guardian),
      owners: s.owners.map((a) => getAddress(a)),
      threshold: BigInt(s.threshold),
      delay: BigInt(s.delay),
      perPaymentCap: BigInt(s.perPaymentCap),
      windowCap: BigInt(s.windowCap),
      maxGasNativeWei: BigInt(s.maxGasNativeWei),
      salt: s.salt as Hex,
      expiresAt: BigInt(s.expiresAt),
      recipients: [] as `0x${string}`[],
    },
  } as const;
}
export const vaultSetupHash = (s: VaultSetup) =>
  hashTypedData(vaultSetupTypedData(s));
export const vaultSetupIntentId = (s: VaultSetup) =>
  `vault-setup:${vaultSetupHash(s)}`;
export const vaultSetupValue = (s: VaultSetup) => ({
  chainId: s.chainId,
  token: getAddress(s.token),
  payer: getAddress(s.sponsor),
  recipient: getAddress(s.factory),
  amount: 0n,
});
export async function verifySetupSignature(s: VaultSetup, raw: unknown) {
  const signed = SetupSignatureSchema.parse(raw);
  if (!s.owners.includes(signed.owner)) throw new Error('SETUP_NOT_OWNER');
  const recovered = await recoverTypedDataAddress({
    ...vaultSetupTypedData(s),
    signature: signed.signature as Hex,
  });
  if (getAddress(recovered) !== signed.owner)
    throw new Error('SETUP_SIGNATURE_MISMATCH');
  return signed;
}
export async function verifyVaultSetup(
  s: VaultSetup,
  signatures: readonly SetupSignature[],
  now: number,
) {
  VaultSetupSchema.parse(s);
  if (now >= s.expiresAt) throw new Error('SETUP_EXPIRED');
  const signed = await Promise.all(
    signatures.map((sig) => verifySetupSignature(s, sig)),
  );
  if (
    signed.length !== s.owners.length ||
    new Set(signed.map((sig) => sig.owner)).size !== s.owners.length
  )
    throw new Error('SETUP_ALL_OWNERS_REQUIRED');
}
export const NO_GUARDIAN = zeroAddress;
