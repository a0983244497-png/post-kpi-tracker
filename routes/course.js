import express from 'express';
import pool from '../db.js';

const router = express.Router();

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
    const { rows } = await pool.query(
      `SELECT p.id, p.title, p.file_url, p.sort_order
       FROM pdf_access a
       JOIN pdf_pdfs p ON p.id = a.pdf_id
       WHERE a.student_id = $1
       ORDER BY p.sort_order ASC, p.id ASC`,
      [req.session.studentId]
    );
    res.json(rows);
  } catch (e) {
    console.error('[Course] my-pdfs:', e.message);
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
        `INSERT INTO pdf_students (email, name, tv_name, source) VALUES ($1,$2,$3,'import')`,
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

// ── 管理端：學員列表 ────────────────────────────────────────
router.get('/admin/students', requireManager, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM pdf_students ORDER BY created_at DESC`);
    res.json(rows);
  } catch (e) {
    console.error('[Course] admin/students:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
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
        `INSERT INTO pdf_students (email, name, tv_name, source) VALUES ($1,$2,$3,'application')`,
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

// ── 管理端：PDF 列表（第二階段才有上傳）────────────────────
router.get('/admin/pdfs', requireManager, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM pdf_pdfs ORDER BY sort_order ASC, id ASC`);
    res.json(rows);
  } catch (e) {
    console.error('[Course] admin/pdfs:', e.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── 管理端：權限開通 ────────────────────────────────────────
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

export default router;
