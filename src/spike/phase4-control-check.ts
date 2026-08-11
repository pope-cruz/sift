// Bounded database acceptance for reschedule/cancel. It changes one pending
// demo reminder, verifies both states, and restores the original planned time.
// No Spectrum callback is made.
//
//   npm run phase4:controls -- --execute

import {
  cancelActionReminder,
  db,
  getStudentByPhone,
  rescheduleActionReminder,
} from "../db.ts";
import { env } from "../env.ts";

if (!process.argv.includes("--execute")) {
  throw new Error("Refusing to mutate live state without --execute.");
}

const student = await getStudentByPhone(env.DEMO_PHONE);
if (!student) throw new Error("Demo student is missing.");

const pending = await db
  .from("actions")
  .select("id, remind_at")
  .eq("student_id", student.id)
  .eq("status", "open")
  .eq("reminder_sent", false)
  .not("remind_at", "is", null)
  .order("remind_at", { ascending: true })
  .limit(1)
  .maybeSingle();
if (pending.error) throw pending.error;
if (!pending.data?.remind_at) throw new Error("No second pending reminder exists for the control check.");

const actionId = pending.data.id;
const original = pending.data.remind_at;
const probe = new Date(Date.now() + 10 * 60_000).toISOString();

try {
  const rescheduled = await rescheduleActionReminder({
    studentId: student.id,
    actionId,
    plannedSendAt: probe,
  });
  if (!rescheduled) throw new Error("Reschedule did not update the pending reminder.");

  const afterReschedule = await db
    .from("actions")
    .select("remind_at")
    .eq("id", actionId)
    .eq("student_id", student.id)
    .single();
  if (afterReschedule.error) throw afterReschedule.error;
  if (new Date(afterReschedule.data.remind_at).getTime() !== new Date(probe).getTime()) {
    throw new Error("Rescheduled time was not persisted.");
  }

  const cancelled = await cancelActionReminder(student.id, actionId);
  if (!cancelled) throw new Error("Cancel did not update the pending reminder.");
  const afterCancel = await db
    .from("actions")
    .select("remind_at")
    .eq("id", actionId)
    .eq("student_id", student.id)
    .single();
  if (afterCancel.error) throw afterCancel.error;
  if (afterCancel.data.remind_at !== null) throw new Error("Cancelled reminder still has a send time.");

  console.log({ phase4_controls: "complete", actionId, rescheduled: true, cancelled: true });
} finally {
  const restored = await rescheduleActionReminder({
    studentId: student.id,
    actionId,
    plannedSendAt: original,
  });
  if (!restored) throw new Error("Control check could not restore the original reminder time.");
}
