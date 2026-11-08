import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Constant-time string equality: hashes both inputs to fixed-length
 * (32-byte) digests first, then compares with `timingSafeEqual`.
 *
 * Hashing first means the comparison always operates on same-length
 * buffers regardless of how long `a`/`b` are — `timingSafeEqual` itself
 * throws on mismatched lengths, and comparing variable-length secrets
 * directly (even byte-by-byte) can leak how many leading bytes matched
 * through response timing. Equal hashes means equal inputs (collision
 * risk is cryptographically negligible for SHA-256).
 */
function safeEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Whether `req` carries the correct `x-api-key` for FIVEM_RESOURCE_API_KEY,
 * using the timing-safe comparison above. Exported (not just used inside
 * `requireApiKey`) so other middleware guarding the same routes — notably
 * `authFailureLimiter`, which needs to recognize an already-valid key to
 * exempt it from its own throttling — can reuse the exact same check
 * instead of re-implementing (and risking drifting from) the comparison
 * logic.
 */
export function isValidApiKey(req: Request): boolean {
  const expected = process.env.FIVEM_RESOURCE_API_KEY;
  const provided = req.headers["x-api-key"];
  const providedString = typeof provided === "string" ? provided : "";

  return Boolean(expected) && providedString.length > 0 && safeEqual(providedString, expected!);
}

/**
 * Guards routes called by the FiveM server resource (not a browser/player
 * session). Compares the `x-api-key` header against FIVEM_RESOURCE_API_KEY
 * using a timing-safe comparison (see `isValidApiKey`/`safeEqual`) so a
 * response-timing side channel can't be used to guess the shared secret
 * character by character. Missing/unset env var or a mismatched/missing
 * header both 401 `{ error: "invalid_api_key" }`.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!isValidApiKey(req)) {
    res.status(401).json({ error: "invalid_api_key" });
    return;
  }

  next();
}
