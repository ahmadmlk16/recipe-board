# Recipe Board for a home server (ZimaOS or any Docker host).
# No dependencies to install: Node 22's built-in SQLite holds the data.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY public ./public
COPY src ./src
COPY server ./server
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    PORT=8788 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8788/healthz || exit 1
CMD ["node", "server/main.mjs"]
