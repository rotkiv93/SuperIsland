#!/usr/bin/env python3
"""
Dev Bridge for SuperIsland extensions (dev-status, clipboard-shelf).

SuperIsland extensions run in a JS sandbox with no shell, so this tiny
stdlib-only server (127.0.0.1:7831) does the local work on their behalf:

  GET  /health
  GET  /vpn                      GlobalProtect state {connected, ip, iface, gitlab}
  POST /vpn/connect              click "Connect" in the GlobalProtect menu-bar UI
  POST /vpn/disconnect           click "Disconnect"
  GET  /cornercase               {local, remote} summaries (agents, worktrees)
  GET  /services                 [{name, up, ms}] VPS / GitLab / Ollama / Mongo reachability
  POST /clipboard/transform      {id, kind: json|minify|trim} -> result goes on the clipboard
  GET  /clipboard                {items: [...]}   (newest first, pinned first)
  POST /clipboard/copy           {id}   put an item back on the clipboard
  POST /clipboard/pin            {id}   toggle pin
  POST /clipboard/delete         {id}
  POST /clipboard/clear          drop all unpinned items

Security: loopback only, Host header must be loopback, and any request that
carries an Origin header (i.e. from a web page) is rejected.
"""

import json
import os
import re
import socket
import pathlib
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("DEV_BRIDGE_PORT", "7831"))
REMOTE = os.environ.get("DEV_BRIDGE_CORNERCASE_REMOTE", "vps")
GITLAB_HOST = os.environ.get("DEV_BRIDGE_GITLAB_HOST", "gitlab.lbd.udc.es")
CORNERCASE_INTERVAL = float(os.environ.get("DEV_BRIDGE_CORNERCASE_INTERVAL", "20"))
CLIP_MAX_ITEMS = 50
CLIP_MAX_CHARS = 20000
DATA_DIR = pathlib.Path.home() / "Library/Application Support/SuperIsland/dev-bridge"
PINS_FILE = DATA_DIR / "pins.json"

PATH_EXTRA = "/opt/homebrew/bin:/usr/local/bin:" + str(pathlib.Path.home() / ".local/bin")
ENV = dict(os.environ, PATH=PATH_EXTRA + ":" + os.environ.get("PATH", ""))


def run(cmd, timeout=15, input_text=None):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           input=input_text, env=ENV)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except FileNotFoundError as e:
        return 127, "", str(e)


# --------------------------------------------------------------------------
# VPN (GlobalProtect)
# --------------------------------------------------------------------------

def vpn_state():
    """Connected when a utun interface holds an IPv4 address (the GP tunnel)."""
    code, out, _ = run(["ifconfig"], timeout=5)
    iface, ip, cur = None, None, None
    for line in out.splitlines():
        if line and not line[0].isspace():
            cur = line.split(":")[0]
        elif cur and cur.startswith("utun") and line.strip().startswith("inet "):
            iface, ip = cur, line.split()[1]
            break
    gp_running = run(["pgrep", "-x", "PanGPS"], timeout=3)[0] == 0
    gitlab = None
    if ip:
        gitlab = run(["/usr/bin/nc", "-z", "-G", "2", GITLAB_HOST, "443"], timeout=4)[0] == 0
    return {"connected": bool(ip), "ip": ip, "iface": iface,
            "agentRunning": gp_running, "gitlabReachable": gitlab}


GP_SCRIPT = '''
on run argv
  set wanted to item 1 of argv
  tell application "System Events"
    if not (exists process "GlobalProtect") then return "error:GlobalProtect is not running"
    tell process "GlobalProtect"
      click menu bar item 1 of menu bar 2
      delay 0.7
      set found to false
      repeat with e in (entire contents of window 1)
        try
          if (class of e is button) and ((name of e) is wanted or (title of e) is wanted) then
            click e
            set found to true
            exit repeat
          end if
        end try
      end repeat
      if not found then
        key code 53
        return "error:no '" & wanted & "' button (already " & wanted & "ed?)"
      end if
    end tell
  end tell
  return "ok"
end run
'''


def vpn_toggle(connect):
    code, out, err = run(["osascript", "-e", GP_SCRIPT, "Connect" if connect else "Disconnect"], timeout=25)
    out = out.strip()
    if code != 0:
        msg = err.strip() or "osascript failed"
        if "not allowed assistive" in msg or "(-1719)" in msg or "(-25211)" in msg:
            msg = "Grant Accessibility permission to the process running the bridge (System Settings > Privacy & Security > Accessibility)"
        return {"ok": False, "error": msg}
    if out.startswith("error:"):
        return {"ok": False, "error": out[6:]}
    return {"ok": True}


# --------------------------------------------------------------------------
# Cornercase (local + remote)
# --------------------------------------------------------------------------

_cc = {"local": {"ok": False, "error": "not polled yet"},
       "remote": {"ok": False, "error": "not polled yet"}, "at": 0}
_cc_lock = threading.Lock()


