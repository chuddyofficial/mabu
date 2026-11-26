"""
mabu_report.py — PDF report generation for MABU cases and correlation clusters.

Uses reportlab (pure Python, no external binary dependency) so this works
identically on Windows and the Ubuntu VPS with no extra system packages.

All case content is escaped before it reaches a Paragraph: reportlab parses
paragraph text as markup, so an unescaped "<" or "&" in a finding would
otherwise break report generation (or be interpreted as formatting).
"""

import io
from datetime import datetime, timezone
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, HRFlowable, KeepTogether,
)

# Palette matches the dashboard (navy + gold), tuned for print.
NAVY = colors.HexColor("#0E1A2B")
NAVY_SOFT = colors.HexColor("#1C2C44")
GOLD = colors.HexColor("#B08D3C")
INK = colors.HexColor("#1B2430")
MUTED = colors.HexColor("#5B6778")
RULE = colors.HexColor("#D5DBE3")
ZEBRA = colors.HexColor("#F4F6F9")
AMBER_BG = colors.HexColor("#FBF4E4")

PAGE_W, PAGE_H = LETTER
MARGIN = 0.75 * inch
# SimpleDocTemplate's frame pads 6pt on each side; tables sized to the full
# margin width would overhang the text column by that much.
CONTENT_W = PAGE_W - 2 * MARGIN - 12

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="MabuKicker", fontName="Helvetica-Bold", fontSize=8, leading=10,
                          textColor=GOLD, spaceAfter=4))
styles.add(ParagraphStyle(name="MabuTitle", fontName="Helvetica-Bold", fontSize=20, leading=24,
                          textColor=NAVY, spaceAfter=12))
styles.add(ParagraphStyle(name="MabuSection", fontName="Helvetica-Bold", fontSize=11, leading=14,
                          textColor=NAVY, spaceBefore=18, spaceAfter=4))
styles.add(ParagraphStyle(name="MabuBody", fontName="Helvetica", fontSize=9.5, leading=13.5, textColor=INK))
styles.add(ParagraphStyle(name="MabuLabel", fontName="Helvetica-Bold", fontSize=7.5, leading=10,
                          textColor=MUTED))
styles.add(ParagraphStyle(name="MabuCell", fontName="Helvetica", fontSize=8.5, leading=11, textColor=INK))
styles.add(ParagraphStyle(name="MabuCellMono", fontName="Courier", fontSize=8, leading=11, textColor=INK))
styles.add(ParagraphStyle(name="MabuHead", fontName="Helvetica-Bold", fontSize=7.5, leading=10,
                          textColor=colors.white))
styles.add(ParagraphStyle(name="MabuMeta", fontName="Helvetica", fontSize=8, leading=11, textColor=MUTED))
styles.add(ParagraphStyle(name="MabuNotice", fontName="Helvetica", fontSize=8.5, leading=12, textColor=INK))


def _p(text, style="MabuBody") -> Paragraph:
    """Paragraph from untrusted text: escaped, newlines preserved."""
    safe = escape(str(text if text is not None else "")).replace("\n", "<br/>")
    return Paragraph(safe, styles[style])


def _fmt_date(value) -> str:
    return (value or "")[:19].replace("T", " ") or "–"


def _section(title: str) -> list:
    return [
        Paragraph(escape(title.upper()), styles["MabuSection"]),
        HRFlowable(width="100%", color=GOLD, thickness=0.8, spaceBefore=0, spaceAfter=8),
    ]


def _grid_table(rows: list[list], col_widths: list[float], header: bool = True) -> Table:
    table = Table(rows, colWidths=col_widths, repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, RULE),
        ("BOX", (0, 0), (-1, -1), 0.5, RULE),
    ]
    if header:
        style += [
            ("BACKGROUND", (0, 0), (-1, 0), NAVY),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ZEBRA]),
        ]
    else:
        style += [("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, ZEBRA])]
    table.setStyle(TableStyle(style))
    return table


def _head(*labels: str) -> list:
    return [Paragraph(escape(label.upper()), styles["MabuHead"]) for label in labels]


def _metadata_table(pairs: list[tuple[str, str, str]]) -> Table:
    """Two-column label/value grid. pairs: (label, value, style)."""
    cells = [[Paragraph(escape(label.upper()), styles["MabuLabel"]), _p(value, style)] for label, value, style in pairs]
    half = (len(cells) + 1) // 2
    left, right = cells[:half], cells[half:]
    rows = []
    for i in range(half):
        l_cell = left[i]
        r_cell = right[i] if i < len(right) else ["", ""]
        rows.append(l_cell + r_cell)
    w = CONTENT_W / 2
    table = Table(rows, colWidths=[0.95 * inch, w - 0.95 * inch, 0.95 * inch, w - 0.95 * inch])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, RULE),
    ]))
    return table


