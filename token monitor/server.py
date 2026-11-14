import argparse
import json
import os
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit

from pricing import Catalog
from usage import PHASES, collect

WEB = Path(__file__).with_name("web")
STATIC = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
          "/styles.css": ("styles.css", "text/css")}


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, home, catalog, **kwargs):
        self.home = home
        self.catalog = catalog
        super().__init__(*args, **kwargs)

    def valid_host(self):
        return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

    def respond(self, status, data, mime):
        self.send_response(status)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(data)

    def json_response(self, data, status=200):
        self.respond(status, json.dumps(data, ensure_ascii=False).encode(), "application/json")

    def do_GET(self):
        if not self.valid_host():
            return self.json_response({"error": "请使用服务显示的本机地址"}, 403)
        route = urlsplit(self.path).path
        if route == "/api/usage":
            return self.json_response(collect(self.home) | {"phases": PHASES, "pricing": self.catalog.snapshot()})
        if route == "/api/pricing":
            return self.json_response(self.catalog.snapshot())
        if route in STATIC:
            file, mime = STATIC[route]
            return self.respond(200, (WEB / file).read_bytes(), mime)
        self.json_response({"error": "页面不存在"}, 404)

    def do_POST(self):
        origin = f"http://127.0.0.1:{self.server.server_port}"
        if not self.valid_host() or self.headers.get("Origin") != origin:
            return self.json_response({"error": "仅接受本机页面请求"}, 403)
        if self.path != "/api/pricing/refresh":
            return self.json_response({"error": "页面不存在"}, 404)
        self.catalog.refresh()
        self.json_response(self.catalog.snapshot())


def main():
    home = os.getenv("PROMA_HOME", "").strip()
    default_home = Path(home) if home and home not in ("undefined", "null") else Path.home() / ".proma"
    parser = argparse.ArgumentParser(description="Bloma 本机 Token 用量监测")
    parser.add_argument("--home", type=Path, default=default_home)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--offline", action="store_true", help="启动时使用缓存价格")
    args = parser.parse_args()
    catalog = Catalog(args.home / "token-monitor" / "pricing-cache.json")
    with ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, home=args.home, catalog=catalog)) as server:
        print(f"Bloma Token Monitor  http://127.0.0.1:{server.server_port}/", flush=True)
        if not args.offline:
            Thread(target=catalog.refresh, daemon=True).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
