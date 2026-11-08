import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Router, type Request, type Response } from "express";
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
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return `scrypt:${salt}:${derivedKey.toString("hex")}`;
}

/**
 * Verifies a plaintext password against a `scrypt:<salt>:<hash>` string
 * produced by hashPassword. Recomputes the derived key with the same salt
 * and compares with a constant-time comparison (timingSafeEqual) rather
 * than `===`, so response timing doesn't leak how many leading bytes
 * matched.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hashHex] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hashHex) {
    return false;
  }
  const derivedKey = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
  const storedBuf = Buffer.from(hashHex, "hex");
  if (storedBuf.length !== derivedKey.length) {
    return false;
  }
  return timingSafeEqual(storedBuf, derivedKey);
}

/** Flattens a ZodError into { fieldPath: firstMessage }, project's `fields` shape. */
function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
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

interface StaffStoreItemRow {
  id: string; name: string; description: string; price_cents: string | number;
  category: string; item_key: string | null; image_url: string | null; active: boolean; stock_quantity: number | null;
}
function mapStaffStoreItem(row: StaffStoreItemRow) {
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

function entitlementExpiry(unit: "days" | "months" | "years" | "lifetime", quantity: number): Date | null {
  if (unit === "lifetime") return null;
  const date = new Date();
  if (unit === "days") date.setUTCDate(date.getUTCDate() + quantity);
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

interface ChangelogRow {
  id: string;
  version: string;
  title: string;
  published_at: Date;
  categories: string[];
  body: string;
}

function mapChangelogRow(row: ChangelogRow) {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    publishedAt: row.published_at,
    categories: row.categories,
    body: row.body,
  };
}

interface EventRow {
  id: string;
  title: string;
  description: string;
  category: string;
  starts_at: Date;
  prize_text: string | null;
  featured: boolean;
  created_at: Date;
}

function mapEventRow(row: EventRow) {
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

interface StaffAccountRow {
  id: string;
  password_hash: string;
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

  const { rows } = await pool.query<StaffAccountRow>(
    `SELECT id, password_hash FROM staff_accounts WHERE username = $1`,
    [username]
  );
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

// Record successful Staff mutations without persisting request bodies, which
// may contain credentials, tokens, or other sensitive input. Entitlement and
// role changes are logged transactionally by their own handlers.
staffRouter.use((req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) { next(); return; }
  requireStaff(req, res, () => {
    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 400 || !req.staff) return;
      if (req.path.startsWith("/players/") && req.path.includes("/entitlements")) return;
      if (req.path.startsWith("/team/") && req.path.endsWith("/role")) return;
      const target = req.path.startsWith("/players/") && typeof req.params.id === "string" && /^[0-9a-f-]{36}$/i.test(req.params.id) ? req.params.id : null;
      void pool.query(
        `INSERT INTO staff_audit_logs (staff_id, action, target_player_id, details) VALUES ($1,$2,$3,$4::jsonb)`,
        [req.staff.staffId, `staff.${req.method.toLowerCase()}`, target, JSON.stringify({ path: req.path, statusCode: res.statusCode })]
      ).catch(error => console.error("failed to write staff audit log", error));
    });
    next();
  });
});

// --- changelog CRUD -------------------------------------------------------

staffRouter.post("/changelog", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"content.manage"))) return;
  const parsed = changelogSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", fields: zodFieldErrors(parsed.error) });
    return;
  }
  const { version, title, publishedAt, categories, body } = parsed.data;

  const { rows } = await pool.query<ChangelogRow>(
    `INSERT INTO changelog_entries (version, title, published_at, categories, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, version, title, published_at, categories, body`,
    [version, title, publishedAt, categories, body]
  );

  res.status(201).json({ entry: mapChangelogRow(rows[0]) });
});

staffRouter.put("/changelog/:id", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"content.manage"))) return;
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

  const { rows } = await pool.query<ChangelogRow>(
    `UPDATE changelog_entries
     SET version = $1, title = $2, published_at = $3, categories = $4, body = $5
     WHERE id = $6
     RETURNING id, version, title, published_at, categories, body`,
    [version, title, publishedAt, categories, body, idResult.data]
  );

  const entry = rows[0];
  if (!entry) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  res.status(200).json({ entry: mapChangelogRow(entry) });
});