def _identifier_table(entries: list[dict]) -> Table:
    agg = {"emails": set(), "phones": set(), "usernames": set(), "names": set(), "ips": set()}
    for e in entries:
        for key in agg:
            agg[key].update(v for v in e.get(key, []) if v)
    rows = [_head("Type", "Values")]
    for label, key in [("Email addresses", "emails"), ("Phone numbers", "phones"), ("Usernames", "usernames"),
                       ("Names / aliases", "names"), ("IP addresses", "ips")]:
        values = sorted(agg[key])
        rows.append([_p(label, "MabuCell"), _p(", ".join(values) if values else "None recorded",
                                                "MabuCellMono" if values else "MabuCell")])
    return _grid_table(rows, [1.4 * inch, CONTENT_W - 1.4 * inch])


def _entry_summary_table(entries: list[dict]) -> Table:
    rows = [_head("#", "Date (UTC)", "Author", "Summary")]
    for i, e in enumerate(entries, start=1):
        rows.append([
            _p(str(i), "MabuCell"),
            _p(_fmt_date(e.get("date")), "MabuCellMono"),
            _p(e.get("author") or "–", "MabuCell"),
            _p(e.get("summary") or "–", "MabuCell"),
        ])
    return _grid_table(rows, [0.35 * inch, 1.55 * inch, 1.2 * inch, CONTENT_W - 3.1 * inch])


def _entry_block(i: int, e: dict) -> KeepTogether:
    rows = [
        [Paragraph("SUMMARY", styles["MabuLabel"]), _p(e.get("summary") or "–")],
        [Paragraph("FINDINGS", styles["MabuLabel"]), _p(e.get("findings") or "–")],
    ]
    sources = e.get("sources") or []
    if sources:
        rows.append([Paragraph("SOURCES", styles["MabuLabel"]), _p("\n".join(sources), "MabuCellMono")])
    attachments = e.get("attachments") or []
    if attachments:
        rows.append([Paragraph("ATTACHMENTS", styles["MabuLabel"]),
                     _p(", ".join(a.get("filename", "") for a in attachments), "MabuCell")])
    body = Table(rows, colWidths=[1.0 * inch, CONTENT_W - 1.0 * inch - 14])
    body.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    heading = Paragraph(
        f"<b>Entry {i}</b> &nbsp;·&nbsp; {escape(_fmt_date(e.get('date')))} UTC &nbsp;·&nbsp; {escape(e.get('author') or 'Unknown author')}",
        styles["MabuCell"],
    )
    frame = Table([[heading], [body]], colWidths=[CONTENT_W])
    frame.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.5, RULE),
        ("BACKGROUND", (0, 0), (-1, 0), ZEBRA),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return KeepTogether([frame, Spacer(1, 8)])


def _activity_table(activity: list[dict]) -> Table:
    rows = [_head("Date (UTC)", "Action", "Detail")]
    for a in activity:
        action = (a.get("action") or "").replace("_", " ")
        rows.append([
            _p(_fmt_date(a.get("date")), "MabuCellMono"),
            _p(action[:1].upper() + action[1:], "MabuCell"),
            _p(a.get("detail") or "", "MabuCell"),
        ])
    return _grid_table(rows, [1.55 * inch, 1.4 * inch, CONTENT_W - 2.95 * inch])


def _case_flowables(case: dict, kicker: str = "CASE REPORT") -> list:
    flow = [
        Paragraph(escape(kicker), styles["MabuKicker"]),
        _p(case.get("title", "Untitled Case"), "MabuTitle"),
        _metadata_table([
            ("Case ID", case.get("case_id", "–"), "MabuCellMono"),
            ("Status", (case.get("status") or "open").capitalize(), "MabuCell"),
            ("Investigator", case.get("investigator") or "–", "MabuCell"),
            ("Created", f"{_fmt_date(case.get('created'))} UTC", "MabuCellMono"),
            ("Updated", f"{_fmt_date(case.get('updated'))} UTC", "MabuCellMono"),
            ("Tags", ", ".join(case.get("tags", [])) or "None", "MabuCell"),
        ]),
    ]

    entries = case.get("entries", [])
    flow += _section("Identifiers")
    flow.append(_identifier_table(entries))

    flow += _section(f"Entries ({len(entries)})")
    if entries:
        flow.append(_entry_summary_table(entries))
        flow.append(Spacer(1, 12))
        for i, e in enumerate(entries, start=1):
            flow.append(_entry_block(i, e))
    else:
        flow.append(_p("No entries recorded.", "MabuMeta"))

    activity = case.get("activity_log", [])
    if activity:
        flow += _section("Activity log")
        flow.append(_activity_table(activity))

    return flow


