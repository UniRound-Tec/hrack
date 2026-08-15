#!/usr/bin/env python3
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return

    def do_GET(self):
        body = b'<!doctype html><title>DSH runtime fixture</title>'
        self.send_response(200)
        self.send_header('content-type', 'text/html; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get('content-length', '0'))
        if length:
            self.rfile.read(length)
        if self.path == '/api/session.list':
            value = {'items': []}
        elif self.path == '/api/workspace.list':
            value = {'archivedSessionIds': []}
        elif self.path == '/api/fixture.describe':
            value = {
                'dshHome': os.environ.get('DSH_HOME'),
                'telemetryDisabled': os.environ.get('DSH_TELEMETRY_DISABLED'),
                'pid': os.getpid(),
            }
        else:
            value = {}
        body = json.dumps({'result': {'ok': True, 'value': value}}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    ThreadingHTTPServer((sys.argv[1], int(sys.argv[2])), Handler).serve_forever()
