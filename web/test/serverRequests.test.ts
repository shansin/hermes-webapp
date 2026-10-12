/**
 * Server→client requests: how Hermes asks a question.
 *
 * Approvals and clarify questions stopped being events. The backend sends a
 * JSON-RPC request (`{id: "srq-…", method, params}`) and blocks the agent
 * until a response frame with that id comes back — and only to a client that
 * opted in with `client.capabilities`. One that never did has every such
 * request withdrawn on the spot, which is what this app did for weeks: the
 * agent logged "approval was withdrawn", the phone showed nothing, and every
 * screen looked healthy. Nothing about that is visible from inside the app,
 * which is why each half of it is pinned here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesClient, type ServerRequest } from '../src/ws/client';
import { MockSocket, installMockSocket } from './helpers/mockSocket';

vi.mock('../src/lib/accessSession', () => ({ probeAccess: vi.fn(async () => false), markHostReached: vi.fn() }));

let restore: () => void;
let client: HermesClient;

beforeEach(() => {
  restore = installMockSocket();
  client = new HermesClient('ws://test/api/ws');
});

afterEach(() => restore());

function connected(): MockSocket {
  client.connect();
  const socket = MockSocket.last;
  socket.open();
  return socket;
}

const sentFrames = (socket: MockSocket) => socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
const ready = { jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } };
const approvalFrame = {
  jsonrpc: '2.0',
  id: 'srq-abc123',
  method: 'approval',
  params: { session_id: 's1', request_id: 'a1', command: 'rm -rf build', choices: ['once', 'deny'] },
};

describe('opting in', () => {
  it('advertises server requests on gateway.ready', () => {
    const socket = connected();
    socket.deliverJson(ready);

    expect(socket.lastSent()).toMatchObject({
      method: 'client.capabilities',
      params: { server_requests: true },
    });
  });

  /** The backend records the opt-in per connection, so a reconnect has to repeat it. */
  it('advertises again on every new connection', () => {
    const first = connected();
    first.deliverJson(ready);
    first.drop();
    client.connect();
    const second = MockSocket.last;
    second.open();
    second.deliverJson(ready);

    expect(sentFrames(second).filter((f) => f.method === 'client.capabilities')).toHaveLength(1);
  });
});

describe('routing a request', () => {
  it('hands it to a handler and sends the response under the same id', () => {
    const socket = connected();
    let got: ServerRequest | undefined;
    client.onRequest((req) => {
      got = req;
    });
    socket.deliverJson(approvalFrame);

    expect(got?.method).toBe('approval');
    expect(got?.params.command).toBe('rm -rf build');
    expect(got?.respond({ choice: 'once', all: false })).toBe(true);
    expect(socket.lastSent()).toEqual({ jsonrpc: '2.0', id: 'srq-abc123', result: { choice: 'once', all: false } });
  });

  /**
   * Without the request check ahead of it, the response path looks the string
   * id up among our own calls, finds nothing, and drops the frame silently.
   */
  it('is not mistaken for a response to one of our calls', () => {
    const socket = connected();
    const handler = vi.fn(() => true);
    client.onRequest(handler);
    socket.deliverJson(approvalFrame);

    expect(handler).toHaveBeenCalledOnce();
  });

  /** Declining fast is what stops the agent waiting out a minutes-long deadline. */
  it('answers -32601 when no handler takes it', () => {
    const socket = connected();
    client.onRequest(() => false);
    socket.deliverJson({ jsonrpc: '2.0', id: 'srq-x', method: 'sudo', params: { session_id: 's1' } });

    expect(socket.lastSent()).toMatchObject({ id: 'srq-x', error: { code: -32601 } });
  });

  it('answers -32603 when a handler throws', () => {
    const socket = connected();
    client.onRequest(() => {
      throw new Error('boom');
    });
    socket.deliverJson(approvalFrame);

    expect(socket.lastSent()).toMatchObject({ id: 'srq-abc123', error: { code: -32603 } });
  });

  it('sends at most one response', () => {
    const socket = connected();
    let got: ServerRequest | undefined;
    client.onRequest((req) => {
      got = req;
    });
    socket.deliverJson(approvalFrame);
    got!.respond({ choice: 'once' });
    got!.respond({ choice: 'deny' });

    expect(sentFrames(socket).filter((f) => f.id === 'srq-abc123')).toHaveLength(1);
  });

  /**
   * The ownership rule every handler in the client follows: a socket that has
   * been replaced must not act. Here it would answer on a connection the
   * backend no longer correlates — and `false` is what tells the store to
   * fall back to `request.answer` on the live one.
   */
  it('refuses to answer on a socket that has been superseded', () => {
    const first = connected();
    let got: ServerRequest | undefined;
    client.onRequest((req) => {
      got = req;
    });
    first.deliverJson(approvalFrame);
    first.drop();
    client.connect();
    MockSocket.last.open();

    expect(got!.respond({ choice: 'once' })).toBe(false);
    expect(sentFrames(first).some((f) => f.id === 'srq-abc123')).toBe(false);
  });
});

describe('open requests on resume', () => {
  /**
   * A question raised while the phone was away is not in the event replay —
   * it comes back in the resume's `open_requests`, and has to reach the
   * handler before the caller sees the result.
   */
  it('re-delivers them, marked replayed, before the call resolves', async () => {
    const socket = connected();
    const order: string[] = [];
    client.onRequest((req) => {
      order.push(`request:${req.id}:${req.replayed}`);
    });
    const pending = client.call('session.resume', { session_id: 's1' }).then(() => order.push('resolved'));
    const { id } = socket.lastSent();
    socket.deliverJson({
      jsonrpc: '2.0',
      id,
      result: { session_id: 's1', open_requests: [{ id: 'srq-1', method: 'approval', params: { session_id: 's1' } }] },
    });
    await pending;

    expect(order).toEqual(['request:srq-1:true', 'resolved']);
  });
});
