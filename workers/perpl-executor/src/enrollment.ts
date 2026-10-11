import { hashTypedData, type Hex, type TypedDataDefinition } from 'viem';
import type { PerplNetworkConfig } from '@synq/chain-registry';
import {
  ApiKeyInfoSchema,
  EnrollPayloadSchema,
  SCOPE_MASK,
  type EnrollPayload,
  type FetchLike,
  type PerplScope,
} from '@synq/plugin-perpl';
import { ed25519Sign, generateEd25519, writePerplKey } from './keys.js';

export class EnrollmentError extends Error {
  constructor(
    readonly code:
      | 'PAYLOAD_REFUSED'
      | 'ENROLL_REFUSED'
      | 'ORIGIN_NOT_WHITELISTED'
      | 'INVALID_RESPONSE',
    readonly status: number | null,
    readonly body: string,
  ) {
    super(
      `${code}${status === null ? '' : ` (${status})`}: ${body.slice(0, 300)}`,
    );
    this.name = 'EnrollmentError';
  }
}

type Field = { name: string; type: string };

// EIP-712 values arrive as JSON (uint64 as hex strings, chainId as hex);
// convert by declared type so the digest matches the server's.
export function typedDataForSigning(
  payload: EnrollPayload,
): TypedDataDefinition {
  const td = payload.typed_data;
  const { EIP712Domain: domainFields, ...types } = td.types as Record<
    string,
    Field[]
  >;
  const convert = (
    fields: readonly Field[] | undefined,
    values: Record<string, unknown>,
  ) =>
    Object.fromEntries(
      Object.entries(values).map(([k, v]) => {
        const type = fields?.find((f) => f.name === k)?.type ?? '';
        return [
          k,
          /^u?int[0-9]*$/.test(type) &&
          (typeof v === 'string' || typeof v === 'number')
            ? BigInt(v)
            : v,
        ];
      }),
    );
  return {
    domain: convert(domainFields, td.domain),
    types,
    primaryType: td.primaryType,
    message: convert(types[td.primaryType], td.message),
  } as unknown as TypedDataDefinition;
}

export function popDigest(payload: EnrollPayload): Hex {
  return hashTypedData(typedDataForSigning(payload));
}

const isOriginRefusal = (status: number, body: string) =>
  (status === 403 || status === 400 || status === 401) && /origin/i.test(body);

// Programmatic enrollment exactly as documented: payload, wallet EIP-712
// signature, Ed25519 proof of possession over the same digest, enroll. No
// Origin header is forged; a whitelist refusal is surfaced to the caller.
export async function enrollApiKey(input: {
  network: PerplNetworkConfig;
  address: `0x${string}`;
  scope: PerplScope;
  label: string;
  signTypedData: (definition: TypedDataDefinition) => Promise<Hex>;
  keyPath: string;
  fetch?: FetchLike;
  now?: () => Date;
}) {
  const fetcher = input.fetch ?? (fetch as unknown as FetchLike);
  const { key, seed, publicKey } = generateEd25519();
  const publicKeyHex = `0x${Buffer.from(publicKey).toString('hex')}` as const;
  const post = async (path: string, body: unknown) => {
    const res = await fetcher(`${input.network.restUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, text: await res.text() };
  };
  const payloadRes = await post('/v1/api-key/payload', {
    chain_id: input.network.chainId,
    address: input.address,
    public_key: publicKeyHex,
    scope_mask: SCOPE_MASK[input.scope],
    label: input.label,
  });
  if (payloadRes.status !== 200)
    throw new EnrollmentError(
      isOriginRefusal(payloadRes.status, payloadRes.text)
        ? 'ORIGIN_NOT_WHITELISTED'
        : 'PAYLOAD_REFUSED',
      payloadRes.status,
      payloadRes.text,
    );
  const parsed = EnrollPayloadSchema.safeParse(JSON.parse(payloadRes.text));
  if (!parsed.success)
    throw new EnrollmentError('INVALID_RESPONSE', 200, payloadRes.text);
  const payload = parsed.data;
  const signature = await input.signTypedData(typedDataForSigning(payload));
  const digest = popDigest(payload);
  const pop = ed25519Sign(key, Buffer.from(digest.slice(2), 'hex'));
  const enrollRes = await post('/v1/api-key/enroll', {
    chain_id: input.network.chainId,
    address: input.address,
    typed_data: payload.typed_data,
    mac: payload.mac,
    signature,
    pop_signature: `0x${Buffer.from(pop).toString('hex')}`,
  });
  if (enrollRes.status !== 200)
    throw new EnrollmentError(
      isOriginRefusal(enrollRes.status, enrollRes.text)
        ? 'ORIGIN_NOT_WHITELISTED'
        : 'ENROLL_REFUSED',
      enrollRes.status,
      enrollRes.text,
    );
  const info = ApiKeyInfoSchema.safeParse(
    (JSON.parse(enrollRes.text) as { api_key?: unknown }).api_key,
  );
  if (!info.success)
    throw new EnrollmentError(
      'INVALID_RESPONSE',
      200,
      'enroll response without api_key',
    );
  writePerplKey(input.keyPath, {
    schemaVersion: 1,
    apiKey: info.data.api_key,
    privateKey: Buffer.from(seed).toString('hex'),
    publicKey: publicKeyHex,
    scope: input.scope,
    chainId: input.network.chainId,
    address: input.address,
    label: input.label,
    ...(info.data.origin !== undefined ? { origin: info.data.origin } : {}),
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  return {
    scopeMask: info.data.scope_mask,
    origin: info.data.origin ?? null,
    label: info.data.label,
    publicKey: publicKeyHex,
  };
}
