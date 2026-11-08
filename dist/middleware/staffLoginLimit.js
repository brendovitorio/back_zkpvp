import { rateLimit } from "express-rate-limit";
/**
 * Throttles POST /staff/login per source IP: 10 attempts per 15 minutes.
 *
 * Mirrors authFailureLimit.ts's reasoning (Task 14) but simpler: unlike
 * /api/link/confirm, this route only ever returns 200 (success) or 401
 * (bad credentials) — there's no third "wrong request, but not an auth
 * failure" status to worry about miscounting — so the library's default
 * success-is-status-<400 behavior is already exactly "a correct
 * username+password pair", and `skipSuccessfulRequests: true` is enough
 * on its own, with no `requestWasSuccessful` override needed.
 *
 * Without this, staff.ts's password check (scrypt + timingSafeEqual) is
 * the only friction against unlimited password guesses — real, but not a
 * substitute for actually bounding attempt rate.
 */
export const staffLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_req, res) => {
        res.status(429).json({ error: "rate_limited" });
    },
});
