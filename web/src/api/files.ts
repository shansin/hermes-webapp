/**
 * Workspace filesystem.
 *
 * Hermes splits this across two prefixes, and which one to use is not obvious:
 *  - `/api/fs/*`    reads — list, read-text, read-data-url, write-text
 *  - `/api/files/*` mutations and transfers — mkdir, delete, download, upload
 *
 * Paths are absolute throughout; there is no session-relative root on the wire.
 * `useDefaultCwd` supplies the starting point.
 *
 * Note the casing split: `/api/fs/read-text` answers in camelCase (`byteSize`,
 * `mimeType`) while most of the REST surface is snake_case. Types here match
 * what each endpoint actually sends.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/**
 * `read-text` always returns *something* in `text`, even for a PNG — so
 * `binary` is the field that decides whether it's fit to display. The server
 * also hands back the language, which saves guessing one from the extension.
 */
export interface FileText {
  binary: boolean;
  byteSize: number;
  language: string;
  mimeType: string;
  path: string;
  text: string;
  /**
   * The server caps reads at 512KB. Critically, `text` is then only a *prefix*
   * of the file — saving it back would silently discard the remainder, so
   * editing must be refused whenever this is set.
   */
  truncated?: boolean;
}

export interface GitStatus {
  branch: string;
  detached: boolean;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  changed: number;
}

export const fileKeys = {
  all: ['files'] as const,
  list: (path: string) => ['files', 'list', path] as const,
  text: (path: string) => ['files', 'text', path] as const,
  dataUrl: (path: string) => ['files', 'data-url', path] as const,
  git: (path: string) => ['files', 'git', path] as const,
  cwd: ['files', 'cwd'] as const,
};

const q = (path: string) => encodeURIComponent(path);

/** Where the browser opens: the agent's configured working directory. */
/**
 * The backend's working directory.
 *
 * No longer where Files opens — that is the home directory now, since the cwd
 * is whichever repo the backend was started in and the files an agent leaves
 * behind land in `~`. Kept because it is the only endpoint that reports the
 * cwd and the git branch with it.
 */
export function useDefaultCwd() {
  return useQuery({
    queryKey: fileKeys.cwd,
    queryFn: () => api.get<{ cwd: string; branch: string }>('/api/fs/default-cwd'),
    staleTime: Infinity,
  });
}

export function useDirectory(path: string | null) {
  return useQuery({
    queryKey: fileKeys.list(path ?? ''),
    queryFn: () => api.get<{ entries: FsEntry[] }>(`/api/fs/list?path=${q(path!)}`),
    enabled: Boolean(path),
  });
}

export function useFileText(path: string | null) {
  return useQuery({
    queryKey: fileKeys.text(path ?? ''),
    queryFn: () => api.get<FileText>(`/api/fs/read-text?path=${q(path!)}`),
    enabled: Boolean(path),
    // A file the agent is editing should show through on reopen.
    staleTime: 0,
    retry: false,
  });
}

/** Base64 payload, used to show an image without a second authenticated origin. */
export function useFileDataUrl(path: string | null) {
  return useQuery({
    queryKey: fileKeys.dataUrl(path ?? ''),
    queryFn: () => api.get<{ dataUrl: string }>(`/api/fs/read-data-url?path=${q(path!)}`),
    enabled: Boolean(path),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Git branch and dirty count for a directory.
 *
 * A path outside any repository is the normal case, not an error, so a failure
 * resolves to null and the header simply shows no branch chip.
 */
export function useGitStatus(path: string | null) {
  return useQuery({
    queryKey: fileKeys.git(path ?? ''),
    queryFn: () => api.get<GitStatus>(`/api/git/status?path=${q(path!)}`).catch(() => null),
    enabled: Boolean(path),
    staleTime: 30_000,
  });
}

export function useWriteFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api.post('/api/fs/write-text', { path, content }),
    onSuccess: (_r, { path }) => {
      void qc.invalidateQueries({ queryKey: fileKeys.text(path) });
      // Writing changes the repo's dirty count.
      void qc.invalidateQueries({ queryKey: ['files', 'git'] });
    },
  });
}

export function useMakeDirectory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path }: { path: string }) => api.post('/api/files/mkdir', { path }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files', 'list'] }),
  });
}

export function useDeletePath() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, recursive }: { path: string; recursive?: boolean }) =>
      api.delBody('/api/files', { path, recursive: recursive ?? false }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['files', 'list'] });
      void qc.invalidateQueries({ queryKey: ['files', 'git'] });
    },
  });
}

/**
 * Download a file to the phone.
 *
 * Deliberately not a plain `<a href download>`: in the default deployment the
 * proxy injects the upstream credential and a bare link would work, but when
 * the user points the app straight at Hermes with their own token, that token
 * lives in a header the browser would never attach to a link navigation. Going
 * through the authenticated client keeps both modes working.
 */
export async function downloadFile(path: string): Promise<void> {
  const res = await api.raw(`/api/files/download?path=${q(path)}`);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = basename(path);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately cancels the save on some mobile browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** The parent of an absolute path, or null at the filesystem root. */
export function parentOf(path: string): string | null {
  if (path === '/' || !path.startsWith('/')) return null;
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  if (i < 0) return null;
  return i === 0 ? '/' : trimmed.slice(0, i);
}

export function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
