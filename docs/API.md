# 百花同行 BHTXwebot — 后端 API 文档

> 依据 `server.js` 的**实际实现**逐条核对整理（不是从前端反推）。核对日期：2026-09-25。
> 前端调用点见 `public/app.js`（用户面）、`public/dashboard.js`（统计）、`public/manage.js`（管理面）。
> QQ 机器人不走 HTTP，经 `/api/internal/qq/*` 由服务端自调用。

---

## 0. 通用约定

| 项 | 约定 |
|---|---|
| 业务接口前缀 | **`/api`**（所有下文路径均含此前缀） |
| 页面 | `/`（主站）、`/dashboard`（统计）、`/manage`（管理），均同源 |
| 静态资源 | `/locations.json`、`/qq-bot.png`、`/qq-g-<id>.png`、`/sponsor-<type>.png`、`/vendor/*` |
| 请求/响应格式 | `application/json; charset=utf-8` |
| 请求体上限 | **6MB**（`express.json({limit:"6mb"})`，为赞助码 base64 上传放宽） |
| 错误响应 | 非 2xx 一律 `{ "message": "中文提示" }`，前端直接把 `message` 显示给用户 |
| 时间口径 | `date` = `YYYY-MM-DD`，`time` = `HH:MM`，一律按 **UTC+8** 解释（`buildTripDateTime` 用 `+08:00`） |
| 身份标识 | 字段名叫 `openid`，但本项目里**它的值就是北化邮箱**（`学号@buct.edu.cn`）。沿用旧名是为了不与 `Trip.openid`、`members[].openid` 冲突 |
| Token | JWT，`expiresIn: 7d`，载荷只有 `{ openid }`；**无状态，服务端不存不吊销** |
| CORS | 白名单：`https://bhtx.prom1se.cn`、`http://localhost:3001`、`http://127.0.0.1:3001`；`credentials: false`；其余来源不回任何 CORS 头 |
| 安全响应头 | `X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: strict-origin-when-cross-origin`；`X-Powered-By` 已关闭 |

### 鉴权档位

| 档 | 机制 | 说明 |
|---|---|---|
| `匿名` | 无 | 任何人可调，返回已脱敏数据 |
| `可选登录` | 有 `Authorization` 就解析，没有也放行 | 只影响 `isMember`/`isOrganizer` 等派生字段，不拦请求 |
| `Bearer` | `verifyToken` | 缺头/坏头/过期 → **401** `{message:"Token 无效或已过期"}` |
| `Bearer + 已认证` | `verifyToken` + `requireVerified` | 未通过邮箱认证 → **403** `{message:"为保证校友安全，请先完成北化邮箱认证"}` |
| `管理密钥` | `x-admin-key` 请求头 | 与 `process.env.ADMIN_KEY` 全等比较；**只走 header，不走 query**；不符 → 403 `{message:"无权访问"}` |
| `内部` | `internalGuard` | 仅 `127.0.0.1/::1` 来源 + key；node 本身绑 `127.0.0.1:3100`，公网唯一入口是 nginx(443) |

### 限流全表

| 位置 | 键 | 窗口 | 阈值 |
|---|---|---|---|
| 全部 `/api/*` | IP | 1 分钟 | 200 |
| `POST /api/auth/send-code` | IP | 15 分钟 | 20（兜底，真实防护在邮箱维度） |
| 同上 | **邮箱** | 60 秒 | 1 次冷却 |
| 同上 | **邮箱** | 1 小时 | 5 张码 |
| 同上 | **邮箱** | 24 小时 | 10 张码 |
| 同上 | **全局发信** | 1 小时 | 150 封告警 / 400 封熔断（`SMTP_HOURLY_MAX` 可调） |
| `POST /api/auth/web-login` | IP | 10 分钟 | 10 |
| 登录失败 | **邮箱** | 1 小时 | 错满 10 次 → 锁定该邮箱 30 分钟（拒发 + 拒登，并作废在途验证码） |
| 单张验证码 | 码 | 5 分钟（有效期） | 错满 5 次作废该码 |
| `POST /api/trips` | IP | 10 分钟 | 5 |
| `POST /api/trips` | **openid** | 1 小时 | 加入 + 发布合计 5（`JoinStat`，TTL 1 小时） |
| `POST /api/trips` | **openid** | 自然日（UTC+8） | 发布 ≤ 5（含已取消，防"发一个取消一个"） |
| `POST /api/trips` | **openid** | 进行中 | 同时 ≤ 2 个 `active`/`full` |
| `POST /api/trips/:id/join` | **openid** | 自然日（UTC+8） | 加入 ≤ 5（扫 `Trip`，退出不返还） |
| `POST /api/contributors/apply` | IP | 1 天 | 20 |
| 同上 | **openid/邮箱** | 1 天 | 5 |

