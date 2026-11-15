# Game + online relay in one image; the server only needs Docker.
#   docker compose up -d --build
FROM node:22-alpine AS build
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY . .
ARG RELAY_URL
RUN npm test && npx tsc --noEmit && VITE_NO_LAN=1 VITE_RELAY_URL=$RELAY_URL npx vite build

FROM node:22-alpine
WORKDIR /app
COPY server ./server
COPY --from=build /src/dist ./dist
USER node
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK CMD wget -qO- http://localhost:8787/health || exit 1
CMD ["node", "server/lan.ts"]
