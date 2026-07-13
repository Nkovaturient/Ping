"""Shared helpers for portal notification scrapers."""

import hashlib
import re
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from urllib3.exceptions import InsecureRequestWarning

requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

TIMEOUT = 10
USER_AGENT = (
    "IndiaExamPortalUptimeMonitor/1.0 "
    "(public-good notification tracker; read-only; "
    "contact via the GitHub repo running this)"
)
HEADERS = {"User-Agent": USER_AGENT}

DATE_PATTERNS = [
    re.compile(
        r"(?:last\s*date|closing\s*date|upto|up\s*to|till)\s*[:\-]?\s*"
        r"(\d{1,2}[\./\-]\d{1,2}[\./\-]\d{2,4})",
        re.I,
    ),
    re.compile(r"(\d{1,2}[\./\-]\d{1,2}[\./\-]\d{4})\s*(?:\(|$|\s)", re.I),
]

NAV_JUNK_PHRASES = (
    "contact us",
    "our legacy",
    "our leaders",
    "learning",
    "development",
    "benefits",
    "growth oriented",
    "world of opportunities",
    "what are we looking",
    "employee onboarding",
    "life at the",
    "the sbi story",
    "recruitment results",
    "current openings",
    "post your query",
    "privacy policy",
    "terms of use",
    "sitemap",
    "faq",
    "about us",
    "home",
)

APPLY_HOST_HINTS = (
    "ibpsreg",
    "recruitment.",
    "mpsconline",
    "apply",
    "crpd-",
)

RECRUITMENT_TITLE_HINTS = (
    "recruit",
    "notification",
    "advertisement",
    "vacancy",
    "vacancies",
    "examination",
    "exam",
    "crp",
    "cgl",
    "chsl",
    "neet",
    "jee",
    "cuet",
    "ugc",
    "net",
    "admit card",
    "result",
    "officer",
    "probationary",
    "apply online",
    "public notice",
    "advt",
    "advertisement",
)


def portal_fetch_opts(portal):
    cfg = portal.get("notifications") or {}
    return {
        "verify": cfg.get("sslVerify", True),
        "timeout": cfg.get("timeout", TIMEOUT),
    }


def portal_list_urls(portal):
    cfg = portal.get("notifications") or {}
    urls = cfg.get("listUrls")
    if urls:
        return list(urls)
    single = cfg.get("listUrl")
    if single:
        return [single]
    return []


def fetch_html(url, *, verify=True, timeout=TIMEOUT):
    try:
        r = requests.get(
            url,
            headers=HEADERS,
            timeout=timeout,
            allow_redirects=True,
            verify=verify,
        )
        r.raise_for_status()
        return r.text, r.url
    except requests.RequestException as e:
        raise RuntimeError(str(e)) from e


def fetch_first_ok(urls, *, verify=True, timeout=TIMEOUT):
    if not urls:
        raise RuntimeError("no URLs to fetch")
    last_err = None
    for url in urls:
        try:
            return fetch_html(url, verify=verify, timeout=timeout)
        except RuntimeError as e:
            last_err = e
    raise RuntimeError(str(last_err) if last_err else "all URLs failed")


class UnreachableError(RuntimeError):
    """All configured list URLs failed (timeout / connect / SSL)."""


def make_item_id(portal_id, title, url):
    raw = f"{portal_id}|{title.strip().lower()}|{url.strip().lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def normalize_item(portal_id, title, url, source, posted_at=None, deadline=None):
    title = " ".join(title.split())
    if not title or len(title) < 5:
        return None
    if not is_actionable_notice(title, url, portal_id):
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


def is_pdf_notice(url):
    path = urlparse(url).path.lower()
    return path.endswith(".pdf") or ".pdf" in path


def is_apply_link(url):
    lower = url.lower()
    return any(h in lower for h in APPLY_HOST_HINTS)


def is_nav_junk(title, url=""):
    t = (title or "").strip().lower()
    u = (url or "").lower()
    if not t:
        return True
    if any(p in t for p in NAV_JUNK_PHRASES):
        return True
    if t in ("english", "hindi", "english (443 kb)", "hindi / (370 kb)"):
        # bare language labels without recruitment context — keep PDFs via other filters
        if not is_pdf_notice(u):
            return True
    return False


def is_actionable_notice(title, url, portal_id=None):
    if is_nav_junk(title, url):
        return False
    t = (title or "").lower()
    u = (url or "").lower()
    if is_pdf_notice(u):
        return True
    if is_apply_link(u):
        return True
    if any(h in t for h in RECRUITMENT_TITLE_HINTS):
        return True
    if portal_id == "sbi":
        return False
    return False


def absolute_url(href, base_url):
    if not href:
        return base_url
    if href.startswith("http"):
        return href
    return urljoin(base_url, href)
