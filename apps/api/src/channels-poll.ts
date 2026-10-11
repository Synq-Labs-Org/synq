import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TelegramAdapter, TelegramBotApi } from '@synq/channels';
import { startV1Server } from './v1-server.js';

const env = process.env;
if (env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
  throw new Error(
    'channels:telegram:poll refuses SYNQ_ALLOW_MAINNET_BROADCAST=true',
  );
env.SYNQ_ALLOW_MAINNET_BROADCAST = 'false';
const token = env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error(
    'TELEGRAM_BOT_TOKEN is not set; live Telegram evidence remains PENDING.',
  );
  process.exit(2);
}

if (process.argv.includes('--probe')) {
  const adapter = new TelegramAdapter({ api: new TelegramBotApi({ token }) });
  const bot = await adapter.init();
  const dir = resolve('bounty-evidence/telegram');
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const evidence = {
    schemaVersion: 1,
    kind: 'telegram-getme',
    executionMode: 'PROVIDER_SANDBOX',
    provider: 'telegram-bot-api getMe on a dedicated test bot',
    observedAt: at,
    bot: {
      username: bot.username,
      idHash: createHash('sha256')
        .update(String(bot.id))
        .digest('hex')
        .slice(0, 16),
    },
  };
  writeFileSync(
    join(dir, `getme-${at.replace(/[-:.]/g, '')}.json`),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.log(`telegram getMe ok: @${bot.username}`);
  process.exit(0);
}

env.SYNQ_TELEGRAM_MODE = 'poll';
const app = await startV1Server(env);
console.log('Synq API with Telegram long polling is running');
const stop = () => void app.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
