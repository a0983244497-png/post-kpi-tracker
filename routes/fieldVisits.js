import express from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import pool from '../db.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function configureCloudinary() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

function requireManager(req, res, next) {
  const mgr = process.env.MANAGER_PASSWORD;
  if (!mgr) return res.status(500).json({ error: 'MANAGER_PASSWORD 未設定' });
  const provided = req.headers['x-manager-key'];
  if (provided !== mgr) return res.status(403).json({ error: '需要主管權限' });
  next();
}

// ── GET /api/field-visits ─────────────────────────────────
router.get('/field-visits', async (req, res) => {
  try {
    const { staff_name, date } = req.query;
    const conditions = [];
    const params     = [];
    if (staff_name) { params.push(staff_name); conditions.push(`staff_name = $${params.length}`); }
    if (date)       { params.push(date);        conditions.push(`visit_date = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT * FROM field_visits ${where} ORDER BY created_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error('[FieldVisits] GET:', e.message);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// ── GET /api/field-visits/pending-review ─────────────────
// 主管專用：notify_manager=true 且 manager_reviewed=false
router.get('/field-visits/pending-review', requireManager, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM field_visits
       WHERE notify_manager = TRUE AND manager_reviewed = FALSE
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) {
    console.error('[FieldVisits] pending-review:', e.message);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// ── GET /api/field-visits/pending-count ──────────────────
// 主管專用：未確認筆數
router.get('/field-visits/pending-count', requireManager, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM field_visits
       WHERE notify_manager = TRUE AND manager_reviewed = FALSE`
    );
    res.json({ count: rows[0].count });
  } catch (e) {
    console.error('[FieldVisits] pending-count:', e.message);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// ── POST /api/field-visits ────────────────────────────────
router.post('/field-visits', async (req, res) => {
  const {
    staff_name,
    client_name = '', purpose = '', notes = '', visit_date,
    planned_depart_time = null, planned_return_time = null,
    notify_manager = false,
  } = req.body;
  if (!staff_name) return res.status(400).json({ error: 'staff_name 必填' });
  try {
    const twToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `INSERT INTO field_visits
         (staff_name, visit_date, client_name, purpose, notes,
          planned_depart_time, planned_return_time, notify_manager)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [staff_name, visit_date || twToday, client_name, purpose, notes,
       planned_depart_time || null, planned_return_time || null, !!notify_manager]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[FieldVisits] POST:', e.message);
    res.status(500).json({ error: '新增失敗' });
  }
});

// ── PATCH /api/field-visits/:id ──────────────────────────
router.patch('/field-visits/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  const allowed = ['client_name', 'purpose', 'notes', 'planned_depart_time', 'planned_return_time', 'notify_manager'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      params.push(req.body[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: '無可更新欄位' });
  params.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE field_visits SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: '找不到記錄' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[FieldVisits] PATCH:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

// ── POST /api/field-visits/:id/depart ────────────────────
router.post('/field-visits/:id/depart', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  try {
    const { rows } = await pool.query(
      `UPDATE field_visits SET depart_time = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: '找不到記錄' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[FieldVisits] depart:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

// ── POST /api/field-visits/:id/arrive ────────────────────
router.post('/field-visits/:id/arrive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  const { lat, lng, address = '' } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE field_visits
       SET arrive_time = NOW(), arrive_lat = $2, arrive_lng = $3, arrive_address = $4, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, lat || null, lng || null, address]
    );
    if (!rows.length) return res.status(404).json({ error: '找不到記錄' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[FieldVisits] arrive:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

// ── POST /api/field-visits/:id/complete ──────────────────
router.post('/field-visits/:id/complete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  const { notes } = req.body;
  try {
    const sets = notes !== undefined
      ? 'complete_time = NOW(), status = $2, notes = $3, updated_at = NOW()'
      : 'complete_time = NOW(), status = $2, updated_at = NOW()';
    const params = notes !== undefined
      ? [id, 'completed', notes]
      : [id, 'completed'];
    const { rows } = await pool.query(
      `UPDATE field_visits SET ${sets} WHERE id = $1 RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: '找不到記錄' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[FieldVisits] complete:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

// ── POST /api/field-visits/:id/review ────────────────────
// 主管確認
router.post('/field-visits/:id/review', requireManager, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  try {
    const { rows } = await pool.query(
      `UPDATE field_visits
       SET manager_reviewed = TRUE, manager_reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: '找不到記錄' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[FieldVisits] review:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

// ── POST /api/field-visits/:id/photos ────────────────────
router.post('/field-visits/:id/photos', upload.single('photo'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  if (!req.file) return res.status(400).json({ error: '未收到圖片' });

  configureCloudinary();
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return res.status(500).json({ error: 'Cloudinary 環境變數未設定' });
  }

  try {
    const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const result = await cloudinary.uploader.upload(b64, {
      folder: 'field-visits',
      resource_type: 'image',
    });

    const { rows } = await pool.query(
      `UPDATE field_visits
       SET photo_urls = photo_urls || $2::jsonb, updated_at = NOW()
       WHERE id = $1 RETURNING photo_urls`,
      [id, JSON.stringify([result.secure_url])]
    );
    if (!rows.length) return res.status(404).json({ error: '找不到記錄' });
    res.json({ url: result.secure_url, photo_urls: rows[0].photo_urls });
  } catch (e) {
    console.error('[FieldVisits] photo upload:', e.message);
    res.status(500).json({ error: '上傳失敗：' + e.message });
  }
});

// ── DELETE /api/field-visits/:id ─────────────────────────
router.delete('/field-visits/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  try {
    await pool.query('DELETE FROM field_visits WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[FieldVisits] DELETE:', e.message);
    res.status(500).json({ error: '刪除失敗' });
  }
});

export default router;
