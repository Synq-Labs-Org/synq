import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EnvVaultKeyProvider,
  GiftCodeVault,
  HmacHumanProofVerifier,
  MemoryProfileStore,
  MerchantAuthBroker,
  ProfileDecryptor,
  ProfileDirectory,
  redact,
  redactDeep,
} from '@synq/profile-vault';

let t = 1_780_000_000;
const now = () => t;
const KEY = Buffer.alloc(32, 7).toString('base64');
const keys = new EnvVaultKeyProvider({ SYNQ_PROFILE_VAULT_KEY: KEY });
const address = {
  name: 'Jane Doe',
  line1: '221B Baker Street',
  city: 'London',
  postalCode: 'NW1 6XE',
  country: 'GB',
  email: 'jane@example.com',
};
const traveler = {
  givenName: 'Ada',
  familyName: 'Lovelace',
  bornOn: '1990-01-01',
  email: 'ada@example.com',
  phone: '+442080160509',
  passportNumber: 'X12345678',
};

describe('ProfileVault', () => {
  it('PROFILE-001 stores ciphertext at rest; the agent sees only an opaque ref and redacted summary', async () => {
    const store = new MemoryProfileStore();
    const dir = new ProfileDirectory(store, keys, now);
    const { ref, summary } = await dir.put({
      groupId: 'g1',
      kind: 'SHIPPING',
      data: address,
    });
    expect(ref).toMatch(/^pv_[0-9a-f]{32}$/);
    expect(summary).not.toMatch(/Baker|Jane|NW1|jane@/);
    const raw = JSON.stringify([...store.records.values()]);
    for (const secret of ['Baker', 'Jane', 'NW1 6XE', 'jane@example.com'])
      expect(raw).not.toContain(secret);
    expect(await dir.summary('g2', ref)).toBeNull();
  });
  it('PROFILE-004/PROFILE-002 the worker decrypts only requested fields and audits every access', async () => {
    const store = new MemoryProfileStore();
    const dir = new ProfileDirectory(store, keys, now);
    const { ref } = await dir.put({
      groupId: 'g1',
      kind: 'TRAVELER',
      data: traveler,
    });
    const worker = new ProfileDecryptor(store, keys, now, 'execution-worker-1');
    const got = await worker.resolve({
      groupId: 'g1',
      ref,
      kind: 'TRAVELER',
      purpose: 'booking:b1',
      fields: ['givenName', 'familyName', 'bornOn'],
    });
    expect(got).toEqual({
      givenName: 'Ada',
      familyName: 'Lovelace',
      bornOn: '1990-01-01',
    });
    expect(JSON.stringify(got)).not.toContain('X12345678');
    expect(worker.audit).toEqual([
      expect.objectContaining({
        ref,
        outcome: 'GRANTED',
        purpose: 'booking:b1',
        fields: ['givenName', 'familyName', 'bornOn'],
        worker: 'execution-worker-1',
      }),
    ]);
  });
  it('PROFILE-005 wrong group, wrong kind, unknown field and tampering are denied and audited', async () => {
    const store = new MemoryProfileStore();
    const dir = new ProfileDirectory(store, keys, now);
    const { ref } = await dir.put({
      groupId: 'g1',
      kind: 'TRAVELER',
      data: traveler,
    });
    const worker = new ProfileDecryptor(store, keys, now, 'w');
    await expect(
      worker.resolve({
        groupId: 'g2',
        ref,
        kind: 'TRAVELER',
        purpose: 'x',
        fields: ['givenName'],
      }),
    ).rejects.toThrow(/WRONG_GROUP/);
    await expect(
      worker.resolve({
        groupId: 'g1',
        ref,
        kind: 'SHIPPING',
        purpose: 'x',
        fields: ['name'],
      }),
    ).rejects.toThrow(/FIELD_NOT_ALLOWED/);
    await expect(
      worker.resolve({
        groupId: 'g1',
        ref,
        kind: 'TRAVELER',
        purpose: 'x',
        fields: ['cardNumber' as never],
      }),
    ).rejects.toThrow(/FIELD_NOT_ALLOWED/);
    const rec = store.records.get(ref)!;
    store.records.set(ref, {
      ...rec,
      groupId: 'g1',
      ciphertext: Buffer.from('tampered').toString('base64'),
    });
    await expect(
      worker.resolve({
        groupId: 'g1',
        ref,
        kind: 'TRAVELER',
        purpose: 'x',
        fields: ['givenName'],
      }),
    ).rejects.toThrow(/TAMPERED/);
    const moved = { ...rec, ref: 'pv_moved', groupId: 'g2' };
    store.records.set('pv_moved', moved);
    await expect(
      worker.resolve({
        groupId: 'g2',
        ref: 'pv_moved',
        kind: 'TRAVELER',
        purpose: 'x',
        fields: ['givenName'],
      }),
    ).rejects.toThrow(/TAMPERED/);
    expect(worker.audit.filter((a) => a.outcome === 'DENIED')).toHaveLength(5);
  });
  it('PROFILE-003 guest recipient records expire', async () => {
    const store = new MemoryProfileStore();
    const dir = new ProfileDirectory(store, keys, now);
    const { ref } = await dir.put({
      groupId: 'g1',
      kind: 'RECIPIENT',
      data: address,
      expiresAt: t + 60,
    });
    const worker = new ProfileDecryptor(store, keys, now, 'w');
    await worker.resolve({
      groupId: 'g1',
      ref,
      kind: 'RECIPIENT',
      purpose: 'gift',
      fields: ['line1'],
    });
    t += 61;
    await expect(
      worker.resolve({
        groupId: 'g1',
        ref,
        kind: 'RECIPIENT',
        purpose: 'gift',
        fields: ['line1'],
      }),
    ).rejects.toThrow(/EXPIRED/);
    expect((await dir.summary('g1', ref))?.expired).toBe(true);
  });
  it('rejects malformed keys and invalid profiles', async () => {
    expect(
      () => new EnvVaultKeyProvider({ SYNQ_PROFILE_VAULT_KEY: 'short' }),
    ).toThrow(/KEY_INVALID/);
    const dir = new ProfileDirectory(new MemoryProfileStore(), keys, now);
    await expect(
      dir.put({
        groupId: 'g',
        kind: 'TRAVELER',
        data: { ...traveler, bornOn: 'yesterday' },
      }),
    ).rejects.toThrow(/INVALID_PROFILE/);
  });
});

