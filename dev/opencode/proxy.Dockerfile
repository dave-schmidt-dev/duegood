FROM golang:1.25.1-bookworm@sha256:c423747fbd96fd8f0b1102d947f51f9b266060217478e5f9bf86f145969562ee AS build
ARG SMOKESCREEN_REVISION=609eb8931420453daf5893509be0b25b21bd9edb
COPY proxy-main.go /tmp/duegood-proxy-main.go
RUN git clone https://github.com/stripe/smokescreen.git /src \
    && cd /src \
    && git checkout --detach "${SMOKESCREEN_REVISION}" \
    && test "$(git rev-parse HEAD)" = "${SMOKESCREEN_REVISION}" \
    && cp /tmp/duegood-proxy-main.go /src/main.go \
    && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -mod=vendor -trimpath -ldflags='-s -w' -o /out/smokescreen ./

FROM debian:bookworm-20250908-slim@sha256:df52e55e3361a81ac1bead266f3373ee55d29aa50cf0975d440c2be3483d8ed3
RUN groupadd --gid 65533 smokescreen \
    && useradd --uid 65533 --gid 65533 --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin smokescreen
COPY --from=build /out/smokescreen /usr/local/bin/smokescreen
COPY --chown=65533:65533 proxy-acl.yaml /etc/smokescreen/egress-acl.yaml
USER 65533:65533
ENTRYPOINT ["/usr/local/bin/smokescreen"]
CMD ["--listen-ip=0.0.0.0", "--listen-port=4750", "--egress-acl-file=/etc/smokescreen/egress-acl.yaml", "--disable-acl-policy-action=open", "--disable-acl-policy-action=report", "--max-concurrent-requests=8", "--max-concurrent-connect-tunnels=4", "--timeout=15s", "--dns-timeout=5s"]