def summarize_status(data):
    counts = {}
    agents = []
    for proj in data.get("projects", []):
        for ws in proj.get("workspaces", []):
            for tab in ws.get("tabs", []):
                for pane in tab.get("panes", []):
                    if not pane.get("agent"):
                        continue
                    st = (pane.get("status") or "idle").split(" (")[0]
                    counts[st] = counts.get(st, 0) + 1
                    agents.append({
                        "project": proj.get("name"), "workspace": ws.get("name"),
                        "branch": ws.get("branch"), "agent": pane.get("agent"),
                        "status": st, "model": pane.get("model"),
                        "context": pane.get("context"), "id": pane.get("id")})
    return {"counts": counts, "agents": agents,
            "projects": len(data.get("projects", []))}


def summarize_worktrees(data):
    out = []
    for w in data.get("worktrees", []) if isinstance(data, dict) else []:
        out.append({
            "project": w.get("project") or w.get("project_name"),
            "branch": w.get("branch"),
            "path": w.get("path") or w.get("folder"),
            "merged": bool(w.get("merged")),
            "prunable": bool(w.get("prunable")),
            "safe": w.get("safe_to_remove", w.get("removable")),
            "raw": {k: v for k, v in w.items() if isinstance(v, (str, int, float, bool)) or v is None},
        })
    return out


def cornercase_query(remote):
    code, out, err = run(["cornercase", "status", "--json"] + (["--remote", remote] if remote else []), timeout=25)
    if code != 0:
        msg = (out or err).strip().splitlines()
        return {"ok": False, "error": msg[0] if msg else "cornercase failed"}
    try:
        res = summarize_status(json.loads(out))
    except ValueError:
        return {"ok": False, "error": "bad JSON from cornercase"}
    res["ok"] = True
    code, out, _ = run(["cornercase", "worktrees", "list", "--json", "--no-sizes"] +
                       (["--remote", remote] if remote else []), timeout=40)
    try:
        res["worktrees"] = summarize_worktrees(json.loads(out)) if code == 0 else []
    except ValueError:
        res["worktrees"] = []
    return res


def cornercase_loop():
    while True:
        local = cornercase_query(None)
        remote = cornercase_query(REMOTE) if REMOTE else {"ok": False, "error": "no remote configured"}
        with _cc_lock:
            _cc.update(local=local, remote=remote, at=time.time())
        time.sleep(CORNERCASE_INTERVAL)


# --------------------------------------------------------------------------
# Services health
# --------------------------------------------------------------------------

_services = {"items": [], "at": 0}


def tcp_probe(host, port, timeout=3):
    t0 = time.time()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True, int((time.time() - t0) * 1000)
    except OSError:
        return False, None


def ssh_target(alias):
    host, port = alias, 22
    code, out, _ = run(["ssh", "-G", alias], timeout=5)
    for line in out.splitlines():
        if line.startswith("hostname "):
            host = line.split()[1]
        elif line.startswith("port "):
            port = int(line.split()[1])
    return host, port


def services_loop():
    targets = [("VPS ssh", None), ("GitLab", (GITLAB_HOST, 443)),
               ("Ollama", ("127.0.0.1", 11434)), ("MongoDB", ("127.0.0.1", 27017))]
    if REMOTE:
        targets[0] = ("VPS ssh", ssh_target(REMOTE))
    else:
        targets.pop(0)
    while True:
        items = []
        for name, hp in targets:
            up, ms = tcp_probe(*hp)
            items.append({"name": name, "up": up, "ms": ms, "target": "%s:%s" % hp})
        _services.update(items=items, at=time.time())
        time.sleep(15)


# --------------------------------------------------------------------------
# Clipboard history
# --------------------------------------------------------------------------

_clip = {"items": [], "next": 1, "count": "none"}
_clip_lock = threading.Lock()

JXA = '''
ObjC.import("AppKit");
function run(argv) {
  var pb = $.NSPasteboard.generalPasteboard;
  var c = pb.changeCount;
  if (String(c) === argv[0]) return JSON.stringify({count: c, changed: false});
  var types = ObjC.deepUnwrap(pb.types) || [];
  var secret = types.indexOf("org.nspasteboard.ConcealedType") >= 0 ||
               types.indexOf("org.nspasteboard.TransientType") >= 0 ||
               types.indexOf("com.agilebits.onepassword") >= 0;
  var s = pb.stringForType("public.utf8-plain-text");
  var text = s ? ObjC.unwrap(s) : null;
  return JSON.stringify({count: c, changed: true, secret: secret, text: text});
}
'''


def load_pins():
    try:
        return json.loads(PINS_FILE.read_text())
    except Exception:
        return []


def save_pins():
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        pins = [i["text"] for i in _clip["items"] if i["pinned"]]
        PINS_FILE.write_text(json.dumps(pins))
        os.chmod(PINS_FILE, 0o600)
    except Exception as e:
        print("pin save failed:", e, file=sys.stderr)


