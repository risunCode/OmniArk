#!/usr/bin/env bun
/**
 * OmniArk — Unified cross-platform installer (PRIVATE)
 *
 * ONE installer for Windows, macOS, and Linux (incl. WSL). Replaces the old
 * install.sh (Unix) + install.ps1 (Windows) pair — identical flow, single file.
 *
 * Prerequisite: Bun (this script runs on it).
 *   • Windows (PowerShell):  irm bun.sh/install.ps1 | iex
 *   • macOS / Linux / WSL:   curl -fsSL https://bun.sh/install | bash
 *   then:  bun install.ts        (or:  bun run setup)
 *
 * Environment variables (all optional):
 *   OMNIARK_HOME     Install dir       (default: ~/omniark)
 *   OMNIARK_REPO     Repo URL          (default: https://github.com/risunCode/OmniArk.git)
 *   OMNIARK_YES=1    Skip confirmation (CI / unattended)
 *   OMNIARK_BRANCH   Branch to clone   (default: main)
 *   OMNIARK_NO_CLI=1 Skip the `omniark` CLI shim
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  copyFileSync, symlinkSync, chmodSync, unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

// ── Platform ─────────────────────────────────────────────────────────
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

// Make sure child processes can find the `bun` binary running this script,
// even if it isn't globally on PATH (common right after a fresh Bun install).
const BUN_BIN = dirname(process.execPath);
process.env.PATH = `${BUN_BIN}${IS_WIN ? ";" : ":"}${process.env.PATH ?? ""}`;

// ── Config (env-driven, mirrors the old installers) ──────────────────
const REPO_URL = process.env.OMNIARK_REPO ?? "https://github.com/risunCode/OmniArk.git";
const INSTALL_DIR = process.env.OMNIARK_HOME ?? join(homedir(), "omniark");
const BRANCH = process.env.OMNIARK_BRANCH ?? "main";
const ASSUME_YES = process.env.OMNIARK_YES === "1";
const NO_CLI = process.env.OMNIARK_NO_CLI === "1";

// ── Colors ───────────────────────────────────────────────────────────
const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1"), dim = paint("2"), red = paint("31"), green = paint("32");
const yellow = paint("33"), blue = paint("34"), cyan = paint("36");

const step = (m: string) => console.log(`${cyan("===>")} ${bold(m)}`);
const info = (m: string) => console.log(`    ${m}`);
const warn = (m: string) => console.log(`${yellow("!!")}  ${m}`);
const ok = (m: string) => console.log(`${green("ok")}  ${m}`);
function fail(m: string): never { console.error(`${red("xx")}  ${m}`); process.exit(1); }

// ── Process helpers ──────────────────────────────────────────────────
interface RunOpts { cwd?: string; silent?: boolean; env?: Record<string, string>; }

/** Is `cmd` resolvable on PATH? */
function have(cmd: string): boolean {
  const argv = IS_WIN ? ["where", cmd] : ["sh", "-c", `command -v ${cmd}`];
  return Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore" }).success;
}

/** Run a command, streaming stdio. Resolves true on exit code 0. */
async function run(cmd: string, args: string[] = [], opts: RunOpts = {}): Promise<boolean> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    stdout: opts.silent ? "ignore" : "inherit",
    stderr: opts.silent ? "ignore" : "inherit",
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return (await proc.exited) === 0;
}

/** Run from an argv array (handy for prepending `sudo`). */
const runArgs = (argv: string[], opts: RunOpts = {}) => run(argv[0]!, argv.slice(1), opts);

/** Run a command capturing stdout (never throws). */
async function capture(cmd: string, args: string[] = []): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
}

/** Windows package-manager runner — `cmd /c` so .cmd/.shim resolve via PATHEXT. */
const runWin = (args: string[], opts: RunOpts = {}) => run("cmd.exe", ["/c", ...args], opts);

/** Retry with exponential backoff (for flaky network steps). */
async function retry(fn: () => Promise<boolean>, label = "command", max = 3): Promise<boolean> {
  let delay = 3;
  for (let n = 1; n <= max; n++) {
    if (await fn()) return true;
    if (n >= max) return false;
    warn(`${label} failed (attempt ${n}/${max}). Retrying in ${delay}s...`);
    await Bun.sleep(delay * 1000);
    delay *= 2;
  }
  return false;
}

