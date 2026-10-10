import pg from 'pg';

export const P08_DATABASE_URL =
  process.env.SYNQ_P08_TEST_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p08_test';

export async function ensureP08Database(url = P08_DATABASE_URL) {
  const name = new URL(url).pathname.slice(1);
  if (!/^synq_p08[a-z]?_[a-z0-9_]+$/.test(name))
    throw new Error('P08 test database must be named synq_p08_*');
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
  return new pg.Pool({ connectionString: url, max: 4 });
}
