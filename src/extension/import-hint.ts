// --- A missing package is an install, not a rewrite.
// ---
// --- The failure this exists for: a cell raises ModuleNotFoundError, the model sees a bare traceback with no
// --- path in it, and then spends its next calls rediscovering which interpreter runs the kernel, whether that
// --- interpreter has pip, and what the pip name of the import is. Each of those is a round trip whose answer
// --- the extension already holds. So the failing cell itself names the interpreter and prints the one command
// --- that would have worked the first time.
// ---
// --- Nothing here is guessed at: the interpreter comes from the engine's own resolution, and the installer is
// --- chosen by probing that interpreter for the pip module and the machine for uv -- the same two probes
// --- scripts/setup-venv.mjs already makes.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Import name != pip name for the packages that actually get imported. Without this the hint tells the model
 * to install a package that does not exist (pip has no "PIL"), which is the one wrong command that turns a
 * one-line fix into a second failure. The COM family matters most here: this tool's reason for existing on
 * Windows is pywin32.
 */
export const PIP_NAME_FOR_MODULE: Record<string, string> = {
	PIL: "pillow",
	win32com: "pywin32",
	win32api: "pywin32",
	win32gui: "pywin32",
	win32con: "pywin32",
	pythoncom: "pywin32",
	pywintypes: "pywin32",
	win32print: "pywin32",
	sklearn: "scikit-learn",
	yaml: "pyyaml",
	fitz: "pymupdf",
	cv2: "opencv-python",
	bs4: "beautifulsoup4",
	dateutil: "python-dateutil",
	serial: "pyserial",
	OpenGL: "PyOpenGL",
	docx: "python-docx",
	defusedxml: "defusedxml",
};

/**
 * Packages that are not on PyPI at all: they live as OpenCode skill packages in this machine's global
 * skills directory, and the command that works installs them `--editable` from there. Naming a bare pip
 * name for one of these is the one hint that can never succeed -- pip has no `draftsight`. The directory
 * rule is duplicated from scripts/setup-venv.mjs on purpose (same reason as python-locate.ts: the builder
 * must stay runnable by a bare `node`), and PYTOOL_DRAFTSIGHT_SKILL overrides it there and here.
 */
export function localPackageSource(moduleName: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
	if (moduleName !== "draftsight") return undefined;
	const dir =
		env.PYTOOL_DRAFTSIGHT_SKILL || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "skills", "draftsight-py");
	return existsSync(dir) ? dir : undefined;
}

/** Only these raise for a package that is simply not installed. */
const IMPORT_ERROR_NAMES = new Set(["ModuleNotFoundError", "ImportError"]);

const MODULE_RE = /No module named ['"]([^'"]+)['"]/g;

/** The pip-installable name for a module, resolving the alias table above. */
export function pipName(moduleName: string): string {
	return PIP_NAME_FOR_MODULE[moduleName] ?? moduleName;
}

/**
 * Which packages the error says are missing. Empty when the error is not an import failure, when it is a
 * relative-import mistake, or when the module exists and only a name inside it is missing.
 */
export function missingModuleNames(error: { name?: string; message?: string; stack?: string[] } | undefined): string[] {
	if (!error) return [];
	if (error.name && !IMPORT_ERROR_NAMES.has(error.name)) return [];
	if (/attempted relative import/i.test(error.message ?? "")) return [];

	const haystack = [error.message ?? "", ...(error.stack ?? [])].join("\n");
	const found: string[] = [];
	for (const match of haystack.matchAll(MODULE_RE)) {
		// scipy.optimize is missing because scipy is; and PIL, not PIL.Image, is the thing to install
		const top = match[1].split(".")[0];
		if (top && !found.includes(top)) found.push(top);
	}
	return found;
}

export interface InstallerProbe {
	/** uv resolvable on PATH. */
	uv?: boolean;
	/** The kernel interpreter can import pip. uv-built venvs usually cannot. */
	pip?: boolean;
}

export interface InstallerChoice {
	program: "uv" | "pip";
	/** The exact command, quoting already applied. */
	command: string;
	/** Why the other installer was not offered, when that is worth saying. */
	note?: string;
}

function quote(path: string): string {
	return `"${path}"`;
}

/**
 * The command that installs into the interpreter that runs the cells.
 *
 * The interpreter path is always named and always quoted: installing into "the python on PATH" is the mistake
 * this tool exists to prevent, because the package then sits in an interpreter the kernel never runs and the
 * next cell fails the same way with a longer traceback.
 */
export function installerCommand(
	interpreter: string,
	modules: string[],
	probe: InstallerProbe = {},
	localDirs?: Record<string, string | undefined>,
): InstallerChoice {
	return installerChoice(interpreter, modules, probe, localDirs);
}

