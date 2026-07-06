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
    phone:           row.phone   || '',
    contact:         row.contact || '',
    source:          row.source  || '',
    joined_date:     dateStr(row.joined_date),
    assigned_staff:  row.assigned_staff || '',
    status:          row.status || 'active',
    notes:           row.notes  || '',
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
  const { name, phone = '', contact = '', source = '', joined_date, assigned_staff = '', notes = '' } = req.body;
  if (!name || !joined_date) return res.status(400).json({ error: '姓名和加入日期為必填' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: srows } = await client.query(
      `INSERT INTO course_students (name, phone, contact, source, joined_date, assigned_staff, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7) RETURNING *`,
      [name, phone, contact, source, joined_date, assigned_staff, notes]
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

router.put('/students/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  const { status, notes, assigned_staff } = req.body;
  const updates = [], params = [];
  if (status !== undefined)         { params.push(status);         updates.push(`status=$${params.length}`); }
  if (notes !== undefined)          { params.push(notes);          updates.push(`notes=$${params.length}`); }
  if (assigned_staff !== undefined) { params.push(assigned_staff); updates.push(`assigned_staff=$${params.length}`); }
  if (!updates.length) return res.status(400).json({ error: '沒有要更新的欄位' });
  params.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE course_students SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: '找不到此學員' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[DB] PUT students:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

// ─── Batch Import ────────────────────────────────────────────

router.post('/students/import', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: '無匯入資料' });
  }

  // Valid staff names
  const { rows: staffRows } = await pool.query('SELECT name FROM staff');
  const validStaff = new Set(staffRows.map(r => r.name));

  // Existing students for duplicate detection (name + contact)
  const { rows: existingRows } = await pool.query(
    'SELECT name, contact FROM course_students'
  );
  const existingSet = new Set(existingRows.map(r => `${r.name}|${r.contact || ''}`));

  let success = 0, skipped = 0;
  const details = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name          = (row.name          || '').trim();
    const contact       = (row.contact       || '').trim();
    const joined_date   = (row.joined_date   || '').trim();
    const assigned_staff = (row.assigned_staff || '').trim();
    const source        = (row.source        || '').trim();
    const notes         = (row.notes         || '').trim();
    const rowNum        = i + 2; // CSV row number (1-indexed + header)

    // Required field validation
    const errors = [];
    if (!name)           errors.push('姓名為空');
    if (!contact)        errors.push('聯絡方式為空');
    if (!joined_date)    errors.push('加入日期為空');
    if (!assigned_staff) errors.push('負責業務為空');
    if (joined_date && !/^\d{4}-\d{2}-\d{2}$/.test(joined_date)) {
      errors.push('日期格式錯誤（需 YYYY-MM-DD）');
    }
    if (assigned_staff && !validStaff.has(assigned_staff)) {
      errors.push(`業務「${assigned_staff}」不存在`);
    }
    if (errors.length) {
      details.push({ row: rowNum, name: name || `第${rowNum}行`, reason: errors.join('；') });
      continue;
    }

    // Duplicate check: name + contact
    const dupKey = `${name}|${contact}`;
    if (existingSet.has(dupKey)) {
      skipped++;
      continue;
    }

    // Insert student + funnel
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: srows } = await client.query(
        `INSERT INTO course_students (name, contact, source, joined_date, assigned_staff, status, notes)
         VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING *`,
        [name, contact, source, joined_date, assigned_staff, notes]
      );
      await client.query(
        `INSERT INTO course_funnel (student_id, assigned_staff) VALUES ($1,$2)`,
        [srows[0].id, assigned_staff]
      );
      await client.query('COMMIT');
      existingSet.add(dupKey); // prevent intra-batch duplicates
      success++;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[DB] import row:', e.message);
      details.push({ row: rowNum, name, reason: `資料庫錯誤：${e.message}` });
    } finally {
      client.release();
    }
  }

  res.json({ success, skipped, failed: details.length, details });
});

export default router;
