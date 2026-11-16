/**
 * Lazily build the managed venv the kernel boots in.
 *
 * The plugin used to build it from an npm `postinstall` hook, and that hook is what makes a `github:` plugin
 * install fail: a lifecycle script makes the package manager *prepare* the git checkout, and the npm embedded
 * in OpenCode's compiled binary prepares it by re-launching its own executable with `B:\~BUN\bin\npm-cli.js`
 * -- the opencode CLI -- so the install dies in preparation and the plugin never loads. Building on first use
 * keeps an install a plain dependency install with no scripts to run.
 *
 * The same trap rules how the build is *invoked*: `process.execPath` here is the OpenCode executable, so
 * spawning it with a script argument would run the opencode CLI instead of the builder. The builder is a
 * module with a library form (`scripts/setup-venv.mjs` exports `setupManagedVenv` and never touches the
 * process), so it is imported and awaited. Whether the venv exists, is repairable, or cannot be built is
 * decided there, once -- not re-derived here.
 *
 * Single-flight on disk, so the several processes that load this plugin (the managed service and each CLI
 * worker) do not race into one half-built venv, and one verdict per process: a build that failed is not
 * retried on every call, a build that succeeded is not re-checked either.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clearPythonProbeCache, managedVenvDir, managedVenvPython, resolvePython } from "./python-locate.js";

const LOCK_NAME = ".venv-bootstrap.lock";

/**
 * A cold venv build is a uv/pip install over a real dependency tree, and it runs on the clock of the tool call
 * that triggered it. Two minutes covers a warm cache or a fast link; a cold install on a slow one wants a
 * bigger budget (`PYTOOL_VENV_BOOTSTRAP_MS`) or the manual `npm run setup-venv`.
 */
const DEFAULT_BOOTSTRAP_MS = 120_000;

/** While another process builds, this one waits a little -- then lets the normal resolution/error path speak. */
const DEFAULT_LOCK_WAIT_MS = 20_000;

/** A lock older than this belongs to a process that died mid-build, not to a build in flight. */
const STALE_LOCK_MS = 15 * 60_000;

/** Outcomes already settled in this process, keyed by venv dir: one check, one verdict, per install. */
const settled = new Map<string, { status: VenvBootstrapStatus; detail?: string }>();

export type VenvBootstrapStatus = "skipped" | "already-present" | "built" | "failed";

export interface VenvBootstrapResult {
  status: VenvBootstrapStatus;
  python: string;
  detail?: string;
  log?: string;
  tookMs: number;
}

/** What a venv builder owes the bootstrap: a status, and a reason when the status is not good. */
interface VenvBuilder {
  setupManagedVenv?: (options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    stepTimeoutMs?: number;
    quiet?: boolean;
  }) => Promise<{ status?: string; detail?: string; log?: string }>;
}

/**
 * The builder. `PYTOOL_BOOTSTRAP_SCRIPT` replaces it -- for the tests, and for an operator who wants a
 * corporate wrapper to own the interpreter environment instead of this package's script.
 */
function bootstrapScript(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PYTOOL_BOOTSTRAP_SCRIPT) return env.PYTOOL_BOOTSTRAP_SCRIPT;
  // NodeNext without `baseDir`: this module's URL is the only reliable handle on the package root, and
  // fileURLToPath is what turns it back into a path a Windows `existsSync` understands.
  return fileURLToPath(new URL("../../scripts/setup-venv.mjs", import.meta.url));
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** The lock sits beside the venv, never inside it: `python -m venv --clear` empties the venv directory. */
function lockFile(env: NodeJS.ProcessEnv): string {
  return join(dirname(managedVenvDir(env)), LOCK_NAME);
}

function readLock(path: string): { pid: number; startedAt: number } | null {
  try {
    const [pid, startedAt] = readFileSync(path, "utf8").trim().split("|");
    const at = Number(startedAt);
    return { pid: Number(pid) || 0, startedAt: Number.isFinite(at) ? at : 0 };
  } catch {
    return null;
  }
}

/**
 * Take the build lock. `wx` also fails when the lock directory does not exist yet, so create it and try once
 * more. A lock left behind by a dead process is cleared: a crash must not wedge the tool for the session.
 */
