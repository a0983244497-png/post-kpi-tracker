import pool from '../db.js';
import { listAccessiblePdfs } from './courseAccess.js';

// ── 學員進度追蹤：三清單即時推算，不另存結果（規格見 docs/學員進度追蹤規格.md）──
// 門檻集中在這裡，Gino 之後要調整只改這幾個數字
export const STUCK_WRONG_MIN   = 2;   // 同一題答錯幾次算卡住
export const STUCK_WINDOW_DAYS = 14;  // 只看最近幾天的作答
export const INACTIVE_DAYS     = 7;   // 幾天沒活動算消失
export const COMPARE_DAYS      = 28;  // 進步：最近 28 天 vs 再之前 28 天
export const QUIZ_MIN_ANSWERS  = 6;   // 進步：兩段期間各至少作答幾題
export const QUIZ_RATE_GAIN    = 0.2; // 進步：首答答對率提升幾個百分點
export const PLAN_STREAK_MIN   = 3;   // 進步：最近連續幾次打卡「有照計畫」
export const LAST_SEEN_THROTTLE = `INTERVAL '1 hour'`;

// 列入三清單的學員：啟用中、沒有被排除（講師本人、測試帳號）
const TRACKED = `s.status = 'active' AND s.exclude_from_tracking = false`;

// 最後出現時間：登入 / 開課程時更新，一小時內不重寫；失敗不影響主流程
export function touchLastSeen(studentId) {
  pool.query(
    `UPDATE pdf_students SET last_seen_at = NOW()
     WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < NOW() - ${LAST_SEEN_THROTTLE})`,
    [studentId]
  ).catch(e => console.error('[Tracking] last_seen:', e.message));
}

