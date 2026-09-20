# Build context = repo root:  docker build -f infra/api.Dockerfile .
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY . .
# install only this workspace (plus the shared libs it depends on), then build libs and the service
RUN npm ci --workspace=@yc/api --include-workspace-root --include=dev \
 && npm -w @yc/waterfall run build && npm -w @yc/shared run build \
 && npm -w @yc/api run build
WORKDIR /repo/apps/api
CMD ["node", "dist/main.js"]
