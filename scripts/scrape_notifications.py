#!/usr/bin/env python3
"""
Scrape career/vacancy notifications from configured exam portals.
Runs on GitHub Actions — commits data/notifications.json and may merge
auto-detected deadlines into deadlines.json.
"""

import importlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "portals.json"
NOTIF_FILE = ROOT / "data" / "notifications.json"
STATE_FILE = ROOT / "data" / "notifications_state.json"
DEADLINES_FILE = ROOT / "deadlines.json"
MAX_PER_PORTAL = 25
CONFIRM_RUNS = 2
UNREACHABLE_SKIP_AFTER = 2  # consecutive unreachable runs before auto-skipping


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text())
    return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def scrape_portal(portal, state):
    from scrapers.base import UnreachableError, is_actionable_notice

    cfg = portal.get("notifications") or {}
    strategy = cfg.get("strategy", "manual_only")
    pid = portal["id"]

    if strategy == "manual_only":
        return [], "skipped"

    failures = state.get("consecutiveFailures", {}).get(pid, 0)
    if failures >= UNREACHABLE_SKIP_AFTER:
        print(f"[info] {pid}: auto-skip after {failures} consecutive unreachable runs "
              f"(re-enable by clearing consecutiveFailures in notifications_state.json)")
        return [], "skipped_unreachable"

    if strategy == "module":
        module_name = cfg.get("module", pid)
        mod = importlib.import_module(f"scrapers.{module_name}")
        try:
            items = mod.scrape(portal)
            # Defensive re-filter
            items = [
                i for i in items
                if is_actionable_notice(i.get("title", ""), i.get("url", ""), i.get("portal"))
            ]
            return items, "ok"
        except UnreachableError as e:
            return [], f"unreachable: {e}"
        except Exception as e:
            raise RuntimeError(str(e)) from e

    return [], "unknown_strategy"


def merge_notifications(existing, new_items):
    by_id = {n["id"]: n for n in existing}
    for item in new_items:
        by_id[item["id"]] = item
    merged = list(by_id.values())
    merged.sort(key=lambda x: x.get("scrapedAt") or "", reverse=True)
    return merged


def refilter_actionable(items):
    from scrapers.base import is_actionable_notice

    return [
        n for n in items
        if is_actionable_notice(n.get("title", ""), n.get("url", ""), n.get("portal"))
    ]


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
    consecutive = state.setdefault("consecutiveFailures", {})
    newly_confirmed = []

    portal_status[portal_id] = {
        "status": status,
        "lastRun": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(scraped_ids),
    }

    if status.startswith("unreachable"):
        consecutive[portal_id] = consecutive.get(portal_id, 0) + 1
    elif status in ("ok", "degraded"):
        consecutive[portal_id] = 0
    # skipped / skipped_unreachable / error: leave counter as-is for unreachable track

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


def prune_pending_for_removed(state, keep_ids):
    pending = state.setdefault("pendingIds", {})
    seen = state.setdefault("seenIds", {})
    for iid in list(pending.keys()):
        if iid not in keep_ids:
            pending.pop(iid, None)
    for iid in list(seen.keys()):
        if iid not in keep_ids:
            # keep seen history for IDs we intentionally dropped as junk? drop them
            seen.pop(iid, None)
    return state


def merge_deadlines(deadlines, notifications, confirmed_ids):
    existing_keys = {(d.get("portal"), d.get("displayName")) for d in deadlines}
    changed = False
    now = datetime.now(timezone.utc)
    for n in notifications:
        if n["id"] not in confirmed_ids:
            continue
        if not n.get("deadline"):
            continue
        try:
            dl = n["deadline"].replace("Z", "+00:00")
            if datetime.fromisoformat(dl) < now:
                continue  # skip already-closed windows
        except ValueError:
            pass
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
    state = load_json(STATE_FILE, {
        "seenIds": {},
        "pendingIds": {},
        "portalStatus": {},
        "consecutiveFailures": {},
    })
    deadlines = load_json(DEADLINES_FILE, [])

    # Purge previously committed nav-junk (e.g. old SBI scrapes)
    existing_notifs = refilter_actionable(existing_notifs)

    all_new_items = []
    all_confirmed = []

    for portal in portals:
        pid = portal["id"]
        try:
            items, status = scrape_portal(portal, state)
            ids = [i["id"] for i in items]
            state, confirmed = update_state(state, pid, ids, status)
            all_confirmed.extend(confirmed)
            all_new_items.extend(items)
            print(f"{pid:16s} {status[:40]:40s} {len(items):3d} items")
        except Exception as e:
            state, _ = update_state(state, pid, [], f"error: {e}")
            print(f"{pid:16s} {'error':40s}   0 items — {e}")

    merged = trim_per_portal(merge_notifications(existing_notifs, all_new_items))
    merged = refilter_actionable(merged)
    keep_ids = {n["id"] for n in merged}
    state = prune_pending_for_removed(state, keep_ids)

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
