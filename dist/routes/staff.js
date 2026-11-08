import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireStaff } from "../middleware/requireStaff.js";
import { requireStaffAdmin } from "../middleware/requireStaffAdmin.js";
import { staffLoginLimiter } from "../middleware/staffLoginLimit.js";
import { signStaffSession } from "../services/jwt.js";
export const staffRouter = Router();
const scrypt = promisify(scryptCallback);
const SCRYPT_KEYLEN = 64;
/**
 * Hashes a plaintext password with scrypt (Node's built-in, no extra
 * dependency) using a random per-password salt. Stored as
 * `scrypt:<saltHex>:<derivedKeyHex>` so verifyPassword can recover the salt
 * used. Never store or compare plaintext passwords anywhere else in this
 * file.
 */
export async function hashPassword(password) {
    const salt = randomBytes(16).toString("hex");
    const derivedKey = (await scrypt(password, salt, SCRYPT_KEYLEN));
    return `scrypt:${salt}:${derivedKey.toString("hex")}`;
}
/**
 * Verifies a plaintext password against a `scrypt:<salt>:<hash>` string
 * produced by hashPassword. Recomputes the derived key with the same salt
 * and compares with a constant-time comparison (timingSafeEqual) rather
 * than `===`, so response timing doesn't leak how many leading bytes
 * matched.
 */
