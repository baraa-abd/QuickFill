// Component test for ApplicationSetup — required-field validation + submit shape.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import ApplicationSetup from '../src/sidepanel/ApplicationSetup.svelte';

describe('ApplicationSetup', () => {
  it('refuses an empty company name and surfaces an error', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { getByText } = render(ApplicationSetup, { props: { onSubmit, onCancel } });
    await fireEvent.click(getByText('Continue'));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(getByText(/Company name is required/)).toBeTruthy();
  });

  it('refuses an empty role even when company is filled', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { container, getByText } = render(ApplicationSetup, { props: { onSubmit, onCancel } });
    const company = container.querySelector('#app-company') as HTMLInputElement;
    await fireEvent.input(company, { target: { value: 'Acme' } });
    await fireEvent.click(getByText('Continue'));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(getByText(/Role is required/)).toBeTruthy();
  });

  it('submits trimmed values with null blurb when blurb is empty', async () => {
    const onSubmit = vi.fn();
    const { container, getByText } = render(ApplicationSetup, {
      props: { onSubmit, onCancel: vi.fn() }
    });
    const company = container.querySelector('#app-company') as HTMLInputElement;
    const role = container.querySelector('#app-role') as HTMLInputElement;
    await fireEvent.input(company, { target: { value: '  Acme  ' } });
    await fireEvent.input(role, { target: { value: ' Founding ML Engineer ' } });
    await fireEvent.click(getByText('Continue'));
    expect(onSubmit).toHaveBeenCalledWith('Acme', 'Founding ML Engineer', null);
  });

  it('preserves blurb when present', async () => {
    const onSubmit = vi.fn();
    const { container, getByText } = render(ApplicationSetup, {
      props: { onSubmit, onCancel: vi.fn() }
    });
    const company = container.querySelector('#app-company') as HTMLInputElement;
    const role = container.querySelector('#app-role') as HTMLInputElement;
    const blurb = container.querySelector('#app-blurb') as HTMLTextAreaElement;
    await fireEvent.input(company, { target: { value: 'Acme' } });
    await fireEvent.input(role, { target: { value: 'Eng' } });
    await fireEvent.input(blurb, { target: { value: 'YC S23, ~12 people' } });
    await fireEvent.click(getByText('Continue'));
    expect(onSubmit).toHaveBeenCalledWith('Acme', 'Eng', 'YC S23, ~12 people');
  });

  it('Cancel fires onCancel', async () => {
    const onCancel = vi.fn();
    const { getByText } = render(ApplicationSetup, {
      props: { onSubmit: vi.fn(), onCancel }
    });
    await fireEvent.click(getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});
