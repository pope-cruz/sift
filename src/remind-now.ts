// Deterministic Phase 4 acceptance command. It advances one existing pending
// reminder, then invokes the exact same claim/compose/Spectrum callback path as
// the minute worker. It never fabricates a reminder or bypasses persistence.
//
//   npm run remind:now
//   npm run remind:now -- --action <action-id>

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

import { forceNextReminderNow, getStudentByPhone } from "./db.ts";
import { env } from "./env.ts";
import { runProductionReminderBatch } from "./reminder-runtime.ts";

const actionFlag = process.argv.indexOf("--action");
const actionId = actionFlag >= 0 ? process.argv[actionFlag + 1] : undefined;
if (actionFlag >= 0 && !actionId) throw new Error("--action requires an action id.");

const student = await getStudentByPhone(env.DEMO_PHONE);
if (!student?.photon_space_id) {
  throw new Error("The demo student is not bound to an existing Spectrum iMessage space.");
}

const now = new Date();
const forced = await forceNextReminderNow(student.id, now, actionId);
if (!forced) {
  throw new Error("No pending reminder matched. Save a future deadline first.");
}

const app = await Spectrum({
  projectId: env.PROJECT_ID,
  projectSecret: env.PROJECT_SECRET,
  providers: [imessage.config()],
});

try {
  const result = await runProductionReminderBatch(app, {
    // Ensure the row written just above is unambiguously due even if the
    // database rounds its timestamp more coarsely than JavaScript.
    now: new Date(now.getTime() + 1_000),
    limit: 1,
  });
  if (result.delivered !== 1) {
    throw new Error(`Reminder was not delivered: ${JSON.stringify(result)}`);
  }
  console.log({ remind_now: "delivered", actionId: forced, result });
} finally {
  await app.stop();
}
