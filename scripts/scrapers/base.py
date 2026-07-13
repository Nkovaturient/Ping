"""Shared helpers for portal notification scrapers."""

import hashlib
import re
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

TIMEOUT = 10
USER_AGENT = (
    "IndiaExamPortalUptimeMonitor/1.0 "
    "(public-good notification tracker; read-only; "
    "contact via the GitHub repo running this)"
)
HEADERS = {"User-Agent": USER_AGENT}

# Common Indian govt date patterns in notification text
DATE_PATTERNS = [
    re.compile(
        r"(?:last\s*date|closing\s*date|upto|up\s*to|till)\s*[:\-]?\s*"
        r"(\d{1,2}[\./\-]\d{1,2}[\./\-]\d{2,4})",
        re.I,
    ),
    re.compile(r"(\d{1,2}[\./\-]\d{1,2}[\./\-]\d{4})\s*(?:\(|$|\s)", re.I),
]


def fetch_html(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        r.raise_for_status()
        return r.text, r.url
    except requests.RequestException as e:
        raise RuntimeError(str(e)) from e


def make_item_id(portal_id, title, url):
    raw = f"{portal_id}|{title.strip().lower()}|{url.strip().lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def normalize_item(portal_id, title, url, source, posted_at=None, deadline=None):
    title = " ".join(title.split())
    if not title or len(title) < 5:
        return None
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return {
        "id": make_item_id(portal_id, title, url),
        "portal": portal_id,
        "title": title[:500],
        "url": url,
        "postedAt": posted_at,
        "deadline": deadline,
        "source": source,
        "scrapedAt": now,
    }


def parse_deadline_from_text(text):
    if not text:
        return None
    for pat in DATE_PATTERNS:
        m = pat.search(text)
        if not m:
            continue
        raw = m.group(1).replace("/", ".").replace("-", ".")
        parts = raw.split(".")
        if len(parts) != 3:
            continue
        d, mo, y = parts
        if len(y) == 2:
            y = "20" + y
        try:
            dt = datetime(int(y), int(mo), int(d), 23, 59, 0, tzinfo=timezone.utc)
            return dt.isoformat().replace("+00:00", "Z")
        except ValueError:
            continue
    return None


def extract_links(soup, base_url, min_title_len=10, limit=20):
    seen = set()
    items = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.startswith("#") or href.lower().startswith("javascript:"):
            continue
        title = a.get_text(" ", strip=True)
        if len(title) < min_title_len:
            continue
        url = urljoin(base_url, href)
        if url in seen:
            continue
        seen.add(url)
        items.append((title, url))
        if len(items) >= limit:
            break
    return items


def is_same_domain(url, base_url):
    return urlparse(url).netloc == urlparse(base_url).netloc
