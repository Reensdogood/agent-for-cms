FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
RUN mkdir -p /data/releases && chown -R node:node /app /data
USER node
ENV NODE_ENV=production PORT=4170 FUNNET_DATA_DIR=/data FUNNET_COOKIE_SECURE=true
EXPOSE 4170
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:4170/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/server.mjs"]
