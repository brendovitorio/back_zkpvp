import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { discordAvatarUrl } from "../services/discordOAuth.js";

export const accountRouter = Router();

accountRouter.get("/dashboard", requireAuth, async (req, res) => {
  const playerId = req.player!.playerId;
  const [profileResult, statsResult, entitlementsResult, resultsResult, rankResult] = await Promise.all([
    pool.query<{
      id: string;
      display_name: string;
      discord_username: string;
      discord_id: string;
      discord_avatar: string | null;
      fivem_license: string | null;
      clan_tag: string | null;
      created_at: Date;
    }>(
      `SELECT p.id, p.display_name, p.discord_id, p.discord_username, p.discord_avatar, p.fivem_license,
              c.tag AS clan_tag, p.created_at
       FROM players p
       LEFT JOIN clans c ON c.id = p.clan_id
       WHERE p.id = $1`,
      [playerId]
    ),
    pool.query<{
      mode: string;
      matches: number;
      wins: number;
      kd: string;
      avg_kills: string;
      rating: string;
      ranked: boolean;
    }>(
      `SELECT mode, matches, wins, kd, avg_kills, rating, ranked
       FROM player_stats WHERE player_id = $1`,
      [playerId]
    ),
    pool.query<{
      id: string;
      kind: string;
      entitlement_key: string;
      duration_unit: string;
      granted_at: Date;
      expires_at: Date | null;
    }>(
      `SELECT id, kind, entitlement_key, duration_unit, granted_at, expires_at
       FROM player_entitlements
       WHERE player_id = $1 AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY (expires_at IS NULL) DESC, expires_at ASC, granted_at DESC`,
      [playerId]
    ),
    pool.query<{
      mode: string;
      stage: string;
      position: number;
      eliminations: number;
      wins: number;
      updated_at: Date;
    }>(
      `SELECT mode, stage, position, eliminations, wins, updated_at
       FROM rankings WHERE player_id = $1
       ORDER BY updated_at DESC LIMIT 5`,
      [playerId]
    ),
    pool.query<{ position: string | null }>(
      `SELECT position FROM (
         SELECT player_id, rank() OVER (ORDER BY rating DESC) AS position
         FROM player_stats WHERE mode = 'global' AND ranked = true
       ) leaderboard WHERE player_id = $1`,
      [playerId]
    ),
  ]);

  const profile = profileResult.rows[0];
  if (!profile) {
    res.status(404).json({ error: "player_not_found" });
    return;
  }

  const stats = Object.fromEntries(statsResult.rows.map((row) => [row.mode, {
    matches: row.matches,
    wins: row.wins,
    kd: Number(row.kd),
    avgKills: Number(row.avg_kills),
    rating: Number(row.rating),
    ranked: row.ranked,
  }]));

  res.json({
    profile: {
      id: profile.id,
      displayName: profile.display_name,
      discordUsername: profile.discord_username,
      discordAvatarUrl: discordAvatarUrl(profile.discord_id, profile.discord_avatar),
      linkedToFiveM: profile.fivem_license !== null,
      clanTag: profile.clan_tag,
      createdAt: profile.created_at,
    },
    stats,
    globalPosition: rankResult.rows[0]?.position ? Number(rankResult.rows[0].position) : null,
    entitlements: entitlementsResult.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      key: row.entitlement_key,
      durationUnit: row.duration_unit,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at,
    })),
    recentResults: resultsResult.rows.map((row) => ({
      mode: row.mode,
      stage: row.stage,
      position: row.position,
      eliminations: row.eliminations,
      wins: row.wins,
      updatedAt: row.updated_at,
    })),
  });
});
