FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/user-service ./cmd/server

# Pull a static `migrate` binary so the K8s initContainer (which reuses this
# image with an overridden command) can run versioned migrations against the
# users-db before the app container starts.
FROM alpine:3.20 AS migrate
ARG MIGRATE_VERSION=v4.17.1
RUN apk add --no-cache wget tar \
 && wget -qO /tmp/m.tgz https://github.com/golang-migrate/migrate/releases/download/${MIGRATE_VERSION}/migrate.linux-amd64.tar.gz \
 && tar -xzf /tmp/m.tgz -C /usr/local/bin migrate

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
COPY --from=build   /out/user-service       /usr/local/bin/user-service
COPY --from=migrate /usr/local/bin/migrate  /usr/local/bin/migrate
COPY migrations                              /migrations
USER app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/user-service"]
