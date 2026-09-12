/**
 * 百花同行 QQ 官方机器人（v3.0.0）
 *
 * 定位：薄壳进程。只做事件接收 / 自然语言解析 / 回复组装；
 *       一切撮合动作经 server.js 内部接口执行（业务规则只保留一份实现，不直接读写业务集合）。
 *
 * 接入机制（官方 api-v2）：
 *   · AccessToken：POST bots.qq.com/app/getAppAccessToken（appId + clientSecret，有时效，提前刷新）
 *   · WebSocket：wss://api.sgroup.qq.com/websocket/，鉴权头格式 "QQBot {AccessToken}"
 *   · 握手：op10 Hello(心跳周期) → op2 Identify → op0 Dispatch(READY, session_id) → 周期 op1 心跳 → op11 ACK
 *   · 断线：op13 服务端要求重连 / 连接断开 → op6 Resume（session_id + seq，服务端补发漏掉的事件）
 *   · intents：GROUP_AND_C2C_EVENT (1<<25)，含群@消息 / 单聊 / 进退群 / 好友事件
 *
 * 当前阶段：链路验证骨架 —— 回显收到的群聊与单聊消息，并记录 openid（用于 user_openid 跨群一致性实测）。
 * 凭据全部来自环境变量 QQ_BOT_APP_ID / QQ_BOT_APP_SECRET（.env，不进 git）。
 */

const WebSocket = require("ws");
const axios = require("axios");

const CONFIG = {
  appId: process.env.QQ_BOT_APP_ID || "",
  clientSecret: process.env.QQ_BOT_APP_SECRET || "",
  // GROUP_AND_C2C_EVENT：群@消息 / 单聊消息 / 机器人进退群 / 好友增删
  intents: 1 << 25,
  gateway: process.env.QQ_BOT_GATEWAY || "wss://api.sgroup.qq.com/websocket/",
  apiBase: process.env.QQ_BOT_API_BASE || "https://api.sgroup.qq.com",
  tokenUrl: "https://bots.qq.com/app/getAppAccessToken"
};

if (!CONFIG.appId || !CONFIG.clientSecret) {
  console.error("[qqbot] 缺少环境变量 QQ_BOT_APP_ID / QQ_BOT_APP_SECRET");
  process.exit(1);
}

function log(msg) {
  console.log(`[qqbot ${new Date().toISOString()}] ${msg}`);
}

// ===== AccessToken（有时效，提前 60s 刷新）=====
let accessToken = "";
let tokenExpireAt = 0;

async function refreshAccessToken() {
  const res = await axios.post(CONFIG.tokenUrl, {
    appId: CONFIG.appId,
    clientSecret: CONFIG.clientSecret
  }, { timeout: 10000 });
  if (!res.data || !res.data.access_token) {
    throw new Error("token 响应异常: " + JSON.stringify(res.data).slice(0, 200));
  }
  accessToken = res.data.access_token;
  const expiresIn = parseInt(res.data.expires_in, 10) || 7200;
  tokenExpireAt = Date.now() + expiresIn * 1000 - 60 * 1000;
  log(`AccessToken 已刷新（${expiresIn}s 后过期）`);
}

async function ensureToken() {
  if (!accessToken || Date.now() >= tokenExpireAt) await refreshAccessToken();
  return accessToken;
}

// ===== 消息发送（被动回复：携带 msg_id，不占主动消息额度；同一条消息多次回复递增 msg_seq）=====
async function replyGroup(groupOpenid, content, msgId, msgSeq) {
  const token = await ensureToken();
  return axios.post(`${CONFIG.apiBase}/v2/groups/${groupOpenid}/messages`,
    { content, msg_type: 0, msg_id: msgId, msg_seq: msgSeq || 1 },
    { headers: { Authorization: `QQBot ${token}` }, timeout: 10000 });
}

async function replyC2C(userOpenid, content, msgId, msgSeq) {
  const token = await ensureToken();
  return axios.post(`${CONFIG.apiBase}/v2/users/${userOpenid}/messages`,
    { content, msg_type: 0, msg_id: msgId, msg_seq: msgSeq || 1 },
    { headers: { Authorization: `QQBot ${token}` }, timeout: 10000 });
}

