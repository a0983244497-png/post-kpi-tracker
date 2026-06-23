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
      leads      INTEGER DEFAULT 0,
      deals      INTEGER DEFAULT 0,
      revenue    INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(100) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
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
