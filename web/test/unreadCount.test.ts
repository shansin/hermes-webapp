/**
 * The count on the jump-to-bottom button.
 *
 * The badge exists for one situation — you scrolled up to read something while
 * the agent kept working — and its only job is to be believed. Every way it
 * can be wrong involves a transcript that did not simply grow, which is the
 * common case here rather than an exotic one: a rewind drops turns, an edit
 * replaces one, and every reconnect loads history over the top of whatever was
 * there. Measuring from a remembered *length* would read each of those as a
 * burst of new messages and put a double-digit badge on a conversation that
 * just got shorter.
 *
 * So the anchor is an id, and an id that is gone counts nothing. That is a
 * deliberate undercount, and this file is mostly about pinning it: a badge
 * that occasionally says less than it could is survivable, one that invents
 * arrivals is not, and after the first bogus 12 nobody reads it again.
 */
import { describe, expect, it } from 'vitest';
import { unreadSince } from '../src/components/chat/MessageList';

const list = (...ids: string[]) => ids.map((id) => ({ id }));

describe('unreadSince', () => {
  it('counts what arrived after the anchor', () => {
    expect(unreadSince(list('a', 'b', 'c', 'd'), 'b')).toBe(2);
  });

  it('is zero when the anchor is still the last message', () => {
    expect(unreadSince(list('a', 'b', 'c'), 'c')).toBe(0);
  });

  /* No anchor is the at-the-bottom state: nothing to be behind on. */
  it('is zero with no anchor', () => {
    expect(unreadSince(list('a', 'b'), null)).toBe(0);
  });

  /*
   * A rewind or an edit removes the anchor. The honest answer is "I no longer
   * know", and the badge's version of that is silence — not `messages.length`,
   * which is what a length-based count would produce here.
   */
  it('counts nothing when the anchor has been rewound away', () => {
    expect(unreadSince(list('a', 'b'), 'd')).toBe(0);
  });

  /*
   * The reconnect case, and the one that would be seen most. `loadHistory`
   * rebuilds the array with fresh ids, so nothing of the old one survives —
   * a length comparison would announce the entire transcript as unread.
   */
  it('counts nothing when history was reloaded under it', () => {
    expect(unreadSince(list('h1', 'h2', 'h3', 'h4', 'h5'), 'm7')).toBe(0);
  });

  it('never returns a negative count when the list shrank', () => {
    expect(unreadSince(list('a'), 'a')).toBe(0);
    expect(unreadSince([], 'a')).toBe(0);
  });

  /* One message is singular in the label, which is read off this number. */
  it('counts a single arrival as one', () => {
    expect(unreadSince(list('a', 'b'), 'a')).toBe(1);
  });

  /*
   * Ids are unique in the store (`nextId` is monotonic), but the lookup takes
   * the first match, so a duplicate would count from the older one — the
   * conservative direction if it ever happened.
   */
  it('measures from the first match', () => {
    expect(unreadSince(list('a', 'b', 'a', 'c'), 'a')).toBe(3);
  });
});
