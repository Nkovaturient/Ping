"""SSC notice scraper via official JSON API (SPA has no server-rendered PDFs)."""

from .base import (
    UnreachableError,
    fetch_html,
    normalize_item,
    parse_deadline_from_text,
    portal_fetch_opts,
    portal_list_urls,
)

API_URL = "https://ssc.gov.in/api/general-website/portal/records"
CONTENT_TYPES = ("ssc-calendar", "browse-exam", "ribbons")
ATTRS = "id,headline,examId,contentType,startDate,endDate,language,createdAt"


def _fetch_records(content_type, opts):
    import requests
    from .base import HEADERS

    params = {
        "page": 1,
        "limit": 25,
        "contentType": content_type,
        "key": "createdAt",
        "order": "DESC",
        "isPaginationRequired": "false",
        "isAttachment": "true",
        "language": "english",
        "attributes": ATTRS,
    }
    try:
        r = requests.get(
            API_URL,
            headers={**HEADERS, "Accept": "application/json"},
            params=params,
            timeout=opts.get("timeout", 15),
            verify=opts.get("verify", True),
        )
        r.raise_for_status()
        payload = r.json()
        if str(payload.get("statusCode")) != "200":
            return []
        return payload.get("data") or []
    except Exception as e:
        raise RuntimeError(str(e)) from e


def scrape(portal):
    portal_id = portal["id"]
    opts = portal_fetch_opts(portal)
    items = []
    errors = []

    for ct in CONTENT_TYPES:
        try:
            rows = _fetch_records(ct, opts)
        except RuntimeError as e:
            errors.append(str(e))
            continue
        for row in rows:
            title = (row.get("headline") or "").strip()
            if not title:
                continue
            exam_id = row.get("examId") or ""
            rid = row.get("id") or ""
            url = (
                f"https://ssc.gov.in/home/notice-board#{rid}"
                if rid
                else "https://ssc.gov.in/home/notice-board"
            )
            # Prefer application endDate as deadline when present
            end = row.get("endDate")
            deadline = None
            if end:
                deadline = f"{end}T23:59:00Z" if "T" not in end else end
            else:
                deadline = parse_deadline_from_text(title)
            # Ensure recruitment keyword so is_actionable_notice passes
            if "exam" not in title.lower() and "notice" not in title.lower():
                title = f"{title} (SSC {ct})"
            item = normalize_item(portal_id, title, url, API_URL, deadline=deadline)
            if item and not any(x["id"] == item["id"] for x in items):
                items.append(item)
            if len(items) >= 25:
                return items

    if not items and errors:
        # Fall back to HTML list URLs (usually SPA shell)
        urls = portal_list_urls(portal)
        if urls:
            try:
                fetch_html(urls[0], **opts)
            except RuntimeError as e:
                raise UnreachableError(str(e)) from e
        raise UnreachableError("; ".join(errors[:2]))

    return items
