import { Router } from 'express';
import { syncWeeklyPlan } from '../lib/googleCalendar.js';

const router = Router();

/**
 * POST /api/content-calendar/sync
 * Body: array of { date, time?, topic, type?, series? }
 *
 * date   - 'YYYY-MM-DD'
 * time   - 'HH:MM' in Taiwan time (optional, default '09:00')
 * topic  - post topic/title (string, required)
 * type   - 'single' | 'carousel' | 'cta' (optional)
 * series - series name (optional)
 *
 * Returns: array of per-item results { status, eventId?, summary, date, error? }
 */
router.post('/sync', async (req, res) => {
  try {
    const items = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: '請提供非空的發文計畫陣列' });
    }

    // Validate required fields
    for (let i = 0; i < items.length; i++) {
      if (!items[i].date || !items[i].topic) {
        return res.status(400).json({
          error: `第 ${i + 1} 筆缺少必要欄位（date、topic）`,
        });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(items[i].date)) {
        return res.status(400).json({
          error: `第 ${i + 1} 筆 date 格式應為 YYYY-MM-DD`,
        });
      }
    }

    const results = await syncWeeklyPlan(items);
    const created = results.filter(r => r.status === 'created').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors  = results.filter(r => r.status === 'error').length;

    res.json({ ok: true, summary: { created, skipped, errors }, results });
  } catch (e) {
    console.error('[ContentCalendar] sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
