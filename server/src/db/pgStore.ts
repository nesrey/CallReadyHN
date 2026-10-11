import type { FeedbackOutput } from "../llm/parse.js";
import type { AiRole, Category, Difficulty, Scenario, Tier } from "../scenarios/load.js";
import { SCHEMA_SQL } from "./schema.js";
import type {
  AdminUser, CallDetail, CallRow, CallSummary, Goal, Profile, Settings, Store, StoredScenario, UsageRow,
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

function toProfile(r: Row): Profile {
  return {
    userId: String(r.user_id),
    email: String(r.email),
    goal: (r.goal as Goal | null) ?? null,
    level: (r.level as Difficulty | null) ?? null,
    isPro: r.is_pro === true,
    proUntil: dateOrNull(r.pro_until),
    createdAt: date(r.created_at),
    lastSeenAt: date(r.last_seen_at),
  };
}

function toScenario(r: Row): StoredScenario {
  return {
    id: String(r.id),
    title: { es: String(r.title_es), en: String(r.title_en) },
    summaryEs: String(r.summary_es),
    difficulty: r.difficulty as Difficulty,
    tier: r.tier as Tier,
    category: r.category as Category,
    aiRole: r.ai_role as AiRole,
    persona: {
      name: String(r.persona_name),
      background: String(r.persona_background),
      mood: String(r.persona_mood),
      speechStyle: String(r.persona_speech_style),
    },
    goal: String(r.goal),
    hiddenFacts: (r.hidden_facts as string[]) ?? [],
    expectedFlow: (r.expected_flow as string[]) ?? [],
    difficultyNotes: String(r.difficulty_notes ?? ""),
    enabled: r.enabled === true,
    sortOrder: num(r.sort_order),
  };
}

function toSummary(r: Row): CallSummary {
  return {
    id: String(r.id),
    scenarioId: String(r.scenario_id),
    titleEs: String(r.title_es),
    difficulty: r.difficulty as Difficulty,
    startedAt: date(r.started_at),
    durationSec: num(r.duration_sec),
    avg: num(r.avg_score),
  };
}

const SCENARIO_COLS = `id, title_es, title_en, summary_es, difficulty, tier, category, ai_role, persona_name,
  persona_background, persona_mood, persona_speech_style, goal, hidden_facts, expected_flow, difficulty_notes`;

function scenarioParams(s: Scenario): unknown[] {
  return [
    s.id, s.title.es, s.title.en, s.summaryEs, s.difficulty, s.tier, s.category, s.aiRole, s.persona.name,
    s.persona.background, s.persona.mood, s.persona.speechStyle, s.goal, s.hiddenFacts, s.expectedFlow,
    s.difficultyNotes,
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
      `insert into callready.profiles (user_id, email) values ($1, $2)
       on conflict (user_id) do update set email = excluded.email, last_seen_at = now()
       where callready.profiles.email <> excluded.email
          or callready.profiles.last_seen_at < now() - interval '5 minutes'`,
      [userId, email],
    );
  }

  async getProfile(userId: string): Promise<Profile | null> {
    const { rows } = await this.db.query(`select * from callready.profiles where user_id = $1`, [userId]);
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async updateGoalLevel(userId: string, goal: Goal, level: Difficulty): Promise<void> {
    await this.db.query(`update callready.profiles set goal = $2, level = $3 where user_id = $1`, [userId, goal, level]);
  }

  async getSettings(): Promise<Settings> {
    const { rows } = await this.db.query(`select free_daily_limit, pro_instructions_es from callready.settings`);
    const r = rows[0] ?? {};
    return { freeDailyLimit: num(r.free_daily_limit ?? 2), proInstructionsEs: String(r.pro_instructions_es ?? "") };
  }

  async updateSettings(s: Settings): Promise<void> {
    await this.db.query(
      `update callready.settings set free_daily_limit = $1, pro_instructions_es = $2, updated_at = now()`,
      [s.freeDailyLimit, s.proInstructionsEs],
    );
  }

  async listScenarios(): Promise<StoredScenario[]> {
    const { rows } = await this.db.query(`select * from callready.scenarios order by sort_order, id`);
    return rows.map(toScenario);
  }

  async seedScenarios(list: Scenario[]): Promise<number> {
    const { rows } = await this.db.query<{ m: unknown }>(`select coalesce(max(sort_order), -1) as m from callready.scenarios`);
    let order = num(rows[0]?.m) + 1;
    let added = 0;
    for (const s of list) {
      const res = await this.db.query(
        `insert into callready.scenarios (${SCENARIO_COLS}, sort_order)
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
      `insert into callready.scenarios (${SCENARIO_COLS}, enabled, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               (select coalesce(max(sort_order), -1) + 1 from callready.scenarios))
       on conflict (id) do update set
         title_es = excluded.title_es, title_en = excluded.title_en, summary_es = excluded.summary_es,
         difficulty = excluded.difficulty, tier = excluded.tier, category = excluded.category,
         ai_role = excluded.ai_role, persona_name = excluded.persona_name,
         persona_background = excluded.persona_background, persona_mood = excluded.persona_mood,
         persona_speech_style = excluded.persona_speech_style, goal = excluded.goal,
         hidden_facts = excluded.hidden_facts, expected_flow = excluded.expected_flow,
         difficulty_notes = excluded.difficulty_notes, enabled = excluded.enabled, updated_at = now()`,
      [...scenarioParams(s), enabled],
    );
  }

  async setScenarioEnabled(id: string, enabled: boolean): Promise<boolean> {
    const { rows } = await this.db.query(
      `update callready.scenarios set enabled = $2, updated_at = now() where id = $1 returning id`,
      [id, enabled],
    );
    return rows.length > 0;
  }

  async getCall(id: string): Promise<CallRow | null> {
    const { rows } = await this.db.query(`select * from callready.calls where id = $1`, [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      userId: String(r.user_id),
      scenarioId: String(r.scenario_id),
      startedAt: date(r.started_at),
      turns: num(r.turns),
      tokens: num(r.tokens),
      finishedAt: dateOrNull(r.finished_at),
    };
  }

  async createCall(c: { id: string; userId: string; scenarioId: string }): Promise<void> {
    await this.db.query(`insert into callready.calls (id, user_id, scenario_id) values ($1, $2, $3)`, [
      c.id, c.userId, c.scenarioId,
    ]);
  }

  async recordUsage(callId: string, tokens: number, turn: boolean): Promise<void> {
    await this.db.query(
      `update callready.calls set tokens = tokens + $2, turns = turns + $3 where id = $1`,
      [callId, Math.max(0, Math.round(tokens)), turn ? 1 : 0],
    );
  }

  async countCallsSince(userId: string, since: Date): Promise<number> {
    const { rows } = await this.db.query<{ n: unknown }>(
      `select count(*) as n from callready.calls where user_id = $1 and started_at >= $2 and turns > 0`,
      [userId, since],
    );
    return num(rows[0]?.n);
  }

  async saveFeedback(callId: string, durationSec: number, f: FeedbackOutput): Promise<boolean> {
    const s = f.scores;
    const avg = Math.round(((s.fluency + s.grammar + s.vocabulary + s.empathyPoliteness + s.callFlow) / 5) * 10) / 10;
    // One statement, so the call row and its corrections/phrases are written together or not at all.
    const { rows } = await this.db.query<{ n: unknown }>(
      `with c as (
         update callready.calls set finished_at = now(), duration_sec = $2,
           score_fluency = $3, score_grammar = $4, score_vocabulary = $5, score_empathy = $6, score_call_flow = $7,
           avg_score = $8, summary_es = $9
         where id = $1 and finished_at is null
         returning id
       ), corr as (
         insert into callready.call_corrections (call_id, position, said, better, explanation_es)
         select c.id, t.p, t.said, t.better, t.expl
         from c, unnest($10::smallint[], $11::text[], $12::text[], $13::text[]) as t(p, said, better, expl)
       ), phr as (
         insert into callready.call_phrases (call_id, position, phrase, meaning_es, when_to_use_es)
         select c.id, t.p, t.phrase, t.meaning, t.when_to_use
         from c, unnest($14::smallint[], $15::text[], $16::text[], $17::text[]) as t(p, phrase, meaning, when_to_use)
       )
       select count(*) as n from c`,
      [
        callId, Math.max(0, Math.round(durationSec)),
        s.fluency, s.grammar, s.vocabulary, s.empathyPoliteness, s.callFlow, avg, f.overallSummaryEs,
        f.corrections.map((_, i) => i), f.corrections.map((c) => c.said), f.corrections.map((c) => c.better),
        f.corrections.map((c) => c.explanationEs),
        f.phrases.map((_, i) => i), f.phrases.map((p) => p.phrase), f.phrases.map((p) => p.meaningEs),
        f.phrases.map((p) => p.whenToUseEs),
      ],
    );
    return num(rows[0]?.n) > 0;
  }

  async getCallDetail(userId: string, callId: string): Promise<CallDetail | null> {
    const { rows } = await this.db.query(
      `select c.*, s.title_es, s.difficulty from callready.calls c join callready.scenarios s on s.id = c.scenario_id
       where c.id = $1 and c.user_id = $2 and c.finished_at is not null`,
      [callId, userId],
    );
    const r = rows[0];
    if (!r) return null;
    const corr = await this.db.query(
      `select said, better, explanation_es from callready.call_corrections where call_id = $1 order by position`,
      [callId],
    );
    const phr = await this.db.query(
      `select phrase, meaning_es, when_to_use_es from callready.call_phrases where call_id = $1 order by position`,
      [callId],
    );
    return {
      ...toSummary(r),
      feedback: {
        scores: {
          fluency: num(r.score_fluency),
          grammar: num(r.score_grammar),
          vocabulary: num(r.score_vocabulary),
          empathyPoliteness: num(r.score_empathy),
          callFlow: num(r.score_call_flow),
        },
        corrections: corr.rows.map((c) => ({
          said: String(c.said), better: String(c.better), explanationEs: String(c.explanation_es),
        })),
        phrases: phr.rows.map((p) => ({
          phrase: String(p.phrase), meaningEs: String(p.meaning_es), whenToUseEs: String(p.when_to_use_es),
        })),
        overallSummaryEs: String(r.summary_es ?? ""),
      },
    };
  }

  async listCalls(userId: string, limit: number): Promise<CallSummary[]> {
    const { rows } = await this.db.query(
      `select c.id, c.scenario_id, c.started_at, c.duration_sec, c.avg_score, s.title_es, s.difficulty
       from callready.calls c join callready.scenarios s on s.id = c.scenario_id
       where c.user_id = $1 and c.finished_at is not null
       order by c.started_at desc limit $2`,
      [userId, limit],
    );
    return rows.map(toSummary);
  }

  async listUsers(opts: { query: string; limit: number; offset: number }): Promise<{ users: AdminUser[]; total: number }> {
    const { rows } = await this.db.query(
      `select p.user_id, p.email, p.created_at, p.last_seen_at, p.is_pro, p.pro_until,
              count(c.id) filter (where c.turns > 0) as calls,
              coalesce(sum(c.tokens), 0) as tokens,
              max(c.started_at) as last_call_at,
              avg(c.avg_score) as avg_score,
              count(*) over () as total
       from callready.profiles p
       left join callready.calls c on c.user_id = p.user_id
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
        createdAt: date(r.created_at),
        lastSeenAt: date(r.last_seen_at),
        isPro: r.is_pro === true,
        proUntil: dateOrNull(r.pro_until),
        calls: num(r.calls),
        tokens: num(r.tokens),
        lastCallAt: dateOrNull(r.last_call_at),
        avgScore: r.avg_score === null ? null : Math.round(Number(r.avg_score) * 10) / 10,
      })),
    };
  }

  async setPro(userId: string, isPro: boolean, proUntil: Date | null): Promise<boolean> {
    const { rows } = await this.db.query(
      `update callready.profiles set is_pro = $2, pro_until = $3 where user_id = $1 returning user_id`,
      [userId, isPro, isPro ? proUntil : null],
    );
    return rows.length > 0;
  }

  async usageSince(since: Date): Promise<UsageRow[]> {
    const { rows } = await this.db.query(
      `select started_at, user_id, tokens, avg_score from callready.calls
       where started_at >= $1 and turns > 0 order by started_at`,
      [since],
    );
    return rows.map((r) => ({
      startedAt: date(r.started_at),
      userId: String(r.user_id),
      tokens: num(r.tokens),
      avg: numOrNull(r.avg_score),
    }));
  }
}
