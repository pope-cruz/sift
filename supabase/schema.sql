-- sort schema (Phase 1). Run in the Supabase SQL editor, or:
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

alter table items add column if not exists source_message_id text;
-- Every item produced by one inbound turn shares this value. It is separate
-- from source_message_id because one PDF can produce several independently
-- idempotent items that must still be undone together.
alter table items add column if not exists source_turn_id text;

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

alter table messages add column if not exists processing_status text not null default 'complete';
alter table messages add column if not exists processing_started_at timestamptz;
alter table messages add column if not exists processing_attempts integer not null default 0;
alter table messages drop constraint if exists messages_processing_status_check;
alter table messages add constraint messages_processing_status_check
  check (processing_status in ('pending', 'processing', 'complete', 'failed'));

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
  attempt_count integer not null default 1,
  lease_expires_at timestamptz,
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
  status text not null default 'reserved' check (status in ('reserved', 'processing', 'consumed', 'refunded')),
  created_at timestamptz not null default now(),
  unique (session_id, client_message_id)
);

create table if not exists job_failures (
  id uuid primary key default gen_random_uuid(),
  stage text not null,
  resource_id text,
  error_code text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table demo_turns add column if not exists attempt_count integer not null default 1;
alter table demo_turns add column if not exists lease_expires_at timestamptz;
alter table demo_uploads drop constraint if exists demo_uploads_status_check;
alter table demo_uploads add constraint demo_uploads_status_check
  check (status in ('reserved', 'processing', 'consumed', 'refunded'));

-- Every read path filters by student_id; index accordingly.
create index if not exists items_student_created_idx on items (student_id, created_at desc);
create unique index if not exists items_student_source_message_idx
  on items (student_id, source_message_id) where source_message_id is not null;
create index if not exists items_student_source_turn_idx
  on items (student_id, source_turn_id, created_at desc) where source_turn_id is not null;
create index if not exists actions_student_due_idx on actions (student_id, due_date);
create index if not exists messages_student_created_idx on messages (student_id, created_at desc);
create index if not exists messages_pending_idx on messages (processing_status, created_at)
  where direction = 'inbound' and processing_status <> 'complete';
-- The reminder cron's claim query.
create index if not exists actions_due_reminders_idx on actions (remind_at) where reminder_sent = false;
create index if not exists students_channel_idx on students (channel);
create index if not exists demo_sessions_client_created_idx on demo_sessions (client_key_hash, created_at desc);
create index if not exists demo_session_issuances_client_created_idx on demo_session_issuances (client_key_hash, created_at desc);
create index if not exists demo_sessions_expiry_idx on demo_sessions (expires_at);
create index if not exists demo_turns_session_created_idx on demo_turns (session_id, created_at);
create index if not exists demo_uploads_session_idx on demo_uploads (session_id);
create index if not exists job_failures_created_idx on job_failures (created_at desc);

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
alter table job_failures enable row level security;

-- The worker connects as service_role, which bypasses RLS but still needs table
-- privileges. Supabase's default privileges did not cover tables created here,
-- so grant explicitly. Deliberately NOT granted to anon/authenticated — nothing
-- outside the worker touches these tables.
grant usage on schema public to service_role;
grant all privileges on table students, items, actions, attachments, messages, demo_sessions, demo_session_issuances, demo_turns, demo_uploads, job_failures to service_role;

-- One text mutation becomes one durable command. The stable source message id
-- is the idempotency key, and item + action writes share this transaction.
create or replace function save_note_with_actions(
  p_student_id uuid,
  p_source_message_id text,
  p_title text,
  p_summary text,
  p_extracted_text text,
  p_actions jsonb
) returns table(item_id uuid, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_item uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_student_id::text || ':' || p_source_message_id));
  select id into v_item from items
    where student_id = p_student_id and source_message_id = p_source_message_id;
  if found then
    return query select v_item, true;
    return;
  end if;

  if jsonb_typeof(p_actions) <> 'array' or jsonb_array_length(p_actions) > 20 then
    raise exception using errcode = 'P0001', message = 'INVALID_NOTE_ACTIONS';
  end if;

  insert into items (
    student_id, type, title, summary, extracted_text, category, source_message_id, source_turn_id
  )
  values (
    p_student_id, 'note', p_title, p_summary, p_extracted_text, 'note',
    p_source_message_id, p_source_message_id
  )
  returning id into v_item;

  insert into actions (student_id, item_id, description, due_date, remind_at, status)
  select
    p_student_id,
    v_item,
    entry->>'description',
    nullif(entry->>'due_date', '')::date,
    nullif(entry->>'remind_at', '')::timestamptz,
    case when entry->>'status' = 'reference' then 'reference' else 'open' end
  from jsonb_array_elements(p_actions) as entry;

  return query select v_item, false;
