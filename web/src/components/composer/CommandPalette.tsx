/**
 * The browsable command list.
 *
 * A phone has no keyboard to fish with, so discovery can't rely on typing `/`
 * and guessing: this sheet shows the whole catalog, grouped the way the backend
 * groups it, with skills ranked by how much this user actually uses them.
 *
 * Picking a command that takes an argument seeds the composer rather than
 * running — `/goal` with no argument is rarely what was meant.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sheet } from '../shared/Sheet';
import { Loader } from '../shared/misc';
import { fetchCommandCatalog, type CommandCatalog } from '../../api/commands';
import { argumentMode, canonicalCommand, describeCommand, isSuggestion } from '../../lib/slashCommands';
import { buzz } from '../../lib/haptics';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Run it now (no argument needed). */
  onRun: (command: string) => void;
  /** Put `/command ` in the composer and let the user finish the thought. */
  onSeed: (command: string) => void;
}

interface Row {
  command: string;
  description: string;
}

interface Group {
  name: string;
  rows: Row[];
}

/**
 * Skills sort by observed usage, A–Z within a tie: a catalog sorted
 * alphabetically buries the three skills someone uses daily under sixty they
 * have never opened. Backends without a `skills` map keep the given order.
 */
function rank(rows: Row[], skills: CommandCatalog['skills']): Row[] {
  const usage = (row: Row) => skills[canonicalCommand(row.command)]?.usage ?? 0;
  return [...rows].sort((a, b) => usage(b) - usage(a) || a.command.localeCompare(b.command));
}

const toRows = (pairs: CommandCatalog['pairs'], catalog: CommandCatalog): Row[] =>
  rank(
    pairs
      .filter(([command]) => isSuggestion(command))
      .map(([command, description]) => ({
        command,
        description: describeCommand(command, description),
      })),
    catalog.skills,
  );

function toGroups(catalog: CommandCatalog): Group[] {
  const groups: Group[] = catalog.categories.map((category) => ({
    name: category.name,
    rows: toRows(category.pairs, catalog),
  }));

  // Skill commands are in `pairs` but in no category — without this the
  // palette silently drops every skill, which is most of the catalog.
  const categorized = new Set(
    catalog.categories.flatMap((category) => category.pairs.map(([command]) => command)),
  );
  const skills = toRows(
    catalog.pairs.filter(([command]) => !categorized.has(command)),
    catalog,
  );
  if (skills.length > 0) groups.push({ name: 'Skills', rows: skills });

  return groups.filter((group) => group.rows.length > 0);
}

export function CommandPalette({ open, onClose, onRun, onSeed }: Props) {
  const [query, setQuery] = useState('');

  // Only fetched once the sheet is opened: the catalog is ~150 rows and nobody
  // needs it to send a message.
  const { data, isLoading, error } = useQuery({
    queryKey: ['commands', 'catalog'],
    queryFn: fetchCommandCatalog,
    enabled: open,
    staleTime: 5 * 60_000,
  });

  const groups = useMemo(() => (data ? toGroups(data) : []), [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((group) => ({
        ...group,
        rows: group.rows.filter(
          (row) =>
            row.command.toLowerCase().includes(q) || row.description.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.rows.length > 0);
  }, [groups, query]);

  const pick = (command: string) => {
    buzz('tap');
    onClose();
    setQuery('');
    // A command whose whole point is its argument gets handed to the composer.
    if (argumentMode(command)) onSeed(command);
    else onRun(command);
  };

  return (
    <Sheet open={open} title="Commands" onClose={onClose}>
      <input
        className="field"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search commands…"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />

      {isLoading && <Loader />}
      {error && <div className="palette__note">Couldn’t load the command list.</div>}
      {data?.warning && <div className="palette__note">{data.warning}</div>}

      {filtered.length === 0 && !isLoading && !error && (
        <div className="palette__note">No commands match “{query}”.</div>
      )}

      {filtered.map((group) => (
        <div className="palette__group" key={group.name}>
          <div className="palette__group-name">{group.name}</div>
          {group.rows.map((row) => (
            <button className="palette__row" key={row.command} onClick={() => pick(row.command)}>
              <span className="palette__cmd">{row.command}</span>
              <PaletteDesc text={row.description} />
            </button>
          ))}
        </div>
      ))}
    </Sheet>
  );
}

/**
 * Split the gateway's trailing `(usage: …)` onto its own line.
 *
 * The registry appends it to the description, so commands with real arguments
 * — `/heartbeat`, `/handoff` — rendered as three wrapped lines of parenthetical
 * where the sentence explaining what the command does was the part worth
 * reading. Same information, ranked.
 */
function PaletteDesc({ text }: { text: string }) {
  const m = /^(.*?)\s*\(usage:\s*(.+)\)\s*$/s.exec(text);
  if (!m) return <span className="palette__desc">{text}</span>;
  return (
    <>
      <span className="palette__desc">{m[1]}</span>
      <span className="palette__desc" style={{ fontFamily: 'var(--mono)', opacity: 0.62 }}>
        {m[2]}
      </span>
    </>
  );
}
