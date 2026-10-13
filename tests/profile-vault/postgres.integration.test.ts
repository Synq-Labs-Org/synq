import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  EnvVaultKeyProvider,
  GiftCodeVault,
  PostgresProfileStore,
  ProfileDecryptor,
  ProfileDirectory,
} from '@synq/profile-vault';
import { ensureP08Database } from '../treasury/pg.js';

const now = () => 1_790_000_000;
const keys = new EnvVaultKeyProvider({
  SYNQ_PROFILE_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'),
});
const address = {
  name: 'Jane Doe',
  line1: '221B Baker Street',
  city: 'London',
  postalCode: 'NW1 6XE',
  country: 'GB',
  email: 'jane@example.com',
};
let pool: pg.Pool;
const schemas: string[] = [];
beforeAll(async () => {
  pool = await ensureP08Database(
    process.env.SYNQ_P11_TEST_DATABASE_URL ??
      'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p08_p11',
  );
});
afterAll(async () => {
  for (const s of schemas)
    await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await pool.end();
});

describe('postgres profile store', () => {
  it('PV-PG-001 persists the gift code recipient binding so sealed codes open and stay tamper-evident', async () => {
    const schema = `pv_${process.pid}`;
    schemas.push(schema);
    const store = new PostgresProfileStore(pool, schema);
    await store.migrate();
    await store.migrate();
    const dir = new ProfileDirectory(store, keys, now);
    const ann = (
      await dir.put({ groupId: 'g1', kind: 'RECIPIENT', data: address })
    ).ref;
    const ben = (
      await dir.put({
        groupId: 'g1',
        kind: 'RECIPIENT',
        data: { ...address, name: 'John Doe' },
      })
    ).ref;
    const vault = new GiftCodeVault(store, keys, now);
    const seal = (recipientRef: string) =>
      vault.seal({
        provider: 'reloadly',
        transactionId: 'tx-1',
        groupId: 'g1',
        recipientRef,
        codes: [{ cardNumber: 'GC-0001', pinCode: '1234' }],
      });
    const { ref } = await seal(ann);
    expect((await store.get(ref))?.binding).toMatch(/^r:[0-9a-f]{16}$/);
    expect((await store.get(ann))?.binding).toBeUndefined();
    const open = () =>
      new ProfileDecryptor(store, keys, now, 'delivery-worker').resolve({
        groupId: 'g1',
        ref,
        kind: 'GIFT_CODE',
        purpose: 'deliver',
        fields: ['recipientRef'],
      });
    expect(await open()).toEqual({ recipientRef: ann });
    expect(await seal(ann)).toEqual({ ref });
    await expect(seal(ben)).rejects.toThrow(/TAMPERED/);
    await pool.query(
      `UPDATE "${schema}".synq_profile_vault SET binding = NULL WHERE ref = $1`,
      [ref],
    );
    await expect(open()).rejects.toThrow(/TAMPERED/);
  });
});
