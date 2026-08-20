/**
 * Executes a typed slash command against the surface its spec names.
 *
 * The spec table (`slashCommands.ts`) decides *what* a command is; this hook is
 * the only place that decides *how* it runs, so screens keep passing plain
 * callbacks (open a sheet, start a chat) instead of knowing about the gateway.
 *
 * Output lands in the transcript as a `notice` message rather than a toast: a
 * command's answer is part of the conversation, and a toast on a phone is gone
 * before a long `/status` can be read.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../store/session';
import { useUi } from '../store/ui';
import { hermes, RpcError } from '../ws/client';
import { buzz } from './haptics';
import { execCommand, type DispatchResult } from '../api/commands';
import {
  canonicalCommand,
  isRunnable,
  resolveCommand,
  splitCommand,
  unavailableMessage,
  type LocalActionId,
} from './slashCommands';

export interface SlashHandlers {
  onNewChat: () => void;
  onOpenModel: () => void;
  onOpenContext: () => void;
  onOpenPalette: () => void;
}

/** An alias can point at another command; don't let a cycle spin forever. */
const MAX_ALIAS_DEPTH = 3;

export function useSlashRunner(handlers: SlashHandlers) {
  const navigate = useNavigate();
  const toast = useUi((s) => s.toast);
  /** The command currently in flight — `slash.exec` can take a while. */
  const [busy, setBusy] = useState('');

  // Held in a ref so a caller passing a fresh handlers object each render
  // doesn't churn `run`'s identity and re-run every effect keyed on it.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  const runLocal = useCallback(
    (action: LocalActionId, arg: string): void => {
      const h = handlersRef.current;
      switch (action) {
        case 'new':
          h.onNewChat();
          return;
        case 'sessions':
          // A typed argument is a search the sessions screen can pre-fill.
          navigate(arg ? `/sessions?q=${encodeURIComponent(arg)}` : '/sessions');
          return;
        case 'model':
          h.onOpenModel();
          return;
        case 'context':
          h.onOpenContext();
          return;
        case 'kanban':
          navigate('/kanban');
          return;
        case 'notifications':
          navigate('/notifications');
          return;
        case 'help':
          h.onOpenPalette();
          return;
        default:
          // Each former Hub tab is its own route now.
          navigate(`/${action.replace('hub-', '')}`);
      }
    },
    [navigate],
  );

  const run = useCallback(
    async (input: string, depth = 0): Promise<void> => {
      const { addNotice, submitPrompt, sessionId } = useSession.getState();
      const { arg } = splitCommand(input);
      const name = canonicalCommand(input);
      const spec = resolveCommand(input);

      if (!isRunnable(input)) {
        addNotice(unavailableMessage(input) ?? `${name} isn't available here.`, 'error', name);
        buzz('warn');
        return;
      }

      if (spec?.surface.kind === 'local') {
        buzz('tap');
        runLocal(spec.surface.action, arg);
        return;
      }

      if (!sessionId) {
        toast('No session yet — give it a moment', 'warn');
        return;
      }

      /** Turn a typed `command.dispatch` payload into the right local effect. */
      const applyDispatch = async (result: DispatchResult): Promise<void> => {
        if (result.notice) addNotice(result.notice, 'info', name);

        if (result.type === 'alias' && result.target) {
          if (depth >= MAX_ALIAS_DEPTH) {
            addNotice('Alias chain is too deep.', 'error', name);
            return;
          }
          const target = result.target.startsWith('/') ? result.target : `/${result.target}`;
          await run(arg ? `${target} ${arg}` : target, depth + 1);
          return;
        }

        if ((result.type === 'send' || result.type === 'skill') && result.message) {
          // The model gets the expanded scaffolding; the transcript keeps the
          // short invocation the user typed.
          await submitPrompt(result.message, {
            display: result.display || (arg ? `${name} ${arg}` : name),
          });
          return;
        }

        addNotice(result.output?.trim() || '(no output)', 'info', name);
      };

      buzz('tap');
      setBusy(name);
      try {
        if (spec?.surface.kind === 'rpc') {
          const { rpc, buildParams, render } = spec.surface;
          const result = await hermes.call(rpc, buildParams({ sessionId, arg, name }));
          addNotice(render ? render(result, { sessionId, arg, name }) : 'Done.', 'info', name);
          return;
        }

        // Everything else — including skill and user quick commands we never
        // enumerated — runs on the backend.
        const { output, warning, dispatch } = await execCommand(sessionId, name, arg);
        if (warning) addNotice(warning, 'error', name);
        if (dispatch) {
          await applyDispatch(dispatch);
          return;
        }
        addNotice(output?.trim() || '(no output)', 'info', name);
      } catch (err) {
        const message =
          err instanceof RpcError || err instanceof Error ? err.message : 'command failed';
        addNotice(message, 'error', name);
        buzz('warn');
      } finally {
        setBusy('');
      }
    },
    [runLocal, toast],
  );

  return { run, busy };
}
