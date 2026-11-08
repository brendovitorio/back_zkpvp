import type { NextFunction, Request, Response } from "express";
import { verifySession, type SessionPayload } from "../services/jwt.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth on success; absent on any route it doesn't guard. */
      player?: SessionPayload;
    }
  }
}

/**
 * Reads and verifies the `session` cookie (set by /auth/discord/callback).
 * On success, attaches `{ playerId }` to `req.player` and calls `next()`.
 * On any failure (missing cookie, expired/invalid token, unset JWT_SECRET),
 * responds 401 `{ error: "unauthenticated" }` and does not call `next()`.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.session;
  const payload = typeof token === "string" ? verifySession(token) : null;

  if (!payload) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  req.player = payload;
  next();
}
