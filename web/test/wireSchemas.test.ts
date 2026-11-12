/**
 * The wire schemas' tolerance, pinned at the schema rather than through a store.
 *
 * They moved from classic zod to `zod/mini` for the entry chunk's sake (see
 * the note in `ws/types.ts`), which rewrote every one of them from method
 * chains into nested calls. The contract that rewrite had to keep is the
 * whole point of these schemas and is invisible when broken until a Hermes
 * upgrade lands: an unknown field passes through rather than failing or being
 * stripped, an absent field gets its default, and `null` stays legal where the
 * gateway spells "open-ended" with it.
 *
 * The last case pins the bundle half: one classic `zod` import anywhere in
 * the app — even on a lazy route — puts every core schema class back in the
 * entry chunk, because the two builds share that core.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ApprovalRequestSchema,
  ClarifyRequestSchema,
  RpcEventSchema,
  RpcResponseSchema,
  SessionCreateResultSchema,
} from '../src/ws/types';
import { CommandCatalogSchema, CompletionItemSchema } from '../src/api/commands';
import { DelegationStatusSchema } from '../src/api/delegation';

describe('wire schemas', () => {
  it('pass unknown fields through, at the top and nested', () => {
    const p = RpcEventSchema.parse({
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'message.delta', payload: { text: 'hi' }, future_field: 1 },
    });
    expect(p.params).toMatchObject({ type: 'message.delta', future_field: 1 });

    const r = SessionCreateResultSchema.parse({
      session_id: 'abcd1234',
      info: { model: 'x', brand_new: true },
      extra: 'kept',
    });
    expect(r).toMatchObject({ extra: 'kept', info: { brand_new: true } });
  });

  it('still refuses what is genuinely the wrong shape', () => {
    expect(RpcResponseSchema.safeParse({ jsonrpc: '2.0', id: true }).success).toBe(false);
    expect(RpcEventSchema.safeParse({ jsonrpc: '2.0', method: 'event', params: {} }).success).toBe(
      false,
    );
  });

  it('fills defaults, and never hands two parses the same array', () => {
    const a = ApprovalRequestSchema.parse({});
    const b = ApprovalRequestSchema.parse({});
    expect(a.choices).toEqual(['once', 'deny']);
    a.choices.push('always');
    expect(b.choices).toEqual(['once', 'deny']);

    expect(CompletionItemSchema.parse({ text: 'help' })).toEqual({
      text: 'help',
      display: '',
      meta: '',
      kind: 'command',
    });
    expect(DelegationStatusSchema.parse({}).active).toEqual([]);
  });

  it('keeps null legal where the gateway uses it', () => {
    const c = ClarifyRequestSchema.parse({ request_id: 'r', question: 'why?', choices: null });
    expect(c.choices).toBeNull();
    const d = DelegationStatusSchema.parse({ active: [{ subagent_id: 's', goal: null }] });
    expect(d.active[0]!.goal).toBeNull();
  });

  it('accepts command pairs of two or more strings', () => {
    const cat = CommandCatalogSchema.parse({ pairs: [['/help', 'Show help', 'extra']] });
    expect(cat.pairs[0]).toEqual(['/help', 'Show help', 'extra']);
    expect(CommandCatalogSchema.safeParse({ pairs: [['/help']] }).success).toBe(false);
  });

  it('no source file imports classic zod', () => {
    const src = join(__dirname, '..', 'src');
    // An import statement, not a comment that quotes one.
    const classic = /^\s*(?:import|export)\b[^;]*?from\s*['"]zod['"]/m;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && classic.test(readFileSync(path, 'utf8'))) {
          offenders.push(path.slice(src.length + 1));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
