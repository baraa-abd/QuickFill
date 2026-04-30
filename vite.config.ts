import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'node:path';
import manifest from './src/manifest.config';

export default defineConfig({
  plugins: [svelte(), crx({ manifest })],
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
  build: {
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'src/sidepanel/index.html'),
        options: resolve(__dirname, 'src/options/index.html'),
        onboarding: resolve(__dirname, 'src/onboarding/index.html'),
        offscreen: resolve(__dirname, 'src/offscreen/index.html')
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 }
  }
});
