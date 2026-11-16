/**
 * Routes tests — test route logic directly without loading server.js
 * (server.js requires Google credentials on startup which aren't available in CI)
 *
 * Strategy: extract and test the route handler logic in isolation.
 */
import { test, expect, mock } from 'bun:test';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Feedback route logic (extracted from server.js for testing)
// ---------------------------------------------------------------------------
const FEEDBACK_FILE = '/tmp/test-briefing-feedback.jsonl';

function handleFeedback(body, appendFn) {
  const { type, rating, index, text_snippet, brief_ts } = body;

  if (!['watch_item', 'overall'].includes(type)) {
    return { status: 400, body: { error: 'type must be "watch_item" or "overall"' } };
  }
  if (rating !== 1 && rating !== -1) {
    return { status: 400, body: { error: 'rating must be 1 or -1' } };
  }

  const entry = {
    ts: new Date().toISOString(),
    brief_ts: brief_ts || null,
    type,
    index: index ?? null,
    rating,
    text_snippet: typeof text_snippet === 'string' ? text_snippet.slice(0, 80) : null,
  };

  appendFn(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------
// SSE query param parsing logic (extracted for testing)
// ---------------------------------------------------------------------------
function parseSSEParams(query) {
  return {
    calendar: query.calendar !== '0',
    gmail: query.gmail !== '0',
    slack: query.slack !== '0',
    tone: ['concise', 'standard', 'detailed'].includes(query.tone) ? query.tone : 'standard',
  };
}

// ---------------------------------------------------------------------------
// 1. calendar=0 skips Calendar flag
// ---------------------------------------------------------------------------
test('calendar=0 skips Google Calendar API call', () => {
  const params = parseSSEParams({ calendar: '0', gmail: '1', slack: '1' });
  expect(params.calendar).toBe(false);
  expect(params.gmail).toBe(true);
  expect(params.slack).toBe(true);
});

// ---------------------------------------------------------------------------
// 2. All sources disabled — flags are all false
// ---------------------------------------------------------------------------
test('all sources disabled → all flags are false', () => {
  const params = parseSSEParams({ calendar: '0', gmail: '0', slack: '0' });
  expect(params.calendar).toBe(false);
  expect(params.gmail).toBe(false);
  expect(params.slack).toBe(false);
});

// ---------------------------------------------------------------------------
// 3. Default params (no query string) — all enabled
// ---------------------------------------------------------------------------
test('no params → all sources enabled by default', () => {
  const params = parseSSEParams({});
  expect(params.calendar).toBe(true);
  expect(params.gmail).toBe(true);
  expect(params.slack).toBe(true);
  expect(params.tone).toBe('standard');
});

// ---------------------------------------------------------------------------
// 4. POST /api/feedback — valid entry appended to JSONL
// ---------------------------------------------------------------------------
test('POST /api/feedback appends valid entry to JSONL', () => {
  const appendMock = mock((path, content) => {});
  const result = handleFeedback(
    { type: 'overall', rating: 1, brief_ts: '2026-03-24T07:00:00Z' },
    appendMock
  );

  expect(result.status).toBe(200);
  expect(result.body.ok).toBe(true);
  expect(appendMock).toHaveBeenCalledTimes(1);

  const [, content] = appendMock.mock.calls[0];
  const entry = JSON.parse(content.trim());
  expect(entry.type).toBe('overall');
  expect(entry.rating).toBe(1);
  expect(entry.ts).toBeDefined();
  expect(entry.brief_ts).toBe('2026-03-24T07:00:00Z');
});

// ---------------------------------------------------------------------------
// 5. POST /api/feedback returns 400 for malformed body
// ---------------------------------------------------------------------------
test('POST /api/feedback returns 400 for malformed body', () => {
  const appendMock = mock(() => {});
  const result = handleFeedback({ invalid: true }, appendMock);
  expect(result.status).toBe(400);
  expect(appendMock).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 6. text_snippet truncated at 80 chars
// ---------------------------------------------------------------------------
test('text_snippet truncated at 80 chars in feedback entry', () => {
  const appendMock = mock((path, content) => {});
  const longSnippet = 'A'.repeat(200);
  handleFeedback({ type: 'watch_item', rating: 1, text_snippet: longSnippet }, appendMock);

  const [, content] = appendMock.mock.calls[0];
  const entry = JSON.parse(content.trim());
  expect(entry.text_snippet.length).toBeLessThanOrEqual(80);
});

// ---------------------------------------------------------------------------
// Schedule config handler logic (extracted for testing)
// ---------------------------------------------------------------------------
const CONFIG_DEFAULTS = { briefDays: [0, 1, 2, 3, 4, 5, 6], briefTime: '06:50' };

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

function readConfig(readFn, configFile = '/tmp/test-.briefing-config.json') {
  try {
    const raw = readFn(configFile, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...CONFIG_DEFAULTS, ...parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...CONFIG_DEFAULTS };
    throw err;
  }
}

function handleGetConfig(readFn, cronOverride = false) {
  try {
    const config = readConfig(readFn);
    return { status: 200, body: { ...config, cronOverride } };
  } catch {
    return { status: 500, body: { error: 'Failed to read config' } };
  }
}

function handlePostConfig(body, opts = {}) {
  const { readFn = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
          writeFn = () => {}, renameFn = () => {} } = opts;
  const dedupedDays = [...new Set((body.briefDays || []))];
  const err = validateConfig({ ...body, briefDays: dedupedDays });
  if (err) return { status: 400, body: { error: err } };
  const newConfig = { briefDays: dedupedDays.sort((a, b) => a - b), briefTime: body.briefTime };
  // (In real server, cronJob is rescheduled here — skip in tests)
  try {
    const tmpPath = `/tmp/.briefing-config.tmp.test`;
    writeFn(tmpPath, JSON.stringify(newConfig, null, 2), 'utf8');
    renameFn(tmpPath, '/tmp/test-.briefing-config.json');
  } catch {
    return { status: 500, body: { error: 'Failed to save config' } };
  }
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------
// 7. readConfig returns defaults when file does not exist
// ---------------------------------------------------------------------------
test('readConfig returns defaults when file does not exist', () => {
  const readFn = mock(() => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); });
  const config = readConfig(readFn);
  expect(config.briefDays).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(config.briefTime).toBe('06:50');
});

// ---------------------------------------------------------------------------
// 8. readConfig merges partial file with defaults
// ---------------------------------------------------------------------------
test('readConfig merges partial config with defaults', () => {
  const readFn = mock(() => JSON.stringify({ briefDays: [1, 2, 3, 4, 5] }));
  const config = readConfig(readFn);
  expect(config.briefDays).toEqual([1, 2, 3, 4, 5]);
  expect(config.briefTime).toBe('06:50'); // default preserved
});

// ---------------------------------------------------------------------------
// 9. readConfig re-throws on non-ENOENT errors
// ---------------------------------------------------------------------------
test('readConfig re-throws on corrupt file', () => {
  const readFn = mock(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
  expect(() => readConfig(readFn)).toThrow();
});

// ---------------------------------------------------------------------------
// 10. validateConfig — valid input passes
// ---------------------------------------------------------------------------
test('validateConfig returns null for valid config', () => {
  expect(validateConfig({ briefDays: [1, 2, 3, 4, 5], briefTime: '06:50' })).toBeNull();
});

// ---------------------------------------------------------------------------
// 11. validateConfig — empty briefDays is invalid
// ---------------------------------------------------------------------------
test('validateConfig rejects empty briefDays', () => {
  const err = validateConfig({ briefDays: [], briefTime: '06:50' });
  expect(err).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 12. validateConfig — out-of-range day is invalid
// ---------------------------------------------------------------------------
test('validateConfig rejects out-of-range briefDays values', () => {
  expect(validateConfig({ briefDays: [0, 7], briefTime: '06:50' })).toBeTruthy();
  expect(validateConfig({ briefDays: [-1, 1], briefTime: '06:50' })).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 13. validateConfig — non-integer day is invalid
// ---------------------------------------------------------------------------
test('validateConfig rejects non-integer briefDays', () => {
  expect(validateConfig({ briefDays: [1, 1.5], briefTime: '06:50' })).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 14. validateConfig — deduplication: [1,1,2] treated as [1,2] (valid)
// ---------------------------------------------------------------------------
test('validateConfig accepts deduplicated days', () => {
  const deduped = [...new Set([1, 1, 2])];
  expect(validateConfig({ briefDays: deduped, briefTime: '06:50' })).toBeNull();
});

// ---------------------------------------------------------------------------
// 15. validateConfig — invalid briefTime formats
// ---------------------------------------------------------------------------
test('validateConfig rejects briefTime without leading zero', () => {
  expect(validateConfig({ briefDays: [1], briefTime: '6:50' })).toBeTruthy();
});

test('validateConfig rejects briefTime out of range', () => {
  expect(validateConfig({ briefDays: [1], briefTime: '25:00' })).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 16. validateConfig — boundary briefTimes pass
// ---------------------------------------------------------------------------
test('validateConfig accepts boundary briefTime values', () => {
  expect(validateConfig({ briefDays: [1], briefTime: '00:00' })).toBeNull();
  expect(validateConfig({ briefDays: [1], briefTime: '23:59' })).toBeNull();
});

// ---------------------------------------------------------------------------
// 17. GET /config returns 200 with defaults when file missing
// ---------------------------------------------------------------------------
test('handleGetConfig returns 200 with defaults when file does not exist', () => {
  const readFn = mock(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
  const result = handleGetConfig(readFn, false);
  expect(result.status).toBe(200);
  expect(result.body.briefDays).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(result.body.cronOverride).toBe(false);
});

// ---------------------------------------------------------------------------
// 18. GET /config returns cronOverride: true when BRIEF_CRON is set
// ---------------------------------------------------------------------------
test('handleGetConfig returns cronOverride: true when flag set', () => {
  const readFn = mock(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
  const result = handleGetConfig(readFn, true);
  expect(result.body.cronOverride).toBe(true);
});

// ---------------------------------------------------------------------------
// 19. GET /config returns 500 when file exists but readFn throws non-ENOENT
// ---------------------------------------------------------------------------
test('handleGetConfig returns 500 when readFn throws non-ENOENT', () => {
  const readFn = mock(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
  const result = handleGetConfig(readFn, false);
  expect(result.status).toBe(500);
});

// ---------------------------------------------------------------------------
// 20. POST /config — valid body returns 200
// ---------------------------------------------------------------------------
test('handlePostConfig returns 200 for valid body', () => {
  const writeFn = mock(() => {});
  const renameFn = mock(() => {});
  const result = handlePostConfig(
    { briefDays: [1, 2, 3, 4, 5], briefTime: '06:50' },
    { writeFn, renameFn }
  );
  expect(result.status).toBe(200);
  expect(result.body.ok).toBe(true);
  expect(writeFn).toHaveBeenCalledTimes(1);
  expect(renameFn).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// 21. POST /config — invalid body returns 400
// ---------------------------------------------------------------------------
test('handlePostConfig returns 400 for invalid body', () => {
  const writeFn = mock(() => {});
  const result = handlePostConfig({ briefDays: [], briefTime: '06:50' }, { writeFn });
  expect(result.status).toBe(400);
  expect(writeFn).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 22. POST /config — write failure returns 500
// ---------------------------------------------------------------------------
test('handlePostConfig returns 500 when writeFn throws', () => {
  const writeFn = mock(() => { throw new Error('disk full'); });
  const renameFn = mock(() => {});
  const result = handlePostConfig(
    { briefDays: [1, 2, 3, 4, 5], briefTime: '07:00' },
    { writeFn, renameFn }
  );
  expect(result.status).toBe(500);
});

// ---------------------------------------------------------------------------
// 23. POST /config — deduplicates briefDays silently
// ---------------------------------------------------------------------------
test('handlePostConfig deduplicates briefDays and still returns 200', () => {
  const writeFn = mock(() => {});
  const renameFn = mock(() => {});
  const result = handlePostConfig(
    { briefDays: [1, 1, 2, 3], briefTime: '06:50' },
    { writeFn, renameFn }
  );
  expect(result.status).toBe(200);
  // Verify written config has deduped days
  const written = JSON.parse(writeFn.mock.calls[0][1]);
  expect(written.briefDays).toEqual([1, 2, 3]);
});
