import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  createSecp256k1SigningSession,
  isMeraError,
  type PasskeyCredentialMetadata,
  type WebAuthnClient,
} from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { Address, Hex, TransactionSerializableEIP1559 } from 'viem';
import {
  sendConfirmationTypedData,
  type SendConfirmation,
} from './send-confirmation.js';
import type {
  Asset,
  GrantApprovalChallenge,
  GrantDraft,
  GrantPreview,
  IdentityChallenge,
} from '@synq/schemas';
import { identityChallengeTypedData, meraPrincipalId } from './challenge.js';
import {
  approvalAttestationTypedData,
  assertDraftConsistent,
  challengeRequestTypedData,
  grantPreview,
  grantTypedData,
  previewsEqual,
} from './grant.js';
import {
  safeTransactionTypedData,
  type SafeGovernanceTransaction,
} from './safe-transaction.js';

export const MERA_DERIVATION = 'bip44-ethereum-0-v1' as const;
export type MeraCredential = {
  provider: 'mera';
  principalId: string;
  rpId: string;
  credential: PasskeyCredentialMetadata;
  signer: Address;
  derivation: typeof MERA_DERIVATION;
};
export type MeraOptions = { webAuthnClient?: WebAuthnClient; timeout?: number };
export type MeraAdapterErrorCode =
  | 'PRF_UNAVAILABLE'
  | 'PASSKEY_FAILED'
  | 'INSECURE_ORIGIN'
  | 'WRONG_CREDENTIAL'
  | 'SIGNER_MISMATCH'
  | 'CHALLENGE_MISMATCH'
  | 'PREVIEW_MISMATCH'
  | 'DIGEST_MISMATCH';
export class MeraAdapterError extends Error {
  constructor(
    readonly code: MeraAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MeraAdapterError';
  }
}

type MeraAccount = ReturnType<typeof toViemAccount>;
async function withAccount<T>(
  output: Uint8Array,
  use: (account: MeraAccount) => Promise<T>,
): Promise<T> {
  const seed = mnemonicToSeedSync(entropyToMnemonic(output, wordlist));
  output.fill(0);
  const master = HDKey.fromMasterSeed(seed);
  seed.fill(0);
  const node = master.derive("m/44'/60'/0'/0/0");
  master.wipePrivateData();
  if (!node.privateKey)
    throw new MeraAdapterError('PASSKEY_FAILED', 'derivation failed');
  const session = createSecp256k1SigningSession({
    privateKey: node.privateKey,
  });
  node.wipePrivateData();
  try {
    return await use(toViemAccount(session));
  } finally {
    session.end();
  }
}

function adapterError(error: unknown): never {
  if (error instanceof MeraAdapterError) throw error;
  if (isMeraError(error))
    throw new MeraAdapterError(
      error.code === 'PRF_UNAVAILABLE' ? 'PRF_UNAVAILABLE' : 'PASSKEY_FAILED',
      error.code,
    );
  throw new MeraAdapterError('PASSKEY_FAILED', 'passkey ceremony failed');
}

function assertOrigin(rpId: string, options: MeraOptions): void {
  if (options.webAuthnClient) return;
  if (
    typeof window === 'undefined' ||
    !window.isSecureContext ||
    window.location.hostname !== rpId
  )
    throw new MeraAdapterError(
      'INSECURE_ORIGIN',
      'Mera requires the configured secure browser origin',
    );
}

const ceremony = (options: MeraOptions) => ({
  ...(options.webAuthnClient ? { webAuthnClient: options.webAuthnClient } : {}),
  ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
});

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function deriveMeraSigner(
  prfOutput: Uint8Array,
): Promise<Address> {
  return withAccount(Uint8Array.from(prfOutput), async (a) => a.address);
}

