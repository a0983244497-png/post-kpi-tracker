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
const TYPE_LABEL = { single: '單篇', carousel: '輪播', cta: 'CTA' };
const LABEL_TYPE = { '單篇': 'single', '輪播': 'carousel', 'CTA': 'cta' };

function buildEvent(item) {
  const { date, time, topic, type, series } = item;
  const startTime = time || '09:00';
  const [hh, mm] = startTime.split(':').map(Number);
  const endH = String((hh + 1) % 24).padStart(2, '0');
  const typeLabel = TYPE_LABEL[type] || type || '單篇';

  return {
    summary: `[${typeLabel}] ${topic}`,
    description: [
      series ? `📚 系列：${series}` : '',
      type   ? `📌 類型：${typeLabel}` : '',
    ].filter(Boolean).join('\n'),
    start: { dateTime: `${date}T${startTime}:00+08:00`, timeZone: 'Asia/Taipei' },
    end:   { dateTime: `${date}T${endH}:${String(mm).padStart(2,'0')}:00+08:00`, timeZone: 'Asia/Taipei' },
    // Structured data for reliable read-back (new events only)
    extendedProperties: {
      private: {
        postType:   type   || 'single',
        postTopic:  topic,
        postSeries: series || '',
      },
    },
  };
}

// ── Week range (Taiwan time) ──────────────────────────────────
function getWeekRange(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow  = date.getDay(); // 0=Sun, 1=Mon … 6=Sat
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  const mon  = new Date(y, m - 1, d - daysFromMonday);
  const sun  = new Date(y, m - 1, d - daysFromMonday + 6);
  const fmt  = dt =>
    `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  return {
    timeMin: `${fmt(mon)}T00:00:00+08:00`,
    timeMax: `${fmt(sun)}T23:59:59+08:00`,
  };
}

// ── Month range (Taiwan time) ─────────────────────────────────
function getMonthRange(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const lastDate = new Date(y, m, 0).getDate(); // day 0 of next month = last day of this month
  const lastStr  = `${monthStr}-${String(lastDate).padStart(2, '0')}`;
  return {
    timeMin: `${monthStr}-01T00:00:00+08:00`,
    timeMax: `${lastStr}T23:59:59+08:00`,
  };
}

// ── Parse a Calendar event back into our schema ───────────────
function parseEvent(event) {
  const ep = event.extendedProperties?.private || {};
  let type, topic, series;

  if (ep.postTopic) {
    // New format: read from extendedProperties
    type   = ep.postType   || 'single';
    topic  = ep.postTopic;
    series = ep.postSeries || null;
  } else {
    // Fallback: parse summary "[typeLabel] topic"
    const match = (event.summary || '').match(/^\[([^\]]+)\]\s*([\s\S]*)/);
    if (match) {
      type  = LABEL_TYPE[match[1]] || match[1];
      topic = match[2].trim();
    } else {
      type  = 'single';
      topic = event.summary || '';
    }
    const seriesMatch = (event.description || '').match(/📚\s*系列[：:]\s*(.+)/);
    series = seriesMatch ? seriesMatch[1].trim() : null;
  }

  const startDt  = event.start?.dateTime || '';
  const [datePart, timeFull] = startDt.split('T');
  const time = timeFull ? timeFull.slice(0, 5) : '09:00';

  return { date: datePart, time, topic, type, series: series || null };
}

// ── Core: check duplicate then insert/skip ────────────────────
async function upsertEvent(calendar, calendarId, item) {
  const { date, topic, type } = item;
  const typeLabel = TYPE_LABEL[type] || type || '單篇';
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
 * Get all content events for the week containing dateStr (Monday–Sunday, Asia/Taipei).
 * @param {string} dateStr  'YYYY-MM-DD' — any date within the target week
 * @returns {Array<{ date, time, topic, type, series }>} sorted by date then time
 */
export async function getWeekEvents(dateStr) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = getCalendarId();
  const { timeMin, timeMax } = getWeekRange(dateStr);

  const res = await calendar.events.list({
    calendarId,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 200,
  });

  return (res.data.items || [])
    .map(parseEvent)
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}

/**
 * Get all content events for a full calendar month (Asia/Taipei).
 * @param {string} monthStr  'YYYY-MM'
 * @returns {Array<{ date, time, topic, type, series }>} sorted by date then time
 */
export async function getMonthEvents(monthStr) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = getCalendarId();
  const { timeMin, timeMax } = getMonthRange(monthStr);

  const res = await calendar.events.list({
    calendarId,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 500,
  });

  return (res.data.items || [])
    .map(parseEvent)
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
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
