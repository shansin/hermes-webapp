/**
 * The thing that keeps one bad field from taking the whole app down.
 *
 * Three times now a render-time `TypeError` has blanked every screen in this
 * app rather than the section it came from: a skill whose `category` was null,
 * a Board health payload missing a key, and a kanban card whose
 * `warnings.kinds` was a map where the type said list. In each case the app
 * showed a white page with no route, no nav and no way back — because with no
 * boundary anywhere above `<Routes>`, React's response to a throw during
 * render is to unmount the entire tree.
 *
 * That is a much worse failure than the bug causing it. All three were cosmetic
 * at the point of the throw (a heading, a count, a tooltip) and total in
 * effect. The backend routes this app calls are undocumented, the shapes were
 * captured from live frames, and it runs against Hermes versions it was not
 * built against — so a payload this version does not expect is a normal event,
 * not a hypothetical, and it must cost one screen at most.
 *
 * Two placement decisions matter as much as the boundary:
 *
 * - It wraps the **routes only**, inside `app__body`. The connection banner,
 *   `NavDrawer`, `ApprovalSheet` and `ClarifySheet` stay outside it and stay
 *   mounted. That is deliberate: an approval or a clarify blocks the agent's
 *   turn until it is answered, so a crashed screen must not also strand the
 *   sheet that releases it.
 * - **The fallback has to carry its own way out.** The drawer's trigger is not
 *   in the app shell — every screen renders its own header, and that header is
 *   the thing that just stopped rendering. So on a phone a crashed screen
 *   leaves no menu button anywhere on the page, and a fallback saying "use the
 *   menu" names a control that is not there. The link out is a plain `href`
 *   rather than a router navigation: a full page load is the one recovery that
 *   cannot itself depend on the state that just threw.
 * - It is **keyed on the pathname** by its caller, so changing route remounts
 *   it. A boundary does not reset itself — without that key the first throw
 *   would pin the fallback over every other screen for the rest of the
 *   session, turning a one-screen bug back into a whole-app one by a different
 *   route.
 *
 * The fallback shows the error text on purpose. The user of this app is the
 * person who can fix it, and "something went wrong" would mean going to the
 * browser console on a phone to learn anything at all.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Where the throw happened, for the log line. */
  where?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only record: there is no error reporting service here
    // and the proxy never sees a render throw.
    console.error(`[${this.props.where ?? 'app'}] render failed`, error, info.componentStack);
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="screen">
        <div className="empty" role="alert">
          <div className="empty__icon">⚠️</div>
          <div className="empty__title">This screen hit an error</div>
          <p style={{ maxWidth: '32ch' }}>
            The rest of the app is fine. Reload the chat screen, or try this one again.
          </p>
          {/* Monospace and selectable: on a phone this is the only way to get
              the message off the device and into a bug report. */}
          <code
            style={{
              display: 'block',
              maxWidth: '100%',
              overflowX: 'auto',
              padding: 'var(--space-2)',
              borderRadius: 8,
              background: 'var(--surface-2, rgba(127,127,127,0.12))',
              color: 'var(--error)',
              fontSize: 'var(--type-body-sm)',
              textAlign: 'left',
              userSelect: 'text',
            }}
          >
            {error.message || String(error)}
          </code>
          {/* Worth offering: a transient shape — one bad row from one poll —
              usually renders on the next fetch. A permanent one simply throws
              again and lands back here, which costs nothing. */}
          <div className="btn-group">
            <button type="button" className="btn btn--sm" onClick={this.retry}>
              Try again
            </button>
            {/* A real navigation, not a router push: this screen's header — and
                with it the drawer's trigger — is exactly what failed to
                render, so there is no in-app control left to leave by. */}
            <a className="btn btn--sm btn--primary" href="/chat">
              Go to chat
            </a>
          </div>
        </div>
      </div>
    );
  }
}