export async function enrollMeraPrincipal(
  input: {
    rpId: string;
    rpName: string;
    user: { name: string; displayName: string };
    requestChallenge: (claim: {
      signer: Address;
      credential: PasskeyCredentialMetadata;
    }) => Promise<IdentityChallenge>;
  },
  options: MeraOptions = {},
): Promise<{
  record: MeraCredential;
  challenge: IdentityChallenge;
  signature: Hex;
}> {
  assertOrigin(input.rpId, options);
  const created = await createPasskeyWithPrfOutput({
    rp: { id: input.rpId, name: input.rpName },
    user: input.user,
    ...ceremony(options),
  }).catch(adapterError);
  const credential: PasskeyCredentialMetadata = {
    credentialId: created.credentialId,
    ...(created.transports ? { transports: created.transports } : {}),
  };
  return withAccount(created.prfOutput, async (account) => {
    const challenge = await input.requestChallenge({
      signer: account.address,
      credential,
    });
    if (
      challenge.purpose !== 'ENROLL' ||
      challenge.principalKind !== 'MERA_HUMAN' ||
      !same(challenge.signer, account.address) ||
      challenge.rpId !== input.rpId ||
      challenge.credentialId !== credential.credentialId ||
      challenge.principalId !== meraPrincipalId(account.address)
    )
      throw new MeraAdapterError(
        'CHALLENGE_MISMATCH',
        'enrollment challenge mismatch',
      );
    const signature = await account.signTypedData(
      identityChallengeTypedData(challenge),
    );
    return {
      record: {
        provider: 'mera',
        principalId: challenge.principalId,
        rpId: input.rpId,
        credential,
        signer: account.address.toLowerCase() as Address,
        derivation: MERA_DERIVATION,
      },
      challenge,
      signature,
    };
  });
}

export async function recoverMeraPrincipal(
  input: {
    rpId: string;
    credential?: PasskeyCredentialMetadata;
    requestChallenge: (claim: {
      signer: Address;
      principalId: string;
      credentialId: string;
    }) => Promise<IdentityChallenge>;
  },
  options: MeraOptions = {},
): Promise<{
  record: MeraCredential;
  challenge: IdentityChallenge;
  signature: Hex;
}> {
  assertOrigin(input.rpId, options);
  const asserted = await getPasskeyPrfOutput({
    rpId: input.rpId,
    ...(input.credential ? { credential: input.credential } : {}),
    ...ceremony(options),
  }).catch(adapterError);
  if (
    input.credential &&
    asserted.credentialId !== input.credential.credentialId
  ) {
    asserted.prfOutput.fill(0);
    throw new MeraAdapterError('WRONG_CREDENTIAL', 'unexpected passkey');
  }
  return withAccount(asserted.prfOutput, async (account) => {
    const principalId = meraPrincipalId(account.address);
    const challenge = await input.requestChallenge({
      signer: account.address,
      principalId,
      credentialId: asserted.credentialId,
    });
    if (
      challenge.purpose !== 'RECOVER' ||
      !same(challenge.signer, account.address) ||
      challenge.principalId !== principalId ||
      challenge.rpId !== input.rpId ||
      challenge.credentialId !== asserted.credentialId
    )
      throw new MeraAdapterError(
        'CHALLENGE_MISMATCH',
        'recovery challenge mismatch',
      );
    const signature = await account.signTypedData(
      identityChallengeTypedData(challenge),
    );
    return {
      record: {
        provider: 'mera',
        principalId,
        rpId: input.rpId,
        credential: { credentialId: asserted.credentialId },
        signer: account.address.toLowerCase() as Address,
        derivation: MERA_DERIVATION,
      },
      challenge,
      signature,
    };
  });
}

async function withRecordAccount<T>(
  record: MeraCredential,
  options: MeraOptions,
  use: (account: MeraAccount) => Promise<T>,
): Promise<T> {
  assertOrigin(record.rpId, options);
  const result = await getPasskeyPrfOutput({
    rpId: record.rpId,
    credential: record.credential,
    ...ceremony(options),
  }).catch(adapterError);
  if (result.credentialId !== record.credential.credentialId) {
    result.prfOutput.fill(0);
    throw new MeraAdapterError('WRONG_CREDENTIAL', 'unexpected passkey');
  }
  return withAccount(result.prfOutput, async (account) => {
    if (!same(account.address, record.signer))
      throw new MeraAdapterError(
        'SIGNER_MISMATCH',
        'passkey derives a different signer',
      );
    return use(account);
  });
}

