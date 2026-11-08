import { Router } from "express";
import { pool } from "../db/pool.js";

export const homeStatsRouter = Router();

interface HomeStatRow {
  key: string;
  value: string;
}

/**
 * GET /api/home-stats
 *
 * Deliberately public (no `requireStaff`/`requireAuth`) and read-only — the
 * counterpart write side is `PUT /staff/home-stats/:key` (Task 20), which
 * *is* `requireStaff`-protected. This route just selects every row and
 * returns them keyed by their DB `key` column.
 *
 * Unlike every other route in this app, the response keys stay snake_case
 * (`contas_criadas`, `premiacao_total`, etc.) instead of being camelCased —
 * `stats` is a dynamic key-value map mirroring `home_stats` directly, not a
 * fixed response shape with named fields, so there's nothing to camelCase
 * without inventing a mapping the DB doesn't have.
 */
homeStatsRouter.get("/", async (_req, res) => {
  const { rows } = await pool.query<HomeStatRow>(`SELECT key, value FROM home_stats`);

  const stats: Record<string, string> = {};
  for (const row of rows) {
    stats[row.key] = row.value;
  }

  res.status(200).json({ stats });
});
