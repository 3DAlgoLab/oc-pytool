#!/usr/bin/env node
/**
 * Build (or repair in place) the managed interpreter environment the bridge boots in.
 *
 * It runs twice: as this script (`npm run setup-venv`), and imported by the plugin, which builds the venv on
 * the first boot that needs one (src/engine/venv-bootstrap.ts). There is deliberately no install-time lifecycle
 * script in package.json: a `prepare`/`postinstall` hook makes the package manager *prepare* a git dependency,
 * and the npm embedded in OpenCode's compiled binary prepares it by re-launching its own `process.execPath`
 * with `B:\~BUN\bin\npm-cli.js` -- that is the opencode CLI, so the install dies on "Unrecognized flag:
 * --force in command opencode" and the plugin never loads.
 *
 * So the library form must not kill its host: no process.exit, no synchronous spawn. Only running this file
 * directly sets an exit code and prints as a CLI.
 *
 * Location: $XDG_DATA_HOME/opencode/pytool/venv, else ~/.local/share/opencode/pytool/venv -- OpenCode's
 * own data directory on every platform, so a plugin install that never builds anything still finds the venv in
 * the place the runtime looks (src/engine/python-locate.ts applies the identical rule; keep the two in step, a
 * venv built with one layout and resolved with the other is a dead evaluator hiding behind a healthy-looking
 * install log). PYTOOL_VENV moves it for machines that want it elsewhere.
 *
 * The interpreter lives in Scripts/ on Windows and bin/ elsewhere.
 *
 * Everything runs through spawn, never a shell, so a profile path containing spaces cannot break the
 * install. A uv-created venv has no pip of its own, so installs go through uv whenever uv is present -- but
 * the venv is seeded with pip anyway, because the next session's agent reaches for "python -m pip install"
 * by reflex, and a failure there costs it several calls to find its way back to uv.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WIN = process.platform === "win32";

/** Duplicated in src/engine/python-locate.ts on purpose: this file must stay runnable by a bare `node`. */
export function managedVenvDir(env = process.env, home = homedir()) {
	if (env.PYTOOL_VENV) return env.PYTOOL_VENV;
	const data = env.XDG_DATA_HOME || join(home, ".local", "share");
	return join(data, "opencode", "pytool", "venv");
}

export function managedVenvPython(env = process.env, platform = process.platform, home = homedir()) {
	return join(managedVenvDir(env, home), platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python3");
}

// What bridge.py needs in order to boot -- probed as importable *module* names, never pip names.
export const CORE_MODULES = ["ipykernel", "jupyter_client"];
// [pip name, import name]: pywin32 installs win32com/win32api/pythoncom and there is no "pywin32"
// module, so probing the pip name would call a healthy install broken. It is the whole point of this
// tool on Windows (COM: DraftSight, Excel, AutoCAD, serial ports); its absence is a warning, not a
// dead install.
const EXTRA_PACKAGES = WIN ? [["pywin32", "win32com"]] : [];
const INSTALL_PACKAGES = [...CORE_MODULES, ...EXTRA_PACKAGES.map(([pip]) => pip)];

/** Wall clock one step gets; a hung installer must not sit on the session forever. */
const STEP_TIMEOUT_MS = 900_000;

/** A step's budget, or the default when the caller named none. */
const stepMs = (opts) => (opts.stepTimeoutMs > 0 ? opts.stepTimeoutMs : STEP_TIMEOUT_MS);

/**
 * Run one program with argv, never through a shell, never synchronously: the library form runs inside the
 * OpenCode server, and a spawnSync there freezes every other session in the process.
 */
function run(program, args, { quiet = false, timeoutMs = STEP_TIMEOUT_MS } = {}) {
	return new Promise((res, rej) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let child;
		try {
			child = spawn(program, args, { stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true });
		} catch (error) {
			rej(new Error(`${program} failed to start: ${error?.message ?? error}`));
			return;
		}
		child.stdout?.on("data", (b) => (stdout += b));
		child.stderr?.on("data", (b) => (stderr += b));
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {}
		}, timeoutMs);
		timer.unref?.();
		child.on("error", (error) => {
			clearTimeout(timer);
			rej(new Error(`${program} failed to start: ${error?.message ?? error}`));
		});
		child.on("close", (status, signal) => {
			clearTimeout(timer);
			res({ status, signal, stdout, stderr, timedOut, ok: status === 0 && !timedOut });
		});
	});
}

/**
 * Ask an interpreter which runtime deps it can host. find_spec never executes package code, so probing
 * an environment we do not own is safe.
 */
async function missingModules(python, modules, prefixArgs = []) {
	const probe = [
		"import importlib.util as u",
		`print('DEPS ' + ','.join(n for n in ${JSON.stringify(modules)} if u.find_spec(n) is not None))`,
	].join("; ");
	const r = await run(python, [...prefixArgs, "-c", probe], { quiet: true, timeoutMs: 60_000 });
	const line = /^DEPS (.*)$/m.exec(`${r.stdout ?? ""}`)?.[1]?.trim() ?? "";
	const present = line ? line.split(",").filter(Boolean) : [];
	return modules.filter((d) => !present.includes(d));
}

