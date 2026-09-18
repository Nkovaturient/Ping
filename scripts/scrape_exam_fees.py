#!/usr/bin/env python3
"""
Scrape current application fees from official portal notifications.
Updates data/exam-fees.json — merges scraped current fees with curated history.
"""

import importlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "portals.json"
FEES_FILE = ROOT / "data" / "exam-fees.json"
NOTIF_FILE = ROOT / "data" / "notifications.json"

EXAM_PORTAL_MAP = {
    "upsc": ["upsc_cse", "upsc_nda"],
    "ssc": ["ssc_cgl", "ssc_chsl", "ssc_gd", "ssc_mts"],
    "ibps": ["ibps_po", "ibps_clerk", "ibps_so"],
    "sbi": ["sbi_po"],
    "rbi": ["rbi_grade_b"],
    "nta": ["nta_neet", "nta_jee_main", "nta_cuet"],
    "rrb_apply": ["rrb_ntpc", "rrb_group_d"],
    "uppsc": ["uppsc_pcs"],
    "bpsc": ["bpsc"],
    "mppsc": ["mppsc"],
    "mpsc": ["mpsc"],
    "tnpsc": ["tnpsc_group1"],
    "indiapost_gds": ["indiapost_gds"],
}


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text())
    return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def scrape_portal_fees(portal):
    from scrapers.exam_fees_parser import parse_fees_from_text

    cfg = portal.get("notifications") or {}
    strategy = cfg.get("strategy", "manual_only")
    if strategy != "module":
        return []

    module_name = cfg.get("module", portal["id"])
    mod = importlib.import_module(f"scrapers.{module_name}")
    try:
        items = mod.scrape(portal)
    except Exception as e:
        print(f"[warn] {portal['id']}: scrape failed — {e}")
        return []

    results = []
    for item in items[:8]:
        blob = " ".join(
            filter(None, [item.get("title", ""), item.get("url", ""), item.get("source", "")])
        )
        fees = parse_fees_from_text(blob)
        if not fees:
            continue
        results.append({
            "portal": portal["id"],
            "title": item.get("title", "")[:200],
            "url": item.get("url") or item.get("source"),
            "fees": fees,
            "year": datetime.now().year,
        })
    return results


def apply_scraped_fees(fee_data, scraped_by_portal):
    exams_by_id = {e["id"]: e for e in fee_data.get("exams", [])}
    updated = 0

    for portal_id, items in scraped_by_portal.items():
        exam_ids = EXAM_PORTAL_MAP.get(portal_id, [])
        if not items or not exam_ids:
            continue
        best = items[0]
        for eid in exam_ids:
            exam = exams_by_id.get(eid)
            if not exam:
                continue
            prev = exam.get("current", {}).get("fees", {})
            new_fees = best["fees"]
            if prev == new_fees:
                continue
            exam["current"] = {
                "year": best["year"],
                "fees": new_fees,
                "source": best["url"],
                "verifiedOn": datetime.now(timezone.utc).date().isoformat(),
                "autoScraped": True,
            }
            updated += 1
            print(f"[ok] Updated {eid} from {portal_id} notification scrape")

    fee_data["meta"]["lastUpdated"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return updated


def enrich_from_notifications(fee_data):
    """Cross-check notifications.json titles for fee keywords."""
    from scrapers.exam_fees_parser import parse_fees_from_text

    notifs = load_json(NOTIF_FILE, [])
    if not notifs:
        return 0

    exams_by_id = {e["id"]: e for e in fee_data.get("exams", [])}
    updated = 0
    for n in notifs[:40]:
        fees = parse_fees_from_text(n.get("title", ""))
        if not fees:
            continue
        portal = n.get("portal")
        for eid in EXAM_PORTAL_MAP.get(portal, []):
            exam = exams_by_id.get(eid)
            if not exam:
                continue
            exam["current"]["fees"] = {**exam.get("current", {}).get("fees", {}), **fees}
            exam["current"]["verifiedOn"] = datetime.now(timezone.utc).date().isoformat()
            updated += 1
    return updated


def main():
    sys.path.insert(0, str(ROOT / "scripts"))
    portals = load_json(CONFIG_PATH, [])
    fee_data = load_json(FEES_FILE, {"meta": {}, "exams": []})

    scraped_by_portal = {}
    for portal in portals:
        pid = portal["id"]
        if pid not in EXAM_PORTAL_MAP:
            continue
        items = scrape_portal_fees(portal)
        if items:
            scraped_by_portal[pid] = items
            print(f"[info] {pid}: parsed fees from {len(items)} notification(s)")

    n = apply_scraped_fees(fee_data, scraped_by_portal)
    enrich_from_notifications(fee_data)
    save_json(FEES_FILE, fee_data)
    print(f"[done] Updated {n} exam fee record(s) → {FEES_FILE}")


if __name__ == "__main__":
    main()
