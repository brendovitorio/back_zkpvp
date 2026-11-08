import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import { app } from "../../src/index.js";
import { pool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";
import { signSession } from "../../src/services/jwt.js";
import { confirmRateLimiter } from "../../src/middleware/confirmRateLimit.js";
import { authFailureLimiter } from "../../src/middleware/authFailureLimit.js";

const apiKey = process.env.FIVEM_RESOURCE_API_KEY as string;

const insertedPlayerIds: string[] = [];

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

/** Inserts a link_codes row with an already-expired expires_at. */
async function seedExpiredCode(): Promise<{ code: string; playerId: string }> {
  const playerId = await seedOnePlayer();
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  await pool.query(
    `INSERT INTO link_codes (player_id, code, confirmed, expires_at)
     VALUES ($1, $2, false, now() - interval '1 minute')`,
    [playerId, code]
  );
  return { code, playerId };
}

/** Inserts a link_codes row that's fresh (not expired, not confirmed). */
async function seedFreshCode(): Promise<{ code: string; playerId: string }> {
  const playerId = await seedOnePlayer();
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  await pool.query(
    `INSERT INTO link_codes (player_id, code, confirmed, expires_at)
     VALUES ($1, $2, false, now() + interval '10 minutes')`,
    [playerId, code]
  );
  return { code, playerId };
}

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  if (insertedPlayerIds.length > 0) {
    await pool.query(`DELETE FROM link_codes WHERE player_id = ANY($1::uuid[])`, [
      insertedPlayerIds,
    ]);
    await pool.query(`DELETE FROM players WHERE id = ANY($1::uuid[])`, [insertedPlayerIds]);
  }
});

describe("GET /api/link/code", () => {
  test("without a session cookie returns 401", async () => {
    const res = await request(app).get("/api/link/code");
    expect(res.status).toBe(401);
  });

  test("with a valid session returns a fresh code and invalidates the prior unconfirmed one", async () => {
    const playerId = await seedOnePlayer();
    const token = signSession({ playerId });

    const first = await request(app).get("/api/link/code").set("Cookie", `session=${token}`);
    expect(first.status).toBe(200);
    const firstCode = first.body.code;

    const second = await request(app).get("/api/link/code").set("Cookie", `session=${token}`);
    expect(second.status).toBe(200);
    const secondCode = second.body.code;
    expect(secondCode).not.toBe(firstCode);

    const { rows } = await pool.query<{ code: string }>(
      `SELECT code FROM link_codes WHERE player_id = $1`,
      [playerId]
    );
    expect(rows.map((r) => r.code)).toEqual([secondCode]);
  });
});

