import { MemoryIdentityStore } from '../../packages/identity/src/server.js';
import { identityContract } from './identity-contract.js';

let current = new MemoryIdentityStore();
identityContract('identity services on the in-memory store (unit tier)', {
  fresh: async () => (current = new MemoryIdentityStore()),
  reopen: async () => current,
});
