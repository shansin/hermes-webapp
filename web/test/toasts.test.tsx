/**
 * The toast surface.
 *
 * This is where a failed send, a rejected rename and a cron run that failed
 * while you were on another screen all land — and it was a `div` with a click
 * handler and no live region, so none of it reached a screen reader and none of
 * it could be dismissed without a pointer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toasts } from '../src/components/shared/misc';
import { useUi } from '../src/store/ui';

vi.mock('../src/lib/haptics', () => ({ buzz: vi.fn(), setHapticsEnabled: vi.fn() }));

beforeEach(() => {
  useUi.setState({ toasts: [] });
});

afterEach(cleanup);

/** Zustand updates outside React's batching need flushing before assertions. */
const push = (text: string, tone: 'info' | 'success' | 'warn' | 'error' = 'info', opts = {}) =>
  act(() => {
    useUi.getState().toast(text, tone, opts);
  });

describe('announcement', () => {
  it('announces ordinary feedback politely', () => {
    render(<Toasts />);
    push('Session renamed', 'success');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  /** An error interrupts what someone is doing; it should not wait for a gap. */
  it('announces an error assertively', () => {
    render(<Toasts />);
    push('Could not reach Hermes', 'error');
    const region = screen.getByRole('alert');
    expect(region).toHaveAttribute('aria-live', 'assertive');
    expect(region).toHaveTextContent('Could not reach Hermes');
  });

  /**
   * The region has to exist before the toast does, or the first announcement
   * of a fresh page load is inserted along with its own container and missed.
   */
  it('keeps the live region mounted while empty', () => {
    render(<Toasts />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('dismissing', () => {
  it('is a button, so a keyboard can reach it', async () => {
    const user = userEvent.setup();
    render(<Toasts />);
    push('Copied');

    const toast = screen.getByRole('button', { name: /Copied/ });
    await user.click(toast);
    expect(useUi.getState().toasts).toEqual([]);
  });

  it('says that tapping dismisses', () => {
    render(<Toasts />);
    push('Copied');
    expect(screen.getByRole('button', { name: 'Copied. Dismiss' })).toBeInTheDocument();
  });
});

describe('the undo offer', () => {
  it('renders an action when one is given', () => {
    render(<Toasts />);
    push('Session deleted', 'success', { action: { label: 'Undo', onAction: vi.fn() } });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('runs the action and clears the toast', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<Toasts />);
    push('Session deleted', 'success', { action: { label: 'Undo', onAction } });

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(onAction).toHaveBeenCalledOnce();
    expect(useUi.getState().toasts).toEqual([]);
  });

  it('leaves ordinary toasts without one', () => {
    render(<Toasts />);
    push('Copied');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('stacks several without confusing their actions', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const user = userEvent.setup();
    render(<Toasts />);
    push('Deleted one', 'success', { action: { label: 'Undo', onAction: first } });
    push('Deleted two', 'success', { action: { label: 'Undo', onAction: second } });

    const undos = screen.getAllByRole('button', { name: 'Undo' });
    expect(undos).toHaveLength(2);

    await user.click(undos[1]!);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });
});
