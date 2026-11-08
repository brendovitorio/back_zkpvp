import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { authFailureLimiter } from "../middleware/authFailureLimit.js";
import { confirmRateLimiter } from "../middleware/confirmRateLimit.js";
import { requireApiKey } from "../middleware/requireApiKey.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { CODE_TTL_MS, generateCode } from "../services/pairingCode.js";
export const linkRouter = Router();
const fivemLicenseSchema = z.string().min(10).max(80).regex(/^license:[A-Za-z0-9]+$/);
const tokenSchema = z.string().trim().toUpperCase().regex(/^[A-HJ-KM-NP-Z2-9]{6}$/);
function hashToken(token) {
    return createHash("sha256").update(token).digest("hex");
}
/** FiveM server creates a short-lived token when an unlinked license joins. */
linkRouter.post("/token", requireApiKey, async (req, res) => {
    const parsed = fivemLicenseSchema.safeParse(req.body?.license);
    if (!parsed.success) {
        res.status(400).json({ error: "invalid_license" });
        return;
    }
    const license = parsed.data;
    const token = generateCode();
    const tokenHash = hashToken(token);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [license]);
        const linked = await client.query(`SELECT 1 FROM players WHERE fivem_license = $1`, [license]);
        if (linked.rowCount) {
            await client.query("ROLLBACK");
            res.status(409).json({ error: "license_already_linked" });
            return;
        }
        await client.query(`UPDATE fivem_link_tokens SET invalidated_at = now()
       WHERE fivem_license = $1 AND claimed_at IS NULL AND invalidated_at IS NULL`, [license]);
        const expiresAt = new Date(Date.now() + CODE_TTL_MS);
        await client.query(`INSERT INTO fivem_link_tokens (code_hash, fivem_license, expires_at)
       VALUES ($1, $2, $3)`, [tokenHash, license, expiresAt]);
        await client.query("COMMIT");
        res.status(201).json({ token, expiresAt: expiresAt.toISOString() });
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
});
/**
 * FiveM connection gate polls this endpoint while a player is waiting in
 * the connection deferrals. It returns only whether this license is linked;
 * no account or player data is exposed.
 */
linkRouter.get("/status", requireApiKey, async (req, res) => {
    const parsed = fivemLicenseSchema.safeParse(req.query.license);
    if (!parsed.success) {
        res.status(400).json({ error: "invalid_license" });
        return;
    }
    const { rowCount } = await pool.query(`SELECT 1 FROM players WHERE fivem_license = $1 LIMIT 1`, [parsed.data]);
    res.setHeader("Cache-Control", "no-store");
    res.json({ linked: (rowCount ?? 0) > 0 });
});
/** Authenticated website player claims the token shown by the FiveM server. */
linkRouter.post("/claim", requireAuth, confirmRateLimiter, async (req, res) => {
    const parsed = tokenSchema.safeParse(req.body?.token);
    if (!parsed.success) {
        res.status(400).json({ error: "invalid_token" });
        return;
    }
    const tokenHash = hashToken(parsed.data);
    const playerId = req.player.playerId;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const tokenResult = await client.query(`SELECT fivem_license, expires_at, claimed_by_player_id, claimed_at, invalidated_at
       FROM fivem_link_tokens WHERE code_hash = $1 FOR UPDATE`, [tokenHash]);
        const linkToken = tokenResult.rows[0];
        if (!linkToken) {
            await client.query("ROLLBACK");
            res.status(404).json({ error: "invalid_token" });
            return;
        }
        if (linkToken.expires_at.getTime() <= Date.now()) {
            await client.query("ROLLBACK");
            res.status(410).json({ error: "token_expired" });
            return;
        }
        if (linkToken.invalidated_at) {
            await client.query("ROLLBACK");
            res.status(409).json({ error: "token_replaced" });
            return;
        }
        if (linkToken.claimed_at) {
            const alreadyClaimedByPlayer = linkToken.claimed_by_player_id === playerId;
            await client.query("ROLLBACK");
            res.status(alreadyClaimedByPlayer ? 200 : 409).json(alreadyClaimedByPlayer ? { ok: true, alreadyLinked: true } : { error: "token_already_used" });
            return;
        }
        const playerResult = await client.query(`SELECT fivem_license FROM players WHERE id = $1 FOR UPDATE`, [playerId]);
        const playerLicense = playerResult.rows[0]?.fivem_license ?? null;
        if (playerLicense && playerLicense !== linkToken.fivem_license) {
            await client.query("ROLLBACK");
            res.status(409).json({ error: "account_already_linked" });
            return;
        }
        const otherPlayer = await client.query(`SELECT 1 FROM players WHERE fivem_license = $1 AND id <> $2`, [linkToken.fivem_license, playerId]);
        if (otherPlayer.rowCount) {
            await client.query("ROLLBACK");
            res.status(409).json({ error: "license_already_linked" });
            return;
        }
        await client.query(`UPDATE players SET fivem_license = $1 WHERE id = $2`, [linkToken.fivem_license, playerId]);
        await client.query(`UPDATE fivem_link_tokens SET claimed_by_player_id = $1, claimed_at = now() WHERE code_hash = $2`, [playerId, tokenHash]);
        await client.query("COMMIT");
        res.json({ ok: true });
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
});
/**
 * GET /api/link/code
 *
 * Requires a player session (requireAuth). Generates a fresh 6-char
 * pairing code for the authenticated player, good for 10 minutes.
 *
 * Any prior *unconfirmed* code for this player is deleted first so only
 * one active code can exist at a time — otherwise a player who requests
 * multiple codes (e.g. refreshing the Discord bot's !link command) could
 * end up with several simultaneously-valid codes. Already-confirmed codes
 * are left alone as a historical record of the completed link.
 */
