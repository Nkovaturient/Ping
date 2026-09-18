"""Parse application fee amounts from notification text (HTML/PDF extract)."""

import re

FEE_PATTERNS = [
    re.compile(
        r"(?:fee|application\s+fees?|intimation\s+charges?)\s*(?:of|:)?\s*"
        r"(?:rs\.?|₹)\s*(\d{1,5})",
        re.I,
    ),
    re.compile(r"rs\.?\s*(\d{1,5})\s*/-\s*\(inclusive\s+of\s+gst\)", re.I),
    re.compile(r"pay\s+(?:a\s+)?fee\s+of\s+(?:rs\.?|₹)\s*(\d{1,5})", re.I),
]

GENERAL_OTHERS_PATTERN = re.compile(
    r"rs\.?\s*(\d{1,5})\s*/?\s*-?\s*\(inclusive\s+of\s+gst\)\s+for\s+all\s+others",
    re.I,
)
SC_ST_PATTERN = re.compile(
    r"rs\.?\s*(\d{1,5})\s*/?\s*-?\s*(?:\(inclusive\s+of\s+gst\)\s+)?for\s+sc/st/pwbd",
    re.I,
)
SSC_GENERAL_PATTERN = re.compile(
    r"general\s*/\s*obc\s*/\s*ews\s*:\s*(\d+)\s*/?\s*-?",
    re.I,
)
SSC_ZERO_PATTERN = re.compile(
    r"sc\s*/\s*st\s*/\s*(?:ph|pwd|pwbd)\s*:\s*0",
    re.I,
)
SSC_FEMALE_FREE = re.compile(
    r"(?:all\s+category\s+)?female\s*:\s*0",
    re.I,
)
EXEMPT_SC_ST = re.compile(r"(?:sc\s*/\s*st|sc/st).*?(?:exempt|nil|0)", re.I)
EXEMPT_FEMALE = re.compile(r"female.*?(?:exempt|nil|0)", re.I)
EXEMPT_PWBD = re.compile(r"(?:pwbd|pwd|ph).*?(?:exempt|nil|0)", re.I)


def normalize_text(text):
    if not text:
        return ""
    return re.sub(r"\s+", " ", text.lower())


def parse_fees_from_text(text):
    """Return fee dict or None from raw notification text."""
    t = normalize_text(text)
    if not t:
        return None
    has_fee_hint = (
        "fee" in t
        or "intimation" in t
        or "general / obc" in t
        or "application fees" in t
    )
    if not has_fee_hint:
        return None

    fees = {}
    m_others = GENERAL_OTHERS_PATTERN.search(t)
    m_sc = SC_ST_PATTERN.search(t)
    if m_others:
        general = int(m_others.group(1))
        fees["general"] = general
        fees["obc"] = general
        fees["ews"] = general
        fees["female"] = general
    if m_sc:
        reduced = int(m_sc.group(1))
        fees["sc"] = reduced
        fees["st"] = reduced
        fees["pwd"] = reduced

    m_ssc = SSC_GENERAL_PATTERN.search(t)
    if m_ssc:
        general = int(m_ssc.group(1))
        fees["general"] = general
        fees["obc"] = general
        fees["ews"] = general
        if not SSC_FEMALE_FREE.search(t):
            fees["female"] = general
    if SSC_ZERO_PATTERN.search(t):
        fees["sc"] = 0
        fees["st"] = 0
        fees["pwd"] = 0
    if SSC_FEMALE_FREE.search(t):
        fees["female"] = 0

    if not fees:
        for pat in FEE_PATTERNS:
            m = pat.search(t)
            if m:
                amount = int(m.group(1))
                fees["general"] = amount
                fees["obc"] = amount
                fees["ews"] = amount
                fees["female"] = amount
                break

    if not fees:
        return None

    general = fees.get("general", 100)
    if EXEMPT_SC_ST.search(t) or "sc / st / ph : 0" in t or "sc/st/ph : 0" in t:
        fees["sc"] = 0
        fees["st"] = 0
    if EXEMPT_FEMALE.search(t) or "all category female : 0" in t:
        fees["female"] = 0
    if EXEMPT_PWBD.search(t):
        fees["pwd"] = 0

    for key in ("general", "obc", "sc", "st", "ews", "pwd", "female"):
        fees.setdefault(key, fees.get("general", general))

    if EXEMPT_FEMALE.search(t):
        fees["female"] = 0

    return fees


def merge_fees_into_exam(exam_entry, scraped_fees, source, year):
    """Update exam current fees if scraped values differ."""
    if not scraped_fees:
        return False
    exam_entry["current"] = {
        "year": year,
        "fees": scraped_fees,
        "source": source,
        "verifiedOn": __import__("datetime").date.today().isoformat(),
        "autoScraped": True,
    }
    return True
