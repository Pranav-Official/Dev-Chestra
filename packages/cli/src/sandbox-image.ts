/** Versioned toolchain; custom toolchains use sandbox build --file. */
export const SANDBOX_CONTAINERFILE = `FROM docker.io/library/node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep gh ca-certificates tini openssh-client && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_VERSION=2.1.319
ARG CODEX_VERSION=0.166.0
ARG OPENCODE_VERSION=2.2.5
ARG PI_VERSION=1.5.0
RUN npm install -g @anthropic-ai/claude-code@$CLAUDE_VERSION @openai/codex@$CODEX_VERSION @opencode/cli@$OPENCODE_VERSION @earendil-works/pi-coding-agent@$PI_VERSION
RUN useradd --create-home --uid 1000 --non-unique --shell /bin/sh devchestra && mkdir -p /home/devchestra/.pi/agent /home/devchestra/.pi/sessions /home/devchestra/.codex /home/devchestra/.claude /home/devchestra/.local/share/opencode && chown -R 1000:1000 /home/devchestra
ENV HOME=/home/devchestra
USER devchestra
WORKDIR /home/devchestra
`;
