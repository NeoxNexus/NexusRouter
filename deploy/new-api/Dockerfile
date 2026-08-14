# ---------- 构建阶段 ----------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

# 只装生产依赖（fastify/yaml/zod），不带 devDependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# 配置文件通过 volume 挂载，不打进镜像
EXPOSE 8402

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8402/health || exit 1

CMD ["node", "dist/cli.js", "--config", "/app/config/config.yaml"]
