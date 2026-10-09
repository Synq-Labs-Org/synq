import { LOCAL_CHAIN_ID } from '@synq/schemas';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createPublicClient, http } from 'viem';
import { anvil } from 'viem/chains';
export async function startAnvil(): Promise<{
  url: string;
  process: ChildProcess;
  close: () => Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('ANVIL_PORT');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const child = spawn(
    'anvil',
    [
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--chain-id',
      String(LOCAL_CHAIN_ID),
      '--silent',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let errorOutput = '';
  child.stderr?.on('data', (chunk) => {
    errorOutput += String(chunk);
  });
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({
    chain: anvil,
    transport: http(url, { retryCount: 0, timeout: 300 }),
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Anvil exited: ${errorOutput}`);
    try {
      if ((await client.getChainId()) === LOCAL_CHAIN_ID)
        return {
          url,
          process: child,
          close: () =>
            new Promise((resolve) => {
              if (child.exitCode !== null) return resolve();
              child.once('exit', () => resolve());
              child.kill('SIGTERM');
            }),
        };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`Anvil unavailable: ${errorOutput}`);
}
