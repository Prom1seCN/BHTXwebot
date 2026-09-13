/**
 * 百花同行 Web (BHTXweb) - 云服务器端
 *
 * 版本：v3.0.0（公开使用前的开发版；QQ 官方机器人为后续接口层）
 *
 * 版本规则（2026-09-13 定）：公开使用前所有改动统称 v3.0.0，不再逐次升版；
 * 下方 W1.x 条目为合并进 v3.0.0 的历史细目。
 *
 * 与小程序版（BHTX，已永久下架，仓库冻结归档）的关系：
 *   · 本项目为独立新项目：前端全新（public/ 下的 Vue 3 网站），后端自 BHTX 迁移并清理
 *   · 身份锚点 = 北化邮箱（@buct.edu.cn）—— openid 字段的值即邮箱，不再依赖微信 openid
 *   · 撮合 / 脱敏 / 限流 / 埋点 / 费用等业务逻辑自 BHTX 继承，**只保留一份实现，不并行**
 *
 * 更新日志：
 * - W1.0.0: 网站端可用 —— 邮箱验证码直登（/api/auth/web-login）、同行大厅（首页默认）、
 *           行程详情、发布行程、我的行程、关于页；复用全部既有撮合接口
 * - W1.1.0: 移除内容审查（微信 msg_sec_check 依赖小程序用户 openid，网页版必然失败，
 *           降级逻辑等于全放行，已无意义）；新增用户联系方式（User.contact）：
 *           发布行程自动同步（最新优先）、PUT /api/user/contact 手动修改，
 *           发布/加入行程默认采用已存联系方式
 * - W1.2.0: 新增 /api/stats/dashboard 数据看板接口（漏斗复用重构为 buildFunnel 共用实现；
 *           关键事件按 UTC+8 自然日的次数序列；撮合健康度=被加入行程占比 + 平均发布→首次加入时长）；
 *           前端新增 /dashboard.html 可视化看板（复用主站设计 token，ADMIN_KEY 鉴权）
 */

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const nodemailer = require("nodemailer");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/bhtxweb"; // 新库；小程序时期的 bhtx 库保留为历史存档，不复用
const APP_ID = "wx09391efa82a43eaa";
const APP_SECRET = process.env.WX_APP_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;
// 订阅消息模板 ID（在微信公众平台-订阅消息-选用模板后填入，如留空则加入通知不生效）
const SUBSCRIBE_TEMPLATE_ID = process.env.SUBSCRIBE_TEMPLATE_ID || "";

if (!APP_SECRET) console.error("[ERROR] 缺少环境变量 WX_APP_SECRET，微信 access_token 将无法获取，请配置 .env 文件");
if (!JWT_SECRET) console.error("[ERROR] 缺少环境变量 JWT_SECRET，登录鉴权将失效（可用 `openssl rand -hex 32` 生成），请配置 .env 文件");

app.use(cors());
app.use(express.json());

// 静态文件托管：public/ 目录下的文件可通过 https://bhtx.prom1se.cn/xxx 直接访问（如 funnel.html）
app.use(express.static("public"));

const sendCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "发送过于频繁，请 15 分钟后再试" }
});

const publishLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "发布过于频繁，请 10 分钟后再试" }
});

// 网站端登录限流（防验证码暴力破解：6 位数字，10 分钟内最多 10 次）
const webLoginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "登录尝试过于频繁，请 10 分钟后再试" }
});

// 全局 API 限流：每 IP 200 次/分钟（兜底防刷；各业务接口另有更严格的专用限制）
const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "请求过于频繁，请稍后再试" }
});

// 全局限流挂在 /api 上（定义之后才能引用；放在所有业务路由之前）
app.use("/api", globalLimiter);

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "缺少或无效的 Authorization 头" });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({ message: "Token 不能为空" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || !payload.openid) {
      return res.status(401).json({ message: "Token 无效：缺少用户标识" });
    }
    req.user = { openid: payload.openid };
    next();
  } catch (err) {
    return res.status(401).json({ message: "Token 无效或已过期" });
  }
}

async function requireVerified(req, res, next) {
  try {
    const user = await mongoose.model("User").findOne({ openid: req.user.openid });
    if (!user || !user.isVerified) {
      return res.status(403).json({ message: "为保证校友安全，请先完成北化邮箱认证" });
    }
    next();
  } catch (err) {
    return res.status(500).json({ message: "服务器错误" });
  }
}

