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

-- Which rubric version a call was scored with. The rubric never changed before this column existed, so every call
-- already in the table was scored with version 1; new scorecards store the version in force when they are saved.
alter table ${DB}.calls add column if not exists rubric_version smallint not null default 1;

-- Shared AI budget: model requests and tokens per quota period ('d:YYYY-MM-DD' and 'm:YYYY-MM', in the quota time
-- zone). reserve_ai_request counts one request only if every limit still allows it, holding both rows' locks, so
-- requests arriving at the same moment can never go past a limit. A limit of 0 is off.
create table if not exists ${DB}.ai_usage (
  period text primary key,
  requests integer not null default 0,
  tokens bigint not null default 0,
  updated_at timestamptz not null default now()
);
create or replace function ${DB}.reserve_ai_request(
  p_day text, p_month text, p_day_requests integer, p_day_tokens bigint, p_month_requests integer
) returns boolean language plpgsql as $fn$
declare
  d ${DB}.ai_usage;
  m ${DB}.ai_usage;
begin
  insert into ${DB}.ai_usage (period) values (p_day), (p_month) on conflict (period) do nothing;
  -- Always the day row first, then the month row: one lock order, no deadlocks.
  select * into d from ${DB}.ai_usage where period = p_day for update;
  select * into m from ${DB}.ai_usage where period = p_month for update;
  if (p_day_requests > 0 and d.requests >= p_day_requests)
     or (p_day_tokens > 0 and d.tokens >= p_day_tokens)
     or (p_month_requests > 0 and m.requests >= p_month_requests) then
    return false;
  end if;
  update ${DB}.ai_usage set requests = requests + 1, updated_at = now() where period = p_day;
  update ${DB}.ai_usage set requests = requests + 1, updated_at = now() where period = p_month;
  return true;
end
$fn$;
revoke all on function ${DB}.reserve_ai_request(text, text, integer, bigint, integer) from public;
-- Same lock order as reserve_ai_request (day, then month); one UPDATE of both rows could take them in either order
-- and deadlock against it.
create or replace function ${DB}.add_ai_tokens(p_day text, p_month text, p_tokens bigint)
returns void language plpgsql as $fn$
begin
  insert into ${DB}.ai_usage (period) values (p_day), (p_month) on conflict (period) do nothing;
  update ${DB}.ai_usage set tokens = tokens + p_tokens, updated_at = now() where period = p_day;
  update ${DB}.ai_usage set tokens = tokens + p_tokens, updated_at = now() where period = p_month;
end
$fn$;
revoke all on function ${DB}.add_ai_tokens(text, text, bigint) from public;

alter table ${DB}.ai_usage enable row level security;
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