describe("POST /api/link/confirm", () => {
  // The rate limiter's in-memory store persists for the life of the
  // process, not per-test. Without this, quota consumed by one test would
  // leak into the next (regardless of test order) and could flip an
  // expected 404/410/409 into a 429. Reset to a clean slate before each
  // test in this block so every test only ever sees the requests it itself
  // makes. supertest requests against an in-process app resolve to the
  // loopback IPv4 address, which is the rate limiter's default key.
  beforeEach(() => {
    confirmRateLimiter.resetKey("127.0.0.1");
    authFailureLimiter.resetKey("127.0.0.1");
  });

  test("without the api key returns 401", async () => {
    const res = await request(app)
      .post("/api/link/confirm")
      .send({ code: "ABC123", fivemLicense: "x" });
    expect(res.status).toBe(401);
  });

  test("confirming an unknown code returns 404", async () => {
    const res = await request(app)
      .post("/api/link/confirm")
      .set("x-api-key", apiKey)
      .send({ code: "NOPE99", fivemLicense: "x" });
    expect(res.status).toBe(404);
  });

  test("confirming an expired code returns 410 and does not set fivem_license", async () => {
    const { code, playerId } = await seedExpiredCode();
    const res = await request(app)
      .post("/api/link/confirm")
      .set("x-api-key", apiKey)
      .send({ code, fivemLicense: "x" });
    expect(res.status).toBe(410);
    const player = await pool.query(`select fivem_license from players where id=$1`, [playerId]);
    expect(player.rows[0].fivem_license).toBeNull();
  });

  test("confirming twice returns 409 on the second call", async () => {
    const { code } = await seedFreshCode();
    // Unique per run (not a literal) — this call actually succeeds and
    // writes fivem_license, which is UNIQUE; a literal would collide with
    // a leftover row from any prior run that didn't get to clean up.
    const fivemLicense = `fixture-license-${Math.random().toString(36).slice(2, 9)}`;
    await request(app)
      .post("/api/link/confirm")
      .set("x-api-key", apiKey)
      .send({ code, fivemLicense });
    const second = await request(app)
      .post("/api/link/confirm")
      .set("x-api-key", apiKey)
      .send({ code, fivemLicense });
    expect(second.status).toBe(409);
  });

  test("two concurrent confirms for the same fresh code: exactly one succeeds, the other gets 409 (no double-processing)", async () => {
    const { code } = await seedFreshCode();
    const suffix = Math.random().toString(36).slice(2, 9);

    const [a, b] = await Promise.all([
      request(app)
        .post("/api/link/confirm")
        .set("x-api-key", apiKey)
        .send({ code, fivemLicense: `concurrent-a-${suffix}` }),
      request(app)
        .post("/api/link/confirm")
        .set("x-api-key", apiKey)
        .send({ code, fivemLicense: `concurrent-b-${suffix}` }),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);
  });

  test("the 21st confirm request within a minute from the same source gets 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      // The code doesn't need to be real — the rate limiter runs before
      // the code lookup, so every one of these 21 requests consumes a slot
      // regardless of what status the route itself would have returned.
      const res = await request(app)
        .post("/api/link/confirm")
        .set("x-api-key", apiKey)
        .send({ code: "DOESNOTEXIST", fivemLicense: "x" });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  test("an unauthenticated flood (no/wrong api key) never consumes confirmRateLimiter's quota", async () => {
    const statuses: number[] = [];
    // Deliberately under authFailureLimiter's own 10/15min threshold (see
    // the dedicated test below for that limiter's own 429 behavior) — this
    // test is specifically about confirmRateLimiter, which should never
    // see or count unauthenticated traffic at all, regardless of how many
    // wrong-key attempts authFailureLimiter itself tolerates.
    for (let i = 0; i < 8; i++) {
      const res = await request(app)
        .post("/api/link/confirm")
        .set("x-api-key", "definitely-not-the-real-key")
        .send({ code: "DOESNOTEXIST", fivemLicense: "x" });
      statuses.push(res.status);
    }

    // Every one of them is rejected by requireApiKey (401) — none should
    // ever flip to 429 from confirmRateLimiter, since confirmRateLimiter
    // sits after requireApiKey and never sees unauthenticated traffic.
    expect(statuses.every((s) => s === 401)).toBe(true);

    // A correctly-keyed request right after the flood should still go
    // through confirmRateLimiter normally (not pre-emptively 429'd),
    // proving the flood above never touched this IP's confirmRateLimiter
    // quota.
    const legit = await request(app)
      .post("/api/link/confirm")
      .set("x-api-key", apiKey)
      .send({ code: "DOESNOTEXIST", fivemLicense: "x" });
    expect(legit.status).not.toBe(429);
    expect(legit.status).toBe(404);
  });

  test("the 11th failed api-key attempt within the window gets 429 from authFailureLimiter", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post("/api/link/confirm")
        .set("x-api-key", "definitely-not-the-real-key")
        .send({ code: "DOESNOTEXIST", fivemLicense: "x" });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  test("a correct api key is never blocked by authFailureLimiter, even after it's maxed out from that IP", async () => {
    // Exhaust authFailureLimiter's quota from this (simulated) IP with
    // wrong-key attempts, same as the 11th-attempt test above.
    for (let i = 0; i < 11; i++) {
      await request(app)
        .post("/api/link/confirm")
        .set("x-api-key", "definitely-not-the-real-key")
        .send({ code: "DOESNOTEXIST", fivemLicense: "x" });
    }

    // A request with the CORRECT key, from the same IP, right after the
    // limiter has already started 429ing wrong-key attempts, must still
    // go through — `skip` exempts any request that already carries a
    // valid key from this limiter entirely, regardless of how many prior
    // failures came from this IP. This is the scenario a reverse proxy
    // without `trust proxy` configured would otherwise create: every
    // caller (attacker and the real FiveM resource alike) sharing one
    // apparent IP, where an attacker's failed guesses must never be able
    // to lock out a legitimately-keyed request.
    const legit = await request(app)
      .post("/api/link/confirm")
      .set("x-api-key", apiKey)
      .send({ code: "DOESNOTEXIST", fivemLicense: "x" });

    expect(legit.status).not.toBe(429);
    expect(legit.status).toBe(404); // past both auth checks, unknown code
  });

  test("a correct api key still works after some failed attempts (timing-safe compare correctness)", async () => {
    // A couple of wrong-key attempts first (well under authFailureLimiter's
    // threshold), then the real key — proving the switch to a timing-safe
    // comparison didn't break either the reject-wrong-key or accept-right-key
    // path.
    const wrong = await request(app)
      .post("/api/link/confirm")
      .set("x-api-key", "still-not-the-real-key")
      .send({ code: "DOESNOTEXIST", fivemLicense: "x" });
    expect(wrong.status).toBe(401);

    const right = await request(app)
      .post("/api/link/confirm")
      .set("x-api-key", apiKey)
      .send({ code: "DOESNOTEXIST", fivemLicense: "x" });
    expect(right.status).toBe(404); // past both auth checks, unknown code
  });
});
