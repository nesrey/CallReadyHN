# CallReady

Call-handling practice for people who already speak English: bilingual call-center agents and job seekers. An AI
caller phones in (calm, demanding or furious), you handle the call by voice or typing using an agent desk with the
customer's account and the company's policies, and you get a QA scorecard like a quality team would give you.

- **Site:** `index.html` (landing page) and `privacy.html` at the repo root, served by GitHub Pages at
  https://callreadyhn.com.
- **App:** one file, `app/index.html` (English UI, hash routing), at https://callreadyhn.com/app/. Sign-in with Google
  or an emailed code. `web/` only forwards old links to `app/` and `privacy.html`.
- **Server:** Node + Express + TypeScript in `server/`. It holds the AI key (Anthropic or Google Gemini), checks who is
  signed in, enforces the free/Pro rules and stores everything in Postgres.
- **Accounts and database:** Supabase (free plan). Supabase handles sign-in; the server is the only thing that reads or
  writes the database.
- **Voice:** browser `speechSynthesis` (caller voice) and Web Speech API `SpeechRecognition` (your mic).

```
callready/
├─ index.html, privacy.html    landing page and privacy policy
├─ app/index.html              the whole app (learner screens + admin)
├─ web/                        redirects from the old /web/ addresses
└─ server/
   ├─ data/scenarios.json      seed scenarios (copied into the database on startup if missing)
   ├─ .env.example
   └─ src/
      ├─ index.ts, app.ts      startup, routes, CORS, sign-in check
      ├─ handlers.ts           /session/turn and /session/feedback, free/Pro rules
      ├─ account.ts, admin.ts  /me, /calls, /admin/*
      ├─ auth.ts               Supabase token verification
      ├─ db/                   schema, Store interface, Postgres implementation
      ├─ llm/                  Anthropic + Gemini clients, prompts, QA rubric, parsing
      ├─ scenarios/            validation and the in-memory catalog
      ├─ time.ts               "today" in the configured time zone, usage by day
      └─ __tests__/
```

## 1. Setup

Requires Node 20.12 or newer.

```bash
npm install
cp server/.env.example server/.env
```

