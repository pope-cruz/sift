import "dotenv/config";

import { z } from "zod";

// Fail at boot with one readable message rather than at the first query.
const schema = z.object({
  PROJECT_ID: z.string().min(1),
  PROJECT_SECRET: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DEMO_PHONE: z.string().min(1),
  // Phases 2+; optional here so Phase 1 runs without it.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
  throw new Error(`Bad or missing environment variables: ${missing}. See .env.example.`);
}

export const env = parsed.data;
