import { describe, expect, test } from "vitest";
import request from "supertest";
import { app } from "../../src/index.js";

describe("GET /health", () => {
  test("returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
