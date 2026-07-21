import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initDb } from './db.js';
import postsRouter          from './routes/posts.js';
import staffRouter          from './routes/staff.js';
import weeklyStatsRouter    from './routes/weekly_stats.js';
import dailyFollowersRouter from './routes/daily_followers.js';
import staffGoalsRouter     from './routes/staff_goals.js';
import studentsRouter       from './routes/students.js';
import sessionsRouter       from './routes/sessions.js';
import funnelRouter         from './routes/funnel.js';
import contentCalendarRouter from './routes/contentCalendar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// ─── Auth middleware ──────────────────────────────────────
function requireAuth(req, res, next) {
  const pw = process.env.TEAM_PASSWORD;
  if (!pw) return next(); // 未設定密碼則不驗證（開發用）
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Post KPI Tracker"');
    return res.sendStatus(401);
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const pass    = decoded.slice(decoded.indexOf(':') + 1);
  if (pass !== pw) {
    res.set('WWW-Authenticate', 'Basic realm="Post KPI Tracker"');
    return res.sendStatus(401);
  }
  next();
}

// ─── CORS ────────────────────────────────────────────────
// CORS_ALLOWED_ORIGINS: comma-separated list of allowed origins.
// If unset/empty → allow all (*). If set → whitelist mode.
const ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : [];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (ALLOWED_ORIGINS.length === 0) {
    // Open mode
    res.set('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    // Whitelist mode: reflect matched origin and add Vary
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  // If whitelist mode and origin not in list: no ACAO header → browser blocks

  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  // OPTIONS preflight must be answered before Auth middleware
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Middleware ───────────────────────────────────────────
app.use(express.json());

// ─── API 路由（受 Auth 保護）─────────────────────────────
app.use('/api', requireAuth, postsRouter);
app.use('/api', requireAuth, staffRouter);
app.use('/api', requireAuth, weeklyStatsRouter);
app.use('/api', requireAuth, dailyFollowersRouter);
app.use('/api', requireAuth, staffGoalsRouter);
app.use('/api', requireAuth, studentsRouter);
app.use('/api', requireAuth, sessionsRouter);
app.use('/api', requireAuth, funnelRouter);
app.use('/api/content-calendar', requireAuth, contentCalendarRouter);

// ─── 靜態頁面（受 Auth 保護）────────────────────────────
app.use(requireAuth, express.static(join(__dirname, 'public')));

// ─── 啟動 ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

try {
  await initDb();
  app.listen(PORT, () => {
    console.log(`✓ Post KPI Tracker → http://localhost:${PORT}`);
  });
} catch (e) {
  console.error('啟動失敗:', e.message);
  process.exit(1);
}
