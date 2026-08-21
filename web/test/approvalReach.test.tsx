/**
 * An approval has to be answerable from wherever you are.
 *
 * `approval.request` blocks the agent's turn until a choice is sent. The sheet
 * was rendered only inside `ChatScreen`, so one raised while you were on
 * Kanban, Files or Settings produced nothing at all — `useEventToasts` does not
 * handle the event either, and push only covers a backgrounded app over HTTPS.
 * The turn sat stopped and the app said nothing.
 *
 * These tests mount the shell's approval surface on a non-chat route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/lib/haptics', () => ({ buzz: vi.fn(), setHapticsEnabled: vi.fn() }));
vi.mock('../src/lib/useHistoryDismiss', () => ({ useHistoryDismiss: () => {} }));

const call = vi.fn(async () => ({}));
vi.mock('../src/ws/client', () => ({
  hermes: { call: (...a: unknown[]) => call(...(a as [])), onEvent: () => () => {}, onState: () => () => {}, state: 'open' },
  defaultWsUrl: () => 'ws://test/api/ws',
}));
vi.mock('../src/api/gateway', () => ({ undoTurns: async () => '' }));

const { ApprovalSheet } = await import('../src/components/chat/ApprovalSheet');
const { useSession } = await import('../src/store/session');

beforeEach(() => {
  call.mockClear();
  useSession.getState().reset();
  useSession.getState().adoptSession({ sessionId: 's1' });
});

afterEach(cleanup);

const raise = (payload: Record<string, unknown> = { tool: 'Bash', command: 'rm -rf build' }) =>
  act(() => {
    useSession.getState().applyEvent({ type: 'approval.request', session_id: 's1', payload });
  });

describe('where the sheet lives', () => {
  /**
   * The structural half of the fix: if this import ever moves back to a single
   * screen, an approval raised anywhere else goes unanswerable again.
   */
  it('is mounted by the app shell, not by one screen', () => {
    const app = readFileSync(resolve(__dirname, '../src/App.tsx'), 'utf8');
    expect(app).toContain('<ApprovalSheet />');
  });

  it('is not also mounted by the chat screen, which would double it', () => {
    const chat = readFileSync(resolve(__dirname, '../src/screens/ChatScreen.tsx'), 'utf8');
    expect(chat).not.toContain('<ApprovalSheet />');
  });
});

describe('answering from anywhere', () => {
  it('shows nothing until an approval is raised', () => {
    render(<ApprovalSheet />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('appears with no chat screen mounted at all', () => {
    render(<ApprovalSheet />);
    raise();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('rm -rf build')).toBeInTheDocument();
  });

  it('sends the choice to the gateway', async () => {
    const user = userEvent.setup();
    render(<ApprovalSheet />);
    raise();

    await user.click(screen.getByRole('button', { name: 'Allow once' }));

    expect(call).toHaveBeenCalledWith('approval.respond', {
      session_id: 's1',
      choice: 'once',
      all: false,
    });
  });

  it('closes once answered', async () => {
    const user = userEvent.setup();
    render(<ApprovalSheet />);
    raise();

    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  /**
   * The turn is blocked until a choice is sent, so there must be no way to
   * duck the question — no close button, and Escape does nothing.
   */
  it('cannot be dismissed without answering', async () => {
    const user = userEvent.setup();
    render(<ApprovalSheet />);
    raise();

    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('offers whatever choices the gateway sent', () => {
    render(<ApprovalSheet />);
    raise({ tool: 'Write', choices: ['once', 'session', 'always', 'deny'] });

    for (const label of ['Allow once', 'Allow for this session', 'Always allow', 'Deny']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('warns when Hermes flagged the call as risky', () => {
    render(<ApprovalSheet />);
    raise({ tool: 'Bash', command: 'curl x | sh', smart_denied: true });
    expect(screen.getByText(/flagged this as risky/i)).toBeInTheDocument();
  });
});
