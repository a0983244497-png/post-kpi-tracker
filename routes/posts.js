import express from 'express';
import pool from '../db.js';

const router = express.Router();

// DB row → 前端 JSON（欄位名稱對齊原始 HTML 的 p.view / p.like 等）
function toClient(row) {
  const date = row.date instanceof Date
    ? row.date.toISOString().split('T')[0]
    : String(row.date).split('T')[0];
  return {
    id:      row.id,
    name:    row.name,
    date,
    type:    row.type,
    title:   row.title,
    content: row.content || '',
    view:    row.views    || 0,
    like:    row.likes    || 0,
    comment: row.comments || 0,
    share:   row.shares   || 0,
    replies: row.replies  || 0,
    reposts: row.reposts  || 0,
    quotes:  row.quotes   || 0,
    dms:     row.dms      || 0,
    lead:     row.leads    || 0,
    deal:     row.deals    || 0,
    revenue:  row.revenue  || 0,
    post_url: row.post_url || '',
  };
}

// GET /api/posts — 取得全部，按日期降序
router.get('/posts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM posts ORDER BY date DESC, created_at DESC'
    );
    res.json(rows.map(toClient));
  } catch (e) {
    console.error('[DB] GET posts:', e.message);
    res.status(500).json({ error: '資料庫查詢失敗' });
  }
});

// POST /api/posts — 新增一筆
router.post('/posts', async (req, res) => {
  const { name, date, type, title, content, view, like, comment, share, replies, reposts, quotes, dms, lead, deal, revenue, post_url } = req.body;
  if (!name || !date || !type || !title) {
    return res.status(400).json({ error: '業務、日期、類型、標題為必填' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO posts (name, date, type, title, content, views, likes, comments, shares, replies, reposts, quotes, dms, leads, deals, revenue, post_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        name, date, type, title,
        content  || '',
        view     || 0,
        like     || 0,
        comment  || 0,
        share    || 0,
        replies  || 0,
        reposts  || 0,
        quotes   || 0,
        dms      || 0,
        lead     || 0,
        deal     || 0,
        revenue  || 0,
        post_url || '',
      ]
    );
    res.status(201).json(toClient(rows[0]));
  } catch (e) {
    console.error('[DB] POST posts:', e.message);
    res.status(500).json({ error: '新增失敗' });
  }
});

// PUT /api/posts/:id — 更新一筆
router.put('/posts/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  const { name, date, type, title, content, view, like, comment, share, replies, reposts, quotes, dms, lead, deal, revenue, post_url } = req.body;
  if (!name || !date || !type || !title) {
    return res.status(400).json({ error: '業務、日期、類型、標題為必填' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE posts SET name=$1, date=$2, type=$3, title=$4, content=$5,
       views=$6, likes=$7, comments=$8, shares=$9,
       replies=$10, reposts=$11, quotes=$12, dms=$13,
       leads=$14, deals=$15, revenue=$16, post_url=$17
       WHERE id=$18 RETURNING *`,
      [name, date, type, title, content||'', view||0, like||0, comment||0, share||0,
       replies||0, reposts||0, quotes||0, dms||0, lead||0, deal||0, revenue||0, post_url||'', id]
    );
    if (!rows.length) return res.status(404).json({ error: '找不到此筆資料' });
    res.json(toClient(rows[0]));
  } catch (e) {
    console.error('[DB] PUT posts:', e.message);
    res.status(500).json({ error: '更新失敗' });
  }
});

// DELETE /api/posts/:id
router.delete('/posts/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
  try {
    await pool.query('DELETE FROM posts WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DB] DELETE posts:', e.message);
    res.status(500).json({ error: '刪除失敗' });
  }
});

export default router;