---

## 1. 公开面（匿名）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/trips` | 大厅行程列表 |
| GET | `/api/trips/:id` | 行程详情（可选登录） |
| GET | `/api/trips/:id/members` | 成员列表（可选登录，按是否成员脱敏） |
| GET | `/api/qq` | QQ 机器人与群频道配置 |
| GET | `/api/contributors` | 共建者名录（只公开已通过且未隐藏的） |
| POST | `/api/contributors/apply` | 提交共建者申请 |
| GET | `/api/contributors/apply/:code` | 用申请编号查状态 |
| DELETE | `/api/contributors/apply/:code` | 撤回申请（仅 `pending` 可撤） |
| POST | `/api/auth/send-code` | 发送邮箱验证码 |
| POST | `/api/auth/web-login` | 验证码换 token |
| GET | `/locations.json` | 地点库（静态文件，与 server/qqbot 同源） |

### 1.1 行程列表与详情的下发字段

列表 `GET /api/trips` 对每条行程做**白名单式删除**：删掉 `contact`、`openid`、`nickname`、`avatar`、`members`，并追加 `isFull`。

详情 `GET /api/trips/:id` 同样删除上述字段，另外追加：

```
isFull      boolean   status === "full"
isOrganizer boolean   当前 token 的 openid 是发起人
isMember    boolean   当前用户是 status:"joined" 的成员（决定能否填车费）
costInfo    object|null  { range, estPerPerson:[低,高], actualCost, perPerson }
```

> `costInfo` 为 `null` 表示该路线不在 `COST_TABLE` 里（无预估可给）。
> 行程过期是**惰性判定**：读取时若出发时间已过且状态为 `active`/`full`，就地改写成 `expired` 并落库；另有 60 秒一次的定时任务兜底。

### 1.2 成员列表的脱敏规则

`GET /api/trips/:id/members` → `{ members: [...], contact?: string }`

- 当前用户**是该行程 joined 成员**：每人返回真实 `displayName` 与 `contact`；顶层 `contact` 为发起人联系方式。
- 否则：每人 `displayName` 一律 `"北化校友"`，不带 `contact`；顶层 `contact` 字段**不下发**（`undefined`）。
- 前端正是用 `data.contact !== undefined` 判断"我是成员"，这个语义是契约的一部分。

### 1.3 QQ 频道

`GET /api/qq` → `{ bot: QQChannel|null, groups: QQChannel[] }`（原始文档，含 `_id/kind/label/number/qr/link/updatedAt`）

| 字段 | 含义 |
|---|---|
| `kind` | `"bot"` 或 `"group"` |
| `label` | 群备注名，可空 |
| `number` | 机器人 QQ 号 / 群号，≤20 字 |
| `link` | **加群或机器人主页链接**（`http(s)://` 开头，≤300 字）。有值时前端用 `qr-box` 组件现场绘制二维码 |
| `qr` | `public/` 下的**文件名**（不是 URL！前端拼 `'/' + qr + '?v=' + updatedAt`）。仅作 `link` 为空时的回退 |

> 优先级：`link` > `qr` > 都不显示。两者都空时该卡片仍会因 `number` 存在而显示"复制号码"。

### 1.4 共建者名录与申请

`GET /api/contributors` → `[{ _id, name, role, link }]`，条件 `hidden:false && pending:false`，按 `order` 升序。

`POST /api/contributors/apply` 请求：

```json
{ "name": "希望展示的 ID", "role": "一句话介绍", "ref4": "核实信息", "channel": "alipay|wechat" }
```

- `name` 必填 ≤20；`role` ≤30；`ref4` ≤20（**仅管理员可见**，不是"推荐人"）；`link` 若提供必须 `http(s)://` 开头。
- 同名已有 `pending` 条目 → 400。
- 成功返回 `{ code: "6 位申请编号" }`，申请人凭它查询/撤回；前端存在 localStorage `bhtxweb_contrib_apply`。

`GET /api/contributors/apply/:code` → `{ found, status, name }`；`found:false` 时前端清掉本地记录。

---

