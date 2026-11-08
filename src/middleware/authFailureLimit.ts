import { rateLimit } from "express-rate-limit";
import { isValidApiKey } from "./requireApiKey.js";

/**
 * Throttles *failed* requireApiKey attempts on POST /api/link/confirm,
 * per source IP: 10 failures per 15 minutes.
 *
 * This is separate from `confirmRateLimiter` (which only ever sees traffic
 * that already passed the api-key check) because it guards a different
 * threat: repeated wrong-key guesses against the shared secret itself.
 * Mounted BEFORE requireApiKey so it can see and count the 401s requireApiKey
 * produces.
 *
 * `requestWasSuccessful` is overridden (rather than relying on the
 * library's status-code-based default) to define "success" as "the api
 * key check passed" — i.e. any status *other than* 401 — not "the whole
 * request ultimately 2xx'd". Without this override, a request with a
 * *correct* key that happens to hit a 404/410/409 downstream (unknown/
 * expired/already-confirmed code) would default to counting as a
 * "failure" here too, which would wrongly burn quota meant only for actual
 * auth failures.
 *
 * `skip` re-checks the api key itself (via the same timing-safe
 * `isValidApiKey` helper `requireApiKey` uses) and exempts an
 * already-correct key from this limiter entirely — it's never counted
 * and can never be blocked by it, regardless of IP or prior failures from
 * that IP. This matters because the limiter keys by `req.ip`: the planned
 * deploy puts nginx in front of this API (Task 23), and if `trust proxy`
 * isn't configured correctly there, every request could appear to share
 * one IP (the proxy's). Without this `skip`, an attacker sending 10 failed
 * requests through the public proxy would lock out the real FiveM
 * resource — calling with the correct key, from the same apparent IP —
 * for the full 15-minute window, turning this defense into a DoS vector
 * against the legitimate caller. With `skip`, only wrong/missing keys
 * ever consume quota, so that scenario can't happen no matter how `req.ip`
 * resolves.
 */
export const authFailureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  skip: (req) => isValidApiKey(req),
  handler: (_req, res) => {
    res.status(429).json({ error: "rate_limited" });
  },
});
