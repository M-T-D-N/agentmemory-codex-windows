import { defineConfig } from "vitest/config";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, realpathSync, rmdirSync } from "node:fs";

// Tests must never see the developer's real $HOME: config.ts reads
// ~/.agentmemory/.env underneath process.env, so asserted defaults would
// silently become whatever the local install happens to set — red on clean
// checkouts, green on machines whose .env masks a broken default. Point HOME
// at a throwaway directory for the whole run; tests that need home-dir state
// create their own sandbox and reset HOME themselves.
// Hosted Windows runners can expose TEMP through an 8.3 alias. Fixtures that
// verify physical source identity need the canonical spelling of their own root.
const testTemp = realpathSync.native(tmpdir());
const testHome = mkdtempSync(join(testTemp, "agentmemory-test-home-"));
process.once("exit", () => {
  try {
    rmdirSync(testHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(`Retained test home: ${testHome}\n`);
    }
  }
});

export default defineConfig({
  test: {
    maxWorkers: 4,
    env: {
      TEMP: testTemp,
      TMP: testTemp,
      TMPDIR: testTemp,
      HOME: testHome,
      USERPROFILE: testHome,
    },
  },
});
