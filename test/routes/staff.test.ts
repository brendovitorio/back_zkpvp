import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import { app } from "../../src/index.js";
import { pool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "../../src/routes/staff.js";
import { staffLoginLimiter } from "../../src/middleware/staffLoginLimit.js";
import { signSession, signStaffSession } from "../../src/services/jwt.js";

const insertedStaffIds: string[] = [];
const insertedChangelogIds: string[] = [];
const insertedEventIds: string[] = [];

const STAFF_USERNAME = "staff1";
const STAFF_PASSWORD = "correct-horse-battery-staple";

let staffId: string;
let staffCookie: string;

/** Inserts one staff_accounts row with a properly hashed (never plaintext) password. */
async function seedStaffAccount(): Promise<string> {
  const id = randomUUID();
  const passwordHash = await hashPassword(STAFF_PASSWORD);
  await pool.query(
    `INSERT INTO staff_accounts (id, username, password_hash) VALUES ($1, $2, $3)`,
    [id, STAFF_USERNAME, passwordHash]
  );
  insertedStaffIds.push(id);
  return id;
}

let originalBanidosValue: string | null = null;

async function captureOriginalBanidosValue(): Promise<void> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM home_stats WHERE key = 'banidos'`
  );
  originalBanidosValue = rows[0]?.value ?? null;
}

beforeAll(async () => {
  await runMigrations();
  staffId = await seedStaffAccount();
  staffCookie = `staff_session=${signStaffSession({ staffId })}`;
  await captureOriginalBanidosValue();
});

afterAll(async () => {
  if (insertedChangelogIds.length > 0) {
    await pool.query(`DELETE FROM changelog_entries WHERE id = ANY($1::uuid[])`, [
      insertedChangelogIds,
    ]);
  }
  if (insertedEventIds.length > 0) {
    await pool.query(`DELETE FROM events WHERE id = ANY($1::uuid[])`, [insertedEventIds]);
  }
  if (insertedStaffIds.length > 0) {
    await pool.query(`DELETE FROM staff_accounts WHERE id = ANY($1::uuid[])`, [
      insertedStaffIds,
    ]);
  }
  if (originalBanidosValue === null) {
    await pool.query(`DELETE FROM home_stats WHERE key = 'banidos'`);
  } else {
    await pool.query(`UPDATE home_stats SET value = $1 WHERE key = 'banidos'`, [
      originalBanidosValue,
    ]);
  }
});

describe("POST /staff/login", () => {
  // The rate limiter's in-memory store persists for the life of the
  // process, not per-test (same reasoning as link.test.ts's
  // confirmRateLimiter/authFailureLimiter resets). Reset before AND after
  // each test here so neither the 429 test below nor any ordinary 401/200
  // test in this block can leak quota into another test, in either
  // direction. supertest requests against an in-process app resolve to
  // the loopback IPv4 address, which is the rate limiter's default key.
  beforeEach(() => {
    staffLoginLimiter.resetKey("127.0.0.1");
  });
  afterEach(() => {
    staffLoginLimiter.resetKey("127.0.0.1");
  });

  test("wrong password returns 401", async () => {
    const res = await request(app)
      .post("/staff/login")
      .send({ username: STAFF_USERNAME, password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_credentials" });
  });

  test("unknown username returns 401", async () => {
    const res = await request(app)
      .post("/staff/login")
      .send({ username: "nobody-here", password: STAFF_PASSWORD });
    expect(res.status).toBe(401);
  });

  test("unknown username and wrong password return an identical response (no username enumeration via body)", async () => {
    const unknownRes = await request(app)
      .post("/staff/login")
      .send({ username: "still-nobody-here", password: STAFF_PASSWORD });
    const wrongPasswordRes = await request(app)
      .post("/staff/login")
      .send({ username: STAFF_USERNAME, password: "definitely-wrong" });

    expect(unknownRes.status).toBe(wrongPasswordRes.status);
    expect(unknownRes.body).toEqual(wrongPasswordRes.body);
    expect(unknownRes.body).toEqual({ error: "invalid_credentials" });
  });

  test("DUMMY_PASSWORD_HASH is a real scrypt hash verifyPassword can check against (the code path the 'unknown username' branch runs instead of returning early)", async () => {
    // Response-time assertions are inherently flaky in a unit test, so
    // this covers the dummy-hash path functionally instead: the constant
    // the route feeds to verifyPassword() when no account is found is a
    // genuine hashPassword() output, not a placeholder/short-circuit
    // string, so that call does real scrypt work indistinguishable from
    // the real-account wrong-password path above.
    expect(DUMMY_PASSWORD_HASH.startsWith("scrypt:")).toBe(true);
    await expect(verifyPassword("not-the-decoy-password", DUMMY_PASSWORD_HASH)).resolves.toBe(
      false
    );
    await expect(
      verifyPassword("zkpvp-staff-login-timing-decoy", DUMMY_PASSWORD_HASH)
    ).resolves.toBe(true);
  });

  test("correct credentials returns 200 and sets staff_session cookie", async () => {
    const res = await request(app)
      .post("/staff/login")
      .send({ username: STAFF_USERNAME, password: STAFF_PASSWORD });
    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"] as unknown as string[] | undefined;
    expect(setCookie?.some((c) => c.startsWith("staff_session="))).toBe(true);
  });

  test("the 11th failed login attempt within the window gets 429 from staffLoginLimiter", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post("/staff/login")
        .send({ username: STAFF_USERNAME, password: "wrong" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  test("a successful login in between failed ones does not itself consume quota", async () => {
    // skipSuccessfulRequests rolls back the counter for a response that
    // succeeds (status < 400), but does NOT exempt that request from a
    // block already triggered by prior failures — so this test can't
    // assert "a success is never blocked" in general (that needs an
    // explicit `skip`, which this limiter deliberately doesn't have, per
    // the brief's simpler spec). What it CAN prove: the total failure
    // budget for the window is still exactly 10, unaffected by however
    // many successful logins happened in between — i.e. the 3 failures
    // below plus the next 7 are tolerated (401), and only the 8th/9th/10th
    // of the second batch (the window's 11th/12th/13th failure overall)
    // get 429 — not fewer than 7, which would mean the successful login
    // wrongly ate into the failure quota.
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/staff/login")
        .send({ username: STAFF_USERNAME, password: "wrong" });
      expect(res.status).toBe(401);
    }
    const loginRes = await request(app)
      .post("/staff/login")
      .send({ username: STAFF_USERNAME, password: STAFF_PASSWORD });
    expect(loginRes.status).toBe(200);

    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/staff/login")
        .send({ username: STAFF_USERNAME, password: "wrong" });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 401).length).toBe(7);
    expect(statuses.filter((s) => s === 429).length).toBe(3);
  });
});

describe("POST /staff/changelog", () => {
  test("without a staff session returns 401", async () => {
    const res = await request(app)
      .post("/staff/changelog")
      .send({ version: "v1", title: "x", publishedAt: "2026-11-06", categories: [], body: "x" });
    expect(res.status).toBe(401);
  });

  test("a player session cookie does not satisfy requireStaff", async () => {
    const playerToken = signSession({ playerId: randomUUID() });
    const res = await request(app)
      .post("/staff/changelog")
      .set("Cookie", `session=${playerToken}`)
      .send({ version: "v1", title: "x", publishedAt: "2026-11-06", categories: [], body: "x" });
    expect(res.status).toBe(401);
  });

  test("blank title returns 400 and creates no row", async () => {
    const before = await pool.query(`select count(*)::int as n from changelog_entries`);
    const res = await request(app)
      .post("/staff/changelog")
      .set("Cookie", staffCookie)
      .send({ version: "v1", title: "", publishedAt: "2026-11-06", categories: [], body: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.fields).toHaveProperty("title");
    const after = await pool.query(`select count(*)::int as n from changelog_entries`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test("blank version returns 400 and creates no row", async () => {
    const before = await pool.query(`select count(*)::int as n from changelog_entries`);
    const res = await request(app)
      .post("/staff/changelog")
      .set("Cookie", staffCookie)
      .send({ version: "", title: "x", publishedAt: "2026-11-06", categories: [], body: "x" });
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("version");
    const after = await pool.query(`select count(*)::int as n from changelog_entries`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test("invalid publishedAt returns 400 and creates no row", async () => {
    const before = await pool.query(`select count(*)::int as n from changelog_entries`);
    const res = await request(app)
      .post("/staff/changelog")
      .set("Cookie", staffCookie)
      .send({
        version: "v1",
        title: "x",
        publishedAt: "not-a-date",
        categories: [],
        body: "x",
      });
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("publishedAt");
    const after = await pool.query(`select count(*)::int as n from changelog_entries`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test("valid body creates a row and a staff session fails requireAuth on player routes", async () => {
    const res = await request(app)
      .post("/staff/changelog")
      .set("Cookie", staffCookie)
      .send({
        version: "v1",
        title: "Nova entrada",
        publishedAt: "2026-11-06",
        categories: ["novidades"],
        body: "corpo da entrada",
      });
    expect(res.status).toBe(201);
    expect(res.body.entry).toMatchObject({ version: "v1", title: "Nova entrada" });
    insertedChangelogIds.push(res.body.entry.id);

    const meRes = await request(app).get("/auth/me").set("Cookie", staffCookie);
    expect(meRes.status).toBe(401);
  });
});

describe("staff events CRUD", () => {
  test("POST /staff/events creates, PUT updates, DELETE removes", async () => {
    const createRes = await request(app)
      .post("/staff/events")
      .set("Cookie", staffCookie)
      .send({
        title: "Copa de Teste",
        description: "desc",
        category: "torneio",
        startsAt: "2026-12-01T18:00:00Z",
        prizeText: "R$ 100",
        featured: false,
      });
    expect(createRes.status).toBe(201);
    const id = createRes.body.event.id as string;
    insertedEventIds.push(id);

    const updateRes = await request(app)
      .put(`/staff/events/${id}`)
      .set("Cookie", staffCookie)
      .send({
        title: "Copa de Teste Atualizada",
        description: "desc",
        category: "torneio",
        startsAt: "2026-12-02T18:00:00Z",
        prizeText: "R$ 200",
        featured: true,
      });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.event.title).toBe("Copa de Teste Atualizada");

    const deleteRes = await request(app)
      .delete(`/staff/events/${id}`)
      .set("Cookie", staffCookie);
    expect(deleteRes.status).toBe(200);
    insertedEventIds.splice(insertedEventIds.indexOf(id), 1);

    const check = await pool.query(`select count(*)::int as n from events where id = $1`, [id]);
    expect(check.rows[0].n).toBe(0);
  });

  test("POST /staff/events with blank title returns 400 and creates no row", async () => {
    const before = await pool.query(`select count(*)::int as n from events`);
    const res = await request(app)
      .post("/staff/events")
      .set("Cookie", staffCookie)
      .send({
        title: "",
        description: "desc",
        category: "torneio",
        startsAt: "2026-12-01T18:00:00Z",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    const after = await pool.query(`select count(*)::int as n from events`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("PUT /staff/home-stats/:key", () => {
  test("updates the value", async () => {
    const res = await request(app)
      .put("/staff/home-stats/banidos")
      .set("Cookie", staffCookie)
      .send({ value: "28200" });
    expect(res.status).toBe(200);
    const row = await pool.query(`select value from home_stats where key='banidos'`);
    expect(row.rows[0].value).toBe("28200");
  });

  test("without a staff session returns 401 and does not change the value", async () => {
    const before = await pool.query(`select value from home_stats where key='banidos'`);
    const res = await request(app).put("/staff/home-stats/banidos").send({ value: "999" });
    expect(res.status).toBe(401);
    const after = await pool.query(`select value from home_stats where key='banidos'`);
    expect(after.rows[0].value).toBe(before.rows[0].value);
  });

  test("blank value returns 400 and does not change the value", async () => {
    const before = await pool.query(`select value from home_stats where key='banidos'`);
    const res = await request(app)
      .put("/staff/home-stats/banidos")
      .set("Cookie", staffCookie)
      .send({ value: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    const after = await pool.query(`select value from home_stats where key='banidos'`);
    expect(after.rows[0].value).toBe(before.rows[0].value);
  });
});
