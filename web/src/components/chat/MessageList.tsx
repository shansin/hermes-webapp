/**
 * The transcript.
 *
 * Auto-scroll rule: follow the tail only while the user is already near the
 * bottom. Scrolling up to read must never be yanked back by an incoming token
 * — instead a jump-to-bottom button appears.
 *
 * This renders messages directly rather than virtualizing: entries have wildly
 * variable height (code blocks, tool output), and measuring them costs more
 * than it saves at realistic transcript lengths. The tool/reasoning bodies are
 * individually capped and scrollable, which is what actually bounds the DOM.
 * Assistant replies are deliberately not clamped: the newest answer is the
 * thing you opened the app to read, and putting a "Show more" in front of it
 * charged a tap on every single turn to see what you already asked for.
 *
 * Three modes share this list, and they are mutually exclusive by design:
 * reading, searching (a query bar filters and steps between matches), and
 * selecting (long-press, then tap to build a range to copy or share).
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { splitAttachedImages } from '../../lib/localImages';
import { Link } from 'react-router-dom';
import { Markdown } from './MarkdownAsync';
import { ToolCallCard } from './ToolCallCard';
import { LiveDelegations } from './LiveDelegations';
import { ClarifyCard } from './ClarifyCard';
import { ThinkingBlock } from './ThinkingBlock';
import { SubagentCard } from './SubagentCard';
import { LocalImage } from './LocalImage';
import { EditTurnSheet } from './EditTurnSheet';
import { MessageActions } from './MessageActions';
import { ChatSearchBar } from './ChatSearchBar';
import { StreamingTail } from './StreamingTail';
import { RecentSessions } from './RecentSessions';
import {
  IconClose,
  IconDown,
  IconRefresh,
  IconSpeaker,
  IconStop,
  IconUp,
} from '../shared/Icons';
import { Empty, formatTokens } from '../shared/misc';
import { useSession, type ChatMessage, type MessageTime } from '../../store/session';
import { onSpeakingChange, speak, stopSpeaking } from '../../lib/audio';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';
import { useDebounced } from '../../lib/useDebounced';
import { useLongPress } from '../../lib/useLongPress';
import { chatToMarkdown, copyText, messageText, outcomeToast, shareText } from '../../lib/share';

const NEAR_BOTTOM_PX = 120;

/**
 * How many messages landed after `anchorId`.
 *
 * Pure and exported so it can be tested: every interesting case is a
 * transcript that did *not* simply grow, and all of them look plausible on
 * screen. A rewind, an edit or a reconnect's history load replaces the array
 * outright — a count remembered as a length would read that as a burst of
 * arrivals and put a double-digit badge on a conversation that just got
 * shorter. An anchor that is no longer present therefore counts nothing:
 * undercounting for one scroll is the better failure, because the badge's
 * only job is to be believed.
 */
export function unreadSince(messages: { id: string }[], anchorId: string | null): number {
  if (!anchorId) return 0;
  const idx = messages.findIndex((m) => m.id === anchorId);
  return idx < 0 ? 0 : messages.length - 1 - idx;
}

/**
 * How long the find box must sit still before the transcript is filtered.
 * Matches the session list's search, which settles on the same budget.
 */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Clock time for a message, or null when it isn't known.
 *
 * Restored history has no timestamps, so those messages simply don't get one —
 * see `MessageTime`. The full date lives in the title attribute.
 */
