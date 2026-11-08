import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { app } from "../../src/index.js";
import { pool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";
import { signSession } from "../../src/services/jwt.js";

const insertedPlayerIds: string[] = [];
const insertedStoreItemIds: string[] = [];
const insertedOrderIds: string[] = [];

/** Inserts a single player row directly, bypassing the OAuth flow. */
async function seedOnePlayer(): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 9);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO players (id, discord_id, discord_username, display_name)
     VALUES ($1, $2, $3, $4)`,
    [id, `discord-${suffix}`, `fixture-user-${suffix}`, `Fixture Player ${suffix}`]
  );
  insertedPlayerIds.push(id);
  return id;
}

/** Inserts a single active store item with a known price. */
async function seedStoreItem(priceCents: number, active = true): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 9);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO store_items (id, name, description, price_diamonds, price_cents, category, active)
     VALUES ($1, $2, $3, 0, $4, $5, $6)`,
    [id, `Fixture Item ${suffix}`, "fixture item", priceCents, "fixture", active]
  );
  insertedStoreItemIds.push(id);
  return id;
}

/** Deletes order_items/orders rows for a given order id, for cleanup. */
async function trackOrder(orderId: string): Promise<void> {
  insertedOrderIds.push(orderId);
}

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  if (insertedOrderIds.length > 0) {
    await pool.query(`DELETE FROM order_items WHERE order_id = ANY($1::uuid[])`, [
      insertedOrderIds,
    ]);
    await pool.query(`DELETE FROM orders WHERE id = ANY($1::uuid[])`, [insertedOrderIds]);
  }
  if (insertedStoreItemIds.length > 0) {
    await pool.query(`DELETE FROM store_items WHERE id = ANY($1::uuid[])`, [
      insertedStoreItemIds,
    ]);
  }
  if (insertedPlayerIds.length > 0) {
    await pool.query(`DELETE FROM players WHERE id = ANY($1::uuid[])`, [insertedPlayerIds]);
  }
});

describe("GET /api/store/items", () => {
  test("returns only active items", async () => {
    const activeId = await seedStoreItem(30, true);
    const inactiveId = await seedStoreItem(50, false);

    const res = await request(app).get("/api/store/items");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: any) => i.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(inactiveId);
  });
});

describe("POST /api/store/orders", () => {
  test("without a session returns 401 and creates no order", async () => {
    const itemId = await seedStoreItem(30);
    const before = await pool.query(`select count(*)::int as n from orders`);

    const res = await request(app)
      .post("/api/store/orders")
      .send({ items: [{ storeItemId: itemId, quantity: 1 }] });

    expect(res.status).toBe(401);
    const after = await pool.query(`select count(*)::int as n from orders`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test("computes total in cents from server-side prices, ignoring any client price", async () => {
    const playerId = await seedOnePlayer();
    const sessionCookie = `session=${signSession({ playerId })}`;
    const itemWorth30 = await seedStoreItem(30);

    const res = await request(app)
      .post("/api/store/orders")
      .set("Cookie", sessionCookie)
      .send({ idempotencyKey: randomUUID(), items: [{ storeItemId: itemWorth30, quantity: 2, priceCents: 1 }] });

    expect(res.status).toBe(201);
    if (res.body.order?.id) await trackOrder(res.body.order.id);
    expect(res.body.order.totalCents).toBe(60);
    expect(res.body.order.status).toBe("pending_payment");
    expect(res.body.order.paymentAvailable).toBe(false);
  });

  test("with an empty items array returns 400", async () => {
    const playerId = await seedOnePlayer();
    const sessionCookie = `session=${signSession({ playerId })}`;

    const res = await request(app)
      .post("/api/store/orders")
      .set("Cookie", sessionCookie)
      .send({ idempotencyKey: randomUUID(), items: [] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "empty_order" });
  });

  test("ordering an inactive item's storeItemId is rejected and creates no order", async () => {
    const playerId = await seedOnePlayer();
    const sessionCookie = `session=${signSession({ playerId })}`;
    const inactiveItemId = await seedStoreItem(30, false);
    const before = await pool.query(`select count(*)::int as n from orders`);

    const res = await request(app)
      .post("/api/store/orders")
      .set("Cookie", sessionCookie)
      .send({ idempotencyKey: randomUUID(), items: [{ storeItemId: inactiveItemId, quantity: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_store_item", storeItemId: inactiveItemId });
    const after = await pool.query(`select count(*)::int as n from orders`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test("an items array over 50 entries is rejected", async () => {
    const playerId = await seedOnePlayer();
    const sessionCookie = `session=${signSession({ playerId })}`;
    const items = Array.from({ length: 51 }, () => ({
      storeItemId: randomUUID(),
      quantity: 1,
    }));

    const res = await request(app)
      .post("/api/store/orders")
      .set("Cookie", sessionCookie)
      .send({ idempotencyKey: randomUUID(), items });

    expect(res.status).toBe(400);
  });

  test("a quantity over 99 is rejected", async () => {
    const playerId = await seedOnePlayer();
    const sessionCookie = `session=${signSession({ playerId })}`;
    const itemId = await seedStoreItem(30);

    const res = await request(app)
      .post("/api/store/orders")
      .set("Cookie", sessionCookie)
      .send({ idempotencyKey: randomUUID(), items: [{ storeItemId: itemId, quantity: 100 }] });

    expect(res.status).toBe(400);
  });
});
