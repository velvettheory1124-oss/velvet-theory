#!/usr/bin/env python3
"""
Local helper for the VELVET/THEORY portfolio. Started by START-PORTFOLIO.bat.

It does two jobs:

  1. Serves this folder on http://localhost:8765 so the site (and its editor)
     can be opened in a browser.

  2. Makes the editor's Publish button work. A web page cannot write files or
     run git, so the page sends its changes here and this script does it:
         - saves new photographs into images/
         - writes the arrangement into V2-PORTFOLIO.html (the BASE_CONTENT block)
         - rebuilds PUBLISH/ with publish.ps1
         - commits and pushes to GitHub, where Netlify picks it up

Safety:
  - It listens on 127.0.0.1 only, so nothing outside this computer can reach it.
  - Publishing needs a random token that is generated each time this starts and
    is only handed to pages loaded from this same server. A web page on some
    other site cannot read it, so it cannot trigger a publish.
  - It only ever writes: images/<name>.jpg, V2-PORTFOLIO.html (the BASE_CONTENT
    statement and nothing else), and what publish.ps1 builds.
  - If GitHub has newer work than this computer, it stops BEFORE touching
    anything.
"""
import argparse
import base64
import datetime
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAGE = ROOT / "V2-PORTFOLIO.html"
IMAGES = ROOT / "images"

TOKEN = secrets.token_urlsafe(24)
LOCK = threading.Lock()
PORT = 8765

ALLOWED_KEYS = {"layouts", "removed", "added", "caps", "adj", "covers", "subs", "groups"}
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,80}\.jpg$")
MAX_BODY = 400 * 1024 * 1024
COMMIT_PATHS = ["V2-PORTFOLIO.html", "mobile.css", "images", "PUBLISH"]


class PublishError(Exception):
    """A problem to show the owner. `saved` says whether files were already written."""

    def __init__(self, message, saved=False):
        super().__init__(message)
        self.saved = saved


# ---------------------------------------------------------------- helpers

def run(cmd, timeout=120):
    """Run a command in the project folder; return (exit code, combined output)."""
    try:
        p = subprocess.run(
            cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
        return p.returncode, ((p.stdout or "") + (p.stderr or "")).strip()
    except subprocess.TimeoutExpired:
        return 1, "timed out after %d seconds" % timeout
    except FileNotFoundError as e:
        return 1, "could not run %s (%s)" % (cmd[0], e)


def tail(text, n=12):
    lines = [l for l in text.splitlines() if l.strip()]
    return "\n".join(lines[-n:])


def current_branch():
    code, out = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], 20)
    return out if code == 0 else ""


