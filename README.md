# CallReady (pilot)

Practice English call-center calls by voice. An AI plays the customer (or an HR interviewer), you answer
out loud or by typing, and you get feedback in Spanish with corrected English examples.

- **Web app:** one file, `web/index.html` (Spanish UI, hash routing). Sign-in with Google or an emailed code.
- **Server:** Node + Express + TypeScript in `server/`. It holds the AI key (Anthropic or Google Gemini), checks who is
  signed in, enforces the free/Pro rules and stores everything in Postgres.
- **Accounts and database:** Supabase (free plan). Supabase handles sign-in; the server is the only thing that reads or
  writes the database.
- **Voice:** browser `speechSynthesis` (customer voice) and Web Speech API `SpeechRecognition` (your mic).

```
callready/
├─ index.html                  GitHub Pages entry: redirects to web/
├─ web/index.html              the whole app (learner screens + admin)
└─ server/
   ├─ data/scenarios.json      seed scenarios (copied into the database on startup if missing)
   ├─ .env.example
   └─ src/
      ├─ index.ts, app.ts      startup, routes, CORS, sign-in check
      ├─ handlers.ts           /session/turn and /session/feedback, free/Pro rules
      ├─ account.ts, admin.ts  /me, /calls, /admin/*
      ├─ auth.ts               Supabase token verification
      ├─ db/                   schema, Store interface, Postgres implementation
      ├─ llm/                  Anthropic + Gemini clients, prompts, parsing, Spanish proofreading
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

Open **http://localhost:3000** in Chrome or Edge. Add `http://localhost:3000/` to Supabase's redirect URLs (section 3)
to sign in locally. On startup the server creates its tables (idempotent) and copies in any seed scenario whose id is
not in the database yet.

## 3. Accounts (Supabase)

One-time setup in the Supabase dashboard (free plan):

1. **Create a project.** Pick a region near the users (for Honduras, a US East region). Save the database password.
2. **Keys:** *Project Settings → API Keys*: copy the **Project URL** (`SUPABASE_URL`) and the **Publishable key**
   (`SUPABASE_PUBLISHABLE_KEY`).
3. **Database:** *Connect* → **Session pooler** → copy the URI and put the database password in it (`DATABASE_URL`).
   Use the pooler, not the direct connection: the direct one is IPv6-only and Render cannot reach it.
   Optional: *Database settings → SSL* → download the certificate and paste its text into `DATABASE_SSL_CA`.
4. **Sign-in addresses:** *Authentication → URL Configuration*: Site URL `https://callreadyhn.com/web/`; Redirect URLs
   `https://callreadyhn.com/web/` and `http://localhost:3000/`.
5. **Email code:** *Authentication → Emails → Templates*: in **Magic Link** and **Confirm signup**, put the code in
   the email (Supabase only sends a code when the template contains `{{ .Token }}`):
   ```html
   <h2>Su código de CallReady</h2>
   <p>Escriba este código en la página para entrar:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
   <p>El código vence en una hora. Si usted no lo pidió, puede ignorar este correo.</p>
   ```
   Subject for both: `Su código para entrar a CallReady`.
6. **Google:** in Google Cloud Console create an OAuth client (type *Web application*) with the authorized redirect
   URI `https://<project>.supabase.co/auth/v1/callback`, then paste its client ID and secret into
   *Authentication → Sign In / Providers → Google*.
