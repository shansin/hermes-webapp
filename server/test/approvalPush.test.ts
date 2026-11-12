/**
 * Answering an approval from the lock screen.
 *
 * Three hops, each of which fails silently from the phone: the sweep has to
 * tell an approval apart from any other wait (only an approval gets buttons,
 * and the buttons must carry the request they answer); the route has to
 * accept only the two safe answers; and the answer has to reach the agent
 * through `approval.respond` over the listener's socket, addressed by the
 * session's live handle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hermes-approval-'));

vi.mock('../src/config.js', () => ({
  stateDir: dir,
  getToken: () => 'tok',
  resolveToken: async () => 'tok',
  clearToken: vi.fn(),
  upstreamHttp: 'http://127.0.0.1:9119',
  upstreamHost: '127.0.0.1:9119',
  config: { PUSH_ENABLED: true, VAPID_SUBJECT: 'mailto:test@localhost' },
}));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendPush = vi.fn(async () => 1);
vi.mock('../src/push/send.js', () => ({
  sendPush: (m: unknown) => sendPush(m as never),
  pushPublicKey: () => 'key',
  pushEnabled: () => true,
}));
vi.mock('../src/push/store.js', () => ({
  listSubscriptions: () => [{ subscription: { endpoint: 'e' } }],
  removeSubscription: vi.fn(),
  saveSubscription: vi.fn(),
}));

/** The gateway socket, answered per method. */
let rpc: Record<string, unknown>;
const calls: { method: string; params: Record<string, unknown> }[] = [];
vi.mock('../src/push/rpc.js', () => ({
  callGateway: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return method in rpc ? rpc[method] : null;
  },
}));

type Sessions = typeof import('../src/push/sessions.js');
let sessions: Sessions;
let pushRouter: typeof import('../src/routers/push.js')['pushRouter'];

beforeEach(async () => {
  rmSync(join(dir, '.hermes-cron-feed.json'), { force: true });
  rpc = {};
  calls.length = 0;
  sendPush.mockClear();
  vi.resetModules();
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/sessions/s_1') {
      return new Response(JSON.stringify({ id: 's_1', profile: null }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(null, { status: 404 });
  });
  sessions = await import('../src/push/sessions.js');
  pushRouter = (await import('../src/routers/push.js')).pushRouter;
});

afterEach(() => sessions?.stopSessionSweep());

const row = (status: string) => ({
  id: 'a1b2c3d4',
  session_key: 's_1',
  title: 'Tidy the downloads folder',
  status,
  message_count: 4,
});

/** Seed idle, then move to waiting, so the second pass announces. */
async function goWaiting(): Promise<Record<string, unknown>> {
  rpc['session.active_list'] = { sessions: [row('idle')] };
  await sessions.reconcileSessions();
  rpc['session.active_list'] = { sessions: [row('waiting')] };
  await sessions.reconcileSessions();
  return sendPush.mock.calls.at(-1)![0] as unknown as Record<string, unknown>;
}

const post = (path: string, body: unknown) =>
  pushRouter.request(
    new Request(`http://proxy.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('the waiting banner', () => {
  it('carries Approve once / Deny and the request it answers when an approval is pending', async () => {
    rpc['approval.pending'] = {
      approvals: [{ request_id: 'r1', description: 'recursive delete', command: 'rm -rf ~/Downloads/*' }],
    };
    const push = await goWaiting();

    expect(calls.find((c) => c.method === 'approval.pending')?.params).toEqual({ session_id: 'a1b2c3d4' });
    expect(push).toMatchObject({
      kind: 'session.waiting',
      tag: 'attention:s_1',
      actions: [
        { action: 'approve', title: 'Approve once' },
        { action: 'deny', title: 'Deny' },
      ],
      approval: { sessionId: 's_1', requestId: 'r1' },
    });
    expect(push.body).toContain('recursive delete');
    // The command itself never reaches a lock screen — it is unredacted here.
    expect(push.body).not.toContain('rm -rf');
  });

  it('stays a plain banner when the wait is not an approval', async () => {
    rpc['approval.pending'] = { approvals: [] };
    const push = await goWaiting();

    expect(push.actions).toBeUndefined();
    expect(push.approval).toBeUndefined();
    expect(push.body).toContain('waiting for an answer');
  });

  it('stays a plain banner when the socket cannot say', async () => {
    const push = await goWaiting();
    expect(push.actions).toBeUndefined();
  });
});

describe('POST /push/approval/:sessionId', () => {
  it('answers through approval.respond, addressed by the live handle', async () => {
    rpc['session.active_list'] = { sessions: [row('waiting')] };
    rpc['approval.respond'] = { resolved: 1 };

    const res = await post('/push/approval/s_1', { choice: 'once', requestId: 'r1' });

    expect(res.status).toBe(200);
    expect(calls.find((c) => c.method === 'approval.respond')?.params).toEqual({
      session_id: 'a1b2c3d4',
      choice: 'once',
      all: false,
      request_id: 'r1',
    });
  });

  it('falls back to the stored key when the session has no live handle', async () => {
    rpc['session.active_list'] = { sessions: [] };
    rpc['approval.respond'] = { resolved: 1 };

    await post('/push/approval/s_1', { choice: 'deny' });

    expect(calls.find((c) => c.method === 'approval.respond')?.params).toEqual({
      session_id: 's_1',
      choice: 'deny',
      all: false,
    });
  });

  it.each(['session', 'always', '', 'yes'])('refuses %j — only the two banner answers', async (choice) => {
    const res = await post('/push/approval/s_1', { choice });
    expect(res.status).toBe(400);
    expect(calls.some((c) => c.method === 'approval.respond')).toBe(false);
  });

  it('answers 409 when nothing was left to resolve', async () => {
    rpc['approval.respond'] = { resolved: 0 };
    const res = await post('/push/approval/s_1', { choice: 'once' });
    expect(res.status).toBe(409);
  });

  it('answers 503 when the backend cannot be asked', async () => {
    const res = await post('/push/approval/s_1', { choice: 'once' });
    expect(res.status).toBe(503);
  });

  /* The worker already closed the banner the press came from; a "No longer
     waiting" one replacing it would report the user's own decision back. */
  it('does not send a retraction for a wait answered from the banner', async () => {
    rpc['approval.pending'] = { approvals: [{ request_id: 'r1' }] };
    await goWaiting();
    sendPush.mockClear();

    rpc['approval.respond'] = { resolved: 1 };
    await post('/push/approval/s_1', { choice: 'once', requestId: 'r1' });

    rpc['session.active_list'] = { sessions: [row('working')] };
    await sessions.reconcileSessions();

    expect(sendPush).not.toHaveBeenCalled();
  });
});