end $$;

create or replace function save_ingest_item(
  p_student_id uuid,
  p_source_message_id text,
  p_source_turn_id text,
  p_type text,
  p_title text,
  p_summary text,
  p_extracted_text text,
  p_category text,
  p_filename text,
  p_mime_type text,
  p_storage_path text,
  p_actions jsonb
) returns table(item_id uuid, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_item uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_student_id::text || ':' || p_source_message_id));
  select id into v_item from items
    where student_id = p_student_id and source_message_id = p_source_message_id;
  if found then
    return query select v_item, true;
    return;
  end if;
  if jsonb_typeof(p_actions) <> 'array' or jsonb_array_length(p_actions) > 100 then
    raise exception using errcode = 'P0001', message = 'INVALID_INGEST_ACTIONS';
  end if;

  insert into items (
    student_id, type, title, summary, extracted_text, category, source_message_id, source_turn_id
  )
  values (
    p_student_id, p_type, p_title, p_summary, p_extracted_text, p_category,
    p_source_message_id, p_source_turn_id
  )
  returning id into v_item;
  insert into attachments (student_id, item_id, filename, mime_type, storage_path)
  values (p_student_id, v_item, p_filename, p_mime_type, p_storage_path);
  insert into actions (student_id, item_id, description, due_date, remind_at, status)
  select
    p_student_id,
    v_item,
    entry->>'description',
    nullif(entry->>'due_date', '')::date,
    nullif(entry->>'remind_at', '')::timestamptz,
    case when entry->>'status' = 'reference' then 'reference' else 'open' end
  from jsonb_array_elements(p_actions) as entry;
  return query select v_item, false;
end $$;

-- Undo is deliberately narrow: no caller-supplied item id, title, wildcard, or
-- profile field can reach this function. It removes only the newest save-turn
-- owned by this student, and only while "what I just sent" is still a truthful
-- description. Messages remain as conversational history. Storage objects are
-- returned to the worker only after all database references are gone.
create or replace function undo_latest_save(p_student_id uuid)
returns table(item_count integer, titles text[], storage_paths text[])
language plpgsql security definer set search_path = public as $$
declare
  v_source_turn_id text;
  v_item_ids uuid[];
  v_titles text[];
  v_candidate_paths text[];
  v_storage_paths text[];
