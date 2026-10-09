import { MemoryProjectionStore } from '../../packages/read-model/src/index.js';
import { chainId } from './fixtures.js';
import { projectionScenarios } from './scenarios.js';

projectionScenarios('memory', async () => new MemoryProjectionStore(chainId));