// 台灣時間本週週一（YYYY-MM-DD）
export async function currentWeekStart(db = pool) {
  const { rows } = await db.query(
    `SELECT to_char(date_trunc('week', NOW() AT TIME ZONE 'Asia/Taipei'), 'YYYY-MM-DD') AS week_start`
  );
  return rows[0].week_start;
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function ymd(v) {
  if (typeof v === 'string') return v.slice(0, 10);
  // pg 把 DATE 轉成本機午夜的 Date，用本機欄位取年月日才不會因時區差一天
  const pad = n => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

// 連續打卡週數：從本週（有打）或上週往回數，週與週之間不能斷
export function checkinStreak(weekStarts, thisWeek) {
  const set = new Set(weekStarts.map(ymd));
  let w = set.has(thisWeek) ? thisWeek : addDays(thisWeek, -7);
  let n = 0;
  while (set.has(w)) { n++; w = addDays(w, -7); }
  return n;
}

// ── 🟥 卡住：近 14 天內同一題「最後一次答對之後」又錯 ≥ 2 次（已停用的舊題不算，學員已無法再作答）──
export async function listStuck() {
  const { rows } = await pool.query(
    `WITH last_ok AS (
       SELECT student_id, question_id, MAX(answered_at) AS ok_at
       FROM pdf_quiz_answers WHERE is_correct GROUP BY 1, 2
     )
     SELECT a.student_id, s.name, s.email, a.question_id, q.question, a.pdf_id,
            p.title AS pdf_title, p.episode_no, sr.name AS series_name,
            COUNT(*)::int AS wrong_count, MAX(a.answered_at) AS last_answered_at
     FROM pdf_quiz_answers a
     JOIN pdf_students s        ON s.id = a.student_id
     JOIN pdf_quiz_questions q  ON q.id = a.question_id
     JOIN pdf_pdfs p            ON p.id = a.pdf_id
     LEFT JOIN pdf_series sr    ON sr.id = p.series_id
     LEFT JOIN last_ok lo       ON lo.student_id = a.student_id AND lo.question_id = a.question_id
     WHERE ${TRACKED}
       AND q.is_active
       AND a.is_correct = false
       AND a.answered_at >= NOW() - ($1 || ' days')::interval
       AND (lo.ok_at IS NULL OR a.answered_at > lo.ok_at)
     GROUP BY a.student_id, s.name, s.email, a.question_id, q.question, a.pdf_id, p.title, p.episode_no, sr.name
     HAVING COUNT(*) >= $2
     ORDER BY MAX(a.answered_at) DESC`,
    [String(STUCK_WINDOW_DAYS), STUCK_WRONG_MIN]
  );

  // 一位學員卡多題時合併成一列
  const byStudent = new Map();
  for (const r of rows) {
    if (!byStudent.has(r.student_id)) {
      byStudent.set(r.student_id, { student_id: r.student_id, name: r.name, email: r.email, last_answered_at: r.last_answered_at, items: [] });
    }
    byStudent.get(r.student_id).items.push({
      question_id: r.question_id, question: r.question, pdf_id: r.pdf_id, pdf_title: r.pdf_title,
      series_name: r.series_name, episode_no: r.episode_no, wrong_count: r.wrong_count, last_answered_at: r.last_answered_at,
    });
  }

  // 全班最常錯的題（近 30 天、至少 3 次作答）：多半是題目或課程本身要補充的訊號
  const { rows: hardest } = await pool.query(
    `SELECT q.id AS question_id, q.question, p.title AS pdf_title, sr.name AS series_name,
            COUNT(*)::int AS answers,
            COUNT(*) FILTER (WHERE NOT a.is_correct)::int AS wrong,
            COUNT(DISTINCT a.student_id) FILTER (WHERE NOT a.is_correct)::int AS wrong_students
     FROM pdf_quiz_answers a
     JOIN pdf_students s       ON s.id = a.student_id
     JOIN pdf_quiz_questions q ON q.id = a.question_id
     JOIN pdf_pdfs p           ON p.id = a.pdf_id
     LEFT JOIN pdf_series sr   ON sr.id = p.series_id
     WHERE ${TRACKED} AND q.is_active AND a.answered_at >= NOW() - INTERVAL '30 days'
     GROUP BY q.id, q.question, p.title, sr.name
     HAVING COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE NOT a.is_correct) > 0
     ORDER BY (COUNT(*) FILTER (WHERE NOT a.is_correct))::float / COUNT(*) DESC, COUNT(*) DESC
     LIMIT 5`
  );

  return { students: [...byStudent.values()], hardest_questions: hardest };
}

// ── ⬜ 消失：最後活動（登入/開課程、看完、作答、打卡取最晚）超過 7 天 ──
export async function listInactive() {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.email, s.is_override, s.access_deposit_usd, s.created_at, s.last_seen_at,
            (SELECT MAX(completed_at) FROM pdf_progress     WHERE student_id = s.id) AS last_progress_at,
            (SELECT MAX(answered_at)  FROM pdf_quiz_answers WHERE student_id = s.id) AS last_quiz_at,
            (SELECT MAX(updated_at)   FROM pdf_checkins     WHERE student_id = s.id) AS last_checkin_at
     FROM pdf_students s
     WHERE ${TRACKED}`
  );

  const cutoff = Date.now() - INACTIVE_DAYS * 86400000;
  const result = [];
  for (const s of rows) {
    const times = [s.last_seen_at, s.last_progress_at, s.last_quiz_at, s.last_checkin_at]
      .filter(Boolean).map(t => new Date(t).getTime());
    const last = times.length ? Math.max(...times) : null;
    if (last !== null && last >= cutoff) continue;

    const item = {
      student_id: s.id, name: s.name, email: s.email, is_override: s.is_override,
      access_deposit_usd: s.access_deposit_usd, created_at: s.created_at,
      last_activity_at: last ? new Date(last).toISOString() : null,
      days_inactive: last ? Math.floor((Date.now() - last) / 86400000) : null,
      never_started: last === null,
      last_action: null,
      finished_all: false,
    };
    // 剛建檔還沒滿 7 天、也還沒開始的人不算消失
    if (item.never_started && new Date(s.created_at).getTime() >= cutoff) continue;

    item.last_action = await lastMeaningfulAction(s.id);
    const accessible = await listAccessiblePdfs(s);
    if (accessible.length) {
      const { rows: done } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pdf_progress WHERE student_id = $1 AND pdf_id = ANY($2::int[])`,
        [s.id, accessible.map(p => p.id)]
      );
      item.finished_all = done[0].n >= accessible.length;
    }
    result.push(item);
  }
  // 上過課後消失的排前面（天數多到少），尚未開始的排最後
  result.sort((a, b) => (a.never_started - b.never_started) || ((b.days_inactive ?? 0) - (a.days_inactive ?? 0)));
  return result;
}

