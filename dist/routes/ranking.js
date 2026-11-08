import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
export const rankingRouter = Router();
const modeSchema = z.enum(["diario", "semanal", "mensal", "mvp"]);
const stageSchema = z
    .string()
    .max(64)
    .regex(/^[\w-]+$/)
    .optional();
rankingRouter.get("/", async (req, res) => {
    const modeResult = modeSchema.safeParse(req.query.mode);
    if (!modeResult.success) {
        res.status(400).json({ error: "invalid_mode" });
        return;
    }
    const mode = modeResult.data;
    const stageResult = stageSchema.safeParse(typeof req.query.stage === "string" ? req.query.stage : undefined);
    if (!stageResult.success) {
        res.status(400).json({ error: "invalid_stage" });
        return;
    }
    const stage = stageResult.data;
    const { rows } = await pool.query(`WITH selected_stage AS (
       SELECT stage
       FROM rankings
       WHERE mode = $1 AND ($2::text IS NULL OR stage = $2)
       GROUP BY stage
       ORDER BY MAX(updated_at) DESC, stage DESC
       LIMIT 1
     )
     SELECT
       r.stage,
       r.position,
       r.player_id,
       p.display_name,
       c.tag AS clan_tag,
       r.eliminations,
       r.wins,
       r.prizes_text
     FROM rankings r
     JOIN players p ON p.id = r.player_id
     LEFT JOIN clans c ON c.id = r.clan_id
     JOIN selected_stage selected ON selected.stage = r.stage
     WHERE r.mode = $1
     ORDER BY r.position ASC, r.updated_at DESC`, [mode, stage ?? null]);
    res.json({
        mode,
        stage: rows[0]?.stage ?? stage ?? null,
        entries: rows.map((row) => ({
            position: row.position,
            playerId: row.player_id,
            displayName: row.display_name,
            clanTag: row.clan_tag,
            eliminations: row.eliminations,
            wins: row.wins,
            prizesText: row.prizes_text,
        })),
    });
});
