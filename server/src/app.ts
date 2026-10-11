import express, { type NextFunction, type Request, type Response } from "express";
import { ApiError } from "./errors.js";
import { handleFeedback, handleTurn, type Deps } from "./handlers.js";
import { RateLimiter } from "./limits.js";
import { toSummary } from "./scenarios/load.js";
import { isDeviceId } from "./validate.js";

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

export function createApp(deps: Deps, opts: { webDir: string }) {
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
        res.setHeader("Access-Control-Allow-Methods", "GET, POST");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Device-Id");
        res.setHeader("Access-Control-Max-Age", "600");
        res.status(204).end();
        return;
      }
    }
    next();
  });

  const turnLimiter = new RateLimiter(deps.config.turnRate.max, deps.config.turnRate.windowMs);
  const feedbackLimiter = new RateLimiter(deps.config.feedbackRate.max, deps.config.feedbackRate.windowMs);

  const requireDevice = (req: Request, res: Response, next: NextFunction) => {
    const id = req.header("x-device-id");
    if (!isDeviceId(id)) {
      return next(new ApiError(400, "invalid_request", "X-Device-Id header must be a UUID."));
    }
    res.locals.deviceId = id.toLowerCase();
    next();
  };

  const limit = (limiter: RateLimiter) => (_req: Request, res: Response, next: NextFunction) => {
    const r = limiter.check(res.locals.deviceId as string);
    if (!r.allowed) {
      res.setHeader("Retry-After", String(r.retryAfterSec));
      return next(new ApiError(429, "rate_limited", "Too many requests.", r.retryAfterSec));
    }
    next();
  };

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/scenarios", (_req: Request, res: Response) => {
    res.json({ scenarios: [...deps.scenarios.values()].map(toSummary) });
  });

  app.post(
    "/session/turn",
    requireDevice,
    limit(turnLimiter),
    wrap(async (req: Request, res: Response) => {
      res.json(await handleTurn(deps, req.body));
    }),
  );

  app.post(
    "/session/feedback",
    requireDevice,
    limit(feedbackLimiter),
    wrap(async (req: Request, res: Response) => {
      res.json(await handleFeedback(deps, req.body));
    }),
  );

  app.use(express.static(opts.webDir));

  app.use((_req: Request, _res: Response, next: NextFunction) => next(new ApiError(404, "not_found", "Not found.")));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
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
