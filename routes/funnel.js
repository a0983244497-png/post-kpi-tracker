import express from 'express';
import pool from '../db.js';

const router = express.Router();

function dateStr(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
}
function dateOrNull(v) { return (!v || v === '') ? null : v; }

function toClient(row) {
  return {
    id:                row.id,
    student_id:        row.student_id,
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
    assigned_staff:    row.assigned_staff || '',
  };
}

router.get('/funnel', async (req, res) => {
  try {
    const { staff } = req.query;
    let q = 'SELECT * FROM course_funnel';
    const params = [], conds = [];
    if (staff && staff !== 'Gino') {
      params.push(staff);
      conds.push(`assigned_staff = $${params.length}`);
    }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    const { rows } = await pool.query(q, params);
    res.json(rows.map(toClient));
  } catch (e) {
    console.error('[DB] GET funnel:', e.message);
    res.status(500).json({ error: '查詢失敗' });
  }
});

router.put('/funnel/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  const {
    attended_sessions = 0,
    completed_course  = false,
    completed_date,
    dm_inquiry        = false,
    dm_date,
    opened_account    = false,
    account_date,
    deposited         = false,
    deposit_amount    = 0,
    deposit_date,
    converted         = false,
    convert_date,
    assigned_staff    = '',
  } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE course_funnel SET
         attended_sessions=$1, completed_course=$2, completed_date=$3,
         dm_inquiry=$4, dm_date=$5,
         opened_account=$6, account_date=$7,
         deposited=$8, deposit_amount=$9, deposit_date=$10,
         converted=$11, convert_date=$12, assigned_staff=$13
       WHERE id=$14 RETURNING *`,
      [
        attended_sessions, completed_course, dateOrNull(completed_date),
        dm_inquiry, dateOrNull(dm_date),
        opened_account, dateOrNull(account_date),
        deposited, deposit_amount, dateOrNull(deposit_date),
        converted, dateOrNull(convert_date),
        assigned_staff, id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: '找不到此筆資料' });
    res.json(toClient(rows[0]));
  } catch (e) {
    console.error('[DB] PUT funnel:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

router.get('/funnel-stats', async (req, res) => {
  try {
    const { staff } = req.query;
    let q = `
      SELECT
        COUNT(s.id)                                                  AS total_students,
        COUNT(CASE WHEN f.attended_sessions > 0 THEN 1 END)         AS attended,
        COUNT(CASE WHEN f.completed_course    THEN 1 END)           AS completed,
        COUNT(CASE WHEN f.dm_inquiry          THEN 1 END)           AS dm_count,
        COUNT(CASE WHEN f.opened_account      THEN 1 END)           AS account_count,
        COUNT(CASE WHEN f.deposited           THEN 1 END)           AS deposited_count,
        COUNT(CASE WHEN f.converted           THEN 1 END)           AS converted_count,
        COALESCE(AVG(CASE WHEN f.deposited THEN f.deposit_amount END), 0) AS avg_deposit,
        COALESCE(SUM(f.deposit_amount), 0)                          AS total_deposit
      FROM course_students s
      LEFT JOIN course_funnel f ON f.student_id = s.id
    `;
    const params = [], conds = [];
    if (staff && staff !== 'Gino') {
      params.push(staff);
      conds.push(`s.assigned_staff = $${params.length}`);
    }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    const { rows } = await pool.query(q, params);
    const r = rows[0];

    const { rows: staffRows } = await pool.query(`
      SELECT s.assigned_staff,
             COUNT(CASE WHEN f.converted THEN 1 END) AS conversions,
             COALESCE(SUM(f.deposit_amount), 0)      AS revenue
      FROM course_students s
      LEFT JOIN course_funnel f ON f.student_id = s.id
      WHERE s.assigned_staff != ''
      GROUP BY s.assigned_staff
      ORDER BY conversions DESC, revenue DESC
    `);

    res.json({
      total_students:  Number(r.total_students),
      attended:        Number(r.attended),
      completed:       Number(r.completed),
      dm_count:        Number(r.dm_count),
      account_count:   Number(r.account_count),
      deposited_count: Number(r.deposited_count),
      converted_count: Number(r.converted_count),
      avg_deposit:     Math.round(Number(r.avg_deposit)),
      total_deposit:   Number(r.total_deposit),
      by_staff: staffRows.map(s => ({
        staff:       s.assigned_staff,
        conversions: Number(s.conversions),
        revenue:     Number(s.revenue),
      })),
    });
  } catch (e) {
    console.error('[DB] GET funnel-stats:', e.message);
    res.status(500).json({ error: '查詢失敗' });
  }
});

export default router;
