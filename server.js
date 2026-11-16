'use strict';

require('dotenv').config({ path: require('path').join(require('os').homedir(), '.config', 'briefing-app', '.env') });

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { google } = require('googleapis');
const { WebClient: SlackWebClient } = require('@slack/web-api');
const cron = require('node-cron');

const { loadContext, buildOrgContext } = require('./lib/context');
const { fetchBriefData, streamBrief, generateBriefText, HISTORY_FILE } = require('./lib/brief');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const CONFIG_DIR = path.join(os.homedir(), '.config', 'briefing-app');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
const FEEDBACK_FILE = path.join(process.env.DATA_DIR || os.homedir(), '.briefing-feedback.jsonl');
const DATA_DIR = process.env.DATA_DIR;
const CONFIG_FILE = path.join(DATA_DIR || os.homedir(), '.briefing-config.json');
const CONFIG_DEFAULTS = { briefDays: [0, 1, 2, 3, 4, 5, 6], briefTime: '06:50' };

// ---------------------------------------------------------------------------
// Schedule config helpers
// ---------------------------------------------------------------------------
function readConfig(readFn = fs.readFileSync) {
  try {
    const raw = readFn(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...CONFIG_DEFAULTS, ...parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...CONFIG_DEFAULTS };
    throw err;
  }
}

function validateConfig(body) {
  const { briefDays, briefTime } = body;
  if (!Array.isArray(briefDays)) return 'briefDays must be an array';
  if (briefDays.length === 0) return 'briefDays must not be empty';
  for (const d of briefDays) {
    if (!Number.isInteger(d) || d < 0 || d > 6) return 'briefDays values must be integers 0–6';
  }
  if (typeof briefTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(briefTime)) {
    return 'briefTime must match HH:MM with leading zero (e.g. "06:50")';
  }
  return null;
}

