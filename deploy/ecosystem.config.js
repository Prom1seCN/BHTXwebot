// BHTXweb · pm2 配置（部署目录：/home/ubuntu/bhtxweb）
// 密钥集中在同目录 .env（Node 20 原生 --env-file），不进 git
// 注意：cluster 模式不传 node_args，--env-file 会失效（实测踩坑），必须 fork
module.exports = {
  apps: [{
    name: "bhtxweb",
    script: "server.js",
    cwd: "/home/ubuntu/bhtxweb",
    node_args: "--env-file=.env",
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    max_memory_restart: "300M",
    env: { NODE_ENV: "production" }
  }, {
    name: "bhtx-qqbot",
    script: "qqbot.js",
    cwd: "/home/ubuntu/bhtxweb",
    node_args: "--env-file=.env",
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    max_memory_restart: "200M"
  }]
};
