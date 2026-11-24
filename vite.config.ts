import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';

/**
 * Sonner injects its stylesheet with a bare <style> element at import time. The
 * CSP only allows nonce'd styles, so that call is removed here and the same CSS
 * is imported statically from app.css instead.
 */
const sonnerStaticCss: Plugin = {
  name: 'openads:sonner-static-css',
  enforce: 'pre',
  transform(code, id) {
    if (!/node_modules\/sonner\/dist\/index\.m?js/.test(id)) return null;
    const patched = code.replace('function __insertCSS(code) {', 'function __insertCSS(code) { return;');
    if (patched === code) throw new Error('sonner no longer injects CSS the expected way; update sonnerStaticCss');
    return { code: patched, map: null };
  },
};

/** Shown in the sidebar footer; read from package.json at build time. */
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: { __OPENADS_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Pre-bundled dependencies would bypass the transform above.
  optimizeDeps: { exclude: ['sonner'] },
  ssr: { noExternal: ['sonner'] },
  build: {
    // The CSP has no data: source; every asset must be a same-origin file.
    assetsInlineLimit: 0,
  },
  plugins: [
    sonnerStaticCss,
    // OPENADS_WRANGLER_CONFIG: a private deployment config (docs/SELF_HOSTING_CLOUDFLARE.md);
    // the tracked wrangler.jsonc is a template with placeholders.
    cloudflare({
      viteEnvironment: { name: 'ssr' }, remoteBindings: false,
      ...(process.env.OPENADS_WRANGLER_CONFIG ? { configPath: process.env.OPENADS_WRANGLER_CONFIG } : {}),
    }),
    tailwindcss(),
    tanstackStart(),
    react(),
  ],
});
