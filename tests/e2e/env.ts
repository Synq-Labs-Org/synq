export const E2E_ADMIN_TOKEN = 'e2e-admin-token-local-only-0123456789abcdef';
import { testDatabaseUrl } from '../durable/pg.js';
export const API = 'http://127.0.0.1:3201';
export const WEB = 'http://localhost:3101';
export const E2E_DATABASE_URL = testDatabaseUrl(
  'SYNQ_E2E_DATABASE_URL',
  'synq_identity_e2e',
);
