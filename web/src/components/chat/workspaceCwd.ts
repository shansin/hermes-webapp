/**
 * The session's working directory, handed down to every `Markdown` in the
 * transcript instead of each one reading it from the store.
 *
 * `Markdown` needs the cwd to resolve `workspace://` links and relative paths,
 * and it used to subscribe for it itself — one store subscription per rendered
 * message. A zustand subscription runs its selector on *every* store write,
 * and the session store is written per token: a long transcript meant hundreds
 * of selector calls per delta, all answering "same as before". `MessageList`
 * now subscribes once and provides the value here.
 *
 * Its own module, not `Markdown.tsx`, because that file is a lazy chunk and
 * the list that provides this is in the entry.
 *
 * The default is a sentinel rather than `undefined` so a `Markdown` rendered
 * outside the transcript (the file viewer, a kanban task, a notification) can
 * tell "nobody provided one" from "the session has no cwd" and fall back to
 * reading the store as it always did. A handful of those is not the problem
 * this solves.
 */
import { createContext } from 'react';

export const NO_CWD_PROVIDER: unique symbol = Symbol('no cwd provider');

export const WorkspaceCwd = createContext<string | undefined | typeof NO_CWD_PROVIDER>(
  NO_CWD_PROVIDER,
);
