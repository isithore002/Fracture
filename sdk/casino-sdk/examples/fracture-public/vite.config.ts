import { defineConfig } from 'vite';
import viteReact from '@vitejs/plugin-react';

/**
 * The game runs inside the host's iframe on a different origin, and the host
 * fetches /game.manifest.json cross-origin — CORS must stay open.
 *
 * `frame-ancestors *` is set explicitly. Several hosting presets emit
 * `X-Frame-Options: SAMEORIGIN` by default, which leaves the standalone URL
 * working while silently blanking the gallery's iframe preview. Setting the
 * CSP here keeps dev, preview and the deployed build consistent; the
 * `public/_headers` file carries the same policy to static hosts.
 */
const frameHeaders = {
  'Content-Security-Policy': 'frame-ancestors *',
  'Access-Control-Allow-Origin': '*',
};

export default defineConfig({
  plugins: [viteReact()],
  server: { port: 3200, cors: true, headers: frameHeaders },
  preview: { port: 3200, cors: true, headers: frameHeaders },
  build: { target: 'es2022' },
});
