# Phase -1 — TCP_NODELAY audit

## Result: Nagle's algorithm was ALREADY off. The diagnosis (TCP retransmit + HOL blocking on WiFi loss) stands.

## Evidence

### 1. `ws` library calls `socket.setNoDelay()` on every WebSocket connection

`node_modules/ws/lib/websocket.js:242`:

```js
if (socket.setNoDelay) socket.setNoDelay();
```

This runs inside `WebSocket.prototype.setSocket` on every connection establishment. The default value of `setNoDelay()` with no argument is `true` (enable TCP_NODELAY = disable Nagle). So every Colyseus WebSocket connection has TCP_NODELAY enabled by default.

### 2. `@colyseus/ws-transport` uses `ws.WebSocketServer`

`node_modules/@colyseus/ws-transport/build/WebSocketTransport.js:58`:

```js
this.wss = new import_ws.WebSocketServer(options);
```

No override of socket options visible in the transport layer.

### 3. Runtime confirmation — boot smoke

After applying belt-and-braces `httpServer.on('connection', (socket) => { socket.setNoDelay(true); ... })` in `src/server/index.ts:159-178` and triggering a `curl localhost:2567/healthz`:

```
[19:29:52.618] INFO (server/20196): TCP_NODELAY applied to first inbound connection
    kind: "tcp_nodelay_first_connection"
```

Belt-and-braces call succeeds without error. Note: Node's `net.Socket` exposes `setNoDelay()` (setter) but no public getter for the current state, so we can only confirm the call ran — not read back the value.

## Conclusion

Hostile review #1 (TCP_NODELAY assumption not verified) is RESOLVED. Nagle's algorithm is not the cause of the 200-500 ms snapshot gaps observed in captures `5vjj4e` and `g6l26y`. The diagnosis of TCP retransmit + receiver-side head-of-line blocking under WiFi packet loss stands.

The explicit `setNoDelay(true)` in `src/server/index.ts` is kept as belt-and-braces — guards against any future `ws` library version that drops the default, and provides a single `tcp_nodelay_first_connection` log entry per server boot so future phone captures contain runtime confirmation.

## Phase -1 exit gate: PASS — proceed to Phase 0 (node-datachannel spike).
