/**
 * Capabilities — toolsets, MCP servers and Hermes' own config.
 *
 * Three sections rather than three drawer rows. They are one question asked
 * three ways — what can this agent reach? — and the drawer is the scarce
 * surface, not this screen.
 *
 * Sections are plain imports, not `lazy()`. The boundary on Models exists
 * because recharts weighs 356 KB; nothing here pulls in anything of the sort,
 * and splitting three small components would buy three round trips for a
 * screen you arrive at with the intent to move between them.
 */
import { useSearchParams } from 'react-router-dom';
import { ToolsetsSection } from './ToolsetsSection';
import { McpSection } from './McpSection';
import { ConfigSection } from './ConfigSection';
import { buzz } from '../../lib/haptics';

const SECTIONS = [
  { id: 'toolsets', label: 'Toolsets' },
  { id: 'mcp', label: 'MCP' },
  { id: 'config', label: 'Config' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export function CapabilitiesTab() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  // Anything unrecognised lands on the first section rather than on nothing.
  const tab: SectionId = SECTIONS.some((s) => s.id === raw) ? (raw as SectionId) : 'toolsets';

  return (
    <>
      <div className="btn-group" role="tablist" aria-label="Capabilities section">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={tab === s.id}
            className={`btn-group__item${tab === s.id ? ' btn-group__item--active' : ''}`}
            onClick={() => {
              buzz('tap');
              // `replace`: moving between sections of one screen is not
              // something you should have to press back through to leave.
              setParams(s.id === 'toolsets' ? {} : { tab: s.id }, { replace: true });
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {tab === 'mcp' ? <McpSection /> : tab === 'config' ? <ConfigSection /> : <ToolsetsSection />}
    </>
  );
}
