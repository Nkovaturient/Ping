"""IBPS exam notification scraper."""

from bs4 import BeautifulSoup

from .base import extract_links, fetch_html, normalize_item, parse_deadline_from_text


def scrape(portal):
    portal_id = portal["id"]
    cfg = portal.get("notifications", {})
    list_url = cfg.get("listUrl", "https://www.ibps.in/index.php/exam-notification/")

    html, final_url = fetch_html(list_url)
    soup = BeautifulSoup(html, "html.parser")

    items = []
    for a in soup.select("a[href*='exam'], a[href*='notification'], a[href*='crp'], article a, .entry-title a"):
        title = a.get_text(" ", strip=True)
        href = a.get("href", "")
        if len(title) < 12:
            continue
        url = href if href.startswith("http") else "https://www.ibps.in" + (href if href.startswith("/") else "/" + href)
        deadline = parse_deadline_from_text(title)
        item = normalize_item(portal_id, title, url, final_url, deadline=deadline)
        if item and not any(x["id"] == item["id"] for x in items):
            items.append(item)
        if len(items) >= 20:
            break

    if not items:
        for title, url in extract_links(soup, final_url, min_title_len=15, limit=15):
            if "notification" in url.lower() or "exam" in title.lower() or "crp" in title.lower():
                deadline = parse_deadline_from_text(title)
                item = normalize_item(portal_id, title, url, final_url, deadline=deadline)
                if item:
                    items.append(item)

    return items
