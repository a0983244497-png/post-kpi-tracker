import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initDb } from './db.js';
import postsRouter       from './routes/posts.js';
import staffRouter      from './routes/staff.js';
import weeklyStatsRouter    from './routes/weekly_stats.js';
import dailyFollowersRouter from './routes/daily_followers.js';

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

// ─── Middleware ───────────────────────────────────────────
app.use(express.json());

// ─── API 路由（受 Auth 保護）─────────────────────────────
app.use('/api', requireAuth, postsRouter);
app.use('/api', requireAuth, staffRouter);
app.use('/api', requireAuth, weeklyStatsRouter);
app.use('/api', requireAuth, dailyFollowersRouter);

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
