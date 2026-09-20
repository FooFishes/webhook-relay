FROM node:24-bookworm-slim AS web
WORKDIR /build/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM rust:1.98-bookworm AS rust
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 relay && useradd --uid 10001 --gid relay --no-create-home relay
WORKDIR /app
COPY --from=rust /build/target/release/webhook-relay /usr/local/bin/webhook-relay
COPY --from=web /build/web/dist /app/web/dist
RUN mkdir /app/data && chown relay:relay /app/data
USER relay
ENV RELAY_BIND=0.0.0.0:8080 DATABASE_URL=sqlite:///app/data/relay.db RELAY_WEB_DIR=/app/web/dist
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:8080/healthz || exit 1
CMD ["webhook-relay"]
