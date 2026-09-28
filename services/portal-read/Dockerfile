# syntax=docker/dockerfile:1
#
# The portal-read worker (ADR 0057 §6), built in two stages.
#
# The first stage installs the workspace from its lockfile and bundles the
# worker (build.mjs). The second is what runs, and it holds:
#  - Node;
#  - one Chromium, with the system libraries it needs;
#  - Playwright;
#  - the bundle, and beside it the launcher it starts Chromium through.
# No TypeScript, workspace source or development dependency reaches it, and
# nothing of the build context but those.
#
# Built from the repository root, because the worker runs code from
# packages/portal and packages/crypto. Dockerfile.dockerignore, beside this
# file, keeps secrets out of the context (the README has the Fly command):
#   docker build -f services/portal-read/Dockerfile -t recouple-portal-read .

FROM node:22-bookworm-slim AS build
ENV CI=1
# The pnpm that package.json's packageManager names, and that wrote the lockfile.
RUN npm install --global pnpm@10.33.0
WORKDIR /repo
# The lockfile alone first, so the download layer is reused until it changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
 && node services/portal-read/build.mjs /out

FROM node:22-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /srv
# Owned by root, and so fixed for the user the worker runs as: the bundle, and
# the launcher (launch-chromium.sh) that starts every browser with its sandbox
# and an environment of its own.
COPY --from=build /out/ /srv/
# tini, as PID 1, reaps the processes Chromium leaves behind and passes signals
# on. The Chromium installed is the one the Playwright copied beside the
# bundle drives, so the two cannot drift apart; --with-deps adds its libraries.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && node node_modules/playwright-core/cli.js install --with-deps --no-shell chromium \
 && rm -rf /var/lib/apt/lists/* \
 && test -x /srv/launch-chromium.sh

# The worker, and every browser it launches, run as the image's unprivileged
# user, which owns nothing the worker runs. It must: Chromium's sandbox will
# not start as root, and the worker refuses to start without it. The sandbox
# needs unprivileged user namespaces. The worker checks for them at start, so
# the first deploy shows whether the platform allows them; Docker's default
# seccomp profile does not, and the worker then refuses to start (README).
USER node
ENV HOME=/home/node PORT=8080
EXPOSE 8080
# The port the worker listens on is PORT's, so the check asks that one: a
# container started with another PORT is not reported unhealthy for it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 8080}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/srv/portal-read.mjs"]
