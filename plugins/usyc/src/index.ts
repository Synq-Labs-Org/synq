import {
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  keccak256,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import type { Money } from '@synq/domain';
import { contract, token } from '@synq/chain-registry/arc';

/**
 * USYC (Hashnote/Circle tokenized money-market fund) on Arc testnet.
 *
 * USYC is permissioned: subscriptions go through the Teller, and the Teller's
 * Solmate `RolesAuthority` ("Entitlements") decides who may call it. Circle
 * allowlists an Arc testnet address only after a support ticket; production
 * access is for eligible non-US institutions. Synq therefore:
 * - reads the entitlement on chain (`canCall(wallet, teller, selector)`)
 *   before planning any Teller action, after checking that the Teller really
 *   answers to that authority and that both code hashes match the registry;
 * - returns INELIGIBLE for any wallet that is not allowlisted, and never
 *   simulates, fixtures or describes a successful USYC investment for it;
 * - does not treat `Teller.maxDeposit(wallet)` as eligibility: on Arc testnet
 *   it returns the wallet's USDC balance even for non-allowlisted wallets.
 *
 * Read-only: callers pass a public client; no signer is ever needed here.
 */

export const TELLER_ABI = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address account) returns (uint256)',
  'function mint(uint256 shares, address receiver) returns (uint256)',
  'function authority() view returns (address)',
  'function asset() view returns (address)',
  'function share() view returns (address)',
  'function maxDeposit(address account) view returns (uint256)',
]);
export const ENTITLEMENTS_ABI = parseAbi([
  'function canCall(address user, address target, bytes4 functionSig) view returns (bool)',
  'function isCapabilityPublic(address target, bytes4 functionSig) view returns (bool)',
  'function getUserRoles(address user) view returns (bytes32)',
  'function getRolesWithCapability(address target, bytes4 functionSig) view returns (bytes32)',
]);

export const TELLER_ACTIONS = {
  deposit: toFunctionSelector('function deposit(uint256,address)'),
  redeem: toFunctionSelector('function redeem(uint256,address,address)'),
  mint: toFunctionSelector('function mint(uint256,address)'),
} as const;
export type TellerAction = keyof typeof TELLER_ACTIONS;

export class UsycError extends Error {
  constructor(
    readonly code:
      | 'INELIGIBLE'
      | 'BINDING_MISMATCH'
      | 'CODE_HASH_MISMATCH'
      | 'STALE_ENTITLEMENT'
      | 'WRONG_WALLET'
      | 'BAD_AMOUNT',
    message: string = code,
  ) {
    super(message);
    this.name = 'UsycError';
  }
}

