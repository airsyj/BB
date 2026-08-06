# 报备系统容器镜像（CloudBase 云托管）
FROM node:18-alpine

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY package.json ./
RUN npm install --omit=dev

# 复制应用代码（config.json / data / uploads 已在 .dockerignore 排除）
COPY . .

# 容器内监听端口 = 控制台「服务端口」配置值（CloudBase 会把该值注入为 PORT 环境变量）；
# 若平台未注入 PORT，则回退到 server.js 默认值 3000。
# 请保证控制台「服务端口」与此保持一致（本次部署填 3000）。
EXPOSE 3000

CMD ["node", "server.js"]
