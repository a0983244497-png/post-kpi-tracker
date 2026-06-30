import express from 'express';
import pool from '../db.js';

const router = express.Router();

function dateStr(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0,10) : String(d).slice(0,10);
}
function toClient(row) {
  return {
    ...row,
    week_start_date: dateStr(row.week_start_date),
    start_date:      dateStr(row.start_date),
    end_date:        dateStr(row.end_date),
  };
}

router.get('/staff-goals', async (req, res) => {
  try {
    const { name, month } = req.query;
    let q = 'SELECT * FROM staff_goals';
    const params = [], conds = [];
    if (name)  { params.push(name);  conds.push(`staff_name = $${params.length}`); }
    if (month) { params.push(month); conds.push(`goal_month = $${params.length}`); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY COALESCE(start_date, week_start_date) DESC NULLS LAST LIMIT 500';
    const { rows } = await pool.query(q, params);
    res.json(rows.map(toClient));
  } catch (e) {
    console.error('[DB] GET staff-goals:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/staff-goals', async (req, res) => {
  const {
    staff_name,
    start_date,
    end_date,
    // legacy compat
    goal_month         = null,
    week_start_date    = null,
    target_views       = 0,
    target_leads       = 0,
    target_conversions = 0,
    target_followers   = 0,
  } = req.body;

  // Derive start_date / end_date from legacy fields if not provided
  let sd = start_date;
  let ed = end_date;
  if (!sd && goal_month) {
    const [y, m] = goal_month.split('-').map(Number);
    sd = `${goal_month}-01`;
    ed = new Date(y, m, 0).toISOString().slice(0,10); // last day of month
  } else if (!sd && week_start_date) {
    const d = new Date(week_start_date);
    d.setDate(d.getDate() + 6);
    sd = week_start_date.slice(0,10);
    ed = d.toISOString().slice(0,10);
  }

  // Derive goal_month from start_date for backward-compat columns
  const gm = goal_month || (sd ? sd.slice(0,7) : null);

  if (!staff_name || !sd || !ed) {
    return res.status(400).json({ error: '缺少 staff_name、start_date 或 end_date' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO staff_goals
         (staff_name, start_date, end_date, goal_month, week_start_date,
          target_views, target_leads, target_conversions, target_followers, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (staff_name, start_date, end_date) WHERE start_date IS NOT NULL AND end_date IS NOT NULL
       DO UPDATE SET
         target_views       = EXCLUDED.target_views,
         target_leads       = EXCLUDED.target_leads,
         target_conversions = EXCLUDED.target_conversions,
         target_followers   = EXCLUDED.target_followers,
         goal_month         = EXCLUDED.goal_month,
         updated_at         = NOW()
       RETURNING *`,
      [staff_name, sd, ed, gm, week_start_date,
       target_views, target_leads, target_conversions, target_followers]
    );
    res.json(toClient(rows[0]));
  } catch (e) {
    console.error('[DB] POST staff-goals error:', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
