import { test, expect, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Import lib
// ---------------------------------------------------------------------------
const { fetchBriefData, generateBriefText } = await import('../lib/brief.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ORG_CONTEXT = 'People: Priya (CEO)';

function makeCalendarClient(items = []) {
  return {
    events: {
      list: mock(() => Promise.resolve({ data: { items } })),
    },
  };
}

function makeGmailClient(messages = [], getImpl = null) {
  const defaultGet = () => Promise.resolve({
    data: {
      payload: {
        headers: [
          { name: 'From', value: 'user@example.com' },
          { name: 'Subject', value: 'Test subject' },
          { name: 'Date', value: '2026-03-23' },
        ],
      },
      snippet: 'Short snippet',
    },
  });
  return {
    users: {
      messages: {
        list: mock(() => Promise.resolve({ data: { messages } })),
        get: mock(getImpl || (() => defaultGet())),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 1. generateBriefText returns a string (headless mode)
// ---------------------------------------------------------------------------
test('generateBriefText returns string, not AsyncGenerator', async () => {
  // Inject a mock client via the _client option (no real API call)
  const mockClient = {
    messages: {
      create: mock(() => Promise.resolve({
        content: [{ type: 'text', text: 'Hello world' }],
      })),
    },
  };

  const data = {
    events: [{ summary: 'Standup', start: '09:00', end: '09:30', location: '', description: '' }],
    emails: [],
    messages: [],
    unavailable: [],
  };

  const result = await generateBriefText(data, ORG_CONTEXT, { _client: mockClient });
  expect(typeof result).toBe('string');
  expect(result).toContain('Hello world');
});

// ---------------------------------------------------------------------------
// 2. One source failing does not abort brief generation (Promise.allSettled)
// ---------------------------------------------------------------------------
test('one source failing does not abort brief generation', async () => {
  const badGmail = {
    users: {
      messages: {
        list: mock(() => Promise.reject(new Error('Network error'))),
        get: mock(() => Promise.reject(new Error('Network error'))),
      },
    },
  };
  const goodCalendar = makeCalendarClient([{
    summary: 'Meeting', start: { dateTime: '09:00' }, end: { dateTime: '10:00' }
  }]);

  const data = await fetchBriefData(
    { calendar: goodCalendar, gmail: badGmail, slackClient: null },
    { calendar: true, gmail: true, slack: false }
  );

  expect(data.unavailable).toContain('Gmail');
  expect(data.unavailable).toContain('Slack');
  expect(data.events.length).toBeGreaterThan(0);
  expect(data.emails).toEqual([]);
});

// ---------------------------------------------------------------------------
// 3. Gmail capped at 20 emails
// ---------------------------------------------------------------------------
test('Gmail capped at 20 emails', async () => {
  const mockMessages = Array.from({ length: 25 }, (_, i) => ({ id: `msg-${i}` }));
  const gmailClient = makeGmailClient(mockMessages);

  const data = await fetchBriefData(
    { gmail: gmailClient, calendar: null, slackClient: null },
    { calendar: false, gmail: true, slack: false }
  );

  expect(data.emails.length).toBeLessThanOrEqual(20);
});

// ---------------------------------------------------------------------------
// Slack last_read cursor helpers
// ---------------------------------------------------------------------------
function makeSlackClient({ infoImpl, historyMessages = [] } = {}) {
  return {
    conversations: {
      list: mock(() => Promise.resolve({
        channels: [{ id: 'C1', name: 'general', is_member: true }],
      })),
      info: mock(infoImpl || (() => Promise.resolve({ channel: {} }))),
      history: mock(() => Promise.resolve({ messages: historyMessages })),
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Email body truncated at 200 chars
// ---------------------------------------------------------------------------
test('email body truncated at 200 chars', async () => {
  const longSnippet = 'X'.repeat(500);
  const gmailClient = makeGmailClient([{ id: 'msg-1' }], () =>
    Promise.resolve({
      data: {
        payload: {
          headers: [
            { name: 'From', value: 'alice@example.com' },
            { name: 'Subject', value: 'Long email' },
            { name: 'Date', value: '2026-03-23' },
          ],
        },
        snippet: longSnippet,
      },
    })
  );

  const data = await fetchBriefData(
    { gmail: gmailClient, calendar: null, slackClient: null },
    { calendar: false, gmail: true, slack: false }
  );

  expect(data.emails.length).toBe(1);
  expect(data.emails[0].snippet.length).toBeLessThanOrEqual(200);
});

// ---------------------------------------------------------------------------
// 5. Slack last_read cursor — filters out boundary message and older messages
// ---------------------------------------------------------------------------
test('fetchSlackMessages uses last_read cursor and excludes boundary message', async () => {
  const lastReadTs = '1700000000.000000';
  const staleMsg    = { type: 'message', ts: '1699999999.000000', text: 'stale', user: 'U1' };
  const boundaryMsg = { type: 'message', ts: lastReadTs,          text: 'at boundary', user: 'U1' };
  const freshMsg    = { type: 'message', ts: '1700000001.000000', text: 'fresh', user: 'U1' };

  const slackClient = makeSlackClient({
    infoImpl: () => Promise.resolve({ channel: { last_read: lastReadTs } }),
    historyMessages: [freshMsg, boundaryMsg, staleMsg],
  });

  const data = await fetchBriefData(
    { calendar: null, gmail: null, slackClient },
    { calendar: false, gmail: false, slack: true }
  );

  expect(data.messages.length).toBe(1);
  expect(data.messages[0].text).toBe('fresh');
});

// ---------------------------------------------------------------------------
// 6. Slack: conversations.info failure falls back to 24h window (no skip)
// ---------------------------------------------------------------------------
test('fetchSlackMessages falls back to 24h window when conversations.info fails', async () => {
  const recentMsg = { type: 'message', ts: String(Math.floor(Date.now() / 1000) - 3600), text: 'recent', user: 'U1' };

  const slackClient = makeSlackClient({
    infoImpl: () => Promise.reject(new Error('API error')),
    historyMessages: [recentMsg],
  });

  const data = await fetchBriefData(
    { calendar: null, gmail: null, slackClient },
    { calendar: false, gmail: false, slack: true }
  );

  // conversations.history must still be called despite info failure
  expect(slackClient.conversations.history.mock.calls.length).toBe(1);
  expect(data.messages.length).toBe(1);
  expect(data.messages[0].text).toBe('recent');
});

// ---------------------------------------------------------------------------
// 7. Slack: absent last_read falls back to 24h window gracefully
// ---------------------------------------------------------------------------
test('fetchSlackMessages falls back to 24h window when last_read is absent', async () => {
  const recentMsg = { type: 'message', ts: String(Math.floor(Date.now() / 1000) - 3600), text: 'recent', user: 'U1' };

  const slackClient = makeSlackClient({
    infoImpl: () => Promise.resolve({ channel: {} }), // no last_read field
    historyMessages: [recentMsg],
  });

  const data = await fetchBriefData(
    { calendar: null, gmail: null, slackClient },
    { calendar: false, gmail: false, slack: true }
  );

  expect(data.messages.length).toBe(1);
  expect(data.messages[0].text).toBe('recent');
});
