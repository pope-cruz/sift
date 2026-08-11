// Read-only audit for one live Phase 4 delivery.
//
//   npm run phase4:audit -- --action <action-id>

import { db, getStudentByPhone } from "../db.ts";
import { env } from "../env.ts";
import { composeReminder, type ReminderClaim } from "../reminders.ts";
import { storedDueTime } from "../stored-deadlines.ts";

const flag = process.argv.indexOf("--action");
const actionId = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!actionId) throw new Error("Pass --action <action-id> from remind:now output.");

const student = await getStudentByPhone(env.DEMO_PHONE);
if (!student?.photon_space_id) throw new Error("Demo student or Spectrum space is missing.");

const action = await db
  .from("actions")
  .select("id, student_id, item_id, description, due_date, remind_at, reminder_sent, status")
  .eq("id", actionId)
  .eq("student_id", student.id)
  .single();
if (action.error) throw action.error;

const item = action.data.item_id
  ? await db
      .from("items")
      .select("title, summary, extracted_text")
      .eq("id", action.data.item_id)
      .eq("student_id", student.id)
      .maybeSingle()
  : { data: null, error: null };
if (item.error) throw item.error;
if (!action.data.description || !action.data.due_date || !action.data.remind_at) {
  throw new Error("Delivered action is missing reminder grounding.");
}

const claim: ReminderClaim = {
  actionId: action.data.id,
  studentId: student.id,
  itemId: action.data.item_id,
  spaceId: student.photon_space_id,
  timezone: student.timezone,
  description: action.data.description,
  dueDate: action.data.due_date,
  dueTime: storedDueTime(
    item.data?.extracted_text,
    action.data.description,
    action.data.due_date,
  ),
  plannedSendAt: action.data.remind_at,
  itemTitle: item.data?.title ?? null,
  itemSummary: item.data?.summary ?? null,
};
const exactText = composeReminder(claim);
const transcript = await db
  .from("messages")
  .select("id", { count: "exact", head: true })
  .eq("student_id", student.id)
  .eq("direction", "outbound")
  .eq("content", exactText);
if (transcript.error) throw transcript.error;

const summary = {
  phase4_audit: "complete",
  actionId,
  action_status: action.data.status,
  reminder_sent: action.data.reminder_sent,
  exact_outbound_callbacks: transcript.count ?? 0,
  exact_text: exactText,
};
if (summary.action_status !== "open") throw new Error("The delivered action was not released to open.");
if (summary.reminder_sent !== true) throw new Error("The delivered flag was not persisted.");
if (summary.exact_outbound_callbacks !== 1) {
  throw new Error(`Expected one exact outbound callback, found ${summary.exact_outbound_callbacks}.`);
}
console.log(summary);
