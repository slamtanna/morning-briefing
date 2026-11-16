'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Anthropic = require('@anthropic-ai/sdk');

const HISTORY_FILE = path.join(process.env.DATA_DIR || os.homedir(), '.briefing-history.jsonl');

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

/**
 * Fetch today's calendar events (up to 20).
 * Returns array of { summary, start, end, location } or throws.
 */
async function fetchCalendarEvents(calendar) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: todayStart,
    timeMax: todayEnd,
    maxResults: 20,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (res.data.items || []).map(ev => ({
    summary: ev.summary || '(untitled)',
    start: ev.start?.dateTime || ev.start?.date || '',
    end: ev.end?.dateTime || ev.end?.date || '',
    location: ev.location || '',
    description: (ev.description || '').slice(0, 100),
  }));
}

/**
 * Fetch inbox emails from last 24 hours, capped at 20.
 * Subject + sender + first 200 chars of snippet.
 */
async function fetchEmails(gmail) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['INBOX'],
    q: 'newer_than:1d',
    maxResults: 20,
  });

  const messages = res.data.messages || [];
  const emails = [];

  for (const msg of messages.slice(0, 20)) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });

    const headers = detail.data.payload?.headers || [];
    const get = name => (headers.find(h => h.name === name) || {}).value || '';

    emails.push({
      subject: get('Subject'),
      from: get('From'),
      date: get('Date'),
      snippet: (detail.data.snippet || '').slice(0, 200),
    });
  }

  return emails;
}

/**
 * Fetch unread Slack messages across key channels using each channel's last_read cursor.
 * Falls back to a 24h window if conversations.info fails or last_read is absent.
 */
async function fetchSlackMessages(slackClient) {
  const fallbackOldest = String(Math.floor(Date.now() / 1000) - 86400);

  // Get list of joined channels — filter to public + private
  const channelsRes = await slackClient.conversations.list({
    types: 'public_channel,private_channel',
    limit: 20,
    exclude_archived: true,
  });

  const channels = (channelsRes.channels || []).filter(c => c.is_member).slice(0, 10);
  const allMessages = [];

  for (const ch of channels) {
    try {
      // Resolve oldest ts: use last_read cursor so only unread messages appear.
      // Falls back to 24h window if info call fails or last_read is absent.
      let oldest = fallbackOldest;
      let lastRead = null;
      try {
        const infoRes = await slackClient.conversations.info({ channel: ch.id });
        lastRead = infoRes.channel?.last_read || null;
        if (lastRead) oldest = lastRead;
      } catch {
        // info failed — fall back to 24h window for this channel
      }

      const histRes = await slackClient.conversations.history({
        channel: ch.id,
        oldest,
        limit: 10,
      });
      // Slack's oldest param is inclusive — filter out the already-read boundary message
      const msgs = (histRes.messages || []).filter(m =>
        m.type === 'message' && !m.bot_id && (!lastRead || m.ts > lastRead)
      );
      for (const m of msgs) {
        allMessages.push({
          channel: ch.name,
          user: m.user || 'unknown',
          text: (m.text || '').slice(0, 200),
          ts: m.ts,
        });
      }
    } catch {
      // Skip this channel silently (history failed)
    }
  }

  return allMessages.slice(0, 50);
}

/**
 * Fetch all data sources in parallel. Uses Promise.allSettled so one failure
 * doesn't abort the brief. Returns { events, emails, messages, unavailable }.
 *
 * @param {{ calendar, gmail, slackClient }} sources - initialized API clients
 * @param {{ calendar: boolean, gmail: boolean, slack: boolean }} flags
 */
