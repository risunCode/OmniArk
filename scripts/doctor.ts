#!/usr/bin/env bun
/**
 * OmniArk doctor — lightweight health diagnostic.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

console.log("\n  OmniArk — Doctor\n");

const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
console.log(`Bun:        ${bun.stdout.trim() || "not found"}`);
console.log(`Node:       ${process.version}`);
console.log(`Platform:   ${process.platform}`);
console.log(`Database:   ${Bun.env.DATABASE_PATH || "data/omniark.db"} ${existsSync(Bun.env.DATABASE_PATH || "data/omniark.db") ? "(exists)" : "(will be created)"}`);
console.log(`Dashboard:  ${existsSync("dashboard/dist/index.html") ? "built" : "not built — run: bun run build"}`);

console.log("\n  Tip: run `bun src/index.ts` to start the server.\n");
