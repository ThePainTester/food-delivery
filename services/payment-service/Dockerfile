FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/payment-service ./cmd/server

FROM alpine:3.20 AS migrate
ARG MIGRATE_VERSION=v4.17.1
RUN apk add --no-cache wget tar \
 && wget -qO /tmp/m.tgz https://github.com/golang-migrate/migrate/releases/download/${MIGRATE_VERSION}/migrate.linux-amd64.tar.gz \
 && tar -xzf /tmp/m.tgz -C /usr/local/bin migrate

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
COPY --from=build   /out/payment-service    /usr/local/bin/payment-service
COPY --from=migrate /usr/local/bin/migrate  /usr/local/bin/migrate
COPY migrations                              /migrations
USER app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/payment-service"]
