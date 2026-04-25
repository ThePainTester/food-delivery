FROM alpine:3.20 AS build
WORKDIR /src
COPY public/ ./public/
RUN find ./public -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' \) -print

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/public /usr/share/nginx/html
EXPOSE 80
