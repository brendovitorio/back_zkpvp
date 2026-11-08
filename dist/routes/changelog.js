import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
export const changelogRouter = Router();
const categorySchema = z.string().min(1).max(64).optional();
const searchSchema = z.string().min(1).max(200).optional();
changelogRouter.get("/", async (req, res) => {
    const categoryResult = categorySchema.safeParse(typeof req.query.category === "string" ? req.query.category : undefined);
    if (!categoryResult.success) {
        res.status(400).json({ error: "invalid_category" });
        return;
    }
    const category = categoryResult.data ?? null;
    const searchResult = searchSchema.safeParse(typeof req.query.search === "string" ? req.query.search : undefined);
    if (!searchResult.success) {
        res.status(400).json({ error: "invalid_search" });
        return;
    }
    const search = searchResult.data ?? null;
    const { rows } = await pool.query(`SELECT id, version, title, published_at, categories, body
     FROM changelog_entries
     WHERE ($1::text IS NULL OR categories @> ARRAY[$1]::text[])
       AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%' OR body ILIKE '%' || $2 || '%')
     ORDER BY published_at DESC`, [category, search]);
    res.json({
        entries: rows.map((row) => ({
            id: row.id,
            version: row.version,
            title: row.title,
            publishedAt: row.published_at,
            categories: row.categories,
            body: row.body,
        })),
    });
});