def find_statement(html):
    """Locate the whole `const BASE_CONTENT = {...};` statement in the page.

    Returns (start, end) such that html[start:end] is the statement, including
    its trailing semicolon. Braces inside strings are ignored, so a caption such
    as "a } b" cannot throw the match off."""
    m = re.search(r"(?m)^[ \t]*const BASE_CONTENT = ", html)
    if not m:
        raise PublishError("Could not find `const BASE_CONTENT` in V2-PORTFOLIO.html. Nothing was changed.")
    i = html.index("{", m.end() - 1)
    depth, in_str, quote, esc = 0, False, "", False
    j = i
    while j < len(html):
        c = html[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == quote:
                in_str = False
        else:
            if c in "\"'":
                in_str, quote = True, c
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    break
        j += 1
    else:
        raise PublishError("The BASE_CONTENT block in V2-PORTFOLIO.html is not closed. Nothing was changed.")
    k = j + 1
    while k < len(html) and html[k] in " \t":
        k += 1
    if k < len(html) and html[k] == ";":
        k += 1
    return m.start(), k


def render_statement(content, nl):
    text = json.dumps(content, indent=1, ensure_ascii=False)
    text = text.replace("</", "<\\/")          # a caption can never end the page's script
    text = text.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return ("const BASE_CONTENT = " + text + ";").replace("\n", nl)


# ---------------------------------------------------------------- publish

def publish(data):
    content = data.get("content")
    images = data.get("images") or []
    message = str(data.get("message") or "").strip()[:200]

    # ---- 1. check everything BEFORE touching a single file
    if not isinstance(content, dict) or not set(content) <= ALLOWED_KEYS:
        raise PublishError("The editor sent something this helper does not recognise. Nothing was changed.")
    decoded = []
    for im in images:
        name = str(im.get("name", ""))
        if not NAME_RE.match(name):
            raise PublishError("Refusing to save a photo called %r. Nothing was changed." % name)
        try:
            raw = base64.b64decode(im.get("data", ""), validate=True)
        except Exception:
            raise PublishError("A photo arrived damaged (%s). Nothing was changed." % name)
        if raw[:2] != b"\xff\xd8":
            raise PublishError("%s is not a JPEG. Nothing was changed." % name)
        decoded.append((name, raw))

    code, out = run(["git", "rev-parse", "--is-inside-work-tree"], 20)
    if code != 0:
        raise PublishError("This folder is not a git repository, so there is nothing to push to.")
    code, out = run(["git", "fetch", "origin"], 90)
    if code != 0:
        raise PublishError("Could not reach GitHub, so nothing was changed:\n" + tail(out))
    code, behind = run(["git", "rev-list", "--count", "HEAD..@{u}"], 20)
    if code == 0 and behind.strip() not in ("", "0"):
        raise PublishError(
            "GitHub has %s newer change(s) than this computer. Nothing was changed.\n"
            "Run `git pull` in the project folder first, then publish again." % behind.strip())

    html = PAGE.read_text(encoding="utf-8")
    nl = "\r\n" if "\r\n" in html else "\n"
    start, end = find_statement(html)
    new_html = html[:start] + render_statement(content, nl) + html[end:]

    # ---- 2. write. From here on, a failure leaves files changed on disk.
    IMAGES.mkdir(exist_ok=True)
    written = 0
    for name, raw in decoded:
        target = IMAGES / name
        if target.exists() and target.read_bytes() == raw:
            continue
        target.write_bytes(raw)
        written += 1
    with open(PAGE, "w", encoding="utf-8", newline="") as f:
        f.write(new_html)

    # ---- 3. rebuild PUBLISH/
    ps = shutil.which("powershell") or shutil.which("pwsh")
    if not ps:
        raise PublishError("PowerShell was not found, so PUBLISH/ could not be rebuilt.", saved=True)
    code, out = run([ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "publish.ps1")], 600)
    if code != 0 or not (ROOT / "PUBLISH" / "index.html").exists():
        raise PublishError("Building PUBLISH/ failed:\n" + tail(out), saved=True)

    # ---- 4. commit
    code, out = run(["git", "add", "--"] + COMMIT_PATHS, 120)
    if code != 0:
        raise PublishError("git add failed:\n" + tail(out), saved=True)
    code, _ = run(["git", "diff", "--cached", "--quiet"], 60)
    if code == 0:
        return {"summary": "Nothing had changed since the last publish, so there was nothing to send."}
    when = datetime.datetime.now().strftime("%d %B %Y, %H:%M")
    code, out = run(["git", "commit", "-q", "-m", message or ("Update the site - " + when)], 120)
    if code != 0:
        raise PublishError("git commit failed:\n" + tail(out), saved=True)
    code, sha = run(["git", "rev-parse", "--short", "HEAD"], 20)

    # ---- 5. push
    branch = current_branch()
    code, out = run(["git", "push"], 300)
    if code != 0:
        raise PublishError("Committed as %s, but the push to GitHub failed:\n%s" % (sha, tail(out)), saved=True)

    bits = []
    if written:
        bits.append("%d new photo%s" % (written, "" if written == 1 else "s"))
    bits.append("commit %s pushed to %s" % (sha, branch or "GitHub"))
    text = ", ".join(bits)
    return {"summary": text[0].upper() + text[1:] + "."}


# ---------------------------------------------------------------- server

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    # keep the console quiet except for publishing
    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        # the page is edited constantly; never serve a stale copy
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _host_ok(self):
        host = (self.headers.get("Host") or "").lower()
        return host in ("localhost:%d" % PORT, "127.0.0.1:%d" % PORT)

    def _json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/.git") or path.endswith("local-server.py"):
            self.send_error(404)
            return
        if path == "/__status":
            if not self._host_ok():
                self.send_error(403)
                return
            self._json(200, {"publish": True, "token": TOKEN, "branch": current_branch()})
            return
        super().do_GET()

    def do_OPTIONS(self):          # no CORS: other sites get nothing
        self.send_error(403)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/__publish":
            self.send_error(404)
            return
        origin = self.headers.get("Origin")
        if not self._host_ok() or (origin and origin not in ("http://localhost:%d" % PORT, "http://127.0.0.1:%d" % PORT)):
            self._json(403, {"ok": False, "error": "Refused: this request did not come from the local site."})
            return
        if self.headers.get("X-Publish-Token") != TOKEN:
            self._json(403, {"ok": False, "error": "Refused: wrong or missing token. Reload the page and try again."})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            self._json(400, {"ok": False, "error": "The upload was empty or far too large."})
            return
        try:
            data = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            self._json(400, {"ok": False, "error": "The upload could not be read."})
            return

        if not LOCK.acquire(blocking=False):
            self._json(409, {"ok": False, "error": "A publish is already running. Wait for it to finish."})
            return
        try:
            print("\n  Publishing...")
            result = publish(data)
            print("  Done: " + result["summary"])
            self._json(200, {"ok": True, **result})
        except PublishError as e:
            print("  Stopped: " + str(e))
            self._json(200, {"ok": False, "saved": e.saved, "error": str(e)})
        except Exception as e:                                  # never hang the page
            print("  Unexpected error: %r" % (e,))
            self._json(200, {"ok": False, "saved": False, "error": "Unexpected error: %s" % e})
        finally:
            LOCK.release()


def main():
    global PORT
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    PORT = ap.parse_args().port
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        print("Could not start on port %d: %s" % (PORT, e))
        print("Is the server already running in another window?")
        sys.exit(1)
    print("  VELVET/THEORY local server")
    print("  http://localhost:%d/V2-PORTFOLIO.html" % PORT)
    print("  Publish button: ready (this computer only)")
    print("  Keep this window open. Close it, or press Ctrl+C, when you are done.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
