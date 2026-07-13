"""SBI careers current openings scraper."""

from bs4 import BeautifulSoup

from .base import extract_links, fetch_html, normalize_item, parse_deadline_from_text


def scrape(portal):
    portal_id = portal["id"]
    cfg = portal.get("notifications", {})
    list_url = cfg.get("listUrl", "https://sbi.bank.in/web/careers/current-openings")

    html, final_url = fetch_html(list_url)
    soup = BeautifulSoup(html, "html.parser")

    items = []
    for a in soup.select("a[href*='career'], a[href*='recruit'], a[href*='opening'], table a, .career a, li a"):
        title = a.get_text(" ", strip=True)
        href = a.get("href", "")
        if len(title) < 10:
            continue
        lower = (title + href).lower()
        if not any(k in lower for k in ("recruit", "officer", "opening", "vacancy", "crpd", "apply", "career")):
            continue
        url = href if href.startswith("http") else "https://sbi.bank.in" + (href if href.startswith("/") else "/" + href)
        parent_text = a.find_parent(["tr", "li", "div"])
        ctx = parent_text.get_text(" ", strip=True) if parent_text else title
        deadline = parse_deadline_from_text(ctx) or parse_deadline_from_text(title)
        item = normalize_item(portal_id, title, url, final_url, deadline=deadline)
        if item and not any(x["id"] == item["id"] for x in items):
            items.append(item)
        if len(items) >= 20:
            break

    if not items:
        for title, url in extract_links(soup, final_url, min_title_len=12, limit=15):
            deadline = parse_deadline_from_text(title)
            item = normalize_item(portal_id, title, url, final_url, deadline=deadline)
            if item:
                items.append(item)

    return items
