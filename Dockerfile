# 报备系统容器镜像（CloudBase 云托管）
FROM node:18-alpine

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY package.json ./
RUN npm install --omit=dev

# 复制应用代码（config.json / data / uploads 已在 .dockerignore 排除）
COPY . .

# 云托管「监听端口」请设为 3000（与下方一致）
EXPOSE 3000

CMD ["node", "server.js"]
