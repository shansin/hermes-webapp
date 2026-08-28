/**
 * The boundary that scopes a render throw to one screen.
 *
 * Three shipped bugs in this app were cosmetic where they threw and total in
 * effect — a null skill `category`, a Board health payload missing a key, a
 * kanban card whose `warnings.kinds` was a map where the type said list. Each
 * blanked every screen, because React unmounts the whole tree when a render
 * throws with no boundary above it.
 *
 * What these tests pin is the part that is easy to get subtly wrong: not that
 * a fallback appears, but that the app is still *usable* around it and that
 * the fallback does not outlive the screen that caused it.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { ErrorBoundary } from '../src/components/shared/ErrorBoundary';

/** React logs the caught error itself; the noise would drown the run. */
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  spy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  spy.mockRestore();
  cleanup();
});

function Boom({ message = 'kinds.join is not a function' }: { message?: string }): never {
  throw new TypeError(message);
}

describe('ErrorBoundary', () => {
  it('renders the fallback instead of unmounting the tree', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/This screen hit an error/)).toBeTruthy();
  });

  /*
   * The drawer's trigger lives in each screen's header, which is precisely what
   * stopped rendering — so on a phone a crashed screen has no menu button
   * anywhere on the page. Without a link in the fallback itself the user is
   * stranded, which is how a contained failure becomes a whole-app one again.
   */
  it('offers a way out, since the crashed header held the only menu button', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const out = screen.getByText('Go to chat');
    // A real navigation: a router push would depend on the tree that threw.
    expect(out.getAttribute('href')).toBe('/chat');
  });

  it('shows the message, which on a phone is the only way to read it', () => {
    render(
      <ErrorBoundary>
        <Boom message="warnings.kinds.join is not a function" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('warnings.kinds.join is not a function')).toBeTruthy();
  });

  /*
   * The whole point of the placement. A throw inside the routes must leave the
   * drawer and the approval/clarify sheets mounted — an approval blocks the
   * agent's turn until answered, so a crashed screen stranding it would turn a
   * cosmetic bug into a stuck agent.
   */
  it('leaves siblings outside it mounted', () => {
    render(
      <div>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
        <div data-testid="shell">nav + approval sheet</div>
      </div>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByTestId('shell')).toBeTruthy();
  });

  it('passes children through untouched when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div data-testid="ok">board</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('ok')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /*
   * A boundary never resets itself. `App` keys it on the pathname so navigating
   * remounts it — without that, the first throw pins its fallback over every
   * other route for the rest of the session, which is the same whole-app
   * failure arriving by a different road.
   */
  it('a new key remounts it, so navigating away clears the fallback', () => {
    function Harness() {
      const [path, setPath] = useState('/kanban');
      return (
        <>
          <button onClick={() => setPath('/chat')}>go</button>
          <ErrorBoundary key={path}>
            {path === '/kanban' ? <Boom /> : <div data-testid="chat">chat</div>}
          </ErrorBoundary>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.click(screen.getByText('go'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('chat')).toBeTruthy();
  });

  it('Try again re-renders, so a transient bad payload recovers in place', () => {
    let fail = true;
    function Flaky() {
      if (fail) throw new TypeError('one bad row');
      return <div data-testid="recovered">board</div>;
    }
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    fail = false;
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByTestId('recovered')).toBeTruthy();
  });

  it('a still-broken screen lands back on the fallback rather than escaping', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
