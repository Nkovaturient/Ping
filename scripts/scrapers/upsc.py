"""UPSC active exams / what's new scraper."""

from bs4 import BeautifulSoup

from .base import extract_links, fetch_html, normalize_item, parse_deadline_from_text


def scrape(portal):
    portal_id = portal["id"]
    cfg = portal.get("notifications", {})
    list_url = cfg.get("listUrl", "https://upsc.gov.in/examinations/active-exams")

    html, final_url = fetch_html(list_url)
    soup = BeautifulSoup(html, "html.parser")

    items = []
    # Active exams table rows and notice links
    for row in soup.select("table tr, .view-content .views-row, li"):
        links = row.find_all("a", href=True) if row.name != "a" else [row]
        for a in links:
            title = a.get_text(" ", strip=True)
            href = a["href"]
            if len(title) < 10:
                continue
            url = href if href.startswith("http") else "https://upsc.gov.in" + (href if href.startswith("/") else "/" + href)
            ctx = row.get_text(" ", strip=True)
            deadline = parse_deadline_from_text(ctx) or parse_deadline_from_text(title)
            item = normalize_item(portal_id, title, url, final_url, deadline=deadline)
            if item and not any(x["id"] == item["id"] for x in items):
                items.append(item)
            if len(items) >= 20:
                return items

    if not items:
        for title, url in extract_links(soup, final_url, min_title_len=12, limit=20):
            deadline = parse_deadline_from_text(title)
            item = normalize_item(portal_id, title, url, final_url, deadline=deadline)
            if item:
                items.append(item)

    return items
