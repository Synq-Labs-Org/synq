import { expect, it } from 'vitest';
import { runCrossPhaseDemo } from '../../scripts/cross-phase-demo.js';

it('§71 connects Brain evidence, governed approval, Kernel, Temporal, accounting, risk pause and a refreshed WorldSnapshot', async () => {
  const result = await runCrossPhaseDemo();
  expect(result).toMatchObject({
    executionMode: 'SIMULATION',
    unauthorizedMutations: 0,
    authorizedLocalTokenTransfers: 1,
    mainnetBroadcasts: 0,
    finalBalance: '275000000000000000000',
  });
  expect(result.stages.every((s) => s.executionMode === 'SIMULATION')).toBe(
    true,
  );
  expect(result.stages.map((s) => s.stage)).toEqual(
    expect.arrayContaining([
      'WorldSnapshot',
      'Brain → typed Mandate → EvidenceArtifact',
      'Safe owner approval → registry governance',
      'weekly cap',
      'Kuru quote → bounded prepare',
      'Perpl risk → bounded conditional hedge',
      'CRE unhealthy → pause',
      'WorldSnapshot update',
    ]),
  );
}, 180000);
