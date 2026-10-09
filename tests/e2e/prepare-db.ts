import pg from 'pg';
import { PostgresIdentityStore } from '@synq/identity/server';

import { E2E_DATABASE_URL } from './env.js';

export async function prepareDatabase(url = E2E_DATABASE_URL): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*e2e[a-z0-9_]*$/.test(name))
    throw new Error(
      'refusing to reset a database whose name does not contain e2e',
    );
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [name],
    );
    if (!exists.rows.length) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    await new PostgresIdentityStore(pool).migrate();
    await pool.query(
      'TRUNCATE identity_verified_approval,identity_grant_challenge,identity_grant_draft,identity_delegation_usage,identity_delegation_policy,identity_membership,identity_group,identity_challenge,identity_idempotency,identity_principal RESTART IDENTITY CASCADE',
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('prepare-db.ts')) await prepareDatabase();