function Stamp({ at }: { at: MessageTime }) {
  if (at == null) return null;
  const d = new Date(at);
  return (
    <span title={d.toLocaleString()}>
      {d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}

/** Where a read-aloud request has got to. */
type VoicePhase = 'pending' | 'playing';

interface MessageListProps {
  searchOpen: boolean;
  onCloseSearch: () => void;
}

export function MessageList({ searchOpen, onCloseSearch }: MessageListProps) {
  const messages = useSession((s) => s.messages);
  const running = useSession((s) => s.running);
  const rewinding = useSession((s) => s.rewinding);
  const retryLast = useSession((s) => s.retryLast);
  const resendFailed = useSession((s) => s.resendFailed);
  const toast = useUi((s) => s.toast);

  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  /**
   * The last message present when the user scrolled away from the bottom, and
   * the thing the unread count is measured from.
   *
   * An **id** rather than a count, because the transcript is not append-only:
   * a rewind, an edit or a reconnect's history load replaces the array
   * outright, and a remembered length would read that as a burst of new
   * messages arriving. An id that is no longer in the list is simply a lost
   * anchor, which counts nothing — an undercount for one scroll is a far
   * better failure than a badge claiming twenty new messages on a transcript
   * that just got shorter.
   */
  const [anchorId, setAnchorId] = useState<string | null>(null);
  /**
   * Mirrors `stuck` for `followTail`, which must keep a stable identity: it is
   * handed to the streaming bubble, and a new function each render would make
   * memoizing that bubble pointless.
   */
  const stuckRef = useRef(true);
  /**
   * Latest messages for the effects that must not re-run when they change —
   * the anchor is taken at the moment of leaving the bottom, so that effect
   * keys on `stuck` alone.
   */
  const messagesRef = useRef<ChatMessage[]>([]);
  /** The user message whose bubble is showing its actions, if any. */
  const [openActions, setOpenActions] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  /** Message id → its element, for scrolling to a search hit or a turn. */
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const register = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  }, []);

  // --- search ------------------------------------------------------------
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
  }, [currentMatch]);

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

  // --- selection ---------------------------------------------------------
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const beginSelection = useCallback((id: string) => {
    buzz('approval');
    setSelecting(true);
    setSelected(new Set([id]));
    setOpenActions(null);
  }, []);

  const toggleSelected = useCallback((id: string) => {
    buzz('tap');
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const endSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  // Selection is over ids, but the export has to read in transcript order —
  // and a range shared out of order would be nonsense.
  const selectedMarkdown = useCallback(
    () => chatToMarkdown(messages.filter((m) => selected.has(m.id))),
    [messages, selected],
  );

  /**
   * Retry only makes sense on the newest reply — rerunning an older one would
   * silently discard everything after it, which is what edit is for.
   */
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.kind === 'assistant') return m.id;
      if (m?.kind === 'user') return null;
    }
    return null;
  }, [messages]);

  /**
   * The first message that carries a timestamp, when replayed history sits
   * above it. That boundary is where "restored" becomes "this session", and
   * without a marker the missing clock times above it just look broken.
   */
  const historyBoundary = useMemo(() => {
    for (let i = 1; i < messages.length; i++) {
      if (messages[i]!.at != null && messages[i - 1]!.at == null) return messages[i]!.id;
    }
    return null;
  }, [messages]);

  /** Every user turn, for the prev/next turn jumps. */
  const turnIds = useMemo(
    () => messages.filter((m) => m.kind === 'user').map((m) => m.id),
    [messages],
  );

  const onToggleActions = useCallback(
    (id: string) => setOpenActions((cur) => (cur === id ? null : id)),
    [],
  );

  const onEdit = useCallback((id: string, text: string) => {
    setOpenActions(null);
    setEditing({ id, text });
  }, []);

  const onResend = useCallback((id: string) => void resendFailed(id), [resendFailed]);

  const onRetry = useCallback(() => {
    buzz('tap');
    void retryLast();
  }, [retryLast]);

  /**
   * The message being read aloud, and how far along that is.
   *
   * `pending` covers the gap between the tap and the first sound: the TTS
   * round trip is a network request, and a button that stays on "Play" through
   * it reads as a tap that did nothing.
   *
   * Mirrored into a ref so the toggle below can stay a stable callback —
   * `MessageRow` is memoized, and a handler that changed identity every time
   * playback advanced would re-render the whole transcript.
   */
  const [voice, setVoice] = useState<{ id: string; phase: VoicePhase } | null>(null);
  const voiceRef = useRef<{ id: string; phase: VoicePhase } | null>(null);
  const setVoiceState = useCallback((v: { id: string; phase: VoicePhase } | null) => {
    voiceRef.current = v;
    setVoice(v);
  }, []);

  /**
   * Invalidates an in-flight start. Bumped on every tap, so a request that
   * comes back after the user changed their mind can tell it was superseded
   * and decline to claim the button.
   */
  const speakGen = useRef(0);

  // Playback also ends by itself, and the button has to follow it back. A stop
  // reported while we are still `pending` belongs to the *previous* clip —
  // `speak` tears the old one down before starting ours — so it must not clear
  // a request that hasn't begun yet.
  useEffect(
    () =>
      onSpeakingChange((on) => {
        if (!on && voiceRef.current?.phase === 'playing') setVoiceState(null);
      }),
    [setVoiceState],
  );

  const onSpeak = useCallback(
    async (id: string, text: string) => {
      // A second tap on the same message cancels, whether it is already
      // playing or still being fetched.
      if (voiceRef.current?.id === id) {
        speakGen.current++;
        stopSpeaking();
        setVoiceState(null);
        return;
      }

      const gen = ++speakGen.current;
      setVoiceState({ id, phase: 'pending' });
      try {
        await speak(text);
        if (speakGen.current !== gen) return;
        setVoiceState({ id, phase: 'playing' });
      } catch (e) {
        if (speakGen.current !== gen) return;
        setVoiceState(null);
        toast(e instanceof Error ? e.message : 'Speech unavailable', 'warn');
      }
    },
    [setVoiceState, toast],
  );

  // Searching hides everything that doesn't match: on a phone a filtered list
  // beats hunting for highlighted bubbles in a wall of text.
  const filtering = searchOpen && settledQuery.trim().length > 0;

  const isNearBottom = () => {
    const el = ref.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  /**
   * Follow the tail. Stable identity on purpose — the streaming bubble calls
   * this as it grows, which is what keeps the transcript itself out of the
   * per-token render path.
   */
  const followTail = useCallback(() => {
    if (stuckRef.current && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, []);

  // useLayoutEffect so the scroll lands in the same frame as the new content,
  // which avoids a visible jump when a turn finalizes.
  //
  // Suspended while filtering: a turn completing mid-search would otherwise
  // slam the list to the bottom and undo the scroll to the current hit.
  useLayoutEffect(() => {
    if (filtering) return;
    followTail();
  }, [messages, stuck, followTail, filtering]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const near = isNearBottom();
      stuckRef.current = near;
      setStuck(near);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const jump = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stuckRef.current = true;
    setStuck(true);
  };

  messagesRef.current = messages;

  /**
   * Take the anchor on the way up, drop it on the way back down.
   *
   * Keyed on `stuck` alone so it fires on the transition rather than on every
   * message: the whole point is what the transcript looked like at the moment
   * the user stopped following it.
   */
  useEffect(() => {
    setAnchorId(stuck ? null : (messagesRef.current.at(-1)?.id ?? null));
  }, [stuck]);

  /**
   * How much arrived while the user was reading further up.
   *
   * Counts *messages*, so a single reply still streaming reads as zero — it is
   * one message that has not landed yet, and counting its blocks would make
   * the badge climb through a turn and then drop. That case is carried by the
   * pulse instead, which says "something is happening down there" without
   * claiming a number it would have to take back.
   */
  const unread = useMemo(
    () => (stuck ? 0 : unreadSince(messages, anchorId)),
    [messages, anchorId, stuck],
  );

  /**
   * Jump to the previous/next user turn.
   *
   * "Where am I" is decided by what's on screen rather than a stored index, so
   * this stays correct after the user scrolls by hand — which, on a phone, is
   * how they got here.
   */
  const stepTurn = (delta: number) => {
    const el = ref.current;
    if (!el || turnIds.length === 0) return;
    buzz('tap');
    // Measured against the scroller's own box rather than `offsetTop`: the
    // list is not the offset parent, so those two numbers live in different
    // coordinate spaces and comparing them is wrong by a constant.
    const listTop = el.getBoundingClientRect().top;
    const offsets = turnIds.map((id) => {
      const node = nodes.current.get(id);
      return { id, y: node ? node.getBoundingClientRect().top - listTop : 0 };
    });
    // A few px of tolerance, or "previous" lands on the turn already pinned to
    // the top of the viewport and nothing appears to happen.
    const target =
      delta < 0
        ? [...offsets].reverse().find((o) => o.y < -8)
        : offsets.find((o) => o.y > 8);
    if (target) nodes.current.get(target.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  // Leaving the chat must not leave a voice reading into an empty room.
  useEffect(() => stopSpeaking, []);

  const empty = messages.length === 0 && !running;
  const visible = filtering ? messages.filter((m) => matchSet.has(m.id)) : messages;

  return (
    <>
      {searchOpen && (
        <ChatSearchBar
          query={query}
          onQuery={setQuery}
          count={matches.length}
          index={matches.length ? matchIdx : -1}
          onStep={stepMatch}
          onClose={closeSearch}
        />
      )}

      {selecting && (
        <div className="sel-bar">
          <button className="icon-btn" onClick={endSelection} aria-label="Cancel selection">
            <IconClose size={18} />
          </button>
          <span className="sel-bar__count">
            {selected.size} selected
          </span>
          <button
            className="chip"
            disabled={selected.size === 0}
            onClick={async () => {
              const ok = await copyText(selectedMarkdown());
              toast(ok ? 'Copied to clipboard' : 'Nothing could copy here', ok ? 'success' : 'error');
              if (ok) endSelection();
            }}
          >
            Copy
          </button>
          <button
            className="chip"
            disabled={selected.size === 0}
            onClick={async () => {
              const { text, tone } = outcomeToast(await shareText(selectedMarkdown(), 'Hem'));
              toast(text, tone);
              if (tone === 'success') endSelection();
            }}
          >
            Share
          </button>
        </div>
      )}

      <div className={`chat__list${selecting ? ' chat__list--selecting' : ''}`} ref={ref}>
        {empty && (
          <Empty
            icon="✦"
            title="Ready when you are"
            hint="Ask a question, or use a quick action below."
            action={<RecentSessions />}
          />
        )}

        {filtering && matches.length === 0 && (
          <div className="chat-search__none">No messages match “{settledQuery.trim()}”.</div>
        )}

        {visible.map((m) => (
          <MessageRow
            key={m.id}
            m={m}
            register={register}
            showDivider={!filtering && m.id === historyBoundary}
            isMatch={searchOpen && matchSet.has(m.id)}
            isCurrentMatch={m.id === currentMatch}
            selecting={selecting}
            isSelected={selected.has(m.id)}
            onBeginSelection={beginSelection}
            onToggleSelected={toggleSelected}
            openActions={openActions === m.id}
            onToggleActions={onToggleActions}
            onEdit={onEdit}
            onResend={onResend}
            isLastAssistant={m.id === lastAssistantId}
            running={running}
            rewinding={rewinding}
            onRetry={onRetry}
            onSpeak={onSpeak}
            voice={voice?.id === m.id ? voice.phase : null}
          />
        ))}

        {/* After the tail, not before: a background delegation outlives the
            turn that dispatched it, so this block is about what is still
            running now rather than part of any reply. Hidden while filtering,
            like everything else that is not a search hit. */}
        {!filtering && <StreamingTail onGrow={followTail} />}
        {!filtering && <LiveDelegations />}
      </div>

      {/* Turn navigation sits with jump-to-bottom rather than in the header:
          both are "move me through the transcript", and on a phone the thumb
          is already down here. */}
      {!selecting && !stuck && (
        <div className="chat-nav">
          {turnIds.length > 1 && (
            <>
              <button className="chat-nav__btn" onClick={() => stepTurn(-1)} aria-label="Previous turn">
                <IconUp size={17} />
              </button>
              <button className="chat-nav__btn" onClick={() => stepTurn(1)} aria-label="Next turn">
                <IconDown size={17} />
              </button>
            </>
          )}
          {/*
            * Two signals, and they are not the same claim. The badge is a
            * count of messages that landed while you were up here. The pulse
            * only says a turn is running below — no number, because a reply
            * mid-stream is one message that has not arrived yet.
            */}
          <button
            className={`jump-fab${unread ? ' jump-fab--unread' : ''}${
              running && !unread ? ' jump-fab--live' : ''
            }`}
            onClick={jump}
            aria-label={
              unread
                ? `Jump to latest, ${unread} new ${unread === 1 ? 'message' : 'messages'}`
                : running
                  ? 'Jump to latest, a reply is coming in'
                  : 'Jump to latest'
            }
          >
            <IconDown size={19} />
            {unread > 0 && (
              /* Capped so the badge stays a badge: a turn with a dozen tool
                 cards would otherwise widen the button mid-scroll. */
              <span className="jump-fab__badge" aria-hidden="true">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
        </div>
      )}

      <EditTurnSheet
        turn={editing}
        onClose={() => setEditing(null)}
        onSubmit={(text) => {
          const id = editing?.id;
          setEditing(null);
          if (id) void useSession.getState().editTurn(id, text);
        }}
      />
    </>
  );
}

interface RowProps {
  m: ChatMessage;
  register: (id: string, el: HTMLDivElement | null) => void;
  showDivider: boolean;
  isMatch: boolean;
  isCurrentMatch: boolean;
  selecting: boolean;
  isSelected: boolean;
  onBeginSelection: (id: string) => void;
  onToggleSelected: (id: string) => void;
  openActions: boolean;
  onToggleActions: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onResend: (id: string) => void;
  isLastAssistant: boolean;
  running: boolean;
  rewinding: boolean;
  onRetry: () => void;
  onSpeak: (id: string, text: string) => void;
  /** Read-aloud phase for this message, or null when it isn't the one. */
  voice: VoicePhase | null;
}

/**
 * One row of the transcript.
 *
 * Split out of the list body and memoized: the list now tracks search and
 * selection state that changes on every keystroke and every tap, and without
 * this each of those would re-render every bubble, tool card and thinking
 * block in the conversation.
 */
const MessageRow = memo(function MessageRow(p: RowProps) {
  const { m, selecting, isSelected, register } = p;
  const showReasoning = useUi((s) => s.showReasoning);

  const { handlers, consumed } = useLongPress(() => p.onBeginSelection(m.id));

  /**
   * Stable per row. As an inline arrow this was a new identity on every
   * render, so React tore the node out of the lookup map and put it back each
   * time the row re-rendered — for a ref whose target never actually changed.
   */
  const setNode = useCallback(
    (el: HTMLDivElement | null) => {
      register(m.id, el);
    },
    [register, m.id],
  );

  const cls = [
    'msg',
    m.kind === 'user' ? 'msg--user' : '',
    m.kind === 'assistant' ? 'msg--assistant' : '',
    p.isMatch ? 'msg--match' : '',
    p.isCurrentMatch ? 'msg--match-current' : '',
    isSelected ? 'msg--selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  /** In selection mode every row is a checkbox and nothing else responds. */
  const selectionProps = selecting
    ? {
        onClick: () => p.onToggleSelected(m.id),
        role: 'checkbox' as const,
        'aria-checked': isSelected,
        tabIndex: 0,
      }
    : {};

  const body = (() => {
    if (m.kind === 'user') {
      /**
       * An image you sent is persisted as an `@image:<path>` line appended to
       * your own message — Hermes' own directive form, which every client is
       * expected to lift out. Rendered raw it was a stray line of file path
       * under the caption, and the picture itself never appeared at all.
       */
      const { text: caption, images } = splitAttachedImages(m.displayText ?? m.text);
      const label = caption || (images.length === 1 ? '1 image' : `${images.length} images`);

      return (
        <>
          {images.length > 0 && (
            <div className="msg__images">
              {images.map((path) => (
                <LocalImage key={path} path={path} />
              ))}
            </div>
          )}
          {/* A skill command shows its invocation, not the expanded
              prompt the model was actually handed. */}
          <button
            className="msg__bubble msg__bubble--tappable"
            {...handlers}
            onClick={() => {
              // A long press already opened selection mode; the click the
              // browser fires afterwards must not also toggle the actions.
              if (consumed() || selecting) return;
              buzz('tap');
              p.onToggleActions(m.id);
            }}
            // No aria-label: the message text itself must stay the
            // button's accessible name, or the transcript goes silent to
            // a screen reader. `aria-expanded` carries the affordance.
            aria-expanded={p.openActions}
          >
            {label}
          </button>

          {m.failed && (
            <div className="msg__meta">
              <span className="msg__failed">Not sent</span>
              <button
                className="code__copy"
                disabled={p.running}
                onClick={() => {
                  buzz('tap');
                  p.onResend(m.id);
                }}
              >
                <IconRefresh size={13} /> Send again
              </button>
            </div>
          )}

          {p.openActions && !selecting && (
            <div className="msg__meta">
              <Stamp at={m.at} />
              <button
                className="code__copy"
                disabled={p.running || p.rewinding}
                // Edit the real prompt, not the short display form.
                onClick={() => p.onEdit(m.id, m.text)}
              >
                Edit &amp; resend
              </button>
              {/* Copy what the bubble shows: the refs are plumbing. */}
              <MessageActions getText={() => caption} title="Hem" />
            </div>
          )}
        </>
      );
    }

    if (m.kind === 'notice') {
      return (
        <div className={`notice${m.tone === 'error' ? ' notice--error' : ''}`}>
          {m.label && <div className="notice__label">{m.label}</div>}
          <pre className="notice__body">{m.text}</pre>
          {m.action && (
            <Link className="btn btn--sm" to={m.action.to} style={{ marginTop: 8, display: 'inline-block' }}>
              {m.action.label}
            </Link>
          )}
        </div>
      );
    }

    // `clarify` is a tool only in the mechanical sense — it ran no command and
    // returned no output, it asked the person a question. It gets a card that
    // reads like the exchange it was.
    if (m.kind === 'tool')
      return m.name === 'clarify' ? <ClarifyCard msg={m} /> : <ToolCallCard msg={m} />;
    if (m.kind === 'subagent') return <SubagentCard msg={m} />;

    return (
      <>
        {m.reasoning && showReasoning && <ThinkingBlock text={m.reasoning} />}
        <div className="msg__body">
          <Markdown>{m.text}</Markdown>
        </div>
        <div className="msg__meta">
          <Stamp at={m.at} />
          {m.interrupted && <span className="msg__interrupted">Interrupted</span>}
          {m.usage?.total != null && <span>{formatTokens(m.usage.total)} tok</span>}
          {m.text && (
            <>
              <button
                className={`code__copy msg__action${p.voice ? ' msg__action--on' : ''}`}
                onClick={() => void p.onSpeak(m.id, m.text)}
                aria-label={
                  p.voice === 'playing'
                    ? 'Stop reading aloud'
                    : p.voice === 'pending'
                      ? 'Cancel reading aloud'
                      : 'Read aloud'
                }
                // Announce the phase change to a screen reader without
                // stealing focus — the label alone changes silently.
                aria-live="polite"
              >
                {p.voice === 'pending' ? (
                  <>
                    <span className="spin" style={{ fontSize: 'var(--type-label-sm)' }}>
                      ◌
                    </span>
                    Preparing…
                  </>
                ) : p.voice === 'playing' ? (
                  <>
                    <IconStop size={12} /> Stop
                  </>
                ) : (
                  <>
                    <IconSpeaker size={13} /> Play
                  </>
                )}
              </button>
              <MessageActions getText={() => m.text} title="Hem" />
            </>
          )}
          {p.isLastAssistant && (
            <button
              className="code__copy msg__action"
              disabled={p.running || p.rewinding}
              onClick={p.onRetry}
              aria-label="Retry this reply"
            >
              <IconRefresh size={13} /> {p.rewinding ? 'Retrying…' : 'Retry'}
            </button>
          )}
        </div>
      </>
    );
  })();

  return (
    <>
      {p.showDivider && (
        <div className="msg-divider">
          <span>Earlier — restored from history</span>
        </div>
      )}
      <div
        className={cls}
        ref={setNode}
        // Non-user rows get the press handlers here; the user bubble puts them
        // on its own button so the press target matches the visible bubble.
        {...(m.kind === 'user' ? {} : handlers)}
        {...selectionProps}
      >
        {selecting && <span className={`msg__tick${isSelected ? ' msg__tick--on' : ''}`} />}
        {body}
      </div>
    </>
  );
});