## 2. 用户面（Bearer，写操作另需已认证）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/auth/send-code` | 匿名 | `{emailPrefix}`，学号须 6–15 位纯数字 |
| POST | `/api/auth/web-login` | 匿名 | `{emailPrefix, code}` → `{token, isVerified, email, displayName}` |
| POST | `/api/trips` | Bearer + 已认证 | 发布行程 |
| POST | `/api/trips/:id/join` | Bearer + 已认证 | `{contact}` 加入 |
| POST | `/api/trips/:id/leave` | Bearer | 退出，返回更新后的 `trip` |
| PUT | `/api/trips/:id/status` | Bearer | `{action:"complete"|"cancel"}`，仅发起人 |
| PUT | `/api/trips/:id/cost` | Bearer + 已认证 | `{actualCost}`，任何已加入成员 |
| GET | `/api/trips/my` | Bearer | 我发布的（无分页，返回全部） |
| GET | `/api/trips/joined` | Bearer | 我加入的（无分页，返回全部） |
| GET | `/api/mytrips/active` | Bearer | 我的进行中行程（机器人/提醒用） |
| GET | `/api/user/profile` | Bearer | `{openid,email,isVerified,displayName,displayNameUpdatedAt,contact,qqBound}` |
| PUT | `/api/user/display-name` | Bearer | `{displayName}` ≤12 字，一天限改一次 |
| PUT | `/api/user/contact` | Bearer | `{contact}` ≤50 字 |
| POST | `/api/user/qq-unbind` | Bearer | 解除 QQ 绑定 |
| POST | `/api/analytics/event` | **Bearer** | `{type, tripId}` 埋点（**不是匿名**，游客不上报） |

### 2.1 发布行程

```json
POST /api/trips
{ "from":"北化北区", "to":"北京南站", "date":"2026-09-26", "time":"14:30",
  "contact":"wx 或手机号", "remark":"可选 ≤100 字", "capacity":3 }
```

- `from`/`to` ≤30 字；自定义地点由前端把 `fromCustom`/`toCustom` 填进 `from`/`to`。
- `contact` **可缺省**：不带时服务端回退到 `User.contact`（QQ 机器人发布就走这条）。
- `capacity` 语义是**含发起人的总人数**：`2`/`3`/`4`，默认 `3`，服务端 `clamp(2,4)`。满员判定为 `headcount` 达到 `capacity - 1`。
  前端"乘客人数"按钮的 `form.seats` 是 `1/2/3`（界面显示 2/3/4 人），映射 `[2,3,4][seats-1]`。
- 出发时间必须晚于当前时间。
- 成功返回 `{ message:"发布成功", trip, recommendations }`（`recommendations` 是同路线推荐）。
- 失败码：400 字段/时间/并发问题，401 未登录，403 未认证，429 触发任一频率上限。

### 2.2 状态与费用

`PUT /api/trips/:id/status`：`action` 只接受 `complete` 或 `cancel`，其他 400；已是 `completed`/`cancelled` 再转被拒；`complete` 要求已过出发时间。`cancel` 会把成员置 `cancelled` 并入队 QQ 通知。

`PUT /api/trips/:id/cost`：

- `actualCost` 传 `undefined` / `null` / `""` **都算清空** → `{message:"已清除费用", actualCost:null}`。
- 数值范围 `0–999`，落库保留两位小数；行程完成后仍可改（结算依据），改完重新通知；仅 `cancelled` 不可改。
- 非成员 → 403 `请先加入行程，才能填写费用`。

### 2.3 登录与验证码

`POST /api/auth/send-code` → 200 `{message:"验证码已发送", email}`；`code` 为 `crypto.randomInt(100000,1000000)` 的 6 位数字，5 分钟有效（`Auth.expiresAt` + Mongo TTL 自动回收）。

`POST /api/auth/web-login` → 200 `{token, isVerified:true, email, displayName}`；验证码错 5 次作废当前码；邮箱 1 小时内错满 10 次锁定 30 分钟。

---

## 3. 统计与管理面（`x-admin-key`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/stats/funnel?days=N` | 转化漏斗 + 费用（`days` 上限 90，默认 30） |
| GET | `/api/stats/dashboard?days=N` | 看板全量：`{days, funnel, fee, daily[], match, totals, generatedAt}` |
| GET/POST/PUT/DELETE | `/api/manage/contributors[/:id]` | 名录增删改与排序，`POST /:id/move` 移动 |
| GET/POST/DELETE | `/api/manage/sponsor[/:type]` | 赞助收款码，`type ∈ {wechat, alipay}` |
| PUT | `/api/manage/qq/bot` | 更新机器人条目（`number` / `link` / `data` 图片） |
| POST/PUT/DELETE | `/api/manage/qq/channels/groups[/:id]` | 群频道增删改 |