export async function verifyPassword(password, stored) {
    const [scheme, salt, hashHex] = stored.split(":");
    if (scheme !== "scrypt" || !salt || !hashHex) {
        return false;
    }
    const derivedKey = (await scrypt(password, salt, SCRYPT_KEYLEN));
    const storedBuf = Buffer.from(hashHex, "hex");
    if (storedBuf.length !== derivedKey.length) {
        return false;
    }
    return timingSafeEqual(storedBuf, derivedKey);
}
/** Flattens a ZodError into { fieldPath: firstMessage }, project's `fields` shape. */
function zodFieldErrors(error) {
    const fields = {};
    for (const issue of error.issues) {
        const key = issue.path.length > 0 ? issue.path.join(".") : "_";
        if (!(key in fields)) {
            fields[key] = issue.message;
        }
    }
    return fields;
}
const uuidParamSchema = z.string().uuid();
const isoDateStringSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "invalid_date",
});
const loginSchema = z.object({
    username: z.string().trim().min(1),
    password: z.string().min(1),
});
const changelogSchema = z.object({
    version: z.string().trim().min(1),
    title: z.string().trim().min(1),
    publishedAt: isoDateStringSchema,
    categories: z.array(z.string().trim().min(1)).default([]),
    body: z.string().trim().min(1),
});
const eventSchema = z.object({
    title: z.string().trim().min(1),
    description: z.string().trim().default(""),
    category: z.string().trim().min(1),
    startsAt: isoDateStringSchema,
    prizeText: z.string().trim().min(1).nullable().optional(),
    featured: z.boolean().optional().default(false),
});
const homeStatSchema = z.object({
    value: z.string().trim().min(1),
});
const storeItemSchema = z.object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(2000).default(""),
    priceCents: z.number().int().positive().max(2_000_000_000),
    category: z.string().trim().min(1).max(64),
    itemKey: z.string().trim().max(100).nullable().optional(),
    imageUrl: z.string().trim().url().max(2048).nullable().optional(),
    stockQuantity: z.number().int().min(0).max(1_000_000).nullable().optional(),
    active: z.boolean().default(true),
});
function mapStaffStoreItem(row) {
    return { id: row.id, name: row.name, description: row.description,
        priceCents: Number(row.price_cents), category: row.category, itemKey: row.item_key,
        imageUrl: row.image_url, active: row.active, stockQuantity: row.stock_quantity };
}
const entitlementSchema = z.object({
    kind: z.enum(["vip", "skin", "vehicle"]),
    key: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_:-]+$/),
    durationUnit: z.enum(["days", "months", "years", "lifetime"]),
    quantity: z.number().int().positive().max(1000).default(1),
});
function entitlementExpiry(unit, quantity) {
    if (unit === "lifetime")
        return null;
    const date = new Date();
    if (unit === "days")
        date.setUTCDate(date.getUTCDate() + quantity);
    if (unit === "months") {
        const day = date.getUTCDate();
        date.setUTCDate(1);
        date.setUTCMonth(date.getUTCMonth() + quantity);
        const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
        date.setUTCDate(Math.min(day, lastDay));
    }
    if (unit === "years") {
        const month = date.getUTCMonth();
        const day = date.getUTCDate();
        date.setUTCDate(1);
        date.setUTCFullYear(date.getUTCFullYear() + quantity);
        date.setUTCMonth(month);
        const lastDay = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate();
        date.setUTCDate(Math.min(day, lastDay));
    }
    return date;
}
function mapChangelogRow(row) {
    return {
        id: row.id,
        version: row.version,
        title: row.title,
        publishedAt: row.published_at,
        categories: row.categories,
        body: row.body,
    };
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
const SESSION_COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h, matches jwt.ts's STAFF_SESSION_TTL
/**
 * A fixed, precomputed hash of an arbitrary, unused password — never a
 * real account's hash. Computed once (module-level, via top-level await;
 * `module` is NodeNext/ESM so this is supported) and run through
 * verifyPassword on the "no such username" path below, so that path does
 * the same scrypt work a wrong-password attempt against a real account
 * does. Without this, a request for a nonexistent username returns
 * immediately (no scrypt call) while a wrong-password request for a real
 * username pays the full scrypt cost first — a timing side-channel an
 * attacker can use to enumerate valid staff usernames by measuring
 * response latency, independent of anything the response body says.
 */
export const DUMMY_PASSWORD_HASH = await hashPassword("zkpvp-staff-login-timing-decoy");
/**
 * POST /staff/login
 *
 * body { username, password }. On a bad/blank body, no matching account,
 * or a wrong password, responds 401 { error: "invalid_credentials" } —
 * never 400/404, so the response body never reveals whether the username
 * exists, and (via DUMMY_PASSWORD_HASH above) the response *timing*
 * doesn't either. Never touches staff_accounts for a body that failed
 * validation. Rate-limited by staffLoginLimiter (mounted on the route
 * below) to bound brute-force password guessing per IP.
 */
staffRouter.post("/login", staffLoginLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(401).json({ error: "invalid_credentials" });
        return;
    }
    const { username, password } = parsed.data;
    const { rows } = await pool.query(`SELECT id, password_hash FROM staff_accounts WHERE username = $1`, [username]);
    const account = rows[0];
    if (!account) {
        await verifyPassword(password, DUMMY_PASSWORD_HASH);
        res.status(401).json({ error: "invalid_credentials" });
        return;
    }
    const ok = await verifyPassword(password, account.password_hash);
    if (!ok) {
        res.status(401).json({ error: "invalid_credentials" });
        return;
    }
    const token = signStaffSession({ staffId: account.id });
    res.cookie("staff_session", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: SESSION_COOKIE_MAX_AGE_MS,
    });
    res.status(200).json({ ok: true });
});
/** Confirms that the current browser has a valid staff session cookie. */
staffRouter.get("/session", requireStaff, (_req, res) => {
    res.status(200).json({ ok: true });
});
// --- changelog CRUD -------------------------------------------------------
staffRouter.post("/changelog", requireStaff, async (req, res) => {
    const parsed = changelogSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "validation_error", fields: zodFieldErrors(parsed.error) });
        return;
    }
    const { version, title, publishedAt, categories, body } = parsed.data;
    const { rows } = await pool.query(`INSERT INTO changelog_entries (version, title, published_at, categories, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, version, title, published_at, categories, body`, [version, title, publishedAt, categories, body]);
    res.status(201).json({ entry: mapChangelogRow(rows[0]) });
});
staffRouter.put("/changelog/:id", requireStaff, async (req, res) => {
    const idResult = uuidParamSchema.safeParse(req.params.id);
    if (!idResult.success) {
        res.status(400).json({ error: "validation_error", fields: { id: "invalid_id" } });
        return;
    }
    const parsed = changelogSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "validation_error", fields: zodFieldErrors(parsed.error) });
        return;
    }
    const { version, title, publishedAt, categories, body } = parsed.data;
    const { rows } = await pool.query(`UPDATE changelog_entries
     SET version = $1, title = $2, published_at = $3, categories = $4, body = $5
     WHERE id = $6
     RETURNING id, version, title, published_at, categories, body`, [version, title, publishedAt, categories, body, idResult.data]);
    const entry = rows[0];
    if (!entry) {
        res.status(404).json({ error: "not_found" });
        return;
    }
    res.status(200).json({ entry: mapChangelogRow(entry) });
});
staffRouter.delete("/changelog/:id", requireStaff, async (req, res) => {
    const idResult = uuidParamSchema.safeParse(req.params.id);
    if (!idResult.success) {
        res.status(400).json({ error: "validation_error", fields: { id: "invalid_id" } });
        return;
    }
    const { rowCount } = await pool.query(`DELETE FROM changelog_entries WHERE id = $1`, [
        idResult.data,
    ]);
    if (!rowCount) {
        res.status(404).json({ error: "not_found" });
        return;
    }
    res.status(200).json({ ok: true });
});
// --- events CRUD -----------------------------------------------------------
staffRouter.post("/events", requireStaff, async (req, res) => {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "validation_error", fields: zodFieldErrors(parsed.error) });
        return;
    }
    const { title, description, category, startsAt, prizeText, featured } = parsed.data;
    const { rows } = await pool.query(`INSERT INTO events (title, description, category, starts_at, prize_text, featured)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, description, category, starts_at, prize_text, featured, created_at`, [title, description, category, startsAt, prizeText ?? null, featured]);
    res.status(201).json({ event: mapEventRow(rows[0]) });
});
staffRouter.put("/events/:id", requireStaff, async (req, res) => {
    const idResult = uuidParamSchema.safeParse(req.params.id);
    if (!idResult.success) {
        res.status(400).json({ error: "validation_error", fields: { id: "invalid_id" } });
        return;
    }
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "validation_error", fields: zodFieldErrors(parsed.error) });
        return;
    }
    const { title, description, category, startsAt, prizeText, featured } = parsed.data;
    const { rows } = await pool.query(`UPDATE events
     SET title = $1, description = $2, category = $3, starts_at = $4, prize_text = $5, featured = $6
     WHERE id = $7
     RETURNING id, title, description, category, starts_at, prize_text, featured, created_at`, [title, description, category, startsAt, prizeText ?? null, featured, idResult.data]);
    const event = rows[0];
    if (!event) {
        res.status(404).json({ error: "not_found" });
        return;
    }
    res.status(200).json({ event: mapEventRow(event) });
});
staffRouter.delete("/events/:id", requireStaff, async (req, res) => {
    const idResult = uuidParamSchema.safeParse(req.params.id);
    if (!idResult.success) {
        res.status(400).json({ error: "validation_error", fields: { id: "invalid_id" } });
        return;
    }
    const { rowCount } = await pool.query(`DELETE FROM events WHERE id = $1`, [idResult.data]);
    if (!rowCount) {
        res.status(404).json({ error: "not_found" });
        return;
    }
    res.status(200).json({ ok: true });
});
// --- home stats --------------------------------------------------------
/**
 * PUT /staff/home-stats/:key
 *
 * Upserts the value for `key` (home_stats.key is its primary key, no
 * fixed enum of allowed keys at the DB layer) so this works whether or
 * not the row was pre-seeded. A blank body `value` fails validation
 * before any query runs.
 */