// 最後在做什麼：看完哪篇 / 作答哪篇 / 打卡（只登入不算「在做什麼」）
async function lastMeaningfulAction(studentId) {
  const { rows } = await pool.query(
    `SELECT kind, at, pdf_id FROM (
       SELECT 'progress' AS kind, completed_at::timestamptz AS at, pdf_id FROM pdf_progress WHERE student_id = $1
       UNION ALL
       SELECT 'quiz', answered_at, pdf_id FROM pdf_quiz_answers WHERE student_id = $1
       UNION ALL
       SELECT 'checkin', updated_at, NULL FROM pdf_checkins WHERE student_id = $1
     ) ev ORDER BY at DESC LIMIT 1`,
    [studentId]
  );
  if (!rows.length) return null;
  const ev = rows[0];
  if (ev.kind === 'checkin') return '每週打卡';
  const { rows: p } = await pool.query(
    `SELECT p.title, s.name AS series_name FROM pdf_pdfs p LEFT JOIN pdf_series s ON s.id = p.series_id WHERE p.id = $1`,
    [ev.pdf_id]
  );
  const name = p.length ? (p[0].series_name ? `${p[0].series_name}｜${p[0].title}` : p[0].title) : '（已刪除的課程）';
  return (ev.kind === 'progress' ? '看完 ' : '作答 ') + name;
}

// ── 🟩 進步：照計畫做單為主、測驗為輔、心情只參考 ──
//   打卡：最近 3 次（不含「這週沒做單」）都「有照計畫」、最近一次在兩週內、之前 12 週內有過「沒有照計畫」
//   測驗：首次作答答對率，最近 28 天比前 28 天提升 ≥ 20 個百分點，兩段各 ≥ 6 題
export async function listImproving() {
  const { rows: students } = await pool.query(
    `SELECT s.id, s.name, s.email, s.case_consent FROM pdf_students s WHERE ${TRACKED}`
  );
  if (!students.length) return [];
  const ids = students.map(s => s.id);
  const thisWeek = await currentWeekStart();

  const { rows: checkins } = await pool.query(
    `SELECT student_id, to_char(week_start, 'YYYY-MM-DD') AS week_start, followed_plan, mood
     FROM pdf_checkins WHERE student_id = ANY($1::int[]) AND week_start >= $2::date - INTERVAL '16 weeks'
     ORDER BY week_start DESC`,
    [ids, thisWeek]
  );
  // 每題第一次作答：落在哪個期間、對不對
  const { rows: firsts } = await pool.query(
    `SELECT student_id,
            COUNT(*) FILTER (WHERE answered_at >= NOW() - ($2 || ' days')::interval)::int AS recent_n,
            COUNT(*) FILTER (WHERE answered_at >= NOW() - ($2 || ' days')::interval AND is_correct)::int AS recent_ok,
            COUNT(*) FILTER (WHERE answered_at <  NOW() - ($2 || ' days')::interval)::int AS prior_n,
            COUNT(*) FILTER (WHERE answered_at <  NOW() - ($2 || ' days')::interval AND is_correct)::int AS prior_ok
     FROM (
       SELECT DISTINCT ON (student_id, question_id) student_id, question_id, is_correct, answered_at
       FROM pdf_quiz_answers WHERE student_id = ANY($1::int[])
       ORDER BY student_id, question_id, answered_at ASC
     ) f
     WHERE answered_at >= NOW() - ($2 || ' days')::interval * 2
     GROUP BY student_id`,
    [ids, String(COMPARE_DAYS)]
  );
  const quizBy = new Map(firsts.map(r => [r.student_id, r]));
  const checkinsBy = new Map();
  for (const c of checkins) (checkinsBy.get(c.student_id) || checkinsBy.set(c.student_id, []).get(c.student_id)).push(c);

  const recentFrom = addDays(thisWeek, -7 * 3); // 最近 4 週（含本週）
  const priorFrom  = addDays(thisWeek, -7 * 7); // 再之前 4 週

  const result = [];
  for (const s of students) {
    const reasons = [];
    const list = checkinsBy.get(s.id) || [];

    // 打卡：排除「這週沒做單」（中性），看最近 3 次
    const traded = list.filter(c => c.followed_plan !== 'no_trade');
    const lastN = traded.slice(0, PLAN_STREAK_MIN);
    if (lastN.length === PLAN_STREAK_MIN && lastN.every(c => c.followed_plan === 'yes')
        && lastN[0].week_start >= addDays(thisWeek, -7)) {
      const earlierNo = traded.slice(PLAN_STREAK_MIN).filter(c => c.followed_plan === 'no' && c.week_start >= addDays(thisWeek, -7 * 12));
      if (earlierNo.length) {
        reasons.push({ kind: 'plan', text: `最近 ${PLAN_STREAK_MIN} 次打卡都有照計畫做單（之前 12 週有 ${earlierNo.length} 次沒照計畫）` });
      }
    }

    // 測驗首答答對率
    const q = quizBy.get(s.id);
    if (q && q.recent_n >= QUIZ_MIN_ANSWERS && q.prior_n >= QUIZ_MIN_ANSWERS) {
      const prior = q.prior_ok / q.prior_n, recent = q.recent_ok / q.recent_n;
      if (recent - prior >= QUIZ_RATE_GAIN) {
        reasons.push({ kind: 'quiz', text: `測驗首次答對率 ${Math.round(prior * 100)}% → ${Math.round(recent * 100)}%` });
      }
    }
    if (!reasons.length) continue;

    // 心情：只當參考顯示
    const avg = arr => arr.length ? arr.reduce((a, c) => a + c.mood, 0) / arr.length : null;
    const moodRecent = avg(list.filter(c => c.week_start >= recentFrom));
    const moodPrior  = avg(list.filter(c => c.week_start >= priorFrom && c.week_start < recentFrom));
    const planCount = arr => `${arr.filter(c => c.followed_plan === 'yes').length}/${arr.length}`;

    result.push({
      student_id: s.id, name: s.name, email: s.email, case_consent: s.case_consent || 'none',
      reasons,
      plan_prior: planCount(list.filter(c => c.week_start >= priorFrom && c.week_start < recentFrom)),
      plan_recent: planCount(list.filter(c => c.week_start >= recentFrom)),
      mood_prior: moodPrior, mood_recent: moodRecent,
    });
  }
  return result;
}

