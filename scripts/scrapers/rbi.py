"""RBI homepage recruitment announcements (skip CAPTCHA opportunities portal)."""

from bs4 import BeautifulSoup

from .base import (
    UnreachableError,
    absolute_url,
    fetch_first_ok,
    is_pdf_notice,
    is_same_domain,
    normalize_item,
    parse_deadline_from_text,
    portal_fetch_opts,
    portal_list_urls,
)

RBI_HINTS = (
    "recruit",
    "vacancy",
    "vacancies",
    "officer",
    "grade",
    "advertisement",
    "notification",
    "opportunity",
)


def scrape(portal):
    portal_id = portal["id"]
    opts = portal_fetch_opts(portal)
    urls = portal_list_urls(portal) or ["https://www.rbi.org.in/"]

    try:
        html, final_url = fetch_first_ok(urls, **opts)
    except RuntimeError as e:
        raise UnreachableError(str(e)) from e

    soup = BeautifulSoup(html, "html.parser")
    items = []

    for a in soup.find_all("a", href=True):
        title = a.get_text(" ", strip=True)
        url = absolute_url(a["href"], final_url)
        if "opportunities.rbi.org.in" in url.lower():
            continue
        if not is_same_domain(url, final_url) and not is_pdf_notice(url):
            continue
        if len(title) < 10:
            continue
        lower = title.lower()
        if not any(h in lower for h in RBI_HINTS) and not is_pdf_notice(url):
            continue
        parent = a.find_parent(["tr", "li", "div"])
        ctx = parent.get_text(" ", strip=True) if parent else title
        deadline = parse_deadline_from_text(ctx) or parse_deadline_from_text(title)
        item = normalize_item(portal_id, title, url, final_url, deadline=deadline)
        if item and not any(x["id"] == item["id"] for x in items):
            items.append(item)
        if len(items) >= 20:
            break

    return items
