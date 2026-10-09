import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type pg from 'pg';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port');
  await new Promise<void>((r) => server.close(() => r()));
  return address.port;
}

export interface EnvioOptions {
  env: Record<string, string>;
  schema: string;
  database: {
    host: string;
    port: number;
    user: string;
    password: string;
    name: string;
  };
  logFile: string;
}

export class EnvioProcess {
  private child: ChildProcess | null = null;
  private port = 0;
  starts = 0;
  constructor(readonly options: EnvioOptions) {}
  private environment(): NodeJS.ProcessEnv {
    const db = this.options.database;
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...this.options.env,
      ENVIO_PG_HOST: db.host,
      ENVIO_PG_PORT: String(db.port),
      ENVIO_PG_USER: db.user,
      ENVIO_PG_PASSWORD: db.password,
      ENVIO_PG_DATABASE: db.name,
      ENVIO_PG_SCHEMA: this.options.schema,
      ENVIO_TUI: 'false',
      ENVIO_HASURA: 'false',
      ENVIO_INDEXER_PORT: String(this.port),
      LOG_LEVEL: 'info',
      LOG_STRATEGY: 'console-raw',
      SYNQ_INDEXER_POLLING_MS: '250',
    };
  }
  async start(): Promise<void> {
    if (this.child) throw new Error('envio already running');
    this.port = await freePort();
    mkdirSync(resolve(this.options.logFile, '..'), { recursive: true });
    const log = createWriteStream(this.options.logFile, { flags: 'a' });
    log.write(
      `\n--- envio start #${++this.starts} ${new Date().toISOString()}\n`,
    );
    const child = spawn(
      process.execPath,
      [resolve('indexer/envio/node_modules/envio/bin.mjs'), 'start'],
      {
        cwd: resolve('indexer/envio'),
        env: this.environment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    this.child = child;
  }
  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }
  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (child.exitCode !== null) return;
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
      child.kill(signal);
    });
  }
  async progress(db: pg.Pool, chainId: number): Promise<number | null> {
    try {
      const { rows } = await db.query(
        `SELECT progress_block FROM "${this.options.schema}".envio_chains WHERE id=$1`,
        [chainId],
      );
      return rows[0] ? Number(rows[0].progress_block) : null;
    } catch {
      return null;
    }
  }
  async waitFor(
    db: pg.Pool,
    chainId: number,
    block: number,
    timeoutMs = 180_000,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child && this.child.exitCode !== null)
        throw new Error(
          `envio exited with ${this.child.exitCode}; see ${this.options.logFile}`,
        );
      const p = await this.progress(db, chainId);
      if (p !== null && p >= block) return p;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `envio did not reach block ${block}; see ${this.options.logFile}`,
    );
  }
}
