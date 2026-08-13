-- Sift schema (Phase 1). Run in the Supabase SQL editor, or:
--   psql "$SUPABASE_DB_URL" -f supabase/schema.sql
-- Safe to re-run.

create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  name text,
  phone text unique,
  photon_space_id text unique,                        -- space.id from the loop; needed for space.get()
  timezone text not null default 'America/New_York',
  profile jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table students add column if not exists channel text not null default 'imessage';
alter table students drop constraint if exists students_channel_check;
alter table students add constraint students_channel_check check (channel in ('imessage', 'web_demo'));

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students on delete cascade,
  type text,
  title text,
  summary text,
  extracted_text text,
  source_url text,
  category text,
  created_at timestamptz not null default now()
);

create table if not exists actions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students on delete cascade,
  item_id uuid references items on delete set null,
  description text,
  due_date date,
  status text not null default 'open',
  remind_at timestamptz,
  reminder_sent boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists attachments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students on delete cascade,
  item_id uuid references items on delete set null,
  filename text,
  mime_type text,
  storage_path text,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references students on delete cascade,
  photon_message_id text unique not null,             -- UNIQUE = the dedup mechanism
  direction text,
  content text,
  created_at timestamptz not null default now()
);

create table if not exists demo_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text unique not null,
  student_id uuid unique not null references students on delete cascade,
  client_key_hash text not null,
  timezone text not null default 'UTC',
  turns_used integer not null default 0 check (turns_used between 0 and 12),
  attachment_turns_used integer not null default 0 check (attachment_turns_used between 0 and 4),
  attachment_bytes_used bigint not null default 0 check (attachment_bytes_used between 0 and 20971520),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists demo_session_issuances (
  id uuid primary key default gen_random_uuid(),
  client_key_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists demo_turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references demo_sessions on delete cascade,
  client_message_id text not null,
  kind text not null check (kind in ('message', 'starter', 'reminder')),
  status text not null default 'accepted' check (status in ('accepted', 'processing', 'complete', 'failed')),
  events jsonb not null default '[]',
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, client_message_id)
);

create table if not exists demo_uploads (
  id uuid primary key,
  session_id uuid not null references demo_sessions on delete cascade,
  client_message_id text not null,
  storage_path text unique not null,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes between 1 and 8388608),
  status text not null default 'reserved' check (status in ('reserved', 'processing', 'consumed')),
  created_at timestamptz not null default now(),
  unique (session_id, client_message_id)
);

-- Every read path filters by student_id; index accordingly.
create index if not exists items_student_created_idx on items (student_id, created_at desc);
create index if not exists actions_student_due_idx on actions (student_id, due_date);
create index if not exists messages_student_created_idx on messages (student_id, created_at desc);
-- The reminder cron's claim query.
create index if not exists actions_due_reminders_idx on actions (remind_at) where reminder_sent = false;
create index if not exists students_channel_idx on students (channel);
create index if not exists demo_sessions_client_created_idx on demo_sessions (client_key_hash, created_at desc);
create index if not exists demo_session_issuances_client_created_idx on demo_session_issuances (client_key_hash, created_at desc);
create index if not exists demo_sessions_expiry_idx on demo_sessions (expires_at);
create index if not exists demo_turns_session_created_idx on demo_turns (session_id, created_at);
create index if not exists demo_uploads_session_idx on demo_uploads (session_id);

-- The worker connects with the service-role key, which bypasses RLS. Enabling
-- it with no policies means a leaked anon key reads nothing.
alter table students enable row level security;
alter table items enable row level security;
alter table actions enable row level security;
alter table attachments enable row level security;
alter table messages enable row level security;
alter table demo_sessions enable row level security;
alter table demo_session_issuances enable row level security;
alter table demo_turns enable row level security;
alter table demo_uploads enable row level security;

