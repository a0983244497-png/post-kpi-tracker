import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import pool from '../db.js';
import { listAccessiblePdfs, getStudentForAccess, applyDepositUpdate } from '../lib/courseAccess.js';
import { touchLastSeen, currentWeekStart, checkinStreak, listStuck, listInactive, listImproving, studentDetail } from '../lib/tracking.js';

const router = express.Router();

// ── PDF 實體檔案儲存（Railway Volume，本機開發可用 PDF_STORAGE_DIR 覆蓋）──
const PDF_STORAGE_DIR = process.env.PDF_STORAGE_DIR || '/data/pdfs';
fs.mkdirSync(PDF_STORAGE_DIR, { recursive: true });

const pdfUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PDF_STORAGE_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${randomUUID()}.pdf`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('只接受 PDF 檔案'));
    cb(null, true);
  },
});

function requireManager(req, res, next) {
  const mgr = process.env.MANAGER_PASSWORD;
  if (!mgr) return res.status(500).json({ error: 'MANAGER_PASSWORD 未設定' });
  const provided = req.headers['x-manager-key'];
  if (provided !== mgr) return res.status(403).json({ error: '需要主管權限' });
  next();
}

function requireStudent(req, res, next) {
  if (!req.session || !req.session.studentId) return res.status(401).json({ error: '請先登入' });
  next();
}

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

// ── 學員登入 ────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(401).json({ error: '帳號或密碼錯誤' });
    const { rows } = await pool.query(
      `SELECT * FROM pdf_students WHERE LOWER(TRIM(email)) = $1 AND status = 'active'`,
      [norm(email)]
    );
    if (!rows.length || norm(rows[0].tv_name) !== norm(password)) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }
    req.session.studentId = rows[0].id;
    touchLastSeen(rows[0].id);
    res.json({ id: rows[0].id, email: rows[0].email, name: rows[0].name, tv_name: rows[0].tv_name });
  } catch (e) {
    console.error('[Course] login:', e.message);
    res.status(500).json({ error: '登入失敗' });
  }
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', requireStudent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, name, tv_name, status FROM pdf_students WHERE id = $1`,
      [req.session.studentId]
    );
    if (!rows.length) return res.status(401).json({ error: '請先登入' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[Course] me:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

router.get('/my-pdfs', requireStudent, async (req, res) => {
  try {
    const student = await getStudentForAccess(req.session.studentId);
    if (!student) return res.status(401).json({ error: '請先登入' });
    touchLastSeen(student.id);
    res.json(await listAccessiblePdfs(student));
  } catch (e) {
    console.error('[Course] my-pdfs:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── 觀看進度 ────────────────────────────────────────────────
// GET：目前學員所有已看完的 pdf_id
router.get('/progress', requireStudent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pdf_id FROM pdf_progress WHERE student_id = $1 ORDER BY completed_at ASC`,
      [req.session.studentId]
    );
    res.json({ pdf_ids: rows.map(r => r.pdf_id) });
  } catch (e) {
    console.error('[Course] progress get:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// POST：標記已看完（先用現有存取邏輯確認有權限才記錄）
router.post('/progress', requireStudent, async (req, res) => {
  const pdfId = parseInt(req.body?.pdf_id);
  if (!Number.isInteger(pdfId)) return res.status(400).json({ error: '缺少 pdf_id' });
  try {
    const student = await getStudentForAccess(req.session.studentId);
    if (!student) return res.status(401).json({ error: '請先登入' });
    const allowed = (await listAccessiblePdfs(student)).some(p => p.id === pdfId);
    if (!allowed) return res.status(403).json({ error: '無權限存取此檔案' });

    const { rows } = await pool.query(
      `INSERT INTO pdf_progress (student_id, pdf_id, completed_at) VALUES ($1,$2,NOW())
       ON CONFLICT (student_id, pdf_id) DO UPDATE SET completed_at = NOW()
       RETURNING pdf_id, completed_at`,
      [student.id, pdfId]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[Course] progress post:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// GET /api/course/pdf/:id/file — 實際吐 PDF 位元流，必須先驗證登入 + 開通權限
router.get('/pdf/:id/file', requireStudent, async (req, res) => {
  const pdfId = parseInt(req.params.id);
  try {
    const student = await getStudentForAccess(req.session.studentId);
    if (!student) return res.status(401).json({ error: '請先登入' });
    const pdf = (await listAccessiblePdfs(student)).find(p => p.id === pdfId);
    if (!pdf) return res.status(403).json({ error: '無權限存取此檔案' });
    touchLastSeen(student.id);

    const filename = path.basename(pdf.file_url || '');
    const filePath = path.join(PDF_STORAGE_DIR, filename);
    if (!filename || !fs.existsSync(filePath)) return res.status(404).json({ error: '檔案不存在' });

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline');
    res.set('Cache-Control', 'no-store');
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error('[Course] pdf file:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── 課後小測驗（學員端）────────────────────────────────────
// 正確答案只在答對後才給，答錯只回「錯」＋解釋，讓學員再想一次（「卡住」才有意義）
async function requirePdfAccess(req, res, pdfId) {
  const student = await getStudentForAccess(req.session.studentId);
  if (!student) { res.status(401).json({ error: '請先登入' }); return null; }
  const allowed = (await listAccessiblePdfs(student)).some(p => p.id === pdfId);
  if (!allowed) { res.status(403).json({ error: '無權限存取此檔案' }); return null; }
  return student;
}

router.get('/quiz/:pdfId', requireStudent, async (req, res) => {
  const pdfId = parseInt(req.params.pdfId);
  if (!Number.isInteger(pdfId)) return res.status(400).json({ error: '缺少 pdf_id' });
  try {
    const student = await requirePdfAccess(req, res, pdfId);
    if (!student) return;
    const { rows: qs } = await pool.query(
      `SELECT id, question, options, correct_index, explanation FROM pdf_quiz_questions
       WHERE pdf_id = $1 AND is_active ORDER BY sort_order ASC, id ASC`,
      [pdfId]
    );
    const { rows: last } = await pool.query(
      `SELECT DISTINCT ON (question_id) question_id, chosen_index, is_correct
       FROM pdf_quiz_answers WHERE student_id = $1 AND pdf_id = $2
       ORDER BY question_id, answered_at DESC`,
      [student.id, pdfId]
    );
    const lastBy = new Map(last.map(r => [r.question_id, r]));
    res.json({
      questions: qs.map(q => {
        const l = lastBy.get(q.id);
        return {
          id: q.id, question: q.question, options: q.options,
          last: l ? {
            chosen_index: l.chosen_index, is_correct: l.is_correct,
            explanation: q.explanation,
            correct_index: l.is_correct ? q.correct_index : null,
          } : null,
        };
      }),
    });
  } catch (e) {
    console.error('[Course] quiz get:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

router.post('/quiz/:pdfId/answer', requireStudent, async (req, res) => {
  const pdfId = parseInt(req.params.pdfId);
  const questionId = parseInt(req.body?.question_id);
  const chosen = parseInt(req.body?.chosen_index);
  if (![pdfId, questionId, chosen].every(Number.isInteger)) return res.status(400).json({ error: '缺少作答資料' });
  try {
    const student = await requirePdfAccess(req, res, pdfId);
    if (!student) return;
    const { rows } = await pool.query(
      `SELECT options, correct_index, explanation FROM pdf_quiz_questions WHERE id = $1 AND pdf_id = $2 AND is_active`,
      [questionId, pdfId]
    );
    if (!rows.length) return res.status(404).json({ error: '題目不存在' });
    const q = rows[0];
    if (chosen < 0 || chosen >= q.options.length) return res.status(400).json({ error: '選項不存在' });

    const isCorrect = chosen === q.correct_index;
    await pool.query(
      `INSERT INTO pdf_quiz_answers (student_id, pdf_id, question_id, chosen_index, is_correct) VALUES ($1,$2,$3,$4,$5)`,
      [student.id, pdfId, questionId, chosen, isCorrect]
    );
    touchLastSeen(student.id);
    res.json({ is_correct: isCorrect, correct_index: isCorrect ? q.correct_index : null, explanation: q.explanation });
  } catch (e) {
    console.error('[Course] quiz answer:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── 每週打卡（學員端）：一週一筆，同週再送 = 修改；週一 00:00 台灣時間換週 ──
async function checkinPayload(studentId) {
  const weekStart = await currentWeekStart();
  const { rows } = await pool.query(
    `SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start, followed_plan, mood
     FROM pdf_checkins WHERE student_id = $1 ORDER BY week_start DESC LIMIT 60`,
    [studentId]
  );
  const current = rows.find(r => r.week_start === weekStart) || null;
  return {
    week_start: weekStart,
    checkin: current ? { followed_plan: current.followed_plan, mood: current.mood } : null,
    streak: checkinStreak(rows.map(r => r.week_start), weekStart),
  };
}

router.get('/checkin/current', requireStudent, async (req, res) => {
  try {
    res.json(await checkinPayload(req.session.studentId));
  } catch (e) {
    console.error('[Course] checkin get:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

router.put('/checkin/current', requireStudent, async (req, res) => {
  const plan = req.body?.followed_plan;
  const mood = parseInt(req.body?.mood);
  if (!['yes', 'no', 'no_trade'].includes(plan)) return res.status(400).json({ error: '請選擇這週有沒有照計畫做單' });
  if (!(mood >= 1 && mood <= 5)) return res.status(400).json({ error: '請選擇心情分數 1～5' });
  try {
    const weekStart = await currentWeekStart();
    await pool.query(
      `INSERT INTO pdf_checkins (student_id, week_start, followed_plan, mood) VALUES ($1,$2,$3,$4)
       ON CONFLICT (student_id, week_start) DO UPDATE SET followed_plan = $3, mood = $4, updated_at = NOW()`,
      [req.session.studentId, weekStart, plan, mood]
    );
    touchLastSeen(req.session.studentId);
    res.json(await checkinPayload(req.session.studentId));
  } catch (e) {
    console.error('[Course] checkin put:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── 申請開通 ────────────────────────────────────────────────
router.post('/apply', async (req, res) => {
  try {
    const { email, name, tv_name, note } = req.body;
    if (!email || !name || !tv_name) return res.status(400).json({ error: '請填寫完整資料' });
    const emailNorm = norm(email);

    const { rows: existingStudent } = await pool.query(
      `SELECT id FROM pdf_students WHERE LOWER(TRIM(email)) = $1`, [emailNorm]
    );
    if (existingStudent.length) {
      return res.status(400).json({ error: '此 email 已註冊或已在審核中' });
    }
    const { rows: pendingApp } = await pool.query(
      `SELECT id FROM pdf_applications WHERE LOWER(TRIM(email)) = $1 AND status = 'pending'`, [emailNorm]
    );
    if (pendingApp.length) {
      return res.status(400).json({ error: '此 email 已註冊或已在審核中' });
    }

    const { rows } = await pool.query(
      `INSERT INTO pdf_applications (email, name, tv_name, note) VALUES ($1,$2,$3,$4) RETURNING *`,
      [email.trim(), name.trim(), tv_name.trim(), (note || '').trim()]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[Course] apply:', e.message);
    res.status(500).json({ error: '申請失敗' });
  }
});

// ── 管理端：名單匯入 ────────────────────────────────────────
router.post('/admin/import', requireManager, async (req, res) => {
  try {
    const { csv } = req.body;
    if (!csv || typeof csv !== 'string') return res.status(400).json({ error: '請提供 CSV 內容' });

    const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
    let created = 0, skipped = 0;

    for (const line of lines) {
      const parts = line.split(',').map(s => s.trim());
      const [name, email, tv_name] = parts;
      if (!name || !email || !tv_name || !email.includes('@')) { skipped++; continue; }

      const { rows: existing } = await pool.query(
        `SELECT id FROM pdf_students WHERE LOWER(TRIM(email)) = $1`, [norm(email)]
      );
      if (existing.length) { skipped++; continue; }

      await pool.query(
        `INSERT INTO pdf_students (email, name, tv_name, source, is_override) VALUES ($1,$2,$3,'import',true)`,
        [email, name, tv_name]
      );
      created++;
    }

    res.json({ created, skipped });
  } catch (e) {
    console.error('[Course] import:', e.message);
    res.status(500).json({ error: '匯入失敗' });
  }
});

// ── 管理端：學員列表（?q= 依姓名/email 模糊搜尋、?page / ?pageSize 分頁）──
router.get('/admin/students', requireManager, async (req, res) => {
  try {
    const { q } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(1000, Math.max(1, parseInt(req.query.pageSize) || 20));
    const params = [];
    let where = '';
    if (q) { params.push(`%${q}%`); where = 'WHERE name ILIKE $1 OR email ILIKE $1'; }

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM pdf_students ${where}`, params
    );
    const total = countRows[0].total;

    params.push(pageSize, (page - 1) * pageSize);
    const { rows } = await pool.query(
      `SELECT * FROM pdf_students ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // ?with_progress=1：逐人補上學習進度（學員列表用；登入檢查、權限搜尋不帶，避免每次輸入都重算）
    //   total     = 目前可看篇數（listAccessiblePdfs）
    //   completed = 已完成且目前仍可看的篇數（不會超過 100%）
    if (req.query.with_progress === '1' && rows.length) {
      const { rows: prog } = await pool.query(
        `SELECT student_id, pdf_id FROM pdf_progress WHERE student_id = ANY($1::int[])`,
        [rows.map(r => r.id)]
      );
      const doneByStudent = {};
      for (const p of prog) (doneByStudent[p.student_id] ||= new Set()).add(p.pdf_id);
      for (const s of rows) {
        const accessible = await listAccessiblePdfs(s);
        const done = doneByStudent[s.id] || new Set();
        s.total = accessible.length;
        s.completed = accessible.filter(p => done.has(p.id)).length;
      }
    }

    res.json({ students: rows, total, page, pageSize });
  } catch (e) {
    console.error('[Course] admin/students:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── 管理端：更新學員（姓名 / email / TV 名稱 / 狀態）──────
router.patch('/admin/students/:id', requireManager, async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, email, tv_name, status, case_consent, exclude_from_tracking } = req.body;
  if (case_consent !== undefined && !['none', 'asked', 'agreed', 'declined'].includes(case_consent)) {
    return res.status(400).json({ error: 'case_consent 不正確' });
  }
  try {
    if (email !== undefined) {
      const { rows: dup } = await pool.query(
        `SELECT id FROM pdf_students WHERE LOWER(TRIM(email)) = $1 AND id <> $2`,
        [norm(email), id]
      );
      if (dup.length) return res.status(400).json({ error: '此 email 已被其他學員使用' });
    }

    const updates = [];
    const params = [];
    if (name !== undefined)    { params.push(String(name).trim());    updates.push(`name = $${params.length}`); }
    if (email !== undefined)   { params.push(String(email).trim());   updates.push(`email = $${params.length}`); }
    if (tv_name !== undefined) { params.push(String(tv_name).trim()); updates.push(`tv_name = $${params.length}`); }
    if (status !== undefined)  { params.push(String(status).trim());  updates.push(`status = $${params.length}`); }
    if (case_consent !== undefined)          { params.push(case_consent);                  updates.push(`case_consent = $${params.length}`); }
    if (exclude_from_tracking !== undefined) { params.push(Boolean(exclude_from_tracking)); updates.push(`exclude_from_tracking = $${params.length}`); }
    if (!updates.length) return res.status(400).json({ error: '沒有可更新的欄位' });
    params.push(id);

    const { rows } = await pool.query(
      `UPDATE pdf_students SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: '學員不存在' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[Course] student patch:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

// ── 管理端：更新學員入金資金（跨級才寬限，邏輯見 lib/courseAccess.js applyDepositUpdate）──
function parseDeposit(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

router.patch('/admin/students/:id/deposit', requireManager, async (req, res) => {
  const id = parseInt(req.params.id);
  const D = parseDeposit(req.body?.deposit_usd);
  if (D === null) return res.status(400).json({ error: 'deposit_usd 必須是 ≥ 0 的數字' });
  try {
    const student = await applyDepositUpdate(id, D);
    if (!student) return res.status(404).json({ error: '學員不存在' });
    res.json(student);
  } catch (e) {
    console.error('[Course] deposit patch:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

// ── 管理端：批次匯入入金（只更新既有學員，不新建）────────────────
// 每行：email,入金  或  姓名,email,入金
// 解析以「含 @ 的欄位」為 email 錨點：前面是姓名（不使用），後面全部接起來去逗號/空白當金額，
// 所以 a@b.com,2,500 → 2500；第一行若沒有 email 視為標題略過
router.post('/admin/students/deposit/import', requireManager, async (req, res) => {
  try {
    const { csv } = req.body;
    if (!csv || typeof csv !== 'string') return res.status(400).json({ error: '請提供 CSV 內容' });

    const lines = csv.split('\n');
    let success = 0;
    const skipped = [];
    const errors = [];
    let seenData = false;

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(',').map(s => s.trim());
      const emailIdx = parts.findIndex(p => p.includes('@'));
      if (emailIdx === -1) {
        if (!seenData) { seenData = true; continue; } // 標題行，例如「email,入金」
        errors.push({ line: lineNo, reason: '找不到 email（沒有含 @ 的欄位）' });
        continue;
      }
      seenData = true;

      const email = parts[emailIdx];
      const amountShown = parts.slice(emailIdx + 1).join(',');
      const amountRaw = amountShown.replace(/[,\s]/g, '');
      if (!amountRaw) {
        errors.push({ line: lineNo, email, reason: '缺少入金金額' });
        continue;
      }
      const D = parseDeposit(amountRaw);
      if (D === null) {
        errors.push({ line: lineNo, email, reason: `入金「${amountShown}」不是 ≥ 0 的數字` });
        continue;
      }

      const { rows: found } = await pool.query(
        `SELECT id FROM pdf_students WHERE LOWER(TRIM(email)) = $1`, [norm(email)]
      );
      if (!found.length) {
        skipped.push({ line: lineNo, email, reason: '找不到 email' });
        continue;
      }

      await applyDepositUpdate(found[0].id, D);
      success++;
    }

    res.json({ success, skipped, errors });
  } catch (e) {
    console.error('[Course] deposit import:', e.message);
    res.status(500).json({ error: '匯入失敗' });
  }
});

// ── 管理端：等級對照表 ───────────────────────────────────────
async function loadTiers() {
  const { rows: tiers } = await pool.query(
    `SELECT id, name, min_deposit_usd, sort_order FROM tiers ORDER BY sort_order ASC, id ASC`
  );
  const { rows: maps } = await pool.query(
    `SELECT ts.tier_id, s.id, s.name
     FROM tier_series ts JOIN pdf_series s ON s.id = ts.series_id
     ORDER BY s.sort_order ASC, s.id ASC`
  );
  return tiers.map(t => ({
    ...t,
    min_deposit_usd: parseFloat(t.min_deposit_usd),
    series: maps.filter(m => m.tier_id === t.id).map(m => ({ id: m.id, name: m.name })),
  }));
}

router.get('/admin/tiers', requireManager, async (req, res) => {
  try {
    res.json(await loadTiers());
  } catch (e) {
    console.error('[Course] tiers get:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// body: { tiers: [{ id, min_deposit_usd, series_ids?: number[] }] }
// series_ids 有帶才整組取代該 tier 的對應系列；權限即時推算，改完不需重算
router.put('/admin/tiers', requireManager, async (req, res) => {
  const input = req.body?.tiers;
  if (!Array.isArray(input) || !input.length) return res.status(400).json({ error: '請提供 tiers 陣列' });

  const updates = [];
  for (const t of input) {
    const id = parseInt(t?.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'tier id 無效' });
    const min = parseDeposit(t.min_deposit_usd);
    if (min === null) return res.status(400).json({ error: `tier ${id} 的 min_deposit_usd 必須是 ≥ 0 的數字` });
    let seriesIds;
    if (t.series_ids !== undefined) {
      if (!Array.isArray(t.series_ids)) return res.status(400).json({ error: `tier ${id} 的 series_ids 必須是陣列` });
      seriesIds = [...new Set(t.series_ids.map(Number))];
      if (seriesIds.some(n => !Number.isInteger(n) || n <= 0)) {
        return res.status(400).json({ error: `tier ${id} 的 series_ids 含無效值` });
      }
    }
    updates.push({ id, min, seriesIds });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const allSeriesIds = [...new Set(updates.flatMap(u => u.seriesIds || []))];
    if (allSeriesIds.length) {
      const { rows } = await client.query(`SELECT id FROM pdf_series WHERE id = ANY($1::int[])`, [allSeriesIds]);
      const existing = new Set(rows.map(r => r.id));
      const missing = allSeriesIds.filter(n => !existing.has(n));
      if (missing.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `系列不存在：${missing.join(', ')}` });
      }
    }

    for (const u of updates) {
      const { rowCount } = await client.query(
        `UPDATE tiers SET min_deposit_usd = $1 WHERE id = $2`, [u.min, u.id]
      );
      if (!rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `tier ${u.id} 不存在` });
      }
      if (u.seriesIds) {
        await client.query(`DELETE FROM tier_series WHERE tier_id = $1`, [u.id]);
        for (const sid of u.seriesIds) {
          await client.query(`INSERT INTO tier_series (tier_id, series_id) VALUES ($1,$2)`, [u.id, sid]);
        }
      }
    }

    await client.query('COMMIT');
    res.json(await loadTiers());
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Course] tiers put:', e.message);
    res.status(500).json({ error: '更新失敗' });
  } finally {
    client.release();
  }
});

// ── 管理端：切換 override（手動開通 / 依入金自動）─────────────
//   true  → 只改旗標，pdf_access 不動（手動開通仍由逐篇/逐系列 toggle 管理）
//   false → 切回自動，access_deposit_usd 對齊目前入金並取消寬限，立即依入金取得權限
router.post('/admin/students/:id/override', requireManager, async (req, res) => {
  const id = parseInt(req.params.id);
  const { is_override } = req.body || {};
  if (typeof is_override !== 'boolean') return res.status(400).json({ error: 'is_override 必須是 true 或 false' });
  try {
    const { rows } = await pool.query(
      is_override
        ? `UPDATE pdf_students SET is_override = true WHERE id = $1 RETURNING *`
        : `UPDATE pdf_students
           SET is_override = false, access_deposit_usd = deposit_usd, grace_until = NULL
           WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: '學員不存在' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[Course] override toggle:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

// ── 管理端：刪除學員（連帶清除該學員的 pdf_access 紀錄）──────
router.delete('/admin/students/:id', requireManager, async (req, res) => {
  const id = parseInt(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM pdf_access WHERE student_id = $1`, [id]);
    const { rows } = await client.query(`DELETE FROM pdf_students WHERE id = $1 RETURNING *`, [id]);
    await client.query('COMMIT');
    if (!rows.length) return res.status(404).json({ error: '學員不存在' });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[Course] student delete:', e.message);
    res.status(500).json({ error: '刪除失敗' });
  } finally {
    client.release();
  }
});

// ── 管理端：申請列表 ────────────────────────────────────────
router.get('/admin/applications', requireManager, async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = 'WHERE status = $1'; }
    const { rows } = await pool.query(
      `SELECT * FROM pdf_applications ${where} ORDER BY created_at DESC`, params
    );
    res.json(rows);
  } catch (e) {
    console.error('[Course] admin/applications:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

router.post('/admin/applications/:id/approve', requireManager, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rows: appRows } = await pool.query(
      `SELECT * FROM pdf_applications WHERE id = $1 AND status = 'pending'`, [id]
    );
    if (!appRows.length) return res.status(404).json({ error: '申請不存在或已處理' });
    const application = appRows[0];

    const { rows: existing } = await pool.query(
      `SELECT id FROM pdf_students WHERE LOWER(TRIM(email)) = $1`, [norm(application.email)]
    );
    if (!existing.length) {
      await pool.query(
        `INSERT INTO pdf_students (email, name, tv_name, source, is_override) VALUES ($1,$2,$3,'application',true)`,
        [application.email, application.name, application.tv_name]
      );
    }
    await pool.query(`UPDATE pdf_applications SET status = 'approved' WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Course] approve:', e.message);
    res.status(500).json({ error: '審核失敗' });
  }
});

router.post('/admin/applications/:id/reject', requireManager, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE pdf_applications SET status = 'rejected' WHERE id = $1 AND status = 'pending' RETURNING *`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: '申請不存在或已處理' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Course] reject:', e.message);
    res.status(500).json({ error: '審核失敗' });
  }
});

// ── 管理端：PDF 列表 ────────────────────────────────────────
router.get('/admin/pdfs', requireManager, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM pdf_pdfs ORDER BY sort_order ASC, id ASC`);
    res.json(rows);
  } catch (e) {
    console.error('[Course] admin/pdfs:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── 管理端：系列列表（含每個系列底下的 PDF，以及未分類 PDF）──
router.get('/admin/series', requireManager, async (req, res) => {
  try {
    const { rows: seriesRows } = await pool.query(`SELECT * FROM pdf_series ORDER BY sort_order ASC, id ASC`);
    const { rows: pdfRows } = await pool.query(`SELECT * FROM pdf_pdfs ORDER BY episode_no ASC, id ASC`);

    const bySeriesId = {};
    const unclassified = [];
    for (const pdf of pdfRows) {
      if (pdf.series_id === null) { unclassified.push(pdf); continue; }
      (bySeriesId[pdf.series_id] ||= []).push(pdf);
    }

    const series = seriesRows.map(s => ({ ...s, pdfs: bySeriesId[s.id] || [] }));
    res.json({ series, unclassified });
  } catch (e) {
    console.error('[Course] admin/series:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── 管理端：新增系列 ────────────────────────────────────────
router.post('/admin/series', requireManager, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '請輸入系列名稱' });
  try {
    const { rows: maxRows } = await pool.query(`SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM pdf_series`);
    const nextSort = maxRows[0].max_sort + 1;
    const { rows } = await pool.query(
      `INSERT INTO pdf_series (name, sort_order) VALUES ($1,$2) RETURNING *`,
      [name, nextSort]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[Course] admin series create:', e.message);
    res.status(500).json({ error: '新增失敗' });
  }
});

// ── 管理端：PDF 上傳（存 Railway Volume，可選 series_id / episode_no）──
router.post('/admin/pdfs/upload', requireManager, (req, res) => {
  pdfUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || '上傳失敗' });
    if (!req.file) return res.status(400).json({ error: '請選擇 PDF 檔案' });

    const title = (req.body.title || '').trim();
    if (!title) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: '請填寫標題' });
    }

    const seriesId = req.body.series_id ? Number(req.body.series_id) : null;
    const episodeNo = req.body.episode_no ? Number(req.body.episode_no) : 0;

    try {
      const { rows: maxRows } = await pool.query(`SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM pdf_pdfs`);
      const nextSort = maxRows[0].max_sort + 1;
      const { rows } = await pool.query(
        `INSERT INTO pdf_pdfs (title, file_url, sort_order, series_id, episode_no) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [title, req.file.filename, nextSort, seriesId, episodeNo]
      );
      res.json(rows[0]);
    } catch (e) {
      console.error('[Course] pdf upload:', e.message);
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: '儲存失敗' });
    }
  });
});