staffRouter.delete("/changelog/:id", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"content.manage"))) return;
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
  if (!(await requirePermission(req,res,"content.manage"))) return;
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", fields: zodFieldErrors(parsed.error) });
    return;
  }
  const { title, description, category, startsAt, prizeText, featured } = parsed.data;

  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events (title, description, category, starts_at, prize_text, featured)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, description, category, starts_at, prize_text, featured, created_at`,
    [title, description, category, startsAt, prizeText ?? null, featured]
  );

  res.status(201).json({ event: mapEventRow(rows[0]) });
});

staffRouter.put("/events/:id", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"content.manage"))) return;
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

  const { rows } = await pool.query<EventRow>(
    `UPDATE events
     SET title = $1, description = $2, category = $3, starts_at = $4, prize_text = $5, featured = $6
     WHERE id = $7
     RETURNING id, title, description, category, starts_at, prize_text, featured, created_at`,
    [title, description, category, startsAt, prizeText ?? null, featured, idResult.data]
  );

  const event = rows[0];
  if (!event) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  res.status(200).json({ event: mapEventRow(event) });
});

staffRouter.delete("/events/:id", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"content.manage"))) return;
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
  if (!(await requirePermission(req,res,"content.manage"))) return;
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

  const { rows } = await pool.query<{ key: string; value: string }>(
    `INSERT INTO home_stats (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     RETURNING key, value`,
    [keyResult.data, parsed.data.value]
  );

  res.status(200).json({ stat: rows[0] });
});

// --- store catalog management ----------------------------------------------

staffRouter.get("/store-items", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"store.read"))) return;
  const { rows } = await pool.query<StaffStoreItemRow>(
    `SELECT id, name, description, price_cents, category, item_key, image_url, active, stock_quantity
     FROM store_items ORDER BY active DESC, category ASC, name ASC`
  );
  res.json({ items: rows.map(mapStaffStoreItem) });
});

staffRouter.post("/store-items", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"store.manage"))) return;
  const parsed = storeItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", fields: zodFieldErrors(parsed.error) });
    return;
  }
  const item = parsed.data;
  const { rows } = await pool.query<StaffStoreItemRow>(
    `INSERT INTO store_items (name, description, price_diamonds, price_cents, category, item_key, image_url, active, stock_quantity)
     VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, description, price_cents, category, item_key, image_url, active, stock_quantity`,
    [item.name, item.description, item.priceCents, item.category, item.itemKey ?? null, item.imageUrl ?? null, item.active, item.stockQuantity ?? null]
  );
  res.status(201).json({ item: mapStaffStoreItem(rows[0]) });
});

staffRouter.put("/store-items/:id", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"store.manage"))) return;
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
  const { rows } = await pool.query<StaffStoreItemRow>(
    `UPDATE store_items SET name=$1, description=$2, price_cents=$3, category=$4, item_key=$5,
       image_url=$6, active=$7, stock_quantity=$8
     WHERE id=$9
     RETURNING id, name, description, price_cents, category, item_key, image_url, active, stock_quantity`,
    [item.name, item.description, item.priceCents, item.category, item.itemKey ?? null, item.imageUrl ?? null, item.active, item.stockQuantity ?? null, id.data]
  );
  if (!rows[0]) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ item: mapStaffStoreItem(rows[0]) });
});

staffRouter.delete("/store-items/:id", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"store.manage"))) return;
  const id = uuidParamSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: "validation_error", fields: { id: "invalid_id" } });
    return;
  }
  // Soft-delete: old orders keep their FK and historical product details.
  const { rowCount } = await pool.query(`UPDATE store_items SET active=false WHERE id=$1`, [id.data]);
  if (!rowCount) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ ok: true });
});

// --- operations center, player directory, audit and staff team -------------

staffRouter.get("/dashboard/summary", requireStaff, async (_req, res) => {
  const [players, linked, entitlements, orders, revenue, products, events, staff] = await Promise.all([
    pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM players`),
    pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM players WHERE fivem_license IS NOT NULL`),
    pool.query<{ count: string; lifetime: string }>(`SELECT count(*)::text AS count, count(*) FILTER (WHERE expires_at IS NULL)::text AS lifetime FROM player_entitlements WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`),
    pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM orders`),
    pool.query<{ total: string }>(`SELECT COALESCE(sum(total_cents),0)::text AS total FROM orders WHERE status IN ('paid','processing','delivered')`),
    pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM store_items WHERE active = true`),
    pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM events WHERE starts_at >= now()`),
    pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM staff_accounts`),
  ]);
  res.json({ summary: {
    players: Number(players.rows[0].count), linkedPlayers: Number(linked.rows[0].count),
    activeEntitlements: Number(entitlements.rows[0].count), lifetimeEntitlements: Number(entitlements.rows[0].lifetime),
    orders: Number(orders.rows[0].count), revenueCents: Number(revenue.rows[0].total),
    activeProducts: Number(products.rows[0].count), upcomingEvents: Number(events.rows[0].count), staffMembers: Number(staff.rows[0].count),
  }});
});

staffRouter.get("/players/all", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"players.read"))) return;
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 80) : "";
  const { rows } = await pool.query<{
    id: string; display_name: string; discord_username: string; discord_id: string;
    fivem_license: string | null; created_at: Date; matches: number; wins: number;
    active_entitlements: number; orders_count: number;
  }>(
    `SELECT p.id, p.display_name, p.discord_username, p.discord_id, p.fivem_license, p.created_at,
       COALESCE(ps.matches,0)::int AS matches, COALESCE(ps.wins,0)::int AS wins,
       (SELECT count(*)::int FROM player_entitlements pe WHERE pe.player_id=p.id AND pe.revoked_at IS NULL AND (pe.expires_at IS NULL OR pe.expires_at > now())) AS active_entitlements,
       (SELECT count(*)::int FROM orders o WHERE o.player_id=p.id)::int AS orders_count
     FROM players p LEFT JOIN player_stats ps ON ps.player_id=p.id AND ps.mode='global'
     WHERE ($1 = '' OR p.display_name ILIKE '%'||$1||'%' OR p.discord_username ILIKE '%'||$1||'%' OR p.discord_id ILIKE '%'||$1||'%' OR COALESCE(p.fivem_license,'') ILIKE '%'||$1||'%')
     ORDER BY p.created_at DESC LIMIT 500`, [search]
  );
  res.json({ players: rows.map(r => ({ id:r.id, displayName:r.display_name, discordUsername:r.discord_username, discordId:r.discord_id, fivemLicense:r.fivem_license, linkedToFiveM:!!r.fivem_license, createdAt:r.created_at, matches:r.matches, wins:r.wins, activeEntitlements:r.active_entitlements, ordersCount:r.orders_count })) });
});

staffRouter.get("/audit", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"audit.read"))) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250);
  const { rows } = await pool.query<{
    id:string; action:string; details:unknown; created_at:Date; username:string | null;
    target_player_id:string | null; display_name:string | null;
  }>(
    `SELECT a.id,a.action,a.details,a.created_at,s.username,p.id AS target_player_id,p.display_name
       FROM staff_audit_logs a LEFT JOIN staff_accounts s ON s.id=a.staff_id
       LEFT JOIN players p ON p.id=a.target_player_id
      ORDER BY a.created_at DESC LIMIT $1`, [limit]
  );
  res.json({ entries: rows.map(r => ({ id:r.id, action:r.action, details:r.details, createdAt:r.created_at, staffUsername:r.username ?? 'Conta removida', targetPlayerId:r.target_player_id, targetPlayerName:r.display_name })) });
});

staffRouter.get("/team", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"team.manage"))) return;
  const { rows } = await pool.query<{ id:string; username:string; role:string; created_at:Date }>(
    `SELECT id, username, role, created_at FROM staff_accounts ORDER BY created_at ASC`
  );
  res.json({ members: rows.map(r => ({ id:r.id, username:r.username, role:r.role, createdAt:r.created_at })) });
});

staffRouter.patch("/team/:id/role", requireStaff, requireStaffAdmin, async (req, res) => {
  const id = uuidParamSchema.safeParse(req.params.id);
  const role = z.enum(["admin","moderator","attendant"]).safeParse(req.body?.role);
  if (!id.success || !role.success) {
    res.status(400).json({ error:"validation_error", fields:{ ...(!id.success ? {id:"invalid_id"}:{}), ...(!role.success ? {role:"invalid_role"}:{}) } });
    return;
  }
  if (id.data === req.staff!.staffId && role.data !== "admin") {
    res.status(409).json({ error:"cannot_demote_self" });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ id:string; username:string; role:string }>(
      `UPDATE staff_accounts SET role=$1 WHERE id=$2 RETURNING id,username,role`, [role.data,id.data]
    );
    if (!updated.rows[0]) { await client.query("ROLLBACK"); res.status(404).json({error:"staff_not_found"}); return; }
    await client.query(`INSERT INTO staff_audit_logs (staff_id,action,details) VALUES ($1,'staff.role.update',$2::jsonb)`,
      [req.staff!.staffId, JSON.stringify({ targetStaffId:id.data, username:updated.rows[0].username, role:role.data })]);
    await client.query("COMMIT");
    res.json({ member:updated.rows[0] });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

// --- player entitlements --------------------------------------------------

staffRouter.get("/players", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"players.read"))) return;
  const parsed = z.string().trim().min(2).max(64).safeParse(req.query.search);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", fields: { search: "Informe pelo menos 2 caracteres." } });
    return;
  }
  const { rows } = await pool.query<{ id: string; display_name: string; discord_username: string; fivem_license: string | null }>(
    `SELECT id, display_name, discord_username, fivem_license
     FROM players
     WHERE display_name ILIKE '%' || $1 || '%' OR discord_username ILIKE '%' || $1 || '%'
     ORDER BY display_name ASC LIMIT 20`,
    [parsed.data]
  );
  res.json({ players: rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    discordUsername: row.discord_username,
    linkedToFiveM: row.fivem_license !== null,
  })) });
});

// Lista todos os jogadores com benefícios atualmente liberados para a equipe.
staffRouter.get("/authorized-players", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"players.read"))) return;
  const { rows } = await pool.query<{
    player_id: string; display_name: string; discord_username: string;
    fivem_license: string | null; entitlement_id: string; kind: string;
    entitlement_key: string; duration_unit: string; granted_at: Date; expires_at: Date | null;
  }>(
    `SELECT p.id AS player_id, p.display_name, p.discord_username, p.fivem_license,
            e.id AS entitlement_id, e.kind, e.entitlement_key, e.duration_unit,
            e.granted_at, e.expires_at
       FROM player_entitlements e
       JOIN players p ON p.id = e.player_id
      WHERE e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > now())
      ORDER BY p.display_name ASC, e.granted_at DESC`
  );
  res.json({ players: rows.map((row) => ({
    playerId: row.player_id, displayName: row.display_name,
    discordUsername: row.discord_username, linkedToFiveM: row.fivem_license !== null,
    entitlement: { id: row.entitlement_id, kind: row.kind, key: row.entitlement_key,
      durationUnit: row.duration_unit, grantedAt: row.granted_at, expiresAt: row.expires_at }
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

  const { rows: players } = await pool.query<{ id: string; fivem_license: string | null }>(
    `SELECT id, fivem_license FROM players WHERE id = $1`, [idResult.data]
  );
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
    const inserted = await client.query<{ id: string; granted_at: Date; expires_at: Date | null }>(
      `INSERT INTO player_entitlements (player_id, kind, entitlement_key, duration_unit, expires_at, created_by_staff)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, granted_at, expires_at`,
      [idResult.data, kind, key, durationUnit, expiresAt, req.staff!.staffId]
    );
    await client.query(
      `INSERT INTO staff_audit_logs (staff_id, action, target_player_id, details)
       VALUES ($1, 'entitlement.grant', $2, $3::jsonb)`,
      [req.staff!.staffId, idResult.data, JSON.stringify({ entitlementId: inserted.rows[0].id, kind, key, durationUnit, quantity, expiresAt })]
    );
    await client.query("COMMIT");
    res.status(201).json({ entitlement: {
      id: inserted.rows[0].id, kind, key, durationUnit,
      grantedAt: inserted.rows[0].granted_at, expiresAt: inserted.rows[0].expires_at,
    } });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
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
    const { rows } = await client.query<{ player_id: string; kind: string; entitlement_key: string }>(
      `UPDATE player_entitlements SET revoked_at = now()
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING player_id, kind, entitlement_key`, [idResult.data]
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "entitlement_not_found" });
      return;
    }
    await client.query(
      `INSERT INTO staff_audit_logs (staff_id, action, target_player_id, details)
       VALUES ($1, 'entitlement.revoke', $2, $3::jsonb)`,
      [req.staff!.staffId, rows[0].player_id, JSON.stringify({ entitlementId: idResult.data, kind: rows[0].kind, key: rows[0].entitlement_key })]
    );
    await client.query("COMMIT");
    res.status(200).json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});


// --- complete administration suite -----------------------------------------
async function staffCan(staffId: string, permission: string): Promise<boolean> {
  const { rows } = await pool.query<{ role: string; effect: string | null }>(
    `SELECT s.role, (SELECT p.effect FROM staff_account_permissions p WHERE p.staff_id=s.id AND p.permission=$2) AS effect
       FROM staff_accounts s WHERE s.id=$1`, [staffId, permission]
  );
  if (!rows[0]) return false;
  if (rows[0].role === "admin") return true;
  if (rows[0].effect) return rows[0].effect === "allow";
  const defaults: Record<string, string[]> = {
    moderator: ["players.read","punishments.read","punishments.manage","tickets.read","tickets.manage","orders.read","monitor.read"],
    attendant: ["players.read","punishments.read","tickets.read","tickets.manage","orders.read","monitor.read"],
  };
  return (defaults[rows[0].role] ?? []).includes(permission);
}

async function requirePermission(req: Request, res: Response, permission: string): Promise<boolean> {
  if (!req.staff?.staffId) { res.status(401).json({ error: "unauthenticated" }); return false; }
  if (!(await staffCan(req.staff.staffId, permission))) { res.status(403).json({ error: "forbidden", permission }); return false; }
  return true;
}

staffRouter.get("/players/:id/admin-profile", requireStaff, async (req, res) => {
  if (!(await requirePermission(req,res,"players.read"))) return;
  const id = uuidParamSchema.safeParse(req.params.id);
  if (!id.success) { res.status(400).json({error:"invalid_player_id"}); return; }
  const [player, entitlements, punishments, notes, orders] = await Promise.all([
    pool.query(`SELECT p.id,p.discord_id,p.discord_username,p.display_name,p.fivem_license,p.created_at,
      COALESCE(ps.matches,0)::int AS matches,COALESCE(ps.wins,0)::int AS wins,COALESCE(ps.kd,0)::float AS kd
      FROM players p LEFT JOIN player_stats ps ON ps.player_id=p.id AND ps.mode='global' WHERE p.id=$1`,[id.data]),
    pool.query(`SELECT id,kind,entitlement_key,duration_unit,granted_at,expires_at,revoked_at FROM player_entitlements WHERE player_id=$1 ORDER BY granted_at DESC LIMIT 100`,[id.data]),
    pool.query(`SELECT id,type,reason,evidence_url,expires_at,revoked_at,created_at FROM player_punishments WHERE player_id=$1 ORDER BY created_at DESC LIMIT 100`,[id.data]),
    pool.query(`SELECT n.id,n.note,n.created_at,s.username FROM staff_player_notes n LEFT JOIN staff_accounts s ON s.id=n.created_by_staff WHERE n.player_id=$1 ORDER BY n.created_at DESC LIMIT 100`,[id.data]),
    pool.query(`SELECT id,status,total_cents,payment_method,created_at FROM orders WHERE player_id=$1 ORDER BY created_at DESC LIMIT 50`,[id.data]),
  ]);
  if (!player.rows[0]) { res.status(404).json({error:"player_not_found"}); return; }
  res.json({ player:player.rows[0], entitlements:entitlements.rows, punishments:punishments.rows, notes:notes.rows, orders:orders.rows });
});

staffRouter.post("/players/:id/notes", requireStaff, async (req,res) => {
  if (!(await requirePermission(req,res,"players.manage"))) return;
  const id=uuidParamSchema.safeParse(req.params.id);
  const note=z.string().trim().min(3).max(2000).safeParse(req.body?.note);
  if(!id.success||!note.success){res.status(400).json({error:"validation_error"});return;}
  const exists=await pool.query(`SELECT 1 FROM players WHERE id=$1`,[id.data]);
  if(!exists.rowCount){res.status(404).json({error:"player_not_found"});return;}
  const {rows}=await pool.query(`INSERT INTO staff_player_notes(player_id,note,created_by_staff) VALUES($1,$2,$3) RETURNING id,note,created_at`,[id.data,note.data,req.staff!.staffId]);
  await pool.query(`INSERT INTO staff_audit_logs(staff_id,action,target_player_id,details) VALUES($1,'player.note.create',$2,$3::jsonb)`,[req.staff!.staffId,id.data,JSON.stringify({noteId:rows[0].id})]);
  res.status(201).json({note:rows[0]});
});

staffRouter.get("/punishments", requireStaff, async (req,res) => {
  if (!(await requirePermission(req,res,"punishments.read"))) return;
  const {rows}=await pool.query(`SELECT b.id,b.player_id,p.display_name,p.discord_username,b.type,b.reason,b.evidence_url,b.expires_at,b.revoked_at,b.created_at,s.username AS staff_username
    FROM player_punishments b JOIN players p ON p.id=b.player_id LEFT JOIN staff_accounts s ON s.id=b.created_by_staff
    ORDER BY b.created_at DESC LIMIT 300`);
  res.json({punishments:rows});
});

staffRouter.post("/players/:id/punishments", requireStaff, async (req,res) => {
  if (!(await requirePermission(req,res,"punishments.manage"))) return;
  const id=uuidParamSchema.safeParse(req.params.id);
  const type=z.enum(["warning","temporary_ban","permanent_ban"]).safeParse(req.body?.type);
  const reason=z.string().trim().min(5).max(1000).safeParse(req.body?.reason);
  const evidence=z.string().url().max(500).nullable().optional().safeParse(req.body?.evidenceUrl ?? null);
  const expiresAt=req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
  if(!id.success||!type.success||!reason.success||!evidence.success||(type.data==="temporary_ban"&&(!expiresAt||Number.isNaN(expiresAt.getTime())||expiresAt<=new Date()))){
    res.status(400).json({error:"validation_error",fields:{form:"Confira jogador, tipo, motivo e validade."}});return;
  }
  const player=await pool.query(`SELECT id FROM players WHERE id=$1`,[id.data]);
  if(!player.rowCount){res.status(404).json({error:"player_not_found"});return;}
  const {rows}=await pool.query(`INSERT INTO player_punishments(player_id,type,reason,evidence_url,expires_at,created_by_staff)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[id.data,type.data,reason.data,evidence.data,expiresAt,req.staff!.staffId]);
  await pool.query(`INSERT INTO staff_audit_logs(staff_id,action,target_player_id,details) VALUES($1,'punishment.create',$2,$3::jsonb)`,
    [req.staff!.staffId,id.data,JSON.stringify({punishmentId:rows[0].id,type:type.data,expiresAt})]);
  res.status(201).json({punishment:rows[0]});
});

