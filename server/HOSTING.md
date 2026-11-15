# Hosting the game and online relay

`server/lan.ts` serves the built game and relays online matches over WebSocket at `/ws`.
It has no dependencies and stores nothing.

## Run

```sh
cp .env.example .env    # set RELAY_URL and ORIGINS to your domain
docker compose up -d --build
curl localhost:8787/health   # → ok 0 rooms
```

Without Docker: `npm ci && VITE_RELAY_URL=wss://<host>/ws npm run build && ORIGINS=https://<host> node server/lan.ts` (Node 22.18+).

Machine-specific settings (extra networks, ports) go in `compose.override.yml`, which is not committed.

## Reverse proxy

Put a reverse proxy with TLS in front (the game page is HTTPS, so the relay must be `wss://`).
It must pass WebSocket upgrades and should allow long-lived connections (a match runs ~10 min).
Set `X-Real-IP` and `TRUST_PROXY=1` so the per-IP limit sees real clients.

## Environment

| Variable | Meaning |
| --- | --- |
| `PORT` | listen port (default 8787) |
| `ORIGINS` | comma-separated sites allowed to connect; empty allows all (LAN) |
| `TRUST_PROXY` | `1`: read the client IP from `X-Real-IP`. Never set it when the port is directly reachable |
| `RELAY_URL` (build) | relay address baked into the game; empty hides the Online button |

The GitHub Pages build reads `RELAY_URL` from the repo variable of the same name.

## Built-in limits

16 KB messages, flood guard (~60 chunks/s), 6 sockets per IP, 500 rooms, 20 commands per player per tick,
only plain command fields relayed, malformed commands ignored by the sim, nicknames stripped of HTML,
static files only from `dist/`.

## Maintenance

No npm packages to patch. Rebuild every month or two for Node security fixes. Restarting ends running matches.
Update: `git pull && docker compose up -d --build`.