begin
  perform pg_advisory_xact_lock(hashtext(p_student_id::text || ':undo_latest_save'));

  select i.source_turn_id into v_source_turn_id
  from items i
  where i.student_id = p_student_id
    and i.source_turn_id is not null
    and i.created_at >= now() - interval '2 hours'
  order by i.created_at desc, i.id desc
  limit 1;

  if v_source_turn_id is null then
    return;
  end if;

  select
    array_agg(i.id order by i.created_at, i.id),
    array_agg(i.title order by i.created_at, i.id) filter (where i.title is not null)
  into v_item_ids, v_titles
  from items i
  where i.student_id = p_student_id and i.source_turn_id = v_source_turn_id;

  select coalesce(array_agg(distinct a.storage_path), array[]::text[])
  into v_candidate_paths
  from attachments a
  where a.student_id = p_student_id
    and a.item_id = any(v_item_ids)
    and a.storage_path is not null;

  delete from actions
  where student_id = p_student_id and item_id = any(v_item_ids);
  delete from attachments
  where student_id = p_student_id and item_id = any(v_item_ids);
  delete from items
  where student_id = p_student_id and id = any(v_item_ids);

  select coalesce(array_agg(candidate.path), array[]::text[])
  into v_storage_paths
  from unnest(v_candidate_paths) as candidate(path)
  where not exists (select 1 from attachments a where a.storage_path = candidate.path);

  return query select cardinality(v_item_ids), coalesce(v_titles, array[]::text[]), v_storage_paths;
end $$;

