import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { imessageConfigFromEnv } from '@synq/channels';
import { startV1Server } from './v1-server.js';

/**
 * Mac iMessage bridge: the Synq API with the iMessage transport enabled.
 * `--probe` only checks the local server and the allowlist and records
 * evidence; it reads and sends no messages.
 */
const env = process.env;
if (env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
  throw new Error(
    'channels:imessage refuses SYNQ_ALLOW_MAINNET_BROADCAST=true',
  );
env.SYNQ_ALLOW_MAINNET_BROADCAST = 'false';
// Finding a chat id happens before the allowlist exists; nothing is read or sent in that mode.
if (process.argv.includes('--find-chat') && !env.SYNQ_IMESSAGE_ALLOWED_CHATS)
  env.SYNQ_IMESSAGE_ALLOWED_CHATS = 'setup-only';
const config = imessageConfigFromEnv(env);
if (!config) {
  console.error(
    'SYNQ_IMESSAGE_TRANSPORT is off; live iMessage evidence remains PENDING.',
  );
  process.exit(2);
}

const find = process.argv.indexOf('--find-chat');
if (find > 0) {
  // Local setup aid: prints only group chats whose title matches; nothing is uploaded.
  const query = process.argv[find + 1] ?? '';
  const chats = (await config.transport.findChats?.(query)) ?? [];
  for (const c of chats) console.log(`${c.chatId}\t${c.title}`);
  if (!chats.length) console.log('no matching group chat');
  process.exit(0);
}

if (process.argv.includes('--probe')) {
  const health = await config.transport.health();
  const at = new Date().toISOString();
  const dir = resolve('bounty-evidence/imessage');
  mkdirSync(dir, { recursive: true });
  const evidence = {
    schemaVersion: 1,
    kind: 'imessage-transport-probe',
    executionMode: 'PROVIDER_SANDBOX',
    transport: config.transport.name,
    capabilities: config.transport.capabilities,
    healthy: health.ok,
    detail: health.detail,
    allowedChats: config.allowedChats.map((c) =>
      createHash('sha256').update(c).digest('hex').slice(0, 16),
    ),
    observedAt: at,
  };
  writeFileSync(
    join(dir, `probe-${at.replace(/[-:.]/g, '')}.json`),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.log(
    `${config.transport.name}: ${health.ok ? 'reachable' : 'NOT reachable'} (${health.detail}); ${config.allowedChats.length} allowlisted chat(s)`,
  );
  process.exit(health.ok ? 0 : 1);
}

if (!env.TELEGRAM_BOT_TOKEN) env.SYNQ_TELEGRAM_MODE = 'off';
const app = await startV1Server(env);
console.log(
  `Synq API with the ${config.transport.name} iMessage bridge is running`,
);
const stop = () => void app.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
