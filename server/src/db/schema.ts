/**
 * Database schema, applied at startup. Every statement is idempotent, so running it again is safe.
 *
 * Tables live in their own "callready" schema, which Supabase's public Data API does not expose, and row level
 * security is on with no policies. Only this server (connecting with the database password) can read or write them.
 */
export const SCHEMA_SQL = `
create schema if not exists callready;

create table if not exists callready.profiles (
  user_id uuid primary key,
  email text not null,
  goal text check (goal in ('job', 'improve')),
  level text check (level in ('A2', 'B1', 'B2')),
  is_pro boolean not null default false,
  pro_until timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists profiles_email on callready.profiles (lower(email));

create table if not exists callready.scenarios (
  id text primary key,
  title_es text not null,
  title_en text not null,
  summary_es text not null,
  difficulty text not null check (difficulty in ('A2', 'B1', 'B2')),
  tier text not null check (tier in ('free', 'pro')),
  category text not null check (category in ('support', 'sales', 'interview')),
  ai_role text not null check (ai_role in ('customer', 'interviewer')),
  persona_name text not null,
  persona_background text not null,
  persona_mood text not null,
  persona_speech_style text not null,
  goal text not null,
  hidden_facts text[] not null default '{}',
  expected_flow text[] not null,
  difficulty_notes text not null default '',
  enabled boolean not null default true,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists callready.calls (
  id uuid primary key,
  user_id uuid not null references callready.profiles (user_id) on delete cascade,
  scenario_id text not null references callready.scenarios (id),
  started_at timestamptz not null default now(),
  turns integer not null default 0,
  tokens integer not null default 0,
  finished_at timestamptz,
  duration_sec integer,
  score_fluency smallint,
  score_grammar smallint,
  score_vocabulary smallint,
  score_empathy smallint,
  score_call_flow smallint,
  avg_score numeric(3, 1),
  summary_es text
);
create index if not exists calls_user_started on callready.calls (user_id, started_at desc);
create index if not exists calls_started on callready.calls (started_at);

create table if not exists callready.call_corrections (
  call_id uuid not null references callready.calls (id) on delete cascade,
  position smallint not null,
  said text not null,
  better text not null,
  explanation_es text not null,
  primary key (call_id, position)
);

create table if not exists callready.call_phrases (
  call_id uuid not null references callready.calls (id) on delete cascade,
  position smallint not null,
  phrase text not null,
  meaning_es text not null,
  when_to_use_es text not null,
  primary key (call_id, position)
);

create table if not exists callready.settings (
  id boolean primary key default true check (id),
  free_daily_limit integer not null default 2 check (free_daily_limit >= 0),
  pro_instructions_es text not null default 'Para activar Pro, comuníquese con el equipo de CallReady.',
  updated_at timestamptz not null default now()
);
insert into callready.settings (id) values (true) on conflict (id) do nothing;

alter table callready.profiles enable row level security;
alter table callready.scenarios enable row level security;
alter table callready.calls enable row level security;
alter table callready.call_corrections enable row level security;
alter table callready.call_phrases enable row level security;
alter table callready.settings enable row level security;
`;
