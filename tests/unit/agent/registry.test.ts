import { describe, expect, it } from 'vitest';
import {
  AGENT_DESCRIPTORS,
  AGENT_KINDS,
  DEFAULT_AGENT_KIND,
  agentDescriptor,
  isAgentKind,
  listAgentDescriptors,
} from '../../../src/agent/registry';

describe('agent registry', () => {
  it('has one descriptor per kind, keyed by its own kind', () => {
    expect(Object.keys(AGENT_DESCRIPTORS).sort()).toEqual([...AGENT_KINDS].sort());
    for (const kind of AGENT_KINDS) {
      expect(AGENT_DESCRIPTORS[kind].kind).toBe(kind);
    }
    expect(listAgentDescriptors().map((d) => d.kind)).toEqual([...AGENT_KINDS]);
  });

  it('keeps descriptor identifiers unique so detection and bylines never collide', () => {
    const descriptors = listAgentDescriptors();
    for (const field of ['displayName', 'command', 'commandEnv'] as const) {
      const values = descriptors.map((d) => d[field]);
      expect(new Set(values).size, field).toBe(values.length);
    }
  });

  it('lists the default agent first so pickers preselect it', () => {
    expect(AGENT_KINDS[0]).toBe(DEFAULT_AGENT_KIND);
  });

  it('recognises only registered kinds', () => {
    for (const kind of AGENT_KINDS) expect(isAgentKind(kind)).toBe(true);
    for (const value of ['', 'Claude', 'deepseek', undefined, null, 1, {}]) {
      expect(isAgentKind(value)).toBe(false);
    }
  });

  it('resolves a missing kind to the default descriptor', () => {
    expect(agentDescriptor(undefined)).toBe(AGENT_DESCRIPTORS[DEFAULT_AGENT_KIND]);
  });
});
