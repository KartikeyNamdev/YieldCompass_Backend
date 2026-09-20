# One Dockerfile for every Node service (build context = repo root).
#   docker build -f infra/node.Dockerfile --build-arg WORKSPACE=@yc/api --build-arg APP_DIR=apps/api .
FROM node:22-slim
ARG WORKSPACE
ARG APP_DIR
ARG ENTRY=dist/main.js
ENV ENTRY=${ENTRY}
ENV NODE_ENV=production
WORKDIR /repo
COPY . .
# install only this workspace (+ the shared libs it depends on), then build libs and the service
RUN npm ci --workspace=${WORKSPACE} --include-workspace-root --include=dev \
 && npm -w @yc/waterfall run build && npm -w @yc/shared run build \
 && npm -w ${WORKSPACE} run build
WORKDIR /repo/${APP_DIR}
CMD ["sh", "-c", "exec node $ENTRY"]
