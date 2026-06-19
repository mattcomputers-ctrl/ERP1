import { describe, expect, it } from 'vitest';
import { chainHash, stableStringify } from './hash-chain';

describe('stableStringify (deterministic, key-sorted serialization)', () => {
  it('is independent of key insertion order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('sorts keys deeply (nested objects)', () => {
    expect(stableStringify({ x: { c: 3, a: 1 }, b: 2 })).toBe('{"b":2,"x":{"a":1,"c":3}}');
  });

  it('preserves array order (arrays are positional, not sorted)', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it('normalizes null and undefined to null', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify({ a: undefined })).toBe('{"a":null}');
  });

  it('serializes primitives like JSON', () => {
    expect(stableStringify('hi')).toBe('"hi"');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify(true)).toBe('true');
  });

  it('distinguishes different content', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe('chainHash (SHA-256 tamper-evident chain link)', () => {
  it('returns a 64-char hex SHA-256 digest', () => {
    expect(chainHash(null, { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same prev + payload', () => {
    expect(chainHash('abc', { a: 1, b: 2 })).toBe(chainHash('abc', { a: 1, b: 2 }));
  });

  it('is independent of payload key order (via stableStringify)', () => {
    expect(chainHash('abc', { a: 1, b: 2 })).toBe(chainHash('abc', { b: 2, a: 1 }));
  });

  it('changes when the payload changes (tamper of the row)', () => {
    expect(chainHash('abc', { a: 1 })).not.toBe(chainHash('abc', { a: 2 }));
  });

  it('changes when the previous hash changes (tamper of an earlier link)', () => {
    expect(chainHash('prev1', { a: 1 })).not.toBe(chainHash('prev2', { a: 1 }));
  });

  it('treats a null genesis prev as the empty string by design', () => {
    expect(chainHash(null, { a: 1 })).toBe(chainHash('', { a: 1 }));
  });

  it('chains: re-walking the same prev/payload sequence reproduces every hash', () => {
    const payloads = [{ act: 'create' }, { act: 'update', v: 2 }, { act: 'close' }];
    const forward: string[] = [];
    let prev: string | null = null;
    for (const p of payloads) {
      prev = chainHash(prev, p);
      forward.push(prev);
    }
    // Independent recompute must match link-for-link.
    let check: string | null = null;
    payloads.forEach((p, i) => {
      check = chainHash(check, p);
      expect(check).toBe(forward[i]);
    });
    // Reordering the middle two payloads must break the recomputed chain.
    const reordered = [payloads[0], payloads[2], payloads[1]];
    let broken: string | null = null;
    const brokenHashes = reordered.map((p) => (broken = chainHash(broken, p)));
    expect(brokenHashes).not.toEqual(forward);
  });
});
