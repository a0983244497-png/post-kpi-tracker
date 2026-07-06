import express from 'express';
import pool from '../db.js';

const router = express.Router();

function dateStr(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
}

function toClient(row) {
  return {
    id:               row.id,
    session_date:     dateStr(row.session_date),
    session_time:     row.session_time || '',
    session_title:    row.session_title || '',
    total_students:   Number(row.total_students)   || 0,
    attended_count:   Number(row.attended_count)   || 0,
    enrollment_count: Number(row.enrollment_count) || 0,
    notes:            row.notes || '',
  };
}

router.get('/sessions', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*) FROM course_students WHERE assigned_session_id = s.id) AS enrollment_count
      FROM course_sessions s
      ORDER BY s.session_date DESC, s.session_time DESC
    `);
    res.json(rows.map(toClient));
  } catch (e) {
    console.error('[DB] GET sessions:', e.message);
    res.status(500).json({ error: '查詢失敗' });
  }
});

router.post('/sessions', async (req, res) => {
  const { session_date, session_time = '', session_title, notes = '' } = req.body;
  if (!session_date || !session_title) return res.status(400).json({ error: '日期和標題為必填' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO course_sessions (session_date, session_time, session_title, notes)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [session_date, session_time, session_title, notes]
    );
    res.status(201).json({ ...toClient(rows[0]), enrollment_count: 0 });
  } catch (e) {
    console.error('[DB] POST sessions:', e.message);
    res.status(500).json({ error: '新增失敗' });
  }
});

router.put('/sessions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  const { session_date, session_time, session_title, notes } = req.body;
  const updates = [], params = [];
  if (session_date  !== undefined) { params.push(session_date);  updates.push(`session_date=$${params.length}`); }
  if (session_time  !== undefined) { params.push(session_time);  updates.push(`session_time=$${params.length}`); }
  if (session_title !== undefined) { params.push(session_title); updates.push(`session_title=$${params.length}`); }
  if (notes         !== undefined) { params.push(notes);         updates.push(`notes=$${params.length}`); }
  if (!updates.length) return res.status(400).json({ error: '無更新欄位' });
  params.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE course_sessions SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: '找不到場次' });
    const enrollment = await pool.query(
      'SELECT COUNT(*) FROM course_students WHERE assigned_session_id=$1', [id]
    );
    res.json({ ...toClient(rows[0]), enrollment_count: Number(enrollment.rows[0].count) });
  } catch (e) {
    console.error('[DB] PUT sessions:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

// Roster: students assigned to this session with attendance status
router.get('/sessions/:id/roster', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  try {
    const { rows } = await pool.query(`
      SELECT cs.id, cs.name, cs.contact, cs.assigned_staff,
        COALESCE(sa.attended, FALSE) AS attended
      FROM course_students cs
      LEFT JOIN session_attendance sa ON sa.student_id = cs.id AND sa.session_id = $1
      WHERE cs.assigned_session_id = $1
      ORDER BY cs.name
    `, [id]);
    res.json(rows.map(r => ({
      id:             r.id,
      name:           r.name,
      contact:        r.contact || '',
      assigned_staff: r.assigned_staff || '',
      attended:       Boolean(r.attended),
    })));
  } catch (e) {
    console.error('[DB] GET roster:', e.message);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// Save attendance records for a session
router.post('/sessions/:id/attendance', async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  if (isNaN(sessionId)) return res.status(400).json({ error: '無效 ID' });
  const { records } = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error: '格式錯誤' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of records) {
      await client.query(`
        INSERT INTO session_attendance (session_id, student_id, attended)
        VALUES ($1,$2,$3)
        ON CONFLICT (session_id, student_id) DO UPDATE SET attended = EXCLUDED.attended
      `, [sessionId, r.student_id, Boolean(r.attended)]);
    }
    const { rows: countRows } = await client.query(
      'SELECT COUNT(*) FROM session_attendance WHERE session_id=$1 AND attended=TRUE',
      [sessionId]
    );
    const attended_count = Number(countRows[0].count);
    await client.query(
      'UPDATE course_sessions SET attended_count=$1 WHERE id=$2',
      [attended_count, sessionId]
    );
    await client.query('COMMIT');
    res.json({ success: true, attended_count });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] POST attendance:', e.message);
    res.status(500).json({ error: '更新失敗' });
  } finally {
    client.release();
  }
});

export default router;
