FROM node:26-slim AS base
LABEL org.opencontainers.image.source="https://github.com/docmost/docmost"
# trigger-ci: retry after GHCR actions access grant (write role)

# CN mirrors for faster downloads (Tsinghua npm mirror was retired — TUNA
# now points to npmmirror; pypi mirror is still on Tsinghua).
# npm/pnpm download registry is set by the repo's .npmrc (registry=...).
# npm_config_registry is kept as a fallback for the `npm install -g pnpm`
# step which runs outside the project directory.
ENV npm_config_registry=https://registry.npmmirror.com
ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn

RUN npm install -g pnpm@11.15.1

FROM base AS builder

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS installer

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl bash \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy apps
COPY --from=builder /app/apps/server/dist /app/apps/server/dist
COPY --from=builder /app/apps/client/dist /app/apps/client/dist
COPY --from=builder /app/apps/server/package.json /app/apps/server/package.json

# Copy packages
COPY --from=builder /app/packages/editor-ext/dist /app/packages/editor-ext/dist
COPY --from=builder /app/packages/editor-ext/package.json /app/packages/editor-ext/package.json
COPY --from=builder /app/packages/base-formula/dist /app/packages/base-formula/dist
COPY --from=builder /app/packages/base-formula/package.json /app/packages/base-formula/package.json

# Copy root package files
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pnpm*.yaml /app/

# Copy patches
COPY --from=builder /app/patches /app/patches

# Copy the mirror-configured .npmrc so `pnpm install --prod` uses the same
# registry as the builder stage
COPY .npmrc /app/.npmrc

RUN chown -R node:node /app

USER node

# pnpm 11 copies packages from its content-addressable store into node_modules
# instead of hardlinking (pnpm 10 used hardlinks) and also keeps a tarball
# cache under ~/.cache/pnpm. Both are only needed during install, not at
# runtime — remove them to keep the image small (~700MB saved).
RUN pnpm install --frozen-lockfile --prod \
  && rm -rf /home/node/.local/share/pnpm /home/node/.cache/pnpm

RUN mkdir -p /app/data/storage

VOLUME ["/app/data/storage"]

EXPOSE 3000

CMD ["pnpm", "start"]
