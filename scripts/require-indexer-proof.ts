import { existsSync } from 'node:fs';
if (
  !process.env.SYNQ_ENVIO_PROOF_ARTIFACT ||
  !existsSync(process.env.SYNQ_ENVIO_PROOF_ARTIFACT)
) {
  console.error(
    'Live indexer tests require SYNQ_ENVIO_PROOF_ARTIFACT pointing to the current Anvil demonstration artifact and a running Envio instance. See docs/development/RUNBOOK.md.',
  );
  process.exitCode = 1;
}
