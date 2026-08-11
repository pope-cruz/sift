from pathlib import Path

from reportlab import rl_config
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf"
OUTPUT.mkdir(parents=True, exist_ok=True)

RUN_MARKER = "SIFT-LIVE-20260811-A"
PAGE_WIDTH, PAGE_HEIGHT = letter
rl_config.invariant = 1

styles = getSampleStyleSheet()
styles.add(
    ParagraphStyle(
        name="CorpusTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=22,
        leading=27,
        textColor=colors.HexColor("#172033"),
        spaceAfter=14,
    )
)
styles.add(
    ParagraphStyle(
        name="CorpusDeck",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=11,
        leading=16,
        textColor=colors.HexColor("#526079"),
        spaceAfter=14,
    )
)
styles.add(
    ParagraphStyle(
        name="CorpusHeading",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=14,
        leading=18,
        textColor=colors.HexColor("#253552"),
        spaceBefore=10,
        spaceAfter=8,
    )
)
styles.add(
    ParagraphStyle(
        name="CorpusBody",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=10.5,
        leading=16,
        textColor=colors.HexColor("#20283A"),
        spaceAfter=8,
    )
)
styles.add(
    ParagraphStyle(
        name="CorpusBadge",
        parent=styles["BodyText"],
        fontName="Helvetica-Bold",
        fontSize=9,
        leading=12,
        textColor=colors.white,
        alignment=TA_CENTER,
    )
)


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#D7DCE6"))
    canvas.line(0.75 * inch, 0.62 * inch, PAGE_WIDTH - 0.75 * inch, 0.62 * inch)
    canvas.setFillColor(colors.HexColor("#69758B"))
    canvas.setFont("Helvetica", 8)
    canvas.drawString(0.75 * inch, 0.4 * inch, RUN_MARKER)
    canvas.drawRightString(PAGE_WIDTH - 0.75 * inch, 0.4 * inch, f"Page {doc.page}")
    canvas.restoreState()


def badge(text):
    table = Table([[Paragraph(text, styles["CorpusBadge"])]], colWidths=[2.2 * inch])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#3558A8")),
                ("BOX", (0, 0), (-1, -1), 0, colors.HexColor("#3558A8")),
                ("LEFTPADDING", (0, 0), (-1, -1), 9),
                ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    return table


def build_pdf(filename, story):
    path = OUTPUT / filename
    document = SimpleDocTemplate(
        str(path),
        pagesize=letter,
        rightMargin=0.8 * inch,
        leftMargin=0.8 * inch,
        topMargin=0.8 * inch,
        bottomMargin=0.8 * inch,
        title=filename,
        author="Sift live validation corpus",
    )
    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return path


practice = [
    badge("PRACTICE MATERIAL - NOT A CURRENT EXAM"),
    Spacer(1, 16),
    Paragraph("CHEM 204 Midterm Practice Questions", styles["CorpusTitle"]),
    Paragraph(
        "A reference packet for reviewing reaction kinetics and equilibrium. "
        "This document does not announce an exam date, deadline, or required event.",
        styles["CorpusDeck"],
    ),
    Paragraph("Reference numbers", styles["CorpusHeading"]),
    Paragraph("Course number: CHEM 204", styles["CorpusBody"]),
    Paragraph("Example student ID: 20240188", styles["CorpusBody"]),
    Paragraph("Workbook price: $20.18", styles["CorpusBody"]),
    Paragraph("See page 2018 in the digital archive index.", styles["CorpusBody"]),
    Paragraph("Questions", styles["CorpusHeading"]),
    Paragraph("1. Compare first-order and second-order reaction rates.", styles["CorpusBody"]),
    Paragraph("2. Explain how temperature affects an equilibrium constant.", styles["CorpusBody"]),
]

contradiction = [
    badge("CURRENT PROJECT BRIEF"),
    Spacer(1, 16),
    Paragraph("DATA 310 Project Brief", styles["CorpusTitle"]),
    Paragraph("Office of Data Science", styles["CorpusDeck"]),
    Paragraph("Publication details", styles["CorpusHeading"]),
    Paragraph("Published August 5, 2026.", styles["CorpusBody"]),
    Paragraph("Assignment", styles["CorpusHeading"]),
    Paragraph(
        "Build a reproducible analysis of the provided transit dataset and submit a short "
        "technical memo with your notebook.",
        styles["CorpusBody"],
    ),
    Paragraph(
        "Project submission is due September 18, 2026 at 5:00 PM.",
        styles["CorpusBody"],
    ),
    Paragraph("Course number: DATA 310. Submission portal ID: 20260031.", styles["CorpusBody"]),
]

multi_item = [
    badge("ITEM 1 OF 2 - EVENT FLYER"),
    Spacer(1, 16),
    Paragraph("Robotics Society Open Lab", styles["CorpusTitle"]),
    Paragraph("Presented by the Robotics Society", styles["CorpusDeck"]),
    Paragraph("Event details", styles["CorpusHeading"]),
    Paragraph("Open Lab meets on September 22, 2026 at 6:00 PM.", styles["CorpusBody"]),
    Paragraph("Location: Engineering Hall, Room 204.", styles["CorpusBody"]),
    Paragraph("Event code: 20262209.", styles["CorpusBody"]),
    PageBreak(),
    badge("ITEM 2 OF 2 - REFERENCE NOTICE"),
    Spacer(1, 16),
    Paragraph("North Library Renovation Notice", styles["CorpusTitle"]),
    Paragraph("Facilities and Campus Planning", styles["CorpusDeck"]),
    Paragraph("Publication details", styles["CorpusHeading"]),
    Paragraph("Published July 14, 2025.", styles["CorpusBody"]),
    Paragraph(
        "This notice summarizes completed accessibility improvements in the north wing. "
        "It does not announce a future event, deadline, or required student action.",
        styles["CorpusBody"],
    ),
    Paragraph("Archive reference: NL-2025-0714. See project page 2019.", styles["CorpusBody"]),
]


if __name__ == "__main__":
    files = [
        build_pdf("2018 Sample Midterm.pdf", practice),
        build_pdf("Fall 2018 Project Brief.pdf", contradiction),
        build_pdf("old-final-packet-2019.pdf", multi_item),
    ]
    for path in files:
        print(path)
