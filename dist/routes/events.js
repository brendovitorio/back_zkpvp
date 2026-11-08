import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
export const eventsRouter = Router();
export const hallOfFameRouter = Router();
const isoDateSchema = z.coerce.date();
/**
 * Parses an optional `from`/`to` query param into a `Date`.
 * Returns `null` when the param was omitted (no filter), or `undefined`
 * when it was present but not a valid date (caller should 400).
 */
function parseOptionalDateQuery(value) {
    if (value === undefined) {
        return null;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const result = isoDateSchema.safeParse(value);
    return result.success ? result.data : undefined;
}
function mapEventRow(row) {
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        category: row.category,
        startsAt: row.starts_at,
        prizeText: row.prize_text,
        featured: row.featured,
        createdAt: row.created_at,
    };
}
eventsRouter.get("/", async (req, res) => {
    const from = parseOptionalDateQuery(req.query.from);
    if (from === undefined) {
        res.status(400).json({ error: "invalid_from" });
        return;
    }
    const to = parseOptionalDateQuery(req.query.to);
    if (to === undefined) {
        res.status(400).json({ error: "invalid_to" });
        return;
    }
    const { rows } = await pool.query(`SELECT id, title, description, category, starts_at, prize_text, featured, created_at
     FROM events
     WHERE ($1::timestamptz IS NULL OR starts_at >= $1)
       AND ($2::timestamptz IS NULL OR starts_at <= $2)
     ORDER BY starts_at ASC`, [from, to]);
    const { rows: featuredRows } = await pool.query(`SELECT id, title, description, category, starts_at, prize_text, featured, created_at
     FROM events
     WHERE featured = true AND starts_at >= now()
     ORDER BY starts_at ASC
     LIMIT 1`);
    res.json({
        events: rows.map(mapEventRow),
        featured: featuredRows.length > 0 ? mapEventRow(featuredRows[0]) : null,
    });
});
hallOfFameRouter.get("/", async (_req, res) => {
    const { rows } = await pool.query(`SELECT id, event_name, champion_name, champion_tag, prize_text, won_at
     FROM hall_of_fame
     ORDER BY won_at DESC`);
    res.json({
        entries: rows.map((row) => ({
            id: row.id,
            eventName: row.event_name,
            championName: row.champion_name,
            championTag: row.champion_tag,
            prizeText: row.prize_text,
            wonAt: row.won_at,
        })),
    });
});