async function fetchBriefData(sources, flags) {
  const tasks = [
    flags.calendar ? fetchCalendarEvents(sources.calendar) : Promise.resolve(null),
    flags.gmail ? fetchEmails(sources.gmail) : Promise.resolve(null),
    flags.slack ? fetchSlackMessages(sources.slackClient) : Promise.resolve(null),
  ];

  const [calResult, gmailResult, slackResult] = await Promise.allSettled(tasks);

  const unavailable = [];
  let events = [], emails = [], messages = [];

  if (!flags.calendar) {
    unavailable.push('Calendar');
  } else if (calResult.status === 'rejected') {
    unavailable.push('Calendar');
    console.error('Calendar fetch failed:', calResult.reason?.message);
  } else {
    events = calResult.value || [];
  }

  if (!flags.gmail) {
    unavailable.push('Gmail');
  } else if (gmailResult.status === 'rejected') {
    unavailable.push('Gmail');
    console.error('Gmail fetch failed:', gmailResult.reason?.message);
  } else {
    emails = gmailResult.value || [];
  }

  if (!flags.slack) {
    unavailable.push('Slack');
  } else if (slackResult.status === 'rejected') {
    unavailable.push('Slack');
    console.error('Slack fetch failed:', slackResult.reason?.message);
  } else {
    messages = slackResult.value || [];
  }

  return { events, emails, messages, unavailable };
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildSystemPrompt(orgContext) {
  return `You are a personal chief of staff briefing assistant.

ORG CONTEXT:
${orgContext}

BRIEF FORMAT:
Write a narrative morning brief addressed to the reader in four sections:
1. Overview — 2-3 sentences of situational awareness for the day. No action items here.
2. Watch — items requiring the reader's action before EOD (deadlines, blockers, unanswered threads)
3. Today — a markdown table with columns: Time | Meeting | Context. One row per event. Context = why it matters / what to have ready. Example row: | 10:00 AM | Daily Ops Review | Atlas launch status expected — ask Alex for the checklist |
4. From Slack & Email — anything notable from unread messages not already covered above

Tone: direct, no filler. Address the reader as "you". Reference people by name, use
project names and acronyms as defined in the org context above.
Example Watch item: "You haven't responded to Marcus's question about slide 22 — BoD deck finalizes at 5pm."`;
}

function buildUserPrompt({ events, emails, messages, unavailable, tone }) {
  const toneNote = tone === 'concise' ? 'Be more concise than usual.'
    : tone === 'detailed' ? 'Provide more detail than usual.'
    : '';

  const unavailableNote = unavailable.length > 0
    ? `⚠ Unavailable sources: ${unavailable.join(', ')}\n\n`
    : '';

  const calSection = events.length === 0
    ? 'No calendar events today.'
    : `CALENDAR EVENTS (${events.length}):\n` + events.map(e =>
        `- ${e.summary} | ${e.start} → ${e.end}${e.location ? ` | ${e.location}` : ''}${e.description ? ` | ${e.description}` : ''}`
      ).join('\n');

  const emailSection = emails.length === 0
    ? 'No emails in last 24h.'
    : `INBOX EMAILS (${emails.length}):\n` + emails.map(e =>
        `- From: ${e.from}\n  Subject: ${e.subject}\n  Snippet: ${e.snippet}`
      ).join('\n\n');

  const slackSection = messages.length === 0
    ? 'No unread Slack messages.'
    : `SLACK MESSAGES (${messages.length} unread):\n` + messages.map(m =>
        `- #${m.channel}: ${m.text}`
      ).join('\n');

  return `${unavailableNote}${toneNote ? toneNote + '\n\n' : ''}Today is ${new Date().toDateString()}.

${calSection}

---

${emailSection}

---

${slackSection}`;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function appendHistory(entry) {
  try {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('Failed to write history:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Brief generation — two modes
// ---------------------------------------------------------------------------

let _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic();
  }
  return _anthropicClient;
}

/**
 * Stream brief to an SSE response object.
 * Writes chunks as `data: <text>\n\n`, ends with `data: [DONE]\n\n`.
 * On error sends `event: error\ndata: <message>\n\n`.
 *
 * @param {{ events, emails, messages, unavailable }} data
 * @param {string} orgContext
 * @param {{ tone: string, briefTs: string }} opts
 * @param {import('http').ServerResponse} res
 */
async function streamBrief(data, orgContext, opts, res) {
  const { tone = 'standard', briefTs } = opts;
  const startMs = Date.now();
  const fullText = [];
  const sources = [];
  if (data.events.length > 0) sources.push('calendar');
  if (data.emails.length > 0) sources.push('gmail');
  if (data.messages.length > 0) sources.push('slack');

  const client = getAnthropicClient();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: buildSystemPrompt(orgContext),
      messages: [{ role: 'user', content: buildUserPrompt({ ...data, tone }) }],
    }, { signal: controller.signal });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text;
        fullText.push(text);
        res.write(`data: ${JSON.stringify(text)}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    appendHistory({
      ts: briefTs,
      brief: fullText.join(''),
      sources,
      duration_ms: Date.now() - startMs,
    });
  } catch (err) {
    const msg = controller.signal.aborted
      ? 'Brief generation timed out — try again.'
      : `Brief generation failed: ${err.message}`;
    console.error('streamBrief error:', err.message);
    res.write(`event: error\ndata: ${JSON.stringify(msg)}\n\n`);
  } finally {
    clearTimeout(timeout);
    res.end();
  }
}

/**
 * Generate brief as a string (headless mode — for cron / Phase 2).
 * Also appends to history JSONL.
 *
 * @param {{ events, emails, messages, unavailable }} data
 * @param {string} orgContext
 * @param {{ tone: string, _client?: object }} opts
 * @returns {Promise<string>}
 */
async function generateBriefText(data, orgContext, opts = {}) {
  const { tone = 'standard', _client } = opts;
  const startMs = Date.now();
  const briefTs = new Date().toISOString();
  const sources = [];
  if (data.events.length > 0) sources.push('calendar');
  if (data.emails.length > 0) sources.push('gmail');
  if (data.messages.length > 0) sources.push('slack');

  const client = _client || getAnthropicClient();
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: buildSystemPrompt(orgContext),
    messages: [{ role: 'user', content: buildUserPrompt({ ...data, tone }) }],
  });

  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  appendHistory({ ts: briefTs, brief: text, sources, duration_ms: Date.now() - startMs });
  return text;
}

module.exports = { fetchBriefData, streamBrief, generateBriefText, HISTORY_FILE };
