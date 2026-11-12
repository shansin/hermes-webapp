/**
 * Selection mode: long-press a message, then tap to build a range to copy or
 * share.
 *
 * Split out of `MessageList` with its behaviour unchanged. Every callback is a
 * stable identity, because each is handed to every memoized `MessageRow`.
 */
import { useCallback, useState } from 'react';
import type { ChatMessage } from '../../store/session';
import { buzz } from '../../lib/haptics';
import { chatToMarkdown } from '../../lib/share';

export function useSelection({
  messages,
  onBegin,
}: {
  messages: ChatMessage[];
  /** Entering selection closes whatever else was open. Must be stable. */
  onBegin: () => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const beginSelection = useCallback(
    (id: string) => {
      buzz('approval');
      setSelecting(true);
      setSelected(new Set([id]));
      onBegin();
    },
    [onBegin],
  );

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

  return { selecting, selected, beginSelection, toggleSelected, endSelection, selectedMarkdown };
}
