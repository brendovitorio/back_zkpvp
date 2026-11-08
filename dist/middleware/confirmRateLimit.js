import { rateLimit } from "express-rate-limit";
/**
 * Throttles POST /api/link/confirm per source IP.
 *
 * Codes are only 6 chars from a 32-char alphabet (~1 billion combinations,
 * but still brute-forceable fast if unthrottled). The endpoint already
 * requires `requireApiKey` (a shared secret only the FiveM resource holds,
 * not a public attacker), which meaningfully narrows who could even attempt
 * this — but a compromised/leaked resource key, or a bug in the resource
 * itself, shouldn't be able to hammer arbitrary codes unbounded. 20/min is
 * generous for legitimate FiveM-resource traffic (one real confirm per
 * player link) while blunting a brute-force attempt.
 *
 * Chose the `express-rate-limit` package over a hand-rolled counter since
 * it already handles the window/cleanup bookkeeping correctly and is a
 * well-audited, widely-used dependency for exactly this job.
 *
 * Exported (not just applied inline) so tests can call `resetAll()` between
 * cases — otherwise quota consumed by earlier tests in the same process
 * would leak into later ones since the in-memory store is shared for the
 * life of the process, not reset per request/test.
 */
export const confirmRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
        res.status(429).json({ error: "rate_limited" });
    },
});
