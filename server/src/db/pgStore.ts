import type { FeedbackOutput } from "../llm/parse.js";
import type { CallType, Scenario, Temperament, Tier } from "../scenarios/load.js";
import type { Message } from "../types.js";
import { DB, SCHEMA_SQL } from "./schema.js";
import type {
  AdminUser, CallDetail, CallRow, CallSummary, OverviewCounts, Profile, RecentCall, RecentUser, Role, ScenarioCount, Settings,
  SkillAverage, Store, StoredScenario, TurnCommit, UsageRow,
} from "./store.js";

/** The part of node-postgres' Pool (and PGlite, used in tests) this store needs. */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  exec?(sql: string): Promise<unknown>;
}

type Row = Record<string, unknown>;

// node-postgres returns count/sum/numeric as strings; PGlite returns some as numbers. Normalise both.
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function toProfile(r: Row): Profile {
  return {
    userId: String(r.user_id),
    email: String(r.email),
    role: (r.role as Role | null) ?? null,
    interests: strs(r.interests) as CallType[],
    isPro: r.is_pro === true,
    proUntil: dateOrNull(r.pro_until),
    createdAt: date(r.created_at),
    lastSeenAt: date(r.last_seen_at),
  };
}

function toScenario(r: Row): StoredScenario {
  const labels = strs(r.account_labels);
  const values = strs(r.account_values);
  return {
    id: String(r.id),
    title: String(r.title),
    summary: String(r.summary),
    callType: r.call_type as CallType,
    temperament: r.temperament as Temperament,
    tier: r.tier as Tier,
    company: String(r.company),
    persona: {
      name: String(r.persona_name),
      background: String(r.persona_background),
      speechStyle: String(r.persona_speech_style),
    },
    goal: String(r.goal),
    account: labels.map((label, i) => ({ label, value: values[i] ?? "" })),
    policies: strs(r.policies),
    hiddenFacts: strs(r.hidden_facts),
    behaviorNotes: String(r.behavior_notes ?? ""),
    enabled: r.enabled === true,
    sortOrder: num(r.sort_order),
  };
}

function toCall(r: Row): CallRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    scenarioId: String(r.scenario_id),
    startedAt: date(r.started_at),
    turns: num(r.turns),
    tokens: num(r.tokens),
    finishedAt: dateOrNull(r.finished_at),
    serverTranscript: r.server_transcript === true,
    callerEndedAt: dateOrNull(r.caller_ended_at),
  };
}

function toSummary(r: Row): CallSummary {
  return {
    id: String(r.id),
    scenarioId: String(r.scenario_id),
    title: String(r.title),
    callType: r.call_type as CallType,
    temperament: r.temperament as Temperament,
    startedAt: date(r.started_at),
    durationSec: num(r.duration_sec),
    qaScore: num(r.qa_score),
  };
}

const SCENARIO_COLS = `id, title, summary, call_type, temperament, tier, company, persona_name, persona_background,
  persona_speech_style, goal, account_labels, account_values, policies, hidden_facts, behavior_notes`;

function scenarioParams(s: Scenario): unknown[] {
  return [
    s.id, s.title, s.summary, s.callType, s.temperament, s.tier, s.company, s.persona.name, s.persona.background,
    s.persona.speechStyle, s.goal, s.account.map((f) => f.label), s.account.map((f) => f.value), s.policies,
    s.hiddenFacts, s.behaviorNotes,
  ];
}

