import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [svelte({ hot: false }), svelteTesting()],
  resolve: {
    alias: {
      $shared: resolve(__dirname, 'src/shared'),
      $bg: resolve(__dirname, 'src/background'),
      $content: resolve(__dirname, 'src/content'),
      $sidepanel: resolve(__dirname, 'src/sidepanel'),
      $options: resolve(__dirname, 'src/options'),
      $onboarding: resolve(__dirname, 'src/onboarding'),
      $offscreen: resolve(__dirname, 'src/offscreen')
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.{test,spec}.ts'],
    setupFiles: ['./tests/setup.ts']
  }
});
