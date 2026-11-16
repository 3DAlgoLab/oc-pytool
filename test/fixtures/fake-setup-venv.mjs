/**
 * Stand-in for scripts/setup-venv.mjs in test/venv-bootstrap.test.ts.
 *
 * It keeps the one part of that module's contract the bootstrap depends on -- an exported
 * `setupManagedVenv(env, ...)` that resolves to `{ status, detail, log }` -- and leaves an audit trail
 * (`<venv parent>/bootstrap-marks`, one line per run) so a test can prove *how many times* a build was
 * attempted. Nothing here touches a real interpreter environment.
 *
 * Behaviour comes from PYTOOL_BOOTSTRAP_MODE:
 *   create  build it: create the interpreter path the resolver looks for, report `created`
 *   slow    like `create`, but slowly, so another process can be seen waiting for the lock
 *   ready   report `ready` without building anything (the venv was already healthy)
 *   fail    report a dead install
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const win = process.platform === "win32";

export async function setupManagedVenv(options = {}) {
	const env = options.env ?? process.env;
	const venv = env.PYTOOL_VENV ?? "";
	const mode = env.PYTOOL_BOOTSTRAP_MODE || "create";
	const interpreter = join(venv, win ? "Scripts" : "bin", win ? "python.exe" : "python3");
	const started = Date.now();
	if (!venv) return { status: "failed", detail: "PYTOOL_VENV is not set", python: "", venvDir: venv, log: "", tookMs: 0 };

	appendFileSync(join(dirname(venv), "bootstrap-marks"), `${mode}|${process.pid}|${started}\n`);
	const base = { python: interpreter, venvDir: venv, tookMs: Date.now() - started };

	if (mode === "fail")
		return {
			...base,
			status: "failed",
			detail: "no usable python found on PATH; could not create the evaluator venv.",
			log: `[pytool] building evaluator venv at ${venv}...`,
		};
	if (mode === "ready") return { ...base, status: "ready", log: `[pytool] venv ready at ${venv}` };

	if (mode === "slow") await new Promise((r) => setTimeout(r, 700));
	mkdirSync(dirname(interpreter), { recursive: true });
	// a marker, not an interpreter: the bootstrap only ever asks whether the path exists
	writeFileSync(interpreter, "#!/bin/sh\nexit 0\n");
	return { ...base, status: "created", log: `[pytool] building evaluator venv at ${venv}...\n[pytool] done.` };
}
