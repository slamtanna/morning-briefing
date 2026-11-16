'use strict';

import { test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadContext } from '../lib/context.js';

// Helper — write a temp CLAUDE.md and return its path
function writeTempMd(content) {
  const tmp = path.join(os.tmpdir(), `claude-md-test-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmp, content, 'utf8');
  return tmp;
}

// ---------------------------------------------------------------------------
// 1. Happy path — all four sections extracted
// ---------------------------------------------------------------------------
test('extracts People, Terms, Projects, Preferences sections', () => {
  const md = `
## People
| Who | Role |
|-----|------|
| Priya | CEO |

## Terms
| Term | Meaning |
|------|---------|
| BoD | Board |

## Projects
| Name | What |
|------|------|
| Series B | Fundraise |

## Preferences
- Direct and concise
`;
  const p = writeTempMd(md);
  try {
    const result = loadContext(p);
    expect(result.People).toContain('Priya');
    expect(result.Terms).toContain('BoD');
    expect(result.Projects).toContain('Series B');
    expect(result.Preferences).toContain('Direct');
  } finally {
    fs.unlinkSync(p);
  }
});

// ---------------------------------------------------------------------------
// 2. gstack stop — content after ## gstack is NOT included
// ---------------------------------------------------------------------------
test('stops extraction before ## gstack heading', () => {
  const md = `
## People
| Who | Role |
|-----|------|
| Priya | CEO |

## Preferences
- Direct

## gstack
This is gstack skill content — should NOT appear in context.
SUPER SECRET SKILL INSTRUCTIONS.
`;
  const p = writeTempMd(md);
  try {
    const result = loadContext(p);
    expect(result.People).toContain('Priya');
    expect(result.Preferences).toContain('Direct');
    const allText = Object.values(result).join(' ');
    expect(allText).not.toContain('SUPER SECRET SKILL');
  } finally {
    fs.unlinkSync(p);
  }
});

// ---------------------------------------------------------------------------
// 3. Missing required section — throws with clear message
// ---------------------------------------------------------------------------
test('throws at startup if ## People section is missing', () => {
  const md = `
## Terms
| Term | Meaning |
|------|---------|
| BoD | Board |

## Projects
| Name | What |
|------|------|
| Series B | Fundraise |
`;
  const p = writeTempMd(md);
  try {
    expect(() => loadContext(p)).toThrow('CLAUDE.md missing required section: ## People');
  } finally {
    fs.unlinkSync(p);
  }
});

// ---------------------------------------------------------------------------
// 4. Empty section — heading present, no content — should not throw
// ---------------------------------------------------------------------------
test('handles empty section (heading exists, no content)', () => {
  const md = `
## People
| Who | Role |
|-----|------|
| Priya | CEO |

## Terms

## Projects
| Name | What |
|------|------|
| Series B | Fundraise |
`;
  const p = writeTempMd(md);
  try {
    const result = loadContext(p);
    expect(result.People).toContain('Priya');
    expect(result.Terms).toBe('');
  } finally {
    fs.unlinkSync(p);
  }
});

// ---------------------------------------------------------------------------
// 5. File not found — throws with path in message
// ---------------------------------------------------------------------------
test('throws if file not found', () => {
  const missing = '/tmp/does-not-exist-briefing-test.md';
  expect(() => loadContext(missing)).toThrow(missing);
});

// ---------------------------------------------------------------------------
// 6. DATA_DIR set + volume file exists → reads from volume
// ---------------------------------------------------------------------------
test('reads from DATA_DIR/CLAUDE.md when DATA_DIR is set and file exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-datadir-'));
  const volumePath = path.join(tmpDir, 'CLAUDE.md');
  fs.writeFileSync(volumePath, `
## People
| Who | Role |
|-----|------|
| Jordan | Head of Sales |
`, 'utf8');
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  try {
    const result = loadContext();
    expect(result.People).toContain('Jordan');
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    fs.unlinkSync(volumePath);
    fs.rmdirSync(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 7. DATA_DIR set + volume file missing → falls back to bundled
// ---------------------------------------------------------------------------
test('falls back to bundled CLAUDE.md when DATA_DIR set but volume file absent', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-datadir-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  try {
    // With no volume file, loadContext must read the bundled path, not the DATA_DIR path.
    // The bundled file exists in the Docker image but may not on a dev machine.
    const bundled = path.join(os.homedir(), 'Claude Context', 'CLAUDE.md');
    if (fs.existsSync(bundled)) {
      expect(loadContext().People).toBeTruthy();
    } else {
      expect(() => loadContext()).toThrow(bundled);
    }
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    fs.rmdirSync(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 8. DATA_DIR set → CLAUDE_MD_PATH export points to volume path (write target)
// ---------------------------------------------------------------------------
test('CLAUDE_MD_PATH export uses DATA_DIR path when DATA_DIR is set at module load', async () => {
  // CLAUDE_MD_PATH is resolved at module load time, so we verify the pattern:
  // when DATA_DIR is set, CLAUDE_MD_PATH must end with /CLAUDE.md under DATA_DIR.
  // Import a fresh module instance with DATA_DIR pre-set.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-datadir-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  try {
    // Re-import with cache-busted URL to pick up the new DATA_DIR value
    const { CLAUDE_MD_PATH: volumeWritePath } = await import(`../lib/context.js?datadir=${tmpDir}`);
    expect(volumeWritePath).toBe(path.join(tmpDir, 'CLAUDE.md'));
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    fs.rmdirSync(tmpDir);
  }
});
