# CallReady (pilot)

Practice English call-center calls by voice. An AI plays the customer (or an HR interviewer), you answer
out loud or by typing, and you get feedback in Spanish with corrected English examples.

- **Web app:** one file, `web/index.html` (Spanish UI, hash routing, `localStorage`).
- **Server:** Node + Express + TypeScript in `server/`. It serves the page and holds the AI API key (Anthropic or Google Gemini).
- **Voice:** browser `speechSynthesis` (customer voice) and Web Speech API `SpeechRecognition` (your mic).

```
callready/
├─ web/index.html              the whole app
└─ server/
   ├─ data/scenarios.json      the 6 seed scenarios (add more here)
   ├─ .env.example
   └─ src/
      ├─ app.ts, index.ts      Express wiring + startup
      ├─ handlers.ts           /session/turn and /session/feedback logic
      ├─ llm/ (client, prompts, parse)
      ├─ limits.ts             per-device rate limit + per-session token cap
      ├─ scenarios/load.ts     schema validation
      └─ __tests__/
```

## 1. Setup

Requires Node 20.12 or newer.

```bash
npm install
cp server/.env.example server/.env
```

Edit `server/.env` and set **one** AI key: `ANTHROPIC_API_KEY` (Claude, paid) or `GEMINI_API_KEY` (Google, has a free
tier; get it at https://aistudio.google.com/apikey). The key lives only in this file (it is git-ignored) and is never
sent to the browser. The server refuses to start without one.

On Gemini's free tier Google may use the prompts (the practice-call transcripts) to improve its products, and the
daily limits are low. Fine for a small pilot; tell testers not to share real personal details on calls.

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | | Claude key (one of the two keys is required) |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | Claude model for customer and grader |
| `GEMINI_API_KEY` | | Google Gemini key |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Gemini model for customer and grader |
| `LLM_PROVIDER` | (auto) | `anthropic` or `gemini`; by default whichever key is set, Anthropic if both |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Use `HOST=0.0.0.0` only if you need other devices on your network |
| `SESSION_TOKEN_CAP` | `20000` | Max tokens (input + output) per call, including feedback |
| `FEEDBACK_TOKEN_RESERVE` | `4000` | Kept back so a call can always get its feedback |
| `RATE_TURN_MAX` / `RATE_TURN_WINDOW_SEC` | `40` / `600` | Turn requests per device per window |
| `RATE_FEEDBACK_MAX` / `RATE_FEEDBACK_WINDOW_SEC` | `6` / `600` | Feedback requests per device per window |
| `MIN_TURNS` / `MAX_TURNS` | `6` / `10` | Call length in customer turns |
| `ALLOWED_ORIGINS` | (empty) | Other sites allowed to call the API from a browser, e.g. `https://nesrey.github.io` |

## 2. Run

```bash
npm run dev      # auto-reloads, from the repo root
# or
npm start        # builds, then runs compiled code
```

Open **http://localhost:3000** in Chrome or Edge.

## 3. Online: GitHub Pages + Render

The live pilot runs in two pieces:

- **Page:** GitHub Pages serves the repo root. `index.html` at the root redirects to `web/`, so
  https://nesrey.github.io/CallReadyHN/ opens the app.
- **Server:** a Render web service (free plan) built from this repo:
  - Build command: `npm install --include=dev && npm run build -w server`
  - Start command: `npm run start -w server`
  - Health check path: `/health`
  - Environment: `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`), `HOST=0.0.0.0`, `ALLOWED_ORIGINS=https://nesrey.github.io` (Render sets `PORT`)

When the page is on `*.github.io` it sends API calls to the address in `API_BASE` near the top of the script in
`web/index.html`; everywhere else (local server) it uses its own site. Pushing to `main` redeploys both.

The free Render plan sleeps after 15 minutes without traffic; the first request after that takes up to a minute
(the page says so while it waits). Anyone with the link can run calls on your API credits, within the limits above.

## 4. Voice: what works where

- **Chrome and Edge** (desktop and Android) support speech recognition. Firefox does not; Safari is unreliable.
  Without recognition the page still works: the text box is always visible.
- Chrome sends your audio to Google for recognition, so it needs internet.
- **The microphone only works on `https://` pages or `localhost`.** Opening `http://192.168.x.x:3000` from a
  phone will load the page but the mic stays disabled (the page tells the user). Use a tunnel for phones.
