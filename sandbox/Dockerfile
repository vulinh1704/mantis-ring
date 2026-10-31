# The sandbox one task runs in: Node, git, Chromium's headless shell and the Mantis CLI.
# No secrets are baked in or passed at run time; the runner starts it read-only, without
# capabilities, on an internal network whose only way out is the allowlist proxy.
FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && npm install -g @vulinh1704/mantis@0.7.1 \
 && node "$(npm root -g)/@vulinh1704/mantis/node_modules/playwright/cli.js" install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

COPY static-server.mjs /opt/ring/static-server.mjs

RUN useradd --create-home --uid 10001 ring
USER ring
WORKDIR /work
CMD ["sleep", "infinity"]
