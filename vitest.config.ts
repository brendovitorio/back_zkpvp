import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file in this package shares one real Postgres database
    // (see src/db/pool.ts) rather than a mocked/per-file DB. In particular
    // test/db/seed.test.ts runs `TRUNCATE TABLE ...` across every domain
    // table. Under Vitest's default file-level parallelism, that TRUNCATE
    // races against whichever other route test file is mid-insert/query
    // against the same tables, causing intermittent failures unrelated to
    // the code under test. Running files sequentially avoids the race.
    fileParallelism: false,
  },
});
