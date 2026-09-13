"""
mabu_report.py — PDF report generation for MABU cases and correlation clusters.

Uses reportlab (pure Python, no external binary dependency) so this works
identically on Windows and the Ubuntu VPS with no extra system packages.
"""

import io
from datetime import datetime, timezone

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, HRFlowable,
)

MABU_GREEN = colors.HexColor("#0e5c28")
MABU_DARK = colors.HexColor("#0a140c")
MABU_TEXT = colors.HexColor("#1a1a1a")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="MabuTitle", fontSize=20, leading=24, textColor=MABU_DARK, spaceAfter=4, fontName="Helvetica-Bold"))
styles.add(ParagraphStyle(name="MabuSubtitle", fontSize=10, textColor=colors.grey, spaceAfter=14))
styles.add(ParagraphStyle(name="MabuSection", fontSize=13, textColor=MABU_GREEN, spaceBefore=16, spaceAfter=6, fontName="Helvetica-Bold"))
styles.add(ParagraphStyle(name="MabuBody", fontSize=10, leading=14))
styles.add(ParagraphStyle(name="MabuMeta", fontSize=9, textColor=colors.grey))


def _entry_table(entries: list[dict]) -> Table:
    rows = [["Date", "Author", "Summary"]]
    for e in entries:
        date = (e.get("date") or "")[:19].replace("T", " ")
        rows.append([date, e.get("author", ""), (e.get("summary") or "")[:80]])

    table = Table(rows, colWidths=[1.4 * inch, 1.3 * inch, 3.8 * inch])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), MABU_GREEN),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.lightgrey),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f5f7f5")]),
    ]))
    return table


def _identifier_lines(entries: list[dict]) -> list[str]:
    agg = {"emails": set(), "phones": set(), "usernames": set(), "names": set(), "ips": set()}
    for e in entries:
        for key in agg:
            agg[key].update(e.get(key, []))
    lines = []
    for label, key in [("Emails", "emails"), ("Phones", "phones"), ("Usernames", "usernames"),
                        ("Names/Aliases", "names"), ("IPs", "ips")]:
        values = sorted(agg[key])
        lines.append(f"<b>{label}:</b> {', '.join(values) if values else '(none)'}")
    return lines


def _case_flowables(case: dict) -> list:
    flow = []
    flow.append(Paragraph(case.get("title", "Untitled Case"), styles["MabuTitle"]))
    flow.append(Paragraph(
        f"Case ID: {case.get('case_id', '-')} &nbsp;|&nbsp; "
        f"Status: {case.get('status', 'open').upper()} &nbsp;|&nbsp; "
        f"Investigator: {case.get('investigator', '-')}",
        styles["MabuSubtitle"],
    ))
    flow.append(HRFlowable(width="100%", color=MABU_GREEN, thickness=1))

    flow.append(Paragraph("Case Metadata", styles["MabuSection"]))
    flow.append(Paragraph(f"Created: {case.get('created', '-')}", styles["MabuMeta"]))
    flow.append(Paragraph(f"Last updated: {case.get('updated', '-')}", styles["MabuMeta"]))
    flow.append(Paragraph(f"Tags: {', '.join(case.get('tags', [])) or '(none)'}", styles["MabuMeta"]))

    entries = case.get("entries", [])
    flow.append(Paragraph("Aggregated Identifiers", styles["MabuSection"]))
    for line in _identifier_lines(entries):
        flow.append(Paragraph(line, styles["MabuBody"]))

    flow.append(Paragraph(f"Entries ({len(entries)})", styles["MabuSection"]))
    if entries:
        flow.append(_entry_table(entries))
        flow.append(Spacer(1, 10))
        for i, e in enumerate(entries, start=1):
            date = (e.get("date") or "")[:19].replace("T", " ")
            flow.append(Paragraph(f"<b>Entry {i} — {date} by {e.get('author', '-')}</b>", styles["MabuBody"]))
            flow.append(Paragraph(f"Summary: {e.get('summary') or '(none)'}", styles["MabuBody"]))
            flow.append(Paragraph(f"Findings: {e.get('findings') or '(none)'}", styles["MabuBody"]))
            sources = e.get("sources", [])
            if sources:
                flow.append(Paragraph("Sources: " + "; ".join(sources), styles["MabuMeta"]))
            flow.append(Spacer(1, 8))
    else:
        flow.append(Paragraph("(no entries yet)", styles["MabuBody"]))

    activity = case.get("activity_log", [])
    if activity:
        flow.append(Paragraph("Activity Log", styles["MabuSection"]))
        for a in activity:
            date = (a.get("date") or "")[:19].replace("T", " ")
            flow.append(Paragraph(f"[{date}] {a.get('action', '')}: {a.get('detail', '')}", styles["MabuMeta"]))

    return flow


def _footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(colors.grey)
    canvas.drawString(0.75 * inch, 0.5 * inch,
                       f"MABU Research Platform — generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} — local-only, confidential")
    canvas.drawRightString(LETTER[0] - 0.75 * inch, 0.5 * inch, f"Page {doc.page}")
    canvas.restoreState()


def build_case_report_pdf(case: dict) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER,
                             topMargin=0.75 * inch, bottomMargin=0.75 * inch,
                             leftMargin=0.75 * inch, rightMargin=0.75 * inch)
    flow = _case_flowables(case)
    doc.build(flow, onFirstPage=_footer, onLaterPages=_footer)
    return buf.getvalue()


def build_cluster_report_pdf(cases: list[dict]) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER,
                             topMargin=0.75 * inch, bottomMargin=0.75 * inch,
                             leftMargin=0.75 * inch, rightMargin=0.75 * inch)

    flow = []
    flow.append(Paragraph("MABU Correlation Cluster Report", styles["MabuTitle"]))
    flow.append(Paragraph(f"{len(cases)} linked case(s)", styles["MabuSubtitle"]))
    flow.append(HRFlowable(width="100%", color=MABU_GREEN, thickness=1))

    # Shared identifier summary across all cases in the cluster
    all_ids = [set() for _ in cases]
    for i, c in enumerate(cases):
        for e in c.get("entries", []):
            for key in ("emails", "usernames", "names", "ips", "phones"):
                all_ids[i].update(v.lower() for v in e.get(key, []))

    shared_across_all = set.intersection(*all_ids) if all_ids else set()
    flow.append(Paragraph("Shared Across All Cases", styles["MabuSection"]))
    flow.append(Paragraph(", ".join(sorted(shared_across_all)) or "(no single identifier common to every case)", styles["MabuBody"]))

    for case in cases:
        flow.append(PageBreak())
        flow.extend(_case_flowables(case))

    doc.build(flow, onFirstPage=_footer, onLaterPages=_footer)
    return buf.getvalue()