SECRET_RE = re.compile(
    r"(glpat-|ghp_|gho_|github_pat_|sk-[A-Za-z0-9]|sk-ant-|AKIA[0-9A-Z]{12}|xox[baprs]-|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|-----BEGIN [A-Z ]*PRIVATE KEY)")


def looks_secret(text):
    t = text.strip()
    if SECRET_RE.search(t):
        return True
    # one long token with no spaces and mixed character classes
    return (len(t) >= 32 and " " not in t and "\n" not in t and "/" not in t[:8]
            and re.search(r"[A-Za-z]", t) and re.search(r"\d", t) and re.fullmatch(r"[A-Za-z0-9_\-+=.]+", t) is not None)


def clip_add(text):
    text = text.strip("\n") if text else ""
    if not text.strip() or len(text) > CLIP_MAX_CHARS or looks_secret(text):
        return
    with _clip_lock:
        existing = next((i for i in _clip["items"] if i["text"] == text), None)
        if existing:
            _clip["items"].remove(existing)
            existing["at"] = time.time()
            _clip["items"].insert(0, existing)
            return
        item = {"id": _clip["next"], "text": text, "at": time.time(), "pinned": False}
        _clip["next"] += 1
        _clip["items"].insert(0, item)
        unpinned = [i for i in _clip["items"] if not i["pinned"]]
        for extra in unpinned[CLIP_MAX_ITEMS:]:
            _clip["items"].remove(extra)


def clipboard_loop():
    for t in load_pins():
        clip_add(t)
        _clip["items"][0]["pinned"] = True
    while True:
        code, out, _ = run(["osascript", "-l", "JavaScript", "-e", JXA, str(_clip["count"])], timeout=5)
        if code == 0:
            try:
                r = json.loads(out)
                _clip["count"] = r["count"]
                if r.get("changed") and not r.get("secret") and r.get("text"):
                    clip_add(r["text"])
            except Exception:
                pass
        time.sleep(0.8)


def clip_view():
    with _clip_lock:
        items = sorted(_clip["items"], key=lambda i: (not i["pinned"], -i["at"]))
        return {"items": [dict(i) for i in items]}


def clip_find(item_id):
    return next((i for i in _clip["items"] if i["id"] == item_id), None)


def clip_action(path, body):
    if path == "/clipboard/clear":
        with _clip_lock:
            _clip["items"] = [i for i in _clip["items"] if i["pinned"]]
        return {"ok": True}
    item_id = body.get("id")
    with _clip_lock:
        item = clip_find(item_id)
    if not item:
        return {"ok": False, "error": "unknown item"}
    if path == "/clipboard/copy":
        code, _, err = run(["pbcopy"], timeout=5, input_text=item["text"])
        return {"ok": code == 0, "error": err.strip() or None}
    if path == "/clipboard/transform":
        text = item["text"]
        kind = body.get("kind")
        try:
            if kind == "json":
                text = json.dumps(json.loads(text), indent=2, ensure_ascii=False)
            elif kind == "minify":
                text = json.dumps(json.loads(text), separators=(",", ":"), ensure_ascii=False)
            elif kind == "trim":
                text = " ".join(text.split())
            else:
                return {"ok": False, "error": "unknown transform"}
        except ValueError:
            return {"ok": False, "error": "not valid JSON"}
        code, _, err = run(["pbcopy"], timeout=5, input_text=text)
        return {"ok": code == 0, "error": err.strip() or None}
    with _clip_lock:
        if path == "/clipboard/pin":
            item["pinned"] = not item["pinned"]
            save_pins()
        elif path == "/clipboard/delete":
            _clip["items"].remove(item)
            save_pins()
    return {"ok": True}


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _guard(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost") or self.headers.get("Origin"):
            self._send(403, {"error": "forbidden"})
            return False
        return True

    def do_GET(self):
        if not self._guard():
            return
        path = self.path.split("?")[0]
        if path == "/health":
            return self._send(200, {"ok": True, "port": PORT})
        if path == "/vpn":
            return self._send(200, vpn_state())
        if path == "/cornercase":
            with _cc_lock:
                return self._send(200, {"local": _cc["local"], "remote": _cc["remote"],
                                        "remoteName": REMOTE, "at": _cc["at"]})
        if path == "/services":
            return self._send(200, _services)
        if path == "/clipboard":
            return self._send(200, clip_view())
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._guard():
            return
        path = self.path.split("?")[0]
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        except ValueError:
            return self._send(400, {"error": "bad json"})
        if path in ("/vpn/connect", "/vpn/disconnect"):
            return self._send(200, vpn_toggle(path.endswith("connect") and not path.endswith("disconnect")))
        if path.startswith("/clipboard/"):
            return self._send(200, clip_action(path, body))
        self._send(404, {"error": "not found"})


def main():
    threading.Thread(target=cornercase_loop, daemon=True).start()
    threading.Thread(target=clipboard_loop, daemon=True).start()
    threading.Thread(target=services_loop, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
