import { beforeEach, expect, test, vi } from "vitest";
import { getCachedServerStatus, pollOnce, resetServerStatusCacheForTests } from "../../src/services/fivemStatus.js";

beforeEach(() => {
  resetServerStatusCacheForTests();
});

test("a successful poll updates the cache with the players array length", async () => {
  const fakeFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Data: { clients: 143 } }) });
  await pollOnce(fakeFetch as unknown as typeof fetch);
  expect(getCachedServerStatus().online).toBe(143);
});

test("a failed poll leaves the previous cached value in place", async () => {
  await pollOnce(
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Data: { clients: 143 } }) }) as unknown as typeof fetch
  );
  await pollOnce(vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch);
  expect(getCachedServerStatus().online).toBe(143);
});
