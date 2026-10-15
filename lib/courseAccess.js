import pool from '../db.js';

// ── 課程分級開通：學員可看內容的唯一推算來源 ─────────────────────
// 權限不另存，一律即時推算：
//   is_override = true  → 沿用後台手動開通（pdf_access，逐篇），不受資金影響
//   is_override = false → 所有 min_deposit_usd ≤ access_deposit_usd 的 tier 對應系列聯集

// 回傳 { mode: 'override' | 'deposit', seriesIds: number[] }
// override 模式的 seriesIds = 手動開通的 PDF 所屬系列（未分類的 PDF 不在其中）
export async function computeAccessibleSeries(student) {
  if (student.is_override) {
    const { rows } = await pool.query(
      `SELECT DISTINCT p.series_id
       FROM pdf_access a
       JOIN pdf_pdfs p ON p.id = a.pdf_id
       WHERE a.student_id = $1 AND p.series_id IS NOT NULL`,
      [student.id]
    );
    return { mode: 'override', seriesIds: rows.map(r => r.series_id) };
  }

  const { rows } = await pool.query(
    `SELECT DISTINCT ts.series_id
     FROM tiers t
     JOIN tier_series ts ON ts.tier_id = t.id
     WHERE t.min_deposit_usd <= $1`,
    [student.access_deposit_usd ?? 0]
  );
  return { mode: 'deposit', seriesIds: rows.map(r => r.series_id) };
}

// 學員可看的 PDF 清單（給 my-pdfs、讀檔權限檢查共用）
// override 模式維持逐篇粒度：只回傳 pdf_access 有開的那幾篇，不會因為開了一篇就整個系列全開
export async function listAccessiblePdfs(student) {
  const SELECT_COLS = `p.id, p.title, p.file_url, p.sort_order, p.series_id, p.episode_no,
                       s.name AS series_name`;
  const ORDER = `ORDER BY s.sort_order ASC NULLS LAST, p.episode_no ASC, p.id ASC`;

  if (student.is_override) {
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS}
       FROM pdf_access a
       JOIN pdf_pdfs p ON p.id = a.pdf_id
       LEFT JOIN pdf_series s ON s.id = p.series_id
       WHERE a.student_id = $1
       ${ORDER}`,
      [student.id]
    );
    return rows;
  }

  const { seriesIds } = await computeAccessibleSeries(student);
  if (!seriesIds.length) return [];
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLS}
     FROM pdf_pdfs p
     LEFT JOIN pdf_series s ON s.id = p.series_id
     WHERE p.series_id = ANY($1::int[])
     ${ORDER}`,
    [seriesIds]
  );
  return rows;
}

export async function getStudentForAccess(studentId) {
  const { rows } = await pool.query(
    `SELECT id, is_override, access_deposit_usd FROM pdf_students WHERE id = $1`,
    [studentId]
  );
  return rows[0] || null;
}

// tier(x) = min_deposit_usd 最大且 ≤ x 的 tier；x 低於所有門檻時回傳 null
export async function tierFor(amount, db = pool) {
  const { rows } = await db.query(
    `SELECT * FROM tiers WHERE min_deposit_usd <= $1 ORDER BY min_deposit_usd DESC LIMIT 1`,
    [amount]
  );
  return rows[0] || null;
}

// ── 每日排程：寬限到期的自動模式學員正式降級 ───────────────────
// override 學員一律跳過（權限由手動開通決定）
export async function expireGraceDowngrades() {
  const { rowCount } = await pool.query(
    `UPDATE pdf_students
     SET access_deposit_usd = deposit_usd, grace_until = NULL
     WHERE is_override = false AND grace_until IS NOT NULL AND grace_until <= NOW()`
  );
  console.log(`[Tier] 寬限到期降級：${rowCount} 位`);
  return rowCount;
}
