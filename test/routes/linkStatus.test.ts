import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { app } from "../../src/index.js";

const oldKey = process.env.FIVEM_RESOURCE_API_KEY;
beforeAll(() => {
  process.env.FIVEM_RESOURCE_API_KEY = "test-only-fivem-api-key-32-bytes-long";
});
afterAll(() => {
  if (oldKey === undefined) delete process.env.FIVEM_RESOURCE_API_KEY;
  else process.env.FIVEM_RESOURCE_API_KEY = oldKey;
});

describe("GET /api/link/status", () => {
  test("requires the FiveM API key", async () => {
    const response = await request(app)
      .get("/api/link/status")
      .query({ license: "license:abcdef0123456789" });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "invalid_api_key" });
  });

  test("rejects malformed licenses", async () => {
    const response = await request(app)
      .get("/api/link/status")
      .set("x-api-key", process.env.FIVEM_RESOURCE_API_KEY!)
      .query({ license: "not-a-license" });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid_license" });
  });
});
