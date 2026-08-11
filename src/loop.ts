import type { SpectrumInstance } from "spectrum-ts";

import { getStudentBySpaceId, recordMessage } from "./db.ts";
import { handleTurn, parts, summarize } from "./turn.ts";

// Delivery signals, not conversation. This line emits `read` receipts as their
// own messages; they must never reach a turn or the messages table.
const IGNORED = new Set(["read", "typing", "reaction", "unsend", "edit"]);

export async function runLoop(app: SpectrumInstance) {
  for await (const [space, message] of app.messages) {
    // Kept as a guard, though this line does not echo sends back into the
    // stream — outbound rows are written at send time instead (see say() in
    // turn.ts).
    if (message.direction === "outbound") continue;
    if (IGNORED.has(message.content.type)) continue;

    try {
      const student = await getStudentBySpaceId(space.id);

      // Dedup before any side effect: message.id is stable across redeliveries,
      // so a retry loses the race on the UNIQUE column and returns false here.
      const fresh = await recordMessage({
        studentId: student?.id ?? null,
        photonMessageId: message.id,
        direction: message.direction,
        content: summarize(parts(message)),
      });

      if (!fresh) {
        console.log({ duplicate: message.id, spaceId: space.id });
        continue;
      }

      await handleTurn(space, message, student);
    } catch (error) {
      // A failure here is infrastructure (DB down), not turn logic — keep the
      // loop alive so the next message still gets a chance.
      console.error("loop error", { spaceId: space.id, messageId: message.id, error });
    }
  }
}