staffRouter.put("/home-stats/:key", requireStaff, async (req, res) => {
    const keyResult = z.string().trim().min(1).max(64).safeParse(req.params.key);
    if (!keyResult.success) {
        res.status(400).json({ error: "validation_error", fields: { key: "invalid_key" } });
        return;
    }
    const parsed = homeStatSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "validation_error", fields: zodFieldErrors(parsed.error) });
        return;
    }
    const { rows } = await pool.query(`INSERT INTO home_stats (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     RETURNING key, value`, [keyResult.data, parsed.data.value]);
    res.status(200).json({ stat: rows[0] });
});
// --- store catalog management ----------------------------------------------
staffRouter.get("/store-items", requireStaff, async (_req, res) => {
    const { rows } = await pool.query(`SELECT id, name, description, price_cents, category, item_key, image_url, active, stock_quantity
     FROM store_items ORDER BY active DESC, category ASC, name ASC`);
    res.json({ items: rows.map(mapStaffStoreItem) });
});
staffRouter.post("/store-items", requireStaff, async (req, res) => {
    const parsed = storeItemSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "validation_error", fields: zodFieldErrors(parsed.error) });
        return;
    }
    const item = parsed.data;
    const { rows } = await pool.query(`INSERT INTO store_items (name, description, price_diamonds, price_cents, category, item_key, image_url, active, stock_quantity)
     VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, description, price_cents, category, item_key, image_url, active, stock_quantity`, [item.name, item.description, item.priceCents, item.category, item.itemKey ?? null, item.imageUrl ?? null, item.active, item.stockQuantity ?? null]);
    res.status(201).json({ item: mapStaffStoreItem(rows[0]) });
});
staffRouter.put("/store-items/:id", requireStaff, async (req, res) => {
    const id = uuidParamSchema.safeParse(req.params.id);
    if (!id.success) {
        res.status(400).json({ error: "validation_error", fields: { id: "invalid_id" } });
        return;
    }
    const parsed = storeItemSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "validation_error", fields: zodFieldErrors(parsed.error) });
        return;
    }
    const item = parsed.data;
    const { rows } = await pool.query(`UPDATE store_items SET name=$1, description=$2, price_cents=$3, category=$4, item_key=$5,
       image_url=$6, active=$7, stock_quantity=$8
     WHERE id=$9
     RETURNING id, name, description, price_cents, category, item_key, image_url, active, stock_quantity`, [item.name, item.description, item.priceCents, item.category, item.itemKey ?? null, item.imageUrl ?? null, item.active, item.stockQuantity ?? null, id.data]);
    if (!rows[0]) {
        res.status(404).json({ error: "not_found" });
        return;
    }
    res.json({ item: mapStaffStoreItem(rows[0]) });
});
staffRouter.delete("/store-items/:id", requireStaff, async (req, res) => {
    const id = uuidParamSchema.safeParse(req.params.id);
    if (!id.success) {
        res.status(400).json({ error: "validation_error", fields: { id: "invalid_id" } });
        return;
    }
    // Soft-delete: old orders keep their FK and historical product details.
    const { rowCount } = await pool.query(`UPDATE store_items SET active=false WHERE id=$1`, [id.data]);
    if (!rowCount) {
        res.status(404).json({ error: "not_found" });
        return;
    }
    res.json({ ok: true });
});
// --- player entitlements --------------------------------------------------
staffRouter.get("/players", requireStaff, async (req, res) => {
    const parsed = z.string().trim().min(2).max(64).safeParse(req.query.search);
    if (!parsed.success) {
        res.status(400).json({ error: "validation_error", fields: { search: "Informe pelo menos 2 caracteres." } });
        return;
    }
    const { rows } = await pool.query(`SELECT id, display_name, discord_username, fivem_license
     FROM players
     WHERE display_name ILIKE '%' || $1 || '%' OR discord_username ILIKE '%' || $1 || '%'
     ORDER BY display_name ASC LIMIT 20`, [parsed.data]);
    res.json({ players: rows.map((row) => ({
            id: row.id,
            displayName: row.display_name,
            discordUsername: row.discord_username,
            linkedToFiveM: row.fivem_license !== null,
        })) });
});
staffRouter.post("/players/:id/entitlements", requireStaff, requireStaffAdmin, async (req, res) => {
    const idResult = uuidParamSchema.safeParse(req.params.id);
    if (!idResult.success) {
        res.status(400).json({ error: "validation_error", fields: { id: "invalid_id" } });
        return;
    }
    const parsed = entitlementSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "validation_error", fields: zodFieldErrors(parsed.error) });
        return;
    }
    const { rows: players } = await pool.query(`SELECT id, fivem_license FROM players WHERE id = $1`, [idResult.data]);
    if (!players[0]) {
        res.status(404).json({ error: "player_not_found" });
        return;
    }
    if (!players[0].fivem_license) {
        res.status(409).json({ error: "player_not_linked_to_fivem" });
        return;
    }
    const { kind, key, durationUnit, quantity } = parsed.data;
    const expiresAt = entitlementExpiry(durationUnit, quantity);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const inserted = await client.query(`INSERT INTO player_entitlements (player_id, kind, entitlement_key, duration_unit, expires_at, created_by_staff)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, granted_at, expires_at`, [idResult.data, kind, key, durationUnit, expiresAt, req.staff.staffId]);
        await client.query(`INSERT INTO staff_audit_logs (staff_id, action, target_player_id, details)
       VALUES ($1, 'entitlement.grant', $2, $3::jsonb)`, [req.staff.staffId, idResult.data, JSON.stringify({ entitlementId: inserted.rows[0].id, kind, key, durationUnit, quantity, expiresAt })]);
        await client.query("COMMIT");
        res.status(201).json({ entitlement: {
                id: inserted.rows[0].id, kind, key, durationUnit,
                grantedAt: inserted.rows[0].granted_at, expiresAt: inserted.rows[0].expires_at,
            } });
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
});
staffRouter.delete("/entitlements/:id", requireStaff, requireStaffAdmin, async (req, res) => {
    const idResult = uuidParamSchema.safeParse(req.params.id);
    if (!idResult.success) {
        res.status(400).json({ error: "validation_error", fields: { id: "invalid_id" } });
        return;
    }
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query(`UPDATE player_entitlements SET revoked_at = now()
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING player_id, kind, entitlement_key`, [idResult.data]);
        if (!rows[0]) {
            await client.query("ROLLBACK");
            res.status(404).json({ error: "entitlement_not_found" });
            return;
        }
        await client.query(`INSERT INTO staff_audit_logs (staff_id, action, target_player_id, details)
       VALUES ($1, 'entitlement.revoke', $2, $3::jsonb)`, [req.staff.staffId, rows[0].player_id, JSON.stringify({ entitlementId: idResult.data, kind: rows[0].kind, key: rows[0].entitlement_key })]);
        await client.query("COMMIT");
        res.status(200).json({ ok: true });
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
});
