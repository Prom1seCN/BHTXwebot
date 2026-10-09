/* 百花同行 BHTXwebot —— 前端应用
 * 纯前端逻辑，所有业务规则由后端 API 提供（不重复实现）
 */

// 地点库：唯一数据源 public/locations.json（大厅筛选、发布选项在 mounted 拉取；自定义输入不受限制）

function pad2(n) { return String(n).padStart(2, '0'); }

function dateStr(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtDateCN(s) {
  if (!s) return '';
  const p = String(s).split('-');
  if (p.length !== 3) return s;
  return `${parseInt(p[1], 10)}月${parseInt(p[2], 10)}日`;
}

function normTrip(t) {
  if (!t) return null;
  return Object.assign({}, t, {
    id: t._id || t.id,
    displayDate: fmtDateCN(t.date)
  });
}

const LS = {
  token: 'bhtxweb_token',
  email: 'bhtxweb_email',
  name: 'bhtxweb_name',
  contact: 'bhtxweb_contact',
  contribApply: 'bhtxweb_contrib_apply'   // 本机共建者申请编号（一设备同时仅一条）
};

const app = Vue.createApp({
  data() {
    return {
      // ---- 会话 ----
      token: localStorage.getItem(LS.token) || '',
      email: localStorage.getItem(LS.email) || '',
      displayName: localStorage.getItem(LS.name) || '',
      qqBound: false,

      // ---- 视图 ----
      view: 'hall',
      // 详情页来路：从「我的行程」点进详情，返回应回列表而不是大厅
      detailFrom: 'hall',

      // ---- 通用确认弹层（替代 window.confirm）----
      // 原生 confirm 在微信/QQ 内置 webview 里样式不可控，又与全站的底部 sheet 风格完全割裂
      confirmSheet: { open: false, title: '', text: '', confirmText: '确认', danger: false },
      _confirmResolve: null,

      // ---- 加入行程 · 填写联系方式（替代 window.prompt）----
      joinContactOpen: false,
      joinContactValue: '',
      joinContactError: '',

      // ---- 大厅 ----
      trips: [],
      externalTrips: [],      // 同行雷达：第三方公开帖子聚合
      extSheet: null,         // 同行雷达：当前查看原文的那条
      // 同行雷达：删除（仅限第三方帖子；需认证 + 勾选本人 + 填原因，24 小时限 1 条）
      extDeleteOpen: false,
      extDeleteReason: '',
      extDeleteDetail: '',
      extDeleteConfirm: false,
      extDeleteBusy: false,
      extDeleteReasons: [
        '我是发帖人，不想被转载',
        '信息有误',
        '已经拼到人了',
        '其他'
      ],
      loading: false,
      dateFilter: 'all',      // all | today | tomorrow | after | 具体日期 YYYY-MM-DD
      fromFilter: '',
      sheetPicker: '',        // '' | 'date' | 'from' —— 选择弹层
      dateFilters: [
        { k: 'all', label: '全部' },
        { k: 'today', label: '今天' },
        { k: 'tomorrow', label: '明天' },
        { k: 'after', label: '后天' }
      ],
      locations: [],

      // ---- 详情 ----
      tripId: '',
      trip: null,
      members: [],
      membersLoading: false,
      isMember: false,
      statusBusy: false,
      costInput: '',
      isMemberView: false,

      // ---- QQ 频道（独立页）----
      qqData: null,
      qqTs: 0,

      // ---- 共建者名录（含自主申请）----
      showContributors: false,
      contributorsLoading: false,
      contributors: [],
      applyCode: localStorage.getItem(LS.contribApply) || '',
      applyState: null,          // {status,name,role}
      applyFormOpen: false,
      applyName: '',
      applyRole: '',
      applyRef: '',
      applyError: '',
      applying: false,

      // ---- 赞助 ----
      sponsorOpen: false,
      sponsorTs: 0,

      // ---- 发布 ----
      form: {
        from: '', fromCustom: '', to: '', toCustom: '',
        date: '', time: '', seats: 2, contact: '', remark: ''
      },
      publishing: false,
      publishError: '',

      // ---- 菜单（桌面侧栏与手机菜单弹层共用同一份数据）----
      menus: [
        { key: 'hall', label: '同行大厅' },
        { key: 'trips', label: '我的行程' },
        { key: 'qq', label: 'QQ机器人 & QQ群' },
        { key: 'auth', label: '邮箱认证' },
        { key: 'guide', label: '使用教程' },
        { key: 'legal', label: '隐私政策与用户协议' },
        { key: 'about', label: '关于' }
      ],
      quickFrom: ['北化北区', '昌平西山口'],   // 常用出发地，其余进「选择出发地」
      myPublished: [],
      myJoined: [],

      // ---- 修改 ID ----
      idSheetOpen: false,
      newId: '',
      idError: '',
      savingId: false,

      // ---- 修改联系方式 ----
      contactSheetOpen: false,
      newContact: '',
      contactError: '',
      savingContact: false,

      // ---- 登录 ----
      loginOpen: false,
      loginPrefix: '',
      loginCode: '',
      loginError: '',
      loggingIn: false,
      sending: false,
      counting: false,
      countdown: 60,

      toast: ''
    };
  },

  computed: {
    isLoggedIn() { return !!this.token; },
    // 菜单项：邮箱认证后面缀当前认证状态（「退出登录」不在菜单里——桌面侧栏与手机菜单页的账号卡片各有一个）
    menuList() {
      return this.menus.map((m) => m.key === 'auth'
        ? Object.assign({}, m, { note: this.isLoggedIn ? '已认证' : '未认证' })
        : m);
    },
    // 出发地筛选是否落在「选择出发地」里（非常用地点）
    isOtherFrom() {
      return !!this.fromFilter && this.quickFrom.indexOf(this.fromFilter) === -1;
    },
    // 日期筛选是否选的是具体某一天（而非快捷标签）
    isPickedDate() { return /^\d{4}-\d{2}-\d{2}$/.test(this.dateFilter); },
    dateChipLabel() { return this.isPickedDate ? fmtDateCN(this.dateFilter) : '选择日期'; },

    // 日期弹层的选项：全部 + 之后 31 天（与发布可选范围一致）
    dateOptions() {
      const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const list = [{ v: 'all', label: '全部日期', hint: '' }];
      for (let i = 0; i <= 30; i++) {
        const d = dateStr(i);
        const p = d.split('-');
        const dt = new Date(d + 'T00:00:00');
        list.push({
          v: d,
          label: `${parseInt(p[1], 10)}月${parseInt(p[2], 10)}日 ${wd[dt.getDay()]}`,
          hint: i === 0 ? '今天' : i === 1 ? '明天' : i === 2 ? '后天' : ''
        });
      }
      return list;
    },

    // 出发地弹层的选项
    fromOptions() {
      return [{ v: '', label: '全部出发地', hint: '' }]
        .concat(this.locations.map((l) => ({ v: l, label: l, hint: '' })));
    },

    pickOptions() {
      return this.sheetPicker === 'date' ? this.dateOptions : this.fromOptions;
    },

    // 手机菜单：底部 Dock 已有「同行大厅」，这里不再重复
    menuListMobile() { return this.menuList.filter((m) => m.key !== 'hall'); },

    // 单字头像：取 ID 首字，缺省「北」
    idInitial() { return this.displayName ? this.displayName[0] : '北'; },

    // 日期筛选当前对应的值（快捷标签换算成具体日期，便于与列表比对）
    activeDateVal() {
      return this.dateFilter === 'all' ? 'all' : this.targetDate;
    },

    activePickValue() {
      return this.sheetPicker === 'date' ? this.activeDateVal : this.fromFilter;
    },
    today() { return dateStr(0); },
    maxDate() { return dateStr(30); },

    // 当前筛选对应的具体日期（空 = 全部）
    targetDate() {
      const k = this.dateFilter;
      if (!k || k === 'all') return '';
      if (k === 'today') return dateStr(0);
      if (k === 'tomorrow') return dateStr(1);
      if (k === 'after') return dateStr(2);
      return k;
    },

    visibleTrips() {
      const target = this.targetDate;
      return this.trips
        .filter(t => {
          if (this.fromFilter && t.from !== this.fromFilter) return false;
          if (target && t.date !== target) return false;
          return true;
        })
        .sort((a, b) => String(a.date + a.time).localeCompare(String(b.date + b.time)));
    },

    // 同行雷达：跟随日期筛选（出发地不参与——第三方帖子常未注明起点）
    visibleExternal() {
      const target = this.targetDate;
      return (this.externalTrips || [])
        .filter(t => {
          if (target && t.date !== target) return false;
          return true;
        })
        .sort((a, b) => String(a.date + a.time).localeCompare(String(b.date + b.time)));
    },

    emptyTitle() {
      if (this.fromFilter) return '「' + this.fromFilter + '」暂无行程';
      if (this.dateFilter === 'all') return '暂无行程';
      return '该日期暂无行程';
    },

    statusText() {
      const t = this.trip;
      if (!t) return '';
      if (t.status === 'full') return '已满员';
      if (t.status === 'completed') return '已完成';
      if (t.status === 'cancelled') return '已下架';
      if (t.status === 'expired') return '已过期';
      return '预约同行';
    },

    // 车费填写权限：任何已加入成员（取消的行程除外）
    canEditCost() {
      return !!(this.trip && this.isMember && this.trip.status !== 'cancelled');
    },

    // QQ 频道弹层：bot/群任一有号或码才展示条目，全空时给占位文案
    // 判断口径必须与模板渲染一致（number || link || qr）：link 是前端画二维码的首选字段，
    // 只配 link 时卡片会正常渲染，这里漏判就会同时出现卡片和「频道尚未公布」
    qqGroupsShown() {
      const d = this.qqData;
      if (!d) return false;
      const botHas = !!(d.bot && (d.bot.number || d.bot.link || d.bot.qr));
      const groupsHas = (d.groups || []).some((g) => g.number || g.link || g.qr);
      return botHas || groupsHas;
    }
  },

  watch: {
    // 取消登录（未成功）时作废「登录后自动跳转」的待办，避免下次从别处登录时被莫名带进发布/行程页
    loginOpen(v) {
      if (!v && !this.isLoggedIn) { this._pendingTrips = false; this._pendingPublish = false; }
    }
  },

  methods: {
    // ================= API =================
    async api(path, opts) {
      opts = opts || {};
      const headers = { 'Content-Type': 'application/json' };
      if (this.token) headers.Authorization = 'Bearer ' + this.token;

      // 超时保护：避免网络异常时请求一直挂着、界面永远停在「提交中」
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let res;
      try {
        res = await fetch('/api' + path, {
          method: opts.method || 'GET',
          headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: ctrl.signal
        });
      } catch (err) {
        clearTimeout(timer);
        const e = new Error(err && err.name === 'AbortError' ? '请求超时，请检查网络后重试' : '网络异常，请稍后重试');
        e.status = 0;
        throw e;
      }
      clearTimeout(timer);

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 401（无 token / token 失效）：先清本地登录态，再给可读文案——不把服务端原始提示「缺少或无效的 Authorization 头」甩到界面上
        if (res.status === 401) {
          const hadToken = !!this.token;
          this.logout(true);
          const e = new Error(hadToken ? '登录已过期，请重新邮箱认证' : '请登录后重试');
          e.status = 401;
          throw e;
        }
        // 优先用服务端文案；取不到时按状态码给可读兜底，不甩「请求失败」这种无信息量的提示
        const raw = data && data.message;
        const msg = (typeof raw === 'string' && raw)
          ? raw
          : res.status === 429 ? '操作过于频繁，请稍后再试'
          : res.status >= 500 ? '服务器繁忙，请稍后重试'
          : '请求失败';
        const e = new Error(msg);
        e.status = res.status;
        throw e;
      }
      return data;
    },

    showToast(msg) {
      this.toast = msg;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.toast = ''; }, 2200);
    },

    // 行程状态标签（大厅与行程历史共用）
    tagOf(t) {
      if (!t) return '';
      const map = { full: '已满员', completed: '已完成', cancelled: '已下架', expired: '已过期' };
      return map[t.status] || '预约同行';
    },

    tagClass(t) {
      if (!t) return '';
      if (t.status === 'full') return 'full';
      if (['completed', 'cancelled', 'expired'].indexOf(t.status) > -1) return 'done';
      return '';
    },

    // ================= 路由 =================
    go(view, fromHash) {
      // 行程历史需要身份，未认证时转到邮箱认证
      if (view === 'trips' && !this.isLoggedIn) { this.askAuthForTrips(); return; }
      // 发布需「已认证」身份；守卫放在 go() 里才覆盖 hash 直达/刷新（#/publish）这条绕过按钮的路径
      if (view === 'publish' && !this.isLoggedIn) { this.askAuthForPublish(); return; }

      this.view = view;
      if (!fromHash) location.hash = view === 'hall' ? '#/' : '#/' + view;
      if (view === 'hall') this.reloadHall();
      if (view === 'trips') this.loadMine();
      if (view === 'qq') this.loadQQData();
      window.scrollTo(0, 0);
    },

    // 未认证时点「行程历史」：提示并引导到邮箱认证
    askAuthForTrips() {
      this._pendingTrips = true;
      this.showToast('查看我的行程需先完成邮箱认证');
      if (location.hash !== '#/' && location.hash !== '') location.hash = '#/';
      setTimeout(() => { if (!this.isLoggedIn) this.openLogin(); }, 600);
    },

    // 未认证时进「发布行程」（含刷新 #/publish）：落回大厅并引导登录，避免停在发布页填完才报错
    askAuthForPublish() {
      this._pendingPublish = true;
      this.showToast('请登录后重试');
      this.go('hall');
      setTimeout(() => { if (!this.isLoggedIn) this.openLogin(); }, 600);
    },

    goPublish() {
      this.go('publish');   // 未登录时由 go() 的守卫引导到邮箱认证
    },

    // 返回按钮：回到进来时的来源。原先固定 go('hall')，从「我的行程」点进详情再返回会掉到大厅
    goBack() {
      this.go(this.view === 'detail' && this.detailFrom === 'trips' ? 'trips' : 'hall');
    },

    // 通用确认弹层：await this.askConfirm({...}) 得到 true / false
    // 为什么不用 window.confirm：原生弹窗与全站底部 sheet 割裂，webview 里样式且不受控
    askConfirm(opts) {
      this.confirmSheet = Object.assign(
        { open: true, title: '确认操作', text: '', confirmText: '确认', danger: false },
        opts || {}
      );
      return new Promise((resolve) => { this._confirmResolve = resolve; });
    },
    closeConfirm(result) {
      if (!this.confirmSheet.open) return;
      this.confirmSheet.open = false;
      const resolve = this._confirmResolve;
      this._confirmResolve = null;
      // 只结算一次：遮罩点击与按钮点击可能同时到达
      if (resolve) resolve(!!result);
    },

    handleHash() {
      const h = location.hash.replace(/^#\/?/, '');
      if (h.indexOf('trip/') === 0) {
        const id = h.slice(5);
        if (this.view !== 'detail' || this.tripId !== id) this.openTrip(id, true);
        return;
      }
      // 同行雷达原帖详情：写入历史栈后浏览器返回键不再直接退出网站
      if (h.indexOf('ext/') === 0) {
        const id = h.slice(4);
        const hit = (this.externalTrips || []).find((x) => x._id === id);
        if (hit) { this.openExtRaw(hit, true); return; }
        // 刷新或直接打开分享链接时列表还没到：先拉一次大厅数据再定位，
        // 拿不到这条就回大厅 —— 不能把人停在空详情页上
        this.reloadHall().then(() => {
          const t = (this.externalTrips || []).find((x) => x._id === id);
          if (t) this.openExtRaw(t, true);
          else this.go('hall');
        });
        return;
      }
      const v = ['publish', 'menu', 'trips', 'about', 'qq', 'guide', 'legal'].indexOf(h) > -1 ? h : 'hall';
      if (this.view !== v) this.go(v, true);
    },

    // ================= 大厅 =================
    async reloadHall() {
      this.loading = true;
      try {
        // 本站行程与同行雷达并行拉取；雷达失败不影响大厅主列表
        const [list, ext] = await Promise.all([
          this.api('/trips'),
          this.api('/external-trips').catch(() => [])
        ]);
        this.trips = (list || []).map(normTrip);
        this.externalTrips = (Array.isArray(ext) ? ext : []).map((t) =>
          Object.assign({}, t, { displayDate: fmtDateCN(t.date) }));
      } catch (e) {
        this.showToast(e.message || '加载失败');
      } finally {
        this.loading = false;
      }
    },

    // 同行雷达：查看原帖（需登录 —— 仅信息查询工具，认证后才展开详情）
    // 注意：不要叫 openExternal，那个名字已被「打开外链」占用（见文件后段）
    openExtRaw(t, fromHash) {
      if (!this.isLoggedIn) {
        this.showToast('查看原帖需先完成邮箱认证');
        setTimeout(() => { if (!this.isLoggedIn) this.openLogin(); }, 600);
        return;
      }
      if (!fromHash) location.hash = '#/ext/' + t._id;   // 进历史栈：返回键留在站内，链接可直接分享
      this.extSheet = t;
      this.view = 'extdetail';
      window.scrollTo(0, 0);
    },

    // 同行雷达：打开删除确认（重置上一次的输入）
    openExtDelete() {
      this.extDeleteReason = '';
      this.extDeleteDetail = '';
      this.extDeleteConfirm = false;
      this.extDeleteOpen = true;
    },
    closeExtDelete() {
      if (this.extDeleteBusy) return;
      this.extDeleteOpen = false;
    },

    // 同行雷达：提交删除
    async submitExtDelete() {
      if (!this.extSheet || this.extDeleteBusy) return;
      if (!this.extDeleteConfirm) { this.showToast('请勾选「这是我本人发布的帖子」'); return; }
      if (!this.extDeleteReason) { this.showToast('请选择删除原因'); return; }

      this.extDeleteBusy = true;
      try {
        await this.api('/external-trips/' + this.extSheet._id + '/delete', {
          method: 'POST',
          body: {
            reason: this.extDeleteReason,
            reasonDetail: this.extDeleteDetail,
            confirm: true
          }
        });
        this.extDeleteOpen = false;
        this.extSheet = null;
        this.showToast('已删除');
        this.go('hall');              // go('hall') 内部已调用 reloadHall()
      } catch (e) {
        // 失败时保留弹窗，让用户看清原因（限流 / 校验 / 网络）
        this.showToast((e && e.message) || '删除失败，请稍后重试');
      } finally {
        this.extDeleteBusy = false;
      }
    },

    // 同行雷达：发帖时间显示（如「2 小时前」/「10-01 14:05」）
    fmtPosted(iso) {
      if (!iso) return '未知';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '未知';
      const diff = Date.now() - d.getTime();
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
      if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
      const p = n => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },

    // ================= 详情 =================
    async openTrip(id, fromHash) {
      if (!fromHash) location.hash = '#/trip/' + id;
      // 记住来路：从「我的行程」进来就回列表，其余入口回大厅
      this.detailFrom = this.view === 'trips' ? 'trips' : 'hall';
      this.view = 'detail';
      this.tripId = id;
      this.trip = null;
      this.members = [];
      this.isMember = false;
      window.scrollTo(0, 0);

      try {
        const data = await this.api('/trips/' + id);
        this.trip = normTrip(data);
        this.costInput = this.trip.actualCost != null ? String(this.trip.actualCost) : '';
        await this.loadMembers();
      } catch (e) {
        this.showToast(e.message || '行程不存在或已结束');
        this.go('hall');
      }
    },

    async loadMembers() {
      this.membersLoading = true;
      try {
        const data = await this.api('/trips/' + this.tripId + '/members');
        this.members = (data && data.members) || [];
        this.isMemberView = !!(data && data.contact !== undefined);

        // isMember 以详情接口为准（仅当前在车上；曾加入已退出的走历史展示，不可再退出）
        this.isMember = !!this.trip.isMember;
      } catch (e) {
        /* 静默：成员列表加载失败不阻塞主流程 */
      } finally {
        this.membersLoading = false;
      }
    },

    // 取联系方式：本机有存档直接用；没有就弹底部弹层收集（替代 window.prompt）
    // prompt 在微信/QQ 内置浏览器里样式不可控，还会把「加入行程」打断成一个突兀的系统框
    ensureContact(cb) {
      const c = localStorage.getItem(LS.contact) || '';
      if (c) { cb(c); return; }
      this.joinContactValue = '';
      this.joinContactError = '';
      this.joinContactOpen = true;
      this._joinContactCb = cb;    // 弹层提交后回调，加入流程本身不变
    },

    submitJoinContact() {
      const c = (this.joinContactValue || '').trim();
      if (!c) { this.joinContactError = '请输入联系方式（微信号或手机号）'; return; }
      localStorage.setItem(LS.contact, c);
      this.joinContactOpen = false;
      const cb = this._joinContactCb;
      this._joinContactCb = null;
      if (cb) cb(c);
    },

    closeJoinContact() {
      this.joinContactOpen = false;
      this._joinContactCb = null;
    },

    joinTrip() {
      if (!this.isLoggedIn) { this.openLogin(); return; }
      this.ensureContact(async (contact) => {
        try {
          await this.api('/trips/' + this.tripId + '/join', { method: 'POST', body: { contact } });
          this.showToast('加入成功');
          const data = await this.api('/trips/' + this.tripId);
          this.trip = normTrip(data);
          await this.loadMembers();
        } catch (e) {
          this.showToast(e.message || '加入失败');
        }
      });
    },

    async leaveTrip() {
      const ok = await this.askConfirm({
        title: '退出行程',
        text: '确定退出该行程吗？',
        confirmText: '退出',
        danger: true          // 退出/取消这类不可逆操作给危险色，和「取消行程」保持同一套语义
      });
      if (!ok) return;
      try {
        await this.api('/trips/' + this.tripId + '/leave', { method: 'POST' });
        this.showToast('已退出');
        const data = await this.api('/trips/' + this.tripId);
        this.trip = normTrip(data);
        await this.loadMembers();
      } catch (e) {
        this.showToast(e.message || '退出失败');
      }
    },

    async completeTrip() {
      const ok = await this.askConfirm({
        title: '标记完成',
        text: '确认标记该行程为已完成？',
        confirmText: '标记完成'
      });
      if (!ok) return;
      this.statusBusy = true;
      try {
        await this.api('/trips/' + this.tripId + '/status', { method: 'PUT', body: { action: 'complete' } });
        this.showToast('已标记完成');
        const data = await this.api('/trips/' + this.tripId);
        this.trip = normTrip(data);
      } catch (e) {
        this.showToast(e.message || '操作失败');
      } finally {
        this.statusBusy = false;
      }
    },

    async cancelTrip() {
      const ok = await this.askConfirm({
        title: '取消行程',
        text: '确认取消该行程？',
        confirmText: '取消行程',
        danger: true
      });
      if (!ok) return;
      this.statusBusy = true;
      try {
        await this.api('/trips/' + this.tripId + '/status', { method: 'PUT', body: { action: 'cancel' } });
        this.showToast('已取消');
        const data = await this.api('/trips/' + this.tripId);
        this.trip = normTrip(data);
      } catch (e) {
        this.showToast(e.message || '操作失败');
      } finally {
        this.statusBusy = false;
      }
    },

    async saveCost() {
      const v = String(this.costInput).trim();
      let payload = '';
      if (v !== '') {
        const n = Number(v);
        if (Number.isNaN(n) || n < 0 || n > 999) return this.showToast('费用需为 0-999 元');
        payload = n;
      }
      this.statusBusy = true;
      try {
        await this.api('/trips/' + this.tripId + '/cost', { method: 'PUT', body: { actualCost: payload } });
        this.showToast('车费已更新');
        const data = await this.api('/trips/' + this.tripId);
        this.trip = normTrip(data);
        this.costInput = this.trip.actualCost != null ? String(this.trip.actualCost) : '';
      } catch (e) {
        this.showToast(e.message || '保存失败');
      } finally {
        this.statusBusy = false;
      }
    },

    // 复制（tripId 存在且已登录时，顺带埋点：联系方式复制是漏斗的关键一步）
    copy(text, tripId) {
      if (tripId && this.isLoggedIn) {
        this.api('/analytics/event', { method: 'POST', body: { type: 'contact_copy', tripId } }).catch(() => {});
      }
      const done = () => this.showToast('已复制');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallback());
      } else { fallback(); }
      function fallback() {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    },

    // ================= 发布 =================
    async submitTrip() {
      this.publishError = '';
      // 兜底：会话中途失效（token 过期）停在本页时，提交前先引导登录，不发无效请求
      if (!this.isLoggedIn) { this.publishError = '请登录后重试'; this.openLogin(); return; }
      const f = this.form;
      const from = f.from === '__custom__' ? f.fromCustom : f.from;
      const to = f.to === '__custom__' ? f.toCustom : f.to;

      if (!from) return (this.publishError = '请选择出发地');
      if (!to) return (this.publishError = '请选择目的地');
      if (from === to) return (this.publishError = '出发地和目的地不能相同');
      if (!f.date) return (this.publishError = '请选择出发日期');
      if (!f.time) return (this.publishError = '请选择出发时间');
      if (!f.contact) return (this.publishError = '请填写联系方式');
      if (new Date(f.date + 'T' + f.time + ':00').getTime() <= Date.now()) {
        return (this.publishError = '出发时间必须晚于当前时间');
      }

      this.publishing = true;
      try {
        await this.api('/trips', {
          method: 'POST',
          body: {
            from: from, to: to, date: f.date, time: f.time,
            contact: f.contact,
            remark: f.remark || undefined,
            capacity: [2, 3, 4][f.seats - 1] || 3
          }
        });
        localStorage.setItem(LS.contact, f.contact);
        this.showToast('发布成功');
        this.resetForm();
        this.go('hall');
      } catch (e) {
        this.publishError = e.message || '发布失败';
      } finally {
        this.publishing = false;
      }
    },

    resetForm() {
      this.form = {
        from: '', fromCustom: '', to: '', toCustom: '',
        date: dateStr(0), time: '', seats: 2,
        contact: localStorage.getItem(LS.contact) || '',
        remark: ''
      };
      this.publishError = '';
    },

    // ================= 我的 =================
    async loadMine() {
      if (!this.isLoggedIn) return;
      try {
        const [mine, joined] = await Promise.all([
          this.api('/trips/my').catch(() => []),
          this.api('/trips/joined').catch(() => [])
        ]);
        this.myPublished = (mine || []).map(normTrip);
        const mineIds = this.myPublished.map(t => String(t.id));
        this.myJoined = (joined || [])
          .map(normTrip)
          .filter(t => mineIds.indexOf(String(t.id)) === -1);
      } catch (e) {
        this.showToast(e.message || '加载失败');
      }
    },

    // 菜单图标映射
    iconOf(key) {
      const map = {
        hall: 'i-users', trips: 'i-clock', qq: 'i-chat', auth: 'i-shield',
        guide: 'i-book', legal: 'i-file', about: 'i-info'
      };
      return map[key] || 'i-info';
    },

    handleMenu(key) {
      if (key === 'hall') { this.go('hall'); return; }
      if (key === 'trips') {
        this.go('trips');
        return;
      }
      if (key === 'auth') {
        if (!this.isLoggedIn) { this.openLogin(); return; }
        this.showToast('邮箱已验证：' + this.email);
        return;
      }
      if (key === 'guide' || key === 'legal' || key === 'about' || key === 'qq') {
        this.go(key);
      }
    },

    // 并入 api() 后自带 30s 超时与错误兜底；QQ 频道是纯展示数据，失败静默（页面有独立空态文案）
    loadQQData() {
      this.api('/qq').then((d) => {
        this.qqData = d || null;
        this.qqTs = Date.now();
      }).catch(() => {});
    },

    // 大厅日期筛选：快捷标签与手动选日期互斥
    setDateFilter(k) {
      this.dateFilter = k;
    },

    openPicker(kind) {
      this.sheetPicker = kind;
      // 打开后把已选项滚到可视中间（只滚列表，不动页面）
      this.$nextTick(() => {
        const list = this.$el.querySelector('.pick-list');
        const cur = this.$el.querySelector('.pick-row.on');
        if (list && cur) list.scrollTop = Math.max(0, cur.offsetTop - list.clientHeight / 2);
      });
    },

    closePicker() { this.sheetPicker = ''; },

    pickOption(v) {
      if (this.sheetPicker === 'date') {
        this.dateFilter = v;          // 'all' 或具体日期
      } else {
        this.fromFilter = v;
      }
      this.closePicker();
    },

    openRename() {
      this.idSheetOpen = true;
      this.newId = this.displayName || '';
      this.idError = '';
    },

    async submitRename() {
      this.idError = '';
      const name = (this.newId || '').trim();
      if (!name) { this.idError = '请输入 ID'; return; }
      this.savingId = true;
      try {
        const data = await this.api('/user/display-name', {
          method: 'PUT',
          body: { displayName: name }
        });
        this.displayName = data.displayName || name;
        localStorage.setItem(LS.name, this.displayName);
        this.idSheetOpen = false;
        this.showToast('已更新');
      } catch (e) {
        this.idError = e.message || '修改失败';
      } finally {
        this.savingId = false;
      }
    },

    openContactEdit() {
      this.contactSheetOpen = true;
      this.newContact = localStorage.getItem(LS.contact) || '';
      this.contactError = '';
    },

    async submitContact() {
      this.contactError = '';
      const c = (this.newContact || '').trim();
      if (!c) { this.contactError = '请输入联系方式'; return; }
      this.savingContact = true;
      try {
        const data = await this.api('/user/contact', {
          method: 'PUT',
          body: { contact: c }
        });
        localStorage.setItem(LS.contact, data.contact || c);
        this.contactSheetOpen = false;
        this.showToast('已更新');
      } catch (e) {
        this.contactError = e.message || '修改失败';
      } finally {
        this.savingContact = false;
      }
    },

    logout(silent) {
      this.token = '';
      this.email = '';
      this.displayName = '';
      this.myPublished = [];
      this.myJoined = [];
      this.qqBound = false;
      localStorage.removeItem(LS.token);
      localStorage.removeItem(LS.email);
      localStorage.removeItem(LS.name);
      localStorage.removeItem(LS.contact);   // 共享电脑防外泄：不清的话下一个人的发布表单会预填上一位的联系方式
      // 需登录态的页面一律落回大厅：trips / publish（detail 游客可见，保留在原地）
      if (this.view === 'trips' || this.view === 'publish') this.view = 'hall';
      if (!silent) this.showToast('已退出登录');
    },

    async unbindQQ() {
      const ok = await this.askConfirm({
        title: '解除 QQ 绑定',
        text: '解除后需重新绑定才能使用机器人。',
        confirmText: '解除绑定',
        danger: true
      });
      if (!ok) return;
      try {
        await this.api('/user/qq-unbind', { method: 'POST' });
        this.qqBound = false;
        this.showToast('已解除 QQ 绑定');
      } catch (e) {
        this.showToast(e.message || '操作失败');
      }
    },

    // ================= 资料 =================
    // 登录后与进入页面时同步服务端资料（ID / 联系方式）到本地，跨设备一致
    async loadProfile() {
      if (!this.isLoggedIn) return;
      try {
        const p = await this.api('/user/profile');
        if (p.displayName) {
          this.displayName = p.displayName;
          localStorage.setItem(LS.name, p.displayName);
        }
        if (p.contact) localStorage.setItem(LS.contact, p.contact);
        this.qqBound = !!p.qqBound;
      } catch (e) { /* 静默：资料同步失败不阻塞 */ }
    },

    // ================= 登录 =================
    openLogin() {
      this.loginOpen = true;
      this.loginError = '';
    },

    async sendCode() {
      this.loginError = '';
      if (!this.loginPrefix) { this.loginError = '请输入学号'; return; }
      this.sending = true;
      try {
        await this.api('/auth/send-code', {
          method: 'POST',
          body: { emailPrefix: this.loginPrefix }
        });
        this.showToast('验证码已发送');
        this.startCountdown();
      } catch (e) {
        this.loginError = e.message || '发送失败';
      } finally {
        this.sending = false;
      }
    },

    startCountdown() {
      this.counting = true;
      this.countdown = 60;
      clearInterval(this._cdTimer);
      this._cdTimer = setInterval(() => {
        this.countdown -= 1;
        if (this.countdown <= 0) {
          clearInterval(this._cdTimer);
          this.counting = false;
          this.countdown = 60;
        }
      }, 1000);
    },

    async doLogin() {
      this.loginError = '';
      if (!this.loginPrefix || !this.loginCode) {
        this.loginError = '请填写学号与验证码';
        return;
      }
      this.loggingIn = true;
      try {
        const data = await this.api('/auth/web-login', {
          method: 'POST',
          body: { emailPrefix: this.loginPrefix, code: this.loginCode }
        });
        this.token = data.token;
        this.email = data.email || '';
        this.displayName = data.displayName || '';
        localStorage.setItem(LS.token, this.token);
        localStorage.setItem(LS.email, this.email);
        localStorage.setItem(LS.name, this.displayName);

        this.loginOpen = false;
        this.loginCode = '';
        this.showToast('登录成功');
        this.loadProfile();

        if (this._pendingTrips) {
          this._pendingTrips = false;
          this.go('trips');
        }
        if (this._pendingPublish) {
          this._pendingPublish = false;
          this.go('publish');
        }
        if (this.view === 'detail') this.loadMembers();
        if (this.view === 'trips') this.loadMine();
      } catch (e) {
        this.loginError = e.message || '登录失败';
      } finally {
        this.loggingIn = false;
      }
    },

    openExternal(url) { window.open(url, '_blank', 'noopener'); },

    openSponsor() {
      this.sponsorTs = Date.now();
      this.sponsorOpen = true;
    },

    async toggleContributors() {
      this.showContributors = !this.showContributors;
      if (this.showContributors && !this.contributors.length) {
        this.contributorsLoading = true;
        try {
          const list = await this.api('/contributors');
          this.contributors = Array.isArray(list) ? list : [];
        } catch (e) {
          this.contributors = [];
        }
        this.contributorsLoading = false;
      }
      if (this.showContributors) this.checkApply();
    },

    // 本机申请状态：LS 存编号 → 查服务端；已删除/撤回则清掉本地记录
    async checkApply() {
      if (!this.applyCode) { this.applyState = null; return; }
      try {
        const d = await this.api('/contributors/apply/' + this.applyCode);
        if (!d.found) {
          this.applyCode = '';
          localStorage.removeItem(LS.contribApply);
          this.applyState = null;
          return;
        }
        this.applyState = { status: d.status, name: d.name };
      } catch (e) { /* 网络异常保持现状 */ }
    },

    async submitApply() {
      this.applyError = '';
      if (!this.applyName) { this.applyError = '请填写希望展示的 ID'; return; }
      this.applying = true;
      try {
        // api() 在非 2xx 时抛出带服务端 message 的 Error：429 能显示「提交过于频繁，请明天再试」而非笼统的「提交失败」
        const data = await this.api('/contributors/apply', {
          method: 'POST',
          body: { name: this.applyName, role: this.applyRole, ref4: this.applyRef }
        });
        this.applyCode = String(data.code || '');
        localStorage.setItem(LS.contribApply, this.applyCode);
        this.applyFormOpen = false;
        this.applyName = this.applyRole = this.applyRef = '';
        await this.checkApply();
      } catch (e) {
        this.applyError = e.message || '提交失败，请稍后再试';
      } finally {
        this.applying = false;
      }
    },

    async withdrawApply() {
      if (!this.applyCode) return;
      try {
        await this.api('/contributors/apply/' + this.applyCode, { method: 'DELETE' });
      } catch (e) {
        this.applyError = e.message || '撤回失败，请稍后再试';
        return;
      }
      this.applyCode = '';
      this.applyState = null;
      this.applyFormOpen = true;
      localStorage.removeItem(LS.contribApply);
    },

    hideSponsorItem(e) {
      if (e.target && e.target.parentNode) e.target.parentNode.style.display = 'none';
    }
  },

  mounted() {
    window.addEventListener('hashchange', this.handleHash);

    // 已登录：同步服务端资料（ID / 联系方式跨设备一致）
    if (this.isLoggedIn) this.loadProfile();

    // 横向筛选行：鼠标滚轮纵向滚动时转为横向滚动（触屏本身可拖动）
    document.addEventListener('wheel', (e) => {
      const el = e.target instanceof Element ? e.target.closest('.chips-track') : null;
      if (!el || el.scrollWidth <= el.clientWidth) return;
      const delta = e.deltaY || e.deltaX;
      // 已滚到头/尾且还在往同方向滚：放行页面滚动，避免鼠标停在筛选行上时整页滚不动
      const atStart = el.scrollLeft <= 0 && delta < 0;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 && delta > 0;
      if (atStart || atEnd) return;
      el.scrollLeft += delta;
      e.preventDefault();
    }, { passive: false });

    // 地点库（静态明文，与 server/qqbot 同源）：拉取失败则仅剩自定义输入可用
    fetch('/locations.json').then((r) => r.json()).then((d) => {
      if (Array.isArray(d.locations)) this.locations = d.locations;
    }).catch(() => {});

    this.form.date = dateStr(0);
    this.form.contact = localStorage.getItem(LS.contact) || '';

    const h = location.hash.replace(/^#\/?/, '');
    const guideSeen = localStorage.getItem('bhtxweb_guide_seen');

    if (h.indexOf('trip/') === 0) {
      this.openTrip(h.slice(5), true);
    } else if (h.indexOf('ext/') === 0) {
      // 雷达原帖详情：先立起详情骨架（模板自带「加载中」），列表数据到位后再填内容
      this.view = 'extdetail';
      this.handleHash();
    } else if (['publish', 'menu', 'trips', 'about', 'qq', 'guide', 'legal'].indexOf(h) > -1) {
      // 走 go()，使「行程历史」的认证判断同样生效
      this.go(h, true);
    } else if (!guideSeen) {
      // 首次进入：先看使用教程
      localStorage.setItem('bhtxweb_guide_seen', '1');
      this.view = 'guide';
      location.hash = '#/guide';
    } else {
      this.view = 'hall';
      this.reloadHall();
    }
  }
});

