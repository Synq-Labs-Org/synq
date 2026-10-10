import { MemoryProjectionStore } from '@synq/read-model';
import { chainId } from '../read-model/fixtures.js';
import { treasuryScenarios } from './scenarios.js';

treasuryScenarios('memory', async () => new MemoryProjectionStore(chainId));
