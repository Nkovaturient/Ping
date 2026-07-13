#!/usr/bin/env python3
"""
Scrape career/vacancy notifications from configured exam portals.
Runs on GitHub Actions — commits data/notifications.json and may merge
auto-detected deadlines into deadlines.json.
"""

import importlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "portals.json"
NOTIF_FILE = ROOT / "data" / "notifications.json"
STATE_FILE = ROOT / "data" / "notifications_state.json"
DEADLINES_FILE = ROOT / "deadlines.json"
MAX_PER_PORTAL = 25
CONFIRM_RUNS = 2  # require item in 2 consecutive scrapes before treating as confirmed new


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text())
    return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def scrape_portal(portal):
    cfg = portal.get("notifications") or {}
    strategy = cfg.get("strategy", "manual_only")
    if strategy == "manual_only":
        return [], "skipped"
    if strategy == "module":
        module_name = cfg.get("module", portal["id"])
        mod = importlib.import_module(f"scrapers.{module_name}")
        items = mod.scrape(portal)
        return items, "ok"
    return [], "unknown_strategy"


def merge_notifications(existing, new_items):
    by_id = {n["id"]: n for n in existing}
    for item in new_items:
        by_id[item["id"]] = item
    merged = list(by_id.values())
    merged.sort(key=lambda x: x.get("scrapedAt") or "", reverse=True)
    return merged


def trim_per_portal(items):
    by_portal = {}
    for item in items:
        pid = item["portal"]
        by_portal.setdefault(pid, []).append(item)
    out = []
    for pid in sorted(by_portal):
        out.extend(by_portal[pid][:MAX_PER_PORTAL])
    out.sort(key=lambda x: x.get("scrapedAt") or "", reverse=True)
    return out


def update_state(state, portal_id, scraped_ids, status):
    seen = state.setdefault("seenIds", {})
    pending = state.setdefault("pendingIds", {})
    portal_status = state.setdefault("portalStatus", {})
    newly_confirmed = []

    portal_status[portal_id] = {
        "status": status,
        "lastRun": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(scraped_ids),
    }

    for item_id in scraped_ids:
        if item_id in seen:
            pending.pop(item_id, None)
        else:
            pending[item_id] = pending.get(item_id, 0) + 1
            if pending[item_id] >= CONFIRM_RUNS:
                seen[item_id] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                pending.pop(item_id, None)
                newly_confirmed.append(item_id)

    return state, newly_confirmed


def merge_deadlines(deadlines, notifications, confirmed_ids):
    existing_keys = {(d.get("portal"), d.get("displayName")) for d in deadlines}
    changed = False
    for n in notifications:
        if n["id"] not in confirmed_ids:
            continue
        if not n.get("deadline"):
            continue
        key = (n["portal"], n["title"])
        if key in existing_keys:
            continue
        deadlines.append({
            "portal": n["portal"],
            "displayName": n["title"],
            "url": n["url"],
            "deadline": n["deadline"].replace("Z", "").replace("+00:00", ""),
            "source": n.get("source", n["url"]),
            "verifiedOn": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "autoScraped": True,
        })
        existing_keys.add(key)
        changed = True
    return deadlines, changed


def main():
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    portals = json.loads(CONFIG_PATH.read_text())
    existing_notifs = load_json(NOTIF_FILE, [])
    state = load_json(STATE_FILE, {"seenIds": {}, "pendingIds": {}, "portalStatus": {}})
    deadlines = load_json(DEADLINES_FILE, [])

    all_new_items = []
    all_confirmed = []

    for portal in portals:
        pid = portal["id"]
        try:
            items, status = scrape_portal(portal)
            ids = [i["id"] for i in items]
            state, confirmed = update_state(state, pid, ids, status)
            all_confirmed.extend(confirmed)
            all_new_items.extend(items)
            print(f"{pid:16s} {status:8s} {len(items):3d} items")
        except Exception as e:
            state, _ = update_state(state, pid, [], f"error: {e}")
            print(f"{pid:16s} error    0 items — {e}")

    merged = trim_per_portal(merge_notifications(existing_notifs, all_new_items))
    save_json(NOTIF_FILE, merged)
    save_json(STATE_FILE, state)

    if all_confirmed:
        deadlines, changed = merge_deadlines(deadlines, merged, all_confirmed)
        if changed:
            save_json(DEADLINES_FILE, deadlines)
            print(f"deadlines.json updated ({len(all_confirmed)} newly confirmed items checked)")

    print(f"Wrote {len(merged)} notifications total")


if __name__ == "__main__":
    main()
