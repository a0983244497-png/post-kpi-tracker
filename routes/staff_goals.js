import express from 'express';
import pool from '../db.js';

const router = express.Router();

router.get('/staff-goals', async (req, res) => {
  try {
    const { name, week, month } = req.query;
    let q = 'SELECT * FROM staff_goals';
    const params = [], conds = [];
    if (name)  { params.push(name);  conds.push(`staff_name = $${params.length}`); }
    if (week)  { params.push(week);  conds.push(`week_start_date = $${params.length}`); }
    if (month) { params.push(month); conds.push(`goal_month = $${params.length}`); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY COALESCE(goal_month, TO_CHAR(week_start_date,\'YYYY-MM\')) DESC NULLS LAST LIMIT 500';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) {
    console.error('[DB] GET staff-goals:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/staff-goals', async (req, res) => {
  const {
    staff_name,
    goal_month,
    week_start_date    = null,
    period_end         = null,
    target_views       = 0,
    target_leads       = 0,
    target_conversions = 0,
    target_followers   = 0,
  } = req.body;

  const gm = goal_month || (week_start_date ? week_start_date.slice(0, 7) : null);

  if (!staff_name || !gm) {
    return res.status(400).json({ error: '缺少 staff_name 或 goal_month' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO staff_goals
         (staff_name, goal_month, week_start_date, period_end,
          target_views, target_leads, target_conversions, target_followers, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (staff_name, goal_month) WHERE goal_month IS NOT NULL
       DO UPDATE SET
         target_views       = EXCLUDED.target_views,
         target_leads       = EXCLUDED.target_leads,
         target_conversions = EXCLUDED.target_conversions,
         target_followers   = EXCLUDED.target_followers,
         updated_at         = NOW()
       RETURNING *`,
      [staff_name, gm, week_start_date, period_end,
       target_views, target_leads, target_conversions, target_followers]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[DB] POST staff-goals error:', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
