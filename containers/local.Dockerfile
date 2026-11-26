FROM docker.io/library/ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap ca-certificates curl git gnupg openssh-client software-properties-common \
        build-essential docker.io docker-compose-v2 python3 util-linux \
        ccache clang-22 clang-format-22 clang-tidy-22 cmake ninja-build pkg-config \
        nasm tar gnome-desktop-testing \
        libasound2-dev libpulse-dev libaudio-dev libfribidi-dev libjack-dev \
        libsndio-dev libx11-dev libxext-dev libxrandr-dev libxcursor-dev \
        libxfixes-dev libxi-dev libxss-dev libxtst-dev libxkbcommon-dev \
        libdrm-dev libgbm-dev libgl1-mesa-dev libgles2-mesa-dev libegl1-mesa-dev \
        libdbus-1-dev libibus-1.0-dev libudev-dev libthai-dev libusb-1.0-0-dev \
        libpipewire-0.3-dev libwayland-dev libdecor-0-dev liburing-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --allow-scripts=opencode-ai corepack opencode-ai \
    && corepack enable \
    && corepack install --global yarn@1.22.22 \
    && opencode --version

RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        google-chrome-stable fonts-liberation fonts-noto-color-emoji \
    && npx --yes playwright@1.64.1 install-deps chromium firefox webkit \
    && rm -rf /var/lib/apt/lists/*

RUN ln -s /usr/bin/clang-22 /usr/local/bin/clang \
    && ln -s /usr/bin/clang++-22 /usr/local/bin/clang++ \
    && ln -s /usr/bin/clang-format-22 /usr/local/bin/clang-format \
    && ln -s /usr/bin/clang-tidy-22 /usr/local/bin/clang-tidy

WORKDIR /opt/agent-orchestrator
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/github-git-askpass.mjs scripts/contained-process-supervisor.mjs ./scripts/
RUN yarn build

COPY --chmod=755 containers/local-entrypoint.sh /usr/local/bin/local-entrypoint
ENTRYPOINT ["local-entrypoint"]
CMD ["node", "dist/main.js"]
