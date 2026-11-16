# oc-pytool

An [OpenCode](https://opencode.ai) plugin that adds one tool, `pytool`: a **session-persistent Python kernel**
the agent can call like any other tool. Variables, imports, loaded data, open files and live object handles
stay alive for the whole session. Only output comes back to the conversation.

```
✓ pytool · app = win32com.client.Dispatch("DraftSight.Application")
✓ pytool · sheet = app.ActiveSheet()
✓ pytool · sheet.Line(0, 0, 40, 0)          · <Line object …>
```

`app` is still a live COM proxy in the third call. Nothing was re-connected and nothing re-dispatched.

Two purposes, in order:

1. **Persistent connections** — COM/Office/DraftSight, DB sessions, anything with a handle.
2. **Data exploration** — a namespace that accumulates instead of a script that reloads.

## Why this exists in OpenCode specifically

OpenCode already reaches Python two ways, and both are traps:

- **Code Mode** runs *JavaScript*. There is no Python interpreter behind it to hold state.
- **`bash`** can run Python, but every call pays a cold interpreter and keeps nothing: `python3 - <<'PY'`
  re-imports pandas, re-reads the CSV and drops both before the next call.

`pytool` registers beside those tools as one more of them. It is declared `codemode: false`, so no JavaScript
layer is inserted between the model and the kernel — the state this tool exists to keep is exactly what such a
layer would discard.

This is the OpenCode port of [pi-pytool](https://github.com/3DAlgoLab/pi-pytool). What carried over is the
load-bearing part: the stdio bridge protocol, the interpreter ladder, the output caps, the
interrupt/abort/reap semantics, and the Windows process-tree kill. What changed is the host surface:

| pi-pytool | oc-pytool | why |
| --- | --- | --- |
| `session_start` hook warms the kernel | `session.hook("prompt")` | OpenCode has no session-start hook; a prompt is the earliest point where warming cannot race the first cell |
| `resources_guidelines` | `session.hook("context")` pushes a system part | OpenCode injects per request, so a plugin reload changes the guidance with no per-session bookkeeping to invalidate |
| tool-call `options.message` inspected for shell Python | `tool.hook("execute.before"/"execute.after")` | OpenCode gives a real interception point, so `PYTOOL_SHELL_PY=block` can *refuse* the call instead of only annotating it |
| `ctx.chat` compaction guard | dropped | OpenCode has no in-tool chat call, and the cap is pinned under the harness's own output limit instead (`DEFAULT_MAX_OUTPUT_CHARS = 46080`) |
| `/pytool` slash command | `pytool({ status: true })` | OpenCode slash commands are prompts; a diagnostics prompt would spend a model turn to ask for text this tool already has |
| tool registration through `pi.registerTool` | `tool.transform` → `editor.add` | the V2 registration API; `input` is a JSON Schema |

## Install

Point OpenCode at the plugin directory — global (`~/.config/opencode/opencode.jsonc`) makes it available in
every project, which is what a session kernel wants:

```jsonc
{
  "plugins": ["file:///D:/dev-oc/oc-pytool"],
}
```

On Windows the `file:///` URL form is the one measured to load; a bare absolute path is what the docs show and
what works on POSIX hosts.

A local plugin directory needs `package.json` `name` + `exports`, which this package has; OpenCode loads the
server part from `exports["."]`. Restart the server (`opencode service restart`) after the first install.

The kernel needs a Python with `ipykernel` + `jupyter_client`. `npm install` builds it in `postinstall`, or run
it directly:

```bash
npm run setup-venv           # node scripts/setup-venv.mjs
```

It builds at `$XDG_DATA_HOME/opencode/pytool/venv`, else `~/.local/share/opencode/pytool/venv` — one venv per
machine, not one per project, because the kernel is one interpreter for the whole agent. `uv` when present,
`pip` otherwise, seeded with `pip`, and `pywin32` on Windows (which is what puts `win32com` in reach).
If `python3` or the network is missing it says so plainly instead of half-building. `PYTOOL_VENV` moves it;
`PYTOOL_SKIP_VENV=1` defers the build.

## Use

Send Python to `pytool`. Nothing to switch on: the kernel warms as soon as a prompt is admitted, so the first
cell waits on a boot that already started.

- `pytool({ code, maxOutputChars?, timeoutMs?, status? })` — stdout, stderr and the last-expression value come
  back. The kernel is one per OpenCode session, so two sessions never share a namespace.
- A cell that raises reports the traceback and the kernel keeps everything it had.
- `pytool({ status: true })` is read-only diagnostics: interpreter and which rule picked it, the process roles
  with their pids, the live names in the namespace, the output cap, how many kernels this session has consumed.
- A cell that fails on a missing package names the interpreter that runs the kernel and prints the command that
  installs into it — `uv pip install --python "<that interpreter>" <pkg>` when uv owns the machine, that
  interpreter's own pip otherwise — plus the pip name when it differs from the import name (`PIL` → `pillow`,
  `yaml` → `pyyaml`, `win32com` → `pywin32`). The same text is in `metadata.installHint`.

| Variable | Effect |
| --- | --- |
| `PYTOOL_PYTHON` | pin the interpreter, trusted without probing; the kernel exports the winner as `PYTOOL_PYTHON` for sibling skills |
| `PYTOOL_VENV` | where the managed venv lives (build script and resolver read the same variable) |
| `PYTOOL_TIMEOUT_MS` | silence watchdog: interrupt a cell after this long with no output; `0` (off) by default |
| `PYTOOL_ABORT_GRACE_MS` | how long an aborted cell gets before the kernel is reaped (`5000`) |
| `PYTOOL_MAX_OUTPUT_CHARS` | per-cell output cap, `46080`; `4096` per line, cuts marked. One call can override it with `maxOutputChars` |
| `PYTOOL_CELL_TIMEOUT_MS` | wall clock each cell gets when the caller named none; `0` (off) by default. One call overrides it with `timeoutMs` |
| `PYTOOL_BOOT_TIMEOUT_MS` | deadline for a kernel that boots but never answers (`90000`) |
| `PYTOOL_SHELL_PY` | how hard pytool pushes back when Python is routed through `bash`: `warn` (default) appends one notice to the offending result, at most 3 per session; `block` refuses such a call outright; `off` says nothing |

## Interrupts, measured

Aborting a cell — the user's stop, which OpenCode delivers as `context.signal`, or a cell that names its own
`timeoutMs` — sends an interrupt. An interrupt takes effect at the next Python bytecode boundary and cannot
enter a blocking call. Measured on Windows 11, Python 3.14.4, jupyter_client 8.10.0, ipykernel 7.4.0: the
Win32 interrupt event handle is present, so this is the primary path and not the fallback. A loop of
`time.sleep(0.05)` dies about 0.5 s after the signal with its names intact; one `time.sleep(3)` finishes its
3 s first. A cell parked inside a single C call — a hung COM/RPC, a socket read — never regains a boundary, so
after `PYTOOL_ABORT_GRACE_MS` the kernel is killed and the result says `KernelReaped`: every live handle it held
died with it, and the next cell boots an empty kernel. The engine survives its kernel.

A cell can also be handed a wall clock of its own: `timeoutMs` per call, `PYTOOL_CELL_TIMEOUT_MS` for the
session. That is for a caller living under somebody else's deadline — a nested harness whose own budget is about
to fire, which would otherwise abandon the cell mid-flight and reap the kernel behind its back. Naming a number
under that deadline moves the cut inside pytool: interrupt first, a kernel kill only if the cell will not yield,
and a result carrying `status: "timeout"`, `timedOut`, and a `<pytool_cell_timeout>` notice that says in one
line whether the names and the live handles survived. Either way, the output the cell had reached before the cut
comes back. Losing it was a measured cost, not a hypothetical: on 2026-10-31 a DraftSight COM batch that hung had
printed seven progress lines naming the exact stage it hung at, and the abandoned call returned an empty result.

The rule that follows from that, and the one guideline this tool adds to the prompt: **write COM work as many
short calls.** Forty COM calls are interruptible between each; one `Rebuild()` is not interruptible at all.

## A live COM handle, measured

No DraftSight on this host, so the smoke test ran against Excel 16.0 through the installed `pywin32`. Three
separate `pytool` calls: the first did `DispatchEx("Excel.Application")`, added a workbook and wrote `A1`; the
second read `A1` back as `oc-pytool` and wrote and read `A2`; the third deleted the names, collected and reported
the process. The proxies for the application, the workbook and the worksheet were the same live objects across
all three — nothing re-dispatched, and the second call had no way to reach them except the namespace. A wrong
formula came back as the real `com_error`, message included, which is what makes COM work debuggable cell by
cell.

One caveat that only shows up when the interpreter is persistent: **the COM server's lifetime is the kernel's, not
the cell's.** `xl.Quit()` followed by `del` of every proxy and `gc.collect()` still left `EXCEL.EXE` running —
pywin32's dynamic dispatch keeps the sub-object proxies it created, and Excel holds the process until the last
one is released, which in practice is when the kernel exits. So a session that dispatches a server should also
quit it, and a kernel that is reaped mid-COM-work can leave that server behind. The tool cannot fix that from
outside: a COM proxy is not closable by a harness that never held it.

## Encoding, measured

The protocol pipe is UTF-8, pinned by `use_utf8_stdio` in `bridge.py`. Before that, text-mode stdin used the OS
locale codec — cp949 on a Korean Windows box — and redecoded every non-ASCII byte of cell source on the way in:
`print("재질 20° Ø8")` reached the kernel as `U+FFFD` plus Hangul assembled from the UTF-8 bytes of `°` and `Ø`.
Output was never affected, because `json.dumps` escapes to ASCII, which is why this reads like a font problem
and was in fact a transport one. A cell can now carry Hangul, CJK, a degree sign or a diameter sign straight
into generated CAD text.

## Tool results, measured

A tool result whose `metadata` carries a key with an explicitly `undefined` value is dropped by OpenCode 2.3.0,
and dropped quietly: the cell runs, the bridge settles it, the tool's own `execute.after` hook reports a completed
result, and the session part still never leaves `status: "running"`. What the model is then handed is the literal
text `Tool result missing`. Measured 2026-11-16 by bisecting a call that worked (`status: true`, every metadata
value defined) against the identical cell call that did not, the only difference being five `undefined`-valued
keys in the cell's details. So every pytool result builds its metadata through `toolResultMetadata`, which drops
those keys, and a unit test keeps it that way. Falsy-but-defined values (`stdout: ""`, `durationMs: 0`) are kept:
they are facts, not absences.

## Layout

```
bridge.py               the Python side: jupyter_client + ipykernel, one JSON line per op
src/index.ts            plugin wiring: one kernel per session, hooks, the tool, teardown
src/engine/
  python-locate.ts      pin > managed venv > PATH, each non-pin probed for ipykernel/jupyter_client
  protocol.ts           the bridge's message shapes, both sides
  kernel.ts             spawn the bridge, route events by id, cap output, kill the process tree
  engine.ts             boot, cell queue, cell budget, abort grace, reset notice, teardown
src/extension/
  prompt.ts             the tool's description and the guidelines injected into the system parts
  shell-python.ts       detecting Python routed through the shell, and what to say about it
  import-hint.ts        a failed import: which interpreter, which installer, which pip name
  error-format.ts       tracebacks, with the frames that are pytool's own plumbing removed
  diagnostics.ts        the status=true report
  tool-result.ts        the result's metadata, and why it never carries an undefined value
test/
  pytool-units.test.ts     gate 1a — no server, no kernel: routing, caps, ladder, budgets, model-facing text
  pytool-plugin.test.ts    gate 1b — a real plugin against a fake context: registration, guidance, pushback
  pytool-integration.test.ts gate 2 — a real ipykernel: persistence, abort, reap, caps, encoding
scripts/setup-venv.mjs     the managed venv, uv-aware, platform-aware
```

Three processes matter, and more on Windows: a venv `python.exe` is a launcher stub that re-execs, so a live
session there is a chain of launcher → bridge → ipykernel-launcher → the interpreter that holds the COM proxies.
Killing the bridge alone orphans that last one, holding your document open with nobody left to release it, so
teardown is always a tree kill (`taskkill /PID <root> /T /F`, `kill(-pid)` on POSIX). The plugin's unload
function is that teardown, and it is bounded: shutdown is asked for first, then the tree is killed.

## Tests

```bash
bun test test/pytool-units.test.ts test/pytool-plugin.test.ts   # no kernel needed
bun test                                                       # + a real ipykernel, ~25 s
npm run typecheck
```

Gate 2 needs the evaluator venv (`npm run setup-venv`). The two Windows-specific cases in it are measured, not
assumed: a cell blocked in `time.sleep` is *interruptible* on POSIX and *parked* on Windows, because the Win32
interrupt only sets a pending-signal flag, and that parked shape is the same one a hung COM/RPC has.

## Status

Gated on Windows 11 (10.0.26300), OpenCode plugin API 2.3.0, Python 3.14.4 64-bit in the managed venv,
bun 1.4.4: 64 tests pass across the three gates, and the bridge drive harness confirms the interrupt path
(~1.1 s to cut a yielding cell with the namespace intact) and that teardown leaves no orphan interpreter.

Verified through the real harness rather than only the unit gates, in a scratch project with the plugin in the
global config and `opencode run --standalone` as the driver: five calls in one session held one namespace
(`x = 21` in one call, `42` out of the next), a missing package came back as the error plus the exact install
command for the kernel interpreter, a cell naming `timeoutMs: 1500` was cut while parked in `time.sleep(6)` with
only its pre-cut output and an intact namespace, and `status: true` then named the live kernel. A whole-cell
`for` loop with 600 ms sleeps streamed each line as it printed. After those runs exited, the process list held
no `python*` at all: the launcher → bridge → kernel chain dies with the session.

Not yet done, in order of value:

- The same COM smoke test against a live DraftSight instance, which this host does not have: it was measured
  against Excel 16.0 instead, so the DraftSight path still rests on the pi-pytool evidence.
- A second host, and a POSIX one: the Windows process-tree kill is measured, the POSIX path is not.

## Not

- Not a sandbox: the kernel runs with your permissions.
- Not a replacement for the other tools: file, process, git and install work stays outside it.
- Not durable across restarts: the namespace lives as long as the kernel does. A COM proxy, an open DWG and a
  DB connection cannot be pickled, so a rebuilt kernel starts empty and says so rather than pretending otherwise.

## License

MIT.
