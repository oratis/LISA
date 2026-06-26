# Static site (Astro build) served by nginx on Cloud Run's $PORT (8080).
FROM nginx:1.27-alpine
COPY dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
