"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const directory = __dirname;
const build = JSON.parse(fs.readFileSync(path.join(directory, "build-info.json"), "utf8"));
const lockPath = path.join(directory, "package-lock.json");
const statePath = path.join(directory, ".echoes-dependency-state.json");
let runtime = null;
let bootstrapState = { state: "checking", message: "Checking server dependencies." };

function safeMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{24,}/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@").slice(0, 2_000);
}

function lockHash() {
  return crypto.createHash("sha256").update(fs.readFileSync(lockPath)).digest("hex");
}

function expectedState() {
  const actualLockHash = lockHash();
  const builtLockHash = String(build.productionLockSha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(builtLockHash)) {
    throw new Error("Build metadata does not contain a valid production lock hash.");
  }
  if (actualLockHash !== builtLockHash) {
    throw new Error("Production lock hash does not match the build metadata.");
  }
  return {
    lockHash: actualLockHash,
    platform: process.platform,
    arch: process.arch,
    abi: process.versions.modules,
    lanceVersion: "0.31.0",
    ipaddrVersion: "2.2.0",
  };
}

function stateMatches(expected) {
  try {
    const current = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return Object.keys(expected).every((key) => current[key] === expected[key]);
  } catch {
    return false;
  }
}

function verifyDependencies() {
  const packageJson = require(path.join(directory, "node_modules", "@lancedb", "lancedb", "package.json"));
  if (packageJson.version !== "0.31.0") throw new Error(`Unexpected LanceDB version: ${packageJson.version}`);
  require(path.join(directory, "node_modules", "@lancedb", "lancedb"));
  const ipaddrPackage = require(path.join(directory, "node_modules", "ipaddr.js", "package.json"));
  if (ipaddrPackage.version !== "2.2.0") throw new Error(`Unexpected ipaddr.js version: ${ipaddrPackage.version}`);
  require(path.join(directory, "node_modules", "ipaddr.js"));
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js"),
    "/usr/share/nodejs/npm/bin/npm-cli.js",
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("npm-cli.js was not found; install npm alongside Node.js.");
  return found;
}

function installDependencies() {
  const expected = expectedState();
  if (stateMatches(expected)) {
    try {
      verifyDependencies();
      return expected;
    } catch {
      // Reinstall below.
    }
  }
  const result = spawnSync(process.execPath, [npmCliPath(),
    "ci",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ], {
    cwd: directory,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 10 * 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "npm ci failed").slice(-2_000);
    throw new Error(`Dependency installation failed (${result.status}): ${detail}`);
  }
  verifyDependencies();
  fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(expected, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(`${statePath}.tmp`, statePath);
  return expected;
}

function limitedStatus() {
  const [nodeMajor = Number.NaN, nodeMinor = Number.NaN] = process.versions.node
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return {
    build,
    protocolCompatible: true,
    platform: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      supported: ["win32", "linux"].includes(process.platform)
        && process.arch === "x64"
        && (nodeMajor === 22 || (nodeMajor === 20 && nodeMinor >= 9)),
    },
    bootstrap: bootstrapState,
    subsystems: { credentials: "unavailable", jobs: "unavailable", retrieval: "unavailable" },
    pendingMigrations: [],
  };
}

async function init(router) {
  router.get("/health", (_request, response) => response.json({
    ok: bootstrapState.state !== "degraded",
    build,
    bootstrap: bootstrapState,
  }));
  try {
    const dependency = installDependencies();
    bootstrapState = { state: "ready", dependencyHash: dependency.lockHash };
    process.env.ECHOES_BOOTSTRAP_STATE = "ready";
    process.env.ECHOES_DEPENDENCY_HASH = dependency.lockHash;
    runtime = require(path.join(directory, "runtime.cjs"));
    await runtime.init(router);
  } catch (error) {
    bootstrapState = { state: "degraded", message: safeMessage(error) };
    process.env.ECHOES_BOOTSTRAP_STATE = "degraded";
    process.env.ECHOES_BOOTSTRAP_MESSAGE = bootstrapState.message;
    router.get("/system/status", (_request, response) => response.json(limitedStatus()));
    router.post("/system/diagnostics", (_request, response) => {
      const now = new Date().toISOString();
      const status = limitedStatus();
      const checks = [{
        id: "bootstrap_dependency",
        title: "Server dependencies",
        state: "fail",
        message: bootstrapState.message,
      }];
      response.status(202).json({
        job: {
          id: `bootstrap_diagnostic_${Date.now()}`,
          type: "system-diagnostics",
          status: "succeeded",
          progress: 1,
          message: "Limited diagnostics completed",
          createdAt: now,
          updatedAt: now,
          result: {
            status,
            checks,
            bundle: {
              build,
              platform: status.platform,
              bootstrap: status.bootstrap,
              subsystems: status.subsystems,
              checks,
              generatedAt: now,
            },
          },
        },
      });
    });
    console.error("[Echoes] Limited maintenance mode:", bootstrapState.message);
  }
}

async function exit() {
  if (runtime?.exit) await runtime.exit();
}

module.exports = {
  init,
  exit,
  info: {
    id: "echoes-memory",
    name: "Echoes Memory System",
    description: "Structured and semantic long-term memory for SillyTavern.",
  },
};
