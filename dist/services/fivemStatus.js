/**
 * Polls the FiveM server-list API for this server's current online-player
 * count and caches the result in memory. The route layer (routes/serverStatus.ts)
 * only ever reads the cache — it never calls the FiveM API directly.
 */
const POLL_INTERVAL_MS = 30_000;
let cache = { online: null, lastUpdated: null };
let hasLoggedMissingCode = false;
/** Returns the last successfully-polled status. Never throws. */
export function getCachedServerStatus() {
    return cache;
}
/**
 * Resets the module-level cache to its initial state. Test-only: lets each
 * test start from a clean slate instead of depending on run order.
 */
export function resetServerStatusCacheForTests() {
    cache = { online: null, lastUpdated: null };
}
/**
 * Performs one poll attempt against the FiveM API using the given fetch
 * implementation. On success, replaces the cache. On failure (network error,
 * non-ok response, or unexpected payload shape), logs and leaves the
 * previously cached value untouched.
 */
export async function pollOnce(fetchImpl = fetch) {
    try {
        const res = await fetchImpl(`https://servers-frontend.fivem.net/api/servers/single/${process.env.FIVEM_CFX_CODE}`);
        if (!res.ok) {
            throw new Error(`fivem status poll failed with HTTP ${res.status}`);
        }
        const body = (await res.json());
        const online = body.Data?.clients;
        if (typeof online !== "number") {
            throw new Error("fivem status poll returned an unexpected payload shape");
        }
        cache = { online, lastUpdated: new Date().toISOString() };
    }
    catch (err) {
        console.error("fivem status poll failed, keeping previous cached value", err);
    }
}
/**
 * Starts polling the FiveM API every 30s. No-ops (after logging once) when
 * FIVEM_CFX_CODE is unset, so local dev never attempts a network call it
 * can't complete. Returns a stop function that clears the interval.
 */
export function startFivemPolling(fetchImpl = fetch) {
    if (!process.env.FIVEM_CFX_CODE) {
        if (!hasLoggedMissingCode) {
            console.log("FIVEM_CFX_CODE is unset; skipping FiveM online-count polling");
            hasLoggedMissingCode = true;
        }
        return () => { };
    }
    void pollOnce(fetchImpl);
    const interval = setInterval(() => {
        void pollOnce(fetchImpl);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
}
