import { MemorySplitStore } from '@synq/allocations';
import { criticScenarios } from './critic-scenarios.js';

criticScenarios('memory', async () => new MemorySplitStore());
