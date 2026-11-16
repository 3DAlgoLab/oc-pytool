// --- pytool: one session-persistent Python tool, registered alongside OpenCode's own tools.
// ---
// --- The design rule inherited from the reference implementation: this tool never touches the agent's other
// --- tools. It does not hide them, reorder them, or take over the prompt -- it adds one tool and states where
// --- its boundary with `bash` lies. No namespace snapshots and no helper preloading either; see README.
// ---
// --- One KernelManager per session, keyed by Session.ID. OpenCode runs one server for many sessions, so a
// --- single shared kernel would let two sessions overwrite each other's names and fight over one COM
// --- apartment; per-session isolation is what makes the namespace a promise.

import { Plugin } from "@opencode/plugin";
import { DEFAULT_MAX_OUTPUT_CHARS, KernelManager } from "./engine/engine.js";
import { formatDiagnostics } from "./extension/diagnostics.js";
import { composeErrorLines } from "./extension/error-format.js";
import { composeImportHint, missingModuleNames, probeInstaller } from "./extension/import-hint.js";
import { pytoolGuidelines, pytoolToolDescription } from "./extension/prompt.js";
import { toolResultMetadata, type PytoolDetails } from "./extension/tool-result.js";
import {
	composeShellPythonBlock,
	composeShellPythonNotice,
	detectShellPython,
	shellPythonMode,
	type ShellPythonMode,
} from "./extension/shell-python.js";

/** Progress is a UI affordance, not a stream: one update per cell, then at most one per this interval. */
const PROGRESS_INTERVAL_MS = 750;
/** How much of the cell's output a progress update carries: enough to name the stage, not the whole log. */
const PROGRESS_TAIL_CHARS = 4000;

/** OpenCode's shell tool is `bash`; the guard matches either spelling so a renamed tool still gets it. */
const SHELL_TOOLS = new Set(["bash", "shell"]);

const pytoolInput = {
	type: "object",
	properties: {
		code: {
			type: "string",
			description:
				"Python source for this cell; stdout, stderr and the last-expression result come back. Pass an empty string with status=true to ask about the kernel instead of running code.",
		},
		maxOutputChars: {
			type: "integer",
			minimum: 512,
			description:
				"Optional cap on characters returned per channel. Set it lower when the caller has its own output budget shared across nested results; the session default is 46080 and can be changed with PYTOOL_MAX_OUTPUT_CHARS.",
		},
		timeoutMs: {
			type: "integer",
			minimum: 0,
			description:
				"Optional wall-clock cap for this cell, in milliseconds. Set it below the deadline the caller is already under: pytool then cuts the cell itself (interrupt first, a kernel kill only if the cell will not yield), returns what it printed up to the cut, and states whether the names and live handles survived. With no cap, a cell that outruns the caller deadline is abandoned mid-cell and its kernel gets reaped behind the scenes.",
		},
		status: {
			type: "boolean",
			description:
				"Set true to return kernel diagnostics instead of running code: interpreter, process ids, output cap and the names currently in the namespace.",
		},
	},
	required: ["code"],
	additionalProperties: false,
};