def _page_chrome(title: str):
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    x0, x1 = MARGIN + 6, PAGE_W - MARGIN - 6  # align with the frame's text column

    def draw(canvas, doc):
        canvas.saveState()
        # Header band
        band_h = 0.42 * inch
        canvas.setFillColor(NAVY)
        canvas.rect(0, PAGE_H - band_h, PAGE_W, band_h, stroke=0, fill=1)
        canvas.setFillColor(GOLD)
        canvas.rect(0, PAGE_H - band_h - 2, PAGE_W, 2, stroke=0, fill=1)
        base = PAGE_H - band_h / 2 - 3
        canvas.setFillColor(colors.white)
        canvas.setFont("Helvetica-Bold", 10)
        canvas.drawString(x0, base, "M A B U")
        canvas.setFillColor(colors.HexColor("#C8A24A"))
        canvas.setFont("Helvetica-Bold", 6.5)
        canvas.drawString(x0 + 52, base + 1, "INTELLIGENCE RESEARCH PLATFORM")
        canvas.setFillColor(colors.HexColor("#C9D3E0"))
        canvas.setFont("Helvetica", 7)
        canvas.drawRightString(x1, base + 1, f"{title.upper()}  ·  CONFIDENTIAL")
        # Footer
        canvas.setStrokeColor(RULE)
        canvas.setLineWidth(0.5)
        canvas.line(x0, 0.62 * inch, x1, 0.62 * inch)
        canvas.setFillColor(MUTED)
        canvas.setFont("Helvetica", 7)
        canvas.drawString(x0, 0.45 * inch, f"Generated {generated} with MABU. Contains case data; handle as confidential.")
        canvas.drawRightString(x1, 0.45 * inch, f"Page {doc.page}")
        canvas.restoreState()

    return draw


def _doc(buf) -> SimpleDocTemplate:
    return SimpleDocTemplate(buf, pagesize=LETTER,
                             topMargin=0.95 * inch, bottomMargin=0.85 * inch,
                             leftMargin=MARGIN, rightMargin=MARGIN,
                             title="MABU report", author="MABU")


def build_case_report_pdf(case: dict) -> bytes:
    buf = io.BytesIO()
    chrome = _page_chrome("Case report")
    _doc(buf).build(_case_flowables(case), onFirstPage=chrome, onLaterPages=chrome)
    return buf.getvalue()


def build_cluster_report_pdf(cases: list[dict]) -> bytes:
    buf = io.BytesIO()

    # Identifiers present in every case of the cluster
    all_ids = [set() for _ in cases]
    for i, c in enumerate(cases):
        for e in c.get("entries", []):
            for key in ("emails", "usernames", "names", "ips", "phones"):
                all_ids[i].update(v.lower() for v in e.get(key, []) if v)
    shared_across_all = set.intersection(*all_ids) if all_ids else set()

    flow = [
        Paragraph("LINK ANALYSIS", styles["MabuKicker"]),
        Paragraph("Correlation cluster report", styles["MabuTitle"]),
        _metadata_table([
            ("Cases", str(len(cases)), "MabuCell"),
            ("Shared IDs", str(len(shared_across_all)), "MabuCell"),
        ]),
    ]

    notice = Table([[_p("Cases in this cluster share one or more identifiers. A shared identifier is a potential "
                        "connection, not confirmation that the cases involve the same individual. Verify "
                        "independently before treating any link as established.", "MabuNotice")]],
                   colWidths=[CONTENT_W])
    notice.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), AMBER_BG),
        ("LINEBEFORE", (0, 0), (0, -1), 2.5, GOLD),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    flow += [Spacer(1, 12), notice]

    flow += _section("Identifiers shared across all cases")
    flow.append(_p(", ".join(sorted(shared_across_all)) or "No single identifier is common to every case.",
                   "MabuCellMono" if shared_across_all else "MabuBody"))

    flow += _section("Cases in this cluster")
    rows = [_head("Case", "Status", "Investigator", "Entries")]
    for c in cases:
        rows.append([
            _p(c.get("title") or "Untitled Case", "MabuCell"),
            _p((c.get("status") or "open").capitalize(), "MabuCell"),
            _p(c.get("investigator") or "–", "MabuCell"),
            _p(str(len(c.get("entries", []))), "MabuCell"),
        ])
    flow.append(_grid_table(rows, [CONTENT_W - 3.3 * inch, 0.9 * inch, 1.6 * inch, 0.8 * inch]))

    for case in cases:
        flow.append(PageBreak())
        flow.extend(_case_flowables(case, kicker="CLUSTER MEMBER"))

    chrome = _page_chrome("Cluster report")
    _doc(buf).build(flow, onFirstPage=chrome, onLaterPages=chrome)
    return buf.getvalue()
