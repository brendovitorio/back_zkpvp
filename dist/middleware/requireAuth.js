import { verifySession } from "../services/jwt.js";
/**
 * Reads and verifies the `session` cookie (set by /auth/discord/callback).
 * On success, attaches `{ playerId }` to `req.player` and calls `next()`.
 * On any failure (missing cookie, expired/invalid token, unset JWT_SECRET),
 * responds 401 `{ error: "unauthenticated" }` and does not call `next()`.
 */
export function requireAuth(req, res, next) {
    const token = req.cookies?.session;
    const payload = typeof token === "string" ? verifySession(token) : null;
    if (!payload) {
        res.status(401).json({ error: "unauthenticated" });
        return;
    }
    req.player = payload;
    next();
}
