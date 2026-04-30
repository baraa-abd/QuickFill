<script lang="ts">
  type Props = {
    message: string;
    retryable: boolean;
    onRetry?: () => void;
    onDismiss: () => void;
  };
  let { message, retryable, onRetry, onDismiss }: Props = $props();
</script>

{#if message}
  <div
    class="card col"
    style="border-color: var(--danger); background: #fef2f2;"
    role="alert"
  >
    <div class="error" style="margin: 0;">{message}</div>
    <div class="row" style="justify-content: flex-end; gap: 8px;">
      {#if retryable && onRetry}
        <button onclick={onRetry}>Retry</button>
      {/if}
      <button onclick={onDismiss}>Dismiss</button>
    </div>
  </div>
{/if}
