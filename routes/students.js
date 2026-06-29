import express from 'express';
import pool from '../db.js';

const router = express.Router();

function dateStr(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
}

function toClient(row) {
  return {
    id:              row.id,
    name:            row.name,
    phone:           row.phone || '',
    joined_date:     dateStr(row.joined_date),
    assigned_staff:  row.assigned_staff || '',
    status:          row.status || 'active',
    notes:           row.notes || '',
    funnel_id:       row.funnel_id || null,
    attended_sessions: Number(row.attended_sessions) || 0,
    completed_course:  row.completed_course || false,
    completed_date:    dateStr(row.completed_date),
    dm_inquiry:        row.dm_inquiry || false,
    dm_date:           dateStr(row.dm_date),
    opened_account:    row.opened_account || false,
    account_date:      dateStr(row.account_date),
    deposited:         row.deposited || false,
    deposit_amount:    Number(row.deposit_amount) || 0,
    deposit_date:      dateStr(row.deposit_date),
    converted:         row.converted || false,
    convert_date:      dateStr(row.convert_date),
  };
}

router.get('/students', async (req, res) => {
  try {
    const { staff } = req.query;
    let q = `
      SELECT s.*,
        f.id        AS funnel_id,
        f.attended_sessions, f.completed_course, f.completed_date,
        f.dm_inquiry, f.dm_date,
        f.opened_account, f.account_date,
        f.deposited, f.deposit_amount, f.deposit_date,
        f.converted, f.convert_date
      FROM course_students s
      LEFT JOIN course_funnel f ON f.student_id = s.id
    `;
    const params = [], conds = [];
    if (staff && staff !== 'Gino') {
      params.push(staff);
      conds.push(`s.assigned_staff = $${params.length}`);
    }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY s.joined_date DESC, s.id DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows.map(toClient));
  } catch (e) {
    console.error('[DB] GET students:', e.message);
    res.status(500).json({ error: '查詢失敗' });
  }
});

router.post('/students', async (req, res) => {
  const { name, phone = '', joined_date, assigned_staff = '', notes = '' } = req.body;
  if (!name || !joined_date) return res.status(400).json({ error: '姓名和加入日期為必填' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: srows } = await client.query(
      `INSERT INTO course_students (name, phone, joined_date, assigned_staff, status, notes)
       VALUES ($1,$2,$3,$4,'active',$5) RETURNING *`,
      [name, phone, joined_date, assigned_staff, notes]
    );
    const student = srows[0];
    const { rows: frows } = await client.query(
      `INSERT INTO course_funnel (student_id, assigned_staff)
       VALUES ($1,$2) RETURNING *`,
      [student.id, assigned_staff]
    );
    await client.query('COMMIT');
    res.status(201).json(toClient({ ...student, ...frows[0], funnel_id: frows[0].id }));
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] POST students:', e.message);
    res.status(500).json({ error: '新增失敗' });
  } finally {
    client.release();
  }
});

export default router;
