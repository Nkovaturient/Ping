"""UPSC active / forthcoming / recruitment advertisement scraper."""

import re

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
    urls = portal_list_urls(portal) or [
        "https://www.upsc.gov.in/examinations/active-exams",
        "https://www.upsc.gov.in/examinations/forthcoming-exams",
        "https://www.upsc.gov.in/recruitment/recruitment-advertisement",
    ]

    try:
        html, final_url = fetch_first_ok(urls, **opts)
    except RuntimeError as e:
        raise UnreachableError(str(e)) from e

    soup = BeautifulSoup(html, "html.parser")
    items = []

    for row in soup.select("table tr, .view-content .views-row, li, article"):
        links = row.find_all("a", href=True)
        for a in links:
            title = a.get_text(" ", strip=True)
            href = a["href"]
            if len(title) < 10:
                continue
            url = absolute_url(href, final_url)
            # Skip UPSC nav chrome (section labels without exam year)
            if not re.search(r"20\d{2}", title) and not is_pdf_notice(url):
                continue
            ctx = row.get_text(" ", strip=True)
            deadline = parse_deadline_from_text(ctx) or parse_deadline_from_text(title)
            item = normalize_item(portal_id, title, url, final_url, deadline=deadline)
            if item and not any(x["id"] == item["id"] for x in items):
                items.append(item)
            if len(items) >= 25:
                return items

    if not items:
        for a in soup.find_all("a", href=True):
            title = a.get_text(" ", strip=True)
            url = absolute_url(a["href"], final_url)
            if len(title) < 12 and not is_pdf_notice(url):
                continue
            if not re.search(r"20\d{2}", title) and not is_pdf_notice(url):
                continue
            deadline = parse_deadline_from_text(title)
            item = normalize_item(portal_id, title, url, final_url, deadline=deadline)
            if item and not any(x["id"] == item["id"] for x in items):
                items.append(item)
            if len(items) >= 25:
                break

    return items
