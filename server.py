#!/usr/bin/env python3
"""pi web ui server.

Spawns a `pi --mode rpc` subprocess and exposes it over HTTP + SSE so a
browser can chat with the pi coding agent.

Endpoints:
  GET  /api/health      -> {"ok": true, ...}
  GET  /api/events      -> SSE stream of pi session records
  GET  /api/state       -> current pi session state (via get_state)
  GET  /api/models      -> available models (via get_available_models)
  GET  /api/stats       -> session stats (via get_session_stats)
  POST /api/command     -> send a pi rpc command, await its response
  POST /api/ui-response -> answer an extension_ui_request dialog
  POST /api/restart     -> restart the pi process
  GET  /                -> static frontend
"""

import json
import os
import queue
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HOST = os.environ.get("PI_WEB_HOST", "0.0.0.0")
PORT = int(os.environ.get("PI_WEB_PORT", "8787"))
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
PI_ARGS = ["pi", "--mode", "rpc", "--no-session"]
PI_CWD = os.environ.get("PI_WEB_CWD", "/home/user/aaaa")
CMD_TIMEOUT = 300


class Bridge:
    def __init__(self):
        self.proc = None
        self.proc_lock = threading.Lock()
        self.cond = threading.Condition()
        self.pending = {}  # command id -> {"event": Event, "data": None}
        self.clients = []  # list of queue.Queue
        self.clients_lock = threading.Lock()
        self.stderr_file = None
        self.start()

    # ---------- process lifecycle ----------

    def start(self):
        self.stop_proc()
        self.stderr_file = open(os.devnull, "w")
        self.proc = subprocess.Popen(
            PI_ARGS,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.stderr_file,
            cwd=PI_CWD,
            bufsize=0,
        )
        self.proc_lock = threading.Lock()
        t = threading.Thread(target=self._reader, daemon=True)
        t.start()

    def stop_proc(self):
        with self.proc_lock:
            p = self.proc
            self.proc = None
        if p is not None and p.poll() is None:
            try:
                p.kill()
                p.wait(timeout=5)
            except Exception:
                pass
        with self.cond:
            self.pending.clear()

    # ---------- stdin writes ----------

    def _write(self, rec):
        with self.proc_lock:
            if self.proc is None or self.proc.poll() is not None:
                raise RuntimeError("pi process is not running")
            self.proc.stdin.write(json.dumps(rec).encode("utf-8") + b"\n")
            self.proc.stdin.flush()

    # ---------- stdout reader ----------

    def _reader(self):
        buf = b""
        proc = self.proc
        try:
            while True:
                chunk = proc.stdout.read(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line.decode("utf-8"))
                    except Exception:
                        continue
                    self._on_record(rec)
        finally:
            with self.cond:
                self.pending.clear()
            with self.proc_lock:
                p = self.proc
                self.proc = None
            if p is not None:
                try:
                    p.kill()
                except Exception:
                    pass

    def _on_record(self, rec):
        t = rec.get("type")
        if t == "response":
            cmd_id = rec.get("id")
            with self.cond:
                entry = self.pending.pop(cmd_id, None)
                if entry is not None:
                    entry["event"].set()
                    entry["data"] = rec
        with self.clients_lock:
            clients = list(self.clients)
        for c in clients:
            try:
                c.put_nowait(rec)
            except Exception:
                pass

    # ---------- commands ----------

    def send_command(self, cmd, timeout=CMD_TIMEOUT):
        cmd_id = cmd.get("id") or ("cmd-" + uuid.uuid4().hex)
        cmd = dict(cmd)
        cmd["id"] = cmd_id
        entry = {"event": threading.Event(), "data": None}
        with self.cond:
            self.pending[cmd_id] = entry
        self._write(cmd)
        entry["event"].wait(timeout)
        with self.cond:
            self.pending.pop(cmd_id, None)
        data = entry["data"]
        success = True
        error = None
        response_data = None
        if data is None:
            success = False
            error = "Timed out waiting for pi response"
        else:
            success = bool(data.get("success"))
            error = data.get("error")
            response_data = data.get("data")
        return {
            "type": "response",
            "command": cmd.get("type"),
            "id": cmd_id,
            "success": success,
            "data": response_data,
            "error": error,
        }

    def send_ui_response(self, rec):
        with self.proc_lock:
            if self.proc is None or self.proc.poll() is not None:
                return {"ok": False, "error": "pi process is not running"}
            self.proc.stdin.write(json.dumps(rec).encode("utf-8") + b"\n")
            self.proc.stdin.flush()
        return {"ok": True}

    # ---------- sse ----------

    def subscribe(self):
        q = queue.Queue()
        with self.clients_lock:
            self.clients.append(q)
        return q

    def unsubscribe(self, q):
        with self.clients_lock:
            try:
                self.clients.remove(q)
            except ValueError:
                pass

    def restart(self):
        self.stop_proc()
        self.start()
        return {"ok": True}