Fill in `server/.env` (git-ignored; nothing in it is ever sent to the browser except the Supabase URL and
publishable key, which are public by design). The server refuses to start if a required value is missing.

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | | One AI key is required. Gemini has a free tier (https://aistudio.google.com/apikey) |
| `GEMINI_MODEL` / `ANTHROPIC_MODEL` | `gemini-3.5-flash-lite` / `claude-haiku-5-5` | Model for the customer and the grader |
| `LLM_PROVIDER` | (auto) | `anthropic` or `gemini`; by default whichever key is set, Anthropic if both |
| `SUPABASE_URL` | (required) | `https://<project>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | (required) | `sb_publishable_…` (the legacy `SUPABASE_ANON_KEY` also works) |
| `DATABASE_URL` | (required) | Supabase **Session pooler** connection string (see section 3) |
| `DATABASE_SSL_CA` | | Supabase's root certificate (PEM text). When set, the database certificate is verified |
| `SUPABASE_JWT_SECRET` | | Only for older Supabase projects that still sign tokens with a shared secret |
| `ADMIN_EMAILS` | `nesrey@gmail.com` | Comma-separated emails that may open the admin page |
| `TIMEZONE` | `America/Tegucigalpa` | Where "today" starts for the free daily limit and the usage view |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Use `HOST=0.0.0.0` on Render |
| `ALLOWED_ORIGINS` | (empty) | Sites allowed to call the API from a browser, e.g. `https://callreadyhn.com` |
| `SESSION_TOKEN_CAP` / `FEEDBACK_TOKEN_RESERVE` | `20000` / `4000` | Max AI tokens per call; part kept back so feedback always fits |
| `RATE_TURN_MAX` / `RATE_TURN_WINDOW_SEC` | `40` / `600` | Turn requests per account per window |
| `RATE_FEEDBACK_MAX` / `RATE_FEEDBACK_WINDOW_SEC` | `6` / `600` | Feedback requests per account per window |
| `MIN_TURNS` / `MAX_TURNS` | `6` / `10` | Call length in customer turns |

On Gemini's free tier Google may use the prompts (the practice-call transcripts) to improve its products, and the
daily limits are low. Fine for a small pilot; tell testers not to share real personal details on calls.

## 2. Run

```bash
npm run dev      # auto-reloads, from the repo root
# or
npm start        # builds, then runs compiled code
```

Open **http://localhost:3000/app/** in Chrome or Edge. Add `http://localhost:3000/app/` to Supabase's redirect URLs
(section 3) to sign in locally. On startup the server creates its tables (idempotent) and copies in any seed scenario whose id is
not in the database yet.

## 3. Accounts (Supabase)

One-time setup in the Supabase dashboard (free plan):

1. **Create a project.** Pick a region near the users (for Honduras, a US East region). Save the database password.
2. **Keys:** *Project Settings → API Keys*: copy the **Project URL** (`SUPABASE_URL`) and the **Publishable key**
   (`SUPABASE_PUBLISHABLE_KEY`).
3. **Database:** *Connect* → **Session pooler** → copy the URI and put the database password in it (`DATABASE_URL`).
   Use the pooler, not the direct connection: the direct one is IPv6-only and Render cannot reach it.
   Optional: *Database settings → SSL* → download the certificate and paste its text into `DATABASE_SSL_CA`.
4. **Sign-in addresses:** *Authentication → URL Configuration*: Site URL `https://callreadyhn.com/app/`; Redirect URLs
   `https://callreadyhn.com/app/` and `http://localhost:3000/app/`.
5. **Email sending:** Supabase's built-in sender has a very low hourly limit, and it must be replaced before the
   templates can be edited. Set up a custom SMTP sender (we use Resend from `noreply@callreadyhn.com`) in
   *Authentication → Emails → SMTP Settings*.
6. **Email code:** *Authentication → Emails → Templates*: in **Magic Link** and **Confirm signup**, put the code in
   the email (Supabase only sends a code when the template contains `{{ .Token }}`):
   ```html
   <h2>Your CallReady code</h2>
   <p>Enter this code on the sign-in page:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
   <p>The code expires in one hour. If you didn't ask for it, you can ignore this email.</p>
   ```
   Subject for both: `Your CallReady sign-in code`.
7. **Google:** in Google Cloud Console create an OAuth client (type *Web application*) with the authorized redirect
   URI `https://<project>.supabase.co/auth/v1/callback`, then paste its client ID and secret into
   *Authentication → Sign In / Providers → Google*. The consent screen's privacy link is
   `https://callreadyhn.com/privacy.html`.

Data lives in the `callready_v2` schema, which Supabase's public Data API does not expose; row level security is also
on with no policies. Tables: `profiles`, `scenarios`, `calls`, `call_criteria`, `call_strengths`, `call_moments`,
`call_phrases`, `call_turns` (the transcript), `settings`. On first start the server copies accounts (Pro status) and
the free daily limit from the version 1 `callready` schema; version 1 calls stay there and are no longer shown.

## 4. Online: GitHub Pages + Render

- **Site:** GitHub Pages serves the repo root at **https://callreadyhn.com** (DNS at GoDaddy).
  https://nesrey.github.io/CallReadyHN/ forwards to the domain.
- **Server:** a Render web service (free plan) built from this repo, with **Auto-Deploy: On Commit**:
  - Build command: `npm install --include=dev && npm run build -w server`
  - Start command: `npm run start -w server`
  - Health check path: `/health` (shows the deployed commit as `version`)
  - Environment: the AI key, the Supabase/database values from section 3, `HOST=0.0.0.0`,
    `ALLOWED_ORIGINS=https://callreadyhn.com,https://www.callreadyhn.com,https://nesrey.github.io` (Render sets `PORT`)

When the app is on `callreadyhn.com` or `*.github.io` it sends API calls to `API_BASE` near the top of the script in
`app/index.html`; anywhere else (local server) it uses its own site. Pushing to `main` redeploys both. Locally the
server serves the landing page, the privacy page, `app/` and `web/`, and nothing else from the repo.

The free Render plan sleeps after 15 minutes without traffic; the first request after that takes up to a minute
(the app says so while it waits). Free Supabase projects pause after a week with no activity; resume them from the
dashboard.

## 5. How a call works

1. The learner picks a scenario. Its agent desk (customer account and policies) is visible during the call: a side
   panel on wide screens, a pull-up sheet on phones.
2. The learner **answers first** with their greeting, as on a real inbound line. That first message creates the call
   (after the plan checks).
3. The caller speaks natural English at normal pace; the temperament (calm, demanding, furious) drives how they push
   back and when they calm down. The server decides when the call may end: never before `MIN_TURNS` caller turns,
   always by `MAX_TURNS`.
4. Feedback is a **QA scorecard**: 8 weighted criteria scored 0-10 (opening 10, verification 10, active listening 10,
   empathy & tone 15, call control 15, resolution 20, professional language 10, closing 10; interviews use their own
   6), each with a quote from the call and a tip, plus 2 strengths, 3 coaching moments (said / better / why), 3 power
   phrases and a summary. The grader sees the account, the policies and the caller-only facts, so resolution is judged
   against policy. The 0-100 QA score is computed by the server from the weights, never by the model.
5. The scorecard and the transcript are saved; the results page replays the call with the coaching moments
   highlighted.

## 6. Free vs Pro

- **Free:** a daily number of calls (default 2, set in the admin page) on scenarios marked *Free* (by default the
  calm caller of each call type).
- **Pro:** no daily limit and every scenario (demanding and furious callers, the interview), until an optional end date.
- The server enforces both; the app only explains a refusal. A call counts toward the daily limit once the AI has
  answered, so a call that fails to start does not use one up. Days start at midnight in `TIMEZONE`.
- Payments are manual for now: learners follow the *How to get Pro* text on the Pro page (editable in the admin page),
  and an admin turns Pro on for them. The landing page says "Contact us" for Pro.

## 7. Admin page

`https://callreadyhn.com/app/#/admin`, where admins land after signing in (only `ADMIN_EMAILS`):

- **Users:** search by email; role, signup, last activity, calls, average QA, AI tokens; give Pro (optionally until a
  date, inclusive) or remove it.
- **Usage:** calls, active users, AI tokens and average QA per day for the last 7/30/90 days.
- **Scenarios:** add, edit, turn on/off, including the agent desk (one `Label: Value` per line) and the policies. Every
  save runs the same validation as the seed file. IDs cannot change.
- **Settings:** free calls per day and the *How to get Pro* text.

## 8. Voice: what works where

- **Chrome and Edge** (desktop and Android) support speech recognition. Firefox does not; Safari is unreliable.
  Without recognition the app still works: the text box is always visible.
- Chrome sends your audio to Google for recognition, so it needs internet.
- **The microphone only works on `https://` pages or `localhost`.** For phones, use the live site or an HTTPS tunnel
  (`cloudflared tunnel --url http://localhost:3000`) and add the tunnel address to Supabase's redirect URLs.

## 9. Tests

```bash
npm test          # 97 tests
npm run typecheck
```

Tests use Node's built-in runner, a mocked model and a fake sign-in, so they need no keys and make no network calls.
Database tests run the real SQL on PGlite (Postgres compiled to WebAssembly, in memory), including the carry-over from
version 1. The app's pure logic (streak, daily limit, ordering, verdict, transcript highlighting) sits between
`LOGIC:START` and `LOGIC:END` in `app/index.html`, and `web-logic.test.ts` loads it from there.

## 10. API

Errors look like `{ "error": { "code": "…", "message": "…" } }`. Signed-in routes need
`Authorization: Bearer <Supabase access token>`.

Public:
- `GET /health`, `GET /config` (Supabase URL and publishable key for the app), `GET /scenarios` (enabled scenarios,
  with the agent desk: account and policies; never the caller-only facts).

Signed in:
- `GET /me`: email, `role`, `interests`, `isPro`, `proUntil`, `isAdmin`, `callsToday`, `freeDailyLimit`,
  `proInstructions`, `timeZone`. `PUT /me` with `{ role: "job_seeker"|"agent"|"trainer", interests: [call types] }`.
- `POST /session/turn` with `{ sessionId: <uuid>, scenarioId, history }` returns `{ line, callEnded, turnNumber, usage }`.
  `history` must start with the agent's line and end with one. The first turn creates the call with that id after
  checking the plan (`403 pro_required`, `403 daily_limit`).
- `POST /session/feedback` with the same body returns `callId`, `qaScore`, `criteria` (key, label, weight, score,
  evidence, tip), `strengths`, `moments`, `phrases` and `summary`, and saves them with the transcript. Asking again
  returns the saved copy. `422 not_enough_speech` with fewer than 3 real agent lines.
- `GET /calls` (history and per-criterion `skills` averages), `GET /calls/:id` (one call with its scorecard and
  transcript).

Admin (`403 forbidden` for others): `GET /admin/users?q=&offset=`, `POST /admin/users/:id/pro`
`{ isPro, proUntil?: "YYYY-MM-DD" }`, `GET /admin/usage?days=`, `GET /admin/scenarios`,
`PUT /admin/scenarios/:id` `{ scenario, enabled }`, `POST /admin/scenarios/:id/enabled` `{ enabled }`,
`GET|PUT /admin/settings` `{ freeDailyLimit, proInstructions }`.

Model output must be valid JSON; if it is not, the server retries once with the error fed back, then returns
`502 llm_bad_output`. Other codes: `unauthorized`, `invalid_request`, `unknown_scenario`, `not_found`, `call_over`,
`rate_limited`, `session_token_cap`, `llm_unavailable`, `llm_busy`.

## 11. Scenarios

The database is the source of truth; edit them in the admin page. `server/data/scenarios.json` only seeds scenarios
whose id is not in the database yet; it never overwrites admin edits. The seed has 3 scenarios per call type (calm,
demanding, furious) plus the interview. Fields: `id`, `title`, `summary`, `callType`
(`service|tech|sales|collections|interview`), `temperament` (`calm|demanding|furious`), `company` (fictional),
`persona {name, background, speechStyle}`, `goal`, `account` (`[{label, value}]`, 2+), `policies` (1+),
`hiddenFacts` (what only the caller knows, including verification details); optional `tier` (defaults to `free` for
calm non-interview calls) and `behaviorNotes`.

## Known pilot limitations

- Rate limits are in memory and reset when the server restarts (per-call token totals are in the database).
- Payments are manual; the landing page says "Contact us" for Pro and "2 calls a day" for Free (update it by hand if
  the free limit changes).
- The caller voice is the browser's built-in speech; quality depends on the device.
- The pages load fonts from Google Fonts and the Supabase library from jsDelivr.

## Troubleshooting

- **"Startup failed: … is missing"**: set that value in `server/.env` or in Render → Environment.
- **"Startup failed" with a database error**: check `DATABASE_URL` uses the Session pooler host and the right password.
- **Sign-in returns to the login page with an error**: the page address is not in Supabase's Redirect URLs.
- **No code in the email, only a link**: the email template does not contain `{{ .Token }}` (section 3, step 6).
- **"Too many codes were requested"**: the email provider's limit; wait a minute.
- **A push to `main` did not go live**: check `/health` → `version`, and Render → Events; Auto-Deploy must be on.
- **`llm_busy` on Gemini**: the free tier's per-minute or daily limit was hit; wait, or switch to a paid key.
- **Mic button is greyed out**: not HTTPS/localhost, unsupported browser, or the caller is still talking.
- **`llm_unavailable`**: check the server log (upstream errors are logged there, never sent to the browser), the key
  and the model name.
