// Component test for FillHistory — only fill entries appear, Revert wires up.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import FillHistory from '../src/sidepanel/FillHistory.svelte';
import type { RecentActivity } from '../src/sidepanel/session-store.svelte';

const fillEntry = (id: string, label: string, value: string): RecentActivity => ({
  kind: 'fill',
  id,
  at: Date.now(),
  label,
  canonicalKey: 'first name',
  value,
  source: 'profile',
  tabId: 1,
  frameId: 0,
  elementRef: 'el-1',
  previousValue: '',
  fieldType: 'text'
});

describe('FillHistory', () => {
  it('renders nothing when there are no fill entries', () => {
    const { container } = render(FillHistory, {
      props: {
        entries: [{ kind: 'save', id: 's-1', at: Date.now(), label: 'x', value: 'y' }],
        onRevert: vi.fn()
      }
    });
    expect(container.querySelector('h2')).toBeNull();
  });

  it('renders one row per fill entry, newest first', () => {
    const a = fillEntry('a', 'First name', 'Ada');
    const b = fillEntry('b', 'Last name', 'Lovelace');
    const { getAllByText, getByText } = render(FillHistory, {
      props: { entries: [a, b], onRevert: vi.fn() }
    });
    expect(getByText('First name')).toBeTruthy();
    expect(getByText('Last name')).toBeTruthy();
    expect(getAllByText('Revert')).toHaveLength(2);
  });

  it('Revert button posts the entry id', async () => {
    const onRevert = vi.fn();
    const a = fillEntry('the-id', 'First name', 'Ada');
    const { getByText } = render(FillHistory, {
      props: { entries: [a], onRevert }
    });
    await fireEvent.click(getByText('Revert'));
    expect(onRevert).toHaveBeenCalledWith('the-id');
  });
});