`/api/stats/dashboard` 的 `totals` 是**全量口径**（不受 `days` 影响，也不受埋点 90 天 TTL 影响）：

```json
{ "verifiedUsers": 0, "trips": 0, "cancelled": 0, "matched": 0,
  "costActual": 0, "costFilled": 0, "since": "ISO|null", "daysOnline": 0 }
```

> 故意**不含**"历史加入人次"：`Trip.headcount` 是当前在车人数（退出即减），历史人次只存在于 90 天 TTL 的埋点里。
> `totals` 聚合失败时为 `null`，看板其余部分照常显示。

图片上传契约（赞助码与 QQ 码共用 `decodeImageUpload`）：请求体 `{ data: "<纯 base64，无 dataURL 前缀>" }`，解码后 ≤3MB，且必须以 PNG(`0x89 0x50`) 或 JPG(`0xFF 0xD8`) 魔数开头；服务端写盘到 `public/`，数据库只记文件名。

---

## 4. 内部面（`internalGuard`：仅回环 + key）

QQ 机器人 `qqbot.js` 经服务端自调用（`http://127.0.0.1:3100/api/...`）访问，**不应暴露给公网客户端**：

```
POST /api/internal/qq/proxy            代理执行公开接口（带伪 IP）
POST /api/internal/qq/whoami           由 QQ openid 反查绑定身份
POST /api/internal/qq/bind-start       发起绑定
POST /api/internal/qq/bind-check       校验绑定
POST /api/internal/qq/unbind           解绑
POST /api/internal/qq/notify-pull      拉取待推送通知
POST /api/internal/qq/notify-members   成员变动通知文案
POST /api/internal/qq/reminder-due     出发前 1 小时提醒名单
POST /api/internal/qq/reminder-sent    回执已发送
POST /api/internal/qq/groups           群注册/查询
POST /api/internal/qq/trip-lookup      行程号查详情（响应瘦身）
POST /api/internal/qq/manual-broadcast 手动播报
POST /api/internal/qq/broadcast-today  每日 4 档定时播报（按 slot 去重）
GET  /api/internal/qq/locations        地点库
```

---

## 5. 数据模型（MongoDB 库 `bhtxweb`）

| 集合 | 用途 | 关键字段 | TTL |
|---|---|---|---|
| `trips` | 行程 | `from to date time openid status tripType remark capacity headcount members[] tripNo actualCost feeHint` | — |
| `users` | 身份 | `openid(=邮箱) email qqOpenId isVerified contact displayName displayNameUpdatedAt` | — |
| `auths` | 在途验证码 | `email code expiresAt lastSentAt failCount` | `expiresAt`（到点回收） |
| `authguards` | **邮箱维度防护** | `email sends[] fails failSince lockedUntil` | `updatedAt` + 30 天 |
| `smtpquotas` | **全局发信熔断** | `key("smtp-YYYY-MM-DDTHH") count` | `createdAt` + 2 小时 |
| `analyticsevents` | 埋点 | `type tripId openid extra` | `createdAt` + **90 天** |
| `joinstats` | 加入/发布小时计数 | `openid joinedAt` | `joinedAt` + 1 小时 |
| `contributors` | 名录 | `name role link hidden pending channel ref4 code order` | — |
| `qqchannels` | QQ 频道 | `kind label number qr link` | — |
| `qqnotifies` / `qqreminded` / `qqdailyquota` / `qqgroups` | 机器人推送与配额 | — | 2 天 / 30 天 / 2 天 / — |

`Trip.status`：`active`（默认，可加入）/ `full` / `completed` / `cancelled`（界面显示"已下架"）/ `expired`。
`Trip.tripType` 只有 `scheduled`（小程序时代的"即刻出发"已删除）。
`members[]`：`{ openid, nickname, displayName, role: organizer|passenger, seat, contact, joinedAt, status: joined|cancelled }`。

---

## 6. OpenAPI 3.0

