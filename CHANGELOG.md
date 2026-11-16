# Changelog

All notable changes to briefing-app are documented here.

## [1.1.0.0] - 2026-05-27

### Added
- Schedule configurability: choose which days of the week to receive a brief via day-of-week checkboxes in the Settings panel (Mon-Sun, any combination)
- Time picker in Settings to set the brief send time (defaults to 06:50 PT)
- `GET /config` and `POST /config` API endpoints for reading and persisting schedule settings
- `DATA_DIR` env var support for config file path — set to `/data` when a Fly volume is mounted so schedule config survives deploys
- `BRIEF_CRON` env var override: if set, controls the cron expression directly; time input in UI is disabled and shows a note
- Cron expression derived dynamically from saved `briefTime` on startup and on config change
- Atomic config writes via temp file + rename to prevent corrupt config on crash

### Changed
- Morning brief now skips silently on days not in the configured `briefDays` list (previously fired every day)
- Startup log now shows the scheduled days and time instead of a hardcoded "6:50am PT"

## [1.0.0.0] - 2026-03-25

### Added
- Initial release: streaming brief generation from Google Calendar, Gmail, and Slack
- SSE-based web UI with Settings panel (source toggles, tone selector)
- CLAUDE.md org context with hot-reload via web UI
- Brief history page with collapsible entries and delete
- Feedback collection (thumbs up/down per item)
- HTTP Basic Auth
- 6:50am PT daily cron via node-cron with Gmail send
- Cron failure alert email
- Fly.io deployment
