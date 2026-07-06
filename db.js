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
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS post_url VARCHAR(500) DEFAULT ''`);
  for (const col of ['snapshot_1730_views','snapshot_1730_likes','snapshot_1730_replies','snapshot_1730_reposts']) {
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS ${col} INTEGER DEFAULT NULL`);
  }
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS snapshot_1730_recorded_at TIMESTAMPTZ DEFAULT NULL`);
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

  // Staff goals table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_goals (
      id                  SERIAL PRIMARY KEY,
      staff_name          VARCHAR(100) NOT NULL,
      week_start_date     DATE NOT NULL,
      target_views        INTEGER DEFAULT 0,
      target_leads        INTEGER DEFAULT 0,
      target_conversions  INTEGER DEFAULT 0,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(staff_name, week_start_date)
    )
  `);

  // Course tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS course_students (
      id             SERIAL PRIMARY KEY,
      name           VARCHAR(100) NOT NULL,
      phone          VARCHAR(20)  DEFAULT '',
      joined_date    DATE         NOT NULL,
      assigned_staff VARCHAR(100) DEFAULT '',
      status         VARCHAR(20)  DEFAULT 'active',
      notes          TEXT         DEFAULT '',
      created_at     TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS course_sessions (
      id              SERIAL PRIMARY KEY,
      session_date    DATE         NOT NULL,
      session_title   VARCHAR(200) NOT NULL,
      total_students  INTEGER      DEFAULT 0,
      attended_count  INTEGER      DEFAULT 0,
      notes           TEXT         DEFAULT '',
      created_at      TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS course_funnel (
      id                SERIAL PRIMARY KEY,
      student_id        INTEGER REFERENCES course_students(id) ON DELETE CASCADE,
      attended_sessions INTEGER   DEFAULT 0,
      completed_course  BOOLEAN   DEFAULT FALSE,
      completed_date    DATE,
      dm_inquiry        BOOLEAN   DEFAULT FALSE,
      dm_date           DATE,
      opened_account    BOOLEAN   DEFAULT FALSE,
      account_date      DATE,
      deposited         BOOLEAN   DEFAULT FALSE,
      deposit_amount    INTEGER   DEFAULT 0,
      deposit_date      DATE,
      converted         BOOLEAN   DEFAULT FALSE,
      convert_date      DATE,
      assigned_staff    VARCHAR(100) DEFAULT '',
      created_at        TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE(student_id)
    )
  `);

  // Migration: staff_goals → monthly goals
  await pool.query(`ALTER TABLE staff_goals ALTER COLUMN week_start_date DROP NOT NULL`);
  await pool.query(`ALTER TABLE staff_goals ADD COLUMN IF NOT EXISTS period_end DATE`);
  await pool.query(`ALTER TABLE staff_goals ADD COLUMN IF NOT EXISTS target_followers INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE staff_goals ADD COLUMN IF NOT EXISTS goal_month VARCHAR(7)`);
  await pool.query(`ALTER TABLE staff_goals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);
  // Populate goal_month from existing week_start_date
  await pool.query(`UPDATE staff_goals SET goal_month = TO_CHAR(week_start_date, 'YYYY-MM') WHERE goal_month IS NULL AND week_start_date IS NOT NULL`);
  // Dedup: keep latest row per (staff_name, goal_month) before adding unique index
  await pool.query(`
    DELETE FROM staff_goals WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY staff_name, goal_month ORDER BY created_at DESC NULLS LAST) AS rn
        FROM staff_goals WHERE goal_month IS NOT NULL
      ) t WHERE rn > 1
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS staff_goals_name_month_uidx ON staff_goals(staff_name, goal_month) WHERE goal_month IS NOT NULL`);
  // Migration: staff_goals → date-range goals
  await pool.query(`ALTER TABLE staff_goals ADD COLUMN IF NOT EXISTS start_date DATE`);
  await pool.query(`ALTER TABLE staff_goals ADD COLUMN IF NOT EXISTS end_date DATE`);
  // Populate start_date/end_date from existing goal_month
  await pool.query(`
    UPDATE staff_goals
    SET
      start_date = (goal_month || '-01')::DATE,
      end_date   = ((goal_month || '-01')::DATE + INTERVAL '1 MONTH' - INTERVAL '1 DAY')::DATE
    WHERE start_date IS NULL AND goal_month IS NOT NULL
  `);
  // Also populate from week_start_date for very old rows with no goal_month
  await pool.query(`
    UPDATE staff_goals
    SET
      start_date = week_start_date,
      end_date   = week_start_date + 6
    WHERE start_date IS NULL AND week_start_date IS NOT NULL
  `);
  // Dedup before adding range unique index
  await pool.query(`
    DELETE FROM staff_goals WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY staff_name, start_date, end_date ORDER BY created_at DESC NULLS LAST) AS rn
        FROM staff_goals WHERE start_date IS NOT NULL AND end_date IS NOT NULL
      ) t WHERE rn > 1
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS staff_goals_range_uidx ON staff_goals(staff_name, start_date, end_date) WHERE start_date IS NOT NULL AND end_date IS NOT NULL`);
  // Migration: add notes to daily_followers
  await pool.query(`ALTER TABLE daily_followers ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`);

  // Migration: add contact and source to course_students
  await pool.query(`ALTER TABLE course_students ADD COLUMN IF NOT EXISTS contact VARCHAR(100) DEFAULT ''`);
  await pool.query(`ALTER TABLE course_students ADD COLUMN IF NOT EXISTS source  VARCHAR(100) DEFAULT ''`);

  // Migration: session time + student-session assignment
  await pool.query(`ALTER TABLE course_sessions ADD COLUMN IF NOT EXISTS session_time VARCHAR(5) DEFAULT ''`);
  await pool.query(`ALTER TABLE course_students ADD COLUMN IF NOT EXISTS assigned_session_id INTEGER REFERENCES course_sessions(id) ON DELETE SET NULL`);

  // Attendance tracking per session
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_attendance (
      id         SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES course_sessions(id)  ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES course_students(id) ON DELETE CASCADE,
      attended   BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(session_id, student_id)
    )
  `);

  // Seed default staff (unconditional, skips if already exists)
  await pool.query(
    `INSERT INTO staff (name) VALUES ('Gino'),('Darren'),('Josh'),('Jenna'),('路克') ON CONFLICT (name) DO NOTHING`
  );
  console.log('✓ Database ready');
}

export default pool;
