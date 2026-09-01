# ---------- 构建阶段 ----------
FROM node:20-alpine AS build
WORKDIR /app

# 与 package.json packageManager 字段保持同版本；不用 corepack，
# 避免旧版 corepack 的签名 keyid 问题导致构建失败
RUN npm install -g pnpm@11.22.0

COPY package.json pnpm-lock.yaml tsconfig.json tsup.config.ts ./
RUN pnpm install --frozen-lockfile

COPY src ./src
RUN pnpm build

# ---------- 运行阶段 ----------
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

RUN npm install -g pnpm@11.22.0

# 只装生产依赖（fastify/yaml/zod），不带 devDependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune

COPY --from=build /app/dist ./dist

# 配置文件通过 volume 挂载，不打进镜像
EXPOSE 8402

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8402/health || exit 1

CMD ["node", "dist/cli.js", "--config", "/app/config/config.yaml"]
