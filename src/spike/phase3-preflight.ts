// Bounded, read-only Phase 3 check against the persisted demo student.
// It never prints identity fields, raw messages, extracted documents, or
// credentials. Pass --model to exercise the real Haiku answer call as well.
//
//   npm run phase3:preflight
//   npm run phase3:preflight -- --model

import { getContextRows, getStudentByPhone } from "../db.ts";
import { today } from "../dates.ts";
import { env } from "../env.ts";
import { respond } from "../llm.ts";
import { assembleContext, fallbackReply, renderContext, validateReply } from "../planner.ts";

const question = "Plan my week using what I've saved.";
const useModel = process.argv.includes("--model");
const student = await getStudentByPhone(env.DEMO_PHONE);
if (!student) throw new Error("The demo student is not seeded.");

const context = assembleContext({
  student,
  question,
  today: today(student.timezone),
  rows: await getContextRows(student.id),
});
const rendered = renderContext(context);

const callback = {
  has_project_1: /\bProject 1\b/i.test(rendered),
  saved_place_names: context.places.map((place) => place.place?.name ?? place.title).filter(Boolean),
  upcoming_deadlines: context.upcomingDeadlines.map((action) => ({
    title: action.itemTitle,
    description: action.description,
    due_date: action.dueDate,
  })),
  context_characters: rendered.length,
  within_budget: rendered.length <= 8_000,
  malformed_rows_ignored: context.droppedMalformedRows,
};

console.log({ phase3_preflight: callback });

if (useModel) {
  const answer = await respond({
    history: context.messages.map(({ direction, content }) => ({ direction, content })),
    text: question,
    context: rendered,
    timezone: student.timezone,
    tools: [],
    runTool: async () => "Error: tools are disabled in this read-only preflight.",
    validateReply: (text) => validateReply(context, text),
    fallbackReply: fallbackReply(context),
  });
  console.log({ model_answer: answer });
}
