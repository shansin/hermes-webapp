/**
 * Read a reply aloud: which message is speaking, and the toggle that starts
 * and stops it.
 *
 * Split out of `MessageList` with its behaviour unchanged. The awkward part is
 * that three things can end playback — a second tap, the clip finishing, and
 * a newer tap superseding a request still in flight — and the button has to
 * follow all three without a stale request claiming it back.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { onSpeakingChange, speak, stopSpeaking } from '../../lib/audio';
import type { Toast } from '../../store/ui';

/** Where a read-aloud request has got to. */
export type VoicePhase = 'pending' | 'playing';

export function useReadAloud(toast: (text: string, tone?: Toast['tone']) => void) {
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

  // Leaving the chat must not leave a voice reading into an empty room.
  useEffect(() => stopSpeaking, []);

  return { voice, onSpeak };
}