```yaml
openapi: 3.0.3
info:
  title: 百花同行 BHTXwebot API
  version: 3.0.0
  description: |
    依据 server.js 实际实现整理。所有路径含 /api 前缀。
    鉴权四档：匿名 / Bearer(JWT) / Bearer+已认证 / x-admin-key；另有仅回环的内部面未列入。
servers:
  - url: https://bhtx.prom1se.cn/api
  - url: http://localhost:3001/api
tags:
  - { name: auth }
  - { name: trips }
  - { name: user }
  - { name: public }
  - { name: admin }
components:
  parameters:
    TripId:
      name: id
      in: path
      required: true
      schema: { type: string, description: 行程 _id（Mongo ObjectId） }
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer, bearerFormat: JWT }
    adminKey:   { type: apiKey, in: header, name: x-admin-key }
  responses:
    BadRequest:
      description: 参数或业务校验失败
      content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
    Unauthorized:
      description: 缺少或无效的 Authorization 头 / token 过期
      content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
    Forbidden:
      description: 未完成邮箱认证（403）或密钥不符（403）
      content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
    TooMany:
      description: 触发限流
      content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
  schemas:
    Error:
      type: object
      properties: { message: { type: string } }
    Trip:
      type: object
      description: 公开下发版本；contact/openid/nickname/avatar/members 一律不下发
      properties:
        _id:        { type: string }
        from:       { type: string, maxLength: 30, example: 北化北区 }
        to:         { type: string, maxLength: 30, example: 北京南站 }
        date:       { type: string, format: date }
        time:       { type: string, example: "14:30" }
        status:     { type: string, enum: [active, full, completed, cancelled, expired] }
        tripType:   { type: string, enum: [scheduled] }
        tripNo:     { type: string, description: 行程号 YYMMDD + 当天序号 }
        remark:     { type: string, maxLength: 100 }
        capacity:   { type: integer, minimum: 2, maximum: 4, description: 含发起人的总人数 }
        headcount:  { type: integer, description: 当前已加入人数（不含发起人） }
        actualCost: { type: number, nullable: true, description: 实际总车费，null=未填 }
        feeHint:    { type: string }
        isFull:     { type: boolean }
        isOrganizer:{ type: boolean }
        isMember:   { type: boolean }
        costInfo:
          nullable: true
          type: object
          properties:
            range:        { type: array, items: { type: number } }
            estPerPerson: { type: array, items: { type: number } }
            actualCost:   { type: number, nullable: true }
            perPerson:    { type: number, nullable: true }
    Member:
      type: object
      properties:
        displayName: { type: string, description: 非成员一律「北化校友」 }
        contact:     { type: string, description: 仅成员可见 }
    UserProfile:
      type: object
      properties:
        openid:      { type: string, description: 值即北化邮箱 }
        email:       { type: string }
        isVerified:  { type: boolean }
        displayName: { type: string }
        displayNameUpdatedAt: { type: string, format: date-time, nullable: true }
        contact:     { type: string }
        qqBound:     { type: boolean }
    QQChannel:
      type: object
      properties:
        _id:    { type: string }
        kind:   { type: string, enum: [bot, group] }
        label:  { type: string }
        number: { type: string, maxLength: 20 }
        link:   { type: string, maxLength: 300, description: 有值则前端绘制二维码，优先于 qr }
        qr:     { type: string, description: public/ 下的文件名（不是 URL），link 为空时回退 }
    Totals:
      type: object
      properties:
        verifiedUsers: { type: integer }
        trips:         { type: integer }
        cancelled:     { type: integer }
        matched:       { type: integer }
        costActual:    { type: number }
        costFilled:    { type: integer }
        since:         { type: string, format: date-time, nullable: true }
        daysOnline:    { type: integer }
paths:
  /auth/send-code:
    post:
      tags: [auth]
      summary: 发送邮箱验证码
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [emailPrefix]
              properties:
                emailPrefix: { type: string, pattern: '^\d{6,15}$', example: "2024010101" }
      responses:
        '200': { description: 已发送 }
        '400': { $ref: '#/components/responses/BadRequest' }
        '429': { $ref: '#/components/responses/TooMany' }
  /auth/web-login:
    post:
      tags: [auth]
      summary: 验证码换 token
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [emailPrefix, code]
              properties:
                emailPrefix: { type: string }
                code:        { type: string, pattern: '^\d{6}$' }
      responses:
        '200':
          description: 登录成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  token: { type: string }
                  isVerified: { type: boolean }
                  email: { type: string }
                  displayName: { type: string }
        '400': { $ref: '#/components/responses/BadRequest' }
        '429': { description: 该邮箱被锁定或尝试过于频繁 }
  /trips:
    get:
      tags: [trips]
      summary: 大厅行程列表（脱敏）
      security: []
      responses:
        '200':
          description: 行程数组
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/Trip' } }
    post:
      tags: [trips]
      summary: 发布行程
      description: 需 Bearer 且邮箱已认证；受 IP、小时、每日、并发四重限制
      security: [ { bearerAuth: [] } ]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [from, to, date, time]
              properties:
                from:     { type: string, maxLength: 30 }
                to:       { type: string, maxLength: 30 }
                date:     { type: string, format: date }
                time:     { type: string, example: "14:30" }
                contact:  { type: string, maxLength: 50, description: 缺省时回退 User.contact }
                remark:   { type: string, maxLength: 100 }
                capacity: { type: integer, minimum: 2, maximum: 4, default: 3 }
      responses:
        '200': { description: 发布成功，返回 trip 与 recommendations }
        '400': { $ref: '#/components/responses/BadRequest' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '403': { $ref: '#/components/responses/Forbidden' }
        '429': { $ref: '#/components/responses/TooMany' }
  /trips/{id}:
    get:
      tags: [trips]
      summary: 行程详情（可选登录）
      security: [ {}, { bearerAuth: [] } ]
      parameters: [ { $ref: '#/components/parameters/TripId' } ]
      responses:
        '200':
          description: 详情
          content: { application/json: { schema: { $ref: '#/components/schemas/Trip' } } }
        '400': { description: 无效的行程ID }
        '404': { description: 找不到该行程 }
  /trips/{id}/members:
    get:
      tags: [trips]
      summary: 成员列表（非成员只见「北化校友」，不见联系方式）
      security: [ {}, { bearerAuth: [] } ]
      parameters: [ { $ref: '#/components/parameters/TripId' } ]
      responses:
        '200':
          description: 成员与发起人联系方式（后者仅成员可见）
          content:
            application/json:
              schema:
                type: object
                properties:
                  members: { type: array, items: { $ref: '#/components/schemas/Member' } }
                  contact: { type: string, nullable: true }
  /trips/{id}/join:
    post:
      tags: [trips]
      summary: 加入行程
      security: [ { bearerAuth: [] } ]
      parameters: [ { $ref: '#/components/parameters/TripId' } ]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties: { contact: { type: string, maxLength: 50 } }
      responses:
        '200': { description: 已加入 }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '403': { $ref: '#/components/responses/Forbidden' }
        '409': { description: 已满员 / 已结束 / 已加入过 }
        '429': { description: 超过小时或每日上限 }
  /trips/{id}/leave:
    post:
      tags: [trips]
      summary: 退出行程
      security: [ { bearerAuth: [] } ]
      parameters: [ { $ref: '#/components/parameters/TripId' } ]
      responses:
        '200': { description: 已退出，返回更新后的 trip }
        '401': { $ref: '#/components/responses/Unauthorized' }
  /trips/{id}/status:
    put:
      tags: [trips]
      summary: 完成或下架行程（仅发起人）
      security: [ { bearerAuth: [] } ]
      parameters: [ { $ref: '#/components/parameters/TripId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [action]
              properties:
                action: { type: string, enum: [complete, cancel] }
      responses:
        '200': { description: 操作成功 }
        '400': { description: 动作非法、状态不可再转、或出发时间未到 }
  /trips/{id}/cost:
    put:
      tags: [trips]
      summary: 填写或清空实际车费（任何已加入成员）
      security: [ { bearerAuth: [] } ]
      parameters: [ { $ref: '#/components/parameters/TripId' } ]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                actualCost:
                  description: 0–999 的数值；null、空串或不传都表示清空
                  oneOf:
                    - { type: number, minimum: 0, maximum: 999 }
                    - { type: 'null' }
                    - { type: string, enum: [''] }
      responses:
        '200': { description: 已更新或已清除 }
        '400': { description: 费用超出范围，或行程已取消 }
        '403': { description: 非成员无权填写 }
  /trips/my:
    get:
      tags: [trips]
      summary: 我发布的行程（全部，无分页）
      security: [ { bearerAuth: [] } ]
      responses:
        '200':
          description: 行程数组
          content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/Trip' } } } }
  /trips/joined:
    get:
      tags: [trips]
      summary: 我加入的行程（全部，无分页）
      security: [ { bearerAuth: [] } ]
      responses:
        '200': { description: 行程数组 }
  /mytrips/active:
    get:
      tags: [trips]
      summary: 我的进行中行程
      security: [ { bearerAuth: [] } ]
      responses: { '200': { description: 行程数组 } }
  /user/profile:
    get:
      tags: [user]
      summary: 个人资料（无记录时自动建壳）
      security: [ { bearerAuth: [] } ]
      responses:
        '200':
          description: 资料
          content: { application/json: { schema: { $ref: '#/components/schemas/UserProfile' } } }
  /user/display-name:
    put:
      tags: [user]
      summary: 修改展示 ID（≤12 字，一天一次）
      security: [ { bearerAuth: [] } ]
      requestBody:
        required: true
        content: { application/json: { schema: { type: object, required: [displayName], properties: { displayName: { type: string, maxLength: 12 } } } } }
      responses: { '200': { description: 新 ID }, '400': { description: 太频繁或格式不符 } }
  /user/contact:
    put:
      tags: [user]
      summary: 修改联系方式（≤50 字）
      security: [ { bearerAuth: [] } ]
      requestBody:
        required: true
        content: { application/json: { schema: { type: object, required: [contact], properties: { contact: { type: string, maxLength: 50 } } } } }
      responses: { '200': { description: 新联系方式 } }
  /user/qq-unbind:
    post:
      tags: [user]
      summary: 解除 QQ 绑定
      security: [ { bearerAuth: [] } ]
      responses: { '200': { description: 已解除 } }
  /analytics/event:
    post:
      tags: [user]
      summary: 埋点上报（需登录；前端 fire-and-forget，失败静默）
      security: [ { bearerAuth: [] } ]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [type]
              properties:
                type:   { type: string, example: contact_copy }
                tripId: { type: string, description: 非行程类事件传空串，服务端归一为 undefined }
      responses: { '200': { description: 已接收 } }
  /qq:
    get:
      tags: [public]
      summary: QQ 机器人与群频道
      security: []
      responses:
        '200':
          description: bot 与 groups
          content:
            application/json:
              schema:
                type: object
                properties:
                  bot:     { $ref: '#/components/schemas/QQChannel' }
                  groups:  { type: array, items: { $ref: '#/components/schemas/QQChannel' } }
  /contributors:
    get:
      tags: [public]
      summary: 共建者名录（仅已通过且未隐藏）
      security: []
      responses:
        '200':
          description: 名录
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    _id: { type: string }
                    name: { type: string }
                    role: { type: string }
                    link: { type: string }
  /contributors/apply:
    post:
      tags: [public]
      summary: 提交共建者申请
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name:    { type: string, maxLength: 20 }
                role:    { type: string, maxLength: 30 }
                ref4:    { type: string, maxLength: 20, description: 核实信息，仅管理员可见 }
                channel: { type: string, enum: [alipay, wechat, ''] }
      responses:
        '200': { description: 返回 6 位申请编号 }
        '400': { description: 缺字段或同名待审 }
        '429': { description: 超过 IP 或身份维度上限 }
  /contributors/apply/{code}:
    parameters: [ { name: code, in: path, required: true, schema: { type: string, pattern: '^\d{6}$' } } ]
    get:
      tags: [public]
      summary: 查询申请状态
      security: []
      responses: { '200': { description: '{found, status, name}' } }
    delete:
      tags: [public]
      summary: 撤回申请（仅 pending 可撤）
      security: []
      responses: { '200': { description: 已撤回 }, '400': { description: 不可撤回 } }
  /stats/funnel:
    get:
      tags: [admin]
      summary: 转化漏斗
      security: [ { adminKey: [] } ]
      parameters: [ { name: days, in: query, schema: { type: integer, minimum: 1, maximum: 90, default: 30 } } ]
      responses: { '200': { description: '{days, funnel, fee}' }, '403': { $ref: '#/components/responses/Forbidden' } }
  /stats/dashboard:
    get:
      tags: [admin]
      summary: 看板全量数据
      security: [ { adminKey: [] } ]
      parameters: [ { name: days, in: query, schema: { type: integer, minimum: 1, maximum: 90, default: 30 } } ]
      responses:
        '200':
          description: 漏斗 + 按日序列 + 撮合健康度 + 累计总量
          content:
            application/json:
              schema:
                type: object
                properties:
                  days:  { type: integer }
                  funnel: { type: object, additionalProperties: { type: integer } }
                  fee:   { type: object }
                  daily: { type: array, items: { type: object } }
                  match: { type: object }
                  totals: { $ref: '#/components/schemas/Totals' }
                  generatedAt: { type: string, format: date-time }
        '403': { $ref: '#/components/responses/Forbidden' }
  /manage/qq/bot:
    put:
      tags: [admin]
      summary: 更新机器人条目
      security: [ { adminKey: [] } ]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                number: { type: string, maxLength: 20 }
                link:   { type: string, maxLength: 300, description: 必须 http(s):// 开头；空串=改回图片模式 }
                data:   { type: string, description: 纯 base64 图片，≤3MB，PNG/JPG }
      responses: { '200': { description: 已保存 }, '400': { description: 链接或图片非法 } }
  /manage/qq/channels/groups:
    post:
      tags: [admin]
      summary: 新增群（群号已存在则合并）
      security: [ { adminKey: [] } ]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                label:  { type: string, maxLength: 20 }
                number: { type: string, maxLength: 20 }
                link:   { type: string, maxLength: 300 }
                data:   { type: string, description: 纯 base64 图片 }
      responses: { '200': { description: 已添加或已合并 }, '400': { description: 至少填一项 / 图片非法 } }
  /manage/qq/channels/groups/{id}:
    parameters: [ { name: id, in: path, required: true, schema: { type: string } } ]
    put:    { tags: [admin], summary: 修改群, security: [ { adminKey: [] } ], responses: { '200': { description: 已保存 } } }
    delete: { tags: [admin], summary: 删除群（连带删二维码文件）, security: [ { adminKey: [] } ], responses: { '200': { description: 已删除 } } }
  /manage/sponsor:
    get:  { tags: [admin], summary: 收款码状态, security: [ { adminKey: [] } ], responses: { '200': { description: 各类型是否存在与更新时间 } } }
    post: { tags: [admin], summary: 上传收款码, security: [ { adminKey: [] } ], responses: { '200': { description: 已更新 }, '400': { description: 图片非法 } } }
  /manage/sponsor/{type}:
    delete:
      tags: [admin]
      summary: 删除收款码
      security: [ { adminKey: [] } ]
      parameters: [ { name: type, in: path, required: true, schema: { type: string, enum: [wechat, alipay] } } ]
      responses: { '200': { description: 已删除 } }
  /manage/contributors:
    get:  { tags: [admin], summary: 名录（含 pending 与隐藏）, security: [ { adminKey: [] } ], responses: { '200': { description: 数组 } } }
    post: { tags: [admin], summary: 新增名录条目, security: [ { adminKey: [] } ], responses: { '200': { description: 已添加 } } }
```