/**
 * The same decision with the probe supplied explicitly, so the hint can be tested without spawning anything.
 * `localDirs` overrides the filesystem lookup per module, for the same reason the probe is injected.
 */
export function installerChoice(
	interpreter: string,
	modules: string[],
	probe: InstallerProbe,
	localDirs: Record<string, string | undefined> = {},
): InstallerChoice {
	// a local skill package contributes `--editable "<dir>"` where a PyPI package contributes its name;
	// the argument order works for both uv and pip
	const args: string[] = [];
	const local: string[] = [];
	for (const m of modules) {
		const src = localDirs[m] ?? localPackageSource(m);
		if (src !== undefined) {
			if (!local.includes(m)) local.push(m);
			const flag = `--editable ${quote(src)}`;
			if (!args.includes(flag)) args.push(flag);
		} else {
			args.push(pipName(m));
		}
	}
	const packages = args.join(" ");
	const localNote =
		local.length > 0 ? `${local.join(", ")} is a local skill package, not a PyPI name - installed editable from its skill directory` : undefined;
	if (probe.uv) {
		const notes = [probe.pip ? undefined : 'this venv has no pip module, so "python -m pip install" cannot work here', localNote].filter(Boolean);
		return { program: "uv", command: `uv pip install --python ${quote(interpreter)} ${packages}`, note: notes.join("; ") || undefined };
	}
	return { program: "pip", command: `${quote(interpreter)} -m pip install ${packages}`, note: localNote };
}

/**
 * Lines appended after a failing import: what is missing, where the kernel runs, the command that fixes it,
 * and the alias when the pip name differs from the import name.
 */
export function composeImportHint(modules: string[], interpreter: string | undefined, choice?: InstallerChoice): string[] {
	if (modules.length === 0 || !interpreter) return [];
	const install = choice ?? installerCommand(interpreter, modules, {});
	const lines = [
		`[hint] not installed in the kernel interpreter: ${modules.join(", ")}`,
		`       interpreter: ${interpreter}`,
		`       install it:  ${install.command}`,
	];
	const aliases = modules.filter((m) => pipName(m) !== m).map((m) => `${m} -> ${pipName(m)}`);
	if (aliases.length > 0) lines.push(`       pip name differs from the import name: ${aliases.join(", ")}`);
	if (install.note) lines.push(`       note: ${install.note}`);
	// Measured, not inferred: an editable install registers through a .pth read at interpreter startup, so a
	// kernel that was already running when the install landed still raises ModuleNotFoundError on the next
	// cell -- the exact dead end this line used to send the model into. An ordinary site-packages install
	// IS picked up by a live interpreter, so only the editable form changes the advice.
	if (install.command.includes("--editable")) {
		lines.push("       an editable install lands in a .pth read at interpreter startup: the next kernel boot sees it;");
		lines.push("       this running kernel needs the source tree on sys.path (insert it) to use it now.");
	} else {
		lines.push("       run it through the shell tool, then re-run the cell: the kernel picks the package up without a restart.");
	}
	return lines;
}

// --- probes: process-cached, and only ever paid after an import failure that already cost a cell ---

let uvProbe: boolean | undefined;
const pipProbe = new Map<string, boolean>();

export function detectUv(timeoutMs = 5_000): boolean {
	if (uvProbe !== undefined) return uvProbe;
	try {
		const r = spawnSync("uv", ["--version"], { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
		uvProbe = !r.error && r.status === 0;
	} catch {
		uvProbe = false;
	}
	return uvProbe;
}

/** find_spec, never an import: probing pip must not execute package code or warm it into the probe. */
export function interpreterHasPip(interpreter: string, timeoutMs = 10_000): boolean {
	const hit = pipProbe.get(interpreter);
	if (hit !== undefined) return hit;
	let ok = false;
	try {
		const r = spawnSync(interpreter, ["-c", "import importlib.util as u; raise SystemExit(0 if u.find_spec('pip') else 1)"], {
			encoding: "utf8",
			timeout: timeoutMs,
			windowsHide: true,
		});
		ok = !r.error && r.status === 0;
	} catch {
		ok = false;
	}
	pipProbe.set(interpreter, ok);
	return ok;
}

/**
 * Probe the machine and the interpreter, then pick the installer.
 *
 * The packages are part of this call on purpose: an installer decision built without them yields a command
 * that installs nothing, which is a worse outcome than no command at all.
 */
export function probeInstaller(interpreter: string, modules: string[] = []): InstallerChoice & { probe: InstallerProbe } {
	const probe: InstallerProbe = { uv: detectUv(), pip: interpreterHasPip(interpreter) };
	return { ...installerChoice(interpreter, modules, probe), probe };
}
