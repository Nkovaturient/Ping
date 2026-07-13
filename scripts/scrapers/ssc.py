"""SSC notice board scraper."""

import json

from .base import fetch_html, normalize_item, parse_deadline_from_text


def scrape(portal):
    portal_id = portal["id"]
    cfg = portal.get("notifications", {})
    list_url = cfg.get("listUrl", "https://ssc.gov.in")

    # SSC exposes a JSON notice board API on newer site builds
    try:
        text, _ = fetch_html(list_url)
        data = json.loads(text)
        rows = data if isinstance(data, list) else data.get("data", data.get("records", []))
        items = []
        for row in rows[:25]:
            if isinstance(row, dict):
                title = row.get("title") or row.get("noticeTitle") or row.get("name") or ""
                url = row.get("url") or row.get("link") or row.get("attachmentUrl") or list_url
                if url and not url.startswith("http"):
                    url = "https://ssc.gov.in" + (url if url.startswith("/") else "/" + url)
            else:
                continue
            deadline = parse_deadline_from_text(title)
            item = normalize_item(portal_id, title, url, list_url, deadline=deadline)
            if item:
                items.append(item)
        if items:
            return items
    except (json.JSONDecodeError, RuntimeError):
        pass

    # HTML fallback — notice links on homepage / notice section
    from bs4 import BeautifulSoup

    home_url = portal.get("url", "https://ssc.gov.in")
    html, final_url = fetch_html(home_url)
    soup = BeautifulSoup(html, "html.parser")
    items = []
    for a in soup.select("a[href*='notice'], a[href*='Notification'], a[href*='.pdf']"):
        title = a.get_text(" ", strip=True)
        href = a.get("href", "")
        if len(title) < 12:
            continue
        url = href if href.startswith("http") else "https://ssc.gov.in" + (href if href.startswith("/") else "/" + href)
        deadline = parse_deadline_from_text(title)
        item = normalize_item(portal_id, title, url, final_url, deadline=deadline)
        if item and item not in items:
            items.append(item)
        if len(items) >= 20:
            break
    return items
