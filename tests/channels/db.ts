import pg from 'pg';

export async function freshChannelDatabase(connectionString: string) {
  const name = new URL(connectionString).pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*(test|demo)[a-z0-9_]*$/.test(name))
    throw new Error('CHANNEL_TEST_DATABASE_NAME');
  const admin = new pg.Client({
    connectionString: connectionString.replace(/\/[^/]+$/, '/postgres'),
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
  const p = new pg.Pool({ connectionString, max: 4 });
  await p.query(
    'DROP TABLE IF EXISTS synq_channel_event, synq_channel_group_link, synq_channel_user_link, synq_channel_inbound, synq_channel_chat_link, synq_channel_member_link, synq_channel_link_code, synq_channel_notification, synq_channel_delivery_failure',
  );
  return p;
}
