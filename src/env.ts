import "dotenv/config";

import { z } from "zod";

function parse<T extends z.ZodType>(schema: T, label: string): z.infer<T> {
  const parsed = schema.safeParse(process.env);
  if (parsed.success) return parsed.data;
  const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
  throw new Error(`Bad or missing ${label} environment variables: ${missing}. See .env.example.`);
}

const sharedSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
});

const spectrumSchema = z.object({
  PROJECT_ID: z.string().min(1),
  PROJECT_SECRET: z.string().min(1),
  DEMO_PHONE: z.string().min(1),
});

const demoSchema = z.object({
  DEMO_ENABLED: z.enum(["true", "false"]).default("false"),
  DEMO_TOKEN_SECRET: z.string().min(32),
  CRON_SECRET: z.string().min(16),
});

/** Required by both Railway and Vercel; contains no Photon credentials. */
export const sharedEnv = parse(sharedSchema, "shared server");

let cachedSpectrum: z.infer<typeof spectrumSchema> | undefined;
let cachedDemo: z.infer<typeof demoSchema> | undefined;

export function getSpectrumEnv() {
  return (cachedSpectrum ??= parse(spectrumSchema, "Spectrum"));
}

export function getDemoEnv() {
  return (cachedDemo ??= parse(demoSchema, "web demo"));
}

/** Compatibility proxy for existing Spectrum-only scripts. It parses lazily. */
export const env = new Proxy({ ...sharedEnv } as z.infer<typeof sharedSchema> & z.infer<typeof spectrumSchema>, {
  get(target, key: string) {
    if (key in target) return target[key as keyof typeof target];
    return getSpectrumEnv()[key as keyof z.infer<typeof spectrumSchema>];
  },
});
