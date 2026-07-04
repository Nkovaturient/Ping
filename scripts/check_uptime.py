#!/usr/bin/env python3
"""
Pings every portal in config/portals.json, records status + latency,
appends to a monthly CSV under data/, and writes a small data/latest.json
snapshot the dashboard reads for the "live status" grid.

Runs under GitHub Actions on a schedule. Deliberately polite:
- identifies itself via User-Agent
- only hits the public homepage (no login, no form endpoints)
- one request per portal per run, short timeout, no retries hammering the server
"""
import csv
import json
import os
import time
import datetime
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config", "portals.json")
DATA_DIR = os.path.join(ROOT, "data")
TIMEOUT = 10
USER_AGENT = (
    "IndiaExamPortalUptimeMonitor/1.0 "
    "(public-good uptime tracker; read-only homepage checks; "
    "contact via the GitHub repo running this)"
)


def load_portals():
    with open(CONFIG_PATH) as f:
        return json.load(f)


def check(url):
    headers = {"User-Agent": USER_AGENT}
    start = time.perf_counter()
    try:
        r = requests.head(url, headers=headers, timeout=TIMEOUT, allow_redirects=True)
        # Some government servers don't implement HEAD properly (405/501) -
        # fall back to a streamed GET so we don't falsely mark them "down".
        if r.status_code in (405, 501) or r.status_code >= 500:
            r = requests.get(url, headers=headers, timeout=TIMEOUT, allow_redirects=True, stream=True)
            r.close()
        latency_ms = round((time.perf_counter() - start) * 1000)
        return r.status_code, latency_ms, r.status_code < 400
    except requests.exceptions.RequestException:
        latency_ms = round((time.perf_counter() - start) * 1000)
        return 0, latency_ms, False


def main():
    portals = load_portals()
    now = datetime.datetime.utcnow()
    os.makedirs(DATA_DIR, exist_ok=True)
    month_file = os.path.join(DATA_DIR, f"uptime-{now:%Y-%m}.csv")
    is_new_file = not os.path.exists(month_file)

    rows = []
    for p in portals:
        status, latency, up = check(p["url"])
        ts = now.replace(microsecond=0).isoformat() + "Z"
        rows.append([ts, p["id"], status, latency, int(up)])
        print(f"{p['id']:14s} status={status:<4} latency={latency:>6}ms up={up}")

    with open(month_file, "a", newline="") as f:
        w = csv.writer(f)
        if is_new_file:
            w.writerow(["timestamp_utc", "portal_id", "status_code", "latency_ms", "up"])
        w.writerows(rows)

    latest = {
        r[1]: {"timestamp_utc": r[0], "status_code": r[2], "latency_ms": r[3], "up": bool(r[4])}
        for r in rows
    }
    with open(os.path.join(DATA_DIR, "latest.json"), "w") as f:
        json.dump(latest, f, indent=2)


if __name__ == "__main__":
    main()