7. **Email sending (before real users):** Supabase's built-in sender has a very low hourly limit and is for testing.
   Set up a custom SMTP sender (for example Resend's free plan) in *Authentication → Emails → SMTP Settings*.

Data lives in a `callready` schema that Supabase's public Data API does not expose; row level security is also on with
no policies. Tables: `profiles`, `scenarios`, `calls`, `call_corrections`, `call_phrases`, `settings`. Practice
transcripts are not stored, only scores and feedback.

## 4. Online: GitHub Pages + Render

- **Page:** GitHub Pages serves the repo root at **https://callreadyhn.com** (DNS at GoDaddy). The root `index.html`
  redirects to `web/`. https://nesrey.github.io/CallReadyHN/ forwards to the domain.
- **Server:** a Render web service (free plan) built from this repo:
  - Build command: `npm install --include=dev && npm run build -w server`
  - Start command: `npm run start -w server`
  - Health check path: `/health` (shows the deployed commit as `version`)
  - Environment: the AI key, the Supabase/database values from section 3, `HOST=0.0.0.0`,
    `ALLOWED_ORIGINS=https://callreadyhn.com,https://www.callreadyhn.com,https://nesrey.github.io` (Render sets `PORT`)

When the page is on `callreadyhn.com` or `*.github.io` it sends API calls to `API_BASE` near the top of the script in
`web/index.html`; anywhere else (local server) it uses its own site. Pushing to `main` redeploys both.

The free Render plan sleeps after 15 minutes without traffic; the first request after that takes up to a minute
(the page says so while it waits). Free Supabase projects pause after a week with no activity; resume them from the
dashboard.

## 5. Free vs Pro

- **Free:** a daily number of calls (default 2, set in the admin page) on scenarios marked *Gratis*.
- **Pro:** no daily limit and every scenario, until an optional end date.
- The server enforces both; the page only explains a refusal. A call counts toward the daily limit once the AI has
  answered, so a call that fails to start does not use one up. Days start at midnight in `TIMEZONE`.
- Payments are manual for now: learners pay as the *Cómo activar Pro* text on the Pro page says (editable in the admin
  page), and an admin turns Pro on for them.

## 6. Admin page

`https://callreadyhn.com/web/#/admin`, visible in **Ajustes** only for `ADMIN_EMAILS`:

- **Usuarios:** search by email; signup, last activity, calls, average score, AI tokens; give Pro (optionally until a
  date, inclusive) or remove it.
- **Uso:** calls, active users, AI tokens and average score per day for the last 7/30/90 days.
- **Escenarios:** add, edit, turn on/off. Every save runs the same validation as the seed file. Ids cannot change.
- **Ajustes:** free calls per day and the *Cómo activar Pro* text.

## 7. Voice: what works where

- **Chrome and Edge** (desktop and Android) support speech recognition. Firefox does not; Safari is unreliable.
  Without recognition the page still works: the text box is always visible.
- Chrome sends your audio to Google for recognition, so it needs internet.
- **The microphone only works on `https://` pages or `localhost`.** For phones, use the live site or an HTTPS tunnel
  (`cloudflared tunnel --url http://localhost:3000`) and add the tunnel address to Supabase's redirect URLs.
- Recognition is set to `en-US`. Accented speech may be transcribed imperfectly; the grader is told to ignore
  likely recognition errors, and the user can type instead.

## 8. Tests

```bash
npm test          # 108 tests
npm run typecheck
```

Tests use Node's built-in runner, a mocked model and a fake sign-in, so they need no keys and make no network calls.
Database tests run the real SQL on PGlite (Postgres compiled to WebAssembly, in memory). The page's pure logic
(streak, daily limit, scoring, sorting) sits between `LOGIC:START` and `LOGIC:END` in `web/index.html`, and
`web-logic.test.ts` loads it from there.

## 9. API

Errors look like `{ "error": { "code": "…", "message": "…" } }`. Signed-in routes need
`Authorization: Bearer <Supabase access token>`.

Public:
- `GET /health`, `GET /config` (Supabase URL and publishable key for the page), `GET /scenarios` (enabled scenarios).

Signed in:
- `GET /me`: email, goal, level, `isPro`, `proUntil`, `isAdmin`, `callsToday`, `freeDailyLimit`, `proInstructionsEs`,
  `timeZone`. `PUT /me` with `{ goal: "job"|"improve", level: "A2"|"B1"|"B2" }`.
- `POST /session/turn` with `{ sessionId: <uuid>, scenarioId, history }` returns `{ line, callEnded, turnNumber, usage }`.
  The first turn (`history: []`) creates the call with that id after checking the plan (`403 pro_required`,
  `403 daily_limit`). The server decides when the call may end: never before `MIN_TURNS`, always by `MAX_TURNS`.
- `POST /session/feedback` with the same body returns `callId`, `scores` (1-10), 3 `corrections`, 3 `phrases` and
  `overallSummaryEs`, and saves them. Asking again returns the saved copy. `422 not_enough_speech` if the learner said
  fewer than 2 real lines.
- `GET /calls` (history), `GET /calls/:id` (one call with its feedback).

Admin (`403 forbidden` for others): `GET /admin/users?q=&offset=`, `POST /admin/users/:id/pro`
`{ isPro, proUntil?: "YYYY-MM-DD" }`, `GET /admin/usage?days=`, `GET /admin/scenarios`,
`PUT /admin/scenarios/:id` `{ scenario, enabled }`, `POST /admin/scenarios/:id/enabled` `{ enabled }`,
`GET|PUT /admin/settings` `{ freeDailyLimit, proInstructionsEs }`.

Model output must be valid JSON; if it is not, the server retries once with the error fed back, then returns
`502 llm_bad_output`. Feedback whose Spanish has missing accents, missing ¿/¡ or tú/vos forms gets one focused
proofreading request; the version with fewer problems is kept. Other codes: `unauthorized`, `invalid_request`,
`unknown_scenario`, `not_found`, `call_over`, `rate_limited`, `session_token_cap`, `llm_unavailable`, `llm_busy`.

## 10. Scenarios

The database is the source of truth; edit them in the admin page. `server/data/scenarios.json` only seeds scenarios
whose id is not in the database yet (new installs, or new entries added to the file later); it never overwrites
admin edits. Fields: `id`, `title {es,en}`, `summaryEs`, `difficulty` (`A2|B1|B2`), `category`
(`support|sales|interview`), `persona {name, background, mood, speechStyle}`, `goal`, `hiddenFacts`, `expectedFlow`
(3+ stages); optional `tier` (defaults to `pro` for B2 and interviews), `aiRole` (`customer|interviewer`),
`difficultyNotes`. The grader scores call-flow compliance against `expectedFlow`.

## Known pilot limitations

- Rate limits are in memory and reset when the server restarts (per-call token totals are in the database).
- Payments are manual.
- Spanish proofreading catches common errors from a word list; it is not a full spell checker.
- The page loads two fonts from Google Fonts and the Supabase library from jsDelivr.

## Troubleshooting

- **"Startup failed: … is missing"**: set that value in `server/.env` or in Render → Environment.
- **"Startup failed" with a database error**: check `DATABASE_URL` uses the Session pooler host and the right password.
- **Sign-in returns to the login page with an error**: the page address is not in Supabase's Redirect URLs.
- **No code in the email, only a link**: the email template does not contain `{{ .Token }}` (section 3, step 5).
- **"Se pidieron demasiados códigos"**: Supabase's email limit; wait, or set up custom SMTP.
- **`llm_busy` on Gemini**: the free tier's per-minute or daily limit was hit; wait, or switch to a paid key.
- **Mic button is greyed out**: not HTTPS/localhost, unsupported browser, or the model is still talking/answering.
- **`llm_unavailable`**: check the server log (upstream errors are logged there, never sent to the browser), the key
  and the model name.
