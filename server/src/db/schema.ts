/** The schema this version reads and writes. */
export const DB = "callready_v2";

/**
 * Database schema, applied at startup. Every statement is idempotent, so running it again is safe.
 *
 * Tables live in their own schema, which Supabase's public Data API does not expose, and row level security is on
 * with no policies: only this server (connecting with the database password) can read or write them.
 *
 * Version 2 (call-center pivot) uses a fresh schema. The first start copies accounts (Pro status) and the free daily
 * limit from version 1 ("callready"); version 1 calls stay where they are and are no longer shown.
 */
export const SCHEMA_SQL = `
create schema if not exists ${DB};

create table if not exists ${DB}.profiles (
  user_id uuid primary key,
  email text not null,
  role text check (role in ('job_seeker', 'agent', 'trainer')),
  interests text[] not null default '{}',
  is_pro boolean not null default false,
  pro_until timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists profiles_email on ${DB}.profiles (lower(email));

create table if not exists ${DB}.scenarios (
  id text primary key,
  title text not null,
  summary text not null,
  call_type text not null check (call_type in ('service', 'tech', 'sales', 'collections', 'interview')),
  temperament text not null check (temperament in ('calm', 'demanding', 'furious')),
  tier text not null check (tier in ('free', 'pro')),
  company text not null,
  persona_name text not null,
  persona_background text not null,
  persona_speech_style text not null,
  goal text not null,
  account_labels text[] not null,
  account_values text[] not null,
  policies text[] not null,
  hidden_facts text[] not null default '{}',
  behavior_notes text not null default '',
  enabled boolean not null default true,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now(),
  check (cardinality(account_labels) = cardinality(account_values))
);

create table if not exists ${DB}.calls (
  id uuid primary key,
  user_id uuid not null references ${DB}.profiles (user_id) on delete cascade,
  scenario_id text not null references ${DB}.scenarios (id),
  started_at timestamptz not null default now(),
  turns integer not null default 0,
  tokens integer not null default 0,
  finished_at timestamptz,
  duration_sec integer,
  qa_score smallint check (qa_score between 0 and 100),
  summary text
);
create index if not exists calls_user_started on ${DB}.calls (user_id, started_at desc);
create index if not exists calls_started on ${DB}.calls (started_at);

create table if not exists ${DB}.call_criteria (
  call_id uuid not null references ${DB}.calls (id) on delete cascade,
  position smallint not null,
  key text not null,
  score smallint not null check (score between 0 and 10),
  evidence text not null,
  tip text not null,
  primary key (call_id, position)
);

create table if not exists ${DB}.call_strengths (
  call_id uuid not null references ${DB}.calls (id) on delete cascade,
  position smallint not null,
  text text not null,
  primary key (call_id, position)
);

create table if not exists ${DB}.call_moments (
  call_id uuid not null references ${DB}.calls (id) on delete cascade,
  position smallint not null,
  said text not null,
  better text not null,
  why text not null,
  primary key (call_id, position)
);

create table if not exists ${DB}.call_phrases (
  call_id uuid not null references ${DB}.calls (id) on delete cascade,
  position smallint not null,
  phrase text not null,
  when_to_use text not null,
  primary key (call_id, position)
);

create table if not exists ${DB}.call_turns (
  call_id uuid not null references ${DB}.calls (id) on delete cascade,
  position smallint not null,
  role text not null check (role in ('customer', 'agent')),
  text text not null,
  primary key (call_id, position)
);

create table if not exists ${DB}.settings (
  id boolean primary key default true check (id),
  free_daily_limit integer not null default 2 check (free_daily_limit >= 0),
  pro_instructions text not null default 'To activate Pro, contact the CallReady team.',
  updated_at timestamptz not null default now()
);

do $$
begin
  if to_regclass('callready.profiles') is not null then
    insert into ${DB}.profiles (user_id, email, is_pro, pro_until, created_at, last_seen_at)
    select user_id, email, is_pro, pro_until, created_at, last_seen_at from callready.profiles
    on conflict (user_id) do nothing;
  end if;
  if to_regclass('callready.settings') is not null then
    insert into ${DB}.settings (id, free_daily_limit)
    select true, free_daily_limit from callready.settings
    on conflict (id) do nothing;
  end if;
end $$;
insert into ${DB}.settings (id) values (true) on conflict (id) do nothing;

-- Server-recorded transcripts. Calls that existed before this change keep server_transcript = false (the old
-- browser-supplied transcript); every call created now is written with true. caller_ended_at is set when the server
-- ends the call. lease_token/lease_until let one request at a time run a turn or the scoring for a call.
alter table ${DB}.calls add column if not exists server_transcript boolean not null default false;
alter table ${DB}.calls add column if not exists caller_ended_at timestamptz;
alter table ${DB}.calls add column if not exists lease_token uuid;
alter table ${DB}.calls add column if not exists lease_until timestamptz;
create index if not exists calls_unfinished on ${DB}.calls (started_at) where finished_at is null;

alter table ${DB}.profiles enable row level security;
alter table ${DB}.scenarios enable row level security;
alter table ${DB}.calls enable row level security;
alter table ${DB}.call_criteria enable row level security;
alter table ${DB}.call_strengths enable row level security;
alter table ${DB}.call_moments enable row level security;
alter table ${DB}.call_phrases enable row level security;
alter table ${DB}.call_turns enable row level security;
alter table ${DB}.settings enable row level security;
`;
