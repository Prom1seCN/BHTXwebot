# BHTXwebot（百花同行）

北化校友共建的拼车平台，两个对外形态：网页 + QQ 机器人。

## 代码与部署位置

| | 位置 |
|---|---|
| 开发机（本机 NAS） | `/home/hcn/Projects/BHTXwebot` |
| 生产（腾讯云 VPS） | `/home/ubuntu/bhtxweb` |
| 进程 | pm2：`bhtxweb`（server.js）、`bhtx-qqbot`（qqbot.js） |
| 仓库 | `github.com/Prom1seCN/BHTXwebot`，主分支 `main` |

线上标识符**仍是旧名**：MongoDB 库 `bhtxweb`、pm2 应用 `bhtxweb`、部署目录 `/home/ubuntu/bhtxweb`。仓库 2026-09-19 从 `BHTXweb` 改名 `BHTXwebot`，线上没跟着迁。

## 技术栈

- `server.js` —— **单文件** Express 后端，静态托管 + `/api/*` 同源，无跨域
- `public/` —— Vue 3 单页前端
- `qqbot.js` —— QQ 机器人薄壳，走内部接口 `/api/internal/*`
- MongoDB `bhtxweb` 库；nginx 反代 3100 端口，HTTPS

## 铁律

- **业务规则只在 `server.js`**。架构上避免并行逻辑——"改一处要改两处"的方案一律否掉。
- **脱敏三层**：对外接口绝不能返回 `nickname` 等身份字段。`deploy.sh` 里有自动校验，结果应为 0 次。
- 准入仅限 `@buct.edu.cn` 教育邮箱在校生。
- 动手前先读 `PROJECT.md`（架构与边界的唯一权威），别凭猜测改业务规则。

## 部署流程

```bash
# 1. 本机自查
cd /home/hcn/Projects/BHTXwebot
node --check server.js

# 2. 提交推送
git add -A && git commit -m "<说明>" && git push

# 3. 上生产
ssh vps 'cd /home/ubuntu/bhtxweb && git pull && bash deploy/deploy.sh'
```

`deploy/deploy.sh` 自带环境自检（.env / JWT_SECRET）、语法检查、pm2 reload、健康检查（首页与 API 状态码 + 脱敏验证）。跑完看输出，健康检查不过就别当成功。

## 文档

| 文件 | 内容 |
|---|---|
| `PROJECT.md` | 架构、数据模型、业务规则、合规、运维——原理与边界的权威 |
| `HANDOVER.md` | 项目记忆与协作铁律（**其中路径仍是 Windows 时代的 `D:\Projects\`，以本文路径为准**） |
| `docs/API.md` | 接口清单 |
| `README.md` | 面向使用者的说明 |
