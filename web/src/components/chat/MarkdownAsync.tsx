/**
 * `Markdown`, split out of the initial download.
 *
 * The rendering pipeline — react-markdown, remark-gfm, highlight.js and their
 * shared unified machinery — is the largest thing the chat screen pulls in,
 * and chat is the landing route, so it was landing in the entry chunk and
 * delaying first paint on a phone.
 *
 * While the chunk is in flight the raw text renders as-is. Markdown degrades
 * into something readable on its own, so the fallback looks like the message
 * rather than like a loading state, and the swap is usually invisible: the
 * chunk is warmed on app start (see `preloadMarkdown`) and the socket takes
 * longer to connect than the chunk takes to arrive.
 */
import { Suspense, lazy } from 'react';

const MarkdownImpl = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })));

/**
 * Start fetching the markdown chunk without blocking on it. Called once the
 * app shell is up, so the cost is paid during connection setup rather than on
 * the first message.
 */
export function preloadMarkdown(): void {
  void import('./Markdown');
}

export function Markdown({ children }: { children: string }) {
  return (
    <Suspense fallback={<div className="md md--plain">{children}</div>}>
      <MarkdownImpl>{children}</MarkdownImpl>
    </Suspense>
  );
}
