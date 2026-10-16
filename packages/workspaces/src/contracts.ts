import { getAddress, isAddress, zeroAddress } from 'viem';
import { z } from 'zod';

export const ARC_WORKSPACE_CHAIN = 5042002;
export const WalletSchema = z
  .string()
  .refine(
    (s) => isAddress(s) && s.toLowerCase() !== zeroAddress && BigInt(s) > 1n,
  )
  .transform((s) => getAddress(s));
export const WorkspaceIdSchema = z.string().uuid();
export const RoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
export const CreateWorkspaceSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(80),
  kind: z.enum(['PERSONAL', 'GROUP', 'BUSINESS']),
});
export const InviteSchema = z.strictObject({
  role: RoleSchema,
  expiresIn: z.number().int().min(60).max(86400).default(3600),
});
export const LoginSchema = z.strictObject({
  wallet: WalletSchema,
  audience: z.enum(['web', 'native']).default('web'),
});
export const CompleteLoginSchema = z.strictObject({
  challengeId: z.string().uuid(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export const AcceptInviteSchema = z.strictObject({
  token: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Role = z.infer<typeof RoleSchema>;
export type Workspace = {
  id: string;
  displayName: string;
  kind: 'PERSONAL' | 'GROUP' | 'BUSINESS';
  createdBy: string;
  chainId: typeof ARC_WORKSPACE_CHAIN;
  status: 'FORMING' | 'LAUNCHING' | 'ACTIVE';
  vault: string | null;
  threshold: number | null;
};
export type Member = {
  principalId: string;
  wallet: string;
  role: Role;
  joinedAt: number;
};
export const WorkspaceSchema = z.strictObject({
  id: WorkspaceIdSchema,
  displayName: z.string(),
  kind: z.enum(['PERSONAL', 'GROUP', 'BUSINESS']),
  createdBy: z.string(),
  chainId: z.literal(ARC_WORKSPACE_CHAIN),
  status: z.enum(['FORMING', 'LAUNCHING', 'ACTIVE']),
  vault: z.string().nullable(),
  threshold: z.number().int().positive().nullable(),
});
export const WorkspaceListSchema = z.strictObject({
  workspaces: z.array(WorkspaceSchema),
});
export const WorkspaceViewSchema = z.strictObject({
  workspace: WorkspaceSchema,
  members: z.array(
    z.strictObject({
      principalId: z.string(),
      role: RoleSchema,
      joinedAt: z.number(),
      walletHint: z.string(),
    }),
  ),
});
export function workspaceView(view: {
  workspace: Workspace;
  members: Member[];
}) {
  return WorkspaceViewSchema.parse({
    ...view,
    members: view.members.map(({ wallet, ...m }) => ({
      ...m,
      walletHint: `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
    })),
  });
}
export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}
export function defaultThreshold(owners: number) {
  if (!Number.isInteger(owners) || owners < 1 || owners > 20)
    throw new WorkspaceError('INVALID_OWNERS', 400);
  return Math.min(owners, 3, Math.ceil(owners / 2) + 1);
}
export type LoginChallenge = {
  id: string;
  wallet: string;
  origin: string;
  audience: 'web' | 'native';
  nonce: string;
  expiresAt: number;
};
export function loginTypedData(c: LoginChallenge) {
  return {
    domain: {
      name: 'Synq Workspace Login',
      version: '1',
      chainId: ARC_WORKSPACE_CHAIN,
    },
    types: {
      WorkspaceLogin: [
        { name: 'challengeId', type: 'string' },
        { name: 'wallet', type: 'address' },
        { name: 'origin', type: 'string' },
        { name: 'audience', type: 'string' },
        { name: 'nonce', type: 'string' },
        { name: 'expiresAt', type: 'uint64' },
        { name: 'statement', type: 'string' },
      ],
    },
    primaryType: 'WorkspaceLogin',
    message: {
      challengeId: c.id,
      wallet: c.wallet,
      origin: c.origin,
      audience: c.audience,
      nonce: c.nonce,
      expiresAt: String(c.expiresAt),
      statement:
        'Sign in to Synq on Arc testnet. This signature does not approve payments or vault setup.',
    },
  } as const;
}
