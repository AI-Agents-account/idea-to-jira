ARG OPENCLAW_VERSION=2026.7.1-2

FROM node:24.19.0-bookworm-slim AS plugin-build

WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/idea-to-jira-plugin/package.json packages/idea-to-jira-plugin/package.json
RUN npm ci --ignore-scripts
COPY scripts/plugin-build-fingerprint.mjs scripts/plugin-build-fingerprint.mjs
COPY packages/idea-to-jira-plugin packages/idea-to-jira-plugin
RUN node scripts/plugin-build-fingerprint.mjs > /src/PLUGIN_BUILD_FINGERPRINT \
  && npm run build

# Keep the deployment on an explicit reviewed OpenClaw release.
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}

USER root
WORKDIR /opt/openclaw-plugins/idea-to-jira
COPY packages/idea-to-jira-plugin/package.json ./package.json
COPY packages/idea-to-jira-plugin/openclaw.plugin.json ./openclaw.plugin.json
COPY --from=plugin-build /src/packages/idea-to-jira-plugin/dist ./dist
COPY --from=plugin-build /src/PLUGIN_BUILD_FINGERPRINT ./BUILD_FINGERPRINT
RUN npm install --omit=dev --ignore-scripts --legacy-peer-deps \
  && npm cache clean --force

COPY scripts/healthcheck.mjs scripts/create-readiness.mjs scripts/pilot-readiness.mjs scripts/pilot-env-check.mjs scripts/storage-container-check.mjs /app/scripts/
COPY scripts/pilot-container-entrypoint.sh /app/scripts/pilot-container-entrypoint.sh
RUN chmod 0555 /app/scripts/pilot-container-entrypoint.sh \
  && chown -R node:node /opt/openclaw-plugins/idea-to-jira /app/scripts/healthcheck.mjs /app/scripts/create-readiness.mjs /app/scripts/pilot-readiness.mjs /app/scripts/pilot-env-check.mjs /app/scripts/storage-container-check.mjs /app/scripts/pilot-container-entrypoint.sh
USER node
ENTRYPOINT ["/app/scripts/pilot-container-entrypoint.sh"]