async function hasUv() {
	try {
		return (await run("uv", ["--version"], { quiet: true, timeoutMs: 30_000 })).ok;
	} catch {
		return false;
	}
}

/** Interpreters that could host a venv build, most likely first. */
async function systemPythons() {
	const candidates = WIN
		? [["python", []], ["python3", []], ["py", ["-3"]]]
		: [["python3", []], ["python", []]];
	for (const [program, prefix] of candidates) {
		try {
			if ((await run(program, [...prefix, "--version"], { quiet: true, timeoutMs: 30_000 })).ok) return [program, prefix];
		} catch {}
	}
	return null;
}

/** An optional package that failed to land is worth reporting, but must not fail the whole install. */
async function reportExtras(py, warn) {
	const missing = await missingModules(py, EXTRA_PACKAGES.map(([, imported]) => imported));
	if (missing.length === 0) return;
	const names = EXTRA_PACKAGES.filter(([, imported]) => missing.includes(imported)).map(([pip]) => pip);
	warn(`installed but not importable: ${names.join(", ")} - COM work will not load.`);
}

/**
 * Give the venv the pip module if it lacks one.
 *
 * A venv without pip is a trap for the next session: the first missing package makes the agent run
 * "python -m pip install", watch it die with "No module named pip", and go looking for some other
 * interpreter -- which is where packages end up installed somewhere the kernel never runs. Failure here is a
 * warning, not a dead install: the evaluator works without pip, and pytool's import hint prints the uv form.
 */
async function ensurePip(py, uv, warn, log, opts = {}) {
	if ((await missingModules(py, ["pip"])).length === 0) return;
	try {
		if (uv) await run("uv", ["pip", "install", "--python", py], { timeoutMs: stepMs(opts), quiet: opts.quiet });
		else await run(py, ["-m", "ensurepip", "--upgrade"], { timeoutMs: stepMs(opts), quiet: opts.quiet });
	} catch (error) {
		warn(`could not add pip to the venv (${error?.message ?? error}); install packages with uv against ${py}.`);
		return;
	}
	if ((await missingModules(py, ["pip"])).length > 0) {
		warn(`pip is still not importable next to ${py}; install packages with uv against it.`);
		return;
	}
	log("added pip to the venv.");
}

function addPackagesHint(uv, py) {
	return uv ? `uv pip install --python "${py}" <pkg>` : `"${py}" -m pip install <pkg>`;
}

async function installDeps(py, uv, opts = {}) {
	if (uv) {
		await run("uv", ["pip", "install", "--python", py, ...INSTALL_PACKAGES], { timeoutMs: stepMs(opts), quiet: opts.quiet });
		return;
	}
	await run(py, ["-m", "pip", "install", "--upgrade", "pip"], { timeoutMs: stepMs(opts), quiet: opts.quiet });
	await run(py, ["-m", "pip", "install", ...INSTALL_PACKAGES], { timeoutMs: stepMs(opts), quiet: opts.quiet });
}

/** Create the venv; uv owns most agent venvs and creates them without pip. */
async function createVenv(venvDir, system, prefix, uv, opts = {}) {
	mkdirSync(join(venvDir, ".."), { recursive: true });
	if (uv) {
		// --seed puts pip in the venv: without it an agent mid-session cannot install the one package it needs
		// unless it already knows this venv was built by uv
		await run("uv", ["venv", "--seed", "--python", system, ...prefix, venvDir], { timeoutMs: stepMs(opts), quiet: opts.quiet });
		return;
	}
	// --clear: a half-built venv must not leak into a "working" one
	await run(system, [...prefix, "-m", "venv", "--clear", venvDir], { timeoutMs: stepMs(opts), quiet: opts.quiet });
}

/**
 * The whole job, as a value. Never exits the process and never throws for an expected failure: the caller
 * decides what a failure costs, and the plugin's caller is a live OpenCode server.
 *
 * status: "ready" (already fine) | "repaired" (deps added to an existing venv) | "created" (new venv)
 *       | "skipped" (PYTOOL_SKIP_VENV=1) | "failed" (detail says why)
 */
