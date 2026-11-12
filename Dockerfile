# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
COPY web ./web
RUN cargo build --release --locked && cp target/release/rslack /rslack

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home /data rslack && mkdir -p /data && chown rslack /data
COPY --from=build /rslack /usr/local/bin/rslack
USER rslack
ENV RSLACK_HOST=0.0.0.0 \
    RSLACK_PORT=8080 \
    RSLACK_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/rslack"]
