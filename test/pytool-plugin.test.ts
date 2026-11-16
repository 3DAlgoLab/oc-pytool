// Gate 1b: the OpenCode wiring, with a fake plugin context. No server, no kernel.
//
// This is the gate for the parts that only exist because OpenCode's API is what it is: the tool the plugin
// registers, the system guidance it injects, and how hard it pushes back on Python run through the shell.
// The kernel behaviour behind them is gate 2 (pytool-integration.test.ts).

import { describe, expect, test } from "bun:test";
import plugin from "../src/index.js";

type Hook = (event: any) => Promise<void> | void;

interface Harness {
	tools: any[];
	hooks: Record<string, Hook>;
	toolHooks: Record<string, Hook>;
	cleanup?: () => Promise<void> | void;
}

async function load(env: Record<string, string | undefined> = {}): Promise<Harness> {
	const previous = { ...process.env };
	Object.assign(process.env, env);
	const harness: Harness = { tools: [], hooks: {}, toolHooks: {} };
	try {
		const ctx = {
			location: { directory: process.cwd() },
			session: {
				hook: async (name: string, cb: Hook) => {
					harness.hooks[name] = cb;
					return { dispose: async () => {} };
				},
			},
			tool: {
				transform: async (cb: (editor: any) => void) => {
					const editor = {
						list: () => [],
						get: () => undefined,
						namespace: () => {},
						add: (tool: any) => harness.tools.push(tool),
						update: () => {},
						remove: () => {},
					};
					cb(editor);
					return { dispose: async () => {} };
				},
				hook: async (name: string, cb: Hook) => {
					harness.toolHooks[name] = cb;
					return { dispose: async () => {} };
				},
				list: async () => [],
				reload: async () => {},
			},
		};
		harness.cleanup = (await plugin.setup(ctx as any)) as (() => Promise<void>) | undefined;
		return harness;
	} finally {
		for (const key of Object.keys(env)) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
}

function toolCall() {
	return { sessionID: "ses_test", agent: "build", messageID: "msg_1", id: "call_1", progress: async () => {} };
}

describe("the registered tool", () => {
	test("pytool is added once, as a direct tool with a code argument", async () => {
		const h = await load({ PYTOOL_SHELL_PY: "off" });
		expect(h.tools.map((t) => t.name)).toEqual(["pytool"]);
		const tool = h.tools[0];
		// Code Mode would put a JavaScript layer between the model and the kernel -- the state this tool
		// exists to keep is exactly what that layer discards.
		expect(tool.options).toEqual({ codemode: false });
		expect(tool.input.required).toEqual(["code"]);
		expect(Object.keys(tool.input.properties)).toEqual(["code", "maxOutputChars", "timeoutMs", "status"]);
		expect(tool.description).toContain("stays alive for the whole session");
		expect(tool.description).toContain("COM");
	});

	test("an empty cell answers instead of booting a kernel", async () => {
		const h = await load({ PYTOOL_SHELL_PY: "off" });
		const r = await h.tools[0].execute({ code: "   " }, toolCall());
		expect(r.content).toContain("nothing to run");
		expect(r.metadata).toEqual({ status: "empty" });
	});

	test("status=true reports a kernel that has not booted, without booting one", async () => {
		const h = await load({ PYTOOL_SHELL_PY: "off" });
		const r = await h.tools[0].execute({ code: "", status: true }, toolCall());
		expect(r.content).toContain("kernel: not started");
		expect(r.metadata).toMatchObject({ status: "diagnostics" });
	});

	test("unloading the plugin disposes its kernels and does not throw", async () => {
		const h = await load({ PYTOOL_SHELL_PY: "off" });
		expect(await h.cleanup?.()).toBeUndefined();
	});
});

describe("session guidance", () => {
	test("the rules are pushed into the system parts of every request", async () => {
		const h = await load({ PYTOOL_SHELL_PY: "off" });
		const event: any = { system: [], messages: [], tools: {}, options: {} };
		await h.hooks.context?.(event);
		expect(event.system.length).toBe(1);
		const text: string = event.system[0].text;
		expect(text).toContain("<pytool>");
		expect(text).toContain("The live kernel is the source of truth");
		// the rule the agent breaks most often, stated where it will be read
		expect(text).toContain("Never compute through bash");
		// and the request hook is not the boot path: guidance must not spawn a kernel
		expect(h.hooks.prompt).toBeDefined();
	});
});

describe("python through the shell", () => {
	test("warn mode annotates the shell result, and stops after three notices", async () => {
		const h = await load({ PYTOOL_SHELL_PY: "warn" });
		const hit = { command: "python3 - <<'PY'\nprint(1)\nPY" };
		for (const n of [1, 2, 3]) {
			const event: any = { tool: "bash", status: "completed", input: hit, result: { content: "1" } };
			await h.toolHooks["execute.after"]?.(event);
			expect(event.result.content, `notice ${n}`).toContain("[pytool]");
			// the last one says it is the last, so the nagging is visibly bounded
			expect(event.result.content).toContain(n === 3 ? "last notice" : `notice ${n}/3`);
		}
		const fourth: any = { tool: "bash", status: "completed", input: hit, result: { content: "1" } };
		await h.toolHooks["execute.after"]?.(fourth);
		expect(fourth.result.content).toBe("1");
	});

	test("the notice never rewrites a non-shell or failed call", async () => {
		const h = await load({ PYTOOL_SHELL_PY: "warn" });
		const read: any = { tool: "read", status: "completed", input: { filePath: "x" }, result: { content: "python3 - <<'PY'" } };
		await h.toolHooks["execute.after"]?.(read);
		expect(read.result.content).toBe("python3 - <<'PY'");
		const failed: any = { tool: "bash", status: "error", input: { command: "python -c 'print(1)'" }, error: { message: "boom" } };
		await h.toolHooks["execute.after"]?.(failed);
		expect(failed.result).toBeUndefined();
	});

	test("block mode refuses the call, and a bare interpreter name still routes", async () => {
		const h = await load({ PYTOOL_SHELL_PY: "block" });
		let message = "";
		try {
			await h.toolHooks["execute.before"]?.({ tool: "bash", input: { command: "python -c \"print(1)\"" } });
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).toContain("cold CPython");
		expect(message).toContain("PYTOOL_SHELL_PY=warn");
		// installs stay allowed in strict mode: the fix for a missing package is a shell call
		let blocked = true;
		try {
			await h.toolHooks["execute.before"]?.({ tool: "bash", input: { command: "uv pip install --python x lxml" } });
			blocked = false;
		} catch {
			blocked = true;
		}
		expect(blocked).toBe(false);
	});

	test("off mode registers no shell hooks at all", async () => {
		const h = await load({ PYTOOL_SHELL_PY: "off" });
		expect(h.toolHooks["execute.after"]).toBeUndefined();
		expect(h.toolHooks["execute.before"]).toBeUndefined();
	});
});
