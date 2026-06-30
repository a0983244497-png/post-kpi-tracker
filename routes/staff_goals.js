import express from 'express';
import pool from '../db.js';

const router = express.Router();

router.get('/staff-goals', async (req, res) => {
  try {
    const { name, week } = req.query;
    let q = 'SELECT * FROM staff_goals';
    const params = [], conds = [];
    if (name) { params.push(name); conds.push(`staff_name = $${params.length}`); }
    if (week) { params.push(week); conds.push(`week_start_date = $${params.length}`); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY week_start_date DESC LIMIT 500';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) {
    console.error('[DB] GET staff-goals:', e.message);
    res.status(500).json({ error: '查詢失敗' });
  }
});

router.post('/staff-goals', async (req, res) => {
  const {
    staff_name,
    week_start_date,
    period_end         = null,
    target_views       = 0,
    target_leads       = 0,
    target_conversions = 0,
  } = req.body;
  if (!staff_name || !week_start_date) {
    return res.status(400).json({ error: '缺少 staff_name 或 week_start_date' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO staff_goals (staff_name, week_start_date, period_end, target_views, target_leads, target_conversions)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (staff_name, week_start_date) DO UPDATE SET
         period_end=$3, target_views=$4, target_leads=$5, target_conversions=$6
       RETURNING *`,
      [staff_name, week_start_date, period_end, target_views, target_leads, target_conversions]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[DB] POST staff-goals:', e.message);
    res.status(500).json({ error: '儲存失敗' });
  }
});

export default router;
