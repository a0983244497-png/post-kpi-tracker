import express from 'express';
import pool from '../db.js';

const router = express.Router();

function toClient(row) {
  const d = row.session_date;
  return {
    id:             row.id,
    session_date:   d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0],
    session_title:  row.session_title || '',
    total_students: Number(row.total_students) || 0,
    attended_count: Number(row.attended_count) || 0,
    notes:          row.notes || '',
  };
}

router.get('/sessions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM course_sessions ORDER BY session_date DESC'
    );
    res.json(rows.map(toClient));
  } catch (e) {
    console.error('[DB] GET sessions:', e.message);
    res.status(500).json({ error: '查詢失敗' });
  }
});

router.post('/sessions', async (req, res) => {
  const { session_date, session_title, total_students = 0, attended_count = 0, notes = '' } = req.body;
  if (!session_date || !session_title) return res.status(400).json({ error: '日期和標題為必填' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO course_sessions (session_date, session_title, total_students, attended_count, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [session_date, session_title, total_students, attended_count, notes]
    );
    res.status(201).json(toClient(rows[0]));
  } catch (e) {
    console.error('[DB] POST sessions:', e.message);
    res.status(500).json({ error: '新增失敗' });
  }
});

export default router;
