#!/usr/bin/env bash
# BHTXweb 部署脚本 —— 在服务器上执行：bash /home/ubuntu/bhtxweb/deploy.sh
set -euo pipefail
cd /home/ubuntu/bhtxweb

# nvm 安装的 node 不在非交互 shell 的 PATH 里，手动补上（取版本号最大的目录）
export PATH="$(ls -d $HOME/.nvm/versions/node/*/bin 2>/dev/null | tail -1):$PATH"
command -v node >/dev/null || { echo "❌ 找不到 node"; exit 1; }

echo "== 1. 环境自检 =="
node -v
test -f .env || { echo "❌ 缺少 .env"; exit 1; }
grep -q "^PORT=" .env || echo "PORT=3100" >> .env
grep -q "^MONGO_URI=" .env || echo "MONGO_URI=mongodb://localhost:27017/bhtxweb" >> .env

echo "== 2. 安装依赖 =="
npm ci --omit=dev --no-audit --no-fund

echo "== 3. 语法自检 =="
node --check server.js

echo "== 4. pm2 启动/重载 =="
if pm2 describe bhtxweb >/dev/null 2>&1; then
  pm2 reload bhtxweb
else
  pm2 start ecosystem.config.js --only bhtxweb
fi
if pm2 describe bhtx-qqbot >/dev/null 2>&1; then
  pm2 reload bhtx-qqbot
else
  pm2 start ecosystem.config.js --only bhtx-qqbot
fi
pm2 save

echo "== 5. 健康检查 =="
PORT=$(grep '^PORT=' .env | cut -d= -f2 | tr -d '\r')
sleep 2
echo "首页   : HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/)"
echo "API    : HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/api/trips)"
echo "脱敏验证: nickname 出现 $(curl -s http://127.0.0.1:${PORT}/api/trips | grep -c nickname) 次（应为 0）"
pm2 list
