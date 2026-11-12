/**
 * A mermaid fence that is still being written stays code.
 *
 * The streaming tail re-renders its open block ten times a second. A mermaid
 * fence there used to become a diagram on every tick: the first one fetched
 * the ~900KB diagrams chunk mid-stream, and each later one queued another
 * `mermaid.render` of a half-written source — serialized inside mermaid, so
 * the backlog went on redrawing (and failing) after the reply had finished.
 * Nothing about that is visible in a test of the finished transcript, which
 * is why it is pinned here at both levels: `Markdown`'s flag, and the tail
 * actually setting it on the open block and only there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/components/chat/MermaidBlock', () => ({
  MermaidBlock: ({ source }: { source: string }) => <div data-testid="diagram">{source}</div>,
}));

/** What the tail reads from the store. */
const state = {
  streamingText: '',
  streamingReasoning: '',
  statusLine: '',
  thinkingHint: '',
  running: true,
  info: undefined,
};
vi.mock('../src/store/session', () => ({
  useSession: (pick: (s: unknown) => unknown) => pick(state),
}));
vi.mock('../src/store/ui', () => ({
  useUi: (pick: (s: unknown) => unknown) => pick({ showReasoning: false, theme: 'dark' }),
}));
// Every tick rendered, so the assertion sees the text it set.
vi.mock('../src/lib/useThrottled', () => ({ useThrottled: <T,>(v: T) => v }));
// The synchronous renderer, not the lazy wrapper's Suspense fallback.
vi.mock('../src/components/chat/MarkdownAsync', async () => ({
  Markdown: (await import('../src/components/chat/Markdown')).Markdown,
}));

import { Markdown } from '../src/components/chat/Markdown';
import { StreamingTail } from '../src/components/chat/StreamingTail';

afterEach(cleanup);

const FENCE = '```mermaid\ngraph TD\n  A --> B\n```';

function show(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe('Markdown streaming flag', () => {
  it('draws a finished message’s mermaid fence as a diagram', () => {
    show(<Markdown>{FENCE}</Markdown>);
    expect(screen.getAllByTestId('diagram')).toHaveLength(1);
  });

  it('shows the same fence as code while streaming', () => {
    const { container } = show(<Markdown streaming>{FENCE}</Markdown>);
    expect(screen.queryByTestId('diagram')).toBeNull();
    expect(container.querySelector('.code__head')?.textContent).toContain('mermaid');
    expect(container.querySelector('pre')?.textContent).toContain('A --> B');
  });
});

describe('StreamingTail', () => {
  it('does not draw an unclosed mermaid fence', () => {
    state.streamingText = 'Here is the flow:\n\n```mermaid\ngraph TD\n  A --> B';
    const { container } = show(<StreamingTail onGrow={() => {}} />);
    expect(screen.queryByTestId('diagram')).toBeNull();
    expect(container.textContent).toContain('A --> B');
  });

  it('draws a fence once it is closed and in the stable half', () => {
    state.streamingText = `Here is the flow:\n\n${FENCE}\n\nAnd then the expla`;
    show(<StreamingTail onGrow={() => {}} />);
    expect(screen.getAllByTestId('diagram')).toHaveLength(1);
  });
});
