import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      date       DATE NOT NULL,
      type       VARCHAR(20)  NOT NULL,
      title      TEXT NOT NULL,
      content    TEXT    DEFAULT '',
      views      INTEGER DEFAULT 0,
      likes      INTEGER DEFAULT 0,
      comments   INTEGER DEFAULT 0,
      shares     INTEGER DEFAULT 0,
      replies    INTEGER DEFAULT 0,
      reposts    INTEGER DEFAULT 0,
      quotes     INTEGER DEFAULT 0,
      dms        INTEGER DEFAULT 0,
      leads      INTEGER DEFAULT 0,
      deals      INTEGER DEFAULT 0,
      revenue    INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Migration: add new columns if upgrading from older schema
  for (const col of ['replies','reposts','quotes','dms']) {
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS ${col} INTEGER DEFAULT 0`);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(100) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_stats (
      id               SERIAL PRIMARY KEY,
      week_start_date  DATE    NOT NULL UNIQUE,
      total_posts      INTEGER DEFAULT 0,
      total_views      INTEGER DEFAULT 0,
      total_likes      INTEGER DEFAULT 0,
      total_replies    INTEGER DEFAULT 0,
      total_reposts    INTEGER DEFAULT 0,
      total_quotes     INTEGER DEFAULT 0,
      total_dms        INTEGER DEFAULT 0,
      conversions      INTEGER DEFAULT 0,
      revenue          INTEGER DEFAULT 0,
      followers_end    INTEGER DEFAULT 0,
      followers_start  INTEGER DEFAULT 0,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Seed default staff if table is empty
  const { rows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM staff');
  if (rows[0].cnt === 0) {
    await pool.query(`INSERT INTO staff (name) VALUES ('Gino'),('Darren'),('Josh'),('Jenna') ON CONFLICT DO NOTHING`);
  }
  console.log('✓ Database ready');
}

export default pool;
