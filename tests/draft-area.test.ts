// Component test for DraftArea — edit toggle + partial-stream rendering +
// approve disabled while streaming (per design §5.2 "Generating answer").

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import DraftArea from '../src/sidepanel/DraftArea.svelte';

describe('DraftArea', () => {
  it('renders the streaming caret and disables Approve while streaming', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { getByText } = render(DraftArea, {
      props: { draft: 'Hel', streaming: true, done: false, maxLength: 600, onConfirm, onCancel }
    });
    const button = getByText('Streaming…') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(true);
  });

  it('Approve fires onConfirm with no override when not editing', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { getByText } = render(DraftArea, {
      props: { draft: 'Hello', streaming: false, done: true, maxLength: 600, onConfirm, onCancel }
    });
    await fireEvent.click(getByText('Approve & fill'));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('Edit toggles a textarea + Save edit & fill submits the edited value', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { getByText, container } = render(DraftArea, {
      props: { draft: 'first', streaming: false, done: true, maxLength: 600, onConfirm, onCancel }
    });
    await fireEvent.click(getByText('Edit'));
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe('first');
    await fireEvent.input(textarea, { target: { value: 'edited' } });
    await fireEvent.click(getByText('Save edit & fill'));
    expect(onConfirm).toHaveBeenCalledWith('edited');
  });

  it('shows char counter when maxLength > 0', () => {
    const { getByText } = render(DraftArea, {
      props: {
        draft: 'abc',
        streaming: false,
        done: true,
        maxLength: 100,
        onConfirm: vi.fn(),
        onCancel: vi.fn()
      }
    });
    expect(getByText('3 / 100 chars')).toBeTruthy();
  });

  it('Cancel button fires onCancel', async () => {
    const onCancel = vi.fn();
    const { getByText } = render(DraftArea, {
      props: {
        draft: 'x',
        streaming: false,
        done: true,
        maxLength: 0,
        onConfirm: vi.fn(),
        onCancel
      }
    });
    await fireEvent.click(getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});
