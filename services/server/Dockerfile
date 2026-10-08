# Nexus server image. Build from the repository root:
#   docker build -f services/server/Dockerfile -t nexus-server .
#
# Works both as a plain container (data in /data) and as a Pterodactyl image
# (the egg points NEXUS_DATA_DIR at /home/container/data).

FROM rust:1-trixie AS build
WORKDIR /src
# Workspace manifests first so dependency builds are cached between edits.
COPY Cargo.toml Cargo.lock rustfmt.toml ./
COPY services/server/Cargo.toml services/server/Cargo.toml
COPY scripts/perf-bench/Cargo.toml scripts/perf-bench/Cargo.toml
RUN mkdir -p services/server/src scripts/perf-bench/src \
    && echo "fn main() {}" > services/server/src/main.rs \
    && touch services/server/src/lib.rs \
    && echo "fn main() {}" > scripts/perf-bench/src/main.rs \
    && cargo build --release --locked -p nexus-server \
    && rm -rf services/server/src
COPY services/server services/server
RUN touch services/server/src/main.rs services/server/src/lib.rs \
    && cargo build --release --locked -p nexus-server \
    && cp target/release/nexus-server /nexus-server

FROM debian:trixie-slim
# ca-certificates: HTTPS calls to LiveKit's API when it is behind TLS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -d /home/container -s /bin/sh container \
    && mkdir -p /data && chown container:container /data
COPY --from=build /nexus-server /usr/local/bin/nexus-server
COPY infrastructure/docker/nexus-entrypoint.sh /usr/local/bin/nexus-entrypoint
RUN chmod +x /usr/local/bin/nexus-entrypoint

USER container
ENV NEXUS_DATA_DIR=/data \
    NEXUS_HOST=0.0.0.0 \
    NEXUS_PORT=3000 \
    NO_COLOR=1
VOLUME ["/data"]
EXPOSE 3000
WORKDIR /home/container
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/nexus-entrypoint"]
CMD ["nexus-server", "serve"]
