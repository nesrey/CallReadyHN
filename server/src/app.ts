import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { getMe, getMyCall, isAdmin, listMyCalls, updateMe } from "./account.js";
import {
  adminGetSettings, adminListScenarios, adminListUsers, adminOverview, adminSaveScenario, adminSaveSettings, adminSetPro,
  adminSetScenarioEnabled, adminUsage,
} from "./admin.js";
import type { Auth, AuthUser } from "./auth.js";
import { ApiError } from "./errors.js";
import { handleFeedback, handleTurn, type Deps } from "./handlers.js";
import { RateLimiter } from "./limits.js";
import { toSummary } from "./scenarios/load.js";

export interface AppDeps extends Deps {
  auth: Auth;
  /** Handed to the page so it can sign people in. Both values are public by design. */
  publicConfig: { supabaseUrl: string; supabaseKey: string };
}

type Handler = (req: Request, res: Response) => Promise<unknown>;
/** Run an async handler and send its result as JSON; errors go to the error middleware. */
const json = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).then((out) => res.json(out), next);
};
const userOf = (res: Response) => res.locals.user as AuthUser;

/** siteDir is the repo root; only the site's own pages are served from it, never the rest of the repo. */
export function createApp(deps: AppDeps, opts: { siteDir: string }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  // CORS for the page when it is hosted elsewhere (GitHub Pages). Same-origin use needs none of this.
  const allowed = new Set(deps.config.allowedOrigins);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("origin");
    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Expose-Headers", "Retry-After");
      res.append("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res.setHeader("Access-Control-Max-Age", "600");
        res.status(204).end();
        return;
      }
    }
    next();
  });

  const turnLimiter = new RateLimiter(deps.config.turnRate.max, deps.config.turnRate.windowMs);
  const feedbackLimiter = new RateLimiter(deps.config.feedbackRate.max, deps.config.feedbackRate.windowMs);
  const generalLimiter = new RateLimiter(240, 10 * 60 * 1000);

  /** Signed-in learners only. Creates the profile on first use. */
  const requireUser = (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    deps.auth
      .verify(token)
      .then(async (user) => {
        await deps.store.touchProfile(user.userId, user.email);
        res.locals.user = user;
        next();
      })
      .catch(next);
  };

  const requireAdmin = (_req: Request, res: Response, next: NextFunction) => {
    isAdmin(deps, userOf(res))
      .then((ok) => next(ok ? undefined : new ApiError(403, "forbidden", "Admins only.")))
      .catch(next);
  };

  const limit = (limiter: RateLimiter) => (_req: Request, res: Response, next: NextFunction) => {
    const r = limiter.check(userOf(res).userId);
    if (!r.allowed) {
      res.setHeader("Retry-After", String(r.retryAfterSec));
      return next(new ApiError(429, "rate_limited", "Too many requests.", r.retryAfterSec));
    }
    next();
  };

  app.get("/health", (_req: Request, res: Response) => {
    // Render sets RENDER_GIT_COMMIT; it shows which commit is live after a deploy.
    res.json({ ok: true, version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "local" });
  });

  app.get("/config", (_req: Request, res: Response) => {
    res.json(deps.publicConfig);
  });

  app.get("/scenarios", (_req: Request, res: Response) => {
    res.json({ scenarios: deps.catalog.enabled().map(toSummary) });
  });

  const user = [requireUser, limit(generalLimiter)];
  app.get("/me", ...user, json((_req, res) => getMe(deps, userOf(res))));
  app.put("/me", ...user, json((req, res) => updateMe(deps, userOf(res), req.body)));
  app.get("/calls", ...user, json((_req, res) => listMyCalls(deps, userOf(res))));
  app.get("/calls/:id", ...user, json((req, res) => getMyCall(deps, userOf(res), String(req.params.id))));

  app.post("/session/turn", requireUser, limit(turnLimiter), json((req, res) => handleTurn(deps, userOf(res), req.body)));
  app.post(
    "/session/feedback",
    requireUser,
    limit(feedbackLimiter),
    json((req, res) => handleFeedback(deps, userOf(res), req.body)),
  );

  const admin = [requireUser, limit(generalLimiter), requireAdmin];
  app.get("/admin/users", ...admin, json((req) => adminListUsers(deps, req.query as Record<string, unknown>)));
  app.post("/admin/users/:id/pro", ...admin, json((req) => adminSetPro(deps, String(req.params.id), req.body)));
  app.get("/admin/overview", ...admin, json(() => adminOverview(deps)));
  app.get("/admin/usage", ...admin, json((req) => adminUsage(deps, req.query as Record<string, unknown>)));
  app.get("/admin/scenarios", ...admin, json(async () => adminListScenarios(deps)));
  app.put("/admin/scenarios/:id", ...admin, json((req) => adminSaveScenario(deps, String(req.params.id), req.body)));
  app.post(
    "/admin/scenarios/:id/enabled",
    ...admin,
    json((req) => adminSetScenarioEnabled(deps, String(req.params.id), req.body)),
  );
  app.get("/admin/settings", ...admin, json(() => adminGetSettings(deps)));
  app.put("/admin/settings", ...admin, json((req) => adminSaveSettings(deps, req.body)));

  // The live site is GitHub Pages; this serves the same pages for local development.
  const page = (file: string) => (_req: Request, res: Response) => res.sendFile(join(opts.siteDir, file));
  app.get(["/", "/index.html"], page("index.html"));
  app.get("/privacy.html", page("privacy.html"));
  app.use("/app", express.static(join(opts.siteDir, "app")));
  app.use("/web", express.static(join(opts.siteDir, "web")));

  app.use((_req: Request, _res: Response, next: NextFunction) => next(new ApiError(404, "not_found", "Not found.")));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      if (err.retryAfterSec) res.setHeader("Retry-After", String(err.retryAfterSec));
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    const type = (err as { type?: string } | null)?.type;
    if (type === "entity.parse.failed" || type === "entity.too.large") {
      res.status(400).json({ error: { code: "invalid_request", message: "Invalid JSON body." } });
      return;
    }
    console.error("Unhandled error:", err);
    res.status(500).json({ error: { code: "internal", message: "Unexpected server error." } });
  });

  return app;
}