-- The worker connects as service_role, which bypasses RLS but still needs table
-- privileges. Supabase's default privileges did not cover tables created here,
-- so grant explicitly. Deliberately NOT granted to anon/authenticated — nothing
-- outside the worker touches these tables.
grant usage on schema public to service_role;
grant all privileges on table students, items, actions, attachments, messages, demo_sessions, demo_session_issuances, demo_turns, demo_uploads to service_role;

-- Atomically create an isolated student and fixed 24-hour session while
-- enforcing the per-client creation cap. The caller supplies only hashes.
create or replace function create_demo_session(
  p_token_hash text,
  p_client_key_hash text,
  p_timezone text
) returns table(session_id uuid, student_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_student uuid;
  v_session uuid;
  v_expiry timestamptz := now() + interval '24 hours';
begin
  perform pg_advisory_xact_lock(hashtext(p_client_key_hash));
  if (select count(*) from demo_session_issuances
      where client_key_hash = p_client_key_hash and created_at > now() - interval '24 hours') >= 3 then
    raise exception using errcode = 'P0001', message = 'DEMO_SESSION_CAP';
  end if;

  insert into demo_session_issuances (client_key_hash) values (p_client_key_hash);

  insert into students (timezone, channel) values (p_timezone, 'web_demo') returning id into v_student;
  insert into demo_sessions (token_hash, student_id, client_key_hash, timezone, expires_at)
  values (p_token_hash, v_student, p_client_key_hash, p_timezone, v_expiry)
  returning id into v_session;
  return query select v_session, v_student, v_expiry;
end $$;

-- Reserve attachment quota before issuing a short-lived signed Storage URL.
-- Repeating the client id returns the same reservation without double spend.
create or replace function reserve_demo_upload(
  p_token_hash text,
  p_upload_id uuid,
  p_client_message_id text,
  p_storage_path text,
  p_filename text,
  p_mime_type text,
  p_size_bytes bigint
) returns table(
  upload_id uuid,
  storage_path text,
  duplicate boolean,
  attachment_turns_remaining integer,
  attachment_bytes_remaining bigint
)
language plpgsql security definer set search_path = public as $$
declare
  s demo_sessions%rowtype;
  u demo_uploads%rowtype;
begin
  select * into s from demo_sessions where token_hash = p_token_hash for update;
  if not found or s.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'DEMO_SESSION_EXPIRED';
  end if;
  select * into u from demo_uploads
    where demo_uploads.session_id = s.id and client_message_id = p_client_message_id;
  if found then
    return query select u.id, u.storage_path, true,
      4 - s.attachment_turns_used, 20971520 - s.attachment_bytes_used;
    return;
  end if;
  if p_mime_type not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then
    raise exception using errcode = 'P0001', message = 'DEMO_INVALID_UPLOAD_TYPE';
  end if;
  if p_size_bytes < 1 or p_size_bytes > 8388608 then
    raise exception using errcode = 'P0001', message = 'DEMO_INVALID_UPLOAD_SIZE';
  end if;
  if s.turns_used >= 12 then
    raise exception using errcode = 'P0001', message = 'DEMO_TURN_QUOTA';
  end if;
  if s.attachment_turns_used >= 4 then
    raise exception using errcode = 'P0001', message = 'DEMO_ATTACHMENT_QUOTA';
  end if;
  if s.attachment_bytes_used + p_size_bytes > 20971520 then
    raise exception using errcode = 'P0001', message = 'DEMO_BYTES_QUOTA';
  end if;
  update demo_sessions set
    attachment_turns_used = attachment_turns_used + 1,
    attachment_bytes_used = attachment_bytes_used + p_size_bytes,
    updated_at = now()
  where id = s.id returning * into s;
  insert into demo_uploads (id, session_id, client_message_id, storage_path, filename, mime_type, size_bytes)
  values (p_upload_id, s.id, p_client_message_id, p_storage_path, p_filename, p_mime_type, p_size_bytes)
  returning * into u;
  return query select u.id, u.storage_path, false,
    4 - s.attachment_turns_used, 20971520 - s.attachment_bytes_used;
end $$;

drop function if exists claim_demo_turn(text, text, text, bigint);

-- One row lock governs quota consumption and turn insertion. A duplicate
-- client_message_id replays its existing events without consuming counters.
create or replace function claim_demo_turn(
  p_token_hash text,
  p_client_message_id text,
  p_kind text,
  p_attachment_bytes bigint,
  p_upload_id uuid default null
) returns table(
  turn_id uuid,
  session_id uuid,
  student_id uuid,
  timezone text,
  duplicate boolean,
  status text,
  events jsonb,
  turns_remaining integer,
  attachment_turns_remaining integer,
  attachment_bytes_remaining bigint
)
language plpgsql security definer set search_path = public as $$
declare
  s demo_sessions%rowtype;
  t demo_turns%rowtype;
  u demo_uploads%rowtype;
  v_reserved_attachment boolean := p_upload_id is not null;
  v_has_attachment boolean := p_attachment_bytes > 0 or p_upload_id is not null;
begin
  select * into s from demo_sessions where token_hash = p_token_hash for update;
  if not found or s.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'DEMO_SESSION_EXPIRED';
  end if;

  select * into t from demo_turns
  where demo_turns.session_id = s.id and client_message_id = p_client_message_id;
  if found then
    return query select t.id, s.id, s.student_id, s.timezone, true, t.status, t.events,
      12 - s.turns_used, 4 - s.attachment_turns_used, 20971520 - s.attachment_bytes_used;
    return;
  end if;

  if v_reserved_attachment then
    select * into u from demo_uploads
      where id = p_upload_id and demo_uploads.session_id = s.id and demo_uploads.status = 'reserved';
    if not found then
      raise exception using errcode = 'P0001', message = 'DEMO_UPLOAD_NOT_READY';
    end if;
  end if;

  if s.turns_used >= 12 then
    raise exception using errcode = 'P0001', message = 'DEMO_TURN_QUOTA';
  end if;
  if v_has_attachment and not v_reserved_attachment and s.attachment_turns_used >= 4 then
    raise exception using errcode = 'P0001', message = 'DEMO_ATTACHMENT_QUOTA';
  end if;
  if not v_reserved_attachment and s.attachment_bytes_used + p_attachment_bytes > 20971520 then
    raise exception using errcode = 'P0001', message = 'DEMO_BYTES_QUOTA';
  end if;

  update demo_sessions set
    turns_used = turns_used + 1,
    attachment_turns_used = attachment_turns_used + case when v_has_attachment and not v_reserved_attachment then 1 else 0 end,
    attachment_bytes_used = attachment_bytes_used + case when v_reserved_attachment then 0 else p_attachment_bytes end,
    updated_at = now()
  where id = s.id returning * into s;

  insert into demo_turns (session_id, client_message_id, kind, status)
  values (s.id, p_client_message_id, p_kind, 'processing') returning * into t;
  if v_reserved_attachment then
    update demo_uploads set status = 'processing' where id = p_upload_id;
  end if;
  return query select t.id, s.id, s.student_id, s.timezone, false, t.status, t.events,
    12 - s.turns_used, 4 - s.attachment_turns_used, 20971520 - s.attachment_bytes_used;
end $$;

revoke all on function create_demo_session(text, text, text) from public, anon, authenticated;
revoke all on function reserve_demo_upload(text, uuid, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function claim_demo_turn(text, text, text, bigint, uuid) from public, anon, authenticated;
grant execute on function create_demo_session(text, text, text) to service_role;
grant execute on function reserve_demo_upload(text, uuid, text, text, text, text, bigint) to service_role;
grant execute on function claim_demo_turn(text, text, text, bigint, uuid) to service_role;

-- Private bucket for syllabi and screenshots.
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;
