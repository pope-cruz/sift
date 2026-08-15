// Phase 0 spike: prove the proactive path — sending into an existing
// conversation from outside the message loop, which is what the Phase 4
// reminder cron does.
//
//   npm run spike:send -- "<space.id logged by the loop>" "optional message"
//
// The space id comes from the loop's console output (or, from Phase 1 on,
// students.photon_space_id).
import "dotenv/config";

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const spaceId = process.argv[2] ?? process.env.DEMO_SPACE_ID;
const text = process.argv[3] ?? "sort here — this one came from outside the message loop.";

if (!spaceId) {
  throw new Error("Pass a space id: npm run spike:send -- \"<space.id>\" (or set DEMO_SPACE_ID)");
}

const projectId = process.env.PROJECT_ID;
const projectSecret = process.env.PROJECT_SECRET;

if (!projectId || !projectSecret) {
  throw new Error("Photon credentials missing");
}

const app = await Spectrum({
  projectId,
  projectSecret,
  providers: [imessage.config()],
});

try {
  // `phone` is only needed with multiple dedicated lines; on a shared pool it
  // is ignored, so we omit it.
  const space = await imessage(app).space.get(spaceId);
  await space.send(text);
  console.log({ sent: true, spaceId, text });
} finally {
  await app.stop();
}