BRIDGE = Bridge()


class Handler(BaseHTTPRequestHandler):
    server_version = "pi-webui/1.0"
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):
        print("[pi-webui] " + (fmt % args), flush=True)

    # ---------- helpers ----------

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    # ---------- routes ----------

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            with BRIDGE.cond:
                running = BRIDGE.proc is not None and BRIDGE.proc.poll() is None
            return self._send_json(200, {"ok": running})
        if path == "/api/events":
            return self._sse()
        if path == "/api/state":
            try:
                resp = BRIDGE.send_command({"type": "get_state"})
                return self._send_json(200, {"ok": True, "data": resp.get("data")})
            except Exception as e:
                return self._send_json(500, {"ok": False, "error": str(e)})
        if path == "/api/models":
            try:
                resp = BRIDGE.send_command({"type": "get_available_models"})
                return self._send_json(200, {"ok": True, "data": resp.get("data")})
            except Exception as e:
                return self._send_json(500, {"ok": False, "error": str(e)})
        if path == "/api/stats":
            try:
                resp = BRIDGE.send_command({"type": "get_session_stats"})
                return self._send_json(200, {"ok": True, "data": resp.get("data")})
            except Exception as e:
                return self._send_json(500, {"ok": False, "error": str(e)})
        # static files
        if path == "/":
            path = "/index.html"
        if path in ("/index.html", "/style.css", "/app.js"):
            fname = path.lstrip("/")
            fpath = os.path.join(STATIC_DIR, fname)
            if not os.path.isfile(fpath):
                return self._send_json(404, {"ok": False, "error": "not found"})
            ctype = {
                "/index.html": "text/html; charset=utf-8",
                "/style.css": "text/css; charset=utf-8",
                "/app.js": "text/javascript; charset=utf-8",
            }[path]
            body = open(fpath, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/command":
            body = self._read_body()
            cmd = body.get("command") if isinstance(body.get("command"), dict) else body
            resp = BRIDGE.send_command(cmd)
            if not resp.get("success"):
                return self._send_json(200, {"ok": False, "error": resp.get("error") or "Command failed"})
            return self._send_json(200, {"ok": True, "data": resp.get("data")})
        if path == "/api/ui-response":
            body = self._read_body()
            rec = {"type": "extension_ui_response", "id": body.get("id")}
            for k, v in body.items():
                if k in ("type", "id"):
                    continue
                rec[k] = v
            return self._send_json(200, BRIDGE.send_ui_response(rec))
        if path == "/api/restart":
            return self._send_json(200, BRIDGE.restart())
        return self._send_json(404, {"ok": False, "error": "not found"})

    def _sse(self):
        q = BRIDGE.subscribe()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            while True:
                try:
                    rec = q.get(timeout=25)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                data = json.dumps(rec).encode("utf-8")
                self.wfile.write(b"data: " + data + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            BRIDGE.unsubscribe(q)

    # ---------- static ----------

    def _serve_file(self, path, ctype):
        fpath = os.path.join(STATIC_DIR, path.lstrip("/"))
        if not os.path.isfile(fpath):
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        body = open(fpath, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"[pi-webui] serving on http://{HOST}:{PORT} (pi: {' '.join(PI_ARGS)})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
