// Component test for DedupToast — auto-dismiss after 10s + Undo button wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import DedupToast from '../src/sidepanel/DedupToast.svelte';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('DedupToast', () => {
  it('renders the older question', () => {
    const merge = { olderEntryId: 'id-1', olderQuestion: 'Tell us about leadership' };
    const { getByText } = render(DedupToast, {
      props: { merge, onUndo: vi.fn(), onDismiss: vi.fn() }
    });
    expect(getByText(/Tell us about leadership/)).toBeTruthy();
  });

  it('Undo button fires onUndo', async () => {
    const onUndo = vi.fn();
    const { getByText } = render(DedupToast, {
      props: {
        merge: { olderEntryId: 'id-1', olderQuestion: 'q' },
        onUndo,
        onDismiss: vi.fn()
      }
    });
    await fireEvent.click(getByText('Undo (keep older)'));
    expect(onUndo).toHaveBeenCalled();
  });

  it('Keep merged button fires onDismiss', async () => {
    const onDismiss = vi.fn();
    const { getByText } = render(DedupToast, {
      props: {
        merge: { olderEntryId: 'id-1', olderQuestion: 'q' },
        onUndo: vi.fn(),
        onDismiss
      }
    });
    await fireEvent.click(getByText('Keep merged'));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('auto-dismisses after 10 seconds', () => {
    const onDismiss = vi.fn();
    render(DedupToast, {
      props: {
        merge: { olderEntryId: 'id-1', olderQuestion: 'q' },
        onUndo: vi.fn(),
        onDismiss
      }
    });
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(9_999);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
