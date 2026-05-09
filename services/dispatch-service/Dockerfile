FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json
RUN npm prune --omit=dev

FROM alpine:3.20 AS migrate
ARG MIGRATE_VERSION=v4.17.1
RUN apk add --no-cache wget tar \
 && wget -qO /tmp/m.tgz https://github.com/golang-migrate/migrate/releases/download/${MIGRATE_VERSION}/migrate.linux-amd64.tar.gz \
 && tar -xzf /tmp/m.tgz -C /usr/local/bin migrate

FROM node:20-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app -u 10001
COPY --from=build   /app/node_modules        ./node_modules
COPY --from=build   /app/dist                ./dist
COPY package.json                            ./
COPY --from=migrate /usr/local/bin/migrate   /usr/local/bin/migrate
COPY migrations                              /migrations
USER app
EXPOSE 8080
CMD ["node", "dist/index.js"]
