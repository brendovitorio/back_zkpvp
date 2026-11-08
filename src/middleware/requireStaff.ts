import type { NextFunction, Request, Response } from "express";
import { verifyStaffSession, type StaffSessionPayload } from "../services/jwt.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireStaff on success; absent on any route it doesn't guard. */
      staff?: StaffSessionPayload;
    }
  }
}

/**
 * Reads and verifies the `staff_session` cookie (set by POST /staff/login).
 * Deliberately a separate cookie name and verification path from
 * requireAuth/`session`: verifyStaffSession checks the signature against
 * STAFF_JWT_SECRET (not JWT_SECRET) and the decoded payload's `staffId`
 * (not `playerId`), so a player's `session` cookie can never satisfy this
 * middleware and a staff member's `staff_session` cookie can never satisfy
 * requireAuth.
 *
 * On success, attaches `{ staffId }` to `req.staff` and calls `next()`.
 * On any failure (missing cookie, expired/invalid token, unset
 * STAFF_JWT_SECRET), responds 401 `{ error: "unauthenticated" }` and does
 * not call `next()`.
 */
export function requireStaff(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.staff_session;
  const payload = typeof token === "string" ? verifyStaffSession(token) : null;

  if (!payload) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  req.staff = payload;
  next();
}
