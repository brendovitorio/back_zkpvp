import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { app } from "../../src/index.js";
import { pool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";

const insertedChangelogIds: string[] = [];

/**
 * Inserts changelog entries using the real seed taxonomy (novidades,
 * melhorias, correcoes, importantes) plus a unique search token, so the
 * `category` and `search` filters can be exercised against real rows.
 */
async function seedChangelogFixture(): Promise<string> {
  const token = `ZKTOKEN${Math.random().toString(36).slice(2, 9)}`;

  const olderId = randomUUID();
  const newerId = randomUUID();
  const noCorrecoesId = randomUUID();

  await pool.query(
    `INSERT INTO changelog_entries (id, version, title, published_at, categories, body)
     VALUES
       ($1, '0.9.0', 'Correção antiga', '2025-01-01', ARRAY['correcoes'], 'ajustes antigos'),
       ($2, '0.9.1', $4, '2026-06-01', ARRAY['correcoes','melhorias'], 'corrige bug raro'),
       ($3, '0.9.2', 'Apenas novidades', '2026-07-01', ARRAY['novidades'], 'sem correcoes aqui')`,
    [olderId, newerId, noCorrecoesId, `Novo lançamento ${token}`]
  );
  insertedChangelogIds.push(olderId, newerId, noCorrecoesId);
  return token;
}

let searchToken: string;

beforeAll(async () => {
  await runMigrations();
  searchToken = await seedChangelogFixture();
});

afterAll(async () => {
  if (insertedChangelogIds.length > 0) {
    await pool.query(`DELETE FROM changelog_entries WHERE id = ANY($1::uuid[])`, [
      insertedChangelogIds,
    ]);
  }
});

describe("GET /api/changelog", () => {
  test("category=correcoes only returns entries with that category", async () => {
    const res = await request(app).get("/api/changelog?category=correcoes");
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(res.body.entries.every((e: any) => e.categories.includes("correcoes"))).toBe(true);
  });

  test("entries are camelCased and ordered newest published_at first", async () => {
    const res = await request(app).get("/api/changelog?category=correcoes");
    expect(res.status).toBe(200);
    const versions = res.body.entries.map((e: any) => e.version);
    const newerIndex = versions.indexOf("0.9.1");
    const olderIndex = versions.indexOf("0.9.0");
    expect(newerIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex).toBeGreaterThanOrEqual(0);
    expect(newerIndex).toBeLessThan(olderIndex);

    const sample = res.body.entries[0];
    expect(sample).toHaveProperty("publishedAt");
    expect(sample).not.toHaveProperty("published_at");
  });

  test("search matches title or body case-insensitively", async () => {
    const res = await request(app).get(
      `/api/changelog?search=${encodeURIComponent(searchToken.toLowerCase())}`
    );
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(1);
    expect(res.body.entries[0].version).toBe("0.9.1");
  });

  test("category and search combine as an AND filter", async () => {
    const res = await request(app).get("/api/changelog?category=novidades&search=correcoes");
    expect(res.status).toBe(200);
    // "Apenas novidades" has category novidades and body mentions "correcoes"
    expect(res.body.entries.some((e: any) => e.version === "0.9.2")).toBe(true);
  });
});