// v2.0.0 默认ID：北化校友 + 4位随机（字母数字），避免全员重名（例：北化校友1uGk）
function genSuffix(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < (len || 4); i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// v2.0.0 生成唯一默认 ID（查重 5 次，兜底时间戳后缀）
async function generateUniqueName() {
  for (let i = 0; i < 5; i++) {
    const name = `北化校友${genSuffix(4)}`;
    const exists = await mongoose.model("User").findOne({ displayName: name }).select("_id");
    if (!exists) return name;
  }
  return `北化校友${Date.now().toString(36).slice(-4)}`;
}

// v2.0.0 默认名（空 或 历史默认"北化校友"）→ 惰性升级为带随机后缀的唯一 ID；自定义名不变
async function ensureUniqueDisplayName(user) {
  if (!user) return "";
  if (user.displayName && user.displayName !== "北化校友") return user.displayName;
  const name = await generateUniqueName();
  user.displayName = name;
  await user.save();
  return name;
}

// v2.0.0 确保用户记录存在（登录/改名兜底；未认证用户也有 User 记录与默认 ID）
async function ensureUser(openid) {
  let user = await mongoose.model("User").findOne({ openid });
  if (!user) {
    user = await mongoose.model("User").create({ openid, displayName: await generateUniqueName() });
  }
  return user;
}

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected:", MONGO_URI))
  .catch((err) => console.error("MongoDB connection error:", err));

// ===== 微信 access_token（仅订阅消息通知 sendJoinNotify 使用；内容审查已随小程序停用移除）=====

let _accessToken = null;
let _tokenExpireAt = 0;

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpireAt) {
    return _accessToken;
  }

  try {
    const res = await axios.get(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APP_ID}&secret=${APP_SECRET}`
    );

    if (res.data.access_token) {
      _accessToken = res.data.access_token;
      _tokenExpireAt = Date.now() + (res.data.expires_in - 300) * 1000;
      return _accessToken;
    }

    console.error("[订阅消息] 获取access_token失败:", JSON.stringify(res.data));
    return null;
  } catch (err) {
    console.error("[订阅消息] 获取access_token异常:", err.message);
    return null;
  }
}

// ===== 数据模型 =====

const tripSchema = new mongoose.Schema({
  from: { type: String, required: true },
  to: { type: String, required: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  contact: { type: String, required: true },
  openid: { type: String, required: true },
  status: {
    type: String,
    enum: ["active", "full", "completed", "cancelled", "expired"],
    default: "active"
  },
  nickname: { type: String, default: "北化校友" },
  avatar: { type: String, default: "" },
  tripType: {
    type: String,
    enum: ["scheduled"],
    default: "scheduled"
  },
  remark: { type: String, default: "" },
  // —— 拼车撮合字段（V1.3 新增）——
  capacity: { type: Number, default: 4 },    // 总席位（司机1 + 同学数），拼2个=4，拼1个=3
  headcount: { type: Number, default: 0 },   // 已加入同行者数（不含发起人）
  organizerRole: {
    type: String,
    enum: ["organizer", "passenger"],
    default: "organizer"
  },
  members: [{
    openid: { type: String, required: true },
    nickname: { type: String, default: "北化校友" },
    displayName: { type: String, default: "北化校友" },
    role: { type: String, enum: ["organizer", "passenger"], default: "passenger" },
    seat: { type: String, default: "" },    // 座位由成员线下协商，仅保留字段（去掉 enum 限制，便于未来扩展）
    contact: { type: String, default: "" }, // v2.0.0 成员联系方式（加入时提供，成员间互看）
    joinedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ["joined", "cancelled"], default: "joined" }
  }],
  feeHint: { type: String, default: "" },     // 费用提示文案，服务端生成，前端只展示
  actualCost: { type: Number, default: null }, // v2.0.0 实际总费用（成员可填可编辑，0-999；null=未填）
  // 行程号：YYMMDD(出发日期) + 当天第几班（3 位，按创建顺序递增，一经分配不变）
  tripNo: { type: String, unique: true, sparse: true }
}, { timestamps: true });

tripSchema.index({ "members.openid": 1 });

const authSchema = new mongoose.Schema(
  {
    email: { type: String, required: true },
    code: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    lastSentAt: { type: Date, default: null }   // 上次发送时间（按邮箱 60s 冷却，防验证码轰炸）
  },
  { timestamps: true }
);

const Trip = mongoose.model("Trip", tripSchema);
const Auth = mongoose.model("Auth", authSchema);

const userSchema = new mongoose.Schema({
  // ── 身份主键 ──
  // 本项目中它的值就是北化邮箱（如 2024010101@buct.edu.cn）。
  // 沿用 openid 这个名字，是为了与既有业务字段（Trip.openid、members[].openid）保持一致，
  // 避免大规模改名带来的风险；语义上它就是"这个人是谁"。
  openid: { type: String, required: true, unique: true },

  // 认证邮箱（与 openid 同值，便于按邮箱查询与展示）
  email: { type: String, default: "" },

  // ── 外部通道标识（可以有多个，未来继续加）──
  // 通道只是"入口"，不是"身份本身"。
  // QQ 官方机器人的 user_openid 是加密假名，无法反查真实 QQ 号；绑定后可由 QQ 端反查到该身份。
  qqOpenId: { type: String, default: "" },

  isVerified: { type: Boolean, default: false },
  // —— 联系方式 ——
  // 最近一次提供的联系方式（发布行程自动同步 / 手动修改，均为最新值覆盖）；
  // 发布或加入行程时作为默认值，仅同车成员可见
  contact: { type: String, default: "" },
  // —— 自定义 ID ——
  displayName: { type: String, default: "北化校友" },
  displayNameUpdatedAt: { type: Date, default: null }  // 一天限改一次
}, { timestamps: true });

userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: "string", $ne: "" } } }
);

// 一个 QQ 账号只能绑定一个身份；空值不参与唯一约束
userSchema.index(
  { qqOpenId: 1 },
  { unique: true, partialFilterExpression: { qqOpenId: { $type: "string", $ne: "" } } }
);

const User = mongoose.model("User", userSchema);

const contactCopySchema = new mongoose.Schema({
  openid: { type: String, required: true },
  tripId: { type: String, required: true },
  copiedAt: { type: Date, default: Date.now }
});

contactCopySchema.index({ openid: 1, copiedAt: 1 }, { expireAfterSeconds: 7200 });

const ContactCopy = mongoose.model("ContactCopy", contactCopySchema);

const copyStatSchema = new mongoose.Schema({
  date: { type: String, required: true },
  count: { type: Number, default: 0 }
});

copyStatSchema.index({ date: 1 }, { unique: true });

const CopyStat = mongoose.model("CopyStat", copyStatSchema);

// ===== 埋点事件（V1.3 新增）=====
const analyticsEventSchema = new mongoose.Schema({
  type: { type: String, required: true, index: true },
  tripId: { type: mongoose.Schema.Types.ObjectId, index: true },
  openid: { type: String, index: true },
  extra: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

const AnalyticsEvent = mongoose.model("AnalyticsEvent", analyticsEventSchema);

// TTL：埋点只保留 90 天（宣传周期分析够用，防数据无限膨胀）
analyticsEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// ===== 订阅消息（V2.0 新增：有人加入行程通知发起人）=====
const subscribeSchema = new mongoose.Schema({
  openid: { type: String, required: true, index: true },
  tripId: { type: mongoose.Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ["unused", "used"], default: "unused" }
}, { timestamps: true });

const Subscribe = mongoose.model("Subscribe", subscribeSchema);

// ===== 加入/发布行程限流（v2.0.0：1小时内最多5次，加入和发布统一计数）=====
const joinStatSchema = new mongoose.Schema({
  openid: { type: String, required: true, index: true },
  joinedAt: { type: Date, default: Date.now }
});

// TTL：1 小时后自动清理（限流只关心最近 1 小时，防表无限膨胀）
joinStatSchema.index({ joinedAt: 1 }, { expireAfterSeconds: 3600 });

const JoinStat = mongoose.model("JoinStat", joinStatSchema);

// ===== QQ 机器人支撑集合（v3.0.0：通知队列 / 提醒去重 / 群注册）=====
const qqNotifySchema = new mongoose.Schema({
  type: { type: String, enum: ["join", "leave", "cost", "cancel"], required: true },
  tripId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  actorOpenid: { type: String, default: "" },
  actorName: { type: String, default: "" },
  sentAt: { type: Date, default: null }
}, { timestamps: true });
qqNotifySchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 86400 });
const QQNotify = mongoose.model("QQNotify", qqNotifySchema);

const qqRemindedSchema = new mongoose.Schema({
  tripId: { type: mongoose.Schema.Types.ObjectId, required: true },
  openid: { type: String, required: true }
}, { timestamps: true });
qqRemindedSchema.index({ tripId: 1, openid: 1 }, { unique: true });
qqRemindedSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 });
const QQReminded = mongoose.model("QQReminded", qqRemindedSchema);

const qqGroupSchema = new mongoose.Schema({
  groupOpenid: { type: String, required: true, unique: true },
  addedAt: { type: Date, default: Date.now },
  lastActiveAt: { type: Date, default: Date.now },
  lastBroadcastSlot: { type: String, default: "" }  // 已播报标记：日期-时段（如 2026-09-13-09）
});
const QQGroup = mongoose.model("QQGroup", qqGroupSchema);

// 手动群播报配额：每用户每日 2 次（TTL 2 天自动清理）
const qqDailyQuotaSchema = new mongoose.Schema({
  openid: { type: String, required: true },
  date: { type: String, required: true },
  count: { type: Number, default: 0 }
}, { timestamps: true });
qqDailyQuotaSchema.index({ openid: 1, date: 1 }, { unique: true });
qqDailyQuotaSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 2 * 86400 });
const QQDailyQuota = mongoose.model("QQDailyQuota", qqDailyQuotaSchema);

// ===== 共建者名录 =====
const contributorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  role: { type: String, default: "" },
  link: { type: String, default: "" },
  hidden: { type: Boolean, default: false },
  order: { type: Number, default: 0 }
}, { timestamps: true });
contributorSchema.index({ order: 1 });
const Contributor = mongoose.model("Contributor", contributorSchema);

async function trackEvent(type, tripId, openid, extra = {}) {
  try {
    // tripId 传空串会因 ObjectId cast 失败丢掉整条事件；非行程事件（发码/登录/改名）统一置 undefined
    await AnalyticsEvent.create({ type, tripId: tripId || undefined, openid, extra });
  } catch (err) {
    console.error("[埋点] 记录失败:", err.message);
  }
}

// 有人加入行程 → 通知发起人（一次性订阅消息，fire-and-forget）
// 模板：「活动成行通知」（编号12942）字段：thing4=活动地点(路线)、time3=活动时间、thing2=活动内容(加入者ID)、thing5=温馨提示(拼车进展)；thing 字段限 20 字，time 需 YYYY-MM-DD HH:MM
async function sendJoinNotify(organizerOpenid, trip, joinerName) {
  try {
    if (!SUBSCRIBE_TEMPLATE_ID || !organizerOpenid || !trip) return;
    // 优先消耗本行程的订阅授权（发布时按 tripId 存的）；没有则用最近的任意 unused 兜底
    let sub = await Subscribe.findOne({ openid: organizerOpenid, status: "unused", tripId: trip._id }).sort({ createdAt: -1 });
    if (!sub) {
      sub = await Subscribe.findOne({ openid: organizerOpenid, status: "unused" }).sort({ createdAt: -1 });
    }
    if (!sub) return;

    const token = await getAccessToken();
    if (!token) return;

    // 席位总数（不含发起人）
    const totalSeats = (trip.capacity || 4) - 1;

    await axios.post(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`,
      {
        touser: organizerOpenid,
        template_id: SUBSCRIBE_TEMPLATE_ID,
        page: "pages/detail/detail?id=" + trip._id,
        miniprogram_state: "formal",
        lang: "zh_CN",
        data: {
          thing4: { value: ((trip.from || "") + "→" + (trip.to || "")).slice(0, 20) },   // 活动地点=路线
          time3: { value: (trip.date || "") + " " + (trip.time || "") },                 // 活动时间=出发日期+时间
          thing2: { value: ("加入者：" + (joinerName || "有同学")).slice(0, 20) },      // 活动内容=加入者用户ID
          thing5: { value: ("已有 " + ((trip.headcount || 0) + 1) + "/" + totalSeats + " 人").slice(0, 20) } // 温馨提示=拼车进展
        }
      }
    );
    sub.status = "used";
    await sub.save();
  } catch (e) {
    console.error("[订阅消息] 发送失败:", e.message);
  }
}

// ===== 费用提示（不碰资金，V1.3 新增）=====
// 高频路线预估价区间（元），方向可逆；未收录返回 null
const COST_TABLE = {
  // 用户实测（2026-08-11）：近郊 10-16，城区 20-30，车站机场 100-300（双向同价，反向由 buildFeeHint 回退）
  "北化北区|昌平西山口": [10, 16],
  "北化北区|乐多港万达": [10, 16],
  "北化北区|南口镇": [10, 16],
  "北化北区|昌平悦荟": [20, 30],
  "北化北区|昌平区医院": [20, 30],
  "北化北区|昌平北站": [20, 30],
  "北化北区|首都机场": [100, 300],
  "北化北区|大兴机场": [100, 300],
  "北化北区|北京南站": [100, 300],
  "北化北区|北京西站": [100, 300],
  "北化北区|北京站": [100, 300],
  "北化北区|北京朝阳站": [100, 300],
  "北化北区|北京丰台站": [100, 300],
  "北化北区|清河站/北京北站": [100, 300]
};

function buildFeeHint(from, to, capacity) {
  const range = COST_TABLE[`${from}|${to}`] || COST_TABLE[`${to}|${from}`];
  if (!range) return "";
  const total = capacity - 1; // 可分摊人数（不含司机位）
  const perMin = Math.ceil(range[0] / total);
  const perMax = Math.ceil(range[1] / total);
  return `该路线预估价约${range[0]}-${range[1]}元，按${total}人约${perMin}-${perMax}元/人`;
}

// v2.0.0 人均费用：实际填写优先，未填按预估区间中值估算（统计埋点用）
function getTripPerPersonFee(trip) {
  const count = (trip.headcount || 0) + 1;
  if (count <= 0) return null;
  if (typeof trip.actualCost === "number" && trip.actualCost >= 0) {
    return Math.round(trip.actualCost / count);
  }
  const range = COST_TABLE[`${trip.from}|${trip.to}`] || COST_TABLE[`${trip.to}|${trip.from}`];
  if (!range) return null;
  return Math.round((range[0] + range[1]) / 2 / count);
}

// v2.0.0 行程费用分摊信息（预估区间/实际总费用/实际人均）
function buildCostInfo(trip) {
  const range = COST_TABLE[`${trip.from}|${trip.to}`] || COST_TABLE[`${trip.to}|${trip.from}`];
  if (!range) return null;
  const memberCount = (trip.headcount || 0) + 1;
  return {
    range,
    estPerPerson: [Math.ceil(range[0] / memberCount), Math.ceil(range[1] / memberCount)],
    actualCost: typeof trip.actualCost === "number" ? trip.actualCost : null,
    // v2.0.0 人均精确到分、向上取整（例：46/3=15.333 → 15.34）
    perPerson: typeof trip.actualCost === "number" ? Math.ceil((trip.actualCost / memberCount) * 100) / 100 : null
  };
}

