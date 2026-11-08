import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import request from "supertest";
import { app } from "../../src/index.js";
import { pool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";

// Unique, throwaway key so this test never collides with the real seeded
// rows (Task 7: contas_criadas, premiacao_total, campeonatos, clas,
// banidos) and can be cleaned up independently of them.
const testKey = `test_stat_${randomUUID().replace(/-/g, "")}`;

beforeAll(async () => {
  await runMigrations();
  await pool.query(
    `INSERT INTO home_stats (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [testKey, "12345"]
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM home_stats WHERE key = $1`, [testKey]);
});

test("GET /api/home-stats returns 200 with no auth/cookie at all", async () => {
  const res = await request(app).get("/api/home-stats");
  expect(res.status).toBe(200);
});

test("GET /api/home-stats returns stats keyed by the DB key column, snake_case, value as string", async () => {
  const res = await request(app).get("/api/home-stats");
  expect(res.status).toBe(200);
  expect(res.body.stats[testKey]).toBe("12345");
});

test("response has no top-level error even when staff_session cookie is absent", async () => {
  const res = await request(app).get("/api/home-stats").set("Cookie", "");
  expect(res.status).toBe(200);
  expect(res.body).not.toHaveProperty("error");
});
