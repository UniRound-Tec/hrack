# HRack Remote multi-node public validation — 2026-08-28

## Deployment

- Control plane and `us-1`: `195.72.191.131`, public origin `https://hrack.dev`.
- `cn-1` regional Relay: `103.236.53.197`.
- `cn-1` Relay/WSS origin: `https://103.236.53.197`.
- `cn-1` DSH origin: `https://103.236.53.197:8443`.
- Server implementation commit before this evidence update: `5450a68`.
- Desktop implementation commit: `5b15bf3`.
- App implementation commit: `b162330`.

The China provider rewrote domain HTTP validation to an injected `404 NOTOK`
and reset TLS-ALPN validation. Raw-IP HTTP remained reachable. A publicly
trusted Let’s Encrypt short-lived IP certificate was therefore issued with
Certbot 5.7.0. A dedicated systemd timer runs renewal twice daily and reloads
Nginx. No private token, room ID, URL key, ticket or Cookie is recorded here.

## Real interface results

1. The control plane, US Relay, Web, Nginx and pairing reconciler were running
   from their real Docker images. The regional node ran only Relay and Nginx.
2. The reconciler health endpoint reported both `us-1` and `cn-1` healthy with
   zero consecutive failures.
3. A temporary database-backed pairing assigned to `cn-1` resolved through
   `POST https://hrack.dev/api/remote/resolve` to the China Relay and DSH
   origins above. The stable join origin remained `https://hrack.dev`.
4. Two real public WSS clients completed desktop/phone hello and peer join over
   the China Relay. A 77-byte PTY input frame sent by the phone was received as
   the same 77-byte frame by the desktop.
5. The China Relay process was restarted. Reconciler logs recorded
   `instanceChanged: true`, reapplied revision 13 with one China room, and the
   same room returned HTTP 200. A second public WSS PTY exchange succeeded.
6. The public DSH tunnel used a single-use browser ticket, transferred and
   SHA-256-verified 1,048,576 HTTP response bytes, and carried two independent
   WebSocket streams (`events.mux` and `events.host`).
7. A non-control-center request to the regional system management route
   returned HTTP 403. The same authenticated request from the US control center
   returned HTTP 200.
8. The temporary pairing and user were deleted. Both the resolver and regional
   room lookup returned HTTP 404 afterward.

No automated test suite was run for this deployment pass. The evidence above
came from real HTTPS, WSS, Relay restart, resolver and DSH tunnel traffic.
