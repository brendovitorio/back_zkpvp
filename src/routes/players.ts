import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";

export const playersRouter = Router();

const modeSchema = z.enum(["global", "duo", "squad"]);

interface PlayerRow {
  id: string;
  display_name: string;
  clan_tag: string | null;
  rating: string;
  matches: number;
  kd: string;
  wins: number;
  avg_kills: string;
}

/**
 * GET /api/players?search=<string>&mode=global|duo|squad
 *
 * Unlike /api/ranking, an unrecognized or missing `mode` never 400s here —
 * it silently falls back to "global" — because the Descobrir UI's tabs
 * always send one of the three valid values, and a direct/bookmarked hit
 * with no mode should still render something sensible instead of erroring.
 *
 * `clanTag` comes from `players.clan_id` (migration 002) LEFT JOINed to
 * `clans`, same pattern as `ranking.ts`'s clan join — null for a clanless
 * player, never used to exclude them from results.
 */
playersRouter.get("/", async (req, res) => {
  const modeResult = modeSchema.safeParse(req.query.mode);
  const mode = modeResult.success ? modeResult.data : "global";

  const search =
    typeof req.query.search === "string" && req.query.search.length > 0
      ? req.query.search
      : null;

  const { rows } = await pool.query<PlayerRow>(
    `SELECT
       p.id,
       p.display_name,
       c.tag AS clan_tag,
       ps.rating,
       ps.matches,
       ps.kd,
       ps.wins,
       ps.avg_kills
     FROM players p
     JOIN player_stats ps ON ps.player_id = p.id AND ps.mode = $1
     LEFT JOIN clans c ON c.id = p.clan_id
     WHERE ($2::text IS NULL OR p.display_name ILIKE '%' || $2 || '%')
     ORDER BY ps.wins DESC, ps.kd DESC, ps.avg_kills DESC, ps.matches DESC`,
    [mode, search]
  );

  res.json({
    players: rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      clanTag: row.clan_tag,
      rating: Number(row.rating),
      matches: row.matches,
      kd: Number(row.kd),
      wins: row.wins,
      avgKills: Number(row.avg_kills),
    })),
  });
});
