FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim AS dotnet-sdk

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=dotnet-sdk /usr/share/dotnet /usr/share/dotnet
ENV DOTNET_ROOT=/usr/share/dotnet \
    PATH="/usr/share/dotnet:${PATH}" \
    NUGET_PACKAGES=/app/.nuget/packages
COPY package.json ./
COPY server ./server
COPY agent ./agent
COPY installer ./installer
RUN apt-get update \
  && apt-get install -y --no-install-recommends libicu72 libssl3 zlib1g \
  && rm -rf /var/lib/apt/lists/* \
  && dotnet restore agent/Funnet.Gwanak.Agent.csproj -p:EnableWindowsTargeting=true \
  && dotnet restore installer/Funnet.Gwanak.Agent.Installer.csproj -p:EnableWindowsTargeting=true \
  && mkdir -p /data/releases /data/agent-builds \
  && chown -R node:node /app /data
USER node
ENV NODE_ENV=production PORT=4170 FUNNET_DATA_DIR=/data FUNNET_COOKIE_SECURE=true
EXPOSE 4170
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:4170/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/server.mjs"]