linkRouter.get("/code", requireAuth, async (req, res) => {
    const playerId = req.player.playerId;
    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await pool.query(`DELETE FROM link_codes WHERE player_id = $1 AND confirmed = false`, [
        playerId,
    ]);
    await pool.query(`INSERT INTO link_codes (player_id, code, confirmed, expires_at)
     VALUES ($1, $2, false, $3)`, [playerId, code, expiresAt]);
    res.json({ code, expiresAt: expiresAt.toISOString() });
});
const confirmSchema = z.object({
    code: z.string().min(1),
    fivemLicense: z.string().min(1),
});
/**
 * POST /api/link/confirm
 *
 * Called by the FiveM server resource (requireApiKey), not a player
 * browser session. Rate-limited (confirmRateLimiter) since codes are only
 * 6 chars and this endpoint would otherwise be brute-forceable.
 *
 * Middleware order (matters here): authFailureLimiter -> requireApiKey ->
 * confirmRateLimiter -> handler.
 *   - authFailureLimiter throttles repeated *wrong*-key guesses (10/15min
 *     per IP) against requireApiKey itself, independent of whether the
 *     key ever passes.
 *   - requireApiKey must run before confirmRateLimiter: if the limiter ran
 *     first, an unauthenticated caller with no/wrong x-api-key could still
 *     consume the per-IP rate-limit quota, letting an attacker with no key
 *     exhaust the limiter and lock out the real FiveM resource calling
 *     from that IP (a DoS on the legitimate caller via the very mechanism
 *     meant to protect it). Checking the api key first means only callers
 *     who already hold the valid shared secret ever consume
 *     confirmRateLimiter's quota.
 *
 * Responses: code not found (404) -> expired (410) -> already confirmed
 * (409) -> success (200). Expiry always wins over "already confirmed" when
 * a code is somehow both — an expired code is never a valid "already
 * linked" success story. These stay as distinct status codes rather than
 * one generic error: this route already requires `requireApiKey`, so it's
 * not public-facing, and the brief calls for the enumeration explicitly.
 *
 * The claim itself (flipping `confirmed` to true) is a single atomic
 * UPDATE whose WHERE clause folds in the "not expired, not already
 * confirmed" check, rather than a separate SELECT-then-check-then-UPDATE.
 * Postgres takes a row lock for the matching row during the UPDATE, so two
 * concurrent confirm calls for the same code can't both read "claimable"
 * before either writes (a TOCTOU race) — at most one of them can see
 * `confirmed = false` at the moment it writes. If the UPDATE claims no
 * row, a read-only follow-up SELECT distinguishes *why* (not found vs
 * expired vs already confirmed) purely for picking the right status code;
 * it doesn't re-decide anything the UPDATE already decided.
 *
 * On success, sets players.fivem_license in the same transaction as the
 * claiming UPDATE, so a failure setting the license can't leave a code
 * marked confirmed with no license actually set.
 */
linkRouter.post("/confirm", authFailureLimiter, requireApiKey, confirmRateLimiter, async (req, res) => {
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(404).json({ error: "code_not_found" });
        return;
    }
    const { code, fivemLicense } = parsed.data;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const claim = await client.query(`UPDATE link_codes
       SET confirmed = true
       WHERE code = $1 AND confirmed = false AND expires_at > now()
       RETURNING player_id`, [code]);
        if (claim.rows.length === 0) {
            // Nothing was claimed/written above — this SELECT only reports
            // current state, so it's safe to run before rolling back.
            const { rows } = await client.query(`SELECT id, player_id, code, confirmed, expires_at FROM link_codes WHERE code = $1`, [code]);
            const linkCode = rows[0];
            await client.query("ROLLBACK");
            if (!linkCode) {
                res.status(404).json({ error: "code_not_found" });
                return;
            }
            if (linkCode.expires_at.getTime() < Date.now()) {
                res.status(410).json({ error: "code_expired" });
                return;
            }
            res.status(409).json({ error: "code_already_confirmed" });
            return;
        }
        const playerId = claim.rows[0].player_id;
        await client.query(`UPDATE players SET fivem_license = $1 WHERE id = $2`, [
            fivemLicense,
            playerId,
        ]);
        await client.query("COMMIT");
        res.json({ ok: true });
    }
    catch (err) {
        await client.query("ROLLBACK");
        throw err;
    }
    finally {
        client.release();
    }
});