// ── 單一學員明細：各篇測驗、最近 8 週打卡、最後活動 ──
export async function studentDetail(studentId) {
  const { rows: st } = await pool.query(
    `SELECT id, name, email, last_seen_at, case_consent, exclude_from_tracking FROM pdf_students WHERE id = $1`, [studentId]
  );
  if (!st.length) return null;

  const { rows: quiz } = await pool.query(
    `SELECT a.pdf_id, p.title AS pdf_title, sr.name AS series_name,
            COUNT(DISTINCT a.question_id)::int AS questions_answered,
            COUNT(DISTINCT a.question_id) FILTER (WHERE a.is_correct)::int AS questions_correct,
            COUNT(*) FILTER (WHERE NOT a.is_correct)::int AS wrong_total,
            MAX(a.answered_at) AS last_answered_at
     FROM pdf_quiz_answers a
     JOIN pdf_pdfs p ON p.id = a.pdf_id
     LEFT JOIN pdf_series sr ON sr.id = p.series_id
     WHERE a.student_id = $1
     GROUP BY a.pdf_id, p.title, sr.name, sr.sort_order, p.episode_no
     ORDER BY sr.sort_order ASC NULLS LAST, p.episode_no ASC`,
    [studentId]
  );
  const { rows: wrongQs } = await pool.query(
    `SELECT a.pdf_id, q.question, COUNT(*)::int AS wrong_count
     FROM pdf_quiz_answers a JOIN pdf_quiz_questions q ON q.id = a.question_id
     WHERE a.student_id = $1 AND NOT a.is_correct
     GROUP BY a.pdf_id, q.id, q.question ORDER BY wrong_count DESC`,
    [studentId]
  );
  for (const r of quiz) r.wrong_questions = wrongQs.filter(w => w.pdf_id === r.pdf_id);

  const thisWeek = await currentWeekStart();
  const { rows: checkins } = await pool.query(
    `SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start, followed_plan, mood
     FROM pdf_checkins WHERE student_id = $1 AND week_start > $2::date - INTERVAL '8 weeks'
     ORDER BY week_start ASC`,
    [studentId, thisWeek]
  );
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const w = addDays(thisWeek, -7 * i);
    weeks.push({ week_start: w, checkin: checkins.find(c => c.week_start === w) || null });
  }
  return { student: st[0], quiz, weeks };
}
