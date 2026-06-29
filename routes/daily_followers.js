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
  const { date, staff_name, followers = 0 } = req.body;
  if (!date || !staff_name) {
    return res.status(400).json({ error: '缺少 date 或 staff_name' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO daily_followers (date, staff_name, followers)
       VALUES ($1, $2, $3)
       ON CONFLICT (date, staff_name) DO UPDATE SET followers = $3
       RETURNING *`,
      [date, staff_name, followers]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[DB] POST daily-followers:', e.message);
    res.status(500).json({ error: '儲存失敗' });
  }
});

export default router;
