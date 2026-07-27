#!/usr/bin/env bun
/**
 * OmniArk preflight check.
 *
 * Lightweight sanity check before first start. Does not require Python/browser.
 */

import { spawnSync } from "node:child_process";

let ok = true;

function check(name: string, passed: boolean, hint: string) {
  if (passed) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}: ${hint}`);
    ok = false;
  }
}

console.log("\n  OmniArk — Preflight\n");

const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
check("Bun runtime", bun.status === 0, "Install Bun: https://bun.sh");

const env = Bun.env;
check("Database path", !!env.DATABASE_PATH || true, "Using default data/omniark.db");
check("Encryption key", (env.ENCRYPTION_KEY?.length ?? 0) >= 16, "Set a strong ENCRYPTION_KEY in .env");

const dist = Bun.file("dashboard/dist/index.html");
check("Dashboard build", await dist.exists(), "Run: bun run build");

console.log(ok ? "\n  ✓ Preflight passed\n" : "\n  ✗ Preflight found issues\n");
process.exit(ok ? 0 : 1);
