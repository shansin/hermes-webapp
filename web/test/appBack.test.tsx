/**
 * What "back" resolves to.
 *
 * The failure this guards is silent in both directions and only on a real
 * device: a back button that walks out of the app (or, in a `standalone`
 * install, does nothing visible at all) because the screen was reached by a
 * redirect, and a back button pinned to `/chat` that ignores where you
 * actually came from. Neither shows up in a render test, and neither is
 * something anyone reports precisely enough to find.
 *
 * The check is on `history.state.idx` — React Router's own stack depth — and
 * the whole point of choosing it over `location.key === 'default'` is that a
 * `replace` leaves it alone. So the redirect cases are the ones tested hardest.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { canGoBack } from '../src/lib/useAppBack';
import { BackButton } from '../src/components/shared/BackButton';

/** Put React Router's bookkeeping into `history.state`, as the DOM router does. */
function setIdx(idx: number | undefined) {
  window.history.replaceState(idx === undefined ? {} : { idx, key: 'k' }, '');
}

beforeEach(() => {
  setIdx(undefined);
});

// This project does not enable RTL's global auto-cleanup.
afterEach(cleanup);

describe('canGoBack', () => {
  it('is false at the bottom of the stack', () => {
    setIdx(0);
    expect(canGoBack()).toBe(false);
  });

  it('is true once anything has been pushed', () => {
    setIdx(1);
    expect(canGoBack()).toBe(true);
  });

  it('is false when there is no router state at all', () => {
    // A cold load, or any host that has not yet written its bookkeeping.
    // Guessing "yes" here is what sends `navigate(-1)` out of the app.
    expect(canGoBack()).toBe(false);
  });

  it('ignores a key without an index', () => {
    // The shape `location.key === "default"` used to be read from. A redirect
    // mints a fresh key while leaving the stack exactly as short as it was, so
    // a key alone can never answer this question.
    window.history.replaceState({ key: 'fresh-after-redirect' }, '');
    expect(canGoBack()).toBe(false);
  });

  it('is not fooled by a non-numeric index', () => {
    window.history.replaceState({ idx: '3' }, '');
    expect(canGoBack()).toBe(false);
  });
});

/** Renders the current path so a test can assert where a press landed. */
function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function app(initial: string[]) {
  return render(
    <MemoryRouter initialEntries={initial}>
      <BackButton />
      <Where />
      <Routes>
        <Route path="/chat" element={null} />
        <Route path="/models" element={null} />
        <Route path="/usage" element={<Navigate to="/models" replace />} />
        <Route path="/settings" element={null} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BackButton', () => {
  it('goes back when there is history behind it', async () => {
    setIdx(2);
    const back = vi.spyOn(window.history, 'back');
    app(['/chat', '/models']);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    // MemoryRouter pops its own stack rather than the DOM's, so the assertion
    // that matters is where we ended up, not that `history.back` fired.
    expect(screen.getByTestId('where').textContent).toBe('/chat');
    back.mockRestore();
  });

  it('falls back to chat when this screen is the entry point', async () => {
    setIdx(0);
    app(['/settings']);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('where').textContent).toBe('/chat');
  });

  it('falls back to chat when a redirect was the entry point', async () => {
    // `/usage` → `/models` replaces the entry: a fresh location key, the same
    // stack depth. Going "back" from here must not leave the app.
    setIdx(0);
    app(['/usage']);
    expect(screen.getByTestId('where').textContent).toBe('/models');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('where').textContent).toBe('/chat');
  });

  it('honours an explicit override instead of navigating', async () => {
    // Files uses this to go up a directory while staying on the screen.
    setIdx(3);
    const onBack = vi.fn();
    render(
      <MemoryRouter initialEntries={['/files']}>
        <BackButton label="Up one directory" onBack={onBack} />
        <Where />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Up one directory' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('where').textContent).toBe('/files');
  });
});
