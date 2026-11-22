"""HTTP plumbing for `slck rewrite review PLAN`: the `PlanView` page over a plan file.

Endpoints:

- ``GET /``, ``GET /<asset>``: the vendored ``dist/`` (built from the `ts` branch's
  ``src/plan-view/review.tsx``; see ``BUNDLE_PROVENANCE``).
- ``GET /plan``: ``{"path", "plan"}``, the plan's review form (`Plan.review_json`).
- ``POST /check``, ``POST /apply``: body ``{"ids": [ts, …]}``; runs `apply` on
  those actions (a dry run for ``/check``) and returns ``{"outcomes": […]}``.

Bound to 127.0.0.1. A POST must be ``Content-Type: application/json`` and,
when the browser sends an ``Origin``, come from this server's own origin, so
another site's page can't trigger an apply.
"""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

from ..rewrite import Outcome, Plan

# The preview server's 3077, plus one.
DEFAULT_PORT = 3078

DIST_DIR = Path(__file__).parent / "dist"

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}

# `(plan, ids, dry_run) -> outcomes`; the CLI binds the Slack client and receipts.
Runner = Callable[[Plan, list[str], bool], list[Outcome]]


def make_handler(plan_path: Path, run: Runner, dist_dir: Path = DIST_DIR) -> type[BaseHTTPRequestHandler]:
    plan = Plan.load(plan_path)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args) -> None:
            pass

        def _json(self, status: int, obj: dict) -> None:
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if path == "/plan":
                self._json(200, {"path": plan_path.name, "plan": plan.review_json()})
                return
            name = path.lstrip("/") or "index.html"
            file = (dist_dir / name).resolve()
            if not file.is_relative_to(dist_dir.resolve()) or not file.is_file():
                self._json(404, {"error": f"not found: {path}"})
                return
            body = file.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", _CONTENT_TYPES.get(file.suffix, "application/octet-stream"))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            path = self.path.split("?", 1)[0]
            if path not in ("/check", "/apply"):
                self._json(404, {"error": f"not found: {path}"})
                return
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                self._json(415, {"error": "expected Content-Type: application/json"})
                return
            origin = self.headers.get("Origin")
            if origin is not None and origin != f"http://{self.headers.get('Host')}":
                self._json(403, {"error": f"cross-origin request from {origin}"})
                return
            length = int(self.headers.get("Content-Length", 0))
            try:
                ids = json.loads(self.rfile.read(length))["ids"]
            except (json.JSONDecodeError, KeyError, TypeError) as e:
                self._json(400, {"error": f"bad request: {e}"})
                return
            if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
                self._json(400, {"error": "bad request: ids must be a list of ts strings"})
                return
            known = {a.ts for a in plan.actions if a.writes}
            unknown = [i for i in ids if i not in known]
            if unknown:
                self._json(400, {"error": f"not edits or reposts in this plan: {', '.join(unknown)}"})
                return
            try:
                outcomes = run(plan, ids, path == "/check")
            except Exception as e:
                self._json(500, {"error": f"{type(e).__name__}: {e}"})
                return
            self._json(200, {"outcomes": [o.to_json() for o in outcomes]})

    return Handler


def serve(plan_path: Path, port: int, run: Runner, dist_dir: Path = DIST_DIR) -> ThreadingHTTPServer:
    """Bind and return the server (the caller runs ``serve_forever``; port 0 picks a free one)."""
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(plan_path, run, dist_dir))
