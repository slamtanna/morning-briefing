# Briefing App — Feature Backlog

Priority: **P1** = blocking / breaks silently | **P2** = meaningful quality of life | **P3** = nice to have
Effort: **S** = <1hr | **M** = half day | **L** = full day+

---

## P1 — Fix or ship soon

### Schedule configurability — post-ship fast follows
After the schedule config PR ships, two small follow-ups:

**"No briefing days selected" warning**
**Problem:** If all 7 day checkboxes are unchecked, the cron silently skips every day with no indication in the UI.
**Fix:** Reuse the existing `.settings-warning` pattern (same as "All sources off" warning). Show "No briefing days selected — brief will never send." when zero days are checked.
**Effort:** S

**"Next brief: [Day] at [Time]" indicator**
**Problem:** After changing the schedule, there's no confirmation of when the next brief fires.
**Fix:** Compute next briefing day/time client-side from the loaded config. Show "Next brief: Monday at 6:50am PT" below the day checkboxes.
**Effort:** S

---

## P2 — Meaningful quality of life

### Source attribution per brief
**Problem:** No way to tell which sources (Calendar / Gmail / Slack) actually had content for any given brief. The `/history` page shows source tags but they only indicate what was _fetched_, not what was _useful_.
**Fix:** Claude already gets all three — prompt it to note at the top which sources contributed substantively. Or just show fetch counts (e.g., "14 emails, 3 events, 22 Slack messages") in the brief header.
**Effort:** S

### Tone memory
**Problem:** You select tone (concise / standard / detailed) every session, but it resets to "standard" each load.
**Fix:** `localStorage` — remember last-used tone in the browser.
**Effort:** S

### Brief quality feedback loop
**Problem:** Thumbs up/down feedback is collected in `~/.briefing-feedback.jsonl` but never used for anything. It's write-only right now.
**Fix (minimal):** Show feedback stats in the UI ("You've rated 12 of 30 briefs. 83% positive.") so at least the data feels alive.
**Fix (real):** Pass low-rated brief examples back into the system prompt as anti-examples. Closes the loop.
**Effort:** S (stats display) / L (actual tuning loop)

### Slack channel filtering
**Problem:** The app pulls the first 10 joined channels by default. Some channels are noise; others are critical. No way to configure which ones matter.
**Fix:** Add a `SLACK_CHANNELS` env var (comma-separated channel names). If set, only fetch those. If unset, current behavior.
**Effort:** S

### Brief send time configurability
**Problem:** 6:50am PT is hardcoded. Not useful if timezone or schedule changes.
**Fix:** `BRIEF_CRON` env var (cron expression). Defaults to `50 6 * * *` with `America/Los_Angeles`. Validated on startup.
**Effort:** S

---

## P3 — Nice to have

### Express 5.x upgrade
**Why:** Resolves path-to-regexp HIGH CVE (GHSA-37ch-88jc-xwx2) in the dependency tree. Routes and middleware are simple — upgrade is low-risk.
**Effort:** S (upgrade + smoke test)

### Security headers via helmet
**Why:** CSP, X-Frame-Options, X-Content-Type-Options. No functional impact; defense-in-depth for the web UI.
**Fix:** `bun add helmet` + `app.use(helmet())` before routes.
**Effort:** S

### Brief email open tracking
**Why:** Know whether you actually read the brief (useful for gauging how much you rely on it).
**Fix:** Append a 1x1 tracking pixel to the HTML email. Self-hosted endpoint (just a counter) or skip entirely.
**Effort:** M

### Mobile push instead of (or in addition to) email
**Why:** Email is one more thing to open. A push notification with the brief as a rich preview would be faster to consume.
**Options:** Pushover (dead-simple API, $5 one-time), ntfy.sh (free, self-hostable), iOS Shortcuts webhook.
**Effort:** S (Pushover) / M (ntfy with self-hosted)

---

## Completed

- [x] Basic web UI with SSE streaming
- [x] Google Calendar + Gmail + Slack integration
- [x] CLAUDE.md org context (hot-reload via web UI)
- [x] Brief history page
- [x] Feedback collection (thumbs up/down)
- [x] HTTP Basic Auth
- [x] 6:50am PT cron with Gmail send
- [x] Fly.io deployment (Firecracker VMs, HTTPS)
- [x] Non-root container (USER bun)
- [x] Token refresh callback hardened (ENOENT on homedir change)
- [x] XSS fix in SSE error handler
- [x] Cron failure alerting (failure email via Gmail with error + manual link)
- [x] Duplicate cron on two machines (scaled to 1 machine via `fly scale count 1`)
- [x] Git repo initialized + pushed to GitHub
- [x] Persistent volume for CLAUDE.md, brief history, feedback, and schedule config (DATA_DIR + Fly volume)
