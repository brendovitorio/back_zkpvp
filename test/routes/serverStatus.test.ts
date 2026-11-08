import { beforeEach, expect, test } from "vitest";
import request from "supertest";
import { app } from "../../src/index.js";
import { resetServerStatusCacheForTests } from "../../src/services/fivemStatus.js";

beforeEach(() => {
  resetServerStatusCacheForTests();
});

test("GET /api/server-status always returns 200, even before the first poll", async () => {
  const res = await request(app).get("/api/server-status");
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty("online");
  expect(res.body.online).toBeNull();
  expect(res.body.lastUpdated).toBeNull();
});
