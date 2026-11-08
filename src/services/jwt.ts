import jwt from "jsonwebtoken";

/**
 * Minimal payload carried in the `session` cookie: just enough to look the
 * player up again on every request. Never put anything sensitive here —
 * the JWT is signed, not encrypted, and only httpOnly (not hidden from a
 * server with the secret).
 */
export interface SessionPayload {
  playerId: string;
}

const SESSION_TTL = "30d";

/**
 * Reads JWT_SECRET from the environment on every call (never cached at
 * module-load time) so it reflects whatever .env state is current when a
 * test or the app actually signs/verifies a token.
 */
function getSecret(): string | undefined {
  return process.env.JWT_SECRET;
}

/**
 * Signs a session JWT for the given player. Throws if JWT_SECRET is unset —
 * callers (the /auth/discord/callback route) only reach this after a
 * successful Discord token exchange, at which point a missing secret is a
 * server misconfiguration, not a recoverable per-request condition.
 */
export function signSession(payload: SessionPayload): string {
  const secret = getSecret();
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return jwt.sign(payload, secret, { expiresIn: SESSION_TTL });
}

/**
 * Verifies and decodes a session JWT. Returns null (never throws) on any
 * failure: missing secret, expired token, bad signature, or a payload
 * that doesn't carry a string `playerId`. Callers (requireAuth) treat null
 * uniformly as "unauthenticated".
 */
export function verifySession(token: string): SessionPayload | null {
  const secret = getSecret();
  if (!secret) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, secret);
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      typeof (decoded as Record<string, unknown>).playerId === "string"
    ) {
      return { playerId: (decoded as Record<string, unknown>).playerId as string };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Minimal payload carried in the `staff_session` cookie. Deliberately a
 * distinct shape (`staffId`, not `playerId`) AND signed with a distinct
 * secret (STAFF_JWT_SECRET, not JWT_SECRET) from the player session above,
 * so a player's session JWT can never verify as a staff session (wrong
 * secret -> signature check fails) and, even in the hypothetical where the
 * secrets collided, wouldn't carry the field requireStaff reads either.
 */
export interface StaffSessionPayload {
  staffId: string;
}

const STAFF_SESSION_TTL = "12h";

function getStaffSecret(): string | undefined {
  return process.env.STAFF_JWT_SECRET;
}

/**
 * Signs a staff session JWT. Throws if STAFF_JWT_SECRET is unset — the
 * /staff/login route only reaches this after a verified password match,
 * at which point a missing secret is a server misconfiguration.
 */
export function signStaffSession(payload: StaffSessionPayload): string {
  const secret = getStaffSecret();
  if (!secret) {
    throw new Error("STAFF_JWT_SECRET is not set");
  }
  return jwt.sign(payload, secret, { expiresIn: STAFF_SESSION_TTL });
}

/**
 * Verifies and decodes a staff session JWT. Returns null (never throws) on
 * any failure, including a validly-signed *player* session JWT: that token
 * was signed with JWT_SECRET, not STAFF_JWT_SECRET, so jwt.verify rejects
 * it on signature mismatch before the payload shape is even considered.
 */
export function verifyStaffSession(token: string): StaffSessionPayload | null {
  const secret = getStaffSecret();
  if (!secret) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, secret);
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      typeof (decoded as Record<string, unknown>).staffId === "string"
    ) {
      return { staffId: (decoded as Record<string, unknown>).staffId as string };
    }
    return null;
  } catch {
    return null;
  }
}
