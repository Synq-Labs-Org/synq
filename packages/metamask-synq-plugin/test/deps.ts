import { allows, type SynqCommandId } from '../src/core/capabilities.js';
import type { Deps } from '../src/core/group.js';
import { MemberSessions, type SessionStore } from '../src/core/session.js';
import { SynqApi, type FetchLike } from '../src/core/synq-api.js';
import { hostFromContext, type HostContext } from '../src/plugin-host.js';
import type { RpcFallback } from '../src/core/rpc.js';
import { fakeIo } from './fakes.js';

/** Wires a command exactly like plugin-host.depsFor, with injectable fetch and session store. */
export function makeDeps(
  ctx: HostContext,
  fetch: FetchLike,
  command: SynqCommandId,
  store: SessionStore,
  now: () => number,
  rpcFallback: RpcFallback | null = null,
): Deps {
  const host = hostFromContext(ctx, fakeIo, command, rpcFallback);
  const api = new SynqApi(
    { baseUrl: 'http://127.0.0.1:3200', token: null },
    fetch,
  );
  return {
    host,
    api,
    sessions: new MemberSessions(
      api,
      store,
      host,
      now,
      allows(command, 'wallet-submit'),
    ),
    now,
  };
}
