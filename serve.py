#!/usr/bin/env python3
"""No-cache static server for the ocean project (port 5390)."""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5390
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        # module workers + SharedArrayBuffer-free, but keep COOP/COEP off so the
        # CDN script tag still loads
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


Handler.extensions_map.update({".js": "text/javascript", ".mjs": "text/javascript"})

if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"ocean serving {ROOT} on http://127.0.0.1:{PORT}")
        httpd.serve_forever()
