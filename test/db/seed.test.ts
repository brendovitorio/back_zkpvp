import { describe, expect, test } from "vitest";
import { pool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seed } from "../../src/db/seed.js";

describe("seed", () => {
  test("seed populates every domain table with at least one row", async () => {
    await runMigrations();
    await seed();
    for (const t of [
      "players",
      "rankings",
      "events",
      "hall_of_fame",
      "changelog_entries",
      "store_items",
      "home_stats",
    ]) {
      const { rows } = await pool.query(`select count(*)::int as n from ${t}`);
      expect(rows[0].n).toBeGreaterThan(0);
    }
  });

  test("seed is idempotent and gives every player distinct per-mode stats", async () => {
    await runMigrations();
    await seed();
    await seed(); // must not throw on unique constraints (discord_id, tag, etc.)

    const { rows: playerCount } = await pool.query(
      `select count(*)::int as n from players`
    );
    expect(playerCount[0].n).toBeGreaterThanOrEqual(10);

    const { rows: statsRows } = await pool.query(
      `select player_id, mode, matches, avg_position, avg_kills, kd, wins, rating
       from player_stats`
    );
    expect(statsRows.length).toBeGreaterThanOrEqual(30); // >=10 players x 3 modes

    const byPlayer = new Map<string, typeof statsRows>();
    for (const row of statsRows) {
      const list = byPlayer.get(row.player_id) ?? [];
      list.push(row);
      byPlayer.set(row.player_id, list);
    }

    for (const [, modes] of byPlayer) {
      expect(modes.length).toBe(3);
      const modeNames = modes.map((m) => m.mode).sort();
      expect(modeNames).toEqual(["duo", "global", "squad"]);
      const signatures = modes.map((m) =>
        JSON.stringify([m.matches, m.avg_position, m.avg_kills, m.kd, m.wins, m.rating])
      );
      expect(new Set(signatures).size).toBe(3); // all 3 modes genuinely distinct
    }

    const { rows: rankingModes } = await pool.query(
      `select distinct mode from rankings order by mode`
    );
    expect(rankingModes.map((r) => r.mode)).toEqual(["semanal", "mvp", "diario", "mensal"]);

    const { rows: homeStatsRows } = await pool.query(
      `select key from home_stats order by key`
    );
    expect(homeStatsRows.map((r) => r.key)).toEqual(
      ["banidos", "campeonatos", "clas", "contas_criadas", "premiacao_total"]
    );
  });
});
