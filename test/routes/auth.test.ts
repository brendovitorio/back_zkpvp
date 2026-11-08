import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";

// Mock only `exchangeCode` (the real Discord network call) so the callback
// happy-path tests never hit the real Discord API; `isDiscordConfigured` /
// `buildAuthorizeUrl` stay real so the /auth/discord/login 503 test still
// exercises the actual env-var check.
vi.mock("../../src/services/discordOAuth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/discordOAuth.js")>();
  return {
    ...actual,
    exchangeCode: vi.fn(),
  };
});

import { app } from "../../src/index.js";
import { pool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";
import { signSession } from "../../src/services/jwt.js";
import { exchangeCode } from "../../src/services/discordOAuth.js";

const mockedExchangeCode = vi.mocked(exchangeCode);

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

function setCookieHeaders(res: request.Response): string[] {
  const raw = res.headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  if (insertedPlayerIds.length > 0) {
    await pool.query(`DELETE FROM players WHERE id = ANY($1::uuid[])`, [insertedPlayerIds]);
  }
});

describe("GET /auth/discord/login", () => {
  test("503s with a clear error when Discord env vars are unset", async () => {
    const original = process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_ID;

    const res = await request(app).get("/auth/discord/login");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "discord_not_configured" });

    if (original !== undefined) {
      process.env.DISCORD_CLIENT_ID = original;
    }
  });
});

describe("GET /auth/me", () => {
  test("without a session cookie returns 401", async () => {
    const res = await request(app).get("/auth/me");
    expect(res.status).toBe(401);
  });

  test("with a valid session cookie returns the player", async () => {
    const playerId = await seedOnePlayer();
    const token = signSession({ playerId });

    const res = await request(app).get("/auth/me").set("Cookie", `session=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.player).toHaveProperty("displayName");
  });
});

describe("GET /auth/discord/callback", () => {
  const originalClientId = process.env.DISCORD_CLIENT_ID;
  const originalClientSecret = process.env.DISCORD_CLIENT_SECRET;
  const originalRedirectUri = process.env.DISCORD_REDIRECT_URI;

  beforeEach(() => {
    // isDiscordConfigured() is real in this test file (not mocked) — give
    // it something truthy so the callback route doesn't 503 before we even
    // get to exercise the state check / upsert logic.
    process.env.DISCORD_CLIENT_ID = "test-client-id";
    process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
    process.env.DISCORD_REDIRECT_URI = "http://localhost:3000/auth/discord/callback";
  });

  afterEach(() => {
    if (originalClientId === undefined) delete process.env.DISCORD_CLIENT_ID;
    else process.env.DISCORD_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.DISCORD_CLIENT_SECRET;
    else process.env.DISCORD_CLIENT_SECRET = originalClientSecret;
    if (originalRedirectUri === undefined) delete process.env.DISCORD_REDIRECT_URI;
    else process.env.DISCORD_REDIRECT_URI = originalRedirectUri;

    mockedExchangeCode.mockReset();
  });

  test("rejects a callback with no state (missing cookie and query param) and never upserts a player or sets a session cookie", async () => {
    const res = await request(app).get("/auth/discord/callback?code=some-code");

    expect(res.status).toBe(400);
    expect(mockedExchangeCode).not.toHaveBeenCalled();

    const cookies = setCookieHeaders(res);
    expect(cookies.some((c) => c.startsWith("session="))).toBe(false);
  });

  test("rejects a callback whose state query param doesn't match the oauth_state cookie, without exchanging the code", async () => {
    const res = await request(app)
      .get("/auth/discord/callback?code=some-code&state=attacker-supplied-state")
      .set("Cookie", "oauth_state=real-state-issued-by-login");

    expect(res.status).toBe(400);
    expect(mockedExchangeCode).not.toHaveBeenCalled();

    const cookies = setCookieHeaders(res);
    expect(cookies.some((c) => c.startsWith("session="))).toBe(false);
  });

  test("on a matching state, exchanges the code, upserts the player, sets a session cookie, and redirects to WEB_ORIGIN/cadastro", async () => {
    const state = "matching-state-value";
    const suffix = Math.random().toString(36).slice(2, 9);
    const discordId = `discord-cb-${suffix}`;
    mockedExchangeCode.mockResolvedValueOnce({ discordId, username: `cb-user-${suffix}` });

    const res = await request(app)
      .get(`/auth/discord/callback?code=good-code&state=${state}`)
      .set("Cookie", `oauth_state=${state}`);

    expect(mockedExchangeCode).toHaveBeenCalledWith("good-code");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${process.env.WEB_ORIGIN}/cadastro`);

    const cookies = setCookieHeaders(res);
    const sessionCookie = cookies.find((c) => c.startsWith("session="));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM players WHERE discord_id = $1`,
      [discordId]
    );
    expect(rows).toHaveLength(1);
    insertedPlayerIds.push(rows[0].id);
  });

  test("logging in twice with the same discord_id upserts the same player (no duplicate row), keeping display_name but refreshing discord_username", async () => {
    const state = "matching-state-value-2";
    const suffix = Math.random().toString(36).slice(2, 9);
    const discordId = `discord-cb2-${suffix}`;

    mockedExchangeCode.mockResolvedValueOnce({ discordId, username: `first-username-${suffix}` });
    const firstRes = await request(app)
      .get(`/auth/discord/callback?code=code-1&state=${state}`)
      .set("Cookie", `oauth_state=${state}`);
    expect(firstRes.status).toBe(302);

    const { rows: afterFirst } = await pool.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM players WHERE discord_id = $1`,
      [discordId]
    );
    expect(afterFirst).toHaveLength(1);
    insertedPlayerIds.push(afterFirst[0].id);
    const originalDisplayName = afterFirst[0].display_name;

    mockedExchangeCode.mockResolvedValueOnce({ discordId, username: `second-username-${suffix}` });
    const secondRes = await request(app)
      .get(`/auth/discord/callback?code=code-2&state=${state}`)
      .set("Cookie", `oauth_state=${state}`);
    expect(secondRes.status).toBe(302);

    const { rows: afterSecond } = await pool.query<{
      id: string;
      display_name: string;
      discord_username: string;
    }>(
      `SELECT id, display_name, discord_username FROM players WHERE discord_id = $1`,
      [discordId]
    );
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].id).toBe(afterFirst[0].id);
    expect(afterSecond[0].display_name).toBe(originalDisplayName);
    expect(afterSecond[0].discord_username).toBe(`second-username-${suffix}`);
  });
});
