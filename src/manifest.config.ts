import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'QuickFill',
  version: pkg.version,
  description: pkg.description,
  minimum_chrome_version: '116',

  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },

  action: {
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    },
    default_title: 'QuickFill'
  },

  background: {
    service_worker: 'src/background/index.ts',
    type: 'module'
  },

  content_scripts: [
    {
      js: ['src/content/index.ts'],
      matches: ['<all_urls>'],
      all_frames: true,
      run_at: 'document_idle'
    }
  ],

  side_panel: {
    default_path: 'src/sidepanel/index.html'
  },

  options_ui: {
    page: 'src/options/index.html',
    open_in_tab: true
  },

  // `scripting` is needed for the on-demand content-script injection fallback
  // in the SW (when a tab was already open before the extension loaded, or
  // when a content script disappeared into bfcache). The auto-inject via
  // `content_scripts` still handles the normal case.
  permissions: ['storage', 'activeTab', 'sidePanel', 'downloads', 'offscreen', 'scripting'],
  host_permissions: ['<all_urls>'],

  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },

  commands: {
    'trigger-fill': {
      suggested_key: { default: 'Alt+A' },
      description: 'Start auto-fill on the focused field'
    },
    'trigger-fill-manual': {
      suggested_key: { default: 'Alt+Shift+A' },
      description: 'Start fill with manual question highlight (skip auto-detection)'
    },
    'add-to-profile': {
      suggested_key: { default: 'Alt+S' },
      description: "Save the focused field's current value to the profile"
    }
  },

  // The offscreen document needs to be loadable by URL from the SW.
  // We deliberately do NOT list `models/*` — Transformers.js has
  // env.allowLocalModels = false (see src/offscreen/index.ts), so model
  // files come straight from the HuggingFace CDN and live in IndexedDB.
  web_accessible_resources: [
    {
      resources: ['src/offscreen/index.html'],
      matches: ['<all_urls>']
    }
  ]
});