function writeConfig(config, writeFn = fs.writeFileSync, renameFn = fs.renameSync) {
  const tmpPath = `${CONFIG_FILE}.tmp.${Date.now()}`;
  writeFn(tmpPath, JSON.stringify(config, null, 2), 'utf8');
  try {
    renameFn(tmpPath, CONFIG_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

let cronJob = null;

function scheduleFromConfig(config) {
  const expr = process.env.BRIEF_CRON || (() => {
    const [hh, mm] = config.briefTime.split(':');
    return `${parseInt(mm, 10)} ${parseInt(hh, 10)} * * *`;
  })();
  try { if (cronJob) cronJob.stop(); } catch { /* ignore */ }
  try {
    cronJob = cron.schedule(expr, sendMorningBrief, { timezone: 'America/Los_Angeles' });
  } catch (err) {
    console.error(`[cron] Invalid expression "${expr}": ${err.message}. Falling back to default.`);
    const [hh, mm] = CONFIG_DEFAULTS.briefTime.split(':');
    cronJob = cron.schedule(`${parseInt(mm, 10)} ${parseInt(hh, 10)} * * *`, sendMorningBrief, { timezone: 'America/Los_Angeles' });
  }
}

// Handler functions extracted for unit testing (server.js can't be imported in CI)
function handleGetConfig(readFn = fs.readFileSync) {
  try {
    const config = readConfig(readFn);
    return { status: 200, body: { ...config, cronOverride: !!process.env.BRIEF_CRON } };
  } catch {
    return { status: 500, body: { error: 'Failed to read config' } };
  }
}

function handlePostConfig(body, opts = {}) {
  const { readFn = fs.readFileSync, writeFn = fs.writeFileSync, renameFn = fs.renameSync } = opts;
  const dedupedDays = [...new Set((body.briefDays || []))];
  const err = validateConfig({ ...body, briefDays: dedupedDays });
  if (err) return { status: 400, body: { error: err } };

  const newConfig = { briefDays: dedupedDays.sort((a, b) => a - b), briefTime: body.briefTime };
  let oldConfig;
  try { oldConfig = readConfig(readFn); } catch { oldConfig = { ...CONFIG_DEFAULTS }; }

  scheduleFromConfig(newConfig);

  try {
    writeConfig(newConfig, writeFn, renameFn);
  } catch {
    try { scheduleFromConfig(oldConfig); } catch { /* best-effort rollback */ }
    return { status: 500, body: { error: 'Failed to save config' } };
  }
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------
let orgContext;
try {
  const sections = loadContext();
  orgContext = buildOrgContext(sections);
  console.log('✅  CLAUDE.md loaded — org context ready');
} catch (err) {
  console.error('❌  CLAUDE.md error:', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Google API client (singleton)
// ---------------------------------------------------------------------------
let _googleAuth = null;

function getGoogleAuth() {
  if (_googleAuth) return _googleAuth;

  let creds, tokens;
  if (process.env.GOOGLE_CREDENTIALS_B64 && process.env.GOOGLE_TOKEN_B64) {
    // Cloud deployment: read from env vars
    creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8'));
    tokens = JSON.parse(Buffer.from(process.env.GOOGLE_TOKEN_B64, 'base64').toString('utf8'));
  } else {
    // Local: read from files
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      throw new Error(`Google credentials not found at ${CREDENTIALS_FILE}. Run node auth.js first.`);
    }
    if (!fs.existsSync(TOKEN_FILE)) {
      throw new Error(`Google token not found at ${TOKEN_FILE}. Run node auth.js first.`);
    }
    creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  }
  const { client_id, client_secret } = creds.installed || creds.web || {};

  const oauth2 = new google.auth.OAuth2(
    client_id,
    client_secret,
    'http://localhost:3001/oauth2callback'
  );
  oauth2.setCredentials(tokens);

  // Persist refreshed tokens automatically (best-effort — env vars are the source of truth in prod)
  oauth2.on('tokens', refreshed => {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { /* first run or env-var deploy */ }
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...existing, ...refreshed }, null, 2));
    } catch (err) {
      console.warn('[auth] Could not persist refreshed token to disk:', err.message);
    }
  });

  _googleAuth = oauth2;
  return _googleAuth;
}

function getGoogleClients() {
  const auth = getGoogleAuth();
  return {
    calendar: google.calendar({ version: 'v3', auth }),
    gmail: google.gmail({ version: 'v1', auth }),
  };
}

// ---------------------------------------------------------------------------
// Slack client (singleton)
// ---------------------------------------------------------------------------
let _slackClient = null;

function getSlackClient() {
  if (_slackClient) return _slackClient;
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) throw new Error('SLACK_USER_TOKEN not set in .env');
  _slackClient = new SlackWebClient(token);
  return _slackClient;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// Basic Auth — requires BRIEF_USER and BRIEF_PASS env vars
const BRIEF_USER = process.env.BRIEF_USER;
const BRIEF_PASS = process.env.BRIEF_PASS;
if (!BRIEF_USER || !BRIEF_PASS) {
  console.warn('⚠️   BRIEF_USER / BRIEF_PASS not set — app is unprotected');
} else {
  const expected = 'Basic ' + Buffer.from(`${BRIEF_USER}:${BRIEF_PASS}`).toString('base64');
  app.use((req, res, next) => {
    if (req.headers.authorization === expected) return next();
    res.set('WWW-Authenticate', 'Basic realm="Daily Brief"');
    res.status(401).send('Unauthorized');
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ---------------------------------------------------------------------------
// GET /api/brief — SSE streaming
// ---------------------------------------------------------------------------
app.get('/api/brief', async (req, res) => {
  const calendar = req.query.calendar !== '0';
  const gmail = req.query.gmail !== '0';
  const slack = req.query.slack !== '0';
  const tone = ['concise', 'standard', 'detailed'].includes(req.query.tone) ? req.query.tone : 'standard';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const briefTs = new Date().toISOString();

  try {
    let sources = {};

    // Initialize only the clients for enabled sources
    if (calendar || gmail) {
      try {
        sources = { ...sources, ...getGoogleClients() };
      } catch (err) {
        console.error('Google client init failed:', err.message);
        // Both sources unavailable — will be flagged in fetchBriefData
        sources.calendar = null;
        sources.gmail = null;
      }
    }

    if (slack) {
      try {
        sources.slackClient = getSlackClient();
      } catch (err) {
        console.error('Slack client init failed:', err.message);
        sources.slackClient = null;
      }
    }

    // If a client is null, treat that source as disabled
    const flags = {
      calendar: calendar && !!sources.calendar,
      gmail: gmail && !!sources.gmail,
      slack: slack && !!sources.slackClient,
    };

    const data = await fetchBriefData(sources, flags);
    await streamBrief(data, orgContext, { tone, briefTs }, res);
  } catch (err) {
    console.error('Brief route error:', err.message);
    res.write(`event: error\ndata: ${JSON.stringify('Brief generation failed: ' + err.message)}\n\n`);
    res.end();
  }
});

// ---------------------------------------------------------------------------
// POST /api/update-context — hot-reload CLAUDE.md from uploaded content
// ---------------------------------------------------------------------------
app.post('/api/update-context', express.text({ type: '*/*', limit: '2mb' }), (req, res) => {
  try {
    const content = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ ok: false, error: 'Empty content' });
    }
    const sections = loadContext(null, content);
    orgContext = buildOrgContext(sections);
    // Persist to disk so it survives in-process restarts (until next deploy)
    fs.writeFileSync(require('./lib/context').CLAUDE_MD_PATH, content, 'utf8');
    const loaded = Object.entries(sections).filter(([, v]) => v).map(([k]) => k);
    console.log(`✅  CLAUDE.md updated via upload — sections: ${loaded.join(', ')}`);
    res.json({ ok: true, sections: loaded });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/send-now — manually trigger morning brief
// ---------------------------------------------------------------------------
app.post('/api/send-now', async (req, res) => {
  try {
    await sendMorningBrief();
    res.json({ ok: true, message: 'Brief sent.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/feedback — append to JSONL
// ---------------------------------------------------------------------------
app.post('/api/feedback', (req, res) => {
  const { type, rating, index, text_snippet, brief_ts } = req.body;

  // Validate
  if (!['watch_item', 'overall'].includes(type)) {
    return res.status(400).json({ error: 'type must be "watch_item" or "overall"' });
  }
  if (rating !== 1 && rating !== -1) {
    return res.status(400).json({ error: 'rating must be 1 or -1' });
  }

  const entry = {
    ts: new Date().toISOString(),
    brief_ts: brief_ts || null,
    type,
    index: index ?? null,
    rating,
    text_snippet: typeof text_snippet === 'string' ? text_snippet.slice(0, 80) : null,
  };

  try {
    fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
    res.json({ ok: true });
  } catch (err) {
    console.error('Feedback write failed:', err.message);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// ---------------------------------------------------------------------------
// GET /config — read schedule config
// POST /config — update schedule config
// ---------------------------------------------------------------------------
app.get('/config', (req, res) => {
  const result = handleGetConfig();
  res.status(result.status).json(result.body);
});

app.post('/config', (req, res) => {
  const result = handlePostConfig(req.body);
  res.status(result.status).json(result.body);
});

// ---------------------------------------------------------------------------
// DELETE /api/history/:ts — remove one entry from history JSONL
// ---------------------------------------------------------------------------
app.delete('/api/history/:ts', (req, res) => {
  const ts = req.params.ts;
  try {
    if (!fs.existsSync(HISTORY_FILE)) return res.status(404).json({ error: 'No history file' });
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    const filtered = lines.filter(l => {
      try { return JSON.parse(l).ts !== ts; } catch { return true; }
    });
    if (filtered.length === lines.length) return res.status(404).json({ error: 'Entry not found' });
    fs.writeFileSync(HISTORY_FILE, filtered.join('\n') + (filtered.length ? '\n' : ''));
    res.json({ ok: true });
  } catch (err) {
    console.error('History delete failed:', err.message);
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

// ---------------------------------------------------------------------------
// GET /history — past briefs
// ---------------------------------------------------------------------------
app.get('/history', (req, res) => {
  let entries = [];
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
      entries = lines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .reverse(); // newest first
    }
  } catch (err) {
    console.error('History read failed:', err.message);
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Brief History</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9f9f9; color: #111; padding: 32px; max-width: 860px; margin: 0 auto; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    .back { font-size: 13px; color: #555; text-decoration: none; display: block; margin-bottom: 24px; }
    .back:hover { color: #111; }
    .entry { background: #fff; border: 1px solid #ddd; margin-bottom: 16px; }
    .entry-header { padding: 14px 20px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
    .entry-header:hover { background: #fafafa; }
    .entry-date { font-size: 14px; font-weight: 600; }
    .entry-meta { font-size: 12px; color: #777; }
    .entry-body { display: none; padding: 20px 24px; border-top: 1px solid #eee; font-size: 14px; line-height: 1.7; }
    .entry-body.open { display: block; }
    .empty { text-align: center; padding: 64px; color: #aaa; font-size: 14px; }
    .btn-delete { font-size: 12px; color: #bbb; background: none; border: none; cursor: pointer; padding: 2px 6px; border-radius: 4px; margin-left: 12px; flex-shrink: 0; }
    .btn-delete:hover { color: #c0392b; background: #fff0ee; }
  </style>
</head>
<body>
  <a class="back" href="/">← Back to today's brief</a>
  <h1>Brief History</h1>
  <p style="color:#777;font-size:13px;margin-bottom:24px;">${entries.length} brief${entries.length !== 1 ? 's' : ''} on record</p>

  ${entries.length === 0 ? '<div class="empty">No briefs yet.</div>' : entries.map((e, i) => `
  <div class="entry">
    <div class="entry-header" onclick="toggle(${i})">
      <span class="entry-date">${new Date(e.ts).toLocaleString()}</span>
      <span style="display:flex;align-items:center;">
        <span class="entry-meta">${(e.sources || []).join(', ')} · ${e.duration_ms ? Math.round(e.duration_ms / 1000) + 's' : '?'}</span>
        <button class="btn-delete" onclick="deleteEntry(event, '${e.ts}', this)" title="Delete this brief">✕</button>
      </span>
    </div>
    <div class="entry-body" id="entry-${i}" data-brief="${encodeURIComponent(e.brief || '')}"></div>
  </div>`).join('')}

  <script>
    function toggle(i) {
      const el = document.getElementById('entry-' + i);
      el.classList.toggle('open');
      if (el.classList.contains('open') && !el.dataset.rendered) {
        const raw = decodeURIComponent(el.dataset.brief);
        el.innerHTML = DOMPurify.sanitize(marked.parse(raw));
        el.dataset.rendered = '1';
      }
    }
    async function deleteEntry(evt, ts, btn) {
      evt.stopPropagation();
      if (!confirm('Delete this brief from history?')) return;
      btn.disabled = true;
      btn.textContent = '…';
      const res = await fetch('/api/history/' + encodeURIComponent(ts), { method: 'DELETE' });
      if (res.ok) {
        btn.closest('.entry').remove();
        const counter = document.querySelector('p[style]');
        if (counter) {
          const n = document.querySelectorAll('.entry').length;
          counter.textContent = n + ' brief' + (n !== 1 ? 's' : '') + ' on record';
        }
      } else {
        btn.disabled = false;
        btn.textContent = '✕';
        alert('Delete failed.');
      }
    }
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Phase 2 — Morning auto-send cron (6:50am daily)
// ---------------------------------------------------------------------------
async function sendMorningBrief() {
  // Day-of-week guard — skip if today not in configured briefDays
  const cfg = (() => { try { return readConfig(); } catch { return { ...CONFIG_DEFAULTS }; } })();
  const today = new Date().getDay();
  if (!cfg.briefDays.includes(today)) {
    console.log(`[cron] Skipping brief — day ${today} not in briefDays [${cfg.briefDays.join(',')}]`);
    return;
  }
  console.log('[cron] Generating morning brief...');
  try {
    let sources = {};
    let flags = { calendar: true, gmail: true, slack: true };

    try {
      sources = { ...sources, ...getGoogleClients() };
    } catch (err) {
      console.error('[cron] Google client error:', err.message);
      flags.calendar = false;
      flags.gmail = false;
    }

    try {
      sources.slackClient = getSlackClient();
    } catch (err) {
      console.error('[cron] Slack client error:', err.message);
      flags.slack = false;
    }

    const data = await fetchBriefData(sources, flags);
    const text = await generateBriefText(data, orgContext, { tone: 'standard' });

    const recipient = process.env.BRIEF_RECIPIENT;
    if (!recipient) {
      console.log('[cron] BRIEF_RECIPIENT not set — brief generated but not sent:\n', text.slice(0, 200) + '...');
      return;
    }

    // Send via Gmail API
    const auth = getGoogleAuth();
    const gmail = google.gmail({ version: 'v1', auth });
    const subject = `Daily Brief — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`;

    // Encode subject for RFC 2047 (handles em dash and other non-ASCII)
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;

    // Convert markdown to HTML for email rendering
    const { marked } = require('marked');
    const htmlBody = marked.parse(text);
    const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 700px; margin: 0 auto; padding: 24px; color: #1a1a1a; }
      h1 { font-size: 22px; margin-bottom: 4px; }
      h2 { font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; border-bottom: 1px solid #e5e5e5; padding-bottom: 4px; margin-top: 28px; }
      table { border-collapse: collapse; width: 100%; margin: 12px 0; }
      th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; padding: 6px 10px; border-bottom: 2px solid #e5e5e5; }
      td { padding: 8px 10px; vertical-align: top; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
      td:first-child { white-space: nowrap; color: #888; min-width: 80px; }
      ul { padding-left: 20px; margin: 8px 0; }
      li { margin: 4px 0; font-size: 14px; }
      p { font-size: 14px; line-height: 1.6; }
      strong { color: #000; }
    </style></head><body>${htmlBody}</body></html>`;

    const boundary = 'briefing_boundary';
    const rawMessage = [
      `To: ${recipient}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      fullHtml,
      '',
      `--${boundary}--`,
    ].join('\r\n');

    const encoded = Buffer.from(rawMessage).toString('base64url');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
    console.log(`[cron] Brief sent to ${recipient}`);
  } catch (err) {
    console.error('[cron] Morning brief failed:', err.message);
    // Best-effort failure alert — lets you know something went wrong
    const recipient = process.env.BRIEF_RECIPIENT;
    if (recipient) {
      try {
        const auth = getGoogleAuth();
        const gmail = google.gmail({ version: 'v1', auth });
        const subject = `=?utf-8?B?${Buffer.from('⚠ Daily Brief Failed').toString('base64')}?=`;
        const body = `Your morning brief failed to generate at ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' })} PT.\n\nError: ${err.message}\n\nCheck https://briefing-app.fly.dev/ to generate manually.`;
        const raw = [
          `To: ${recipient}`,
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          body,
        ].join('\r\n');
        await gmail.users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(raw).toString('base64url') } });
        console.log('[cron] Failure alert sent.');
      } catch (alertErr) {
        console.error('[cron] Could not send failure alert:', alertErr.message);
      }
    }
  }
}

// Schedule from config (falls back to 6:50am PT all days if config missing or corrupt)
scheduleFromConfig((() => { try { return readConfig(); } catch { return { ...CONFIG_DEFAULTS }; } })());

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  const cfg = (() => { try { return readConfig(); } catch { return CONFIG_DEFAULTS; } })();
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dayNames = cfg.briefDays.map(d => days[d]).join(', ') || 'none';
  console.log(`\n🌅  Briefing app running at http://localhost:${PORT}`);
  console.log(`📋  History at http://localhost:${PORT}/history`);
  console.log(`⏰  Morning brief cron: ${cfg.briefTime} PT on ${dayNames}${process.env.BRIEF_CRON ? ' (overridden by BRIEF_CRON)' : ''}\n`);
});

module.exports = app; // for supertest