staffRouter.post("/punishments/:id/revoke", requireStaff, async (req,res) => {
  if (!(await requirePermission(req,res,"punishments.manage"))) return;
  const id=uuidParamSchema.safeParse(req.params.id);
  if(!id.success){res.status(400).json({error:"invalid_id"});return;}
  const {rows}=await pool.query(`UPDATE player_punishments SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id,player_id,type`,[id.data]);
  if(!rows[0]){res.status(404).json({error:"punishment_not_found"});return;}
  await pool.query(`INSERT INTO staff_audit_logs(staff_id,action,target_player_id,details) VALUES($1,'punishment.revoke',$2,$3::jsonb)`,
    [req.staff!.staffId,rows[0].player_id,JSON.stringify({punishmentId:id.data,type:rows[0].type})]);
  res.json({ok:true});
});

staffRouter.get("/tickets", requireStaff, async (req,res) => {
  if (!(await requirePermission(req,res,"tickets.read"))) return;
  const status=typeof req.query.status==="string"?req.query.status:"";
  const {rows}=await pool.query(`SELECT t.id,t.player_id,p.display_name,t.subject,t.body,t.category,t.priority,t.status,t.created_at,t.updated_at,
    a.username AS assigned_username,c.username AS created_by_username
    FROM staff_tickets t LEFT JOIN players p ON p.id=t.player_id LEFT JOIN staff_accounts a ON a.id=t.assigned_staff
    LEFT JOIN staff_accounts c ON c.id=t.created_by_staff
    WHERE ($1='' OR t.status=$1) ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,t.updated_at DESC LIMIT 300`,[status]);
  res.json({tickets:rows});
});

