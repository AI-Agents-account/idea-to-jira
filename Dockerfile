FROM node:24.19.0-bookworm-slim AS plugin-build

WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/idea-to-jira-plugin/package.json packages/idea-to-jira-plugin/package.json
RUN npm ci --ignore-scripts
COPY packages/idea-to-jira-plugin packages/idea-to-jira-plugin
RUN npm run build

# Keep the deployment on an explicit reviewed OpenClaw release.
ARG OPENCLAW_VERSION=2026.7.1-2
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}

USER root
WORKDIR /app/extensions/idea-to-jira-plugin
COPY packages/idea-to-jira-plugin/package.json ./package.json
COPY packages/idea-to-jira-plugin/openclaw.plugin.json ./openclaw.plugin.json
COPY --from=plugin-build /src/packages/idea-to-jira-plugin/dist ./dist
RUN npm install --omit=dev --ignore-scripts --legacy-peer-deps \
  && npm cache clean --force

COPY scripts/healthcheck.mjs scripts/create-readiness.mjs scripts/storage-container-check.mjs /app/scripts/
RUN chown -R node:node /app/extensions/idea-to-jira-plugin /app/scripts/healthcheck.mjs /app/scripts/create-readiness.mjs /app/scripts/storage-container-check.mjs
USER node