export default Plugin.define({
	id: "pytool",
	async setup(ctx) {
		const cwd = ctx.location.directory || process.cwd();
		// --- how hard pytool pushes back when Python is routed through the shell instead of the kernel
		const shellPy: ShellPythonMode = shellPythonMode();
		let nudgesUsed = 0;
		const NUDGE_MAX = 3;

		const kernels = new Map<string, KernelManager>();
		const acquiring = new Map<string, Promise<KernelManager>>();

		/** One kernel per session; a boot that fails leaves no half-built manager behind. */
		async function ensureKernel(sessionID: string): Promise<KernelManager> {
			const live = kernels.get(sessionID);
			if (live) return live;
			const pending = acquiring.get(sessionID);
			if (pending) return pending;
			const build = (async () => {
				const next = new KernelManager({ cwd });
				await next.start();
				kernels.set(sessionID, next);
				return next;
			})();
			// --- a rejection nobody awaits must not surface as an unhandled rejection
			build.catch(() => {});
			acquiring.set(sessionID, build);
			try {
				return await build;
			} finally {
				if (acquiring.get(sessionID) === build) acquiring.delete(sessionID);
			}
		}

		/** Drop a kernel that can no longer serve cells (a failed boot, a dead bridge). */
		async function discardKernel(sessionID: string): Promise<void> {
			const dying = kernels.get(sessionID);
			kernels.delete(sessionID);
			acquiring.delete(sessionID);
			if (dying) await dying.kill();
		}

		// --- the boot is the slow part of the first cell (~1 s to import ipykernel and bind ZMQ), and nothing
		// --- about it depends on what the user asked for, so start it as soon as a prompt is admitted. A
		// --- session that never calls pytool keeps an idle kernel until the plugin unloads.
		await ctx.session.hook("prompt", (event) => {
			void ensureKernel(String(event.sessionID)).catch(() => {
				// --- the first cell reports the boot failure itself; a warm-up rejection is nobody's business
			});
		});

		// --- the rules the tool description cannot carry, in the system parts where the agent's own
		// --- instructions live. Pushed per request rather than stored: the hook is the single source, so a
		// --- plugin reload changes the guidance without any per-session bookkeeping to invalidate.
		const guidance = `<pytool>\n${pytoolGuidelines().join("\n")}\n</pytool>`;
		await ctx.session.hook("context", (event) => {
			event.system.push({ type: "text", text: guidance });
		});

		// --- The prompt states the rule once; this restates it at the exact moment it would otherwise be
		// --- broken silently. A bash call that feeds Python a heredoc, stdin or an inline -c pays a cold
		// --- interpreter and keeps nothing, which is the one thing pytool exists to prevent. `warn` (default)
		// --- annotates the result and stops nagging after NUDGE_MAX calls; `block` refuses the call outright.
		if (shellPy === "block") {
			await ctx.tool.hook("execute.before", (event) => {
				if (!SHELL_TOOLS.has(event.tool)) return;
				const hit = detectShellPython((event.input as { command?: string } | undefined)?.command);
				if (!hit) return;
				throw new Error(composeShellPythonBlock(hit));
			});
		}

		if (shellPy !== "off") {
			await ctx.tool.hook("execute.after", (event) => {
				// --- a hook that throws would take the shell tool down with it, and a notice is never worth
				// --- that: every path here is wrapped so the worst case is a missing notice.
				try {
					if (event.status !== "completed" || !SHELL_TOOLS.has(event.tool)) return;
					if (nudgesUsed >= NUDGE_MAX) return;
					const hit = detectShellPython((event.input as { command?: string } | undefined)?.command);
					if (!hit) return;
					nudgesUsed += 1;
					const notice = composeShellPythonNotice(hit, nudgesUsed, NUDGE_MAX);
					const previous = event.result.content;
					event.result = {
						...event.result,
						content: typeof previous === "string" ? `${previous}\n\n${notice}` : notice,
					};
				} catch {
					// --- annotation only; never break the call it annotates
				}
			});
		}

		await ctx.tool.transform((editor) => {
			editor.add({
				name: "pytool",
				description: pytoolToolDescription,
				// --- Code Mode is JavaScript: routing this tool through it would put a JS layer between the
				// --- model and Python and cost exactly the state the tool exists to keep.
				options: { codemode: false },
				input: pytoolInput,
				execute: async (raw, tool) => {
					const input = raw as { code?: string; maxOutputChars?: number; timeoutMs?: number; status?: boolean };
					const sessionID = String(tool.sessionID);

					if (input.status) {
						const kernel = kernels.get(sessionID);
						const names = (await kernel?.listNamespaceNames()) ?? [];
						return {
							content: formatDiagnostics({
								enginePresent: kernel !== undefined,
								kernelState: kernel?.bootState,
								pid: kernel?.pid,
								bridgePid: kernel?.bridgePid,
								kernelPid: kernel?.kernelPid,
								interpreter: kernel?.pythonInterpreter,
								interpreterSource: kernel?.pythonSource,
								maxOutputChars: kernel?.outputCharBudget ?? DEFAULT_MAX_OUTPUT_CHARS,
								namespaceNames: names,
								kernelGenerations: kernel?.generations,
								kernelDeathReason: kernel?.kernelDeathReason,
							}),
							// --- kernelPid is undefined before the first cell boots a kernel; see tool-result.ts
							metadata: toolResultMetadata({ status: "diagnostics", kernelPid: kernel?.kernelPid }),
						};
					}

					const code = input.code ?? "";
					if (!code.trim()) {
						return {
							content: "[pytool] nothing to run: pass Python in `code`, or status=true for kernel diagnostics.",
							metadata: { status: "empty" },
						};
					}

					const kernel = await ensureKernel(sessionID);
					let streamed = "";
					let lastProgress = 0;
					try {
						const r = await kernel.execute(code, {
							// --- reading tool.signal opts this call into OpenCode's cooperative stop: the user's
							// --- stop aborts the cell, and whatever we then return is still the call's result.
							signal: tool.signal,
							maxOutputChars: input.maxOutputChars,
							timeoutMs: input.timeoutMs,
							onStream: (chunk) => {
								streamed += chunk;
								// --- a minute-long COM batch is otherwise a silent wait, and the one line it
								// --- printed before hanging is the thing that names the call. Mirrored at most
								// --- once per interval; a UI update that fails must never cut the cell.
								const now = Date.now();
								if (now - lastProgress < PROGRESS_INTERVAL_MS) return;
								lastProgress = now;
								void tool.progress({ output: streamed.slice(-PROGRESS_TAIL_CHARS) }).catch(() => {});
							},
						});
						const sections = [r.kernelReset, r.cellTimeout, r.stdout, r.stderr, r.result];
						const errorLines = r.error ? composeErrorLines(r.error) : undefined;
						if (errorLines) sections.push(errorLines.join("\n"));
						// --- a missing package is an install, not a rewrite. Without this the model spends its next
						// --- three calls rediscovering which interpreter runs the kernel, whether that interpreter
						// --- has pip, and what the pip name of the import is -- all three already known here.
						const missing = r.error ? missingModuleNames(r.error) : [];
						const interpreter = kernel.pythonInterpreter;
						const installHint =
							missing.length > 0 && interpreter
								? composeImportHint(missing, interpreter, probeInstaller(interpreter, missing))
								: undefined;
						if (installHint) sections.push(installHint.join("\n"));
						if (r.status === "aborted" && !errorLines) sections.push("[cell aborted]");
						const text = sections.filter((s) => s !== undefined && s !== "").join("\n");
						const details: PytoolDetails = {
							status: r.status,
							durationMs: r.durationMs,
							errorName: r.error?.name,
							stdout: r.stdout || undefined,
							stderr: r.stderr || undefined,
							result: r.result,
							errorStack: errorLines,
							installHint: installHint?.join("\n"),
							kernelReset: r.kernelReset !== undefined,
							timedOut: r.timedOut === true,
							kernelPid: kernel.kernelPid,
						};
						return { content: text || "(no output)", metadata: toolResultMetadata(details) };
					} catch (error) {
						// --- a manager whose kernel died mid-cell and whose re-boot failed is not reusable; drop it
						// --- so the next cell builds a new one instead of queueing behind a corpse
						if (!kernel.isRunning) await discardKernel(sessionID);
						throw error;
					}
				},
			});
		});

		// --- teardown: a leaked ipykernel keeps its COM apartment and the document it has open, which on
		// --- Windows is the worst failure here. Bounded inside KernelClient.shutdown, then the tree kill.
		return async () => {
			const dying = [...kernels.values()];
			kernels.clear();
			acquiring.clear();
			for (const kernel of dying) await kernel.dispose();
		};
	},
});
