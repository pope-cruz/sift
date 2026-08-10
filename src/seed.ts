// Resets the demo student to a clean slate — run before every rehearsal and
// before recording:  npm run seed
import { db } from "./db.ts";
import { env } from "./env.ts";

const { data: existing, error: lookupError } = await db
  .from("students")
  .select("id")
  .eq("phone", env.DEMO_PHONE)
  .maybeSingle();

if (lookupError) throw lookupError;

// Children cascade from students, so dropping the row clears items, actions,
// attachments and messages with it.
if (existing) {
  const { error } = await db.from("students").delete().eq("id", existing.id);
  if (error) throw error;
}

const { data: student, error } = await db
  .from("students")
  .insert({
    name: "Demo Student",
    phone: env.DEMO_PHONE,
    photon_space_id: null, // Set by onboarding when they text "Start Sift".
    timezone: "America/New_York",
    profile: {},
  })
  .select("id, phone, timezone")
  .single();

if (error) throw error;

console.log({ seeded: student, note: 'text "Start Sift" from this number to bind the space' });
