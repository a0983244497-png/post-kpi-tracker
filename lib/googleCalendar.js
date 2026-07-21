import { google } from 'googleapis';

// ── Auth ─────────────────────────────────────────────────────
function getAuth() {
  const raw = process.env.GOOGLE_CALENDAR_CREDENTIALS;
  if (!raw) throw new Error('GOOGLE_CALENDAR_CREDENTIALS 環境變數未設定');

  // Support both raw JSON string and base64-encoded string
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    creds = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  }

  return new google.auth.JWT({
    email: creds.client_email,
    key:   creds.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
  });
}

function getCalendarId() {
  const id = process.env.GOOGLE_CALENDAR_ID;
  if (!id) throw new Error('GOOGLE_CALENDAR_ID 環境變數未設定');
  return id;
}

// ── Helpers ───────────────────────────────────────────────────
function buildEvent(item) {
  const { date, time, topic, type, series } = item;
  // date = 'YYYY-MM-DD', time = 'HH:MM' (optional, defaults to 09:00)
  const startTime = time || '09:00';
  const [hh, mm] = startTime.split(':').map(Number);

  // End time = start + 1 hour
  const endH = String((hh + 1) % 24).padStart(2, '0');

  const typeLabel = { single: '單篇', carousel: '輪播', cta: 'CTA' }[type] || type || '單篇';

  return {
    summary: `[${typeLabel}] ${topic}`,
    description: [
      series  ? `📚 系列：${series}` : '',
      type    ? `📌 類型：${typeLabel}` : '',
    ].filter(Boolean).join('\n'),
    start: { dateTime: `${date}T${startTime}:00+08:00`, timeZone: 'Asia/Taipei' },
    end:   { dateTime: `${date}T${endH}:${String(mm).padStart(2,'0')}:00+08:00`, timeZone: 'Asia/Taipei' },
  };
}

// ── Core: check duplicate then insert/skip ────────────────────
async function upsertEvent(calendar, calendarId, item) {
  const { date, topic, type } = item;
  const typeLabel = { single: '單篇', carousel: '輪播', cta: 'CTA' }[type] || type || '單篇';
  const targetSummary = `[${typeLabel}] ${topic}`;

  // Search for existing event with same title on the same day
  const dayStart = `${date}T00:00:00+08:00`;
  const dayEnd   = `${date}T23:59:59+08:00`;

  const listRes = await calendar.events.list({
    calendarId,
    timeMin: dayStart,
    timeMax: dayEnd,
    q: targetSummary,
    singleEvents: true,
  });

  const existing = (listRes.data.items || []).find(
    e => e.summary === targetSummary
  );

  if (existing) {
    return { status: 'skipped', eventId: existing.id, summary: targetSummary, date };
  }

  const insertRes = await calendar.events.insert({
    calendarId,
    requestBody: buildEvent(item),
  });

  return { status: 'created', eventId: insertRes.data.id, summary: targetSummary, date };
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Sync a single content post plan to Google Calendar.
 * @param {{ date: string, time?: string, topic: string, type?: string, series?: string }} item
 * @returns {{ status: 'created'|'skipped', eventId: string, summary: string, date: string }}
 */
export async function syncEvent(item) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  return upsertEvent(calendar, getCalendarId(), item);
}

/**
 * Sync a week's content plan (array of items) to Google Calendar.
 * @param {Array} items
 * @returns {Array<{ status: string, eventId?: string, summary: string, date: string, error?: string }>}
 */
export async function syncWeeklyPlan(items) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = getCalendarId();

  const results = [];
  for (const item of items) {
    try {
      const result = await upsertEvent(calendar, calendarId, item);
      results.push(result);
    } catch (e) {
      results.push({
        status: 'error',
        date: item.date,
        summary: item.topic,
        error: e.message,
      });
    }
  }
  return results;
}