function takeLock(path: string): { fd: number } | { held: true } | { broken: string } {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid}|${Date.now()}`);
      return { fd };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        try {
          mkdirSync(dirname(path), { recursive: true });
        } catch {}
        continue;
      }
      if (code !== "EEXIST") return { broken: `${code ?? ""} ${error instanceof Error ? error.message : String(error)}`.trim() };
      const heldFor = readLock(path);
      if (heldFor && Date.now() - heldFor.startedAt > STALE_LOCK_MS) {
        try {
          rmSync(path, { force: true });
        } catch {}
        continue; // one retry at most
      }
      return { held: true };
    }
  }
  return { broken: `could not create the venv build lock at ${path}` };
}

/**
 * Make sure the managed venv exists, building it if this process is the one that has to.
 *
 * Never throws and never takes a tool call down: the caller keeps the interpreter resolution it has, and
 * `detail` carries what went wrong for the diagnostic that reaches the agent.
 */
export async function ensureManagedVenv(env: NodeJS.ProcessEnv = process.env): Promise<VenvBootstrapResult> {
  const startedAt = Date.now();
  const venvDir = managedVenvDir(env);
  const python = managedVenvPython(env);
  const settle = (
    status: VenvBootstrapStatus,
    extra: { detail?: string; log?: string; memo?: boolean } = {},
  ): VenvBootstrapResult => {
    if (extra.memo !== false && status !== "skipped") settled.set(venvDir, { status, detail: extra.detail });
    return { status, python, tookMs: Date.now() - startedAt, detail: extra.detail, log: extra.log };
  };

  // The operator's own answers win: an explicit opt-out, or a pinned interpreter that already hosts the
  // bridge, means nothing gets built behind the user's back.
  if (env.PYTOOL_SKIP_VENV === "1") return settle("skipped", { detail: "PYTOOL_SKIP_VENV=1" });
  if (env.PYTOOL_PYTHON || env.PYTHON) {
    const pinned = resolvePython({ env });
    if (pinned.ok && pinned.source !== "managed-venv") return settle("skipped", { detail: `pinned interpreter: ${pinned.argv.join(" ")}` });
  }

  const previous = settled.get(venvDir);
  if (previous) {
    // the first call in this process did the work; every later one reports the state, not a second build
    const status: VenvBootstrapStatus = previous.status === "built" ? "already-present" : previous.status;
    return { status, python, tookMs: Date.now() - startedAt, detail: previous.detail };
  }

  const script = bootstrapScript(env);
  if (!existsSync(script)) return settle("failed", { detail: `bootstrap script is missing: ${script}` });

  const got = takeLock(lockFile(env));
  if ("held" in got) {
    // Someone else is building it: this is the path where one session starts the install and another one, a
    // second later, should simply use the result instead of starting a second install.
    const until = Date.now() + DEFAULT_LOCK_WAIT_MS;
    while (Date.now() < until) {
      if (existsSync(python)) {
        clearPythonProbeCache();
        return settle("built", { detail: "built by another process" });
      }
      await sleep(500);
    }
    return settle("failed", { detail: `another process is building the venv at ${venvDir}; waited ${DEFAULT_LOCK_WAIT_MS / 1000}s.` });
  }
  if (!("fd" in got)) return settle("failed", { detail: got.broken });

  try {
    const budget = Number(env.PYTOOL_VENV_BOOTSTRAP_MS) > 0 ? Number(env.PYTOOL_VENV_BOOTSTRAP_MS) : DEFAULT_BOOTSTRAP_MS;
    let builder: VenvBuilder;
    try {
      builder = (await import(pathToFileURL(script).href)) as VenvBuilder;
    } catch (error) {
      return settle("failed", { detail: `could not load the venv builder ${script}: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (typeof builder.setupManagedVenv !== "function")
      return settle("failed", { detail: `${script} does not export setupManagedVenv; it is not a venv builder.` });

    // quiet: the builder's child processes are piped, so their noise ends up in `log` for the caller to
    // surface rather than in the middle of another session's tool output
    const r = await builder.setupManagedVenv({ env, timeoutMs: budget, stepTimeoutMs: budget, quiet: true });
    const report = (r?.log ?? "").trim();
    switch (r?.status) {
      case "ready":
        // nothing to do, and the answer is worth caching: the resolver may already have written this off
        clearPythonProbeCache();
        return settle("already-present", { log: report });
      case "created":
      case "repaired":
        if (!existsSync(python))
          return settle("failed", { detail: `builder reported ${r.status}, but ${python} is not there`, log: report });
        // a venv built after this process resolved its interpreter must be visible to the next boot
        clearPythonProbeCache();
        return settle("built", { log: report });
      case "skipped":
        return settle("skipped", { detail: "the builder declined to build the venv", log: report });
      case "failed":
        return settle("failed", { detail: r.detail ?? "the venv builder reported a failure without a reason", log: report });
      default:
        return settle("failed", { detail: `the venv builder reported status=${String(r?.status)}; no such status.`, log: report });
    }
  } catch (error) {
    // a builder that throws must not become the agent's error: the plugin's own message names the fix
    return settle("failed", { detail: `venv builder threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` });
  } finally {
    try {
      closeSync(got.fd);
    } catch {}
    try {
      rmSync(lockFile(env), { force: true });
    } catch {}
  }
}

/** The verdict this process already reached, so the plugin's own error text can name the reason. */
export function venvBootstrapOutcome(env: NodeJS.ProcessEnv = process.env): { status: VenvBootstrapStatus; detail?: string } | undefined {
  return settled.get(managedVenvDir(env));
}