function describeApiError(e) {
  return e.response
    ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data).slice(0, 300)}`
    : e.message;
}

// ===== 事件处理（骨架：全量记录 openid 供一致性实测 + 回显确认链路）=====
async function handleEvent(type, d) {
  // 调研实测用：完整记录事件字段（截断），核对 user_openid / group_openid 语义
  log(`EVENT ${type} ${JSON.stringify(d).slice(0, 600)}`);

  try {
    if (type === "GROUP_AT_MESSAGE_CREATE") {
      const content = (d.content || "").trim();
      // 去掉官方转义的 @ 段（content 可能以 "/" 或空格开头，trim 后回显）
      await replyGroup(d.group_openid, "收到：" + (content || "(空)"), d.id);
    } else if (type === "C2C_MESSAGE_CREATE") {
      const content = (d.content || "").trim();
      await replyC2C(d.user_openid, "收到：" + (content || "(空)"), d.id);
    } else if (type === "GROUP_ADD_ROBOT") {
      log(`机器人进群 group_openid=${d.group_openid} op=(${d.op_user_openid || ""})`);
    } else if (type === "FRIEND_ADD") {
      log(`新好友 user_openid=${d.user_openid || (d.user && d.user.user_openid) || ""}`);
    }
  } catch (e) {
    log(`回复失败: ${describeApiError(e)}`);
  }
}

// ===== WebSocket 生命周期 =====
let ws = null;
let sessionId = "";
let lastSeq = 0;
let heartbeatTimer = null;
let reconnectDelay = 3000; // 指数退避上限 60s；Resume 成功后复位

function send(op, d) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ op, d }));
}

function startHeartbeat(intervalMs) {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => send(1, lastSeq), intervalMs);
}

function stopHeartbeat() { clearInterval(heartbeatTimer); heartbeatTimer = null; }

function scheduleReconnect(useResume) {
  stopHeartbeat();
  if (ws) { try { ws.removeAllListeners(); ws.close(); } catch (e) {} ws = null; }
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 60 * 1000);
  log(`${delay / 1000}s 后${useResume && sessionId ? " Resume" : "重连"}…`);
  setTimeout(() => connect(useResume && !!sessionId), delay);
}

function connect(useResume) {
  ensureToken().then((token) => {
    ws = new WebSocket(CONFIG.gateway, { handshakeTimeout: 15000 });

    ws.on("open", () => log("WS 已连接网关"));

    ws.on("message", (raw) => {
      let payload;
      try { payload = JSON.parse(raw); } catch (e) { return log("非 JSON 消息: " + raw.toString().slice(0, 200)); }
      if (payload.s) lastSeq = payload.s;

      switch (payload.op) {
        case 10: // Hello：服务端要求的心跳周期
          startHeartbeat(payload.d.heartbeat_interval);
          if (useResume && sessionId) {
            log("发送 Resume（session=" + sessionId + " seq=" + lastSeq + "）");
            send(6, { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq });
          } else {
            send(2, { token: `QQBot ${token}`, intents: CONFIG.intents, shard: [0, 1] });
            log("发送 Identify（intents=" + CONFIG.intents + "）");
          }
          break;
        case 0: // Dispatch
          if (payload.t === "READY") {
            sessionId = payload.d.session_id;
            reconnectDelay = 3000;
            log(`READY 会话建立（session_id=${sessionId}，用户=${payload.d.user && payload.d.user.user_openid}）`);
          } else if (payload.t === "RESUMED") {
            reconnectDelay = 3000;
            log("RESUMED 会话恢复成功");
          } else {
            handleEvent(payload.t, payload.d);
          }
          break;
        case 11: // Heartbeat ACK
          break;
        case 13: // 服务端要求重连（走 Resume）
          log("服务端要求重连");
          scheduleReconnect(true);
          break;
        default:
          log("未知 op=" + payload.op);
      }
    });

    ws.on("error", (e) => log("WS 错误: " + e.message));
    ws.on("close", (code, reason) => {
      log(`WS 断开 code=${code} reason=${reason && reason.toString().slice(0, 120)}`);
      scheduleReconnect(true);
    });
  }).catch((e) => {
    log(`连接前置失败（token/网关）: ${describeApiError(e)}`);
    scheduleReconnect(false);
  });
}

// 进程启动
refreshAccessToken()
  .then(() => connect(false))
  .catch((e) => {
    log(`启动失败: ${describeApiError(e)}`);
    // token 阶段失败也保持重试（可能是瞬时网络问题）
    setTimeout(() => {
      refreshAccessToken().then(() => connect(false)).catch((e2) => {
        log(`二次尝试仍失败: ${describeApiError(e2)}，退出等待 pm2 重启`);
        process.exit(1);
      });
    }, 10000);
  });
