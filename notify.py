"""
Deadline-aware Telegram notifier for Portal Pulse (Ping).

Design goal: zero hosting cost. This script is meant to run as a scheduled
GitHub Action in the SAME repo as Ping, every 2-4 hours. It does two jobs:

  1. Deadline-window alerts (works from day one — no historical data needed):
     if a portal's form-filling window closes within DANGER_WINDOW_DAYS,
     send a reminder.

  2. Peak-hour advisory (only activates once Ping has real history — see
     load_ping_history() below): if the current hour has historically been a
     slow/unstable hour for that portal, add a "avoid filling right now"
     note instead of guessing.

DATA SOURCE
-----------
Ping's real historical data (written by scripts/check_uptime.py) is:
  - data/uptime-YYYY-MM.csv : one row per check, columns
    timestamp_utc, portal_id, status_code, latency_ms, up
  - data/latest.json        : most recent snapshot per portal

load_ping_history() reads those files directly (preferred: this script runs
inside the same repo checkout per notify.yml, so no network round-trip or
CDN cache lag) and falls back to fetching them from raw.githubusercontent.com
when run outside that checkout. Either way it normalizes rows into
{"portal": ..., "timestamp": ..., "status": "up"|"down", "latencyMs": ...}
so everything downstream (peak_hour_advisory) stays unchanged.
"""

import csv
import io
import json
import os
import statistics
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ---------------- CONFIG ----------------
REPO_OWNER = os.environ.get("PING_REPO_OWNER", "nkovaturient")
REPO_NAME = os.environ.get("PING_REPO_NAME", "Ping")
REPO_BRANCH = os.environ.get("PING_REPO_BRANCH", "main")
RAW_BASE = f"https://raw.githubusercontent.com/{REPO_OWNER}/{REPO_NAME}/{REPO_BRANCH}/data"
DATA_DIR = Path(__file__).parent / "data"  # present when running inside the Ping repo checkout

DEADLINES_FILE = Path(__file__).parent / "deadlines.json"
STATE_FILE = Path(__file__).parent / "sent_state.json"  # avoids re-sending the same alert
DANGER_WINDOW_DAYS = 3          # start reminding once this close to a deadline

# check_uptime.py runs every ~15 min (4/hour, ~96/day per portal — see
# .github/workflows/uptime-check.yml). Tune these against that cadence:
#   MIN_SAMPLES_FOR_ADVISORY total samples for a portal before trusting its
#   overall down-rate baseline at all — 300 is roughly 3 days of checks,
#   enough to smooth out a single bad afternoon without waiting weeks.
#   MIN_SAMPLES_PER_HOUR samples for the *specific* current hour bucket
#   before trusting that bucket — 5 is reachable within ~2 days at this
#   cadence (4 checks/hour/day). Raise both if alerts feel noisy/premature,
#   lower them only if you intentionally reduced the check frequency.
MIN_SAMPLES_FOR_ADVISORY = 300
MIN_SAMPLES_PER_HOUR = 5

BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
# -----------------------------------------


def _read_local_or_remote(filename):
    """Local file (repo checkout) first, HTTPS fallback otherwise."""
    local_path = DATA_DIR / filename
    if local_path.exists():
        try:
            return local_path.read_text()
        except Exception as e:
            print(f"[warn] failed reading local {local_path}: {e}")
    try:
        with urllib.request.urlopen(f"{RAW_BASE}/{filename}", timeout=15) as resp:
            return resp.read().decode("utf-8")
    except Exception as e:
        print(f"[warn] could not load {filename}: {e}")
        return None


def _month_key(dt):
    return dt.strftime("%Y-%m")


def _normalize_csv_rows(raw_text):
    rows = []
    for row in csv.DictReader(io.StringIO(raw_text)):
        up = row.get("up") in ("1", "True", "true")
        latency = row.get("latency_ms")
        rows.append({
            "portal": row.get("portal_id"),
            "timestamp": row.get("timestamp_utc"),
            "status": "up" if up else "down",
            "latencyMs": float(latency) if latency else None,
        })
    return rows


