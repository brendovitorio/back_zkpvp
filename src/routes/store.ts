import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const storeRouter = Router();

interface StoreItemRow {
  id: string;
  name: string;
  description: string;
  price_cents: string | number;
  category: string;
  item_key?: string | null;
  image_url: string | null;
  active: boolean;
  stock_quantity: number | null;
}

storeRouter.get("/items", async (_req, res) => {
  const { rows } = await pool.query<StoreItemRow>(
    `SELECT id, name, description, price_cents, category, item_key, image_url, active, stock_quantity
     FROM store_items WHERE active = true AND price_cents > 0
     ORDER BY category, name`
  );
  res.json({ items: rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    priceCents: Number(row.price_cents),
    category: row.category,
    itemKey: row.item_key ?? null,
    imageUrl: row.image_url,
    active: row.active,
    stockQuantity: row.stock_quantity,
  })) });
});

const orderItemSchema = z.object({
  storeItemId: z.string().uuid(),
  quantity: z.number().int().positive().max(99),
});
const createOrderSchema = z.object({
  idempotencyKey: z.string().uuid(),
  items: z.array(orderItemSchema).max(50).superRefine((items, ctx) => {
    if (new Set(items.map((item) => item.storeItemId)).size !== items.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate_store_item" });
    }
  }),
});
const MAX_SAFE_TOTAL_CENTS = 2_000_000_000;

/**
 * Creates an order using only server-side catalog prices. PIX remains
 * unavailable: the order is recorded as pending_payment and no payment,
 * delivery, or paid status is simulated.
 */
storeRouter.post("/orders", requireAuth, async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_order" });
    return;
  }
  if (parsed.data.items.length === 0) {
    res.status(400).json({ error: "empty_order" });
    return;
  }

  const playerId = req.player!.playerId;
  const { items, idempotencyKey } = parsed.data;
  const payloadHash = createHash("sha256").update(JSON.stringify(items)).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string; total_cents: string | number; status: string; idempotency_payload_hash: string }>(
      `SELECT id, total_cents, status, idempotency_payload_hash FROM orders WHERE player_id = $1 AND idempotency_key = $2`,
      [playerId, idempotencyKey]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].idempotency_payload_hash !== payloadHash) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "idempotency_key_reused" });
        return;
      }
      await client.query("COMMIT");
      res.status(200).json({ order: {
        id: existing.rows[0].id,
        status: existing.rows[0].status,
        totalCents: Number(existing.rows[0].total_cents),
        paymentAvailable: false,
      } });
      return;
    }

    const ids = items.map((item) => item.storeItemId);
    const catalog = await client.query<StoreItemRow>(
      `SELECT id, name, description, price_cents, category, item_key, image_url, active, stock_quantity
       FROM store_items WHERE id = ANY($1::uuid[]) AND active = true AND price_cents > 0 FOR UPDATE`,
      [ids]
    );
    const byId = new Map(catalog.rows.map((row) => [row.id, row]));
    let totalCents = 0;
    const resolved: Array<{ storeItemId: string; quantity: number; unitPriceCents: number }> = [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let parameter = 1;

    for (const item of items) {
      const product = byId.get(item.storeItemId);
      if (!product || (product.stock_quantity !== null && product.stock_quantity < item.quantity)) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: product ? "insufficient_stock" : "invalid_store_item", storeItemId: item.storeItemId });
        return;
      }
      const unitPriceCents = Number(product.price_cents);
      totalCents += unitPriceCents * item.quantity;
      resolved.push({ storeItemId: item.storeItemId, quantity: item.quantity, unitPriceCents });
      placeholders.push(`($${parameter}, $${parameter + 1}, $${parameter + 2}, $${parameter + 3})`);
      values.push("ORDER_ID", item.storeItemId, item.quantity, unitPriceCents);
      parameter += 4;
    }

    if (totalCents <= 0 || totalCents > MAX_SAFE_TOTAL_CENTS) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "invalid_order_total" });
      return;
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO orders (player_id, status, total_diamonds, total_cents, payment_method, idempotency_key, idempotency_payload_hash)
       VALUES ($1, 'pending_payment', 0, $2, 'pix', $3, $4) RETURNING id`,
      [playerId, totalCents, idempotencyKey, payloadHash]
    );
    const orderId = inserted.rows[0].id;
    const insertValues = values.map((value) => value === "ORDER_ID" ? orderId : value);
    await client.query(
      `INSERT INTO order_items (order_id, store_item_id, quantity, unit_price_diamonds, unit_price_cents)
       VALUES ${placeholders.join(", ")}`,
      insertValues
    );
    await client.query("COMMIT");
    res.status(201).json({ order: {
      id: orderId,
      status: "pending_payment",
      totalCents,
      paymentAvailable: false,
      items: resolved,
    } });
  } catch (err) {
    await client.query("ROLLBACK");
    if (typeof err === "object" && err !== null && "code" in err && err.code === "23505") {
      const duplicate = await pool.query<{ id: string; total_cents: string | number; status: string; idempotency_payload_hash: string }>(
        `SELECT id, total_cents, status, idempotency_payload_hash FROM orders WHERE player_id = $1 AND idempotency_key = $2`,
        [playerId, idempotencyKey]
      );
      if (duplicate.rows[0]?.idempotency_payload_hash === payloadHash) {
        res.status(200).json({ order: {
          id: duplicate.rows[0].id,
          status: duplicate.rows[0].status,
          totalCents: Number(duplicate.rows[0].total_cents),
          paymentAvailable: false,
        } });
        return;
      }
    }
    throw err;
  } finally {
    client.release();
  }
});
