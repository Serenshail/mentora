# ============================================================
# Mentora 容器镜像（华为云 SWR 托管，CCE/ECS 通用）
# 构建产物：Next.js standalone（.next/standalone/server.js）
# 镜像 tag 规范 = git 短 sha（回滚锚点，见 scripts/deploy-hw-build.mjs）
# ============================================================

# ---- 构建阶段 ----
FROM node:20-alpine AS builder
WORKDIR /app
ENV TZ=Asia/Shanghai NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# AUTH_SECRET 仅满足构建期 env 校验占位；运行期凭据经编排注入，绝不入镜像
ENV AUTH_SECRET=build-placeholder-not-a-secret
# CONTAINER_BUILD=1 → next.config.ts 产出 standalone（Vercel/本地 dev 不设此开关，走默认输出）
ENV CONTAINER_BUILD=1
RUN npm run build

# ---- 运行阶段 ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Shanghai NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 HOSTNAME=0.0.0.0
RUN apk add --no-cache tzdata \
    && addgroup -S mentora && adduser -S mentora -G mentora
COPY --from=builder --chown=mentora:mentora /app/.next/standalone ./
COPY --from=builder --chown=mentora:mentora /app/.next/static ./.next/static
COPY --from=builder --chown=mentora:mentora /app/public ./public
USER mentora
EXPOSE 3000
CMD ["node", "server.js"]