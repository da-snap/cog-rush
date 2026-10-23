import { defineConfig } from 'vite'

// dev: `npm run dev` + `node server/lan.ts` (after a build) lets the dev page join LAN matches too
export default defineConfig({
  server: { proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } } },
})
