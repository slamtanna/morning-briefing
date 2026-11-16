# Org Context — Example

This is a **fictional** example of the org context file the briefing app reads. Copy it to `CLAUDE.md`, replace the contents with your own, and keep the real file out of git (`CLAUDE.md` is already in `.gitignore`).

The app extracts four sections by their exact headings: `## People` (required), `## Terms`, `## Projects`, and `## Preferences`. Anything under other headings is ignored.

---

## People

> Disambiguation: "Sam" means Sam Ortiz (CTO) unless the thread is about legal, in which case it's Sam Lee (outside counsel).

| Name | Handle | Role | Notes |
|------|--------|------|-------|
| Priya Raman | PR | CEO | Your manager; weekly 1:1 Mondays |
| Sam Ortiz | SO | CTO | Owns platform roadmap |
| Marcus Webb | MW | CFO | Owns budget and board financials |
| Jordan Kim | — | Head of Sales | New this quarter |
| Alex Chen | — | Ops Manager | Your direct report |
| Sam Lee | — | Outside counsel | Contracts, IP |

## Terms

| Term | Meaning |
|------|---------|
| BoD | Board of Directors |
| SLT | Senior leadership team |
| QBR | Quarterly business review |
| Atlas | Internal codename for the v2 platform launch |

## Projects

| Project | Status | Notes |
|---------|--------|-------|
| Board meeting prep | 🔴 Hot | Deck due to Priya 3 business days before the meeting |
| Atlas launch | 🟡 In progress | Sam owns eng; you own the cross-functional launch checklist |
| Office move | 🟡 In progress | Alex owns vendors; lease signature pending |
| Hiring plan | 🟢 Up next | Draft headcount plan with Marcus |

## Preferences

- Direct and concise. No filler.
- Lead with what needs action today; context second.
- Flag anything stale for more than a week.
- Address me as "you".