staffRouter.post("/tickets", requireStaff, async (req,res) => {
  if (!(await requirePermission(req,res,"tickets.manage"))) return;
  const subject=z.string().trim().min(4).max(160).safeParse(req.body?.subject);
  const body=z.string().trim().min(5).max(5000).safeParse(req.body?.body);
  const category=z.enum(["support","report","appeal","technical","other"]).safeParse(req.body?.category ?? "support");
  const priority=z.enum(["low","normal","high","urgent"]).safeParse(req.body?.priority ?? "normal");
  const playerId=req.body?.playerId ? uuidParamSchema.safeParse(req.body.playerId) : null;
  if(!subject.success||!body.success||!category.success||!priority.success||(playerId&&!playerId.success)){res.status(400).json({error:"validation_error"});return;}
  const {rows}=await pool.query(`INSERT INTO staff_tickets(player_id,subject,body,category,priority,created_by_staff)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[playerId?.data??null,subject.data,body.data,category.data,priority.data,req.staff!.staffId]);
  await pool.query(`INSERT INTO staff_audit_logs(staff_id,action,details) VALUES($1,'ticket.create',$2::jsonb)`,[req.staff!.staffId,JSON.stringify({ticketId:rows[0].id,category:category.data})]);
  res.status(201).json({ticket:rows[0]});
});

staffRouter.patch("/tickets/:id", requireStaff, async (req,res) => {
  if (!(await requirePermission(req,res,"tickets.manage"))) return;
  const id=uuidParamSchema.safeParse(req.params.id);
  const status=z.enum(["open","in_progress","resolved","closed"]).safeParse(req.body?.status);
  const priority=z.enum(["low","normal","high","urgent"]).optional().safeParse(req.body?.priority);
  if(!id.success||!status.success||!priority.success){res.status(400).json({error:"validation_error"});return;}
  const {rows}=await pool.query(`UPDATE staff_tickets SET status=$1,priority=COALESCE($2,priority),updated_at=now() WHERE id=$3 RETURNING *`,[status.data,priority.data??null,id.data]);
  if(!rows[0]){res.status(404).json({error:"ticket_not_found"});return;}
  await pool.query(`INSERT INTO staff_audit_logs(staff_id,action,details) VALUES($1,'ticket.update',$2::jsonb)`,[req.staff!.staffId,JSON.stringify({ticketId:id.data,status:status.data,priority:priority.data})]);
  res.json({ticket:rows[0]});
});

staffRouter.get("/orders", requireStaff, async (req,res) => {
  if (!(await requirePermission(req,res,"orders.read"))) return;
  const {rows}=await pool.query(`SELECT o.id,o.player_id,p.display_name,p.discord_username,o.status,o.total_cents,o.payment_method,o.created_at,
    COALESCE(json_agg(json_build_object('name',si.name,'quantity',oi.quantity,'unitPriceCents',oi.unit_price_cents)) FILTER(WHERE oi.id IS NOT NULL),'[]') AS items
    FROM orders o JOIN players p ON p.id=o.player_id LEFT JOIN order_items oi ON oi.order_id=o.id LEFT JOIN store_items si ON si.id=oi.store_item_id
    GROUP BY o.id,p.id,p.display_name,p.discord_username ORDER BY o.created_at DESC LIMIT 300`);
  res.json({orders:rows});
});

staffRouter.get("/notifications", requireStaff, async (req,res) => {
  const {rows}=await pool.query(`SELECT id,title,message,severity,created_at,read_by FROM staff_notifications
    WHERE target_role IS NULL OR target_role=(SELECT role FROM staff_accounts WHERE id=$1)
    ORDER BY created_at DESC LIMIT 100`,[req.staff!.staffId]);
  res.json({notifications:rows.map(r=>({...r,read:(r.read_by??[]).includes(req.staff!.staffId)}))});
});

staffRouter.post("/notifications", requireStaff, async (req,res) => {
  if (!(await requirePermission(req,res,"notifications.manage"))) return;
  const title=z.string().trim().min(3).max(120).safeParse(req.body?.title);
  const message=z.string().trim().min(3).max(1000).safeParse(req.body?.message);
  const severity=z.enum(["info","success","warning","critical"]).safeParse(req.body?.severity??"info");
  if(!title.success||!message.success||!severity.success){res.status(400).json({error:"validation_error"});return;}
  const {rows}=await pool.query(`INSERT INTO staff_notifications(title,message,severity,created_by_staff) VALUES($1,$2,$3,$4) RETURNING id,title,message,severity,created_at`,
    [title.data,message.data,severity.data,req.staff!.staffId]);
  res.status(201).json({notification:rows[0]});
});

staffRouter.post("/notifications/:id/read", requireStaff, async (req,res) => {
  const id=uuidParamSchema.safeParse(req.params.id); if(!id.success){res.status(400).json({error:"invalid_id"});return;}
  await pool.query(`UPDATE staff_notifications SET read_by=array_append(read_by,$1) WHERE id=$2 AND NOT ($1=ANY(read_by))`,[req.staff!.staffId,id.data]);
  res.json({ok:true});
});


staffRouter.get("/team/:id/permissions", requireStaff, async (req,res) => {
  if (!(await requirePermission(req,res,"team.manage"))) return;
  const id=uuidParamSchema.safeParse(req.params.id); if(!id.success){res.status(400).json({error:"invalid_id"});return;}
  const {rows:members}=await pool.query<{role:string}>(`SELECT role FROM staff_accounts WHERE id=$1`,[id.data]);
  const member=members[0];
  if(!member){res.status(404).json({error:"staff_not_found"});return;}
  const {rows}=await pool.query<{permission:string;effect:string}>(`SELECT permission,effect FROM staff_account_permissions WHERE staff_id=$1`,[id.data]);
  const explicit=new Map(rows.map(r=>[r.permission,r.effect]));
  const all=["players.read","players.manage","punishments.read","punishments.manage","tickets.read","tickets.manage","store.read","store.manage","orders.read","content.manage","monitor.read","audit.read","team.manage","notifications.manage"];
  const defaults:Record<string,string[]>={moderator:["players.read","punishments.read","punishments.manage","tickets.read","tickets.manage","orders.read","monitor.read"],attendant:["players.read","punishments.read","tickets.read","tickets.manage","orders.read","monitor.read"]};
  const permissions=all.filter(permission=>member.role==="admin"||explicit.get(permission)==="allow"||(explicit.get(permission)!== "deny"&&(defaults[member.role]??[]).includes(permission)));
  res.json({permissions});
});

staffRouter.put("/team/:id/permissions", requireStaff, async (req,res) => {
  if (!(await requirePermission(req,res,"team.manage"))) return;
  const id=uuidParamSchema.safeParse(req.params.id);
  const permissions=z.array(z.enum(["players.read","players.manage","punishments.read","punishments.manage","tickets.read","tickets.manage","store.read","store.manage","orders.read","content.manage","monitor.read","audit.read","team.manage","notifications.manage"])).max(14).safeParse(req.body?.permissions);
  if(!id.success||!permissions.success){res.status(400).json({error:"validation_error"});return;}
  const exists=await pool.query(`SELECT id FROM staff_accounts WHERE id=$1`,[id.data]);
  if(!exists.rowCount){res.status(404).json({error:"staff_not_found"});return;}
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query(`DELETE FROM staff_account_permissions WHERE staff_id=$1`,[id.data]);
    const all=["players.read","players.manage","punishments.read","punishments.manage","tickets.read","tickets.manage","store.read","store.manage","orders.read","content.manage","monitor.read","audit.read","team.manage","notifications.manage"];
    const selected = new Set<string>(permissions.data);
    for(const permission of all) await client.query(`INSERT INTO staff_account_permissions(staff_id,permission,effect,granted_by) VALUES($1,$2,$3,$4)`,[id.data,permission,selected.has(permission)?"allow":"deny",req.staff!.staffId]);
    await client.query(`INSERT INTO staff_audit_logs(staff_id,action,details) VALUES($1,'staff.permissions.update',$2::jsonb)`,[req.staff!.staffId,JSON.stringify({targetStaffId:id.data,permissions:permissions.data})]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  res.json({ok:true,permissions:permissions.data});
});
