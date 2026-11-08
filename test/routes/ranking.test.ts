import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/index.js";
import { pool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";

const STAGE = "2a-etapa";
const insertedPlayerIds: string[] = [];
const insertedClanIds: string[] = [];

/**
 * Inserts a clan, two players, and two `rankings` rows (mode 'diario',
 * stage `STAGE`) with positions 1 and 2, so the route has real rows to
 * query, order, and join against.
 */
async function seedRankingFixture(): Promise<void> {
  const clanId = randomUUID();
  const clanTag = `CLN${Math.random().toString(36).slice(2, 7)}`;
  await pool.query(`INSERT INTO clans (id, tag, name) VALUES ($1, $2, $3)`, [
    clanId,
    clanTag,
    "Test Clan",
  ]);
  insertedClanIds.push(clanId);

  const player1Id = randomUUID();
  const player2Id = randomUUID();
  const discordSuffix = Math.random().toString(36).slice(2, 9);
  await pool.query(
    `INSERT INTO players (id, discord_id, discord_username, display_name)
     VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
    [
      player1Id,
      `discord-${discordSuffix}-1`,
      "player-one",
      "Player One",
      player2Id,
      `discord-${discordSuffix}-2`,
      "player-two",
      "Player Two",
    ]
  );
  insertedPlayerIds.push(player1Id, player2Id);

  await pool.query(
    `INSERT INTO rankings
       (player_id, mode, stage, position, eliminations, wins, clan_id, prizes_text)
     VALUES
       ($1, 'diario', $2, 1, 10, 3, $3, 'R$ 500'),
       ($4, 'diario', $2, 2, 7, 1, NULL, NULL)`,
    [player1Id, STAGE, clanId, player2Id]
  );
}

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  if (insertedPlayerIds.length > 0) {
    await pool.query(`DELETE FROM rankings WHERE player_id = ANY($1::uuid[])`, [
      insertedPlayerIds,
    ]);
    await pool.query(`DELETE FROM players WHERE id = ANY($1::uuid[])`, [
      insertedPlayerIds,
    ]);
  }
  if (insertedClanIds.length > 0) {
    await pool.query(`DELETE FROM clans WHERE id = ANY($1::uuid[])`, [
      insertedClanIds,
    ]);
  }
});

describe("GET /api/ranking", () => {
  test("returns entries ordered by position", async () => {
    await seedRankingFixture();
    const res = await request(app).get(`/api/ranking?mode=diario&stage=${STAGE}`);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("diario");
    expect(res.body.stage).toBe(STAGE);
    expect(res.body.entries.map((e: any) => e.position)).toEqual([1, 2]);

    const first = res.body.entries[0];
    expect(first).toMatchObject({
      position: 1,
      playerId: insertedPlayerIds[0],
      displayName: "Player One",
      eliminations: 10,
      wins: 3,
      prizesText: "R$ 500",
    });
    expect(typeof first.clanTag).toBe("string");

    const second = res.body.entries[1];
    expect(second).toMatchObject({
      position: 2,
      playerId: insertedPlayerIds[1],
      displayName: "Player Two",
      clanTag: null,
      eliminations: 7,
      wins: 1,
      prizesText: null,
    });
  });

  test("returns 400 for invalid mode", async () => {
    const res = await request(app).get("/api/ranking?mode=invalid");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_mode" });
  });

  test("returns 400 for missing mode", async () => {
    const res = await request(app).get("/api/ranking");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_mode" });
  });

  test("returns 400 for a malformed stage instead of querying the DB", async () => {
    const res = await request(app).get(
      "/api/ranking?mode=diario&stage=" + encodeURIComponent("bad stage!")
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_stage" });
  });

  test("a rejected DB query reaches the error middleware as 500, not a crash", async () => {
    const querySpy = vi
      .spyOn(pool, "query")
      .mockRejectedValueOnce(new Error("connection dropped"));

    const res = await request(app).get("/api/ranking?mode=diario");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error" });
    querySpy.mockRestore();
  });
});
