"""NTA homepage + notice board archive scraper."""

from bs4 import BeautifulSoup

from .base import (
    UnreachableError,
    absolute_url,
    fetch_first_ok,
    is_pdf_notice,
    normalize_item,
    parse_deadline_from_text,
    portal_fetch_opts,
    portal_list_urls,
)

NTA_KEYWORDS = (
    "neet", "jee", "cuet", "ugc", "net", "admission", "result",
    "public notice", "admit card", "application", "exam", "examination",
    "registration", "score", "answer key",
)


def _looks_nta(title, url):
    t = (title or "").lower()
    u = (url or "").lower()
    if is_pdf_notice(u):
        return True
    return any(k in t for k in NTA_KEYWORDS)


def scrape(portal):
    portal_id = portal["id"]
    opts = portal_fetch_opts(portal)
    urls = portal_list_urls(portal) or [
        "https://nta.ac.in/",
        "https://www.nta.ac.in/",
        "https://nta.ac.in/NoticeBoardArchive",
    ]

    try:
        html, final_url = fetch_first_ok(urls, **opts)
    except RuntimeError as e:
        raise UnreachableError(str(e)) from e

    soup = BeautifulSoup(html, "html.parser")
    items = []

    for a in soup.find_all("a", href=True):
        title = a.get_text(" ", strip=True)
        url = absolute_url(a["href"], final_url)
        if len(title) < 12:
            continue
        if not _looks_nta(title, url):
            continue
        if url.rstrip("/").endswith("nta.ac.in"):
            continue
        parent = a.find_parent(["tr", "li", "div", "article"])
        ctx = parent.get_text(" ", strip=True) if parent else title
        deadline = parse_deadline_from_text(ctx) or parse_deadline_from_text(title)
        item = normalize_item(portal_id, title, url, final_url, deadline=deadline)
        if item and not any(x["id"] == item["id"] for x in items):
            items.append(item)
        if len(items) >= 25:
            break

    return items