-- Atomically create an isolated student and fixed 24-hour session while
-- enforcing the per-client creation cap. The caller supplies only hashes.
create or replace function create_demo_session(
  p_token_hash text,
  p_client_key_hash text,
  p_timezone text,
  p_max_sessions integer default 25
) returns table(session_id uuid, student_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_student uuid;
  v_session uuid;
  v_expiry timestamptz := now() + interval '24 hours';
begin
  perform pg_advisory_xact_lock(hashtext(p_client_key_hash));
  if (select count(*) from demo_session_issuances
      where client_key_hash = p_client_key_hash and created_at > now() - interval '24 hours') >= p_max_sessions then
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
    if u.status = 'refunded' then
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
      update demo_uploads set
        storage_path = p_storage_path,
        filename = p_filename,
        mime_type = p_mime_type,
        size_bytes = p_size_bytes,
        status = 'reserved',
        created_at = now()
      where id = u.id returning * into u;
      return query select u.id, u.storage_path, false,
        4 - s.attachment_turns_used, 20971520 - s.attachment_bytes_used;
      return;
    end if;
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
    if t.status = 'failed' or (t.status = 'processing' and coalesce(t.lease_expires_at, t.updated_at) <= now()) then
      update demo_turns set
        status = 'processing',
        events = '[]'::jsonb,
        failure_code = null,
        attempt_count = attempt_count + 1,
        lease_expires_at = now() + interval '5 minutes',
        updated_at = now()
      where id = t.id returning * into t;
      return query select t.id, s.id, s.student_id, s.timezone, false, t.status, t.events,
        12 - s.turns_used, 4 - s.attachment_turns_used, 20971520 - s.attachment_bytes_used;
      return;
    end if;
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

  insert into demo_turns (session_id, client_message_id, kind, status, lease_expires_at)
  values (s.id, p_client_message_id, p_kind, 'processing', now() + interval '5 minutes') returning * into t;
  if v_reserved_attachment then
    update demo_uploads set status = 'processing' where id = p_upload_id;
  end if;
  return query select t.id, s.id, s.student_id, s.timezone, false, t.status, t.events,
    12 - s.turns_used, 4 - s.attachment_turns_used, 20971520 - s.attachment_bytes_used;
end $$;

create or replace function release_demo_upload(
  p_token_hash text,
  p_upload_id uuid
) returns table(storage_path text)
language plpgsql security definer set search_path = public as $$
declare
  s demo_sessions%rowtype;
  u demo_uploads%rowtype;
  t demo_turns%rowtype;
begin
  select * into s from demo_sessions where token_hash = p_token_hash for update;
  if not found or s.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'DEMO_SESSION_EXPIRED';
  end if;
  select * into u from demo_uploads
    where demo_uploads.id = p_upload_id and demo_uploads.session_id = s.id for update;
  if not found or u.status in ('consumed', 'refunded') then return; end if;

  update demo_sessions set
    attachment_turns_used = greatest(0, attachment_turns_used - 1),
    attachment_bytes_used = greatest(0, attachment_bytes_used - u.size_bytes),
    updated_at = now()
  where id = s.id;
  update demo_uploads set status = 'refunded' where id = u.id;
  select * into t from demo_turns
    where demo_turns.session_id = s.id and demo_turns.client_message_id = u.client_message_id for update;
  if found and t.status = 'processing' and t.events = '[]'::jsonb then
    delete from demo_turns where id = t.id;
    update demo_sessions set turns_used = greatest(0, turns_used - 1), updated_at = now()
      where id = s.id;
  end if;
  return query select u.storage_path;
end $$;

create or replace function reset_demo_session(
  p_token_hash text,
  p_new_token_hash text
) returns table(session_id uuid, student_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  s demo_sessions%rowtype;
begin
  select * into s from demo_sessions where token_hash = p_token_hash for update;
  if not found or s.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'DEMO_SESSION_EXPIRED';
  end if;

  delete from messages where messages.student_id = s.student_id;
  delete from actions where actions.student_id = s.student_id;
  delete from attachments where attachments.student_id = s.student_id;
  delete from items where items.student_id = s.student_id;
  delete from demo_turns where demo_turns.session_id = s.id;
  delete from demo_uploads where demo_uploads.session_id = s.id;
  update demo_sessions set
    token_hash = p_new_token_hash,
    turns_used = 0,
    attachment_turns_used = 0,
    attachment_bytes_used = 0,
    updated_at = now()
  where id = s.id returning * into s;
  return query select s.id, s.student_id, s.expires_at;
end $$;

create or replace function claim_inbound_message(p_message_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  update messages set
    processing_status = 'processing',
    processing_started_at = now(),
    processing_attempts = processing_attempts + 1
  where photon_message_id = p_message_id
    and direction = 'inbound'
    and (
      processing_status in ('pending', 'failed')
      or (processing_status = 'processing' and processing_started_at < now() - interval '5 minutes')
    )
  returning id into v_id;
  return v_id is not null;
end $$;

create or replace function finish_inbound_message(p_message_id text, p_succeeded boolean)
returns void
language sql security definer set search_path = public as $$
  update messages set
    processing_status = case when p_succeeded then 'complete' else 'failed' end,
    processing_started_at = null
  where photon_message_id = p_message_id and direction = 'inbound';
$$;

drop function if exists create_demo_session(text, text, text);
revoke all on function create_demo_session(text, text, text, integer) from public, anon, authenticated;
revoke all on function reserve_demo_upload(text, uuid, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function claim_demo_turn(text, text, text, bigint, uuid) from public, anon, authenticated;
revoke all on function save_note_with_actions(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function save_ingest_item(uuid, text, text, text, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function undo_latest_save(uuid) from public, anon, authenticated;
revoke all on function release_demo_upload(text, uuid) from public, anon, authenticated;
revoke all on function reset_demo_session(text, text) from public, anon, authenticated;
revoke all on function claim_inbound_message(text) from public, anon, authenticated;
revoke all on function finish_inbound_message(text, boolean) from public, anon, authenticated;
grant execute on function create_demo_session(text, text, text, integer) to service_role;
grant execute on function reserve_demo_upload(text, uuid, text, text, text, text, bigint) to service_role;
grant execute on function claim_demo_turn(text, text, text, bigint, uuid) to service_role;
grant execute on function save_note_with_actions(uuid, text, text, text, text, jsonb) to service_role;
grant execute on function save_ingest_item(uuid, text, text, text, text, text, text, text, text, text, text, jsonb) to service_role;
grant execute on function undo_latest_save(uuid) to service_role;
grant execute on function release_demo_upload(text, uuid) to service_role;
grant execute on function reset_demo_session(text, text) to service_role;
grant execute on function claim_inbound_message(text) to service_role;
grant execute on function finish_inbound_message(text, boolean) to service_role;

-- Private bucket for syllabi and screenshots.
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;