- Recognition is set to `en-US`. Accented speech may be transcribed imperfectly; the grader is told to ignore
  likely recognition errors, and the user can type instead.
- Voice quality depends on the voices installed on the device.

### Testing on a phone (HTTPS tunnel)

Run the server, then in another terminal use any HTTPS tunnel, for example:

```bash
cloudflared tunnel --url http://localhost:3000
# or
ngrok http 3000
```

Open the `https://…` address it prints on the phone. The page and API share one origin, so there is no CORS setup.
Anyone with the link can use the app (and spend your API credits, within the limits above), so share it only with
pilot testers and stop the tunnel when you are done.

## 5. Tests

```bash
npm test          # 88 tests: scenarios, parsing/retry, limits, handlers, prompts, CORS, Gemini, Spanish spelling, web logic
npm run typecheck
```

Tests use Node's built-in runner and a mocked model, so they need no API key and make no network calls.
The web app's pure logic (streak, daily limit, scoring, sorting) sits between `LOGIC:START` and `LOGIC:END`
markers in `index.html`, and `web-logic.test.ts` loads it from there.

## 6. API

All `/session/*` calls need an `X-Device-Id: <uuid>` header (the page generates and stores one; no login).
Errors look like `{ "error": { "code": "…", "message": "…" } }`.

- `GET /scenarios` returns the scenario summaries (id, titles, difficulty, tier, persona name).
- `POST /session/turn` with `{ sessionId, scenarioId, history }` returns `{ line, callEnded, turnNumber, usage }`.
  `history` is `[{ role: "customer" | "agent", text }]`; send `[]` and the AI opens the call. The server decides
  when the call may end: never before turn `MIN_TURNS`, always by `MAX_TURNS`.
- `POST /session/feedback` with the same body returns `scores` (1-10: fluency, grammar, vocabulary,
  empathyPoliteness, callFlow), exactly 3 `corrections` (`said`, `better`, `explanationEs`), exactly 3 `phrases`,
  and `overallSummaryEs`. It returns `422 not_enough_speech` if the learner said fewer than 2 real lines.

Model output must be valid JSON; if it is not, the server retries once with the error fed back, then returns
`502 llm_bad_output`. Error codes: `invalid_request`, `unknown_scenario`, `call_over`, `rate_limited`,
`session_token_cap`, `not_enough_speech`, `llm_unavailable`, `llm_busy` (provider quota hit), `llm_bad_output`.

## 7. Adding scenarios

Append an object to `server/data/scenarios.json` and restart. The server validates every scenario at startup and
fails with a clear message on unknown fields, duplicate ids, or missing data. Required: `id`, `title {es,en}`,
`summaryEs`, `difficulty` (`A2|B1|B2`), `category` (`support|sales|interview`), `persona`, `goal`, `hiddenFacts`,
`expectedFlow` (3+ stages). Optional: `tier` (defaults to `pro` for B2 and interviews), `aiRole`
(`customer|interviewer`), `difficultyNotes`. The grader scores call-flow compliance against `expectedFlow`.

## 8. Free vs Pro (stub)

Free: 2 calls per day, A2/B1 scenarios. Pro: unlimited calls, B2 and interview scenarios. There is no payment;
`isPro` is one flag in `localStorage`, toggled in **Ajustes → Opciones de desarrollo**. The daily limit is enforced
in the browser only, so a user can bypass it by clearing site data. That is fine for a pilot, not for launch.

## 9. Known pilot limitations

- Device id is a random UUID in `localStorage`; it is spoofable. Rate limits and token caps are in memory and reset
  when the server restarts.
- History lives only in the browser; clearing site data erases it.
- The page loads two fonts from Google Fonts and falls back to system fonts if offline.

## Troubleshooting

- **"Startup failed: No API key found"**: create `server/.env` from the example, or add the key in Render → Environment.
- **`llm_busy` errors on Gemini**: the free tier's per-minute or daily limit was hit; wait, or switch to a paid key.
- **Mic button is greyed out**: not HTTPS/localhost, unsupported browser, or the model is still talking/answering.
- **"El navegador no tiene permiso…"**: allow the microphone from the padlock in the address bar.
- **Customer voice sounds robotic or is missing**: install an English voice in the OS or browser settings.
- **`llm_unavailable` errors**: check the server log (upstream errors are logged there, never sent to the browser),
  your API key, and the model name (`ANTHROPIC_MODEL` / `GEMINI_MODEL`).
