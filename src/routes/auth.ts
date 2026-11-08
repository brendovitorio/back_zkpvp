import { randomBytes } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { pool } from "../db/pool.js";
import { buildAuthorizeUrl, discordAvatarUrl, exchangeCode, isDiscordConfigured } from "../services/discordOAuth.js";
import { signSession } from "../services/jwt.js";

export const authRouter = Router();

interface PlayerRow {
  id: string;
  discord_id: string;
  discord_username: string;
  discord_avatar: string | null;
  display_name: string;
  fivem_license: string | null;
  created_at: Date;
}

/** camelCase shape returned to the frontend (project convention). */
function toPlayerSummary(row: PlayerRow) {
  return {
    id: row.id,
    discordId: row.discord_id,
    discordUsername: row.discord_username,
    discordAvatarUrl: discordAvatarUrl(row.discord_id, row.discord_avatar),
    displayName: row.display_name,
    fivemLicense: row.fivem_license,
  };
}

const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30d, matches jwt.ts's SESSION_TTL

// Short-lived: the state cookie only needs to survive the round trip to
// Discord and back, not a full session.
const OAUTH_STATE_COOKIE_MAX_AGE_MS = 5 * 60 * 1000; // 5min
const OAUTH_STATE_COOKIE_NAME = "oauth_state";

/**
 * GET /auth/discord/login
 *
 * Redirects to Discord's authorize URL. 503s instead of crashing or 500ing
 * when DISCORD_CLIENT_ID/SECRET/REDIRECT_URI are unset — deliberate per the
 * project's current state: no Discord Developer Portal app exists yet.
 *
 * Generates a random CSRF `state` token, stores it in a short-lived
 * httpOnly cookie, and passes it to Discord so the callback can verify the
 * request actually originated from this login (not an attacker tricking a
 * victim into completing an OAuth flow the attacker initiated — login
 * CSRF / session-fixation via the callback).
 */
authRouter.get("/discord/login", (_req, res) => {
  if (!isDiscordConfigured()) {
    res.status(503).json({ error: "discord_not_configured" });
    return;
  }

  const state = randomBytes(16).toString("hex");
  res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: OAUTH_STATE_COOKIE_MAX_AGE_MS,
  });

  res.redirect(buildAuthorizeUrl(state));
});

/**
 * GET /auth/discord/callback?code=...&state=...
 *
 * Verifies the CSRF `state` param against the `oauth_state` cookie set by
 * /auth/discord/login before doing anything else — a missing/mismatched
 * state is rejected (400) without ever calling Discord or touching the
 * `players` table. The state cookie is single-use and cleared either way.
 *
 * On a valid state: exchanges the code for a Discord identity, upserts the
 * `players` row by `discord_id` (creating it with display_name = discord
 * username on first login; an existing player's display_name is left alone
 * so any later customization survives re-login), signs a session JWT, sets
 * it as an httpOnly cookie, and redirects to WEB_ORIGIN/cadastro.
 */
authRouter.get("/discord/callback", async (req, res) => {
  if (!isDiscordConfigured()) {
    res.status(503).json({ error: "discord_not_configured" });
    return;
  }

  const queryState = req.query.state;
  const cookieState = req.cookies?.[OAUTH_STATE_COOKIE_NAME];
  res.clearCookie(OAUTH_STATE_COOKIE_NAME);

  // Plain `===` is fine here: `state` is a single-use, short-lived,
  // non-secret anti-CSRF token, not a password/API-key comparison that
  // needs to be timing-attack-resistant.
  if (
    typeof queryState !== "string" ||
    typeof cookieState !== "string" ||
    queryState.length === 0 ||
    queryState !== cookieState
  ) {
    res.status(400).json({ error: "invalid_state" });
    return;
  }

  const code = req.query.code;
  if (typeof code !== "string" || code.length === 0) {
    res.status(400).json({ error: "missing_code" });
    return;
  }

  const { discordId, username, avatar } = await exchangeCode(code);

  const { rows } = await pool.query<PlayerRow>(
    `INSERT INTO players (discord_id, discord_username, discord_avatar, display_name)
     VALUES ($1, $2, $3, $2)
     ON CONFLICT (discord_id)
     DO UPDATE SET discord_username = EXCLUDED.discord_username,
                   discord_avatar = EXCLUDED.discord_avatar
     RETURNING id, discord_id, discord_username, discord_avatar, display_name, fivem_license, created_at`,
    [discordId, username, avatar]
  );

  const player = rows[0];
  const token = signSession({ playerId: player.id });

  res.cookie("session", token, {
    httpOnly: true,
    // Discord's redirect back to /auth/discord/callback, and this route's
    // own redirect to WEB_ORIGIN, are both top-level navigations, so Lax
    // covers setting the cookie. A production deploy where the frontend
    // calls the API cross-origin via fetch (not navigation) needs
    // SameSite=None + Secure for that cookie to be sent back — revisit
    // once real prod origins are known (see task-13-report.md).
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
  });

  res.redirect(`${process.env.WEB_ORIGIN}/cadastro`);
});

/**
 * GET /auth/me
 *
 * Returns the authenticated player's summary, or 401 via requireAuth when
 * there's no valid session cookie.
 */
authRouter.get("/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query<PlayerRow>(
    `SELECT id, discord_id, discord_username, discord_avatar, display_name, fivem_license, created_at
     FROM players WHERE id = $1`,
    [req.player!.playerId]
  );

  const player = rows[0];
  if (!player) {
    // Valid, non-expired JWT but the player row is gone (deleted account).
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  res.json({ player: toPlayerSummary(player) });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie("session", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  res.status(200).json({ ok: true });
});
