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

-- Every read path filters by student_id; index accordingly.
create index if not exists items_student_created_idx on items (student_id, created_at desc);
create index if not exists actions_student_due_idx on actions (student_id, due_date);
create index if not exists messages_student_created_idx on messages (student_id, created_at desc);
-- The reminder cron's claim query.
create index if not exists actions_due_reminders_idx on actions (remind_at) where reminder_sent = false;

-- The worker connects with the service-role key, which bypasses RLS. Enabling
-- it with no policies means a leaked anon key reads nothing.
alter table students enable row level security;
alter table items enable row level security;
alter table actions enable row level security;
alter table attachments enable row level security;
alter table messages enable row level security;

-- The worker connects as service_role, which bypasses RLS but still needs table
-- privileges. Supabase's default privileges did not cover tables created here,
-- so grant explicitly. Deliberately NOT granted to anon/authenticated — nothing
-- outside the worker touches these tables.
grant usage on schema public to service_role;
grant all privileges on table students, items, actions, attachments, messages to service_role;

-- Private bucket for syllabi and screenshots.
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;
