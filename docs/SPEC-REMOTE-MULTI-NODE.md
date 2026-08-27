# HRack Remote Multi-Node P0 Specification

Status: implementation target  
Scope: United States control center plus independently deployed regional Relay nodes

## 1. Goal

Keep `hrack.dev` as the only control center while allowing a pairing room to use a Relay close to the user. The first deployment contains:

- `us-1`: the Relay beside the control center in the United States.
- `cn-1`: a Relay in China.

The control center owns accounts, pairing records, node selection and room projection. A regional node owns only live WebSocket/DSH traffic for rooms assigned to it. Regional nodes do not contain the account database and do not call each other.

## 2. Invariants

1. The shareable URL remains stable: `https://hrack.dev/remote/{roomId}`.
2. Every room belongs to exactly one `nodeId` until it is revoked. Rotation preserves the node unless a later product flow explicitly moves it.
3. Desktop and App resolve the room through `hrack.dev` before opening WebSocket or DSH traffic, then connect directly to the selected node.
4. The United States node never proxies China session traffic. Only control-plane room projection travels from the control center to the China node.
5. Relay service tokens, revoke tokens and internal origins are never returned by the public resolver or written to client logs.
6. Existing rooms are migrated to `us-1` and continue to work.

## 3. Static node directory

P0 uses one environment variable on the web and reconciler processes:

```json
[
  {
    "id": "us-1",
    "region": "us",
    "label": "United States",
    "relayInternalOrigin": "http://relay:3000",
    "relayPublicOrigin": "https://hrack.dev",
    "dshPublicOrigin": "https://dsh.hrack.dev",
    "serviceToken": "...",
    "enabled": true
  },
  {
    "id": "cn-1",
    "region": "cn",
    "label": "China",
    "relayInternalOrigin": "https://relay-cn.hrack.dev",
    "relayPublicOrigin": "https://relay-cn.hrack.dev",
    "dshPublicOrigin": "https://dsh-cn.hrack.dev",
    "serviceToken": "...",
    "enabled": true
  }
]
```

The variable name is `RELAY_NODES_JSON`. Node IDs are stable lowercase identifiers. Duplicate IDs, invalid origins, missing tokens and an empty enabled set fail startup. When the variable is absent, the existing single-node variables form a compatible `us-1` node.

Adding a third region requires only a node configuration entry, one Relay deployment and DNS/TLS; it must not require a schema change.

### 3.1 IP-certificate fallback

Some regional hosting networks rewrite or reset unfiled domain HTTP Host and TLS SNI traffic. WSS still performs a TLS handshake and therefore does not bypass that policy. If both HTTP-01 and TLS-ALPN-01 fail at the network edge while raw-IP HTTP succeeds, the node may use a publicly trusted short-lived IP certificate:

- `relayPublicOrigin`: `https://REGIONAL_IP` on port 443.
- `dshPublicOrigin`: `https://REGIONAL_IP:8443`.
- The management and Relay routes stay on 443; DSH public HTTP/WebSocket stays on 8443.
- The two origins must not share one authority. Relay identifies DSH public traffic by Host authority, so sharing `IP:443` would misroute the control API as DSH traffic.
- Certificate renewal must run at least twice daily and reload Nginx because IP certificates are short-lived.

The stable user-facing join URL remains on `hrack.dev`; the IP origin is returned only by the resolver for the selected room.

## 4. Data model

`pairings` gains a non-null `node_id` column with default `us-1` and an index. The existing global projection revision remains authoritative in P0. Each independent Relay receives the same revision number with only its assigned room subset.

The control center rejects creation for a disabled or unknown node. If a configured node is removed while rooms still reference it, those rooms become unavailable and are reported in diagnostics; they are never silently moved.

## 5. Control API

### Resolve transport

`POST /api/remote/resolve`

Request:

```json
{ "roomId": "opaque-room-id" }
```

Successful response:

```json
{
  "v": 1,
  "nodeId": "cn-1",
  "region": "cn",
  "label": "China",
  "relayOrigin": "https://relay-cn.hrack.dev",
  "dshOrigin": "https://dsh-cn.hrack.dev"
}
```

Only active rooms owned by a non-banned user resolve. Missing, revoked, disabled-node and unknown-node rooms return `404`. Responses use `Cache-Control: no-store`. The endpoint never returns internal origins or credentials.

Client fallback rules:

- `200` with a valid payload: use the returned origins.
- `404` whose response identifies the route as unsupported: use legacy same-origin transport.
- Network failure, malformed payload, other `4xx`, or `5xx`: show a retryable connection error. Do not silently connect to the wrong node.

### Pairing creation

The dashboard exposes enabled regions. Creating a pairing accepts a `nodeId`; rotating an existing pairing keeps its current `nodeId`. Pairing views include the selected node label.

## 6. Room projection

The reconciler loads the node directory, groups active rooms by `node_id`, then independently reconciles every enabled node through the existing authenticated system state/rooms API.

- Failure of one node must not stop reconciliation of other nodes.
- Logs and health state include `nodeId`, latency and error category, but never room IDs or tokens.
- A restarted Relay receives the current full subset for its node.
- The regional Nginx allows the system management route only from the control-center public IP; the Relay bearer token remains mandatory.

## 7. Client connection flow

1. Parse and validate the stable join URL.
2. Call the resolver at the join URL origin.
3. Build the WebSocket URL from `relayOrigin` while preserving the protocol base path and room ID.
4. Build the DSH tunnel URL from `dshOrigin`.
5. Preserve the stable join URL for display, persistence, QR codes and reconnects.

Desktop and App must use the same rules. A resolver result is kept only for the current connection attempt so a later reconnect can observe a deliberate node change.

## 8. Regional deployment

A regional node runs only:

- Relay process with an in-memory room snapshot restored by the reconciler after restart.
- Nginx for public TLS WebSocket/HTTP and DSH tunnel routes.
- Certificate renewal, health check and log rotation.

It does not run Next.js, SQLite, auth, email, admin initialization or the pairing reconciler. Public Relay/DSH routes use WSS/HTTPS. The management route is IP-restricted and token-authenticated.

## 9. Real acceptance gates

Automated tests are supporting evidence only. Completion requires actual processes and real interfaces:

1. Create a `us-1` URL, connect desktop and App, exchange terminal input/output, and observe bytes only on `us-1`.
2. Create a `cn-1` URL, connect desktop and App, exchange terminal input/output, and observe active sessions/bytes on `cn-1`, not `us-1`.
3. Open a DSH session assigned to `cn-1` and verify browser traffic reaches the resolver-provided DSH origin (regional domain or the IP-certificate `:8443` fallback).
4. Confirm the displayed/saved/QR join URL remains `https://hrack.dev/remote/{roomId}` for both nodes.
5. Restart `cn-1`; the reconciler must restore its room subset and the same URL must reconnect.
6. Confirm an unauthenticated or non-control-center request cannot call a regional system management route.
7. Confirm an existing pre-migration pairing resolves to `us-1`.

Record host, time, selected node, resolved public origins, connection result, traffic counters and restart result without recording credentials or room secrets.

## 10. Explicitly deferred

- Dynamic node registration and admin node CRUD.
- Latency-based automatic selection or automatic failover.
- Database replication and multi-primary control planes.
- Relay-to-Relay or control-center session forwarding.
- Short-lived connection tickets, mTLS and per-room migration.
- Capacity scheduling and billing by region.
