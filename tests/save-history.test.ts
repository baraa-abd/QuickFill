// Component test for SaveHistory — only save entries appear, Delete wires up.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import SaveHistory from '../src/sidepanel/SaveHistory.svelte';
import type { RecentActivity } from '../src/sidepanel/session-store.svelte';

const saveEntry = (id: string, label: string, value: string): RecentActivity => ({
  kind: 'save',
  id,
  at: Date.now(),
  label,
  value
});

describe('SaveHistory', () => {
  it('renders nothing when no save entries', () => {
    const { container } = render(SaveHistory, {
      props: {
        entries: [],
        onDelete: vi.fn()
      }
    });
    expect(container.querySelector('h2')).toBeNull();
  });

  it('renders one row per save and ignores fill entries', () => {
    const s = saveEntry('s-1', 'phone number', '555-0100');
    const { getByText, getAllByText, queryByText } = render(SaveHistory, {
      props: {
        entries: [
          s,
          {
            kind: 'fill',
            id: 'f',
            at: Date.now(),
            label: 'unrelated',
            canonicalKey: 'first name',
            value: 'Ada',
            source: 'profile',
            alternativeValues: [],
            tabId: 1,
            frameId: 0,
            elementRef: 'r',
            previousValue: '',
            fieldType: 'text'
          }
        ],
        onDelete: vi.fn()
      }
    });
    expect(getByText('phone number')).toBeTruthy();
    expect(queryByText('unrelated')).toBeNull();
    expect(getAllByText('Delete from profile')).toHaveLength(1);
  });

  it('Delete button posts the entry id', async () => {
    const onDelete = vi.fn();
    const { getByText } = render(SaveHistory, {
      props: {
        entries: [saveEntry('the-id', 'phone number', '555')],
        onDelete
      }
    });
    await fireEvent.click(getByText('Delete from profile'));
    expect(onDelete).toHaveBeenCalledWith('the-id');
  });
});
