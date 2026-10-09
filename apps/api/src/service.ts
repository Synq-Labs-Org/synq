import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  AddressSchema,
  HashSchema,
  IdSchema,
  TimestampSchema,
} from '@synq/schemas';
import { DeploymentManifestSchema } from '@synq/chain-registry';
import { ChainEventSchema, DeterministicReadModel } from '@synq/read-model';
const ProofSchema = z.object({
  manifest: DeploymentManifestSchema,
  localTestToken: AddressSchema,
  bindings: z
    .array(
      z.strictObject({
        groupId: HashSchema,
        account: AddressSchema,
        registry: AddressSchema,
        module: AddressSchema,
        members: z.array(
          z.strictObject({ memberId: IdSchema, signer: AddressSchema }),
        ),
      }),
    )
    .min(1),
  events: z.array(ChainEventSchema),
  checkpoint: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  snapshot: z.object({ generatedAt: TimestampSchema }),
});
export class ProofQueryService {
  constructor(private readonly artifactPath: string) {}
  private async proof() {
    const raw: unknown = JSON.parse(await readFile(this.artifactPath, 'utf8'));
    return ProofSchema.parse(raw);
  }
  async groups() {
    return (await this.proof()).bindings.map((binding) => ({
      groupId: binding.groupId,
      account: binding.account,
    }));
  }
  async state(groupId: string) {
    const proof = await this.proof();
    const projection = new DeterministicReadModel(
      proof.manifest.network.chainId,
      proof.localTestToken,
      proof.bindings,
    );
    projection.rebuild(proof.events, proof.checkpoint);
    return {
      state: projection.snapshot(
        groupId,
        proof.checkpoint,
        proof.snapshot.generatedAt,
      ),
      proofSource: 'local-chain-event-artifact',
      currentHeadVerified: false,
    };
  }
}
