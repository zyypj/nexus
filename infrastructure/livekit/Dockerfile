# LiveKit server packaged for Pterodactyl: the official binary plus an
# entrypoint that writes livekit.yaml from environment variables at startup.
# Build: docker build -t nexus-livekit infrastructure/livekit
ARG LIVEKIT_VERSION=v1.13.9
FROM livekit/livekit-server:${LIVEKIT_VERSION}

RUN apk add --no-cache ca-certificates tini \
    && adduser -D -h /home/container container
COPY livekit-entrypoint.sh /usr/local/bin/livekit-entrypoint
RUN chmod +x /usr/local/bin/livekit-entrypoint

USER container
WORKDIR /home/container
ENV LIVEKIT_PORT=7880 \
    LIVEKIT_TCP_PORT=7881
EXPOSE 7880/tcp 7880/udp 7881/tcp
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/livekit-entrypoint"]
CMD ["/livekit-server", "--config", "/home/container/livekit.yaml"]
