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

  // ── 業務外出記錄 ────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS field_visits (
      id             SERIAL PRIMARY KEY,
      staff_name     VARCHAR(100) NOT NULL,
      visit_date     DATE         NOT NULL DEFAULT CURRENT_DATE,
      depart_time    TIMESTAMPTZ,
      arrive_time    TIMESTAMPTZ,
      complete_time  TIMESTAMPTZ,
      arrive_lat     NUMERIC(10,7),
      arrive_lng     NUMERIC(10,7),
      arrive_address TEXT         DEFAULT '',
      client_name    VARCHAR(200) DEFAULT '',
      purpose        TEXT         DEFAULT '',
      notes          TEXT         DEFAULT '',
      photo_urls     JSONB        DEFAULT '[]',
      status         VARCHAR(20)  DEFAULT 'in_progress',
      created_at     TIMESTAMPTZ  DEFAULT NOW(),
      updated_at     TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  // Migration: add new columns to field_visits
  await pool.query(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS planned_depart_time TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS planned_return_time TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS notify_manager      BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS manager_reviewed    BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS manager_reviewed_at TIMESTAMPTZ`);
  // Migration: manual address fields (GPS 欄位保留，新增手動填寫欄位)
  await pool.query(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS expected_address TEXT`);
  await pool.query(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS actual_address   TEXT`);


  // ── 課程 PDF 閱讀系統（第一階段：資料庫 + 學員登入 + 名單匯入 + 申請審核）──
  // 命名用 pdf_ 前綴，避免跟既有的 course_students（出席/漏斗追蹤用）撞名
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pdf_students (
      id         SERIAL PRIMARY KEY,
      email      VARCHAR(200) UNIQUE NOT NULL,
      name       VARCHAR(100) NOT NULL,
      tv_name    VARCHAR(100) NOT NULL,
      status     VARCHAR(20)  DEFAULT 'active',
      source     VARCHAR(20)  DEFAULT 'import',
      created_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pdf_pdfs (
      id         SERIAL PRIMARY KEY,
      title      VARCHAR(200) NOT NULL,
      file_url   VARCHAR(500) DEFAULT '',
      sort_order INTEGER      DEFAULT 0,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pdf_access (
      id         SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES pdf_students(id) ON DELETE CASCADE,
      pdf_id     INTEGER NOT NULL REFERENCES pdf_pdfs(id)     ON DELETE CASCADE,
      granted_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(student_id, pdf_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pdf_applications (
      id         SERIAL PRIMARY KEY,
      email      VARCHAR(200) NOT NULL,
      name       VARCHAR(100) NOT NULL,
      tv_name    VARCHAR(100) NOT NULL,
      note       TEXT         DEFAULT '',
      status     VARCHAR(20)  DEFAULT 'pending',
      created_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  // ── 課程 PDF：系列分組 ──────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pdf_series (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      sort_order INTEGER      DEFAULT 0,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE pdf_pdfs ADD COLUMN IF NOT EXISTS series_id  INTEGER REFERENCES pdf_series(id)`);
  await pool.query(`ALTER TABLE pdf_pdfs ADD COLUMN IF NOT EXISTS episode_no INTEGER DEFAULT 0`);

  // Seed default series（先查再插，避免重複）
  const DEFAULT_SERIES = [
    { name: '新手篇',       sort_order: 0 }, // 分級開通：新手級對應系列（內容先留空）
    { name: '交易心理系列', sort_order: 1 },
    { name: '基礎系列',     sort_order: 2 },
    { name: '進階系列',     sort_order: 3 },
  ];
  for (const s of DEFAULT_SERIES) {
    const { rows: existingSeries } = await pool.query(`SELECT id FROM pdf_series WHERE name = $1`, [s.name]);
    if (!existingSeries.length) {
      await pool.query(`INSERT INTO pdf_series (name, sort_order) VALUES ($1,$2)`, [s.name, s.sort_order]);
    }
  }

  // 校正系列閱讀順序：新手篇(0) → 基礎(1) → 交易心理(2) → 進階(3)，依名稱比對、每次開機冪等
  // 目前後台沒有調整系列順序的功能，日後若做了「系列排序」，要把這段移除以免覆蓋手動設定
  await pool.query(`UPDATE pdf_series SET sort_order = 1 WHERE name = '基礎系列'`);
  await pool.query(`UPDATE pdf_series SET sort_order = 2 WHERE name = '交易心理系列'`);

  // 一次性資料歸位（每次啟動都跑，冪等：只處理 series_id 仍為 NULL 的 PDF）
  {
    const { rows: seriesRows } = await pool.query(`SELECT id, name FROM pdf_series`);
    const seriesIdByName = {};
    for (const row of seriesRows) seriesIdByName[row.name] = row.id;

    const CN_NUM_LIST = [['十',10],['九',9],['八',8],['七',7],['六',6],['五',5],['四',4],['三',3],['二',2],['一',1]];
    const parseEpisodeNo = (title) => {
      const arabicMatch = title.match(/\d+/);
      if (arabicMatch) return parseInt(arabicMatch[0], 10);
      for (const [cn, num] of CN_NUM_LIST) {
        if (title.includes(cn)) return num;
      }
      return 0;
    };
    const KEYWORD_TO_SERIES = [
      ['心理', '交易心理系列'],
      ['基礎', '基礎系列'],
      ['進階', '進階系列'],
    ];

    const { rows: unclassified } = await pool.query(`SELECT id, title FROM pdf_pdfs WHERE series_id IS NULL`);
    for (const pdf of unclassified) {
      const matched = KEYWORD_TO_SERIES.find(([kw]) => pdf.title.includes(kw));
      if (!matched) continue; // 歸不到任何系列，維持 NULL（未分類）
      const seriesId = seriesIdByName[matched[1]];
      if (!seriesId) continue;
      const episodeNo = parseEpisodeNo(pdf.title);
      await pool.query(
        `UPDATE pdf_pdfs SET series_id = $1, episode_no = $2 WHERE id = $3`,
        [seriesId, episodeNo, pdf.id]
      );
    }
  }

  // ── 課程分級開通 Phase1：依入金資金分級（只建結構，權限判斷尚未接上）──
  // 學員資金欄位；is_override 第一次新增時，把當下所有既有學員設為 true，保留現有逐篇開通權限
  {
    const { rows: overrideCol } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'pdf_students' AND column_name = 'is_override'`
    );
    const isFirstRun = overrideCol.length === 0;

    await pool.query(`ALTER TABLE pdf_students ADD COLUMN IF NOT EXISTS deposit_usd        NUMERIC   DEFAULT 0`);
    await pool.query(`ALTER TABLE pdf_students ADD COLUMN IF NOT EXISTS deposit_updated_at TIMESTAMP`);
    await pool.query(`ALTER TABLE pdf_students ADD COLUMN IF NOT EXISTS access_deposit_usd NUMERIC   DEFAULT 0`);
    await pool.query(`ALTER TABLE pdf_students ADD COLUMN IF NOT EXISTS grace_until        TIMESTAMP NULL`);
    await pool.query(`ALTER TABLE pdf_students ADD COLUMN IF NOT EXISTS is_override        BOOLEAN   DEFAULT false`);

    // 只在欄位剛建立的這次啟動執行，之後重啟不會把新學員或已切回自動模式的學員再改成 override
    if (isFirstRun) {
      const { rowCount } = await pool.query(`UPDATE pdf_students SET is_override = true`);
      console.log(`[Tier] 既有學員 ${rowCount} 位設為 is_override = true（保留現有權限）`);
    }

    // 過渡期：入金資料與 override 切換 UI 上線前，新學員也走手動開通（只改預設值，不動既有資料列）
    await pool.query(`ALTER TABLE pdf_students ALTER COLUMN is_override SET DEFAULT true`);
  }

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pdf_students_deposit_usd ON pdf_students (deposit_usd)`);
  // email 已有 UNIQUE 索引；登入/比對都用 LOWER(TRIM(email))，補表達式索引才吃得到
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pdf_students_email_norm  ON pdf_students (LOWER(TRIM(email)))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pdf_students_tv_name     ON pdf_students (tv_name)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tiers (
      id              SERIAL PRIMARY KEY,
      name            VARCHAR(50) UNIQUE NOT NULL,
      min_deposit_usd NUMERIC     NOT NULL DEFAULT 0,
      sort_order      INTEGER     DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tier_series (
      tier_id   INTEGER NOT NULL REFERENCES tiers(id)      ON DELETE CASCADE,
      series_id INTEGER NOT NULL REFERENCES pdf_series(id) ON DELETE CASCADE,
      PRIMARY KEY (tier_id, series_id)
    )
  `);

  // Seed tiers + 對應系列：只在表為空時塞一次，之後後台調整不會被開機覆蓋
  {
    const DEFAULT_TIERS = [
      { name: '新手', min_deposit_usd: 0,    sort_order: 1, series: '新手篇' },
      { name: '基礎', min_deposit_usd: 500,  sort_order: 2, series: '基礎系列' },
      { name: '心理', min_deposit_usd: 1000, sort_order: 3, series: '交易心理系列' },
      { name: '進階', min_deposit_usd: 2000, sort_order: 4, series: '進階系列' },
    ];

    const { rows: tierCount } = await pool.query(`SELECT COUNT(*)::int AS cnt FROM tiers`);
    if (tierCount[0].cnt === 0) {
      for (const t of DEFAULT_TIERS) {
        await pool.query(
          `INSERT INTO tiers (name, min_deposit_usd, sort_order) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
          [t.name, t.min_deposit_usd, t.sort_order]
        );
      }
    }

    const { rows: mapCount } = await pool.query(`SELECT COUNT(*)::int AS cnt FROM tier_series`);
    if (mapCount[0].cnt === 0) {
      for (const t of DEFAULT_TIERS) {
        const { rows: tierRows }   = await pool.query(`SELECT id FROM tiers WHERE name = $1`, [t.name]);
        const { rows: seriesRows } = await pool.query(`SELECT id FROM pdf_series WHERE name = $1 ORDER BY id ASC LIMIT 1`, [t.series]);
        if (!tierRows.length || !seriesRows.length) {
          console.warn(`[Tier] 找不到對應：tier「${t.name}」→ series「${t.series}」，略過`);
          continue;
        }
        await pool.query(
          `INSERT INTO tier_series (tier_id, series_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [tierRows[0].id, seriesRows[0].id]
        );
      }
    }
  }

  // ── 課程觀看進度：捲到最後一頁才記為已完成 ─────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pdf_progress (
      id           SERIAL PRIMARY KEY,
      student_id   INTEGER NOT NULL REFERENCES pdf_students(id) ON DELETE CASCADE,
      pdf_id       INTEGER NOT NULL REFERENCES pdf_pdfs(id)     ON DELETE CASCADE,
      completed_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(student_id, pdf_id)
    )
  `);

  // Seed default staff (unconditional, skips if already exists)
  await pool.query(
    `INSERT INTO staff (name) VALUES ('Gino'),('Darren'),('Josh'),('Jenna'),('路克') ON CONFLICT (name) DO NOTHING`
  );
  console.log('✓ Database ready');
}

export default pool;
