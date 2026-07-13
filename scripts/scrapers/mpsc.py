"""MPSC advertisement scraper.

mpsc.gov.in is a React SPA; content APIs require a signed Authorization/CRC
token. We try HTML first, then the public API, and raise UnreachableError if
both yield nothing useful so consecutive-failure auto-skip can engage.
"""

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


def scrape(portal):
    portal_id = portal["id"]
    opts = portal_fetch_opts(portal)
    urls = portal_list_urls(portal) or ["https://mpsc.gov.in/adv_notification/8"]

    try:
        html, final_url = fetch_first_ok(urls, **opts)
    except RuntimeError as e:
        raise UnreachableError(str(e)) from e

    soup = BeautifulSoup(html, "html.parser")
    items = []

    for a in soup.find_all("a", href=True):
        title = a.get_text(" ", strip=True)
        url = absolute_url(a["href"], final_url)
        if len(title) < 10 and not is_pdf_notice(url):
            continue
        lower = (title + " " + url).lower()
        if not any(k in lower for k in ("adv", "recruit", "notification", "exam", ".pdf", "advertisement")):
            continue
        parent = a.find_parent(["tr", "li", "div"])
        ctx = parent.get_text(" ", strip=True) if parent else title
        deadline = parse_deadline_from_text(ctx) or parse_deadline_from_text(title)
        item = normalize_item(portal_id, title or "MPSC Advertisement", url, final_url, deadline=deadline)
        if item and not any(x["id"] == item["id"] for x in items):
            items.append(item)
        if len(items) >= 25:
            return items

    # SPA shell with no links — API is CRC-gated
    if not items and ("create-react-app" in html or "static/js" in html):
        raise UnreachableError(
            "MPSC SPA shell only; /web/api/v1/* requires CRC Authorization token"
        )

    return items
