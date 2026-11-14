FROM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN yarn build

FROM docker.io/library/node:24-bookworm-slim AS runtime
ARG OPENCODE_VERSION=1.18.35
ARG GH_VERSION=2.103.3
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl git openssh-client util-linux \
    && arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" -o "/tmp/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" -o /tmp/checksums.txt \
    && (cd /tmp && sha256sum --ignore-missing -c checksums.txt) \
    && tar -xzf "/tmp/gh_${GH_VERSION}_linux_${arch}.tar.gz" -C /tmp \
    && install "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh \
    && npm install --global "opencode-ai@${OPENCODE_VERSION}" \
    && rm -rf /tmp/gh* /tmp/checksums.txt /var/lib/apt/lists/* /root/.npm
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive --production && yarn cache clean
COPY --from=build /app/dist ./dist
COPY scripts/github-git-askpass.mjs ./scripts/github-git-askpass.mjs
COPY scripts/contained-process-supervisor.mjs ./scripts/contained-process-supervisor.mjs
USER node
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
