import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

import { env } from "./env.ts";
import { runLoop } from "./loop.ts";

const app = await Spectrum({
  projectId: env.PROJECT_ID,
  projectSecret: env.PROJECT_SECRET,
  providers: [imessage.config()],
});

// Spectrum registers its own SIGINT/SIGTERM handlers and calls stop() with a
// 3s timeout, so shutdown needs no wiring here. stop() is idempotent; this
// covers the loop ending on its own (stream closed).
try {
  await runLoop(app);
} finally {
  await app.stop();
}
