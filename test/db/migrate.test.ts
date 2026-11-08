import { describe, expect, test } from "vitest";
import { pool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";

describe("runMigrations", () => {
  test("creates all domain tables and is idempotent", async () => {
    await runMigrations();
    await runMigrations(); // second call must not throw

    const { rows } = await pool.query(
      `select table_name from information_schema.tables where table_schema='public'`
    );
    const names = rows.map((r) => r.table_name);

    for (const t of [
      "players",
      "rankings",
      "events",
      "changelog_entries",
      "store_items",
      "orders",
      "link_codes",
      "staff_accounts",
    ]) {
      expect(names).toContain(t);
    }
  });
});