> 管理面的名录子接口（`/manage/contributors/:id`、`/:id/move`）与内部面（`/api/internal/qq/*`）未展开写 OpenAPI——前者是后台自用，后者只接受回环请求，都不该交给外部客户端调用。

---

## 7. 与"前端反推版"文档的差异

那份文档由 `app.js` 静态分析生成，凡涉及后端行为处基本是猜的。已核对出的偏差：

1. `POST /api/analytics/event` 标为匿名 → 实际**需 Bearer**，游客不上报。
2. `status` 枚举写成 `open` → 实际是 **`active`**。
3. 未提 `tripType` 只剩 `scheduled`。
4. OpenAPI 的 `paths` 缺 `/api` 前缀，`servers` 又写 `/`，导入后无法调用。
5. `POST /trips` 把 `contact` 列为必填 → 实际可缺省并回退 `User.contact`。
6. `capacity` 说明错 → 它是**含发起人的总人数**，服务端 `clamp(2,4)` 默认 3。
7. `/api/qq` 的 `qr` 标成 `format: uri` → 实际是 **`public/` 下的文件名**。
8. `/api/qq` 返回结构是 `QQChannel` 原始文档，不是精简对象。
9. Trip 模型缺 `tripNo`、`headcount`、`costInfo`、`feeHint`。
10. `PUT /cost` 的清空只写了空串 → 实际 `null`/不传同样清空。
11. 共建者 `ref4` 释义错 → 是"核实信息，仅管理员可见"，且各字段有长度上限。

原稿"待确认"5 条的答案：写接口全部严格鉴权；`/trips/my`、`/trips/joined` 无分页返回全部；`/contributors` 返回 `{_id,name,role,link}` 且过滤 pending/hidden；`members.contact` 仅成员可见（前端据此判断成员身份）；`actualCost` 空值一律视为清空。