describe('redaction (CARD-001/CARD-002/FLT-006/AUTH-004)', () => {
  it('removes PAN, CVC, passport, contacts, provider tokens and cookies', () => {
    const trace =
      'pay 4111 1111 1111 1111 cvv: 123 passport no X12345678 mail ada@example.com call +44 20 8016 0509 token duffel_test_abcDEF123 Cookie: session=abc; Authorization: Bearer abcdefghijklmnopqrstu';
    const out = redact(trace);
    for (const leak of [
      '4111',
      '123 ',
      'X12345678',
      'ada@example.com',
      '8016',
      'duffel_test_abc',
      'session=abc',
      'abcdefghijklmnop',
    ])
      expect(out).not.toContain(leak);
    expect(redact('order 1234567890123 total 12')).toContain('1234567890123');
    expect(redactDeep({ a: ['card 4242424242424242'] })).toEqual({
      a: ['card [PAN]'],
    });
  });
});

describe('MerchantAuthBroker', () => {
  const verifier = new HmacHumanProofVerifier(new Uint8Array(32).fill(9));
  const humans = { isEligibleHuman: (p: string) => p.startsWith('human:') };
  it('AUTH-003 exposes only session state to the Brain', () => {
    const b = new MerchantAuthBroker(verifier, now, humans);
    expect(b.state('g', 'amazon.com')).toBe('NONE');
    b.storeSession({
      groupId: 'g',
      merchant: 'amazon.com',
      vaultRef: 'pv_x',
      expiresAt: t + 10,
    });
    expect(b.state('g', 'amazon.com')).toBe('AUTHENTICATED');
    b.markStepUpRequired('g', 'amazon.com');
    expect(b.state('g', 'amazon.com')).toBe('STEP_UP_REQUIRED');
    t += 11;
    expect(b.state('g', 'amazon.com')).toBe('EXPIRED');
  });
  it('AUTH-002 automated or wrong-principal completion is refused; proofs are single use', async () => {
    const b = new MerchantAuthBroker(verifier, now, humans);
    expect(() =>
      b.open({ kind: 'OTP', principalId: 'agent:brain', ttlSeconds: 60 }),
    ).toThrow(/NOT_HUMAN/);
    const c = b.open({
      kind: 'THREE_DS',
      principalId: 'human:alice',
      ttlSeconds: 60,
    });
    expect(
      await b.complete(c, {
        challengeId: c.challengeId,
        principalId: 'human:alice',
        proof: '0'.repeat(64),
      }),
    ).toBe(false);
    expect(
      await b.complete(c, {
        challengeId: c.challengeId,
        principalId: 'human:bob',
        proof: verifier.issue(c, 'human:bob'),
      }),
    ).toBe(false);
    expect(
      await b.complete(c, {
        challengeId: c.challengeId,
        principalId: 'agent:brain',
        proof: verifier.issue(c, 'agent:brain'),
      }),
    ).toBe(false);
    const proof = verifier.issue(c, 'human:alice');
    expect(
      await b.complete(c, {
        challengeId: c.challengeId,
        principalId: 'human:alice',
        proof,
      }),
    ).toBe(true);
    expect(
      await b.complete(c, {
        challengeId: c.challengeId,
        principalId: 'human:alice',
        proof,
      }),
    ).toBe(false);
    expect(b.events.map((e) => e.event)).toEqual([
      'OPENED',
      'REJECTED:BAD_PROOF',
      'REJECTED:WRONG_PRINCIPAL',
      'REJECTED:WRONG_PRINCIPAL',
      'COMPLETED',
      'REJECTED:REPLAY',
    ]);
  });
  it('expired challenges cannot be completed', async () => {
    const b = new MerchantAuthBroker(verifier, now, humans);
    const c = b.open({
      kind: 'OTP',
      principalId: 'human:alice',
      ttlSeconds: 30,
    });
    t += 31;
    expect(
      await b.complete(c, {
        challengeId: c.challengeId,
        principalId: 'human:alice',
        proof: verifier.issue(c, 'human:alice'),
      }),
    ).toBe(false);
  });
});

