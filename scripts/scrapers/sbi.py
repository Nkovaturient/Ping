"""SBI careers — APPLY ONLINE / PDF notice links only."""

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


def _keep_sbi(title, url):
    t = (title or "").lower().strip()
    u = (url or "").lower()
    # Drop bare language/size PDF labels (duplicates of DOWNLOAD ADVERTISEMENT)
    if t.startswith("english") or t.startswith("hindi") or t in ("apply now",):
        return False
    if is_pdf_notice(u) and "sbi.bank.in/documents" in u:
        if any(k in t for k in ("advertisement", "corrigendum", "biodata", "detailed", "adv")):
            return True
        if "download" in t:
            return True
        return False
    if "ibpsreg.ibps.in" in u or "recruitment.sbi.bank.in" in u:
        return "apply" in t
    return False


def scrape(portal):
    portal_id = portal["id"]
    opts = portal_fetch_opts(portal)
    urls = portal_list_urls(portal) or [
        "https://sbi.bank.in/web/careers/current-openings"
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
        if not _keep_sbi(title, url):
            continue
        # Prefer a more descriptive title from the parent row when link text is generic
        display = title
        if display.lower() in ("apply online", "english", "hindi") or len(display) < 12:
            parent = a.find_parent(["tr", "li", "div"])
            if parent:
                richer = " ".join(parent.get_text(" ", strip=True).split())[:200]
                if len(richer) > len(display) + 5:
                    display = richer
        if display.lower() in ("apply online",) and not is_pdf_notice(url):
            display = f"SBI Apply — {url.split('/')[-2] if '/' in url else 'opening'}"

        parent = a.find_parent(["tr", "li", "div"])
        ctx = parent.get_text(" ", strip=True) if parent else display
        deadline = parse_deadline_from_text(ctx) or parse_deadline_from_text(display)
        item = normalize_item(portal_id, display, url, final_url, deadline=deadline)
        if item and not any(x["id"] == item["id"] for x in items):
            # Prefer unique destination URLs (drop duplicate Apply Now / APPLY ONLINE)
            if any(x["url"].split("?")[0] == item["url"].split("?")[0] for x in items):
                # Keep PDF variants; skip duplicate apply links
                if not is_pdf_notice(url):
                    continue
            items.append(item)
        if len(items) >= 15:
            break

    return items