/** Interactive line prompt (only used on a real TTY). */
function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const { promise, resolve } = Promise.withResolvers<string>();
  rl.question(q, (ans) => { rl.close(); resolve(ans); });
  return promise;
}

// ── Distro detection (Linux) ─────────────────────────────────────────
function distroFamily(): string {
  if (!IS_LINUX) return "";
  try {
    const txt = readFileSync("/etc/os-release", "utf8");
    const get = (k: string) => (txt.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "").replace(/"/g, "");
    const s = `${get("ID_LIKE")} ${get("ID")}`.toLowerCase();
    if (/debian|ubuntu/.test(s)) return "debian";
    if (/rhel|fedora|centos/.test(s)) return "rhel";
    if (/arch/.test(s)) return "arch";
    if (/suse/.test(s)) return "suse";
    if (/alpine/.test(s)) return "alpine";
    return "unknown";
  } catch { return "unknown"; }
}
const DISTRO = distroFamily();

/** Prepend `sudo` on Linux when we're not root and sudo exists. */
function sudo(args: string[]): string[] {
  if (IS_LINUX && (process.getuid?.() ?? 0) !== 0 && have("sudo")) return ["sudo", ...args];
  return args;
}

/** Install packages via the distro's native package manager. */
async function installLinuxPackages(pkgs: string[], update = false): Promise<boolean> {
  switch (DISTRO) {
    case "debian":
      if (update) await runArgs(sudo(["apt-get", "update", "-y"]));
      return runArgs(sudo(["apt-get", "install", "-y", ...pkgs]));
    case "rhel":
      return (await runArgs(sudo(["dnf", "install", "-y", ...pkgs])))
        || (await runArgs(sudo(["yum", "install", "-y", ...pkgs])));
    case "arch":
      return runArgs(sudo(["pacman", "-S", "--noconfirm", ...pkgs]));
    case "suse":
      return runArgs(sudo(["zypper", "-n", "install", ...pkgs]));
    case "alpine":
      return runArgs(sudo(["apk", "add", "--no-cache", ...pkgs]));
    default:
      console.error(`Install ${pkgs.join(" ")} manually for your distro and re-run.`);
      return false;
  }
}

/** Augment PATH with common Windows install locations (best-effort). */
function augmentWinPath() {
  if (!IS_WIN) return;
  const extra = [
    BUN_BIN,
    join(homedir(), ".bun", "bin"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd"),
    join(homedir(), "scoop", "shims"),
  ].filter(Boolean);
  const cur = (process.env.PATH ?? "").split(";");
  for (const d of extra) if (d && !cur.includes(d)) cur.unshift(d);
  process.env.PATH = cur.join(";");
}

// ── Steps ─────────────────────────────────────────────────────────────────────────
let PROJECT_DIR = "";

async function showSummary() {
  console.log(`\n${bold(blue("OmniArk"))} — AI Proxy Pool for Multiple Providers\n`);
  const needsGit = !have("git");
  let total = 0;
  const items: string[] = [];
  if (needsGit) { items.push("  • Git                   ~50 MB"); total += 50; }
  items.push("  • Node.js dependencies  ~200 MB"); total += 200;
  items.push("  • Dashboard build       ~50 MB"); total += 50;

  console.log(bold("This will install:"));
  items.forEach((i) => console.log(i));
  console.log(`\n${bold("Estimated total size:")} ~${total} MB`);
  console.log(`${bold("Install location:")}     ${INSTALL_DIR}`);
  console.log(`${bold("Platform:")}             ${process.platform}${DISTRO ? ` (${DISTRO})` : ""}\n`);

  if (needsGit) {
    console.log(`${yellow("Note:")} system deps (Git) install via package manager — may need ${bold(IS_WIN ? "admin" : "sudo")}.\n`);
  }
  if (ASSUME_YES) { console.log(dim("OMNIARK_YES=1 — skipping confirmation.\n")); return; }
  if (!process.stdin.isTTY) { console.log(dim("Non-interactive shell — proceeding automatically.\n")); return; }
  const answer = await prompt("Do you want to continue? [Y/n] ");
  if (/^n/i.test(answer.trim())) { console.log("Installation cancelled."); process.exit(0); }
  console.log("");
}

async function ensureGit() {
  if (have("git")) {
    const { out } = await capture("git", ["--version"]);
    ok(`Git ${out.trim().split(" ")[2] ?? ""} already installed`);
    return;
  }
  step("Installing Git");
  if (IS_WIN) {
    if (have("winget")) await runWin(["winget", "install", "--id", "Git.Git", "--silent", "--accept-package-agreements", "--accept-source-agreements"], { silent: true });
    else if (have("scoop")) await runWin(["scoop", "install", "git"], { silent: true });
    else if (have("choco")) await runWin(["choco", "install", "-y", "git"], { silent: true });
    else fail("Install Git from https://git-scm.com/download/win and re-run.");
    augmentWinPath();
  } else if (IS_MAC) {
    if (have("brew")) await run("brew", ["install", "git"]);
    else {
      info("Triggering Xcode Command-Line Tools installer (GUI dialog)...");
      await run("xcode-select", ["--install"], { silent: true });
      fail("Install git via Xcode CLT or Homebrew, then re-run.");
    }
  } else {
    await installLinuxPackages(["git"], true);
  }
  if (!have("git")) fail("git install finished but 'git' is not on PATH. Open a new terminal and re-run.");
  ok("Git installed");
}

function ensureBun() {
  // We are executing under Bun, so the runtime is guaranteed present.
  ok(`Bun ${Bun.version} (runtime)`);
}

async function cloneOrUpdateRepo() {
  // Already inside a checkout?
  if (existsSync("package.json") && /"name"\s*:\s*"omniark"/.test(readFileSync("package.json", "utf8"))) {
    PROJECT_DIR = process.cwd();
    step(`Using existing checkout: ${PROJECT_DIR}`);
    if (existsSync(".git")) {
      info("Pulling latest...");
      if (!(await run("git", ["pull", "--ff-only"], { silent: true }))) warn("git pull failed (continuing with current checkout)");
    }
    return;
  }
  if (existsSync(join(INSTALL_DIR, ".git"))) {
    PROJECT_DIR = INSTALL_DIR;
    step(`Updating existing checkout at ${PROJECT_DIR}`);
    if (!(await run("git", ["pull", "--ff-only"], { cwd: PROJECT_DIR, silent: true }))) warn("git pull failed");
  } else {
    PROJECT_DIR = INSTALL_DIR;
    step(`Cloning ${REPO_URL} → ${PROJECT_DIR} (branch: ${BRANCH})`);
    if (!(await run("git", ["clone", "--depth=1", "--branch", BRANCH, REPO_URL, PROJECT_DIR]))) {
      fail(`git clone failed. Check connectivity and repo URL: ${REPO_URL}`);
    }
  }
  process.chdir(PROJECT_DIR);
}

function writeEnvIfMissing() {
  step("Configuring .env");
  let env: string;
  if (existsSync(".env")) { info(".env already exists, checking for missing keys..."); env = readFileSync(".env", "utf8"); }
  else { copyFileSync(".env.example", ".env"); info("Created .env from .env.example"); env = readFileSync(".env", "utf8"); }

  const lines = env.split(/\r?\n/);
  const getKey = (key: string) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
  const setKey = (key: string, val: string) => {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${val}`; else lines.push(`${key}=${val}`);
  };

  // Generate ENCRYPTION_KEY if it's still the placeholder / empty.
  const enc = getKey("ENCRYPTION_KEY");
  if (!enc || enc === "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6") {
    setKey("ENCRYPTION_KEY", randomBytes(16).toString("hex"));
    ok("Generated random ENCRYPTION_KEY");
  }
  // Auto-rotate API_KEY off the default placeholder.
  if (getKey("API_KEY") === "pool-proxy-secret-key") {
    const k = randomBytes(24).toString("hex");
    setKey("API_KEY", k);
    ok("Generated random API_KEY");
    info(`  Your API key: ${k}`);
    info("  Clients send this as: Authorization: Bearer <api_key>");
  }
  // Ensure other required keys exist (defaults pulled from .env.example).
  const example = existsSync(".env.example") ? readFileSync(".env.example", "utf8") : "";
  for (const key of ["PORT", "DASHBOARD_PORT", "API_KEY", "DATABASE_PATH"]) {
    if (!lines.some((l) => l.startsWith(`${key}=`))) {
      const def = example.split(/\r?\n/).find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
      lines.push(`${key}=${def}`); info(`Added missing ${key}`);
    }
  }
  writeFileSync(".env", lines.join("\n"));
}

async function installNodeDeps() {
  step("Installing JS dependencies");
  info("Installing root dependencies...");
  if (!(await retry(() => run("bun", ["install"]), "bun install"))) fail("bun install failed in project root. Try manually: bun install");
  info("Installing dashboard dependencies...");
  if (!(await retry(() => run("bun", ["install"], { cwd: "dashboard" }), "bun install (dashboard)"))) {
    fail("bun install failed in dashboard/. Try manually: cd dashboard && bun install");
  }
  ok("JS dependencies installed");
}

async function buildDashboard() {
  step("Building dashboard (production)");
  if (!(await retry(() => run("bun", ["run", "build"], { cwd: "dashboard" }), "dashboard build"))) {
    fail("Dashboard build failed. Try manually: cd dashboard && bun run build");
  }
  ok("Dashboard built");
}

async function runMigrations() {
  step("Running database migrations");
  mkdirSync("data", { recursive: true });
  if (await run("bun", ["src/db/migrate.ts"])) ok("Migrations applied");
  else { warn("Migrations failed. Database will be created on first run."); info("After first run, re-run: bun src/db/migrate.ts"); }
}

async function installCliShims() {
  if (NO_CLI) { warn("OMNIARK_NO_CLI=1 — skipping CLI install"); return; }
  step("Installing CLI commands");
  const target = join(homedir(), ".local", "bin");
  mkdirSync(target, { recursive: true });

  if (IS_WIN) {
    for (const f of ["omniark.ps1", "omniark.cmd"]) {
      const src = join(PROJECT_DIR, f);
      if (existsSync(src)) copyFileSync(src, join(target, f));
      else warn(`${f} not found at ${src}`);
    }
    ok(`Installed omniark command to ${target}`);
    if (!(process.env.PATH ?? "").split(";").includes(target)) {
      warn(`${target} is not on your PATH.`);
      info(`  Session:   $env:Path = "${target};$env:Path"`);
      info(`  Permanent: setx Path "${target};%Path%"`);
    }
  } else {
    const src = join(PROJECT_DIR, "omniark");
    const link = join(target, "omniark");
    try {
      if (existsSync(link)) unlinkSync(link);
      symlinkSync(src, link);
      chmodSync(src, 0o755);
      ok(`Linked ${link} -> ${src}`);
    } catch (e) {
      warn(`Could not create symlink: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!(process.env.PATH ?? "").split(":").includes(target)) {
      warn(`${target} is not on your PATH.`);
      info(`  Add to ~/.bashrc or ~/.zshrc:  export PATH="$HOME/.local/bin:$PATH"`);
    }
  }
}

async function runPreflight() {
  step("Running preflight check");
  if (await run("bun", ["scripts/preflight.ts"])) return;
  warn("Preflight reported issues — see above. The server may still start.");
  info("Run `omniark doctor` for a detailed report.");
}

function printDone() {
  console.log(`\n${green("✓ Installation complete!")}\n`);
  console.log(`OmniArk is installed at: ${PROJECT_DIR}\n`);
  console.log(bold("Quick Start:"));
  console.log(`  1. Start the server:  ${cyan("omniark start")}`);
  console.log(`  2. Open the dashboard: ${cyan("http://localhost:1931")}`);
  console.log("  3. Add accounts via the dashboard UI\n");
  console.log(`${bold("Commands:")} omniark status | logs | stop | restart | doctor | update | help\n`);
  console.log(dim("Tip: re-run this installer any time to pull updates and rebuild."));
  console.log(dim("Tip: trouble? run `omniark doctor` for a checklist of fixes."));
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${blue("OmniArk Installer")} ${dim(`(unified — ${process.platform}${DISTRO ? "/" + DISTRO : ""})`)}\n`);
  augmentWinPath();

  await showSummary();
  await ensureGit();
  ensureBun();
  await cloneOrUpdateRepo();

  process.chdir(PROJECT_DIR);
  writeEnvIfMissing();
  await installNodeDeps();
  await buildDashboard();
  await runMigrations();
  await installCliShims();
  await runPreflight();

  printDone();
}

main().catch((e) => {
  console.error(`${red("xx")}  ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
