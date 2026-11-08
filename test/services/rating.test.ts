import { expect, test } from "vitest";
import { calculateRating } from "../../src/services/rating.js";

test("calculateRating weights wins, kd, inverted position, and avg kills, with a ranked bonus", () => {
  const base = calculateRating({ wins: 7, kd: 2.59, avgPosition: 8.5, avgKills: 3.16, ranked: false });
  // winsScore 7*30=210, kdScore 2.59*25=64.75, positionScore (100-8.5)*0.25=22.875, killsScore 3.16*20=63.2
  // sum = 360.825
  expect(base).toBeCloseTo(360.825, 2);
});

test("ranked matches get a 5% bonus over the same unranked stats", () => {
  const unranked = calculateRating({ wins: 7, kd: 2.59, avgPosition: 8.5, avgKills: 3.16, ranked: false });
  const ranked = calculateRating({ wins: 7, kd: 2.59, avgPosition: 8.5, avgKills: 3.16, ranked: true });
  expect(ranked).toBeCloseTo(unranked * 1.05, 2);
});

test("avgPosition at or beyond 100 contributes zero, never negative", () => {
  const r = calculateRating({ wins: 0, kd: 0, avgPosition: 150, avgKills: 0, ranked: false });
  expect(r).toBe(0);
});
