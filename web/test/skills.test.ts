/**
 * One skill with no category used to take the entire app down.
 *
 * Hermes leaves `category` null on skills the agent wrote itself. The Skills
 * screen grouped on that key and then called `.replace()` on it to render the
 * heading — a throw during render, with no error boundary above it, so Skills
 * came up empty and every other screen stopped rendering until a reload. The
 * value is server-supplied and only appears once someone's agent has written
 * a skill, which is why nothing here caught it.
 */
import { describe, expect, it } from 'vitest';
import { groupSkills } from '../src/components/hub/SkillsTab';
import type { Skill } from '../src/api/hub';

const skill = (name: string, category: string | null): Skill => ({
  name,
  description: '',
  category,
  enabled: true,
  usage: 0,
  provenance: 'agent',
});

describe('groupSkills', () => {
  it('keeps a null category out of the group keys', () => {
    const groups = groupSkills([skill('daemon-environment-gap', null)]);
    expect(groups).toHaveLength(1);
    const [category, skills] = groups[0];
    expect(typeof category).toBe('string');
    expect(category).not.toBe('null');
    expect(skills.map((s) => s.name)).toEqual(['daemon-environment-gap']);
  });

  it('sorts categories alphabetically and puts the uncategorized bin last', () => {
    const groups = groupSkills([
      skill('a', null),
      skill('b', 'writing'),
      skill('c', 'autonomous-ai-agents'),
      skill('d', 'writing'),
    ]);
    expect(groups.map(([c]) => c)).toEqual(['autonomous-ai-agents', 'writing', 'uncategorized']);
    expect(groups[1][1].map((s) => s.name)).toEqual(['b', 'd']);
  });

  it('has no groups at all when nothing is installed', () => {
    expect(groupSkills(undefined)).toEqual([]);
    expect(groupSkills([])).toEqual([]);
  });
});
