<script lang="ts">
  type Props = { message: string };
  let { message }: Props = $props();
</script>

{#if message}
  <div class="muted" style="font-size: 12px; margin: 4px 0;">{message}</div>
{/if}
