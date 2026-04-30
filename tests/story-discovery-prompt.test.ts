// Component test for StoryDiscoveryPrompt — editable proposal + confirm shape.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import StoryDiscoveryPrompt from '../src/sidepanel/StoryDiscoveryPrompt.svelte';

describe('StoryDiscoveryPrompt', () => {
  it('seeds the textarea + keywords from the proposal', () => {
    const { container } = render(StoryDiscoveryPrompt, {
      props: {
        proposal: { content: 'Led migration', keywords: ['leadership', 'shipping'] },
        onConfirm: vi.fn(),
        onDismiss: vi.fn()
      }
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Led migration');
    const kwInput = container.querySelector('#story-kw') as HTMLInputElement;
    expect(kwInput.value).toBe('leadership, shipping');
  });

  it('Save story emits trimmed content + parsed keywords', async () => {
    const onConfirm = vi.fn();
    const { container, getByText } = render(StoryDiscoveryPrompt, {
      props: {
        proposal: { content: 'first', keywords: [] },
        onConfirm,
        onDismiss: vi.fn()
      }
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const kwInput = container.querySelector('#story-kw') as HTMLInputElement;
    await fireEvent.input(textarea, { target: { value: '  edited content  ' } });
    await fireEvent.input(kwInput, { target: { value: ' a , , b ,c' } });
    await fireEvent.click(getByText('Save story'));
    expect(onConfirm).toHaveBeenCalledWith('edited content', ['a', 'b', 'c']);
  });

  it('Skip button fires onDismiss', async () => {
    const onDismiss = vi.fn();
    const { getByText } = render(StoryDiscoveryPrompt, {
      props: {
        proposal: { content: 'x', keywords: [] },
        onConfirm: vi.fn(),
        onDismiss
      }
    });
    await fireEvent.click(getByText('Skip'));
    expect(onDismiss).toHaveBeenCalled();
  });
});
