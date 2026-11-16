// --- The wire contract with bridge.py, in one place.
// --- bridge.py is the only kernel driver pytool speaks to; both sides are in this repository, so a change
// --- here is the change list for both. Anything the host must understand about a line the bridge can print
// --- belongs in this file -- routing, not policy.

export type CellStatus = "ok" | "error" | "aborted";

export interface CellError {
	name: string;
	message: string;
	stack: string[];
}

/** host -> bridge */
export type BridgeRequest =
	| { op: "boot" }
	| { op: "exec"; id: string; code: string }
	| { op: "listNames"; id: string }
	| { op: "interrupt" }
	| { op: "shutdown"; id: string };

/** bridge -> host */
export type BridgeEvent =
	| { type: "ready"; pid: number; kernel_pid?: number }
	| { type: "stream"; id: string; name: "stdout" | "stderr"; text: string }
	| { type: "result"; id: string; status: CellStatus; result?: string; error?: CellError }
	| { type: "reply"; id: string; names?: string[] }
	| { type: "error"; id?: string; message: string }
	/** The bridge is about to exit because the kernel went away (heartbeat lost, died mid-cell). */
	| { type: "dying"; message?: string };

/** Loose shape for the routing switch; the typed variants above are what callers get back. */
export interface BridgeMessage {
	type?: string;
	id?: string;
	[key: string]: unknown;
}
