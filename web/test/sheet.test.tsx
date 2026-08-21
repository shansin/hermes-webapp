/**
 * The bottom sheet's modal contract.
 *
 * `aria-modal="true"` is a promise that the rest of the page is inert, and the
 * sheet made that promise without keeping it: focus stayed behind it, so a
 * keyboard walked the screen underneath while a supposedly exclusive modal sat
 * on top. That is worst on the approval sheet, which is deliberately
 * non-dismissible — the one sheet you *must* answer was the one you could tab
 * straight past.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sheet } from '../src/components/shared/Sheet';

vi.mock('../src/lib/haptics', () => ({ buzz: vi.fn(), setHapticsEnabled: vi.fn() }));
vi.mock('../src/lib/useHistoryDismiss', () => ({ useHistoryDismiss: () => {} }));

afterEach(cleanup);

const open = (props: Partial<React.ComponentProps<typeof Sheet>> = {}) =>
  render(
    <>
      <button>behind the sheet</button>
      <Sheet open title="Pick a model" onClose={props.onClose ?? (() => {})} {...props}>
        <button>first</button>
        <button>second</button>
      </Sheet>
    </>,
  );

describe('labelling', () => {
  it('announces itself by its own heading rather than as "dialog"', () => {
    open();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Pick a model');
  });

  it('is still a dialog with no title', () => {
    render(
      <Sheet open onClose={() => {}}>
        <button>only</button>
      </Sheet>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('focus', () => {
  /**
   * The content, not the close button — which is the first focusable in DOM
   * order and the last thing anyone opening a sheet wants to be handed.
   */
  it('moves into the sheet body on open', async () => {
    open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'first' })).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus();
  });

  it('falls back to the panel when the sheet holds no control', async () => {
    render(
      <Sheet open onClose={() => {}} dismissible={false}>
        <p>nothing to focus</p>
      </Sheet>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus());
  });

  it('wraps forward at the end rather than escaping behind', async () => {
    const user = userEvent.setup();
    open({ dismissible: false });
    await waitFor(() => expect(screen.getByRole('button', { name: 'first' })).toHaveFocus());

    await user.tab();
    expect(screen.getByRole('button', { name: 'second' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'behind the sheet' })).not.toHaveFocus();
  });

  it('wraps backward at the start', async () => {
    const user = userEvent.setup();
    open({ dismissible: false });
    await waitFor(() => expect(screen.getByRole('button', { name: 'first' })).toHaveFocus());

    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'second' })).toHaveFocus();
  });

  /**
   * The close button is part of the sheet, so a dismissible one has three stops
   * rather than two — and the trap has to include it.
   */
  it('keeps the close button inside the trap', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'first' })).toHaveFocus());

    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('returns focus to whatever opened it', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(
      <Sheet open title="Sheet" onClose={() => {}}>
        <button>inside</button>
      </Sheet>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'inside' })).toHaveFocus());

    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

describe('dismissing', () => {
  it('closes on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    open({ onClose });

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  /**
   * A sheet that demands an explicit choice opts out of every escape hatch —
   * that is the whole reason it has no close button.
   */
  it('ignores Escape when a choice is required', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    open({ onClose, dismissible: false });

    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers no close button when a choice is required', () => {
    open({ dismissible: false });
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });
});