describe('gift code recipient binding (N4)', () => {
  const codes = [{ cardNumber: 'GC-0001', pinCode: '1234' }];
  const tagOf = (ref: string) =>
    `r:${createHash('sha256').update(ref).digest('hex').slice(0, 16)}`;
  async function sealed() {
    const store = new MemoryProfileStore();
    const dir = new ProfileDirectory(store, keys, now);
    const ann = (
      await dir.put({ groupId: 'g1', kind: 'RECIPIENT', data: address })
    ).ref;
    const ben = (
      await dir.put({
        groupId: 'g1',
        kind: 'RECIPIENT',
        data: { ...address, name: 'Ben Doe' },
      })
    ).ref;
    const vault = new GiftCodeVault(store, keys, now);
    const seal = (recipientRef: string) =>
      vault.seal({
        provider: 'reloadly',
        transactionId: 'tx-1',
        groupId: 'g1',
        recipientRef,
        codes,
      });
    const { ref } = await seal(ann);
    const worker = new ProfileDecryptor(store, keys, now, 'delivery-worker');
    const open = () =>
      worker.resolve({
        groupId: 'g1',
        ref,
        kind: 'GIFT_CODE',
        purpose: 'deliver',
        fields: ['recipientRef'],
      });
    return { store, ann, ben, ref, seal, open };
  }

  it('authenticates the recipient tag: editing or stripping it makes the record tampered', async () => {
    const w = await sealed();
    const record = w.store.records.get(w.ref)!;
    expect(record.binding).toBe(tagOf(w.ann));
    expect(record.summary.endsWith(record.binding!)).toBe(true);
    expect(await w.open()).toEqual({ recipientRef: w.ann });
    const original = structuredClone(record);
    w.store.records.set(w.ref, { ...original, binding: tagOf(w.ben) });
    await expect(w.open()).rejects.toThrow(/TAMPERED/);
    await expect(w.seal(w.ben)).rejects.toThrow(/TAMPERED/);
    const { binding: _drop, ...stripped } = original;
    w.store.records.set(w.ref, stripped);
    await expect(w.open()).rejects.toThrow(/TAMPERED/);
    w.store.records.set(w.ref, original);
    expect(await w.open()).toEqual({ recipientRef: w.ann });
  });

  it('a rewritten summary cannot re-bind a sealed transaction to another recipient', async () => {
    const w = await sealed();
    const record = w.store.records.get(w.ref)!;
    w.store.records.set(w.ref, {
      ...record,
      summary: record.summary.replace(record.binding!, tagOf(w.ben)),
    });
    await expect(w.seal(w.ben)).rejects.toThrow(/TAMPERED/);
    expect(await w.seal(w.ann)).toEqual({ ref: w.ref });
  });

  it('records sealed before the binding existed stay readable', async () => {
    const w = await sealed();
    const ref = `gc_${'a'.repeat(40)}`;
    const keyId = keys.activeKeyId;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await keys.dataKey(keyId), iv);
    cipher.setAAD(Buffer.from(JSON.stringify([ref, 'g1', 'GIFT_CODE', keyId])));
    const plain = {
      provider: 'reloadly',
      transactionId: 'tx-legacy',
      recipientRef: w.ann,
      codes,
    };
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(plain), 'utf8'),
      cipher.final(),
    ]);
    await w.store.put({
      ref,
      groupId: 'g1',
      kind: 'GIFT_CODE',
      keyId,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      summary: `gift code · reloadly · 1 card(s) · ${tagOf(w.ann)}`,
      expiresAt: null,
      createdAt: now(),
    });
    const worker = new ProfileDecryptor(w.store, keys, now, 'delivery-worker');
    expect(
      await worker.resolve({
        groupId: 'g1',
        ref,
        kind: 'GIFT_CODE',
        purpose: 'deliver',
        fields: ['recipientRef', 'transactionId'],
      }),
    ).toEqual({ recipientRef: w.ann, transactionId: 'tx-legacy' });
    // A legacy record that gains a forged binding no longer authenticates.
    w.store.records.set(ref, {
      ...w.store.records.get(ref)!,
      binding: tagOf(w.ann),
    });
    await expect(
      worker.resolve({
        groupId: 'g1',
        ref,
        kind: 'GIFT_CODE',
        purpose: 'deliver',
        fields: ['recipientRef'],
      }),
    ).rejects.toThrow(/TAMPERED/);
  });
});
