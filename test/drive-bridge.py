"""Drives bridge.py over real stdio and prints the protocol transcript.

Manual tool, not a test suite: it exists to see the wire traffic while the bridge is
being built (payload routing, interrupt latency on Windows, teardown).
Usage: python test/drive-bridge.py
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BRIDGE = os.path.join(ROOT, "bridge.py")


def venv_python():
    """The managed venv: project-local first, then the shared one pytool actually boots."""
    if os.name == "nt":
        local = os.path.join(ROOT, "venv", "Scripts", "python.exe")
        shared = os.path.expanduser(os.path.join("~", ".local", "share", "opencode", "pytool", "venv", "Scripts", "python.exe"))
    else:
        local = os.path.join(ROOT, "venv", "bin", "python")
        shared = os.path.expanduser(os.path.join("~", ".local", "share", "opencode", "pytool", "venv", "bin", "python"))
    for p in (local, shared):
        if os.path.exists(p):
            return p
    return sys.executable


class Drive:
    def __init__(self):
        self.p = subprocess.Popen(
            [venv_python(), BRIDGE],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            encoding="utf-8", bufsize=1,
        )
        self.n = 0

    def send(self, **msg):
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()

    def read(self, timeout=90):
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.p.stdout.readline()
            if not line:
                return None
            line = line.strip()
            if line:
                return json.loads(line)
        return None

    def rpc(self, expect_types, **msg):
        self.n += 1
        mid = "t%d" % self.n
        got = []
        self.send(id=mid, **msg)
        while True:
            m = self.read()
            if m is None:
                return got, None
            got.append(m)
            if m.get("type") in expect_types:
                return got, m

    def cell(self, code):
        got, res = self.rpc({"result"}, op="exec", code=code)
        streams = [m for m in got if m["type"] == "stream"]
        return res, streams

    def stderr_text(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        return self.p.stderr.read()


def main():
    d = Drive()
    _, ready = d.rpc({"ready"}, op="boot")
    print("READY", ready)
    kpid = ready["kernel_pid"]
    print("kernel_pid=%s bridge_pid=%s" % (kpid, ready["pid"]))

    res, _ = d.cell("import sys, os\nsys.executable")
    print("EXEC sys.executable ->", res.get("result"))

    res, streams = d.cell('print("hello out")\nimport sys; print("hello err", file=sys.stderr)')
    print("EXEC prints ->", res["status"], [(s["name"], s["text"].strip()) for s in streams])

    res, _ = d.cell("x = 21*2")
    print("EXEC x=21*2 ->", res["status"], res.get("result"))
    res, _ = d.cell("x")
    print("EXEC x ->", res.get("result"))

    _, rep = d.rpc({"reply"}, op="listNames")
    print("NAMES ->", rep["names"])

    res, _ = d.cell("1/0")
    print("EXEC 1/0 ->", res["status"], res["error"]["name"], "|", res["error"]["message"])

    res, _ = d.cell("def f(a, b=2):\n    'doc'\n    return a+b")
    print("EXEC def ->", res["status"], res.get("error") or "")
    _, rep = d.rpc({"reply"}, op="listNames")
    print("NAMES ->", rep["names"])

    res, streams = d.cell('print("재질/Ø OK")')
    print("EXEC unicode ->", res["status"], [s["text"].strip() for s in streams])

    # long cell + interrupt
    t0 = time.time()
    d.n += 1
    mid = "t%d" % d.n
    d.send(id=mid, op="exec", code="import time\nfor _ in range(200):\n    time.sleep(0.05)")
    time.sleep(1.0)
    d.send(op="interrupt")
    while True:
        m = d.read()
        if m is None:
            print("INTERRUPT -> no result (bridge died?)")
            break
        if m.get("type") == "result":
            print("INTERRUPT -> %s in %.1fs %s" % (m["status"], time.time() - t0, m.get("error") or ""))
            break

    _, rep = d.rpc({"reply"}, op="listNames")
    print("NAMES after interrupt ->", rep["names"][:6])

    d.send(op="shutdown", id="bye")
    code = d.p.wait(timeout=20)
    print("BRIDGE exit=%s" % code)
    alive = False
    try:
        import ctypes
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, kpid)
        alive = bool(h)
        if h:
            ctypes.windll.kernel32.CloseHandle(h)
    except Exception:
        pass
    print("kernel process %s alive=%s" % (kpid, alive))
    err = d.stderr_text()
    print("BRIDGE stderr:\n%s" % (err.strip() or "(empty)"))


if __name__ == "__main__":
    main()
