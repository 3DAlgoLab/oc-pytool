/**
 * Lazy venv bootstrap: the managed interpreter environment is built on the first boot that needs one, under a
 * cross-process lock, and one verdict per process -- a build that failed is not retried on every call, a build
 * that succeeded is not re-checked either.
 *
 * `test/fixtures/fake-setup-venv.mjs` stands in for the real builder: it keeps the contract the bootstrap
 * relies on (an exported `setupManagedVenv` resolving to `{ status, detail, log }`) and leaves an audit trail
 * of how many builds actually ran, so these tests prove the policy without paying for a uv/pip install. The
 * real `scripts/setup-venv.mjs` gets one check of its own: the bootstrap imports it rather than spawning an
 * executable for it, so its library form has to be inert in a process it did not start.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureManagedVenv, venvBootstrapOutcome } from "../src/engine/venv-bootstrap.js";

const FAKE = join(import.meta.dir, "fixtures", "fake-setup-venv.mjs");

const win = process.platform === "win32";

let scratch = "";

const fakeVenvDir = () => join(scratch, "venv");
const fakePython = () => join(fakeVenvDir(), win ? "Scripts" : "bin", win ? "python.exe" : "python3");
const marks = () => join(scratch, "bootstrap-marks");

/** Isolated env: the venv, its lock and the build audit trail all live under this test's scratch directory.
 *  PYTOOL_BOOTSTRAP_SCRIPT is the knob that points the bootstrap at the fake builder. */
function fakeEnv(mode: string) {
	return {
		PYTOOL_BOOTSTRAP_SCRIPT: FAKE,
		PYTOOL_BOOTSTRAP_MODE: mode,
		PYTOOL_VENV: fakeVenvDir(),
		XDG_DATA_HOME: join(scratch, "xdg"),
		PYTOOL_PYTHON: "",
	};
}

function buildAttempts(): string[] {
	try {
		return readFileSync(marks(), "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "pytool-bootstrap-"));
	mkdirSync(fakeVenvDir(), { recursive: true });
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("ensureManagedVenv", () => {
	test("builds once, on the boot that needs it", async () => {
		const env = fakeEnv("create");
		const first = await ensureManagedVenv(env);
		expect(first.status).toBe("built");
		expect(first.python).toBe(fakePython());
		expect(existsSync(fakePython())).toBe(true);
		expect(first.tookMs).toBeGreaterThanOrEqual(0);
		expect(buildAttempts().length).toBe(1);
	});

	test("the same process never builds twice", async () => {
		const env = fakeEnv("create");
		expect((await ensureManagedVenv(env)).status).toBe("built");
		const again = await ensureManagedVenv(env);
		expect(again.status).toBe("already-present");
		expect(buildAttempts().length).toBe(1);
	});

	test("a healthy venv costs one status line, not a rebuild", async () => {
		const env = fakeEnv("ready");
		const r = await ensureManagedVenv(env);
		expect(r.status).toBe("already-present");
		expect(existsSync(fakePython())).toBe(false);
		expect(buildAttempts().length).toBe(1);
	});

	test("PYTOOL_SKIP_VENV=1 defers the build to the operator", async () => {
		const env = { ...fakeEnv("create"), PYTOOL_SKIP_VENV: "1" };
		const r = await ensureManagedVenv(env);
		expect(r.status).toBe("skipped");
		expect(r.detail).toContain("PYTOOL_SKIP_VENV");
		expect(existsSync(fakePython())).toBe(false);
		expect(buildAttempts().length).toBe(0);
	});

	test("a failed build is reported, remembered, and not retried per call", async () => {
		const env = fakeEnv("fail");
		const first = await ensureManagedVenv(env);
		expect(first.status).toBe("failed");
		expect(first.detail).toContain("no usable python found");
		expect(venvBootstrapOutcome(env)?.status).toBe("failed");
		const second = await ensureManagedVenv(env);
		expect(second.status).toBe("failed");
		expect(second.detail).toBe(first.detail);
		expect(buildAttempts().length).toBe(1);
	});

	test("concurrent boots share one build", async () => {
		const env = fakeEnv("slow");
		const both = await Promise.all([ensureManagedVenv(env), ensureManagedVenv(env)]);
		expect(both.map((b) => b.status).sort()).toEqual(["built", "built"]);
		expect(buildAttempts().length).toBe(1);
	});

	test("a lock left behind by a dead process is reclaimed", async () => {
		const env = fakeEnv("create");
		writeFileSync(join(scratch, ".venv-bootstrap.lock"), `999999|${Date.now() - 16 * 60_000}`);
		const r = await ensureManagedVenv(env);
		expect(r.status).toBe("built");
		expect(existsSync(fakePython())).toBe(true);
	});

	test("the builder's lock is not left behind after a successful build", async () => {
		const env = fakeEnv("create");
		await ensureManagedVenv(env);
		expect(existsSync(join(scratch, ".venv-bootstrap.lock"))).toBe(false);
	});

	test("scripts/setup-venv.mjs is import-safe: only a direct run owns the process", async () => {
		const script = join(import.meta.dir, "..", "scripts", "setup-venv.mjs");
		// the bootstrap imports the builder instead of spawning `process.execPath` with it (that executable is
		// the opencode CLI), so the library form must be inert: no build, no output, no exit code
		const child = spawnSync(
			process.execPath,
			["-e", "import(process.env.PYTOOL_IMPORT_TARGET).then(m => { if (typeof m.setupManagedVenv !== 'function') process.exitCode = 3; })"],
			{ encoding: "utf8", timeout: 60_000, env: { ...process.env, PYTOOL_IMPORT_TARGET: pathToFileURL(script).href } },
		);
		expect(child.stdout).toBe("");
		expect(child.stderr).toBe("");
		expect(child.status).toBe(0);
	});
});
