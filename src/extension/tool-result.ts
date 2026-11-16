// --- The one place pytool writes arbitrary values into OpenCode's session store, and it has a sharp edge:
// --- a tool result whose `metadata` carries a key with an explicitly `undefined` value never lands. The call
// --- runs, the tool's `execute.after` hook sees a completed result, and the session part still stays
// --- `status: "running"` -- the model is handed the literal text "Tool result missing" and the cell's output,
// --- which did arrive, is gone. Measured 2026-11-16 by bisecting a working call (`status: true`, every
// --- metadata value defined) against the identical cell call that failed: the only difference was five
// --- `undefined`-valued keys. So metadata is built here, and it never carries one.

/** What a cell call reports alongside its text: the shape the UI and a later call can read. */
export type PytoolDetails = {
	status?: "ok" | "error" | "aborted" | "timeout";
	durationMs?: number;
	/** The cell ran past its own `timeoutMs`; the cut is reported, not swallowed. */
	timedOut?: boolean;
	errorName?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	errorStack?: string[];
	/** The install command for a package the kernel interpreter lacks, when an import failed for that reason. */
	installHint?: string;
	/** True when this cell was the first on a rebuilt kernel (namespace empty). */
	kernelReset?: boolean;
	kernelPid?: number;
};

/**
 * Plain JSON, no undefined values: what OpenCode's tool-result metadata can actually store. A `type` rather
 * than an `interface` above, so a caller's typed object is assignable to this record without an assertion.
 */
export function toolResultMetadata(details: Record<string, unknown>): Record<string, unknown> {
	const metadata: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(details)) {
		if (value !== undefined) metadata[key] = value;
	}
	return metadata;
}
