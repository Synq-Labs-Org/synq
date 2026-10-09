import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FreshnessSchema,
  GroupSnapshotSchema,
  ReadModelError,
  assessFreshness,
  type ChainHeadObserver,
  type Hex,
  type SnapshotSource,
} from '@synq/read-model';

export interface ReadModelRouteDeps {
  snapshots: SnapshotSource;
  head: ChainHeadObserver;
  maxLagBlocks: number;
}
const GroupParamsSchema = z.strictObject({
  groupId: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((x) => x.toLowerCase() as Hex),
});
export const WorldSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceChainId: z.number().int().positive(),
  profile: z.string(),
  indexedThroughBlock: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  freshness: FreshnessSchema,
  frozenGroups: z.array(z.string()),
  groups: z.array(
    z.strictObject({
      groupId: z.string(),
      account: z.string(),
      accountingStatus: z.enum(['OPEN', 'FROZEN']),
    }),
  ),
});
export const GroupStateResponseSchema = z.strictObject({
  snapshot: GroupSnapshotSchema,
  freshness: FreshnessSchema,
});

export async function readModelRoutes(
  api: FastifyInstance,
  deps: ReadModelRouteDeps,
): Promise<void> {
  api.get('/v1/world', async () => {
    const [progress, head] = await Promise.all([
      deps.snapshots.progress(),
      deps.head.head(),
    ]);
    return WorldSnapshotSchema.parse({
      schemaVersion: 1,
      sourceChainId: progress.sourceChainId,
      profile: progress.profile,
      indexedThroughBlock: progress.indexedThroughBlock,
      generation: progress.generation,
      freshness: assessFreshness({
        sourceChainId: progress.sourceChainId,
        indexedThroughBlock: progress.indexedThroughBlock,
        head,
        maxLagBlocks: deps.maxLagBlocks,
        frozen: false,
      }),
      frozenGroups: progress.frozenGroups,
      groups: progress.groups.map((g) => ({
        groupId: g.groupId,
        account: g.account,
        accountingStatus: g.accountingStatus,
      })),
    });
  });
  api.get('/v1/groups/:groupId/state', async (request, reply) => {
    const { groupId } = GroupParamsSchema.parse(request.params);
    const [snapshot, head] = await Promise.all([
      deps.snapshots.groupSnapshot(groupId),
      deps.head.head(),
    ]);
    if (!snapshot) {
      reply.code(404);
      return { error: 'GROUP_NOT_FOUND' };
    }
    return GroupStateResponseSchema.parse({
      snapshot,
      freshness: assessFreshness({
        sourceChainId: snapshot.sourceChainId,
        indexedThroughBlock: snapshot.indexedThroughBlock,
        head,
        maxLagBlocks: deps.maxLagBlocks,
        frozen: snapshot.group.accountingStatus === 'FROZEN',
      }),
    });
  });
}

export function readModelErrorStatus(error: unknown): number | null {
  if (!(error instanceof ReadModelError)) return null;
  return error.code === 'NOT_FOUND' ? 404 : 503;
}
