import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  vite: () => ({ plugins: [preact(), tailwindcss()] }),
  manifest: {
    name: 'MapHound',
    description: 'Passive source map and bundle secret scanner. Everything stays local.',
    minimum_chrome_version: '116',
    permissions: ['storage', 'sidePanel', 'offscreen', 'scripting', 'alarms'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: { default_title: 'MapHound' },
  },
});