// ── 管理端：刪除 PDF（一併清除實體檔案、pdf_access 開通紀錄、pdf_pdfs 紀錄）──
router.delete('/admin/pdfs/:id', requireManager, async (req, res) => {
  const id = parseInt(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM pdf_access WHERE pdf_id = $1`, [id]);
    const { rows } = await client.query(`DELETE FROM pdf_pdfs WHERE id = $1 RETURNING *`, [id]);
    await client.query('COMMIT');
    if (!rows.length) return res.status(404).json({ error: 'PDF 不存在' });

    const filename = path.basename(rows[0].file_url || '');
    if (filename) {
      fs.unlink(path.join(PDF_STORAGE_DIR, filename), () => {}); // Volume 內實體檔案，不存在也不報錯
    }
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[Course] pdf delete:', e.message);
    res.status(500).json({ error: '刪除失敗' });
  } finally {
    client.release();
  }
});

// ── 管理端：PDF 原檔預覽（乾淨檢視，key 走 query 參數方便新分頁直接開啟）──
router.get('/admin/pdfs/:id/file', async (req, res) => {
  const mgr = process.env.MANAGER_PASSWORD;
  if (!mgr) return res.status(500).json({ error: 'MANAGER_PASSWORD 未設定' });
  if ((req.query.key || req.headers['x-manager-key']) !== mgr) {
    return res.status(403).json({ error: '需要主管權限' });
  }
  const id = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(`SELECT file_url FROM pdf_pdfs WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'PDF 不存在' });

    const filename = path.basename(rows[0].file_url || '');
    const filePath = path.join(PDF_STORAGE_DIR, filename);
    if (!filename || !fs.existsSync(filePath)) return res.status(404).json({ error: '檔案不存在' });

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline');
    res.set('Cache-Control', 'no-store');
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error('[Course] admin pdf file:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── 管理端：修改 PDF 標題 / 排序 ────────────────────────────
router.patch('/admin/pdfs/:id', requireManager, async (req, res) => {
  const id = parseInt(req.params.id);
  const { title, sort_order } = req.body;
  const updates = [];
  const params = [];
  if (title !== undefined) { params.push(String(title).trim()); updates.push(`title = $${params.length}`); }
  if (sort_order !== undefined) { params.push(Number(sort_order)); updates.push(`sort_order = $${params.length}`); }
  if (!updates.length) return res.status(400).json({ error: '沒有可更新的欄位' });
  params.push(id);

  try {
    const { rows } = await pool.query(
      `UPDATE pdf_pdfs SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'PDF 不存在' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[Course] pdf patch:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

// ── 管理端：把 PDF 指定到某系列 + 設定篇號（手動微調歸位）──
router.patch('/admin/pdfs/:id/series', requireManager, async (req, res) => {
  const id = parseInt(req.params.id);
  const { series_id, episode_no } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE pdf_pdfs SET series_id = $1, episode_no = $2 WHERE id = $3 RETURNING *`,
      [series_id ?? null, Number(episode_no) || 0, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'PDF 不存在' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[Course] pdf series patch:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

// ── 管理端：該學員目前擁有哪些 pdf_id（給「選學員→開通」用）──
router.get('/admin/access/by-student/:studentId', requireManager, async (req, res) => {
  const studentId = parseInt(req.params.studentId);
  try {
    const { rows } = await pool.query(`SELECT pdf_id FROM pdf_access WHERE student_id = $1`, [studentId]);
    res.json({ pdf_ids: rows.map(r => r.pdf_id) });
  } catch (e) {
    console.error('[Course] access by-student:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── 管理端：該系列每個 PDF 分別被哪些 student_id 開通（給「選系列→開通」用）──
router.get('/admin/access/by-series/:seriesId', requireManager, async (req, res) => {
  const seriesId = parseInt(req.params.seriesId);
  try {
    const { rows } = await pool.query(
      `SELECT a.pdf_id, a.student_id
       FROM pdf_access a
       JOIN pdf_pdfs p ON p.id = a.pdf_id
       WHERE p.series_id = $1`,
      [seriesId]
    );
    const byPdf = {};
    for (const row of rows) {
      (byPdf[row.pdf_id] ||= []).push(row.student_id);
    }
    res.json(byPdf);
  } catch (e) {
    console.error('[Course] access by-series:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── 管理端：單筆開通/收回（開關即時操作的核心端點）──────────
router.post('/admin/access/toggle', requireManager, async (req, res) => {
  const { student_id, pdf_id, grant } = req.body;
  if (!student_id || !pdf_id) return res.status(400).json({ error: '缺少 student_id 或 pdf_id' });
  try {
    if (grant) {
      await pool.query(
        `INSERT INTO pdf_access (student_id, pdf_id) VALUES ($1,$2) ON CONFLICT (student_id, pdf_id) DO NOTHING`,
        [student_id, pdf_id]
      );
    } else {
      await pool.query(`DELETE FROM pdf_access WHERE student_id = $1 AND pdf_id = $2`, [student_id, pdf_id]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[Course] access toggle:', e.message);
    res.status(500).json({ error: '操作失敗' });
  }
});

// ── 管理端：整個系列一次開通/收回（迴圈呼叫單筆開關邏輯）────
router.post('/admin/access/toggle-series', requireManager, async (req, res) => {
  const { student_id, series_id, grant } = req.body;
  if (!student_id || !series_id) return res.status(400).json({ error: '缺少 student_id 或 series_id' });
  try {
    const { rows: pdfRows } = await pool.query(`SELECT id FROM pdf_pdfs WHERE series_id = $1`, [series_id]);
    for (const pdf of pdfRows) {
      if (grant) {
        await pool.query(
          `INSERT INTO pdf_access (student_id, pdf_id) VALUES ($1,$2) ON CONFLICT (student_id, pdf_id) DO NOTHING`,
          [student_id, pdf.id]
        );
      } else {
        await pool.query(`DELETE FROM pdf_access WHERE student_id = $1 AND pdf_id = $2`, [student_id, pdf.id]);
      }
    }
    res.json({ ok: true, count: pdfRows.length });
  } catch (e) {
    console.error('[Course] access toggle-series:', e.message);
    res.status(500).json({ error: '操作失敗' });
  }
});

// ── 管理端：權限開通（整批儲存，舊版沿用）──────────────────
router.post('/admin/access', requireManager, async (req, res) => {
  const { student_id, pdf_ids } = req.body;
  if (!student_id) return res.status(400).json({ error: '缺少 student_id' });
  const ids = Array.isArray(pdf_ids) ? pdf_ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM pdf_access WHERE student_id = $1`, [student_id]);
    for (const pdfId of ids) {
      await client.query(
        `INSERT INTO pdf_access (student_id, pdf_id) VALUES ($1,$2) ON CONFLICT (student_id, pdf_id) DO NOTHING`,
        [student_id, pdfId]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: ids.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[Course] access:', e.message);
    res.status(500).json({ error: '設定失敗' });
  } finally {
    client.release();
  }
});

// ── 管理端：課後小測驗出題 ──────────────────────────────────
router.get('/admin/pdfs/:id/quiz', requireManager, async (req, res) => {
  const pdfId = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      `SELECT q.id, q.question, q.options, q.correct_index, q.explanation,
              (SELECT COUNT(*)::int FROM pdf_quiz_answers a WHERE a.question_id = q.id) AS answer_count
       FROM pdf_quiz_questions q WHERE q.pdf_id = $1 AND q.is_active ORDER BY q.sort_order ASC, q.id ASC`,
      [pdfId]
    );
    res.json(rows);
  } catch (e) {
    console.error('[Course] admin quiz get:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// 整組存檔：{ questions: [{ id?, question, options[], correct_index, explanation }] }
// 已有人作答的題目若改了答案或選項數 → 舊題停用、另建新題（舊作答紀錄的對錯才不會失真）；只改文字就直接更新
// 這次沒送上來的舊題：有作答紀錄的停用、沒有的直接刪除
router.put('/admin/pdfs/:id/quiz', requireManager, async (req, res) => {
  const pdfId = parseInt(req.params.id);
  const input = Array.isArray(req.body?.questions) ? req.body.questions : null;
  if (!input) return res.status(400).json({ error: '缺少 questions' });
  if (input.length > 5) return res.status(400).json({ error: '每篇最多 5 題' });

  const clean = [];
  for (const [i, q] of input.entries()) {
    const question = String(q.question || '').trim();
    const options = (Array.isArray(q.options) ? q.options : []).map(o => String(o || '').trim()).filter(Boolean);
    const correct = parseInt(q.correct_index);
    if (!question) return res.status(400).json({ error: `第 ${i + 1} 題沒有題目` });
    if (options.length < 2) return res.status(400).json({ error: `第 ${i + 1} 題至少要 2 個選項` });
    if (!(correct >= 0 && correct < options.length)) return res.status(400).json({ error: `第 ${i + 1} 題請選正確答案` });
    clean.push({ id: parseInt(q.id) || null, question, options, correct_index: correct, explanation: String(q.explanation || '').trim() });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: pdf } = await client.query(`SELECT id FROM pdf_pdfs WHERE id = $1`, [pdfId]);
    if (!pdf.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'PDF 不存在' }); }

    const { rows: existing } = await client.query(
      `SELECT q.*, (SELECT COUNT(*)::int FROM pdf_quiz_answers a WHERE a.question_id = q.id) AS answer_count
       FROM pdf_quiz_questions q WHERE q.pdf_id = $1 AND q.is_active`,
      [pdfId]
    );
    const byId = new Map(existing.map(q => [q.id, q]));
    const kept = new Set();

    for (const [i, q] of clean.entries()) {
      const old = q.id ? byId.get(q.id) : null;
      const answerChanged = old && (old.correct_index !== q.correct_index || old.options.length !== q.options.length);
      if (old && !(old.answer_count > 0 && answerChanged)) {
        kept.add(old.id);
        await client.query(
          `UPDATE pdf_quiz_questions SET sort_order = $1, question = $2, options = $3, correct_index = $4, explanation = $5, updated_at = NOW()
           WHERE id = $6`,
          [i + 1, q.question, JSON.stringify(q.options), q.correct_index, q.explanation, old.id]
        );
      } else {
        await client.query(
          `INSERT INTO pdf_quiz_questions (pdf_id, sort_order, question, options, correct_index, explanation) VALUES ($1,$2,$3,$4,$5,$6)`,
          [pdfId, i + 1, q.question, JSON.stringify(q.options), q.correct_index, q.explanation]
        );
      }
    }
    for (const old of existing) {
      if (kept.has(old.id)) continue;
      if (old.answer_count > 0) await client.query(`UPDATE pdf_quiz_questions SET is_active = false, updated_at = NOW() WHERE id = $1`, [old.id]);
      else await client.query(`DELETE FROM pdf_quiz_questions WHERE id = $1`, [old.id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: clean.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Course] admin quiz put:', e.message);
    res.status(500).json({ error: '儲存失敗' });
  } finally {
    client.release();
  }
});

// 每篇目前的題數（PDF 管理列表顯示「題目 n」用）
router.get('/admin/quiz-counts', requireManager, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pdf_id, COUNT(*)::int AS n FROM pdf_quiz_questions WHERE is_active GROUP BY pdf_id`
    );
    res.json(Object.fromEntries(rows.map(r => [r.pdf_id, r.n])));
  } catch (e) {
    console.error('[Course] admin quiz-counts:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── 管理端：學員追蹤三清單（即時推算，邏輯見 lib/tracking.js）──
const trackingRoutes = { stuck: listStuck, inactive: listInactive, improving: listImproving };
for (const [name, fn] of Object.entries(trackingRoutes)) {
  router.get(`/admin/tracking/${name}`, requireManager, async (req, res) => {
    try {
      res.json(await fn());
    } catch (e) {
      console.error(`[Course] tracking ${name}:`, e.message);
      res.status(500).json({ error: '伺服器錯誤' });
    }
  });
}

router.get('/admin/tracking/students/:id', requireManager, async (req, res) => {
  try {
    const detail = await studentDetail(parseInt(req.params.id));
    if (!detail) return res.status(404).json({ error: '學員不存在' });
    res.json(detail);
  } catch (e) {
    console.error('[Course] tracking detail:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

export default router;
