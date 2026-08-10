import { createClient } from "@supabase/supabase-js";

import { env } from "./env.ts";

export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export type Student = {
  id: string;
  name: string | null;
  phone: string | null;
  photon_space_id: string | null;
  timezone: string;
  profile: Record<string, unknown>;
};

export async function getStudentBySpaceId(spaceId: string): Promise<Student | null> {
  const { data, error } = await db
    .from("students")
    .select("id, name, phone, photon_space_id, timezone, profile")
    .eq("photon_space_id", spaceId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Claim a message id. Returns false when this id has already been recorded —
 * the caller must then drop the event. `photon_message_id` is UNIQUE, so the
 * conflict is resolved by the database, not by a read-then-write race.
 */
export async function recordMessage(input: {
  studentId: string | null;
  photonMessageId: string;
  direction: string;
  content: string | null;
}): Promise<boolean> {
  const { data, error } = await db
    .from("messages")
    .upsert(
      {
        student_id: input.studentId,
        photon_message_id: input.photonMessageId,
        direction: input.direction,
        content: input.content,
      },
      { onConflict: "photon_message_id", ignoreDuplicates: true },
    )
    .select("id");

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Bind the demo student to the space they texted from. The student row is
 * created by `npm run seed`; onboarding only attaches the space id.
 */
export async function attachSpaceToStudent(phone: string, spaceId: string): Promise<Student> {
  const { data, error } = await db
    .from("students")
    .update({ photon_space_id: spaceId })
    .eq("phone", phone)
    .select("id, name, phone, photon_space_id, timezone, profile")
    .single();

  if (error) throw error;
  return data;
}
