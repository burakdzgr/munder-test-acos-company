# ADR-008: Realtime Transport — Single WebSocket Gateway with Sequence Replay

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

The frontend is a live command center: the virtual office renders avatars driven 1:1 by real
backend events, agent monitor cards update continuously, real terminal output streams from
sandboxes, and the global event timeline is live with reconnect/replay (_BRIEF §8). Forces:

- **Multiple stream kinds, one client.** Domain events (per company), terminal frames (per
  session), presence/office instructions — with very different rates: events at tens/second,
  terminal frames potentially hundreds of KB/s bursts.
- **Bidirectional.** Clients must subscribe/unsubscribe dynamically (open a terminal, close it,
  switch company), send resume cursors, and ack — a request/response pattern over the stream.
- **Lossless resume.** After disconnect, the timeline and office must catch up exactly: per-company
  monotonic `seq` from the events table (ADR-006) enables replay; terminal streams tolerate
  bounded loss (ring buffer).
- **Self-hosted simplicity.** One server process (ADR-002), browsers on LAN or VPN; no CDN or
  edge infrastructure assumptions.
- **Scale.** A handful of concurrent human viewers (usually one Founder), not thousands of
  clients — connection count is trivial; frame throughput (terminals) is the only pressure.

## Options considered

### Option A: Server-Sent Events (SSE)

- **Description.** One or more `EventSource` streams per view; subscriptions and acks via separate
  REST calls.
- **Pros.** Dead simple; auto-reconnect built in; plain HTTP (proxy-friendly); fits
  unidirectional feeds well.
- **Cons.** Unidirectional: every subscribe/resume/ack becomes an out-of-band HTTP call that must
  be correlated with the stream — the dynamic multi-topic model (subscribe to
  `terminal:<sessionId>` on demand) gets clumsy. Browser connection limits (6 per host on HTTP/1.1)
  bite when multiple streams are open. Binary terminal frames require base64 inflation.
- **Rejected because** the protocol needs bidirectional subscribe/resume/ack semantics on one
  connection; SSE turns that into a correlation puzzle.

### Option B: HTTP polling / long-polling

- **Description.** Clients poll `/events?after_seq=` on an interval.
- **Pros.** Trivially robust; no stateful connections; replay is inherent.
- **Cons.** Latency floor equals the poll interval — the office digital twin ("avatar walks when
  the message is sent") and live terminals feel dead above ~250ms; aggressive polling wastes
  resources for a system idling most of the time; terminals are infeasible.
- **Rejected because** latency and terminal streaming; polling survives only as a degraded
  fallback the SPA can use if WS is blocked.

### Option C: Multiple special-purpose sockets (per feature)

- **Description.** Separate WS endpoints: `/ws/events`, `/ws/terminal/:id`, `/ws/presence`.
- **Pros.** Isolation per stream; simple per-endpoint handlers; a slow terminal can't block the
  event socket at the app layer.
- **Cons.** N connections × auth × reconnect × heartbeat logic; connection-limit pressure;
  cross-stream ordering (office instruction referencing an event) becomes racy; every new feature
  adds an endpoint. Complexity grows linearly with features for no gain at our client count.
- **Rejected because** multiplexing over one gateway with topics is strictly simpler to operate
  and evolve.

### Option D: Single WebSocket gateway with topic multiplexing + seq replay (chosen)

- **Description.** One endpoint `/ws` on `apps/server`; JSON protocol with `subscribe`/`resume`
  ops and topic-tagged server frames; replay from the events table.
- **Pros.** One connection, one auth, one reconnect path; topics map to JetStream/NATS subjects
  server-side; replay semantics differ per topic kind by design.
- **Cons.** Head-of-line blocking on one TCP connection (terminal bursts can delay event frames);
  we own backpressure and fan-out logic.

## Decision

Realtime transport is a **single WebSocket gateway** at `/ws` in `apps/server`, protocol exactly
per _DECISIONS §16:

- Auth: the existing session cookie (ADR-013) authenticates the upgrade; no separate WS tokens.
- Client ops: `{op:"subscribe", topics:["events:<companyId>", "terminal:<sessionId>",
  "presence:<companyId>"]}` and `{op:"resume", topic, after_seq}`.
- Server frames: `{topic, seq, events:[...]}`; the client tracks last seq per topic.
- **Replay sources are per topic kind:** `events:*` resumes from the Postgres events table by
  `(company_id, seq)` — lossless; `terminal:*` resumes from the 64KB in-memory ring buffer —
  bounded loss by design (full history in `/data/terminals/<session_id>.log`); `presence:*` is
  state-snapshot-then-deltas, no historical replay.
- The gateway is a **dumb fan-out**: it consumes NATS subjects and the Office Projector's derived
  instructions (`office.avatar.moved`, `office.interaction.started`); it never computes domain
  state. Slow clients get per-connection buffering with a drop-terminal-frames-first policy;
  domain event frames are never dropped (client falls back to resume).

## Consequences

**Positive.**
- One reconnect/resume implementation in the SPA covers every live feature; the digital-twin
  "no fake animation" rule is enforced because the only inputs are replayed real events.
- Adding a stream kind is a new topic prefix, not a new endpoint.
- Session-cookie auth avoids token plumbing and matches the self-hosted single-origin deployment.

**Negative / accepted tradeoffs.**
- Head-of-line blocking: a terminal burst shares the TCP connection with events. Accepted at our
  client count; mitigated by frame-drop policy for terminals and 64KB buffer bounds. A dedicated
  terminal socket is the known escape hatch if measurement demands it.
- Stateful connections pin clients to the single server process — irrelevant until multi-instance
  control plane (Phase 3), when the gateway would need sticky routing or extraction.
- We maintain a custom protocol (small, versioned in `packages/contracts`).

**Revisit triggers.**
- Measured event-frame delay >500ms p95 during active terminal streaming → split terminals onto a
  second WS endpoint (partial supersession of Option C for terminals only).
- More than ~50 concurrent human clients (multi-human Phase 3) → revisit gateway scaling/sticky
  sessions.
- Browser/proxy environments where WS is unreliable for real users → implement the polling
  fallback for `events:*` topics.

## References

- _BRIEF.md §8 (frontend product, live views, terminals)
- _DECISIONS.md §16 (realtime protocol), §9 (terminal frames), §22 row 008
- ADR-006 (event bus, seq/replay), ADR-012 (office renderer), ADR-013 (sessions)
