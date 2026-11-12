/**
 * Find-in-transcript: the query, the hits, and which one is current.
 *
 * Split out of `MessageList` with its behaviour unchanged. It is one of the
 * list's three mutually exclusive modes (reading, searching, selecting) and
 * shares nothing with the other two except the message→element map it
 * scrolls through, which the list owns and passes in.
 */
import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import type { ChatMessage } from '../../store/session';
import { buzz } from '../../lib/haptics';
import { useDebounced } from '../../lib/useDebounced';
import { messageText } from '../../lib/share';

/**
 * How long the find box must sit still before the transcript is filtered.
 * Matches the session list's search, which settles on the same budget.
 */
const SEARCH_DEBOUNCE_MS = 250;

export function useTranscriptSearch({
  searchOpen,
  messages,
  nodes,
  onCloseSearch,
}: {
  searchOpen: boolean;
  messages: ChatMessage[];
  /** Message id → its element, for scrolling to the current hit. */
  nodes: RefObject<Map<string, HTMLDivElement>>;
  onCloseSearch: () => void;
}) {
  const [query, setQuery] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);

  /**
   * Search on the settled value. The raw one still drives the input, so typing
   * stays responsive — but every keystroke was otherwise a full rescan of the
   * transcript *and* a re-render of the filtered list, on the screen where the
   * transcript is by definition long enough to need searching.
   *
   * `filtering` below keys off this too, so the list and the match count flip
   * together instead of showing "no matches" for a beat on every character.
   */
  const settledQuery = useDebounced(query, SEARCH_DEBOUNCE_MS);

  /**
   * The transcript, lowercased once. Rebuilt when the messages change rather
   * than when the query does, so stepping through a search doesn't re-case
   * every message; built only while the search bar is open, so a conversation
   * that is never searched never pays for it or holds the second copy.
   */
  const haystack = useMemo(
    () => (searchOpen ? messages.map((m) => ({ id: m.id, text: messageText(m).toLowerCase() })) : null),
    [searchOpen, messages],
  );

  const matches = useMemo(() => {
    const q = settledQuery.trim().toLowerCase();
    if (!q || !haystack) return [];
    return haystack.filter((h) => h.text.includes(q)).map((h) => h.id);
  }, [haystack, settledQuery]);

  /**
   * The same ids as a set. Every row asks "am I a match" on every render, and
   * an array scan there is quadratic in the transcript length — on the one
   * screen where the transcript is already long enough to need searching.
   */
  const matchSet = useMemo(() => new Set(matches), [matches]);

  // A new query starts from the top rather than keeping a position that meant
  // something about the previous set of hits. Keyed on the settled value, so
  // the reset lands with the match set it belongs to.
  useEffect(() => {
    setMatchIdx(0);
  }, [settledQuery]);

  const currentMatch = matches[matchIdx] ?? null;

  // Bring the active hit into view. `center` rather than the default, so a
  // match near the bottom doesn't end up under the composer.
  useEffect(() => {
    if (!currentMatch) return;
    nodes.current.get(currentMatch)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentMatch, nodes]);

  const stepMatch = useCallback(
    (delta: number) => {
      if (matches.length === 0) return;
      buzz('tap');
      setMatchIdx((i) => (i + delta + matches.length) % matches.length);
    },
    [matches.length],
  );

  // Closing search must not leave the transcript filtered by a stale query.
  const closeSearch = useCallback(() => {
    setQuery('');
    onCloseSearch();
  }, [onCloseSearch]);

  // Searching hides everything that doesn't match: on a phone a filtered list
  // beats hunting for highlighted bubbles in a wall of text.
  const filtering = searchOpen && settledQuery.trim().length > 0;

  return {
    query,
    setQuery,
    settledQuery,
    matches,
    matchSet,
    matchIdx,
    currentMatch,
    stepMatch,
    closeSearch,
    filtering,
  };
}
