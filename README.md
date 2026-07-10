# Ping — Portal Pulse

[![Live](https://img.shields.io/badge/live-GitHub%20Pages-2D3A5C?style=flat-square)](https://nkovaturient.github.io/Ping/) [![Checks](https://img.shields.io/badge/checks-~15%20min-15803D?style=flat-square)](https://github.com/nkovaturient/Ping/actions) [![License](https://img.shields.io/badge/public%20good-free-DB9A34?style=flat-square)](#)

Live uptime & peak-hour patterns for India’s exam and recruitment portals (UPSC, SSC, NTA, IBPS, RRB, state PSCs).

**[Open dashboard →](https://nkovaturient.github.io/Ping/)** · **[Telegram alerts](http://t.me/portal_pulse_bot)**

---

## What it does

| | |
|---|---|
| **Live status** | Homepage checks every ~15 minutes |
| **When to apply** | Best / worst hours from history (IST) |
| **Heatmap** | Peak-hour slowdowns by portal |
| **Alerts** | Optional Telegram bot for deadlines & slow hours |

No server, no database — GitHub Actions writes CSV + JSON; the static dashboard reads them from the repo.

---

## Stack

- `index.html` — dashboard (GitHub Pages)
- `.github/workflows/uptime-check.yml` — scheduled checks
- `config/portals.json` — portal list
- `data/latest.json` · `data/uptime-YYYY-MM.csv` · `data/months.json` — live + history index
- `scripts/check_uptime.py` — check runner

---

## Notes

- Checks **public homepages only** (read-only; no login / form endpoints)
- Actions schedules can run a few minutes late
- Independent, unofficial — not affiliated with any exam body