export async function setupManagedVenv(options = {}) {
	const env = options.env ?? process.env;
	const quiet = options.quiet === true;
	const startedAt = Date.now();
	const deadlineAt = startedAt + (options.timeoutMs ?? STEP_TIMEOUT_MS);
	// one install step's budget: a plugin boot must not sit behind a 15-minute hung uv run, so the caller's
	// timeout also caps each step, and `outOfTime` stops the job between steps. `step` is the pair of knobs
	// every child process inherits: the budget, and whether its noise goes to the console or into `log`.
	const step = {
		stepTimeoutMs: options.stepTimeoutMs > 0 ? Math.min(options.stepTimeoutMs, STEP_TIMEOUT_MS) : STEP_TIMEOUT_MS,
		quiet: options.quiet === true,
	};
	const venvDir = managedVenvDir(env);
	const py = join(venvDir, WIN ? "Scripts" : "bin", WIN ? "python.exe" : "python3");

	const lines = [];
	const log = (m) => {
		lines.push(`[pytool] ${m}`);
		if (!quiet) process.stdout.write(`[pytool] ${m}\n`);
	};
	const warn = (m) => {
		lines.push(`[pytool] warning: ${m}`);
		if (!quiet) process.stderr.write(`[pytool] warning: ${m}\n`);
	};
	const done = (status, extra = {}) => ({
		status,
		venvDir,
		python: py,
		log: lines.join("\n"),
		tookMs: Date.now() - startedAt,
		...extra,
	});
	/** A build that runs past its budget stops between steps rather than owning the session. */
	const outOfTime = () =>
		Date.now() > deadlineAt
			? done("failed", {
					detail: `stopped after ${Math.round((Date.now() - startedAt) / 1000)}s without a usable venv; run 'npm run setup-venv' (or a longer PYTOOL_VENV_TIMEOUT_MS) once the network is back.`,
					timedOut: true,
				})
			: null;

	if (env.PYTOOL_SKIP_VENV === "1") {
		warn("PYTOOL_SKIP_VENV=1: the evaluator venv was not built; pytool fails until one exists.");
		return done("skipped");
	}

	const uv = await hasUv();

	// an existing venv that can host every dep is the common case -- never rebuild it, apart from pip
	const missing = existsSync(py) ? await missingModules(py, CORE_MODULES) : null;
	if (missing && missing.length === 0) {
		await ensurePip(py, uv, warn, log, step);
		log(`venv ready (${INSTALL_PACKAGES.join(", ")}) at ${venvDir}`);
		log(`add packages with: ${addPackagesHint(uv, py)}`);
		return done("ready");
	}

	if (missing && missing.length > 0) {
		log(`repairing evaluator venv at ${venvDir} (missing ${missing.join(", ")})...`);
		try {
			await installDeps(py, uv, step);
		} catch (error) {
			return done("failed", { detail: `could not repair the evaluator venv (${error?.message ?? error}).` });
		}
		const still = await missingModules(py, CORE_MODULES);
		if (still.length > 0)
			return done("failed", { detail: `deps still not importable after install: ${still.join(", ")} - the evaluator won't start.` });
		await reportExtras(py, warn);
		await ensurePip(py, uv, warn, log, step);
		log("done. pytool will use this venv.");
		log(`add packages with: ${addPackagesHint(uv, py)}`);
		return done("repaired");
	}

	const late = outOfTime();
	if (late) return late;

	const system = await systemPythons();
	if (!system) {
		return done("failed", {
			detail:
				`no usable python found on PATH; could not create the evaluator venv at ${venvDir}. ` +
				`Install Python 3.11+ (or set PYTOOL_SKIP_VENV=1 to defer) and re-run 'npm run setup-venv'.`,
		});
	}
	log(
		`building evaluator venv at ${venvDir} (from ${system[0]}${system[1].length ? " " + system[1].join(" ") : ""}${
			uv ? ", via uv" : ""
		})...`,
	);
	try {
		await createVenv(venvDir, system[0], system[1], uv, step);
		if (!existsSync(py)) {
			return done("failed", { detail: `a venv was created but no interpreter sits where the runtime looks for it: ${py}` });
		}
		const late2 = outOfTime();
		if (late2) return late2;
		await installDeps(py, uv, step);
		const still = await missingModules(py, CORE_MODULES);
		if (still.length > 0)
			return done("failed", { detail: `runtime deps still not importable after install: ${still.join(", ")} - the evaluator won't start.` });
		await reportExtras(py, warn);
		await ensurePip(py, uv, warn, log, step);
		log(`done. pytool will use this venv (${INSTALL_PACKAGES.join(", ")}).`);
		log(`add packages with: ${addPackagesHint(uv, py)}`);
		return done("created");
	} catch (error) {
		// a real failure is reported, never swallowed -- but only the CLI may set an exit code
		return done("failed", { detail: `could not build the evaluator venv (${error?.message ?? error}).` });
	}
}

/** CLI entry: print what happened, exit non-zero on a dead install. */
async function main() {
	const r = await setupManagedVenv();
	// machine-readable: the plugin runs this as a child (src/engine/venv-bootstrap.ts) and maps this line
	// back onto its own status, so the venv's health is decided in exactly one place.
	process.stdout.write(`[pytool] status=${r.status}\n`);
	if (r.status === "failed") {
		process.stderr.write(`[pytool] ERROR: ${r.detail}\n`);
		process.exitCode = 1;
	}
}

// --- only a direct run owns the process; an import must not exit or block the host that imported it ---
const invokedDirectly =
	typeof process.argv[1] === "string" && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) void main();
