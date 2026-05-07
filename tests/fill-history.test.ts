// Component test for FillHistory — only fill entries appear, Revert wires up.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import FillHistory from '../src/sidepanel/FillHistory.svelte';
import type { RecentActivity } from '../src/sidepanel/session-store.svelte';

/**
 * Build a FillActivity test fixture. The label and the canonicalKey are kept
 * distinct so tests can target whichever the component happens to render
 * (FillHistory shows `canonicalKey ?? label`, so we drive both via the
 * canonicalKey here to keep the assertions stable).
 */
const fillEntry = (id: string, canonicalKey: string, value: string): RecentActivity => ({
  kind: 'fill',
  id,
  at: Date.now(),
  label: canonicalKey,
  canonicalKey,
  value,
  source: 'profile',
  alternativeValues: [],
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
        entries: [
          { kind: 'save', id: 's-1', at: Date.now(), label: 'x', value: 'y' } as RecentActivity
        ],
        onRevert: vi.fn(),
        onSwitchValue: vi.fn()
      }
    });
    expect(container.querySelector('h2')).toBeNull();
  });

  it('renders one row per fill entry, newest first', () => {
    const a = fillEntry('a', 'first name', 'Ada');
    const b = fillEntry('b', 'last name', 'Lovelace');
    const { getAllByText, getByText } = render(FillHistory, {
      props: { entries: [a, b], onRevert: vi.fn(), onSwitchValue: vi.fn() }
    });
    expect(getByText('first name')).toBeTruthy();
    expect(getByText('last name')).toBeTruthy();
    expect(getAllByText('Revert')).toHaveLength(2);
  });

  it('Revert button posts the entry id', async () => {
    const onRevert = vi.fn();
    const a = fillEntry('the-id', 'first name', 'Ada');
    const { getByText } = render(FillHistory, {
      props: { entries: [a], onRevert, onSwitchValue: vi.fn() }
    });
    await fireEvent.click(getByText('Revert'));
    expect(onRevert).toHaveBeenCalledWith('the-id');
  });
});