// ===== 二维码组件：把链接直接画成 SVG =====
// 为什么画而不存图：官方群码截图 507KB 且放大发虚；链接本身只有一串字符，
// 前端绘制后体积归零、矢量清晰，换群只需改一行文本。
// 库：/vendor/qr-creator.min.js（全局 QrCreator，MIT，12KB，本地托管以守住零 CDN 约定）。
// 兜底：库没加载或画不出来时，退化成可点击的加群链接（移动端点一下就能加）。
app.component('qr-box', {
  props: {
    text: { type: String, default: '' },
    size: { type: Number, default: 320 }
  },
  template:
    '<div class="qr-box">' +
      '<div v-if="ok" class="qr-canvas"></div>' +
      '<a v-else class="qr-fallback" :href="text" target="_blank" rel="noopener">二维码暂不可用，点此直接打开</a>' +
    '</div>',
  data() { return { ok: true }; },
  mounted() { this.draw(); },
  watch: { text() { this.draw(); } },
  methods: {
    draw() {
      const t = String(this.text || '').trim();
      if (!t || typeof window.QrCreator === 'undefined') { this.ok = false; return; }
      this.$nextTick(() => {
        const box = this.$el.querySelector('.qr-canvas');
        if (!box) return;
        box.innerHTML = '';
        try {
          window.QrCreator.render({
            text: t, radius: 0.05, margin: 0.05,
            fgColor: '#0B1220', bgColor: '#FFFFFF', size: this.size
          }, box);
          this.ok = true;
        } catch (e) {
          console.warn('[qr-box] 绘制失败，退化为链接：', e.message);
          this.ok = false;
        }
      });
    }
  }
});

app.mount('#app');
