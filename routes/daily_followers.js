import express from 'express';
import pool from '../db.js';

const router = express.Router();

router.get('/daily-followers', async (req, res) => {
  try {
    const { name, from, to } = req.query;
    let q = 'SELECT * FROM daily_followers';
    const params = [], conds = [];
    if (name) { params.push(name); conds.push(`staff_name = $${params.length}`); }
    if (from) { params.push(from); conds.push(`date >= $${params.length}`); }
    if (to)   { params.push(to);   conds.push(`date <= $${params.length}`); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY date ASC LIMIT 730';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) {
    console.error('[DB] GET daily-followers:', e.message);
    res.status(500).json({ error: '查詢失敗' });
  }
});

router.post('/daily-followers', async (req, res) => {
  const { date, staff_name, followers = 0, notes = '' } = req.body;
  if (!date || !staff_name) {
    return res.status(400).json({ error: '缺少 date 或 staff_name' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO daily_followers (date, staff_name, followers, notes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (date, staff_name) DO UPDATE SET followers = $3, notes = $4
       RETURNING *`,
      [date, staff_name, followers, notes]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[DB] POST daily-followers:', e.message);
    res.status(500).json({ error: '儲存失敗' });
  }
});

router.put('/daily-followers/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  const { date, staff_name, followers = 0, notes = '' } = req.body;
  if (!date || !staff_name) {
    return res.status(400).json({ error: '缺少 date 或 staff_name' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE daily_followers SET date=$1, staff_name=$2, followers=$3, notes=$4 WHERE id=$5 RETURNING *`,
      [date, staff_name, followers, notes, id]
    );
    if (!rows.length) return res.status(404).json({ error: '找不到此筆資料' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[DB] PUT daily-followers:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

router.delete('/daily-followers/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  try {
    await pool.query('DELETE FROM daily_followers WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DB] DELETE daily-followers:', e.message);
    res.status(500).json({ error: '刪除失敗' });
  }
});

export default router;