/** The subset of a viem public client this module reads through. */
export type UsycReader = {
  readContract(args: {
    address: Address;
    abi: typeof TELLER_ABI | typeof ENTITLEMENTS_ABI;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  getCode(args: { address: Address }): Promise<Hex | undefined>;
  getBlockNumber?(): Promise<bigint>;
};

export type UsycEntitlement = Readonly<{
  status: 'ELIGIBLE' | 'INELIGIBLE';
  wallet: Address;
  action: TellerAction;
  selector: Hex;
  teller: Address;
  entitlements: Address;
  canCall: boolean;
  capabilityPublic: boolean;
  userRoles: Hex;
  requiredRoles: Hex;
  checkedAt: number;
  blockNumber: bigint | null;
  /** Shown to the user / agent verbatim. */
  explanation: string;
}>;

async function pinnedCode(r: UsycReader, address: Address, pinned: Hex | null) {
  const code = await r.getCode({ address });
  if (!code || code === '0x')
    throw new UsycError('CODE_HASH_MISMATCH', `${address} has no code`);
  const hash = keccak256(code);
  if (!pinned || hash !== pinned)
    throw new UsycError(
      'CODE_HASH_MISMATCH',
      `${address} code ${hash} != pinned ${pinned}`,
    );
}

/**
 * P15-02: the allowlist read that must precede any Teller action. Throws if
 * the contracts are not the pinned ones or the Teller does not answer to the
 * pinned Entitlements contract; otherwise returns ELIGIBLE or INELIGIBLE.
 */
export async function checkUsycEntitlement(
  reader: UsycReader,
  wallet: Address,
  action: TellerAction,
  now: number,
): Promise<UsycEntitlement> {
  const teller = contract('arc-testnet', 'USYC_TELLER');
  const ent = contract('arc-testnet', 'USYC_ENTITLEMENTS');
  const usyc = token('arc-testnet', 'USYC');
  const usdc = token('arc-testnet', 'USDC');
  await pinnedCode(reader, teller.address, teller.codeHash);
  await pinnedCode(reader, ent.address, ent.codeHash);
  const read = (
    address: Address,
    abi: typeof TELLER_ABI | typeof ENTITLEMENTS_ABI,
    functionName: string,
    args?: readonly unknown[],
  ) => reader.readContract({ address, abi, functionName, args });
  const [authority, asset, share] = (await Promise.all([
    read(teller.address, TELLER_ABI, 'authority'),
    read(teller.address, TELLER_ABI, 'asset'),
    read(teller.address, TELLER_ABI, 'share'),
  ])) as [Address, Address, Address];
  if (!isAddressEqual(authority, ent.address))
    throw new UsycError(
      'BINDING_MISMATCH',
      `Teller authority ${authority} is not the pinned Entitlements ${ent.address}`,
    );
  if (
    !isAddressEqual(asset, usdc.address) ||
    !isAddressEqual(share, usyc.address)
  )
    throw new UsycError(
      'BINDING_MISMATCH',
      `Teller asset/share ${asset}/${share} are not Arc USDC/USYC`,
    );
  const selector = TELLER_ACTIONS[action];
  const [canCall, capabilityPublic, userRoles, requiredRoles] =
    (await Promise.all([
      read(ent.address, ENTITLEMENTS_ABI, 'canCall', [
        wallet,
        teller.address,
        selector,
      ]),
      read(ent.address, ENTITLEMENTS_ABI, 'isCapabilityPublic', [
        teller.address,
        selector,
      ]),
      read(ent.address, ENTITLEMENTS_ABI, 'getUserRoles', [wallet]),
      read(ent.address, ENTITLEMENTS_ABI, 'getRolesWithCapability', [
        teller.address,
        selector,
      ]),
    ])) as [boolean, boolean, Hex, Hex];
  const eligible = canCall === true;
  return Object.freeze({
    status: eligible ? 'ELIGIBLE' : 'INELIGIBLE',
    wallet,
    action,
    selector,
    teller: teller.address,
    entitlements: ent.address,
    canCall: canCall === true,
    capabilityPublic: capabilityPublic === true,
    userRoles,
    requiredRoles,
    checkedAt: now,
    blockNumber: reader.getBlockNumber ? await reader.getBlockNumber() : null,
    explanation: eligible
      ? `Wallet is entitled to Teller.${action} on Arc testnet.`
      : `INELIGIBLE: wallet ${wallet} is not allowlisted for USYC Teller.${action}. USYC is a permissioned fund for eligible institutions; Arc testnet access requires Circle to allowlist the address. Synq will not attempt or simulate this investment.`,
  });
}

export const ENTITLEMENT_MAX_AGE_MS = 60_000;

/** Refuses unless a fresh ELIGIBLE entitlement exists for this wallet and action. */
export function assertUsycAllowed(
  e: UsycEntitlement,
  wallet: Address,
  action: TellerAction,
  now: number,
) {
  if (!isAddressEqual(e.wallet, wallet) || e.action !== action)
    throw new UsycError(
      'WRONG_WALLET',
      `entitlement is for ${e.wallet}/${e.action}`,
    );
  if (now - e.checkedAt > ENTITLEMENT_MAX_AGE_MS || e.checkedAt > now)
    throw new UsycError('STALE_ENTITLEMENT', 're-read canCall before acting');
  if (e.status !== 'ELIGIBLE' || !e.canCall)
    throw new UsycError('INELIGIBLE', e.explanation);
}

export type UsycSubscriptionPlan = Readonly<{
  approve: { to: Address; data: Hex };
  deposit: { to: Address; data: Hex };
  amount: Money;
}>;

/**
 * Builds the two calls for an entitled wallet (approve USDC to the Teller,
 * then `deposit`). For any wallet that is not entitled it throws INELIGIBLE
 * before anything is encoded.
 */
export function planUsycSubscription(input: {
  entitlement: UsycEntitlement;
  wallet: Address;
  amount: Money;
  now: number;
}): UsycSubscriptionPlan {
  assertUsycAllowed(input.entitlement, input.wallet, 'deposit', input.now);
  const usdc = token('arc-testnet', 'USDC');
  if (
    input.amount.asset.assetId !== usdc.assetId ||
    input.amount.baseUnits <= 0n
  )
    throw new UsycError('BAD_AMOUNT', 'subscriptions are in Arc USDC');
  const teller = contract('arc-testnet', 'USYC_TELLER').address;
  return Object.freeze({
    approve: {
      to: usdc.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [teller, input.amount.baseUnits],
      }),
    },
    deposit: {
      to: teller,
      data: encodeFunctionData({
        abi: TELLER_ABI,
        functionName: 'deposit',
        args: [input.amount.baseUnits, input.wallet],
      }),
    },
    amount: input.amount,
  });
}
