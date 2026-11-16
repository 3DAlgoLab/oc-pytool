import { DEFAULT_MAX_OUTPUT_CHARS } from "../engine/engine.js";

/**
 * Model-facing: what this tool is for, and where its boundary with the shell lies.
 *
 * OpenCode gives the agent a `bash` tool and a JS Code Mode runtime, and both can reach Python -- which is
 * exactly the trap. The description therefore spends its last sentences on the boundary rather than on
 * features, because that is the decision the model gets wrong most often.
 */
export const pytoolToolDescription =
	"Run Python in a kernel that stays alive for the whole session. Names, imports, loaded data, " +
	"open files and live object handles (COM/Office/DraftSight proxies, database connections) carry " +
	"over from one call to the next. Use it as the default path for any Python computation: running python " +
	"through bash costs a cold interpreter and discards every name the next cell would reuse, and Code Mode " +
	"runs JavaScript, not Python. A cell that raises keeps the kernel and its namespace. A cell that ignores " +
	"an interrupt gets its kernel killed, which empties the namespace and is reported as KernelReaped. Output " +
	"per channel is capped, and the cut is marked with what fell off; the built-in default is " +
	`${DEFAULT_MAX_OUTPUT_CHARS} chars, PYTOOL_MAX_OUTPUT_CHARS overrides it per session, and status=true ` +
	"reports the cap in force. " +
	"The kernel runs on one interpreter per machine (a managed venv unless pinned), so a cell that fails on a " +
	"missing import names that interpreter and prints the exact command that installs into it.";

/**
 * The rules the tool description cannot carry: what to do with the kernel once it exists. Injected into the
 * session's system parts (see src/index.ts), where it sits beside the agent's own instructions.
 */
export function pytoolGuidelines(): string[] {
	return [
	"The live kernel is the source of truth: reuse existing names instead of re-importing, reloading or recomputing them.",
	"Look before acting: print the minimal view that answers the question (len, shape, head, a slice). The last expression's value comes back on its own.",
	"A failing import is an install, not a rewrite: the cell names the kernel interpreter and the command that adds the package to it. Run that command and retry the cell -- do not reinstall into a different interpreter, and do not hand-roll a pure-Python substitute for a package that is one command away.",
	"Drive COM, RPC and other blocking APIs as many short calls, never one long batch: an interrupt cannot cut a call parked inside C, and the only way back is killing the kernel and losing every name and handle.",
	"If output starts with <pytool_kernel_reset> or the error is KernelReaped, the namespace is empty and handles are dead: re-create and re-open before using any earlier name.",
	"File, process, git and package-install work belongs to the other tools; the Python itself belongs to pytool.",
	"Never compute through bash: `python3 - <<EOF`, `python -c`, and `echo ... | python3` start a cold interpreter, and every name in it is gone before the next call. Send the code to pytool.",
	];
}
