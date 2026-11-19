import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

const e2e = process.env.VITE_MH_E2E === '1';

export default defineConfig({
  srcDir: 'src',
  vite: () => ({ plugins: [preact(), tailwindcss()] }),
  manifest: {
    name: 'MapHound',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    minimum_chrome_version: '116',
    permissions: ['storage', 'sidePanel', 'offscreen', 'scripting', 'alarms', 'activeTab'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // E2E builds pre-grant the local test server, since a headless test cannot click the prompt.
    ...(e2e ? { host_permissions: ['http://127.0.0.1/*'] } : {}),
    action: { default_title: 'MapHound' },
  },
});
