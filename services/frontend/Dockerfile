# Stage 1 — bundle the SPA. esbuild bundles src/app.js + its deps (Leaflet,
# fetch-event-source) into dist/app.js (IIFE) and copies Leaflet's marker
# images into dist/; the Tailwind v4 CLI compiles src/styles.css (Tailwind +
# Leaflet CSS) into dist/styles.css.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY build.mjs ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

# Stage 2 — static file server. Serves public/ (index.html) + the build
# output (app.js, styles.css, marker images). Nothing is loaded from a CDN.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/public /usr/share/nginx/html
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
