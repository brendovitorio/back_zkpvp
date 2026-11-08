import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { app } from "../../src/index.js";
import { pool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";

const insertedEventIds: string[] = [];
const insertedHallOfFameIds: string[] = [];
let neutralizedFeaturedIds: string[] = [];

/**
 * The seed script (Task 7) may have left its own `featured = true` row in
 * place, which would otherwise race our fixture's "nearest future featured
 * event" and make the test's outcome depend on real-world dates. Temporarily
 * un-feature any pre-existing featured events for the duration of this
 * suite, then restore them in afterAll.
 */
async function neutralizeExistingFeaturedEvents(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM events WHERE featured = true`
  );
  neutralizedFeaturedIds = rows.map((r) => r.id);
  if (neutralizedFeaturedIds.length > 0) {
    await pool.query(`UPDATE events SET featured = false WHERE id = ANY($1::uuid[])`, [
      neutralizedFeaturedIds,
    ]);
  }
}

/**
 * Inserts events: one inside the [2026-11-02, 2026-11-08] range (not
 * featured), one outside the range, one featured in the future (should
 * win the `featured` slot), and one featured in the past (must be
 * excluded from `featured` since it's not nearest-in-the-future).
 */
async function seedEventsFixture(): Promise<void> {
  const inRangeId = randomUUID();
  const outOfRangeId = randomUUID();
  const futureFeaturedId = randomUUID();
  const pastFeaturedId = randomUUID();

  await pool.query(
    `INSERT INTO events (id, title, description, category, starts_at, prize_text, featured)
     VALUES
       ($1, 'In Range Cup', 'desc', 'torneio', '2026-11-05T18:00:00Z', 'R$ 100', false),
       ($2, 'Out Of Range Cup', 'desc', 'torneio', '2026-12-25T18:00:00Z', 'R$ 100', false),
       ($3, 'Future Featured Cup', 'desc', 'torneio', '2099-01-01T18:00:00Z', 'R$ 1000', true),
       ($4, 'Past Featured Cup', 'desc', 'torneio', '2000-01-01T18:00:00Z', 'R$ 1000', true)`,
    [inRangeId, outOfRangeId, futureFeaturedId, pastFeaturedId]
  );
  insertedEventIds.push(inRangeId, outOfRangeId, futureFeaturedId, pastFeaturedId);
}

async function seedHallOfFameFixture(): Promise<void> {
  const olderId = randomUUID();
  const newerId = randomUUID();

  await pool.query(
    `INSERT INTO hall_of_fame (id, event_name, champion_name, champion_tag, prize_text, won_at)
     VALUES
       ($1, 'Copa Antiga', 'Old Champ', 'OLD', 'R$ 50', '2020-01-01'),
       ($2, 'Copa Recente', 'New Champ', 'NEW', 'R$ 500', '2026-01-01')`,
    [olderId, newerId]
  );
  insertedHallOfFameIds.push(olderId, newerId);
}

beforeAll(async () => {
  await runMigrations();
  await neutralizeExistingFeaturedEvents();
  await seedEventsFixture();
  await seedHallOfFameFixture();
});

afterAll(async () => {
  if (insertedEventIds.length > 0) {
    await pool.query(`DELETE FROM events WHERE id = ANY($1::uuid[])`, [insertedEventIds]);
  }
  if (insertedHallOfFameIds.length > 0) {
    await pool.query(`DELETE FROM hall_of_fame WHERE id = ANY($1::uuid[])`, [
      insertedHallOfFameIds,
    ]);
  }
  if (neutralizedFeaturedIds.length > 0) {
    await pool.query(`UPDATE events SET featured = true WHERE id = ANY($1::uuid[])`, [
      neutralizedFeaturedIds,
    ]);
  }
});

describe("GET /api/events", () => {
  test("returns events in the range plus the featured one", async () => {
    const res = await request(app).get("/api/events?from=2026-11-02&to=2026-11-08");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.featured === null || typeof res.body.featured.title === "string").toBe(true);
  });

  test("range filters out-of-range events and featured picks nearest future one", async () => {
    const res = await request(app).get("/api/events?from=2026-11-02&to=2026-11-08");
    expect(res.status).toBe(200);

    const titles = res.body.events.map((e: any) => e.title);
    expect(titles).toContain("In Range Cup");
    expect(titles).not.toContain("Out Of Range Cup");

    // every key is camelCase, nothing snake_case leaks through
    const sample = res.body.events[0];
    expect(sample).toHaveProperty("startsAt");
    expect(sample).toHaveProperty("prizeText");
    expect(sample).not.toHaveProperty("starts_at");
    expect(sample).not.toHaveProperty("prize_text");

    expect(res.body.featured).not.toBeNull();
    expect(res.body.featured.title).toBe("Future Featured Cup");
  });

  test("returns 400 for an invalid from/to date", async () => {
    const res = await request(app).get("/api/events?from=not-a-date");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/hall-of-fame", () => {
  test("returns entries newest won_at first, camelCased", async () => {
    const res = await request(app).get("/api/hall-of-fame");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);

    const names = res.body.entries.map((e: any) => e.eventName);
    const newerIndex = names.indexOf("Copa Recente");
    const olderIndex = names.indexOf("Copa Antiga");
    expect(newerIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex).toBeGreaterThanOrEqual(0);
    expect(newerIndex).toBeLessThan(olderIndex);

    const sample = res.body.entries.find((e: any) => e.eventName === "Copa Recente");
    expect(sample).toMatchObject({
      championName: "New Champ",
      championTag: "NEW",
      prizeText: "R$ 500",
    });
    expect(sample).toHaveProperty("wonAt");
    expect(sample).not.toHaveProperty("champion_name");
  });
});
