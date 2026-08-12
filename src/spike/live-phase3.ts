// One-shot Phase 3 acceptance harness. It is deliberately narrower than the
// normal worker: only the configured demo student, two generated marker-bound
// artifacts, one fixed plan question, and (with --send) one existing iMessage
// conversation. Existing rows are never reset or deleted.
//
//   npm run phase3:live -- --execute          # ingest + model, no delivery
//   npm run phase3:live -- --execute --send   # ingest + model + iMessage callback

import sharp from "sharp";
import { Spectrum, type Attachment } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

import { db, getContextRows, getStudentByPhone, recordMessage } from "../db.ts";
import { today } from "../dates.ts";
import { env } from "../env.ts";
import { ingest } from "../ingest.ts";
import { respond } from "../llm.ts";
import { assembleContext, fallbackReply, renderContext, validateReply } from "../planner.ts";
import { say } from "../turn.ts";

const MARKER = "SIFT-PHASE3-20260811-A";
const CAFE_NAME = "Juniper Study Cafe";
const QUESTION = "Plan my week using what I've saved.";
const execute = process.argv.includes("--execute");
const send = process.argv.includes("--send");
const resend = process.argv.includes("--resend");
if (!execute) throw new Error("Refusing to mutate live state without --execute.");

const student = await getStudentByPhone(env.DEMO_PHONE);
if (!student?.photon_space_id) {
  throw new Error("The demo student is missing or is not bound to an existing Spectrum space.");
}
const activeStudent = student;
const spaceId = student.photon_space_id;

function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function longDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));
}

function svg(lines: string[]): Buffer {
  const escaped = lines.map((line) =>
    line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );
  return Buffer.from(`
    <svg width="1400" height="1000" xmlns="http://www.w3.org/2000/svg">
      <rect width="1400" height="1000" fill="#fffdf7"/>
      <rect x="70" y="70" width="18" height="860" fill="#d26445"/>
      ${escaped.map((line, index) =>
        `<text x="140" y="${150 + index * 105}" font-family="Arial, Helvetica, sans-serif" ` +
        `font-size="${index === 0 ? 54 : 38}" font-weight="${index === 0 ? 700 : 400}" ` +
        `fill="#181614">${line}</text>`,
      ).join("\n")}
    </svg>
  `);
}

async function png(lines: string[]): Promise<Buffer> {
  return sharp(svg(lines)).png().toBuffer();
}

function attachment(id: string, name: string, bytes: Buffer): Attachment {
  return {
    id,
    name,
    mimeType: "image/png",
    size: bytes.length,
    read: async () => bytes,
  } as Attachment;
}

async function alreadyIngested(filename: string): Promise<boolean> {
  const { count, error } = await db
    .from("items")
    .select("id", { count: "exact", head: true })
    .eq("student_id", activeStudent.id)
    .ilike("extracted_text", `%${filename}%`);
  if (error) throw error;
  return (count ?? 0) > 0;
}

const localToday = today(activeStudent.timezone);
const projectDue = addDays(localToday, 6);
const quizDue = addDays(localToday, 3);
const syllabusFilename = `phase3-syllabus-${MARKER}.png`;
const cafeFilename = `phase3-cafe-${MARKER}.png`;

let syllabusReply = "already present";
if (!(await alreadyIngested(syllabusFilename))) {
  const bytes = await png([
    "CS 4414: Operating Systems — Current Syllabus",
    "Project 1: Process Scheduler",
    `Project 1 is due ${longDate(projectDue)} at 11:59 PM.`,
    `Reading quiz is due ${longDate(quizDue)}.`,
    "Office hours: Mondays, 2–4 PM",
    MARKER,
  ]);
  syllabusReply = await ingest({
    student: activeStudent,
    text: "Save this current syllabus and track its deadlines.",
    files: [attachment(`phase3-syllabus-${MARKER}`, syllabusFilename, bytes)],
  });
}

let cafeReply = "already present";
if (!(await alreadyIngested(cafeFilename))) {
  const bytes = await png([
    CAFE_NAME,
    "18 University Avenue",
    "Quiet upstairs seating",
    "Outlets at every table",
    "Open daily 7 AM–9 PM",
    MARKER,
  ]);
  cafeReply = await ingest({
    student: activeStudent,
    text: "Save this cafe for study sessions.",
    files: [attachment(`phase3-cafe-${MARKER}`, cafeFilename, bytes)],
  });
}

// Persist the exact question as the inbound half of the controlled application
// turn. A stable id makes reruns non-duplicating.
const freshQuestion = await recordMessage({
  studentId: activeStudent.id,
  photonMessageId: `phase3-live-question-${MARKER}`,
  direction: "inbound",
  content: QUESTION,
});
if (!freshQuestion && send && !resend) {
  // A failed run may have claimed the inbound validation row before reaching
  // delivery. Resume that safely; refuse only when an actual grounded callback
  // is already present in the outbound transcript.
  const { count, error } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("student_id", activeStudent.id)
    .eq("direction", "outbound")
    .ilike("content", "%Project 1%")
    .ilike("content", `%${CAFE_NAME}%`);
  if (error) throw error;
  if ((count ?? 0) > 0) {
    throw new Error("The grounded callback was already delivered; refusing a duplicate without --resend.");
  }
}

const context = assembleContext({
  student: activeStudent,
  question: QUESTION,
  today: localToday,
  rows: await getContextRows(activeStudent.id),
});
const rendered = renderContext(context);
const projectAction = context.upcomingDeadlines.find((action) =>
  /\bProject 1\b/i.test(`${action.itemTitle ?? ""} ${action.description}`),
);
const cafe = context.places.find((place) =>
  (place.place?.name ?? place.title ?? "").toLowerCase() === CAFE_NAME.toLowerCase(),
);
if (!projectAction) throw new Error("Live acceptance failed: Project 1 is absent from the 14-day plan context.");
if (!cafe) throw new Error(`Live acceptance failed: ${CAFE_NAME} is absent from saved places.`);

const answer = await respond({
  history: context.messages.map(({ direction, content }) => ({ direction, content })),
  text: QUESTION,
  context: rendered,
  timezone: activeStudent.timezone,
  tools: [],
  runTool: async () => "Error: mutation tools are disabled in the Phase 3 plan check.",
  validateReply: (text) => validateReply(context, text),
  fallbackReply: fallbackReply(context),
});
if (!/\bProject 1\b/i.test(answer)) throw new Error("Live answer omitted Project 1.");
if (/^\s*(#|\*|- )/m.test(answer)) throw new Error("Live answer used iMessage-hostile Markdown.");
if (!/\b(?:start|first|prioriti[sz]e|finish|then|after)\b/i.test(answer)) {
  throw new Error("Live answer listed context without making a recommendation.");
}

let delivered = false;
if (send) {
  const app = await Spectrum({
    projectId: env.PROJECT_ID,
    projectSecret: env.PROJECT_SECRET,
    providers: [imessage.config()],
  });
  try {
    const space = await imessage(app).space.get(spaceId);
    await say(space, activeStudent.id, answer);
    delivered = true;
  } finally {
    await app.stop();
  }
}

console.log({
  phase3_live: "complete",
  marker: MARKER,
  ingest_confirmations: { syllabus: syllabusReply, cafe: cafeReply },
  evidence: {
    project_1_due: projectAction.dueDate,
    saved_cafe: cafe.place?.name ?? cafe.title,
    context_characters: rendered.length,
  },
  exact_answer: answer,
  delivered,
});
