import express from 'express';
import pool from '../db.js';

const router = express.Router();

router.get('/staff', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM staff ORDER BY created_at');
    res.json(rows);
  } catch (e) {
    console.error('[DB] GET staff:', e.message);
    res.status(500).json({ error: '查詢失敗' });
  }
});

router.post('/staff', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '姓名必填' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO staff (name) VALUES ($1) RETURNING id, name',
      [name]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '此姓名已存在' });
    console.error('[DB] POST staff:', e.message);
    res.status(500).json({ error: '新增失敗' });
  }
});

router.delete('/staff/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  try {
    await pool.query('DELETE FROM staff WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DB] DELETE staff:', e.message);
    res.status(500).json({ error: '刪除失敗' });
  }
});

export default router;
