import { defineConfig } from 'vite'

// dev: `npm run dev` + `node server/lan.ts` (after a build) lets the dev page join LAN matches too
export default defineConfig({
  define: { __BUILD__: JSON.stringify(Date.now().toString(36)) },
  server: { proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } } },
})
