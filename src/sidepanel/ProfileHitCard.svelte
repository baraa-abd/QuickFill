<script lang="ts">
  type Props = {
    hit: { canonicalKey: string; value: string; fieldLabel: string };
    onConfirm: () => void;
    onCancel: () => void;
  };

  let { hit, onConfirm, onCancel }: Props = $props();
</script>

<div class="card col">
  <h2>Filling from profile</h2>
  <p class="muted" style="font-size: 12px;">
    Field: <strong>{hit.fieldLabel}</strong>
  </p>
  <div style="display: flex; flex-direction: column; gap: 2px;">
    <span class="muted" style="font-size: 11px;">{hit.canonicalKey}</span>
    <span style="font-size: 14px; font-weight: 500;">{hit.value}</span>
  </div>
  <div class="row" style="justify-content: space-between; margin-top: 4px;">
    <button type="button" onclick={onCancel}>Cancel</button>
    <button class="primary" type="button" onclick={onConfirm}>Confirm</button>
  </div>
</div>
