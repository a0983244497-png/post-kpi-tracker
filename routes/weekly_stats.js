import express from 'express';
import pool from '../db.js';

const router = express.Router();

router.get('/weekly-stats', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM weekly_stats ORDER BY week_start_date DESC LIMIT 52'
    );
    res.json(rows);
  } catch (e) {
    console.error('[DB] GET weekly-stats:', e.message);
    res.status(500).json({ error: '查詢失敗' });
  }
});

router.post('/weekly-stats', async (req, res) => {
  const {
    week_start_date,
    name           = '',
    total_posts    = 0,
    total_views    = 0,
    total_likes    = 0,
    total_replies  = 0,
    total_reposts  = 0,
    total_quotes   = 0,
    total_dms      = 0,
    conversions    = 0,
    revenue        = 0,
    followers_end  = 0,
    followers_start = 0,
  } = req.body;

  if (!week_start_date) {
    return res.status(400).json({ error: '缺少 week_start_date' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO weekly_stats
         (week_start_date, name, total_posts, total_views, total_likes, total_replies,
          total_reposts, total_quotes, total_dms, conversions, revenue,
          followers_end, followers_start)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (week_start_date, name) DO UPDATE SET
         total_posts=$3, total_views=$4, total_likes=$5, total_replies=$6,
         total_reposts=$7, total_quotes=$8, total_dms=$9, conversions=$10,
         revenue=$11, followers_end=$12, followers_start=$13
       RETURNING *`,
      [
        week_start_date, name,
        total_posts, total_views, total_likes, total_replies,
        total_reposts, total_quotes, total_dms, conversions, revenue,
        followers_end, followers_start,
      ]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[DB] POST weekly-stats:', e.message);
    res.status(500).json({ error: '儲存失敗' });
  }
});

export default router;
