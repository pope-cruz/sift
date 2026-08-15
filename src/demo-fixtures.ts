import sharp from "sharp";

import { today } from "./dates.ts";
import type { Presentation, TurnAttachment } from "./turn-core.ts";

export type DemoScenarioId = "deadlines" | "cafe" | "application";

export type DemoScenario = {
  id: DemoScenarioId;
  label: string;
  caption: string;
  attachment: TurnAttachment;
  presentation: Presentation;
};

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function longDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" })
    .format(new Date(`${date}T12:00:00Z`));
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function renderFixture(title: string, eyebrow: string, lines: string[]): Promise<Buffer> {
  const rows = lines.map((line, index) =>
    `<text x="128" y="${300 + index * 90}" font-family="Arial, Helvetica, sans-serif" font-size="34" fill="#55534d">${escapeXml(line)}</text>`,
  ).join("");
  const svg = Buffer.from(`<svg width="1280" height="900" xmlns="http://www.w3.org/2000/svg">
    <rect width="1280" height="900" fill="#fcfbf7"/>
    <rect x="64" y="64" width="1152" height="772" rx="28" fill="#f6f4ee" stroke="#dcd8ce" stroke-width="2"/>
    <circle cx="112" cy="118" r="10" fill="#c94f32"/>
    <text x="140" y="130" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700" letter-spacing="2" fill="#817e76">${escapeXml(eyebrow.toUpperCase())}</text>
    <text x="112" y="230" font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="700" fill="#1c1c19">${escapeXml(title)}</text>
    ${rows}
  </svg>`);
  return sharp(svg).png().toBuffer();
}

export function isDemoScenarioId(value: unknown): value is DemoScenarioId {
  return value === "deadlines" || value === "cafe" || value === "application";
}

export async function demoScenario(id: DemoScenarioId, timezone: string, now = new Date()): Promise<DemoScenario> {
  const localToday = today(timezone, now);
  const dates = { soon: addDays(localToday, 3), later: addDays(localToday, 7), application: addDays(localToday, 10) };
  let title: string;
  let eyebrow: string;
  let lines: string[];
  let caption: string;
  let label: string;
  let presentation: Presentation;

  if (id === "deadlines") {
    title = "CS 201 · Current syllabus";
    eyebrow = "Course schedule";
    lines = [`Reading quiz — due ${longDate(dates.soon)}`, `Project 1 — due ${longDate(dates.later)} at 11:59 PM`, "Office hours — Monday, 2–4 PM"];
    caption = "sort this syllabus and keep its deadlines.";
    label = "Sort this syllabus";
    presentation = { type: "deadline_list", title: "Dates in this syllabus", items: [{ label: "Reading quiz", date: dates.soon }, { label: "Project 1", date: dates.later }] };
  } else if (id === "cafe") {
    title = "Radio Bakery";
    eyebrow = "Saved post · Greenpoint";
    lines = ["Quiet upstairs tables", "Good outlets · strong coffee", "Best order: twice-baked pistachio croissant"];
    caption = "Save this place for a study session.";
    label = "Save this place";
    presentation = { type: "saved_place", title: "Radio Bakery", detail: "Greenpoint · quiet upstairs tables" };
  } else {
    title = "Product Design Intern";
    eyebrow = "Northline Labs · Summer role";
    lines = [`Applications close ${longDate(dates.application)}`, "Portfolio and short cover note required", "Submit through the candidate portal"];
    caption = `Save this application and remind me before the ${longDate(dates.application)} deadline.`;
    label = "Remember this opportunity";
    presentation = { type: "task_list", title: "Application", items: [{ label: "Submit Northline application", date: dates.application }] };
  }

  const bytes = await renderFixture(title, eyebrow, lines);
  return {
    id,
    label,
    caption,
    attachment: { id: `demo-${id}-${localToday}`, name: `sort-demo-${id}.png`, mimeType: "image/png", size: bytes.length, read: async () => bytes },
    presentation,
  };
}
