import { describe, expect, it } from 'vitest';
import { SETTINGS_REGISTRY, SETTING_GROUPS } from './settings-registry';

describe('settings registry (§14 Configuration catalog)', () => {
  it('has unique keys', () => {
    const keys = SETTINGS_REGISTRY.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every entry belongs to a declared group', () => {
    const groups = new Set<string>(SETTING_GROUPS);
    for (const s of SETTINGS_REGISTRY) expect(groups.has(s.group), `${s.key} group '${s.group}'`).toBe(true);
  });

  it('defaults parse according to their declared type', () => {
    for (const s of SETTINGS_REGISTRY) {
      if (s.type === 'number') {
        expect(Number.isFinite(Number(s.defaultValue)), `${s.key} default '${s.defaultValue}'`).toBe(true);
      }
      if (s.type === 'boolean') {
        expect(['true', 'false'], `${s.key} default '${s.defaultValue}'`).toContain(s.defaultValue);
      }
      if (s.type === 'select') {
        expect(s.options?.length, `${s.key} needs options`).toBeGreaterThan(0);
        expect(s.options, `${s.key} default must be an option`).toContain(s.defaultValue);
      }
    }
  });

  it('every entry documents itself (label + description)', () => {
    for (const s of SETTINGS_REGISTRY) {
      expect(s.label.length, s.key).toBeGreaterThan(2);
      expect(s.description.length, s.key).toBeGreaterThan(10);
    }
  });
});