/** Escape LIKE wildcards so a search for "a_b" matches the literal text. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

export class PgStore implements Store {
  constructor(private db: Queryable) {}

  async migrate(): Promise<void> {
    // PGlite runs multi-statement SQL through exec(); node-postgres accepts it in query() without parameters.
    if (this.db.exec) await this.db.exec(SCHEMA_SQL);
    else await this.db.query(SCHEMA_SQL);
  }

  async touchProfile(userId: string, email: string): Promise<void> {
    await this.db.query(
      `insert into ${DB}.profiles (user_id, email) values ($1, $2)
       on conflict (user_id) do update set email = excluded.email, last_seen_at = now()
       where ${DB}.profiles.email <> excluded.email
          or ${DB}.profiles.last_seen_at < now() - interval '5 minutes'`,
      [userId, email],
    );
  }

  async getProfile(userId: string): Promise<Profile | null> {
    const { rows } = await this.db.query(`select * from ${DB}.profiles where user_id = $1`, [userId]);
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async updateProfile(userId: string, role: Role, interests: CallType[]): Promise<void> {
    await this.db.query(`update ${DB}.profiles set role = $2, interests = $3 where user_id = $1`, [userId, role, interests]);
  }

  async getSettings(): Promise<Settings> {
    const { rows } = await this.db.query(`select free_daily_limit, pro_instructions from ${DB}.settings`);
    const r = rows[0] ?? {};
    return { freeDailyLimit: num(r.free_daily_limit ?? 2), proInstructions: String(r.pro_instructions ?? "") };
  }

  async updateSettings(s: Settings): Promise<void> {
    await this.db.query(
      `update ${DB}.settings set free_daily_limit = $1, pro_instructions = $2, updated_at = now()`,
      [s.freeDailyLimit, s.proInstructions],
    );
  }

  async listScenarios(): Promise<StoredScenario[]> {
    const { rows } = await this.db.query(`select * from ${DB}.scenarios order by sort_order, id`);
    return rows.map(toScenario);
  }

  async seedScenarios(list: Scenario[]): Promise<number> {
    const { rows } = await this.db.query<{ m: unknown }>(`select coalesce(max(sort_order), -1) as m from ${DB}.scenarios`);
    let order = num(rows[0]?.m) + 1;
    let added = 0;
    for (const s of list) {
      const res = await this.db.query(
        `insert into ${DB}.scenarios (${SCENARIO_COLS}, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         on conflict (id) do nothing returning id`,
        [...scenarioParams(s), order],
      );
      if (res.rows.length) {
        added++;
        order++;
      }
    }
    return added;
  }

  async saveScenario(s: Scenario, enabled: boolean): Promise<void> {
    await this.db.query(
      `insert into ${DB}.scenarios (${SCENARIO_COLS}, enabled, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               (select coalesce(max(sort_order), -1) + 1 from ${DB}.scenarios))
       on conflict (id) do update set
         title = excluded.title, summary = excluded.summary, call_type = excluded.call_type,
         temperament = excluded.temperament, tier = excluded.tier, company = excluded.company,
         persona_name = excluded.persona_name, persona_background = excluded.persona_background,
         persona_speech_style = excluded.persona_speech_style, goal = excluded.goal,
         account_labels = excluded.account_labels, account_values = excluded.account_values,
         policies = excluded.policies, hidden_facts = excluded.hidden_facts,
         behavior_notes = excluded.behavior_notes, enabled = excluded.enabled, updated_at = now()`,
      [...scenarioParams(s), enabled],
    );
  }

  async setScenarioEnabled(id: string, enabled: boolean): Promise<boolean> {
    const { rows } = await this.db.query(
      `update ${DB}.scenarios set enabled = $2, updated_at = now() where id = $1 returning id`,
      [id, enabled],
    );
    return rows.length > 0;
  }

  async getCall(id: string): Promise<CallRow | null> {
    const { rows } = await this.db.query(`select * from ${DB}.calls where id = $1`, [id]);
    return rows[0] ? toCall(rows[0]) : null;
  }

  async createCall(c: { id: string; userId: string; scenarioId: string; serverTranscript?: boolean }): Promise<boolean> {
    const { rows } = await this.db.query(
      `insert into ${DB}.calls (id, user_id, scenario_id, server_transcript) values ($1, $2, $3, $4)
       on conflict (id) do nothing returning id`,
      [c.id, c.userId, c.scenarioId, c.serverTranscript === true],
    );
    return rows.length > 0;
  }

  async acquireLease(callId: string, userId: string, token: string, seconds: number): Promise<CallRow | null> {
    // One statement: Postgres re-checks the WHERE against the newest row version, so two requests can't both win.
    const { rows } = await this.db.query(
      `update ${DB}.calls set lease_token = $3, lease_until = now() + $4::int * interval '1 second'
       where id = $1 and user_id = $2 and finished_at is null and (lease_until is null or lease_until <= now())
       returning *`,
      [callId, userId, token, Math.round(seconds)],
    );
    return rows[0] ? toCall(rows[0]) : null;
  }

  async releaseLease(callId: string, userId: string, token: string, tokens: number): Promise<void> {
    await this.db.query(
      `update ${DB}.calls set tokens = tokens + $4,
         lease_token = case when lease_token = $3 then null else lease_token end,
         lease_until = case when lease_token = $3 then null else lease_until end
       where id = $1 and user_id = $2`,
      [callId, userId, token, Math.max(0, Math.round(tokens))],
    );
  }

  async commitTurn(t: TurnCommit): Promise<boolean> {
    // The turn rows go in only if this request still holds an unexpired lease: an expired request never writes.
    const { rows } = await this.db.query<{ n: unknown }>(
      `with u as (
         update ${DB}.calls set tokens = tokens + $4, turns = turns + 1,
           caller_ended_at = case when $5::boolean then now() else caller_ended_at end,
           lease_token = null, lease_until = null
         where id = $1 and user_id = $2 and lease_token = $3 and lease_until > now() and finished_at is null
         returning id
       ), ins as (
         insert into ${DB}.call_turns (call_id, position, role, text)
         select u.id, t.p, t.r, t.x from u, unnest($6::smallint[], $7::text[], $8::text[]) as t(p, r, x)
       )
       select count(*) as n from u`,
      [
        t.callId, t.userId, t.leaseToken, Math.max(0, Math.round(t.tokens)), t.ended,
        [t.position, t.position + 1], ["agent", "customer"], [t.agentText, t.callerText],
      ],
    );
    return num(rows[0]?.n) > 0;
  }

  async getTurns(callId: string, userId: string): Promise<Message[]> {
    const { rows } = await this.db.query(
      `select t.role, t.text from ${DB}.call_turns t join ${DB}.calls c on c.id = t.call_id
       where t.call_id = $1 and c.user_id = $2 order by t.position`,
      [callId, userId],
    );
    return rows.map((r) => ({ role: r.role as Message["role"], text: String(r.text) }));
  }

  async purgeAbandonedTurns(before: Date): Promise<number> {
    const { rows } = await this.db.query<{ n: unknown }>(
      `with gone as (
         delete from ${DB}.call_turns t using ${DB}.calls c
         where t.call_id = c.id and c.finished_at is null and c.started_at < $1
         returning t.call_id
       )
       select count(distinct call_id) as n from gone`,
      [before],
    );
    return num(rows[0]?.n);
  }

  async recordUsage(callId: string, tokens: number, turn: boolean): Promise<void> {
    await this.db.query(
      `update ${DB}.calls set tokens = tokens + $2, turns = turns + $3 where id = $1`,
      [callId, Math.max(0, Math.round(tokens)), turn ? 1 : 0],
    );
  }

  async countCallsSince(userId: string, since: Date): Promise<number> {
    const { rows } = await this.db.query<{ n: unknown }>(
      `select count(*) as n from ${DB}.calls where user_id = $1 and started_at >= $2 and turns > 0`,
      [userId, since],
    );
    return num(rows[0]?.n);
  }

  async saveFeedback(
    callId: string, durationSec: number, qaScore: number, f: FeedbackOutput, transcript: Message[] | null, leaseToken: string | null = null,
  ): Promise<boolean> {
    const idx = (a: unknown[]) => a.map((_, i) => i);
    const lines = transcript ?? [];
    // One statement, so the call row and all its child rows are written together or not at all.
    const { rows } = await this.db.query<{ n: unknown }>(
      `with c as (
         update ${DB}.calls set finished_at = now(), duration_sec = $2, qa_score = $3, summary = $4,
           lease_token = null, lease_until = null
         where id = $1 and finished_at is null
           and ($22::uuid is null or (lease_token = $22::uuid and lease_until > now()))
         returning id
       ), crit as (
         insert into ${DB}.call_criteria (call_id, position, key, score, evidence, tip)
         select c.id, t.p, t.k, t.s, t.e, t.tip
         from c, unnest($5::smallint[], $6::text[], $7::smallint[], $8::text[], $9::text[]) as t(p, k, s, e, tip)
       ), str as (
         insert into ${DB}.call_strengths (call_id, position, text)
         select c.id, t.p, t.x from c, unnest($10::smallint[], $11::text[]) as t(p, x)
       ), mom as (
         insert into ${DB}.call_moments (call_id, position, said, better, why)
         select c.id, t.p, t.s, t.b, t.w from c, unnest($12::smallint[], $13::text[], $14::text[], $15::text[]) as t(p, s, b, w)
       ), phr as (
         insert into ${DB}.call_phrases (call_id, position, phrase, when_to_use)
         select c.id, t.p, t.x, t.w from c, unnest($16::smallint[], $17::text[], $18::text[]) as t(p, x, w)
       ), trn as (
         insert into ${DB}.call_turns (call_id, position, role, text)
         select c.id, t.p, t.r, t.x from c, unnest($19::smallint[], $20::text[], $21::text[]) as t(p, r, x)
       )
       select count(*) as n from c`,
      [
        callId, Math.max(0, Math.round(durationSec)), qaScore, f.summary,
        idx(f.criteria), f.criteria.map((c) => c.key), f.criteria.map((c) => c.score),
        f.criteria.map((c) => c.evidence), f.criteria.map((c) => c.tip),
        idx(f.strengths), f.strengths,
        idx(f.moments), f.moments.map((m) => m.said), f.moments.map((m) => m.better), f.moments.map((m) => m.why),
        idx(f.phrases), f.phrases.map((p) => p.phrase), f.phrases.map((p) => p.whenToUse),
        idx(lines), lines.map((m) => m.role), lines.map((m) => m.text),
        leaseToken,
      ],
    );
    return num(rows[0]?.n) > 0;
  }

  async getCallDetail(userId: string, callId: string): Promise<CallDetail | null> {
    const { rows } = await this.db.query(
      `select c.*, s.title, s.call_type, s.temperament from ${DB}.calls c join ${DB}.scenarios s on s.id = c.scenario_id
       where c.id = $1 and c.user_id = $2 and c.finished_at is not null`,
      [callId, userId],
    );
    const r = rows[0];
    if (!r) return null;
    const q = (sql: string) => this.db.query(sql + " where call_id = $1 order by position", [callId]).then((x) => x.rows);
    const [crit, str, mom, phr, trn] = await Promise.all([
      q(`select key, score, evidence, tip from ${DB}.call_criteria`),
      q(`select text from ${DB}.call_strengths`),
      q(`select said, better, why from ${DB}.call_moments`),
      q(`select phrase, when_to_use from ${DB}.call_phrases`),
      q(`select role, text from ${DB}.call_turns`),
    ]);
    return {
      ...toSummary(r),
      feedback: {
        criteria: crit.map((c) => ({ key: String(c.key), score: num(c.score), evidence: String(c.evidence), tip: String(c.tip) })),
        strengths: str.map((s) => String(s.text)),
        moments: mom.map((m) => ({ said: String(m.said), better: String(m.better), why: String(m.why) })),
        phrases: phr.map((p) => ({ phrase: String(p.phrase), whenToUse: String(p.when_to_use) })),
        summary: String(r.summary ?? ""),
      },
      transcript: trn.map((t) => ({ role: t.role as Message["role"], text: String(t.text) })),
    };
  }

  async listCalls(userId: string, limit: number): Promise<CallSummary[]> {
    const { rows } = await this.db.query(
      `select c.id, c.scenario_id, c.started_at, c.duration_sec, c.qa_score, s.title, s.call_type, s.temperament
       from ${DB}.calls c join ${DB}.scenarios s on s.id = c.scenario_id
       where c.user_id = $1 and c.finished_at is not null
       order by c.started_at desc limit $2`,
      [userId, limit],
    );
    return rows.map(toSummary);
  }

  async skillAverages(userId: string): Promise<SkillAverage[]> {
    const { rows } = await this.db.query(
      `select k.key, avg(k.score) as avg, count(*) as n
       from ${DB}.call_criteria k
       join ${DB}.calls c on c.id = k.call_id
       join ${DB}.scenarios s on s.id = c.scenario_id
       where c.user_id = $1 and s.call_type <> 'interview'
       group by k.key`,
      [userId],
    );
    return rows.map((r) => ({ key: String(r.key), avg: Math.round(Number(r.avg) * 10) / 10, n: num(r.n) }));
  }

  async listUsers(opts: { query: string; limit: number; offset: number }): Promise<{ users: AdminUser[]; total: number }> {
    const { rows } = await this.db.query(
      `select p.user_id, p.email, p.role, p.created_at, p.last_seen_at, p.is_pro, p.pro_until,
              count(c.id) filter (where c.turns > 0) as calls,
              coalesce(sum(c.tokens), 0) as tokens,
              max(c.started_at) as last_call_at,
              avg(c.qa_score) as avg_qa,
              count(*) over () as total
       from ${DB}.profiles p
       left join ${DB}.calls c on c.user_id = p.user_id
       where $1 = '' or lower(p.email) like '%' || lower($1) || '%' escape '\\'
       group by p.user_id
       order by p.last_seen_at desc
       limit $2 offset $3`,
      [likeEscape(opts.query.trim()), opts.limit, opts.offset],
    );
    return {
      total: num(rows[0]?.total),
      users: rows.map((r) => ({
        userId: String(r.user_id),
        email: String(r.email),
        role: (r.role as Role | null) ?? null,
        createdAt: date(r.created_at),
        lastSeenAt: date(r.last_seen_at),
        isPro: r.is_pro === true,
        proUntil: dateOrNull(r.pro_until),
        calls: num(r.calls),
        tokens: num(r.tokens),
        lastCallAt: dateOrNull(r.last_call_at),
        avgQa: r.avg_qa === null ? null : Math.round(Number(r.avg_qa)),
      })),
    };
  }

  async setPro(userId: string, isPro: boolean, proUntil: Date | null): Promise<boolean> {
    const { rows } = await this.db.query(
      `update ${DB}.profiles set is_pro = $2, pro_until = $3 where user_id = $1 returning user_id`,
      [userId, isPro, isPro ? proUntil : null],
    );
    return rows.length > 0;
  }

  async overviewCounts(newSince: Date, now: Date): Promise<OverviewCounts> {
    const { rows } = await this.db.query(
      `select count(*) as users,
              count(*) filter (where created_at >= $1) as new_users,
              count(*) filter (where is_pro and (pro_until is null or pro_until > $2)) as pro_users
       from ${DB}.profiles`,
      [newSince, now],
    );
    const r = rows[0] ?? {};
    return { users: num(r.users), newUsers: num(r.new_users), proUsers: num(r.pro_users) };
  }

  async recentCalls(limit: number): Promise<RecentCall[]> {
    const { rows } = await this.db.query(
      `select p.email, s.title, s.call_type, s.temperament, c.started_at, c.qa_score
       from ${DB}.calls c
       join ${DB}.profiles p on p.user_id = c.user_id
       join ${DB}.scenarios s on s.id = c.scenario_id
       where c.turns > 0
       order by c.started_at desc limit $1`,
      [limit],
    );
    return rows.map((r) => ({
      email: String(r.email),
      title: String(r.title),
      callType: r.call_type as CallType,
      temperament: r.temperament as Temperament,
      startedAt: date(r.started_at),
      qaScore: numOrNull(r.qa_score),
    }));
  }

  async recentUsers(limit: number): Promise<RecentUser[]> {
    const { rows } = await this.db.query(
      `select email, role, created_at from ${DB}.profiles order by created_at desc limit $1`,
      [limit],
    );
    return rows.map((r) => ({ email: String(r.email), role: (r.role as Role | null) ?? null, createdAt: date(r.created_at) }));
  }

  async topScenarios(since: Date, limit: number): Promise<ScenarioCount[]> {
    const { rows } = await this.db.query(
      `select s.title, s.call_type, count(*) as calls
       from ${DB}.calls c join ${DB}.scenarios s on s.id = c.scenario_id
       where c.started_at >= $1 and c.turns > 0
       group by s.id, s.title, s.call_type
       order by count(*) desc, s.title
       limit $2`,
      [since, limit],
    );
    return rows.map((r) => ({ title: String(r.title), callType: r.call_type as CallType, calls: num(r.calls) }));
  }

  async usageSince(since: Date): Promise<UsageRow[]> {
    const { rows } = await this.db.query(
      `select started_at, user_id, tokens, qa_score from ${DB}.calls
       where started_at >= $1 and turns > 0 order by started_at`,
      [since],
    );
    return rows.map((r) => ({
      startedAt: date(r.started_at),
      userId: String(r.user_id),
      tokens: num(r.tokens),
      qa: numOrNull(r.qa_score),
    }));
  }
}
