# 报备系统容器镜像（CloudBase 云托管）
FROM node:18-alpine

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY package.json ./
RUN npm install --omit=dev

# 复制应用代码（config.json / data / uploads 已在 .dockerignore 排除）
COPY . .

# 云托管健康检查默认探测 80，因此容器内监听 80；
# server.js 会读取 PORT 环境变量，本地无 PORT 时仍默认 3000
ENV PORT=80
EXPOSE 80

CMD ["node", "server.js"]
