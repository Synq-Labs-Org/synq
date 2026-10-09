import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  createSecp256k1SigningSession,
  type PasskeyCredentialMetadata,
} from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { Address, Hex, TypedDataDefinition } from 'viem';

export type MeraCredential = {
  provider: 'mera';
  rpId: string;
  credential: PasskeyCredentialMetadata;
  signer: Address;
  derivation: 'bip44-ethereum-0-v1';
};

function withAccount<T>(
  output: Uint8Array,
  use: (account: ReturnType<typeof toViemAccount>) => Promise<T>,
): Promise<T> {
  const seed = mnemonicToSeedSync(entropyToMnemonic(output, wordlist));
  const master = HDKey.fromMasterSeed(seed);
  const node = master.derive("m/44'/60'/0'/0/0");
  seed.fill(0);
  output.fill(0);
  if (!node.privateKey) throw new Error('Mera derivation failed');
  const session = createSecp256k1SigningSession({
    privateKey: node.privateKey,
  });
  master.wipePrivateData();
  node.wipePrivateData();
  return use(toViemAccount(session)).finally(() => session.end());
}

export async function enrollMera(
  rpId: string,
  user: { name: string; displayName: string },
): Promise<MeraCredential> {
  assertBrowser(rpId);
  const result = await createPasskeyWithPrfOutput({
    rp: { id: rpId, name: 'Synq' },
    user,
  });
  return withAccount(result.prfOutput, async (account) => ({
    provider: 'mera',
    rpId,
    credential: {
      credentialId: result.credentialId,
      transports: result.transports,
    },
    signer: account.address,
    derivation: 'bip44-ethereum-0-v1',
  }));
}

export async function signMeraApproval(
  record: MeraCredential,
  typedData: TypedDataDefinition,
): Promise<Hex> {
  assertBrowser(record.rpId);
  const result = await getPasskeyPrfOutput({
    rpId: record.rpId,
    credential: record.credential,
  });
  if (result.credentialId !== record.credential.credentialId) {
    result.prfOutput.fill(0);
    throw new Error('Wrong Mera credential');
  }
  return withAccount(result.prfOutput, async (account) => {
    if (account.address.toLowerCase() !== record.signer.toLowerCase())
      throw new Error('Recovered signer mismatch');
    return account.signTypedData(typedData);
  });
}

function assertBrowser(rpId: string): void {
  if (
    typeof window === 'undefined' ||
    !window.isSecureContext ||
    window.location.hostname !== rpId
  )
    throw new Error('Mera requires the configured secure browser origin');
}
