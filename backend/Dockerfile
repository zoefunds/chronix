# syntax=docker/dockerfile:1

# Build context is the REPO ROOT (not backend/) — required so this Dockerfile
# can also COPY the repo-level database/ migrations below. Every path here is
# therefore prefixed with backend/ except the one that intentionally reaches
# outside it. See fly.toml / scripts/deploy-fly.sh for the exact invocation.

# ---- deps stage: install all deps (incl dev) for building -----------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci

# ---- build stage: compile TypeScript ---------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY backend/package.json backend/package-lock.json* ./
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

# ---- prod-deps stage: install only production deps -------------------------
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --omit=dev

# ---- runtime stage -----------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S chronix && adduser -S chronix -G chronix

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY backend/package.json ./
# Migrations live in the repo-level database/ dir, one level above backend/ —
# this is exactly why the build context must be the repo root.
COPY database ./database

USER chronix

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
