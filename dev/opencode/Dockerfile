FROM node:24.8.0-bookworm-slim@sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85

ARG OPENCODE_VERSION=1.18.30

RUN npm install --global "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force \
    && opencode --version | grep -Fx "${OPENCODE_VERSION}" \
    && groupadd --gid 65532 opencode \
    && useradd --uid 65532 --gid 65532 --home-dir /home/opencode --create-home --shell /usr/sbin/nologin opencode \
    && install -d -o 65532 -g 65532 /workspace /home/opencode/.local/share/opencode /home/opencode/.cache/opencode /tmp/opencode

COPY --chown=65532:65532 opencode.json /etc/opencode/opencode.json
COPY --chown=65532:65532 entrypoint.sh /usr/local/bin/duegood-opencode-entrypoint

USER 65532:65532
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/duegood-opencode-entrypoint"]
