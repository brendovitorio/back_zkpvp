import "dotenv/config";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
// Side-effect import: patches Express so a rejected promise thrown inside an
// async route handler is forwarded to the error-handling middleware below
// instead of becoming an unhandled rejection that can crash the process.
// Must be imported before any router that defines async handlers.
import "express-async-errors";
import { runMigrations } from "./db/migrate.js";
import { authRouter } from "./routes/auth.js";
import { accountRouter } from "./routes/account.js";
import { changelogRouter } from "./routes/changelog.js";
import { eventsRouter, hallOfFameRouter } from "./routes/events.js";
import { fivemEntitlementsRouter } from "./routes/fivemEntitlements.js";
import { fivemAdminRouter } from "./routes/fivemAdmin.js";
import { healthRouter } from "./routes/health.js";
import { homeStatsRouter } from "./routes/homeStats.js";
import { linkRouter } from "./routes/link.js";
import { playersRouter } from "./routes/players.js";
import { rankingRouter } from "./routes/ranking.js";
import { serverStatusRouter } from "./routes/serverStatus.js";
import { staffRouter } from "./routes/staff.js";
import { storeRouter } from "./routes/store.js";
import { startFivemPolling } from "./services/fivemStatus.js";

export const app = express();

// nginx is the only thing that ever talks to this process directly (it
// binds loopback-only — see HOST below), so the single hop in front of it
// is always trusted as "loopback": Express then takes the client IP from
// nginx's X-Forwarded-For instead of nginx's own address. Several routes
// (e.g. the rate limiters on /api/link/confirm, plus authFailureLimiter/
// confirmRateLimiter/staffLoginLimiter) key by `req.ip` and depend on this
// being set correctly once a reverse proxy is in the picture.
app.set("trust proxy", "loopback");
app.use(cors({ origin: process.env.WEB_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use("/health", healthRouter);
app.use("/auth", authRouter);
app.use("/api/account", accountRouter);
app.use("/api/ranking", rankingRouter);
app.use("/api/players", playersRouter);
app.use("/api/events", eventsRouter);
app.use("/api/hall-of-fame", hallOfFameRouter);
app.use("/api/changelog", changelogRouter);
app.use("/api/server-status", serverStatusRouter);
app.use("/api/home-stats", homeStatsRouter);
app.use("/api/link", linkRouter);
app.use("/api/store", storeRouter);
app.use("/api/integrations/fivem", fivemEntitlementsRouter);
app.use("/api/integrations/fivem/admin", fivemAdminRouter);
app.use("/staff", staffRouter);

// Catch-all error handler. Must be mounted after all routes and take exactly
// 4 args so Express recognizes it as an error handler (not regular middleware).
// Replaces Express's default handler, which can leak stack traces, with a
// plain logged 500 response.
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("unhandled route error", err);
    res.status(500).json({ error: "internal_error" });
  }
);

const PORT = Number(process.env.PORT ?? 3000);
// Binds loopback-only by default: this process must never be directly
// reachable from the public internet (that would bypass nginx's TLS
// termination and the Cloudflare origin cert entirely). Override only for
// local setups where the API genuinely needs to accept connections from
// outside 127.0.0.1 (e.g. testing from another device on a LAN).
const HOST = process.env.HOST ?? "127.0.0.1";

// Only boot a real server (and run migrations) when this file is executed
// directly, e.g. `node dist/index.js` or `tsx src/index.ts`. When imported
// by tests (supertest), neither side effect should run.
const isDirectRun = process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectRun) {
  startFivemPolling();

  runMigrations()
    .then(() => {
      app.listen(PORT, HOST, () => {
        console.log(`api listening on ${HOST}:${PORT}`);
      });
    })
    .catch((err) => {
      console.error("failed to run migrations", err);
      process.exit(1);
    });
}
