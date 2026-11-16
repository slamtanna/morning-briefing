# Morning Briefing

A personal morning briefing tool. Every morning it pulls your Google Calendar, Gmail inbox, and Slack channels, feeds them to Claude, and emails you a structured brief. There's also a web UI where you can generate a brief on demand, read your history, and manage your org context.

Deployed on [Fly.io](https://fly.io). Secured with HTTP Basic Auth. Runs on [Bun](https://bun.sh).

---

## Why I built this

As a Chief of Staff, the first hour of my day went to reconstructing context: what's on the calendar, which threads need a reply, what moved in Slack overnight, and which of those things touch the projects that matter this week. That's pattern-matching against org context I already had in my head, so I wrote that context down once and handed the assembly job to Claude.

The design choices that made it useful in practice:

- **Org context as a file, not a prompt.** People, acronyms, projects, and preferences live in one Markdown file (see [`CLAUDE.example.md`](CLAUDE.example.md)). The brief resolves "MW" or "Atlas" correctly because the model knows who and what they are.
- **Action before narrative.** The brief leads with what needs a decision or reply today, then the calendar with *why each meeting matters*, then everything else.
- **Fails loud, not silent.** If a source is down, the brief says so; if the scheduled send fails, a failure email goes out with a manual-trigger link.
- **Unread-only Slack.** Uses Slack's `last_read` cursor so the brief covers what you haven't seen, not the last N messages.

Built with [Claude Code](https://claude.com/claude-code) as a pair programmer.

---

## What it does

- **Scheduled auto-brief** (default 6:50am PT, configurable days and time) — cron job fetches calendar, inbox, Slack, generates a narrative brief via Claude, and sends it to your email
- **Web UI** — generate briefs on demand, toggle sources (calendar / gmail / slack), choose tone (concise / standard / detailed)
- **Brief history** — browse and delete past briefs at `/history`
- **CLAUDE.md context** — upload your org context file (people, projects, terms) to personalize every brief
- **Feedback** — thumbs up/down on Watch items and overall briefs (logged locally for future tuning)

---

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Fly.io account](https://fly.io) + `fly` CLI
- Google Cloud project with Calendar, Gmail, and Gmail Send APIs enabled
- Slack user token (for workspace message access)
- Anthropic API key

---

## First-time setup

### 1. Clone and install

```bash
git clone <repo>
cd briefing-app
bun install
```

### 2. Create config directory and credentials file

```bash
mkdir -p ~/.config/briefing-app
```

Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → Create OAuth2 client (type: Desktop App). Download `credentials.json` and save to:

```
~/.config/briefing-app/credentials.json
```

### 3. Authorize Google OAuth

```bash
bun run auth
```

This opens a browser, prompts for OAuth consent, and saves a refresh token to `~/.config/briefing-app/token.json`. You only need to do this once (tokens refresh automatically).

> **Note:** If your Google app is in "Testing" mode, your account must be added as a test user in the OAuth consent screen, and tokens expire every 7 days. To avoid this, publish the app in the OAuth consent screen settings.

### 4. Create your `.env` file

```bash
cat > ~/.config/briefing-app/.env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
SLACK_USER_TOKEN=xoxp-...
BRIEF_RECIPIENT=you@example.com
BRIEF_USER=your-username
BRIEF_PASS=your-password
EOF
```

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `SLACK_USER_TOKEN` | Slack user token (xoxp-) for reading channels you're a member of |
| `BRIEF_RECIPIENT` | Email address to receive daily briefs |
| `BRIEF_USER` | Username for HTTP Basic Auth on the web UI |
| `BRIEF_PASS` | Password for HTTP Basic Auth on the web UI |

### 5. Run locally

```bash
bun start
```

Open [http://localhost:3000](http://localhost:3000). Log in with the username and password from your `.env`.

---

## Deploying to Fly.io

### First deploy

```bash
fly launch  # if app doesn't exist yet
fly deploy
```

### Set secrets

```bash
fly secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  SLACK_USER_TOKEN=xoxp-... \
  BRIEF_RECIPIENT=you@example.com \
  BRIEF_USER=your-username \
  BRIEF_PASS=your-password \
  --app briefing-app
```

### Set Google credentials as secrets

The app reads Google credentials from environment variables in production (avoids baking tokens into the image):

```bash
fly secrets set \
  GOOGLE_CREDENTIALS_B64=$(base64 -i ~/.config/briefing-app/credentials.json) \
  GOOGLE_TOKEN_B64=$(base64 -i ~/.config/briefing-app/token.json) \
  --app briefing-app
```

If you ever need to re-authorize (e.g., after revoking access):

```bash
bun run auth
fly secrets set GOOGLE_TOKEN_B64=$(base64 -i ~/.config/briefing-app/token.json) --app briefing-app
```

### Re-deploy after code changes

```bash
fly deploy --app briefing-app
```

### Pausing the app (stop paying for compute)

The included `fly.toml` keeps a stopped machine stopped — `auto_start_machines = false` and `min_machines_running = 0`. Suspending a machine directly (`fly machine suspend`) is not enough on its own: with `min_machines_running = 1`, Fly's autoscaler restarts a suspended machine to satisfy the minimum. The volume (`briefing_data`, holds CLAUDE.md/history/feedback) is untouched while stopped, so no data is lost.

To pause:

```bash
fly machine list --app briefing-app        # get the machine ID
fly machine stop <machine-id> --app briefing-app
```

### Resuming the app

```bash
fly machine start <machine-id> --app briefing-app
```

If you want it to go back to always-on (restart automatically, scale as needed), revert `fly.toml`'s `[http_service]` block to `auto_start_machines = true` / `min_machines_running = 1` and `fly deploy`. The scheduled brief will only fire while the machine is running, so remember to resume before you want briefs again.

---

## CLAUDE.md org context

The brief is personalized using a `CLAUDE.md` file containing your org's people, projects, acronyms, and preferences. The app loads this at startup and injects it into every system prompt.

Start from the fictional example:

```bash
cp CLAUDE.example.md CLAUDE.md   # then edit with your own people, terms, projects
```

The parser reads four sections by exact heading — `## People` (required), `## Terms`, `## Projects`, `## Preferences`.

> **Keep your real `CLAUDE.md` out of git.** It's in `.gitignore` because an org context file is, by design, a dense summary of confidential information. The Docker image bakes in only the fictional example; supply your real context at runtime via `CLAUDE_MD_B64` or the web UI upload.

**Updating context without redeploying:**

1. In the web UI, click "Context (CLAUDE.md)" in the bottom panel
2. Upload a file or paste content directly
3. Click "Upload" — the server hot-reloads instantly

The updated context persists on disk until the next deploy. For true persistence across deploys, set `CLAUDE_MD_B64`:

```bash
fly secrets set CLAUDE_MD_B64=$(base64 -i ~/path/to/your/CLAUDE.md) --app briefing-app
```

The priority order is: `CLAUDE_MD_B64` env var → file on disk → the example baked into the image.

---

## Project structure

```
morning-briefing/
├── CLAUDE.example.md  # Fictional org context — copy to CLAUDE.md (gitignored)
├── server.js          # Express app — all routes and middleware
├── auth.js            # One-time Google OAuth setup script
├── index.html         # Web UI (served as static file)
├── Dockerfile         # Production image (runs as non-root bun user)
├── fly.toml           # Fly.io deployment config
├── lib/
│   ├── brief.js       # Data fetching (Calendar, Gmail, Slack) + AI prompt building + streaming
│   └── context.js     # CLAUDE.md loading, section extraction, system prompt building
└── test/
    ├── brief.test.js
    ├── context.test.js
    └── routes.test.js
```

---

## API endpoints

All endpoints require HTTP Basic Auth.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Web UI |
| `GET` | `/api/brief` | Stream a brief via SSE. Query params: `calendar=0/1`, `gmail=0/1`, `slack=0/1`, `tone=concise/standard/detailed` |
| `POST` | `/api/update-context` | Upload new CLAUDE.md content (raw text body, up to 2MB) |
| `POST` | `/api/send-now` | Manually trigger the morning brief email |
| `POST` | `/api/feedback` | Submit thumbs-up/down on a brief item |
| `DELETE` | `/api/history/:ts` | Delete a history entry by timestamp |
| `GET` | `/history` | Browse past briefs |

---

## Running tests

```bash
bun test
```

Tests cover CLAUDE.md parsing, brief generation logic, and API routes.

---

## Security notes

- All routes are protected by HTTP Basic Auth. Set `BRIEF_USER` and `BRIEF_PASS` — if either is missing, the app starts unprotected (warning logged).
- The container runs as a non-root `bun` user (UID 1000).
- Credentials live in Fly.io secrets, not in the image.
- Brief history and feedback are stored locally in `~/.briefing-history.jsonl` and `~/.briefing-feedback.jsonl`. These files are not exported or synced anywhere.
- Every brief sends calendar event titles, email subjects/snippets, and Slack message text to the Anthropic API. These are transient — not stored by Anthropic beyond standard API logging policies.
