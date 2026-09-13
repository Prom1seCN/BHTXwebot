/* 百花同行 Web (BHTXweb) —— 前端应用
 * 纯前端逻辑，所有业务规则由后端 API 提供（不重复实现）
 */

// 百花同行 QQ 群号（填入后，关于页点「QQ群」即可复制群号）
const QQ_GROUP = '';

// 地点库（与后端无关，仅用于表单选项）
const LOCATIONS = [
  '北化北区', '北化东区', '北化西区', '昌平西山口', '乐多港万达',
  '昌平悦荟', '昌平区医院', '昌平北站', '南口镇', '首都机场',
  '大兴机场', '北京南站', '北京西站', '北京站', '北京朝阳站',
  '北京丰台站', '清河站/北京北站'
];

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
  contact: 'bhtxweb_contact'
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

      // ---- 大厅 ----
      trips: [],
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
      locations: LOCATIONS,

      // ---- 详情 ----
      tripId: '',
      trip: null,
      members: [],
      membersLoading: false,
      isMember: false,
      statusBusy: false,
      costInput: '',
      isMemberView: false,

      // ---- 共建者名录 ----
      showContributors: false,
      contributorsLoading: false,
      contributors: [],

      // ---- 赞助 ----
      sponsorOpen: false,
      sponsorTs: 0,
      sponsorFormOpen: false,
      sponsorApplied: false,
      applyName: '',
      applyRole: '',
      applyRef: '',
      applyError: '',
      applying: false,

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
    // 菜单项：邮箱认证后面缀当前认证状态
    menuList() {
      const base = this.menus.map((m) => m.key === 'auth'
        ? Object.assign({}, m, { note: this.isLoggedIn ? '已认证' : '未认证' })
        : m);
      // 登录后才有「退出登录」——桌面侧栏与手机菜单页共用这一份
      return this.isLoggedIn
        ? base.concat([{ key: 'logout', label: '退出登录', note: '' }])
        : base;
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
    }
  },

  methods: {
    // ================= API =================
    async api(path, opts) {
      opts = opts || {};
      const headers = { 'Content-Type': 'application/json' };
      if (this.token) headers.Authorization = 'Bearer ' + this.token;

      const res = await fetch('/api' + path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) this.logout(true);
        const e = new Error((data && data.message) || '请求失败');
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

      this.view = view;
      if (!fromHash) location.hash = view === 'hall' ? '#/' : '#/' + view;
      if (view === 'hall') this.reloadHall();
      if (view === 'trips') this.loadMine();
      window.scrollTo(0, 0);
    },

    // 未认证时点「行程历史」：提示并引导到邮箱认证
    askAuthForTrips() {
      this._pendingTrips = true;
      this.showToast('查看我的行程需先完成邮箱认证');
      if (location.hash !== '#/' && location.hash !== '') location.hash = '#/';
      setTimeout(() => { if (!this.isLoggedIn) this.openLogin(); }, 600);
    },

    goPublish() {
      if (!this.isLoggedIn) { this.openLogin(); return; }
      this.go('publish');
    },

    handleHash() {
      const h = location.hash.replace(/^#\/?/, '');
      if (h.indexOf('trip/') === 0) {
        const id = h.slice(5);
        if (this.view !== 'detail' || this.tripId !== id) this.openTrip(id, true);
        return;
      }
      const v = ['publish', 'menu', 'trips', 'about', 'guide', 'legal'].indexOf(h) > -1 ? h : 'hall';
      if (this.view !== v) this.go(v, true);
    },

    // ================= 大厅 =================
    async reloadHall() {
      this.loading = true;
      try {
        const list = await this.api('/trips');
        this.trips = (list || []).map(normTrip);
      } catch (e) {
        this.showToast(e.message || '加载失败');
      } finally {
        this.loading = false;
      }
    },

    // ================= 详情 =================
    async openTrip(id, fromHash) {
      if (!fromHash) location.hash = '#/trip/' + id;
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

    ensureContact(cb) {
      let c = localStorage.getItem(LS.contact) || '';
      if (c) { cb(c); return; }
      c = window.prompt('请输入联系方式（微信号或手机号）');
      if (!c || !c.trim()) return;
      c = c.trim();
      localStorage.setItem(LS.contact, c);
      cb(c);
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
      if (!window.confirm('确定退出该行程吗？')) return;
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
      if (!window.confirm('确认标记该行程为已完成？')) return;
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
      if (!window.confirm('确认取消该行程？')) return;
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
        hall: 'i-users', trips: 'i-clock', auth: 'i-shield',
        guide: 'i-book', legal: 'i-file', about: 'i-info', logout: 'i-logout'
      };
      return map[key] || 'i-info';
    },

    handleMenu(key) {
      if (key === 'logout') { this.logout(); return; }
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
      if (key === 'guide' || key === 'legal' || key === 'about') {
        this.go(key);
      }
    },

    // TODO: 填入百花同行 QQ 群号后，点击「QQ群」即可复制
    joinQQGroup() {
      if (!QQ_GROUP) { this.showToast('QQ 群号待补充'); return; }
      this.copy(QQ_GROUP);
      this.showToast('群号已复制：' + QQ_GROUP);
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
      if (this.view === 'trips') this.view = 'hall';
      if (!silent) this.showToast('已退出登录');
    },

    async unbindQQ() {
      if (!window.confirm('确认解除 QQ 绑定？解除后需重新绑定才能使用机器人。')) return;
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
        if (this.view === 'detail') this.loadMembers();
        if (this.view === 'trips') this.loadMine();
      } catch (e) {
        this.loginError = e.message || '登录失败';
      } finally {
        this.loggingIn = false;
      }
    },

    openExternal(url) { window.open(url, '_blank'); },

    openSponsor() {
      this.sponsorTs = Date.now();
      this.sponsorOpen = true;
    },

    async toggleContributors() {
      this.showContributors = !this.showContributors;
      if (this.showContributors && !this.contributors.length) {
        this.contributorsLoading = true;
        try {
          const res = await fetch('/api/contributors');
          const list = await res.json();
          this.contributors = Array.isArray(list) ? list : [];
        } catch (e) {
          this.contributors = [];
        }
        this.contributorsLoading = false;
      }
    },

    hideSponsorItem(e) {
      if (e.target && e.target.parentNode) e.target.parentNode.style.display = 'none';
    },

    async submitSponsorApply() {
      this.applyError = '';
      if (!this.applyName) { this.applyError = '请填写希望展示的名字'; return; }
      this.applying = true;
      try {
        const res = await fetch('/api/contributors/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: this.applyName,
            role: this.applyRole,
            ref4: this.applyRef,
            channel: 'web'
          })
        });
        const data = await res.json().catch(() => ({}));
        if (res.status !== 200) { this.applyError = data.message || '提交失败，请稍后再试'; return; }
        this.sponsorApplied = true;
      } catch (e) {
        this.applyError = '提交失败，请稍后再试';
      } finally {
        this.applying = false;
      }
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
      el.scrollLeft += (e.deltaY || e.deltaX);
      e.preventDefault();
    }, { passive: false });

    this.form.date = dateStr(0);
    this.form.contact = localStorage.getItem(LS.contact) || '';

    const h = location.hash.replace(/^#\/?/, '');
    const guideSeen = localStorage.getItem('bhtxweb_guide_seen');

    if (h.indexOf('trip/') === 0) {
      this.openTrip(h.slice(5), true);
    } else if (['publish', 'menu', 'trips', 'about', 'guide', 'legal'].indexOf(h) > -1) {
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

app.mount('#app');
