import { describe, expect, it } from 'vitest';
import { fixture, CHAT_A } from '../channels/harness.js';

describe('G2 channel onboarding entry', () => {
  it('offers a public wallet sign-in link without binding a group or granting authority', async () => {
    const f = fixture(undefined, { workspaceOnboarding: true });
    const r = await f.gateway.handle(f.message('/synq'));
    expect(r.code).toBe('WORKSPACE_ONBOARDING');
    expect(f.adapter.last()?.buttons?.[0]?.url).toBe(
      'https://synq.example/workspaces',
    );
    expect(f.adapter.last()?.text).toContain(
      'does not bind the chat or approve money',
    );
    expect(await f.store.groupLink('telegram', CHAT_A)).toBeNull();
    expect(f.brainCalls).toHaveLength(0);
  });
  it('supports a fresh direct-message /start without a pre-existing member', async () => {
    const f = fixture(undefined, { workspaceOnboarding: true });
    const r = await f.gateway.handle(
      f.message('/start', { chatKind: 'DIRECT', externalGroupId: '111' }),
    );
    expect(r.code).toBe('WORKSPACE_ONBOARDING');
  });
  it('retains existing legacy group linking when the workspace feature is disabled', async () => {
    const f = fixture();
    const r = await f.gateway.handle(f.message('/synq'));
    expect(r.code).toBe('PRIVATE_LINK_ISSUED');
  });
});