def _normalize_latest_json(raw_text):
    latest = json.loads(raw_text)
    rows = []
    for portal_id, rec in latest.items():
        rows.append({
            "portal": portal_id,
            "timestamp": rec.get("timestamp_utc"),
            "status": "up" if rec.get("up") else "down",
            "latencyMs": rec.get("latency_ms"),
        })
    return rows


def load_ping_history():
    """Reads real Ping data (current + previous month CSV) — see DATA SOURCE above."""
    now = datetime.now(timezone.utc)
    months = {_month_key(now), _month_key(now - timedelta(days=31))}

    history = []
    for month in months:
        text = _read_local_or_remote(f"uptime-{month}.csv")
        if text:
            history.extend(_normalize_csv_rows(text))

    if not history:
        # Safety net for a brand-new deployment with no CSV yet.
        text = _read_local_or_remote("latest.json")
        if text:
            history.extend(_normalize_latest_json(text))

    return history


def load_deadlines():
    return json.loads(DEADLINES_FILE.read_text())


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def days_until(date_str):
    target = datetime.fromisoformat(date_str).replace(tzinfo=timezone.utc)
    return (target - datetime.now(timezone.utc)).total_seconds() / 86400


def _ist_hour(ts_iso):
    """Ping's dashboard buckets everything by IST (UTC+5:30) — stay consistent with it."""
    ts = datetime.fromisoformat(ts_iso.replace("Z", "+00:00"))
    utc_minutes = ts.hour * 60 + ts.minute
    return ((utc_minutes + 330) % 1440) // 60


def peak_hour_advisory(history, portal, current_hour):
    """
    Returns a short warning string if the current hour (IST) has historically
    been bad for this portal, or None if there isn't enough data yet / it's fine.
    """
    samples = [h for h in history if h.get("portal") == portal]
    if len(samples) < MIN_SAMPLES_FOR_ADVISORY:
        return None  # not enough history — don't guess

    by_hour = {}
    for s in samples:
        try:
            hour = _ist_hour(s["timestamp"])
        except Exception:
            continue
        by_hour.setdefault(hour, []).append(s)

    this_hour_samples = by_hour.get(current_hour, [])
    if len(this_hour_samples) < MIN_SAMPLES_PER_HOUR:
        return None

    down_rate = sum(1 for s in this_hour_samples if s.get("status") != "up") / len(this_hour_samples)
    latencies = [s["latencyMs"] for s in this_hour_samples if s.get("latencyMs")]
    avg_latency = statistics.mean(latencies) if latencies else None

    overall_down_rate = sum(1 for s in samples if s.get("status") != "up") / len(samples)

    if down_rate > overall_down_rate * 1.5 and down_rate > 0.15:
        return f"this hour has historically been unreliable ({down_rate:.0%} failure rate vs {overall_down_rate:.0%} average)"
    if avg_latency and avg_latency > 3000:
        return f"this hour has historically been slow (avg {avg_latency:.0f}ms response)"
    return None


def send_telegram(text):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    data = json.dumps({
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": "Markdown",
        "disable_web_page_preview": True,
    }).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read()


def main():
    history = load_ping_history()
    deadlines = load_deadlines()
    state = load_state()
    now = datetime.now(timezone.utc)
    current_hour = int(((now.hour * 60 + now.minute + 330) % 1440) // 60)  # IST hour

    for exam in deadlines:
        portal = exam["portal"]
        remaining = days_until(exam["deadline"])
        if remaining < 0 or remaining > DANGER_WINDOW_DAYS:
            continue  # not in the danger window

        state_key = f'{exam["portal"]}:{exam["deadline"]}'
        already_sent_today = state.get(state_key) == now.date().isoformat()
        if already_sent_today:
            continue

        advisory = peak_hour_advisory(history, portal, current_hour)

        lines = [
            f"⏰ *{exam['displayName']}* form window closes in *{remaining:.1f} days*.",
            f"Portal: {exam['url']}",
        ]
        if advisory:
            lines.append(f"⚠️ Heads up: {advisory}. Consider filling at a different time if you can.")
        else:
            lines.append("No historical red flags for this hour — but don't wait for the last day.")

        send_telegram("\n".join(lines))
        state[state_key] = now.date().isoformat()

    save_state(state)


if __name__ == "__main__":
    main()
