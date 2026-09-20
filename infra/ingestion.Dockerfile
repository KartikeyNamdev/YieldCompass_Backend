# Build context = repo root:  docker build -f infra/ingestion.Dockerfile .
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY . .
# install only this workspace (plus the shared libs it depends on), then build libs and the service
RUN npm ci --workspace=@yc/ingestion --include-workspace-root --include=dev \
 && npm -w @yc/waterfall run build && npm -w @yc/shared run build \
 && npm -w @yc/ingestion run build
WORKDIR /repo/services/ingestion
CMD ["node", "dist/index.js"]