// ===== 自动过期定时任务 =====
function buildTripDateTime(trip) {
  if (!trip.date || !trip.time) return null;
  const dt = new Date(`${trip.date}T${trip.time}:00+08:00`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

async function expireOverdueTrips() {
  try {
    const now = new Date();
    const activeTrips = await Trip.find({ status: "active" });
    const expiredIds = [];

    for (const trip of activeTrips) {
      const departureTime = buildTripDateTime(trip);
      if (departureTime && departureTime <= now) {
        expiredIds.push(trip._id);
      }
    }

    if (expiredIds.length > 0) {
      await Trip.updateMany(
        { _id: { $in: expiredIds } },
        { $set: { status: "expired" } }
      );
      for (const id of expiredIds) {
        trackEvent("trip_expire", id, "");
      }
      console.log(`[过期扫描] ${now.toISOString()} - 已自动过期 ${expiredIds.length} 条行程`);
    }
  } catch (err) {
    console.error("[过期扫描] 执行失败:", err.message);
  }
}

setInterval(expireOverdueTrips, 60 * 1000);
setTimeout(expireOverdueTrips, 5000);

// ===== SMTP 配置 =====
const transporter = nodemailer.createTransport({
  host: "smtp.163.com",
  port: 465,
  secure: true,
    auth: {
      user: process.env.SMTP_USER || "bhtxadmin@163.com",
      pass: process.env.SMTP_PASS
    }
});

if (!process.env.SMTP_PASS) console.error("[ERROR] 缺少环境变量 SMTP_PASS，验证码邮件将无法发送，请配置 .env 文件");

// ===== API =====

// 埋点上报（V1.3，前端 fire-and-forget）
app.post("/api/analytics/event", verifyToken, async (req, res) => {
  try {
    const { type, tripId, extra } = req.body;
    if (!type || typeof type !== "string") {
      return res.status(400).json({ message: "缺少事件类型" });
    }
    trackEvent(type, tripId, req.user.openid, extra || {});
    res.json({ message: "ok" });
  } catch (err) {
    res.status(200).json({ message: "ok" }); // 埋点失败不影响业务
  }
});

// 1) 发布行程（预约同行，支持自定义地点与备注）
app.post("/api/trips", publishLimiter, verifyToken, requireVerified, async (req, res) => {
  try {
    const { from, to, date, time, remark, capacity, organizerRole } = req.body;
    const openid = req.user.openid;
    // 发起人（发布与联系方式回退共用）
    const publisher = await User.findOne({ openid });
    // 联系方式：请求未携带时回退用户已存联系方式（QQ 机器人发布场景）
    const contact = (req.body.contact && String(req.body.contact).trim())
      ? String(req.body.contact).trim()
      : (publisher && publisher.contact) || "";

    // v2.0.0 发布与加入统一限流：1小时内最多5次（成功发布才计数）
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentJoins = await JoinStat.countDocuments({ openid, joinedAt: { $gte: oneHourAgo } });
    if (recentJoins >= 5) {
      return res.status(429).json({ message: "操作过于频繁，1小时内最多5次（加入+发布合计）" });
    }

    if (!from || !to || !date || !time || !contact) {
      return res.status(400).json({ message: "缺少必要字段" });
    }

    const departureDT = buildTripDateTime({ date, time });
    if (!departureDT || departureDT <= new Date()) {
      return res.status(400).json({ message: "出发时间必须晚于当前时间" });
    }

    // 每个用户同时最多 2 个进行中行程（不区分发起者/加入者：只要还是成员就算一个；
    // 退出后成员状态变 cancelled，自动腾出名额）
    const activeTripCount = await Trip.countDocuments({
      members: { $elemMatch: { openid, status: "joined" } },
      status: { $in: ["active", "full"] }
    });
    if (activeTripCount >= 2) {
      return res.status(400).json({ message: "你同时最多只能有2个进行中的行程，请先退出其他行程" });
    }

    const finalCapacity = Math.min(Math.max(parseInt(capacity, 10) || 4, 3), 5); // 3(再拼1) / 4(再拼2) / 5(再拼3)
    const finalRole = organizerRole === "passenger" ? "passenger" : "organizer";
    const feeHint = buildFeeHint(from, to, finalCapacity);

    // 发起人默认副驾驶
    const publisherName = publisher && publisher.displayName ? publisher.displayName : "北化校友";
    // 行程号：出发日期 YYMMDD + 当天第几班（创建顺序递增，唯一索引兜底并发，冲突自动重试）
    let trip = null;
    for (let attempt = 0; attempt < 3 && !trip; attempt++) {
      const dayCount = await Trip.countDocuments({ date });
      const candidate = date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10) + String(dayCount + 1).padStart(3, "0");
      try {
        trip = await Trip.create({
          from, to, date, time, contact,
          openid,
          nickname: publisherName,
          avatar: "",
          status: "active",
          tripType: "scheduled",
          remark: (remark && remark.trim()) ? remark.trim() : "",
          capacity: finalCapacity,
          headcount: 0,
          organizerRole: finalRole,
          feeHint,
          tripNo: candidate,
          members: [{
            openid,
            nickname: publisherName,
            displayName: publisherName,
            role: "organizer",
            seat: "",
            contact: contact.trim(),   // v2.0.0 发起人联系方式同步到成员
            status: "joined"
          }]
        });
      } catch (e) {
        if (!(e && e.code === 11000)) throw e; // 行程号撞号（并发）：换下一个号重试
      }
    }
    if (!trip) return res.status(500).json({ message: "发布失败，请重试" });

    // 同路推荐：到达地点相同或相近（组内互为相近）且出发时间相差 1 小时内的其他进行中行程
    let recommendations = [];
    try {
      const NEARBY = [
        ["乐多港万达", "昌平西山口"],
        ["昌平悦荟", "昌平区医院", "昌平站"]
      ];
      const near = (a, b) => a === b || NEARBY.some((g) => g.includes(a) && g.includes(b));
      const depMin = (t) => {
        const p = String(t.time).split(":");
        return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
      };
      const myMin = depMin(trip);
      const others = await Trip.find({
        date, status: "active", openid: { $ne: openid }, _id: { $ne: trip._id }
      }).select("tripNo time from to capacity headcount").lean();
      recommendations = others
        .filter((t) => near(t.to, to) && Math.abs(depMin(t) - myMin) <= 60)
        .sort((a, b) => depMin(a) - depMin(b))
        .slice(0, 3)
        .map((t) => ({
          tripNo: t.tripNo,
          time: t.time,
          from: t.from,
          to: t.to,
          seatsLeft: (t.capacity || 4) - 1 - (t.headcount || 0)
        }))
        .filter((r) => r.seatsLeft > 0);
    } catch (e) {
      console.error("[发布] 同路推荐失败:", e.message);
    }

    // 联系方式随行程更新（最新优先：与手动修改共用同一份 User.contact）
    if (publisher && publisher.contact !== contact.trim()) {
      publisher.contact = contact.trim();
      try { await publisher.save(); } catch (e) { console.error("[发布] 同步联系方式失败:", e.message); }
    }

    trackEvent("trip_publish", trip._id, openid, { from, to, fee: getTripPerPersonFee(trip) });
    // v2.0.0 发布成功也计入限流（加入+发布统一 1h5 次）
    try { await JoinStat.create({ openid }); } catch (e) {}
    res.json({ message: "发布成功", trip, recommendations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "发布失败" });
  }
});

app.get("/api/trips/my", verifyToken, async (req, res) => {
  try {
    const openid = req.user.openid;
    if (!openid) return res.status(400).json({ message: "缺少身份凭证" });

    const myTrips = await Trip.find({ openid }).sort({ createdAt: -1 });
    res.json(myTrips);
  } catch (err) {
    console.error("获取我的行程失败:", err);
    res.status(500).json({ message: "服务器内部错误" });
  }
});

// 我加入的行程（V1.3）
// v2.0.0 用 $elemMatch 保证 openid+status 指同一条成员记录（数组多条件不加 $elemMatch 会串元素）
app.get("/api/trips/joined", verifyToken, async (req, res) => {
  try {
    const openid = req.user.openid;
    if (!openid) return res.status(400).json({ message: "缺少身份凭证" });

    const joinedTrips = await Trip.find({
      members: { $elemMatch: { openid, status: "joined" } }
    }).sort({ createdAt: -1 });

    res.json(joinedTrips);
  } catch (err) {
    console.error("获取我加入的行程失败:", err);
    res.status(500).json({ message: "服务器内部错误" });
  }
});

// 加入行程（V1.3，并发安全：原子条件更新防超卖）
app.post("/api/trips/:id/join", verifyToken, requireVerified, async (req, res) => {
  try {
    const tripId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(tripId)) {
      return res.status(400).json({ message: "无效的行程ID" });
    }

    const openid = req.user.openid;

    // v2.0.0 加入限流：1小时内最多5次（成功才计数；加入/发布统一计数）
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentJoins = await JoinStat.countDocuments({
      openid,
      joinedAt: { $gte: oneHourAgo }
    });
    if (recentJoins >= 5) {
      return res.status(429).json({ message: "操作过于频繁，1小时内最多5次（加入+发布合计）" });
    }

    const trip = await Trip.findById(tripId);
    if (!trip) {
      return res.status(404).json({ message: "找不到该行程" });
    }
    if (trip.status !== "active") {
      return res.status(400).json({ message: "该行程当前不可加入" });
    }
    // 防重复加入（不区分角色：已退出的原发起人也可以乘客身份重新加入）
    if (trip.members.some((m) => m.openid === openid && m.status === "joined")) {
      return res.status(400).json({ message: "你已加入该行程" });
    }
    // 每用户同时最多 2 个进行中行程（不区分发起者/加入者）
    const myActiveTrips = await Trip.countDocuments({
      members: { $elemMatch: { openid, status: "joined" } },
      status: { $in: ["active", "full"] }
    });
    if (myActiveTrips >= 2) {
      return res.status(400).json({ message: "你同时最多只能有2个进行中的行程，请先退出其他行程" });
    }

    // 座位由成员线下自行协商，系统只限制人数（原子条件更新防超卖）
    const user = await User.findOne({ openid });
    const { contact } = req.body;   // 加入者联系方式（成员间互看）；未填时回退使用已存联系方式
    const memberContact = (contact && typeof contact === "string" && contact.trim())
      ? contact.trim()
      : (user && user.contact ? user.contact : "");
    // 联系方式是撮合闭环的必要信息：网页与机器人都必须先有联系方式才能加入
    if (!memberContact) {
      return res.status(400).json({ message: "请先设置联系方式后再加入行程" });
    }
    const updated = await Trip.findOneAndUpdate(
      {
        _id: tripId,
        status: "active",
        $expr: { $lt: ["$headcount", { $subtract: ["$capacity", 1] }] }
      },
      {
        $inc: { headcount: 1 },
        $push: {
          members: {
            openid,
            nickname: user && user.displayName ? user.displayName : "北化校友",
            displayName: user && user.displayName ? user.displayName : "北化校友",
            role: "passenger",
            seat: "",
            contact: memberContact,
            status: "joined"
          }
        }
      },
      { new: true }
    );

    if (!updated) {
      return res.status(409).json({ message: "行程已满员或不可加入" });
    }

    // 满员自动置位
    if (updated.headcount >= updated.capacity - 1) {
      updated.status = "full";
      await updated.save();
    }

    trackEvent("trip_join", updated._id, openid, { fee: getTripPerPersonFee(updated) });
    // 记录加入次数（限流用）
    try { await JoinStat.create({ openid }); } catch (e) {}
    // QQ 通知入队（qqbot 轮询后私聊除操作者外的全体成员）
    try {
      await QQNotify.create({
        type: "join",
        tripId: updated._id,
        actorOpenid: openid,
        actorName: (user && user.displayName) || "有同学"
      });
    } catch (e) {}
    // 通知发起人有人加入（订阅消息，静默失败不影响主流程）
    // 发起人若已退出行程，则不再通知（角色不区分后的边界处理）
    const organizerActive = updated.members.some((m) => m.openid === trip.openid && m.status === "joined");
    if (organizerActive) {
      sendJoinNotify(trip.openid, updated, user && user.displayName ? user.displayName : null);
    }
    res.json({ message: "加入成功", trip: updated });
  } catch (err) {
    console.error("加入行程失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 我的进行中行程（首页置顶：发起+加入全含）
app.get("/api/mytrips/active", verifyToken, async (req, res) => {
  try {
    const openid = req.user.openid;
    const [published, joined] = await Promise.all([
      Trip.find({ openid, status: { $in: ["active", "full"] } }),
      Trip.find({
        members: { $elemMatch: { openid, status: "joined" } },
        status: { $in: ["active", "full"] }
      })
    ]);

    const tripMap = new Map();
    [...published, ...joined].forEach((t) => tripMap.set(t._id.toString(), t));
    const trips = [...tripMap.values()].sort((a, b) => b.createdAt - a.createdAt);

    const safeTrips = trips.map((trip) => {
      const data = trip.toObject();
      delete data.contact;
      delete data.openid;
      delete data.members;
      data.isOrganizer = trip.openid === openid;
      data.isFull = trip.status === "full";   // 与大厅列表字段一致（前端共用同一套渲染）
      return data;
    });
    res.json({ trips: safeTrips });
  } catch (err) {
    console.error("获取我的进行中行程失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 保存订阅授权（发布行程后前端调用；一次性订阅：发一次即用尽）
app.post("/api/subscribe", verifyToken, async (req, res) => {
  try {
    const { tripId } = req.body;
    if (!SUBSCRIBE_TEMPLATE_ID) {
      return res.status(400).json({ message: "订阅消息未配置，请联系管理员" });
    }
    if (!mongoose.Types.ObjectId.isValid(tripId)) {
      return res.status(400).json({ message: "无效的行程ID" });
    }
    await Subscribe.create({ openid: req.user.openid, tripId });
    res.json({ message: "订阅成功" });
  } catch (err) {
    console.error("保存订阅失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 退出行程（V1.3）
app.post("/api/trips/:id/leave", verifyToken, async (req, res) => {
  try {
    const tripId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(tripId)) {
      return res.status(400).json({ message: "无效的行程ID" });
    }

    const openid = req.user.openid;
    const trip = await Trip.findById(tripId);
    if (!trip) {
      return res.status(404).json({ message: "找不到该行程" });
    }
    if (trip.status === "completed" || trip.status === "cancelled" || trip.status === "expired") {
      return res.status(400).json({ message: "该行程已结束，无法退出" });
    }
    // 不区分发起者/加入者：任何人都可以退出，剩余成员保留在行程里
    if (!trip.members.some((m) => m.openid === openid && m.status === "joined")) {
      return res.status(400).json({ message: "你尚未加入该行程" });
    }

    // 修复（v2.0.0）：数组多字段条件必须包 $elemMatch，
    // 否则 Mongo 的 $ 定位符会指向"匹配任一条件"的首个元素（曾导致 E 退出时误把发起人置为 cancelled）
    const updated = await Trip.findOneAndUpdate(
      { _id: tripId, members: { $elemMatch: { openid, status: "joined" } } },
      {
        $inc: { headcount: -1 },
        $set: { "members.$.status": "cancelled" }
      },
      { new: true }
    );

    if (!updated) {
      return res.status(400).json({ message: "退出失败，请重试" });
    }

    // 满员退出后回到招募中（补位）
    if (updated.status === "full" && updated.headcount < updated.capacity - 1) {
      updated.status = "active";
      await updated.save();
    }

    // 所有人都退出了 → 行程自动关闭（避免无人行程一直挂在大厅）
    const stillJoined = updated.members.some((m) => m.status === "joined");
    if (!stillJoined && updated.status !== "cancelled") {
      updated.status = "cancelled";
      await updated.save();
      trackEvent("trip_auto_close", updated._id, openid);
    }

    trackEvent("trip_leave", updated._id, openid, { role: trip.openid === openid ? "organizer" : "passenger" });
    // QQ 通知入队（同上；发起人自己退出时由 pull 端按 actorOpenid 过滤）
    try {
      const actor = await User.findOne({ openid }).select("displayName").lean();
      await QQNotify.create({
        type: "leave",
        tripId: updated._id,
        actorOpenid: openid,
        actorName: (actor && actor.displayName) || "一位同行者"
      });
    } catch (e) {}
    res.json({ message: "已退出行程", trip: updated });
  } catch (err) {
    console.error("退出行程失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

// v2.0.0 填写/编辑实际费用（任何已加入成员可操作；传空清除）
app.put("/api/trips/:id/cost", verifyToken, requireVerified, async (req, res) => {
  try {
    const tripId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(tripId)) {
      return res.status(400).json({ message: "无效的行程ID" });
    }
    const openid = req.user.openid;
    const trip = await Trip.findById(tripId);
    if (!trip) {
      return res.status(404).json({ message: "找不到该行程" });
    }
    // 车费在行程结束后仍可填写/修改（结算依据）；仅已取消的行程不可改
    if (trip.status === "cancelled") {
      return res.status(400).json({ message: "行程已取消，无法修改费用" });
    }
    // 仅已加入成员（含发起人）可填可编辑
    const isMember = trip.openid === openid || trip.members.some((m) => m.openid === openid && m.status === "joined");
    if (!isMember) {
      return res.status(403).json({ message: "请先加入行程，才能填写费用" });
    }

    const { actualCost } = req.body;
    if (actualCost === undefined || actualCost === null || actualCost === "") {
      // 传空 = 清除已填费用
      trip.actualCost = null;
      await trip.save();
      return res.json({ message: "已清除费用", actualCost: null });
    }

    const num = Number(actualCost);
    if (Number.isNaN(num) || num < 0 || num > 999) {
      return res.status(400).json({ message: "费用需为 0-999 元" });
    }
    trip.actualCost = Math.round(num * 100) / 100;   // 最多两位小数
    await trip.save();

    // 已完成的行程修改车费 → 重新结算通知（私聊全体成员）
    if (trip.status === "completed") {
      try { await QQNotify.create({ type: "cost", tripId: trip._id }); } catch (e) {}
    }

    const memberCount = (trip.headcount || 0) + 1;
    res.json({
      message: "费用已更新",
      actualCost: trip.actualCost,
      perPerson: Math.ceil((trip.actualCost / memberCount) * 100) / 100,   // v2.0.0 精确到分向上取整
      memberCount
    });
  } catch (err) {
    console.error("更新费用失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 行程成员列表（V1.3，脱敏）
app.get("/api/trips/:id/members", async (req, res) => {
  try {
    const tripId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(tripId)) {
      return res.status(400).json({ message: "无效的行程ID" });
    }

    const trip = await Trip.findById(tripId).select("members capacity headcount openid contact");
    if (!trip) {
      return res.status(404).json({ message: "找不到该行程" });
    }

    // 可选登录：有 token 就解析当前用户，游客也能看成员（脱敏）
    let currentOpenid = "";
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const payload = jwt.verify(authHeader.slice(7).trim(), JWT_SECRET);
        if (payload && payload.openid) currentOpenid = payload.openid;
      } catch (e) {}
    }

    // v2.0.0：发起人视为成员权限（自己发布的行程，游客带 token 也能看到真实成员）
    const isMember = trip.members.some(
      (m) => m.openid === currentOpenid && m.status === "joined"
    ) || trip.openid === currentOpenid;

    // 实时读取用户最新 ID（改名后所有行程成员列表立即生效，不依赖发布时的快照）
    const joinedRaw = trip.members.filter((m) => m.status === "joined");
    const userMap = {};
    try {
      const users = await User.find({ openid: { $in: joinedRaw.map((m) => m.openid) } }).select("openid displayName");
      users.forEach((u) => { userMap[u.openid] = u.displayName || "北化校友"; });
    } catch (e) {
      console.error("[members] 读取用户实时ID失败:", e.message);
    }

    const joinedMembers = joinedRaw.map((m) => ({
      // 非成员/游客只能看到"北化校友"，成员/发起人可见实时 ID
      displayName: isMember ? (userMap[m.openid] || m.displayName || m.nickname || "北化校友") : "北化校友",
      role: m.role,
      joinedAt: m.joinedAt,
      isOrganizer: m.openid === trip.openid,
      // v2.0.0 成员联系方式互看（仅成员/发起人可见；发起人老数据兜底用 trip.contact）
      contact: isMember
        ? ((m.contact && m.contact.trim()) || (m.openid === trip.openid ? trip.contact : "") || "")
        : undefined
    }));

    res.json({
      capacity: trip.capacity,
      headcount: trip.headcount,
      members: joinedMembers,
      contact: isMember ? trip.contact : undefined
    });
  } catch (err) {
    console.error("获取成员列表失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 发起人取消/完成行程（V1.3）
app.put("/api/trips/:id/status", verifyToken, async (req, res) => {
  try {
    const tripId = req.params.id;
    const { action } = req.body;
    if (!mongoose.Types.ObjectId.isValid(tripId)) {
      return res.status(400).json({ message: "无效的行程ID" });
    }
    if (action !== "cancel" && action !== "complete") {
      return res.status(400).json({ message: "无效的操作" });
    }

    const trip = await Trip.findById(tripId);
    if (!trip) {
      return res.status(404).json({ message: "找不到该行程" });
    }
    if (trip.openid !== req.user.openid) {
      return res.status(403).json({ message: "只有发起人可以操作" });
    }
    if (trip.status === "completed" || trip.status === "cancelled") {
      return res.status(400).json({ message: "该行程已结束" });
    }
    // 标记完成须在出发时间之后（未出发前只能取消）
    if (action === "complete") {
      const dep = buildTripDateTime(trip);
      if (!dep || dep.getTime() > Date.now()) {
        return res.status(400).json({ message: "出发时间未到，无法标记完成" });
      }
    }

    const newStatus = action === "cancel" ? "cancelled" : "completed";
    if (action === "cancel") {
      // 批量取消所有已加入成员（arrayFilters 匹配全部，$ 只更新第一个）
      await Trip.updateOne(
        { _id: tripId },
        { $set: { "members.$[elem].status": "cancelled" } },
        { arrayFilters: [{ "elem.status": "joined" }] }
      );
      // QQ 通知入队：行程取消 → 私聊全体成员（pull 端对 cancel 类型按全部出现过的成员解析）
      try { await QQNotify.create({ type: "cancel", tripId: trip._id, actorOpenid: req.user.openid }); } catch (e) {}
    }
    trip.status = newStatus;
    await trip.save();

    // 已填实际车费的行程标记完成 → 结算通知入队（私聊全体成员）
    if (newStatus === "completed" && typeof trip.actualCost === "number" && trip.actualCost > 0) {
      try { await QQNotify.create({ type: "cost", tripId: trip._id }); } catch (e) {}
    }

    trackEvent(newStatus === "cancelled" ? "trip_cancel" : "trip_complete", trip._id, req.user.openid);
    res.json({ message: newStatus === "cancelled" ? "行程已取消" : "行程已完成", trip });
  } catch (err) {
    console.error("更新行程状态失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

app.get('/api/trips', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

    // 大厅对所有人开放（含游客）：只返回撮合必需字段，
    // 发帖者身份（nickname / avatar）与联系方式、openid、成员名单一律不下发
    const trips = await Trip.find({ status: { $in: ["active", "full"] } })
      .select("-contact -openid -members -nickname -avatar")
      .sort({ date: 1, time: 1 })
      .skip(skip)
      .limit(limit);

    const safeTrips = trips.map((trip) => {
      const data = trip.toObject();
      delete data.contact;
      delete data.openid;
      delete data.members;
      delete data.nickname;
      delete data.avatar;
      data.isFull = trip.status === "full";
      return data;
    });
    res.json(safeTrips);
  } catch (err) {
    console.error('获取列表失败:', err);
    res.status(500).json({ message: '服务器内部错误' });
  }
});

app.get('/api/trips/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: '无效的行程ID' });
    }

    const trip = await Trip.findById(req.params.id).select("-contact");
    if (!trip) {
      return res.status(404).json({ message: '找不到该行程' });
    }

    // 可选登录：判断当前用户是否为发起人（游客也能看详情）
    let currentOpenid = "";
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const payload = jwt.verify(authHeader.slice(7).trim(), JWT_SECRET);
        if (payload && payload.openid) currentOpenid = payload.openid;
      } catch (e) {}
    }

    if (trip.status === 'active' || trip.status === 'full') {
      const departureTime = buildTripDateTime(trip);
      if (departureTime && departureTime <= new Date()) {
        trip.status = 'expired';
        await trip.save();
      }
    }

    const data = trip.toObject();
    delete data.contact;
    delete data.openid;
    delete data.nickname;   // 发帖者 ID：游客不可见（成员列表接口已做脱敏，这里直接不下发）
    delete data.avatar;
    // members 含每个成员的 openid 与联系方式，绝不能随详情下发；
    // 前端成员列表一律走 /api/trips/:id/members（已按是否成员做脱敏）
    delete data.members;
    data.isFull = trip.status === "full";
    data.isOrganizer = !!currentOpenid && trip.openid === currentOpenid;
    // v2.0.0 成员判断（费用填写权限）与费用分摊信息
    data.isMember = !!currentOpenid && trip.members.some((m) => m.openid === currentOpenid && m.status === "joined");
    data.costInfo = buildCostInfo(trip);
    // 埋点：行程详情浏览（仅登录用户计入漏斗，游客不计）
    if (currentOpenid) trackEvent("trip_view", trip._id, currentOpenid);
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: '服务器错误' });
  }
});

app.get("/api/trips/:id/contact", verifyToken, requireVerified, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "无效的行程ID" });
    }

    const trip = await Trip.findById(req.params.id);
    if (!trip) {
      return res.status(404).json({ message: "找不到该行程" });
    }

    const openid = req.user.openid;

    // V1.3 撮合闭环：只有已加入成员或发起人才能查看联系方式
    const isOrganizer = trip.openid === openid;
    const isMember = trip.members.some((m) => m.openid === openid && m.status === "joined");
    if (!isOrganizer && !isMember) {
      return res.status(403).json({ message: "请先加入行程，才能查看联系方式" });
    }

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const copyCount = await ContactCopy.countDocuments({
      openid,
      copiedAt: { $gte: twoHoursAgo }
    });

    if (copyCount >= 5) {
      return res.status(429).json({ message: "操作过于频繁，2小时内最多可复制5次联系方式" });
    }

    await ContactCopy.create({ openid, tripId: req.params.id });

    const today = new Date().toISOString().split("T")[0];
    await CopyStat.findOneAndUpdate(
      { date: today },
      { $inc: { count: 1 } },
      { upsert: true, new: true }
    );

    trackEvent("trip_contact", trip._id, openid);
    res.json({ contact: trip.contact, remaining: 5 - copyCount - 1 });
  } catch (err) {
    console.error("获取联系方式失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

app.post("/api/auth/send-code", sendCodeLimiter, async (req, res) => {
  try {
    const { emailPrefix } = req.body;
    if (!emailPrefix) {
      return res.status(400).json({ message: "请提供邮箱前缀" });
    }
    // 学号校验：北化邮箱 = 学号@buct.edu.cn，学号为纯数字
    // 放宽为 6-15 位数字：既能拦住乱填、避免无谓的 SMTP 发送，又不会误伤特殊学号
    if (!/^\d{6,15}$/.test(emailPrefix)) {
      return res.status(400).json({ message: "请输入正确的学号（纯数字）" });
    }

    const email = `${emailPrefix}@buct.edu.cn`;
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    // 按邮箱 60s 冷却：即使换 IP 也无法对同一个邮箱连续轰炸验证码
    const existingAuth = await Auth.findOne({ email }).select("lastSentAt").lean();
    if (existingAuth && existingAuth.lastSentAt && Date.now() - existingAuth.lastSentAt.getTime() < 60 * 1000) {
      return res.status(429).json({ message: "发送太频繁，请 1 分钟后再试" });
    }

    await Auth.findOneAndUpdate(
      { email },
      { code, expiresAt, lastSentAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await transporter.sendMail({
      from: `"BHTX 验证服务" <bhtxadmin@163.com>`,
      to: email,
      subject: "BHTX 登录验证码",
      text: `您的验证码是：${code}，5分钟内有效。`
    });

    trackEvent("auth_code_sent", "", email);
    res.json({ message: "验证码已发送", email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "验证码发送失败，请检查 SMTP 配置" });
  }
});

// 注：小程序时期的微信登录（/api/auth/login，jscode2session 换 openid）已移除。
// 网站端登录见上方 /api/auth/web-login（北化邮箱验证码，openid 的值即邮箱）。

app.post("/api/auth/verify", verifyToken, async (req, res) => {
  const { emailPrefix, code } = req.body;
  const email = `${emailPrefix}@buct.edu.cn`;
  const openid = req.user.openid;

  try {
    const authRecord = await Auth.findOne({ email, code: String(code), expiresAt: { $gt: new Date() } });
    if (!authRecord) return res.status(400).json({ message: "验证码错误或已过期" });

    const existingUser = await User.findOne({ email });
    if (existingUser && existingUser.openid !== openid) {
      return res.status(400).json({ message: "该邮箱已被其他微信绑定！" });
    }

    const user = await User.findOneAndUpdate(
      { openid },
      { email, isVerified: true },
      { upsert: true, new: true }
    );
    // v2.0.0 新用户默认 ID 带随机后缀；老用户认证时同样惰性升级
    await ensureUniqueDisplayName(user);
    await Auth.deleteMany({ email });
    res.json({ message: "认证成功", isVerified: true, email });
  } catch (err) {
    res.status(500).json({ message: "认证失败" });
  }
});

// ===== 网站端登录 =====
// 北化邮箱验证码直接登录，不依赖微信。身份锚点 = 邮箱：
//   · openid 字段的值即邮箱（新项目不再有"微信随机串"这种身份）
//   · 同邮箱已有用户直接复用，保证一个人只有一条身份记录
app.post("/api/auth/web-login", webLoginLimiter, async (req, res) => {
  try {
    const { emailPrefix, code } = req.body;
    if (!emailPrefix || !code) {
      return res.status(400).json({ message: "请提供学号与验证码" });
    }
    // 学号校验：北化邮箱 = 学号@buct.edu.cn（纯数字）
    if (!/^\d{6,15}$/.test(emailPrefix)) {
      return res.status(400).json({ message: "请输入正确的学号（纯数字）" });
    }

    const email = `${emailPrefix}@buct.edu.cn`;
    const authRecord = await Auth.findOne({ email, code: String(code), expiresAt: { $gt: new Date() } });
    if (!authRecord) {
      return res.status(400).json({ message: "验证码错误或已过期" });
    }

    // 身份唯一：先按邮箱查，查不到再按 openid 查（两者在新项目里等价）
    let user = await User.findOne({ email });
    if (!user) user = await User.findOne({ openid: email });

    if (!user) {
      user = await User.create({
        openid: email,               // ← 新项目中 openid 的值就是北化邮箱
        email,
        isVerified: true,
        displayName: await generateUniqueName()
      });
    } else {
      user.isVerified = true;
      if (!user.email) user.email = email;
      await user.save();
      await ensureUniqueDisplayName(user);
    }

    await Auth.deleteMany({ email });
    const token = jwt.sign({ openid: user.openid }, JWT_SECRET, { expiresIn: "7d" });
    console.log(`[web-login] 登录成功: ${email.replace(/^(\d{3})\d+(\d{2})@/, "$1****$2@")}`);
    trackEvent("user_login", "", email);
    res.json({ token, isVerified: true, email, displayName: user.displayName });
  } catch (err) {
    console.error("[web-login] 登录失败:", err);
    res.status(500).json({ message: "登录失败，请稍后再试" });
  }
});

app.post("/api/auth/unbind", verifyToken, async (req, res) => {
  const { openid } = req.user;

  try {
    await User.findOneAndUpdate(
      { openid },
      { isVerified: false, email: "" }
    );

    // 解绑后不再是认证用户：自动解散他发起的所有进行中行程（cancelled + 全员退出）
    const disbanded = await Trip.updateMany(
      { openid, status: { $in: ["active", "full"] } },
      {
        $set: {
          status: "cancelled",
          "members.$[elem].status": "cancelled"
        }
      },
      { arrayFilters: [{ "elem.status": "joined" }] }
    );

    res.json({
      message: disbanded.modifiedCount > 0
        ? `解绑成功，已自动解散你的 ${disbanded.modifiedCount} 个进行中行程`
        : "解绑成功"
    });
  } catch (err) {
    res.status(500).json({ message: "解绑失败" });
  }
});

// 自定义 ID（V1.3）：限频一个月改一次
app.put("/api/user/display-name", verifyToken, async (req, res) => {
  try {
    const { displayName } = req.body;
    const openid = req.user.openid;
    if (!displayName || typeof displayName !== "string") {
      return res.status(400).json({ message: "请输入 ID" });
    }
    const name = displayName.trim().slice(0, 12);
    if (!name) {
      return res.status(400).json({ message: "ID 不能为空" });
    }
    if (/^[\u4e00-\u9fa5a-zA-Z0-9_-]+$/.test(name) === false) {
      return res.status(400).json({ message: "ID 仅支持中文、字母、数字、下划线、连字符" });
    }

    // v2.0.0 兜底：老数据/未认证用户可能无 User 记录 → 先创建再改名（不再报"用户不存在"）
    const user = await ensureUser(openid);
    const newName = name;

    // 一天限改一次（ID 仅展示名，唯一身份靠 openid+邮箱认证，无需过严限制）
    if (user.displayNameUpdatedAt) {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      if (user.displayNameUpdatedAt > oneDayAgo) {
        return res.status(429).json({ message: "ID 一天只能修改一次" });
      }
    }

    user.displayName = name;
    user.displayNameUpdatedAt = new Date();
    await user.save();

    trackEvent("user_rename", "", openid);
    res.json({ message: "ID 修改成功", displayName: name });
  } catch (err) {
    console.error("修改 ID 失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 联系方式：手动修改入口；发布行程时也会自动同步为所填值（均为最新值覆盖）
app.put("/api/user/contact", verifyToken, async (req, res) => {
  try {
    const { contact } = req.body;
    if (!contact || typeof contact !== "string" || !contact.trim()) {
      return res.status(400).json({ message: "请输入联系方式" });
    }
    const c = contact.trim().slice(0, 50);
    const user = await ensureUser(req.user.openid);
    user.contact = c;
    await user.save();
    res.json({ message: "联系方式已更新", contact: c });
  } catch (err) {
    console.error("修改联系方式失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 解除 QQ 绑定：仅断开机器人通道（qqOpenId 置空），网页身份、行程与历史不受影响
app.post("/api/user/qq-unbind", verifyToken, async (req, res) => {
  try {
    const user = await User.findOne({ openid: req.user.openid });
    if (!user || !user.qqOpenId) return res.status(400).json({ message: "未绑定 QQ" });
    user.qqOpenId = "";
    await user.save();
    res.json({ message: "已解除 QQ 绑定" });
  } catch (err) {
    console.error("解除 QQ 绑定失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

app.get("/api/user/profile", verifyToken, async (req, res) => {
  try {
    // v2.0.0 兜底：无 User 记录时自动创建（未认证用户也有 ID）
    const user = await ensureUser(req.user.openid);
    res.json({
      openid: user.openid,
      email: user.email || "",
      isVerified: !!user.isVerified,
      displayName: user.displayName || "",
      displayNameUpdatedAt: user.displayNameUpdatedAt || null,
      contact: user.contact || "",
      qqBound: !!user.qqOpenId
    });
  } catch (err) {
    console.error("获取用户信息失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

app.get("/api/stats/copy", async (req, res) => {
  const adminKey = req.headers["x-admin-key"] || req.query.key;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ message: "无权访问" });
  }

  try {
    const days = Math.min(parseInt(req.query.days, 10) || 7, 90);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);
    const startDateStr = startDate.toISOString().split("T")[0];

    const stats = await CopyStat.find({ date: { $gte: startDateStr } }).sort({ date: -1 });

    const result = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split("T")[0];
      const stat = stats.find((s) => s.date === dateStr);
      result.push({ date: dateStr, count: stat ? stat.count : 0 });
    }

    res.json({ days, stats: result });
  } catch (err) {
    console.error("获取复制统计失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 转化漏斗数据（funnel 接口与 dashboard 看板共用，只保留一份实现）
async function buildFunnel(days) {
  const start = new Date();
  start.setDate(start.getDate() - days);

  const events = await AnalyticsEvent.aggregate([
    { $match: { createdAt: { $gte: start } } },
    { $group: { _id: { type: "$type", openid: "$openid" } } },
    { $group: { _id: "$_id.type", uniqueUsers: { $sum: 1 } } }
  ]);
  const funnel = {};
  events.forEach((e) => { funnel[e._id] = e.uniqueUsers; });

  // v2.0.0 人均费用统计 —— 实时从 Trip 聚合（而非埋点快照，用户后填的实际费用才能被统计到）：
  //   • 行程已填实际费用（actualCost）→ 用实际值 ÷ 当前人数
  //   • 未填 → 按路线 COST_TABLE 预估区间中值兜底
  //   • 返回 avgPerPerson（全部样本）+ actualAvg/actualSamples（仅实际填写的样本）
  const tripsInWindow = await Trip.find({ createdAt: { $gte: start } })
    .select("from to actualCost headcount");
  let feeSum = 0, feeCount = 0, actualSum = 0, actualCount = 0;
  let totalActual = 0, totalEstimated = 0, totalTrips = 0;
  for (const t of tripsInWindow) {
    const memberCount = (t.headcount || 0) + 1;
    if (memberCount <= 0) continue;
    totalTrips++;
    const range = COST_TABLE[`${t.from}|${t.to}`] || COST_TABLE[`${t.to}|${t.from}`];
    if (typeof t.actualCost === "number" && t.actualCost > 0) {
      const per = t.actualCost / memberCount;
      feeSum += per; feeCount++;
      actualSum += per; actualCount++;
      totalActual += t.actualCost;
      totalEstimated += t.actualCost;
      continue;
    }
    if (!range) continue;
    feeSum += (range[0] + range[1]) / 2 / memberCount;
    feeCount++;
    totalEstimated += (range[0] + range[1]) / 2;
  }
  const fee = {
    avgPerPerson: feeCount ? Math.round((feeSum / feeCount) * 10) / 10 : null,
    samples: feeCount,
    actualAvg: actualCount ? Math.round((actualSum / actualCount) * 10) / 10 : null,
    actualSamples: actualCount,
    totalActual: Math.round(totalActual * 10) / 10,
    totalEstimated: Math.round(totalEstimated * 10) / 10,
    fillRate: totalTrips ? Math.round((actualCount / totalTrips) * 100) : 0
  };

  return { start, funnel, fee };
}

// 转化漏斗（V1.3，ADMIN_KEY 鉴权）
app.get("/api/stats/funnel", async (req, res) => {
  const adminKey = req.headers["x-admin-key"] || req.query.key;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ message: "无权访问" });
  }

  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
    const { funnel, fee } = await buildFunnel(days);
    res.json({ days, funnel, fee });
  } catch (err) {
    console.error("获取漏斗失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 数据看板（ADMIN_KEY 鉴权）：漏斗 + 按日时间序列 + 按日撮合健康度，一次取全
//   daily：关键事件按「天」的次数分布（UTC+8 自然日聚合，与国内日期对齐）
//   match：窗口内发布的行程中，被加入（曾有乘客）的占比 + 平均「发布→首次加入」时长
app.get("/api/stats/dashboard", async (req, res) => {
  const adminKey = req.headers["x-admin-key"] || req.query.key;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ message: "无权访问" });
  }

  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
    const { start, funnel, fee } = await buildFunnel(days);

    const DAILY_TYPES = ["auth_code_sent", "user_login", "trip_publish", "trip_join", "contact_copy", "trip_leave"];
    const rows = await AnalyticsEvent.aggregate([
      { $match: { createdAt: { $gte: start }, type: { $in: DAILY_TYPES } } },
      { $group: {
        _id: {
          type: "$type",
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "+08:00" } }
        },
        count: { $sum: 1 }
      } }
    ]);
    const byKey = {};
    rows.forEach((r) => { byKey[r._id.day + "|" + r._id.type] = r.count; });

    // 零填充：窗口内每天都有一条记录（近端为今天，远端最早一天可能不满 24h）
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const item = { date: d };
      DAILY_TYPES.forEach((t) => { item[t] = byKey[d + "|" + t] || 0; });
      daily.push(item);
    }

    // 撮合健康度：曾有乘客记录（含已退出的）即视为"被加入"；时长 = 首个乘客 joinedAt - 行程创建时间
    const trips = await Trip.find({ createdAt: { $gte: start } }).select("createdAt members").lean();
    let withJoiner = 0, durSum = 0, durSamples = 0;
    for (const t of trips) {
      const joined = (t.members || []).filter((m) => m.role === "passenger" && m.joinedAt);
      if (joined.length) {
        withJoiner++;
        const first = Math.min(...joined.map((m) => new Date(m.joinedAt).getTime()));
        durSum += first - new Date(t.createdAt).getTime();
        durSamples++;
      }
    }
    const match = {
      published: trips.length,
      withJoiner,
      joinRate: trips.length ? Math.round((withJoiner / trips.length) * 1000) / 10 : 0,
      avgFirstJoinMs: durSamples ? Math.round(durSum / durSamples) : null,
      samples: durSamples
    };

    res.json({ days, funnel, fee, daily, match, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("获取看板数据失败:", err);
    res.status(500).json({ message: "服务器错误" });
  }
});

// ===== QQ 机器人内部接口（v3.0.0；ADMIN_KEY 鉴权，仅供本机 qqbot 进程调用）=====
// 设计原则：撮合规则只保留一份实现 —— proxy 按身份签发短期 JWT 并以伪 IP 自调用公开接口，
// 认证 / 限流 / 防超卖等中间件与业务 handler 全量复用；qqbot 进程不直接读写业务集合。

const LOCATIONS = [
  "北化北区", "北化东区", "北化西区", "昌平西山口", "乐多港万达",
  "昌平悦荟", "昌平区医院", "昌平北站", "南口镇", "首都机场",
  "大兴机场", "北京南站", "北京西站", "北京站", "北京朝阳站",
  "北京丰台站", "清河站/北京北站"
];

// 由身份导出的稳定伪 IP（10.x 段）：使自调用走 express-rate-limit 的独立限流桶，
// 避免 QQ 侧所有用户共享 127.0.0.1 的 IP 配额
function pseudoIp(seed) {
  let h = 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) h = (h * 131 + s.charCodeAt(i)) >>> 0;
  return `10.${(h >>> 16) & 255}.${(h >>> 8) & 255}.${h & 255}`;
}

function maskStudentEmail(email) {
  const m = String(email || "").match(/^(\d{1,2})\d+(\d{2})@/);
  return m ? `${m[1]}****${m[2]}@buct.edu.cn` : String(email || "");
}

// 2026-09-15 → 9月15日（机器人通知文案用）
function cnDate(d) {
  const p = String(d || "").split("-");
  return p.length === 3 ? `${parseInt(p[1], 10)}月${parseInt(p[2], 10)}日` : String(d || "");
}

const internalGuard = (req, res, next) => {
  const k = req.headers["x-admin-key"] || req.query.key;
  if (!k || k !== process.env.ADMIN_KEY) return res.status(403).json({ message: "无权访问" });
  next();
};

async function selfApi(method, path, body, headers) {
  return axios({
    method,
    url: `http://127.0.0.1:${PORT}/api${path}`,
    data: body,
    headers: headers || {},
    validateStatus: () => true,
    timeout: 20000
  });
}

// 代理执行公开接口：{ qqOpenid, method, path, body }
app.post("/api/internal/qq/proxy", internalGuard, async (req, res) => {
  try {
    const { qqOpenid, method = "GET", path: p, body } = req.body || {};
    if (!qqOpenid || !p || !p.startsWith("/")) return res.status(400).json({ message: "参数缺失" });
    const user = await User.findOne({ qqOpenId: qqOpenid }).select("openid").lean();
    if (!user) return res.status(404).json({ code: "UNBOUND", message: "尚未绑定" });
    const token = jwt.sign({ openid: user.openid }, JWT_SECRET, { expiresIn: "1h" });
    const resp = await selfApi(method, p, body, {
      Authorization: `Bearer ${token}`,
      "X-Forwarded-For": pseudoIp(user.openid)
    });
    res.status(resp.status).json(resp.data);
  } catch (err) {
    console.error("[qq-internal] proxy 失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 当前身份概要（绑定状态 / ID / 邮箱脱敏）
app.post("/api/internal/qq/whoami", internalGuard, async (req, res) => {
  try {
    const user = await User.findOne({ qqOpenId: req.body.qqOpenid })
      .select("openid email displayName isVerified contact").lean();
    if (!user) return res.json({ bound: false });
    res.json({
      bound: true,
      displayName: user.displayName || "",
      emailMasked: maskStudentEmail(user.email || user.openid),
      contactSet: !!user.contact
    });
  } catch (err) {
    console.error("[qq-internal] whoami 失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 绑定第一步：归属预检 + 复用公开发码接口（自带按邮箱 60s 冷却与 IP 限流）
app.post("/api/internal/qq/bind-start", internalGuard, async (req, res) => {
  try {
    const { qqOpenid, studentId } = req.body || {};
    if (!qqOpenid || !/^\d{6,15}$/.test(studentId || "")) {
      return res.status(400).json({ message: "请提供正确的学号（纯数字）" });
    }
    const email = `${studentId}@buct.edu.cn`;
    const byQQ = await User.findOne({ qqOpenId: qqOpenid }).select("openid email").lean();
    if (byQQ && byQQ.email && byQQ.email !== email) {
      return res.status(400).json({ message: `该QQ已绑定 ${maskStudentEmail(byQQ.email)}，如需更换请联系开发者` });
    }
    const byEmail = await User.findOne({ $or: [{ openid: email }, { email }] }).select("qqOpenId").lean();
    if (byEmail && byEmail.qqOpenId && byEmail.qqOpenId !== qqOpenid) {
      return res.status(400).json({ message: "该学号已绑定其他QQ账号" });
    }
    const resp = await selfApi("POST", "/auth/send-code", { emailPrefix: studentId }, {
      "X-Forwarded-For": pseudoIp(qqOpenid)
    });
    if (resp.status !== 200) return res.status(resp.status).json(resp.data);
    res.json({ message: "验证码已发送", emailMasked: maskStudentEmail(email) });
  } catch (err) {
    console.error("[qq-internal] bind-start 失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 绑定第二步：校验验证码并落 qqOpenid（唯一索引兜底防重复绑定）
app.post("/api/internal/qq/bind-check", internalGuard, async (req, res) => {
  try {
    const { qqOpenid, studentId, code } = req.body || {};
    if (!qqOpenid || !/^\d{6,15}$/.test(studentId || "") || !code) {
      return res.status(400).json({ message: "参数缺失" });
    }
    const email = `${studentId}@buct.edu.cn`;
    const auth = await Auth.findOne({ email, code: String(code), expiresAt: { $gt: new Date() } });
    if (!auth) return res.status(400).json({ message: "验证码错误或已过期" });

    const byQQ = await User.findOne({ qqOpenId: qqOpenid }).select("openid email").lean();
    if (byQQ && byQQ.email && byQQ.email !== email) {
      return res.status(400).json({ message: "该QQ已绑定其他学号" });
    }
    const byEmail = await User.findOne({ $or: [{ openid: email }, { email }] }).select("qqOpenId").lean();
    if (byEmail && byEmail.qqOpenId && byEmail.qqOpenId !== qqOpenid) {
      return res.status(400).json({ message: "该学号已绑定其他QQ账号" });
    }

    const user = await ensureUser(email);
    user.isVerified = true;
    if (!user.email) user.email = email;
    user.qqOpenId = qqOpenid;
    await user.save();
    await ensureUniqueDisplayName(user);
    await Auth.deleteMany({ email });
    trackEvent("qq_bind", undefined, user.openid);
    res.json({ message: "绑定成功", displayName: user.displayName });
  } catch (err) {
    console.error("[qq-internal] bind-check 失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 通知拉取（qqbot 每 30s 轮询）：at-most-once，失败不重试避免轰炸。
// 收件人在 pull 时实时解析 = 该行程当前全体成员（除操作者），文案在此组装成品。
app.post("/api/internal/qq/notify-pull", internalGuard, async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 60 * 1000);
    const docs = await QQNotify.find({ sentAt: null, createdAt: { $gte: since } })
      .sort({ createdAt: 1 }).limit(20).lean();
    const items = [];
    for (const n of docs) {
      await QQNotify.updateOne({ _id: n._id }, { sentAt: new Date() });
      const trip = await Trip.findById(n.tripId)
        .select("from to date time capacity headcount members openid actualCost tripNo").lean();
      if (!trip) continue;
      const memberOpenids = [...new Set([trip.openid, ...trip.members.map((m) => m.openid)])]
        .filter((o) => o !== n.actorOpenid);
      if (!memberOpenids.length) continue;
      const users = await User.find({ openid: { $in: memberOpenids }, qqOpenId: { $nin: ["", null] } })
        .select("qqOpenId").lean();
      if (!users.length) continue; // 全员未绑定 QQ：无触达渠道，静默跳过

      const label = `${trip.tripNo ? "#" + trip.tripNo + " · " : ""}${cnDate(trip.date)} ${trip.time} ${trip.from} → ${trip.to}`;
      const progress = `，当前 ${(trip.headcount || 0) + 1}/${(trip.capacity || 4) - 1} 人`;
      let text;
      if (n.type === "join") {
        text = `【百花同行】${n.actorName} 加入行程 ${label}${progress}。`;
      } else if (n.type === "leave") {
        text = `【百花同行】${n.actorName} 退出行程 ${label}${progress}。`;
      } else if (n.type === "cancel") {
        text = `【百花同行】行程 ${label} 已被发起人取消。`;
      } else if (n.type === "cost") {
        if (typeof trip.actualCost !== "number" || trip.actualCost <= 0) continue;
        const per = Math.ceil((trip.actualCost / ((trip.headcount || 0) + 1)) * 100) / 100;
        text = `【百花同行】行程 ${label} 已完成结算：总车费 ${trip.actualCost} 元，人均 ${per} 元，请向垫付车费的成员支付应付部分。`;
      } else continue;
      for (const u of users) items.push({ qqOpenid: u.qqOpenId, text });
    }
    res.json({ items });
  } catch (err) {
    console.error("[qq-internal] notify-pull 失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 出发提醒候选：进行中行程、距出发约 1 小时内、成员已绑 QQ 且未提醒过
app.post("/api/internal/qq/reminder-due", internalGuard, async (req, res) => {
  try {
    const now = Date.now();
    const trips = await Trip.find({ status: { $in: ["active", "full"] } })
      .select("from to date time members openid tripNo").lean();
    const items = [];
    for (const t of trips) {
      const dep = buildTripDateTime(t);
      if (!dep) continue;
      const diff = dep.getTime() - now;
      if (diff > 75 * 60 * 1000 || diff < -5 * 60 * 1000) continue;
      const openids = [...new Set([t.openid, ...t.members.filter((m) => m.status === "joined").map((m) => m.openid)])];
      const users = await User.find({ openid: { $in: openids }, qqOpenId: { $nin: ["", null] } })
        .select("openid qqOpenId").lean();
      for (const u of users) {
        const dup = await QQReminded.findOne({ tripId: t._id, openid: u.openid }).lean();
        if (dup) continue;
        items.push({ tripId: String(t._id), openid: u.openid, qqOpenid: u.qqOpenId, tripLabel: `${t.tripNo ? "#" + t.tripNo + " · " : ""}${cnDate(t.date)} ${t.time} ${t.from} → ${t.to}` });
      }
    }
    res.json({ items });
  } catch (err) {
    console.error("[qq-internal] reminder-due 失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

app.post("/api/internal/qq/reminder-sent", internalGuard, async (req, res) => {
  try {
    const { tripId, openid } = req.body || {};
    if (!tripId || !openid) return res.status(400).json({ message: "参数缺失" });
    try { await QQReminded.create({ tripId, openid }); } catch (e) {} // 唯一索引冲突 = 已提醒，幂等
    res.json({ message: "ok" });
  } catch (err) {
    console.error("[qq-internal] reminder-sent 失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 解除 QQ 绑定（qqbot 私聊两步确认后调用）
app.post("/api/internal/qq/unbind", internalGuard, async (req, res) => {
  try {
    const { qqOpenid } = req.body || {};
    if (!qqOpenid) return res.status(400).json({ message: "参数缺失" });
    const user = await User.findOne({ qqOpenId: qqOpenid });
    if (!user) return res.status(404).json({ message: "未绑定" });
    user.qqOpenId = "";
    await user.save();
    trackEvent("qq_unbind", undefined, user.openid);
    res.json({ message: "已解除 QQ 绑定" });
  } catch (err) {
    console.error("[qq-internal] unbind 失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 群注册（qqbot 收到进群/群消息时上报）
app.post("/api/internal/qq/groups", internalGuard, async (req, res) => {
  try {
    if (!req.body.groupOpenid) return res.status(400).json({ message: "参数缺失" });
    await QQGroup.updateOne(
      { groupOpenid: req.body.groupOpenid },
      { $set: { lastActiveAt: new Date() }, $setOnInsert: { addedAt: new Date() } },
      { upsert: true }
    );
    res.json({ message: "ok" });
  } catch (err) {
    console.error("[qq-internal] groups 上报失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 行程号反查（qqbot 各指令用）：返回行程快照与操作者角色
app.post("/api/internal/qq/trip-lookup", internalGuard, async (req, res) => {
  try {
    const { tripNo, actorOpenid: actorQQ } = req.body || {};
    if (!tripNo) return res.status(400).json({ message: "参数缺失" });
    const trip = await Trip.findOne({ tripNo })
      .select("from to date time capacity headcount status openid members actualCost tripNo").lean();
    if (!trip) return res.status(404).json({ message: "行程不存在" });
    let actorOpenid = "";
    if (actorQQ) {
      const actor = await User.findOne({ qqOpenId: actorQQ }).select("openid").lean();
      actorOpenid = actor ? actor.openid : "";
    }
    res.json({
      trip,
      isOrganizer: trip.openid === actorOpenid,
      isMember: trip.openid === actorOpenid || (trip.members || []).some((m) => m.openid === actorOpenid && m.status === "joined")
    });
  } catch (err) {
    console.error("[qq-internal] trip-lookup 失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 成员手动提醒：通知行程内除操作者外的其他成员（不限次数）
app.post("/api/internal/qq/notify-members", internalGuard, async (req, res) => {
  try {
    const { tripId, actorOpenid } = req.body || {};
    if (!tripId || !actorOpenid) return res.status(400).json({ message: "参数缺失" });
    const actor = await User.findOne({ qqOpenId: actorOpenid }).select("openid displayName").lean();
    if (!actor) return res.status(404).json({ code: "UNBOUND", message: "尚未绑定" });
    const trip = await Trip.findById(tripId)
      .select("from to date time capacity headcount members openid tripNo").lean();
    if (!trip) return res.status(404).json({ message: "行程不存在" });
    const isMember = trip.openid === actor.openid || (trip.members || []).some((m) => m.openid === actor.openid && m.status === "joined");
    if (!isMember) return res.status(403).json({ message: "请先加入行程，才能通知成员" });
    const label = `${trip.tripNo ? "#" + trip.tripNo + " · " : ""}${cnDate(trip.date)} ${trip.time} ${trip.from} → ${trip.to}`;
    const memberOpenids = [...new Set([trip.openid, ...(trip.members || []).filter((m) => m.status === "joined").map((m) => m.openid)])]
      .filter((o) => o !== actor.openid);
    const users = await User.find({ openid: { $in: memberOpenids }, qqOpenId: { $nin: ["", null] } })
      .select("qqOpenId").lean();
    const text = `【百花同行】${actor.displayName || "同车成员"} 提醒你关注行程 ${label}，出发前请保持联系。`;
    res.json({ items: users.map((u) => ({ qqOpenid: u.qqOpenId, text })), count: users.length });
  } catch (err) {
    console.error("[qq-internal] notify-members 失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 手动群播报配额：每用户每日 2 次
app.post("/api/internal/qq/manual-broadcast", internalGuard, async (req, res) => {
  try {
    const { qqOpenid } = req.body || {};
    if (!qqOpenid) return res.status(400).json({ message: "参数缺失" });
    const user = await User.findOne({ qqOpenId: qqOpenid }).select("openid").lean();
    if (!user) return res.status(404).json({ code: "UNBOUND", message: "尚未绑定" });
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const r = await QQDailyQuota.findOneAndUpdate(
      { openid: user.openid, date: today },
      { $inc: { count: 1 } },
      { upsert: true, new: true }
    );
    if (r.count > 2) return res.status(429).json({ message: "今日手动播报次数已用完", remaining: 0 });
    res.json({ ok: true, remaining: Math.max(0, 2 - r.count) });
  } catch (err) {
    console.error("[qq-internal] manual-broadcast 失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 每日四档播报（09/12/15/18 点，UTC+8；qqbot 到点触发）：仅播报当日尚未出发的行程，
// 按群按时段去重（lastBroadcastSlot = 日期-时段）；无待发行程则不发送
app.post("/api/internal/qq/broadcast-today", internalGuard, async (req, res) => {
  try {
    const SLOTS = ["09", "12", "15", "18"];
    const body = req.body || {};
    const slot = String(body.slot || "");
    const force = !!body.force; // 手动播报：忽略槽位去重，发全部群且不占用槽位标记
    const openid = String(body.openid || ""); // 传入时仅播报该用户发布或加入的行程
    if (!SLOTS.includes(slot) && !force) return res.status(400).json({ message: "无效播报时段" });
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // UTC+8 自然日
    const mark = today + "-" + slot;
    const groups = force || slot === "manual"
      ? await QQGroup.find({}).select("groupOpenid").lean()
      : await QQGroup.find({ lastBroadcastSlot: { $ne: mark } }).select("groupOpenid").lean();
    let upcoming = await Trip.find({ date: today, status: { $in: ["active", "full"] } })
      .select("from to date time capacity headcount members openid tripNo").sort({ time: 1 }).lean();
    upcoming = upcoming.filter((t) => {
      const dep = buildTripDateTime(t);
      if (!dep || dep.getTime() <= Date.now()) return false;
      if (openid) return t.openid === openid || (t.members || []).some((m) => m.openid === openid);
      return true;
    });
    let content = null;
    if (upcoming.length) {
      const lines = upcoming.map((t, i) => {
        const left = (t.capacity || 4) - 1 - (t.headcount || 0);
        return `${i + 1}. #${t.tripNo || ""} ${t.time} ${t.from} → ${t.to}，余 ${left} 位`;
      });
      const head = openid ? `你今日的行程 ${upcoming.length} 班` : `今日出行 ${upcoming.length} 班`;
      content = `【百花同行 · ${head}】\n${lines.join("\n")}\n上车请@我「加入 行程号」；发布行程直接@我说时间和路线。\n网页版：bhtx.prom1se.cn`;
    }
    if (!force) await QQGroup.updateMany({ lastBroadcastSlot: { $ne: mark } }, { lastBroadcastSlot: mark });
    res.json({ content, groups: groups.map((g) => g.groupOpenid) });
  } catch (err) {
    console.error("[qq-internal] broadcast-today 失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 机器人可用地点库（与前端 LOCATIONS 同源，供解析器匹配）
app.get("/api/internal/qq/locations", internalGuard, (req, res) => {
  res.json({ locations: LOCATIONS });
});

// ===== 共建者名录 =====
// 公开读（关于页展示，仅未隐藏条目）
app.get("/api/contributors", async (req, res) => {
  try {
    const list = await Contributor.find({ hidden: false })
      .sort({ order: 1, createdAt: 1 }).select("name role link").lean();
    res.json(list);
  } catch (err) {
    console.error("[contributor] 读取失败:", err.message);
    res.json([]);
  }
});

// 管理接口（dashboard，ADMIN_KEY 鉴权；返回全量含隐藏）
app.get("/api/internal/contributors", internalGuard, async (req, res) => {
  try {
    const list = await Contributor.find().sort({ order: 1, createdAt: 1 }).lean();
    res.json(list);
  } catch (err) {
    console.error("[contributor] 管理读取失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

app.post("/api/internal/contributors", internalGuard, async (req, res) => {
  try {
    const name = String((req.body || {}).name || "").trim().slice(0, 20);
    if (!name) return res.status(400).json({ message: "请输入名字" });
    const max = await Contributor.findOne().sort({ order: -1 }).select("order").lean();
    const doc = await Contributor.create({
      name,
      role: String((req.body || {}).role || "").trim().slice(0, 30),
      link: String((req.body || {}).link || "").trim().slice(0, 200),
      order: max ? (max.order || 0) + 1 : 1
    });
    res.json(doc);
  } catch (err) {
    console.error("[contributor] 新增失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

app.put("/api/internal/contributors/:id", internalGuard, async (req, res) => {
  try {
    const b = req.body || {};
    const update = {};
    if (b.name !== undefined) { const v = String(b.name).trim().slice(0, 20); if (!v) return res.status(400).json({ message: "名字不能为空" }); update.name = v; }
    if (b.role !== undefined) update.role = String(b.role).trim().slice(0, 30);
    if (b.link !== undefined) update.link = String(b.link).trim().slice(0, 200);
    if (b.hidden !== undefined) update.hidden = !!b.hidden;
    const doc = await Contributor.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!doc) return res.status(404).json({ message: "条目不存在" });
    res.json(doc);
  } catch (err) {
    console.error("[contributor] 更新失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

app.delete("/api/internal/contributors/:id", internalGuard, async (req, res) => {
  try {
    const doc = await Contributor.findByIdAndDelete(req.params.id).lean();
    if (!doc) return res.status(404).json({ message: "条目不存在" });
    res.json({ message: "已删除" });
  } catch (err) {
    console.error("[contributor] 删除失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

// 上移 / 下移：与相邻条目交换 order
app.post("/api/internal/contributors/:id/move", internalGuard, async (req, res) => {
  try {
    const dir = (req.body || {}).dir;
    if (dir !== "up" && dir !== "down") return res.status(400).json({ message: "参数缺失" });
    const all = await Contributor.find().sort({ order: 1, createdAt: 1 }).lean();
    const idx = all.findIndex((x) => String(x._id) === req.params.id);
    if (idx === -1) return res.status(404).json({ message: "条目不存在" });
    const swapWith = dir === "up" ? all[idx - 1] : all[idx + 1];
    if (!swapWith) return res.json({ message: "已到边界", moved: false });
    await Contributor.updateOne({ _id: all[idx]._id }, { order: swapWith.order || 0 });
    await Contributor.updateOne({ _id: swapWith._id }, { order: all[idx].order || 0 });
    res.json({ message: "已移动", moved: true });
  } catch (err) {
    console.error("[contributor] 移动失败:", err.message);
    res.status(500).json({ message: "服务器错误" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// 数据看板短链接（静态页在 /dashboard.html）
app.get("/dashboard", (req, res) => res.redirect("/dashboard.html"));
