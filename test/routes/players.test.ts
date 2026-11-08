import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { app } from "../../src/index.js";
import { pool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";

const insertedPlayerIds: string[] = [];
const insertedClanIds: string[] = [];

/**
 * Inserts a player and a `player_stats` row for the given mode with the
 * given rating, plus whatever other columns the route's SELECT needs.
 */
async function insertPlayerStats(
  playerId: string,
  mode: "global" | "duo" | "squad",
  rating: number
): Promise<void> {
  await pool.query(
    `INSERT INTO player_stats
       (player_id, mode, matches, avg_position, avg_kills, kd, wins, ranked, rating)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [playerId, mode, 50, 5.5, 3.5, 1.1, 10, true, rating]
  );
}

/**
 * Inserts 3 players, each with global/duo/squad `player_stats` rows with
 * genuinely distinct ratings (both across players and across modes), so
 * the default-mode sort-order test has real, orderable rows to work with.
 */
async function seedPlayersFixture(): Promise<string[]> {
  const suffix = Math.random().toString(36).slice(2, 9);
  const playerIds = [randomUUID(), randomUUID(), randomUUID()];

  for (let i = 0; i < playerIds.length; i++) {
    const id = playerIds[i];
    await pool.query(
      `INSERT INTO players (id, discord_id, discord_username, display_name)
       VALUES ($1, $2, $3, $4)`,
      [id, `discord-${suffix}-${i}`, `fixture-user-${suffix}-${i}`, `Fixture Player ${suffix}-${i}`]
    );
    insertedPlayerIds.push(id);

    await insertPlayerStats(id, "global", 100 + i * 10);
    await insertPlayerStats(id, "duo", 200 + i * 10);
    await insertPlayerStats(id, "squad", 300 + i * 10);
  }

  return playerIds;
}

/**
 * Inserts a single player with distinct, known ratings for global and duo,
 * so a test can assert that `mode=duo` returns the duo rating/stats and not
 * the global ones.
 */
async function seedPlayerWithDistinctModeStats(): Promise<{
  playerId: string;
  globalRating: number;
  duoRating: number;
}> {
  const suffix = Math.random().toString(36).slice(2, 9);
  const playerId = randomUUID();
  const globalRating = 42;
  const duoRating = 999;

  await pool.query(
    `INSERT INTO players (id, discord_id, discord_username, display_name)
     VALUES ($1, $2, $3, $4)`,
    [playerId, `discord-${suffix}`, `fixture-user-${suffix}`, `Distinct Mode ${suffix}`]
  );
  insertedPlayerIds.push(playerId);

  await insertPlayerStats(playerId, "global", globalRating);
  await insertPlayerStats(playerId, "duo", duoRating);

  return { playerId, globalRating, duoRating };
}

/**
 * Inserts a clan and a single player with `clan_id` set to it (plus a
 * global `player_stats` row), so a test can assert the route's clan LEFT
 * JOIN resolves a real `clanTag` for a player who actually has a clan.
 */
async function seedPlayerWithClan(): Promise<{ playerId: string; clanTag: string }> {
  const suffix = Math.random().toString(36).slice(2, 9);
  const clanId = randomUUID();
  const clanTag = `TST${suffix.slice(0, 4)}`.toUpperCase();
  await pool.query(`INSERT INTO clans (id, tag, name) VALUES ($1, $2, $3)`, [
    clanId,
    clanTag,
    "Test Clan",
  ]);
  insertedClanIds.push(clanId);

  const playerId = randomUUID();
  await pool.query(
    `INSERT INTO players (id, discord_id, discord_username, display_name, clan_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [playerId, `discord-${suffix}`, `fixture-user-${suffix}`, `Clan Member ${suffix}`, clanId]
  );
  insertedPlayerIds.push(playerId);

  await insertPlayerStats(playerId, "global", 500);

  return { playerId, clanTag };
}

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  if (insertedPlayerIds.length > 0) {
    await pool.query(`DELETE FROM player_stats WHERE player_id = ANY($1::uuid[])`, [
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

describe("GET /api/players", () => {
  test("returns players sorted by rating desc for the default (global) mode", async () => {
    await seedPlayersFixture();
    const res = await request(app).get("/api/players");
    expect(res.status).toBe(200);
    const ratings = res.body.players.map((p: any) => p.rating);
    expect(ratings).toEqual([...ratings].sort((a, b) => b - a));
  });

  test("GET /api/players?search=rez filters by display name, case-insensitive", async () => {
    const res = await request(app).get("/api/players?search=REZ");
    expect(res.status).toBe(200);
    expect(
      res.body.players.every((p: any) => p.displayName.toLowerCase().includes("rez"))
    ).toBe(true);
  });

  test("GET /api/players?mode=duo returns the duo rating/stats, not the global ones", async () => {
    const { playerId, globalRating, duoRating } = await seedPlayerWithDistinctModeStats();
    const res = await request(app).get("/api/players?mode=duo");
    expect(res.status).toBe(200);
    const entry = res.body.players.find((p: any) => p.id === playerId);
    expect(entry).toBeDefined();
    expect(entry.rating).toBe(duoRating);
    expect(entry.rating).not.toBe(globalRating);
  });

  test("an unrecognized mode falls back to global instead of 400ing", async () => {
    const res = await request(app).get("/api/players?mode=not-a-real-mode");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.players)).toBe(true);
  });

  test("a player with a clan returns a real clanTag; a clanless player returns clanTag: null", async () => {
    const { playerId: clanPlayerId, clanTag } = await seedPlayerWithClan();
    const clanlessPlayerIds = await seedPlayersFixture();

    const res = await request(app).get("/api/players");
    expect(res.status).toBe(200);

    const clanEntry = res.body.players.find((p: any) => p.id === clanPlayerId);
    expect(clanEntry).toBeDefined();
    expect(clanEntry.clanTag).toBe(clanTag);
    expect(typeof clanEntry.clanTag).toBe("string");

    const clanlessEntry = res.body.players.find(
      (p: any) => p.id === clanlessPlayerIds[0]
    );
    expect(clanlessEntry).toBeDefined();
    expect(clanlessEntry.clanTag).toBeNull();
  });
});
