/**
 * The board's live-update stream.
 *
 * The kanban plugin keeps an append-only `task_events` table and exposes it as
 * `WS /api/plugins/kanban/events?since=<id>`: every 300ms it looks for rows past
 * the cursor and pushes `{events, cursor}` when there are any, sending nothing
 * at all when there are not. That is a much better signal than the ten-second
 * poll it sits next to — a card claimed, spawned, blocked or completed shows up
 * within a third of a second instead of averaging five seconds behind.
 *
 * **It does not replace the poll, and must not.** Three ordinary situations
 * leave this socket unavailable while the board is perfectly fine: a proxy
 * that predates the route in its upgrade allowlist, a Hermes whose kanban
 * plugin is older than the endpoint, and a network that will not carry a
 * WebSocket at all. In each the socket fails in a way indistinguishable from
 * the others, so the honest response is to stop trying and let the poll carry
 * on — which is why this hook *reports* whether it is live rather than taking
 * responsibility for freshness. `useBoard` slows its interval when it is and
 * keeps the fast one when it is not, the same bargain `useActivity` makes with
 * the gateway socket.
 *
 * Three details of the endpoint shape the implementation:
 *
 * - **The board is pinned at the handshake.** The plugin says so in as many
 *   words: changing boards mid-stream would mean reconciling two cursors, so
 *   the client opens a new socket instead. The effect is therefore keyed on the
 *   board and tears down on a change.
 * - **The cursor has to survive a reconnect.** `since` is seeded from the
 *   board's `latest_event_id` and then advanced from each frame, held in a ref.
 *   Re-seeding from the query on every reconnect would replay whatever arrived
 *   in between; starting from zero would replay the entire table, which on a
 *   busy board is thousands of rows and a full re-render for each.
 * - **A frame without `events` is not an event frame.** The proxy sends a JSON
 *   keepalive on this path — the socket is idle for long stretches and
 *   Cloudflare closes an idle proxied WebSocket at 100s — so anything lacking
 *   the key is skipped rather than parsed for meaning.
 *
 * And one invariant borrowed wholesale from `ws/client.ts`, for the same
 * reason: **a socket may only touch state while it is still the current one.**
 * A superseded socket's `onclose` firing after its replacement opened would
 * otherwise mark the hook dead while a perfectly good stream is running.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** How long to sit on a burst before refetching. One frame can carry 200 rows. */
const COALESCE_MS = 250;

/** Reconnect backoff, in milliseconds, then it stays at the last one. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];

/**
 * Consecutive failures before this gives up for good.
 *
 * A socket that cannot open is usually a socket that will never open here — an
 * older proxy, an older plugin, a network that blocks upgrades — and the poll
 * already covers it. Retrying forever would burn a phone's radio to add
 * nothing, so after this many tries the hook goes quiet and stays quiet until
 * the board changes or the screen is remounted.
 */
const MAX_ATTEMPTS = 5;

interface EventFrame {
  events?: { id: number; task_id: string; kind: string }[];
  cursor?: number;
}

export function useKanbanEvents(
  board: string | null,
  /** The board query's `latest_event_id`, used only to seed the cursor. */
  latestEventId: number | undefined,
  enabled: boolean,
): boolean {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);

  /**
   * The cursor, kept out of React state on purpose: it changes on every frame
   * and nothing renders from it, so putting it in state would re-render the
   * whole board for a value only this effect reads.
   */
  const cursor = useRef<number | null>(null);
  if (cursor.current === null && typeof latestEventId === 'number') {
    cursor.current = latestEventId;
  }

  // Seeding again for a different board: the cursors are per-board, and
  // carrying one across would ask for events from the wrong table's numbering.
  const seededFor = useRef<string | null>(board);
  if (seededFor.current !== board) {
    seededFor.current = board;
    cursor.current = typeof latestEventId === 'number' ? latestEventId : null;
  }

  useEffect(() => {
    if (!enabled) return;

    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let coalesce: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let closed = false;
    /** Tasks touched since the last refetch, so one burst costs one round trip. */
    const touched = new Set<string>();

    const flush = () => {
      coalesce = null;
      qc.invalidateQueries({ queryKey: ['kanban', board ?? null, 'board'] });
      for (const id of touched) {
        qc.invalidateQueries({ queryKey: ['kanban', board ?? null, 'task', id] });
      }
      touched.clear();
    };

    const open = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams();
      params.set('since', String(cursor.current ?? 0));
      if (board) params.set('board', board);
      const ws = new WebSocket(
        `${proto}//${location.host}/api/plugins/kanban/events?${params.toString()}`,
      );
      socket = ws;

      ws.onopen = () => {
        // A superseded socket opening late must not claim the hook.
        if (ws !== socket) return;
        attempts = 0;
        setLive(true);
      };

      ws.onmessage = (event) => {
        if (ws !== socket) return;
        let frame: EventFrame;
        try {
          frame = JSON.parse(String(event.data)) as EventFrame;
        } catch {
          // The keepalive is valid JSON, so this is a genuinely malformed
          // frame; dropping it is better than tearing down a live stream.
          return;
        }
        if (!Array.isArray(frame.events) || frame.events.length === 0) return;
        if (typeof frame.cursor === 'number') cursor.current = frame.cursor;
        for (const e of frame.events) if (e.task_id) touched.add(e.task_id);
        if (coalesce === null) coalesce = setTimeout(flush, COALESCE_MS);
      };

      const down = () => {
        if (ws !== socket) return;
        socket = null;
        setLive(false);
        if (closed) return;
        attempts += 1;
        if (attempts >= MAX_ATTEMPTS) return;
        retry = setTimeout(open, BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]);
      };

      ws.onclose = down;
      // `onerror` is always followed by `onclose`, so the retry is scheduled
      // once. Silent: a failure here is expected on any deployment without the
      // route, and the poll behind it means nothing is broken.
      ws.onerror = () => {};
    };

    open();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (coalesce) clearTimeout(coalesce);
      const sock = socket;
      socket = null;
      // `onclose` would otherwise fire during teardown and set state on an
      // unmounted component.
      if (sock) {
        sock.onclose = null;
        sock.onerror = null;
        sock.onmessage = null;
        sock.close();
      }
      setLive(false);
    };
  }, [board, enabled, qc]);

  return live;
}
