#!/usr/bin/env python3
"""
Probe notification list URLs for each scrape-enabled portal.
Prints status code, latency, SSL ok/fail, and a rough item preview count.
"""

import json
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "portals.json"
sys.path.insert(0, str(Path(__file__).resolve().parent))

from scrapers.base import HEADERS, portal_fetch_opts, portal_list_urls  # noqa: E402


def probe_url(url, *, verify=True, timeout=15):
    start = time.perf_counter()
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True, verify=verify)
        ms = round((time.perf_counter() - start) * 1000)
        return {
            "ok": r.status_code < 400,
            "status": r.status_code,
            "ms": ms,
            "ssl": "ok" if verify else "verify_off",
            "bytes": len(r.content),
            "error": None,
        }
    except requests.exceptions.SSLError as e:
        ms = round((time.perf_counter() - start) * 1000)
        return {"ok": False, "status": 0, "ms": ms, "ssl": "fail", "bytes": 0, "error": str(e)[:120]}
    except requests.RequestException as e:
        ms = round((time.perf_counter() - start) * 1000)
        return {"ok": False, "status": 0, "ms": ms, "ssl": "?", "bytes": 0, "error": str(e)[:120]}


def preview_scrape(portal):
    cfg = portal.get("notifications") or {}
    if cfg.get("strategy") != "module":
        return None
    try:
        mod = __import__(f"scrapers.{cfg.get('module', portal['id'])}", fromlist=["scrape"])
        items = mod.scrape(portal)
        return len(items)
    except Exception as e:
        return f"err: {e}"


def main():
    portals = json.loads(CONFIG_PATH.read_text())
    print(f"{'portal':16s} {'url':55s} {'code':>4} {'ms':>6} {'ssl':>10} items")
    print("-" * 110)

    for portal in portals:
        cfg = portal.get("notifications") or {}
        if cfg.get("strategy", "manual_only") == "manual_only":
            continue
        opts = portal_fetch_opts(portal)
        urls = portal_list_urls(portal)
        for url in urls:
            result = probe_url(url, verify=opts["verify"], timeout=opts.get("timeout", 15))
            short = url if len(url) <= 55 else url[:52] + "..."
            err = f"  {result['error']}" if result["error"] else ""
            print(
                f"{portal['id']:16s} {short:55s} {result['status']:4d} "
                f"{result['ms']:6d} {result['ssl']:>10}{err}"
            )
        count = preview_scrape(portal)
        print(f"{'':16s} {'→ scrape preview':55s} {'':4} {'':6} {'':>10} {count}")
        print()


if __name__ == "__main__":
    main()
