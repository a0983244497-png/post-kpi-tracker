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
  // Migration: add name column + composite unique index (week + name)
  await pool.query(`ALTER TABLE weekly_stats ADD COLUMN IF NOT EXISTS name VARCHAR(100) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE weekly_stats DROP CONSTRAINT IF EXISTS weekly_stats_week_start_date_key`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS weekly_stats_week_name_uidx ON weekly_stats(week_start_date, name)`);

  // Daily followers table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_followers (
      id         SERIAL PRIMARY KEY,
      date       DATE NOT NULL,
      staff_name VARCHAR(100) NOT NULL,
      followers  INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(date, staff_name)
    )
  `);

  // Seed default staff (unconditional, skips if already exists)
  await pool.query(
    `INSERT INTO staff (name) VALUES ('Gino'),('Darren'),('Josh'),('Jenna'),('路克') ON CONFLICT (name) DO NOTHING`
  );
  console.log('✓ Database ready');
}

export default pool;