export async function signMeraIdentityChallenge(
  record: MeraCredential,
  challenge: IdentityChallenge,
  options: MeraOptions = {},
): Promise<Hex> {
  if (
    !same(challenge.signer, record.signer) ||
    challenge.principalId !== record.principalId ||
    challenge.rpId !== record.rpId
  )
    throw new MeraAdapterError(
      'CHALLENGE_MISMATCH',
      'challenge is for another principal',
    );
  const typed = identityChallengeTypedData(challenge);
  return withRecordAccount(record, options, (account) =>
    account.signTypedData(typed),
  );
}

export type SignedChallengeRequest = {
  draftDigest: string;
  memberId: string;
  principalId: string;
  requestedAt: number;
  requestSignature: Hex;
};

export async function approveGrantWithMera(
  input: {
    record: MeraCredential;
    memberId: string;
    draft: GrantDraft;
    asset: Asset;
    confirmedPreview: GrantPreview;
    requestChallenge: (
      request: SignedChallengeRequest,
    ) => Promise<GrantApprovalChallenge>;
    now?: () => number;
  },
  options: MeraOptions = {},
): Promise<{
  challenge: GrantApprovalChallenge;
  grantSignature: Hex;
  attestationSignature: Hex;
}> {
  const { record } = input;
  let draft: GrantDraft, preview: GrantPreview;
  try {
    draft = assertDraftConsistent(input.draft);
    preview = grantPreview(draft, input.asset);
  } catch {
    throw new MeraAdapterError(
      'DIGEST_MISMATCH',
      'draft does not match its digest',
    );
  }
  if (!previewsEqual(preview, input.confirmedPreview))
    throw new MeraAdapterError(
      'PREVIEW_MISMATCH',
      'draft differs from the confirmed preview',
    );
  const grant = grantTypedData(draft);
  const requestedAt = (input.now ?? (() => Math.floor(Date.now() / 1000)))();
  return withRecordAccount(record, options, async (account) => {
    const request = {
      principalId: record.principalId,
      memberId: input.memberId,
      requestedAt,
    };
    const requestSignature = await account.signTypedData(
      challengeRequestTypedData(draft, request),
    );
    const challenge = await input.requestChallenge({
      ...request,
      draftDigest: draft.digest,
      requestSignature,
    });
    if (
      challenge.draftDigest !== draft.digest ||
      !same(challenge.signer, record.signer) ||
      challenge.principalId !== record.principalId ||
      challenge.memberId !== input.memberId ||
      challenge.groupId !== draft.groupId
    )
      throw new MeraAdapterError(
        'CHALLENGE_MISMATCH',
        'challenge does not bind this draft',
      );
    const grantSignature = await account.signTypedData(grant);
    const attestationSignature = await account.signTypedData(
      approvalAttestationTypedData(draft, challenge),
    );
    return { challenge, grantSignature, attestationSignature };
  });
}

/** Owner signature over a Safe governance transaction (SafeTx EIP-712), e.g. setExecutor or configureMandate. */
export async function signMeraSafeTransaction(
  record: MeraCredential,
  transaction: SafeGovernanceTransaction,
  options: MeraOptions = {},
): Promise<Hex> {
  const typed = safeTransactionTypedData(transaction);
  return withRecordAccount(record, options, (account) =>
    account.signTypedData(typed),
  );
}

/** Synq Send sender confirmation of the exact previewed recipient, amount, chain and expiry. */
export async function signMeraSendConfirmation(
  record: MeraCredential,
  confirmation: SendConfirmation,
  options: MeraOptions = {},
): Promise<Hex> {
  const typed = sendConfirmationTypedData(confirmation);
  return withRecordAccount(record, options, (account) =>
    account.signTypedData(typed),
  );
}

/**
 * The member's own wallet transaction (e.g. a direct AUSD contribution to the
 * group Safe). The passkey ceremony gates it; the chain id must be present.
 */
export async function signMeraTransaction(
  record: MeraCredential,
  transaction: TransactionSerializableEIP1559 & { chainId: number },
  options: MeraOptions = {},
): Promise<Hex> {
  if (!transaction.chainId)
    throw new MeraAdapterError('CHALLENGE_MISMATCH', 'chainId required');
  return withRecordAccount(record, options, (account) =>
    account.signTransaction({ ...transaction, type: 'eip1559' }),
  );
}
