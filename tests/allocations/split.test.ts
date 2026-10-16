import { MemorySplitStore } from '@synq/allocations';
import { splitScenarios } from './split-scenarios.js';

splitScenarios('memory', async () => new MemorySplitStore());
