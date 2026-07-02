FROM node:20-slim
WORKDIR /app
COPY package.json index.mjs ./
ENV NODE_ENV=production
# Cloud Run injects PORT; index.mjs reads it (defaults to 8080).
CMD ["node", "index.mjs"]
