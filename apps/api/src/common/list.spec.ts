import { describe, expect, it } from 'vitest';
import { buildList } from './list';

const OPTS = { sortable: ['id', 'name'], defaultSort: { id: 'desc' as const } };

describe('buildList — pagination', () => {
  it('defaults to page 1, pageSize 25 when absent', () => {
    const r = buildList({}, OPTS);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(25);
    expect(r.skip).toBe(0);
    expect(r.take).toBe(25);
  });

  it('computes skip from page and pageSize', () => {
    const r = buildList({ page: '3', pageSize: '10' }, OPTS);
    expect(r.page).toBe(3);
    expect(r.pageSize).toBe(10);
    expect(r.skip).toBe(20); // (3-1)*10
    expect(r.take).toBe(10);
  });

  it('clamps page to a minimum of 1 (zero, negative, NaN)', () => {
    expect(buildList({ page: '0' }, OPTS).page).toBe(1);
    expect(buildList({ page: '-5' }, OPTS).page).toBe(1);
    expect(buildList({ page: 'abc' }, OPTS).page).toBe(1);
  });

  it('clamps pageSize to [1, maxPageSize] (default max 200)', () => {
    expect(buildList({ pageSize: '0' }, OPTS).pageSize).toBe(25); // 0 -> falsy -> default 25
    expect(buildList({ pageSize: '-3' }, OPTS).pageSize).toBe(1); // negative -> max(1, ...)
    expect(buildList({ pageSize: '9999' }, OPTS).pageSize).toBe(200);
    expect(buildList({ pageSize: 'abc' }, OPTS).pageSize).toBe(25);
  });

  it('honors a custom maxPageSize', () => {
    expect(buildList({ pageSize: '500' }, { ...OPTS, maxPageSize: 50 }).pageSize).toBe(50);
  });
});

describe('buildList — sort', () => {
  it('uses the default sort when no sort is given', () => {
    expect(buildList({}, OPTS).orderBy).toEqual({ id: 'desc' });
  });

  it('applies a valid sortable field ascending/descending', () => {
    expect(buildList({ sort: 'name:asc' }, OPTS).orderBy).toEqual({ name: 'asc' });
    expect(buildList({ sort: 'name:desc' }, OPTS).orderBy).toEqual({ name: 'desc' });
  });

  it('defaults an unknown direction to ascending', () => {
    expect(buildList({ sort: 'name:sideways' }, OPTS).orderBy).toEqual({ name: 'asc' });
    expect(buildList({ sort: 'name' }, OPTS).orderBy).toEqual({ name: 'asc' });
  });

  it('ignores a non-sortable field and keeps the default sort (no injection)', () => {
    expect(buildList({ sort: 'password:desc' }, OPTS).orderBy).toEqual({ id: 'desc' });
    expect(buildList({ sort: 'DROP TABLE:asc' }, OPTS).orderBy).toEqual({ id: 'desc' });
  });
});
