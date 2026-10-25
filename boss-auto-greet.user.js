// ==UserScript==
// @name         BOSS直聘 · 自动打招呼
// @namespace    https://www.zhipin.com/
// @version      1.1.1
// @description  在职位列表里自动「立即沟通」打招呼：关键词过滤、随机间隔、每日上限、已沟通去重、试运行
// @author       local
// @match        https://www.zhipin.com/web/geek/jobs*
// @match        https://www.zhipin.com/web/geek/chat*
// @match        https://*.zhipin.com/web/geek/jobs*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * 用法（简版）
 *   1. 装好篡改猴 / Tampermonkey，把本文件拖进浏览器安装。
 *   2. 打开 BOSS 直聘「职位」页（www.zhipin.com/web/geek/jobs），右下角出现面板。
 *   3. 先勾「试运行」跑 2~3 个看看筛选对不对，再取消勾选正式跑。
 *
 * 设计原则：只做“人手动会做的动作”，节奏放慢，随时可停；不调用接口、不伪造请求。
 */

(function () {
  'use strict';

  if (window.__BAG_LOADED__) return;
  window.__BAG_LOADED__ = true;

  /* ============================================================
   * 0. 常量与基础工具
   * ============================================================ */
  const VERSION = '1.1.1';
  const IS_ZHIPIN = /(^|\.)zhipin\.com$/i.test(location.hostname);
  const TEST = !IS_ZHIPIN; // 本地仿站测试时走这个分支
  const PREFIX = 'bag.v1.';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const nowStr = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const dayStr = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    return true;
  }

  function area(el) {
    const r = el.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
  }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  /**
   * 模拟一次完整的鼠标点击（pointerdown → mousedown → pointerup → mouseup → click）。
   * 注意：事件直接派发到 el 上，因此 el 若是 <a href="/job_detail/..."> 也不会跳转；
   * 需要时再额外挂一次 preventDefault 兜底。
   */
  function clickEl(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, button: 0, buttons: 1,
    };
    const guard = (e) => e.preventDefault();
    let guarded = false;
    // 卡片本身可能是 <a>，避免触发整页跳转
    if (el.tagName === 'A' && /\/job_detail\//.test(el.getAttribute('href') || '')) {
      el.addEventListener('click', guard, true);
      guarded = true;
    }
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    } catch (e) {
      try { el.click(); } catch (_) {}
    }
    if (guarded) setTimeout(() => el.removeEventListener('click', guard, true), 60);
    return true;
  }

  async function waitFor(fn, timeout, interval) {
    const t0 = Date.now();
    const step = interval || 200;
    while (Date.now() - t0 < timeout) {
      let v = false;
      try { v = fn(); } catch (e) { v = false; }
      if (v) return v;
      await sleep(step);
    }
    return false;
  }

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const toNum = (v, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };

  /* ============================================================
   * 1. 本地存储：配置 / 已沟通记录 / 当天计数
   * ============================================================ */
  const store = {
    read(key, def) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw === null ? def : JSON.parse(raw);
      } catch (e) {
        return def;
      }
    },
    write(key, val) {
      try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); } catch (e) {}
    },
  };

  const DEFAULT_CFG = {
    minDelay: 8,          // 两条之间的最小间隔（秒）
    maxDelay: 18,         // 两条之间的最大间隔（秒）
    dailyCap: 40,         // 每日上限（自己设的保险丝，平台另有上限）
    runCap: 20,           // 本次运行上限
    include: '测试',       // 必含关键词，逗号分隔，命中任意一个即可；留空=不限
    exclude: '销售,客服,培训,招生,中介,保险,房产,兼职,日结,推广,运营助理,电销',
    minSalaryK: 0,        // 薪资下限（K），0=不限
    blacklist: '',        // 公司黑名单，逗号分隔
    skipGreeted: true,    // 跳过本地记录里打过招呼的职位
    dryRun: false,        // 试运行：只点开看筛选结果，不点「立即沟通」
    longRestEvery: 10,    // 每发 N 条长休息一次
    autoSendResume: false // 弹「发送简历」时是否自动点发送
  };

  const cfg = Object.assign({}, DEFAULT_CFG, store.read('cfg', {}));

  let greeted = store.read('greeted', {}) || {}; // { jobId: {t, c, j} }
  let stats = store.read('stats', {}) || {};

  function ensureToday() {
    if (stats.date !== dayStr()) {
      stats = { date: dayStr(), sent: 0 };
      store.write('stats', stats);
    }
    if (typeof stats.sent !== 'number') stats.sent = 0;
  }
  ensureToday();

  function pruneGreeted() {
    const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
    let changed = false;
    Object.keys(greeted).forEach((id) => {
      if (!greeted[id] || greeted[id].t < cutoff) { delete greeted[id]; changed = true; }
    });
    if (changed) store.write('greeted', greeted);
  }
  pruneGreeted();

  function markGreeted(job) {
    greeted[job.id] = { t: Date.now(), c: job.company || '', j: job.title || '' };
    store.write('greeted', greeted);
  }

  function saveCfg() {
    store.write('cfg', cfg);
  }

  /* ============================================================
   * 2. 页面识别：卡片、详情、按钮、弹窗
   * ============================================================ */

  /** 从 href 里取 jobId：/job_detail/xxxxxxxx.html */
  function jobIdFrom(href) {
    const m = String(href || '').match(/\/job_detail\/([0-9a-zA-Z_-]+)\.html/);
    return m ? m[1] : '';
  }

  /** 列表区（左半屏）里所有职位链接 */
  function jobLinks() {
    const W = innerWidth;
    return $$('a[href*="/job_detail/"]').filter((a) => {
      if (!isVisible(a)) return false;
      const r = a.getBoundingClientRect();
      return r.left < W * 0.55 && r.width > 40;
    });
  }

  /** 由链接往上找卡片容器 */
  function cardOf(a) {
    let el = a;
    for (let i = 0; i < 6 && el && el !== document.body; i++) {
      const cls = typeof el.className === 'string' ? el.className : '';
      if (/job-card|job-card-wrapper|job-list-item/i.test(cls)) return el;
      el = el.parentElement;
    }
    let p = a.parentElement;
    for (let i = 0; i < 3 && p && p !== document.body; i++) p = p.parentElement;
    return p || a;
  }

  /** 解析 "7-8K·13薪" / "4-8K" / "面议" */
  function salaryMax(s) {
    const t = String(s || '');
    const m = t.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[Kk千]/);
    if (m) return Number(m[2]);
    const m2 = t.match(/(\d+(?:\.\d+)?)\s*[Kk千]/);
    return m2 ? Number(m2[1]) : null;
  }

  /** 扫描左半屏职位卡片 */
  function scanCards() {
    const out = [];
    const seen = Object.create(null);
    jobLinks().forEach((a) => {
      const id = jobIdFrom(a.getAttribute('href'));
      if (!id || seen[id]) return;
      seen[id] = 1;
      const card = cardOf(a);
      const cardText = textOf(card);
      const title = textOf(a) || (cardText.split(' ')[0] || '');
      const salEl = card.querySelector('[class*="salary"]');
      const salary = salEl ? textOf(salEl) : (cardText.match(/\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*[Kk]/) || [''])[0];
      const comEl = card.querySelector('[class*="company-name"]') || card.querySelector('[class*="company"]');
      out.push({
        id,
        title,
        salary,
        company: comEl ? textOf(comEl) : '',
        cardText,
        el: card,
        link: a,
      });
    });
    return out;
  }

  /** 右侧详情容器 */
  function detailRoot() {
    const cands = $$('[class*="job-detail"], .job-detail, [class*="job-sec"], [class*="detail-box"], [class*="job-banner"]')
      .filter((el) => isVisible(el) && textOf(el).length > 10);
    if (cands.length) {
      return cands.sort((a, b) => textOf(b).length - textOf(a).length)[0];
    }
    const hit = document.elementFromPoint(innerWidth * 0.75, innerHeight * 0.45);
    let el = hit;
    for (let i = 0; i < 8 && el; i++) {
      if (textOf(el).length > 150) return el;
      el = el.parentElement;
    }
    return null;
  }

  function detailText() {
    const r = detailRoot();
    return r ? textOf(r) : '';
  }

  function normText(s) {
    return String(s || '').replace(/\s+/g, '');
  }

  /**
   * 标题归一：去掉空白、括号里的城市、尾部「-出差」这类后缀。
   * 卡片标题常带「（广州）」「-出差」，右侧详情大标题往往没有，归一后就能对上。
   */
  function normTitle(s) {
    let t = normText(s);
    t = t.replace(/[（(][^（）()]{1,12}[）)]/g, '');
    t = t.replace(/[-－—–_|·•].*$/, '');
    return t;
  }

  /** 右侧详情里的职位标题（优先 h1，找不到返回空串） */
  function detailTitle() {
    const root = detailRoot();
    if (!root) return '';
    const cand = root.querySelector('h1, [class*="job-name"], [class*="job-title"], [class*="position-name"]');
    const t = cand ? normText(textOf(cand)) : '';
    return t && t.length <= 40 ? t : '';
  }

  /**
   * 右侧详情对应的职位 id（有就用它精确判断「现在展示的是不是这个职位」）。
   * BOSS 有些地方会带 jobId（data 属性或详情里的职位链接），没有就返回空串，退回标题比对。
   */
  function detailJobId() {
    const root = detailRoot();
    if (!root) return '';
    const attrs = ['data-jobid', 'data-job-id', 'jobid'];
    const readAttrs = (el) => {
      for (const k of attrs) {
        const v = el.getAttribute(k);
        if (v && /^[0-9a-zA-Z_-]{4,}$/.test(v)) return v;
      }
      return '';
    };
    let v = readAttrs(root);
    if (v) return v;
    const holder = root.querySelector('[data-jobid],[data-job-id],[jobid]');
    if (holder) {
      v = readAttrs(holder);
      if (v) return v;
    }
    const a = root.querySelector('a[href*="/job_detail/"]');
    if (a) {
      const id = jobIdFrom(a.getAttribute('href'));
      if (id) return id;
    }
    return '';
  }

  /** 「立即沟通」按钮（只在右半屏找，避开列表里的同名元素） */
  function findChatButton() {
    const W = innerWidth;
    const isBtn = (t) => /^(立即沟通|继续沟通|打招呼)$/.test(t);
    const cands = $$('a,button,[class*="btn"]').filter((el) => {
      if (!isVisible(el)) return false;
      if (!isBtn(textOf(el))) return false;
      const r = el.getBoundingClientRect();
      return r.left > W * 0.3;
    });
    if (cands.length) {
      // 取最“里层”的那个，避免点到外层包装
      const inner = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
      const pick = inner[0] || cands[0];
      return pick;
    }
    const cls = $$('[class*="startchat"],[class*="start-chat"],[class*="btn-chat"],[class*="op-btn-chat"],[class*="chat-btn"]')
      .filter(isVisible);
    return cls[0] || null;
  }

  /** 当前可见弹窗（取最里层、面积最小的那个） */
  function findDialog() {
    const list = $$('[class*="dialog"],[class*="modal"],[role="dialog"],[class*="popup"],[class*="layer"]')
      .filter((el) => isVisible(el) && textOf(el).length > 0);
    if (!list.length) return null;
    const inner = list.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width < innerWidth * 0.98 && r.height < innerHeight * 0.98;
    });
    const pool = inner.length ? inner : list;
    const hit = pool.find((el) => /已向BOSS发送消息|上限|验证|频繁|简历|沟通成功|发送成功/.test(textOf(el)));
    if (hit) return hit;
    return pool.sort((a, b) => area(a) - area(b))[0] || null;
  }

  /** 关掉弹窗：优先「留在此页」，其次关闭按钮，最后 Esc */
  async function dismissDialog(dlg) {
    const box = dlg || findDialog();
    if (!box) return;
    const btn = $$('a,button,span,div', box).find((el) =>
      isVisible(el) && /^(留在此页|知道了|关闭|确定|好的|取消)$/.test(textOf(el))
    );
    if (btn) {
      clickEl(btn);
    } else {
      const x = $$('[class*="close"],[class*="icon-close"],i', box).find(isVisible);
      if (x) clickEl(x);
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    }
    await sleep(rand(300, 600));
  }

  /** 页面是否出现安全验证 / 风控提示 */
  function looksBlocked() {
    const t = document.body ? document.body.innerText : '';
    return /请完成.*验证|安全验证|滑动验证|人机验证|拖动滑块|操作过于频繁|访问异常/.test(t);
  }

  /** 列表滚动容器 */
  function scrollTarget() {
    const a = jobLinks()[0];
    let el = a ? a.parentElement : null;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 30) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  /* ============================================================
   * 3. 筛选
   * ============================================================ */
  function parseList(s) {
    return String(s || '')
      .split(/[,，;；|\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function filterReason(job) {
    const inc = parseList(cfg.include);
    const exc = parseList(cfg.exclude);
    const blk = parseList(cfg.blacklist);
    const title = job.title || '';
    const company = job.company || '';
    const hay = title + ' ' + company;

    if (inc.length && !inc.some((k) => hay.includes(k))) return '不含关键词';
    if (exc.some((k) => title.includes(k))) return '命中排除词';
    if (blk.some((k) => company.includes(k))) return '公司黑名单';
    const maxK = salaryMax(job.salary);
    if (cfg.minSalaryK > 0 && maxK !== null && maxK < cfg.minSalaryK) return '薪资低于 ' + cfg.minSalaryK + 'K';
    return '';
  }

  /* ============================================================
   * 4. 面板 UI（Shadow DOM，避免被站点样式污染）
   * ============================================================ */
  const panel = {
    host: null,
    root: null,
    el: {},
    logs: [],
    built: false,

    build() {
      if (this.built) return;
      const host = document.createElement('div');
      host.id = 'bag-host';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host, * { box-sizing: border-box; margin: 0; padding: 0; }
          * { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
          .wrap {
            width: 344px; max-height: 78vh; display: flex; flex-direction: column;
            background: #14161b; color: #e7e8ee; border: 1px solid #2b2f38;
            border-radius: 12px; overflow: hidden;
            box-shadow: 0 14px 44px rgba(0,0,0,.5); font-size: 13px; line-height: 1.5;
          }
          .hd {
            display: flex; align-items: center; gap: 7px; padding: 9px 10px;
            background: linear-gradient(90deg,#0f3d3a,#14161b); cursor: move; user-select: none;
            border-bottom: 1px solid #262a33;
          }
          .hd b { font-size: 13px; font-weight: 600; letter-spacing: .2px; }
          .hd .ver { font-size: 10px; color: #7d8494; }
          .dot { width: 8px; height: 8px; border-radius: 50%; background: #5b6270; flex: none; }
          .dot.run { background: #2ed39a; box-shadow: 0 0 0 3px rgba(46,211,154,.15); }
          .dot.pause { background: #f5b544; }
          .dot.stop { background: #ef5b5b; }
          .sp { flex: 1; }
          .hd button {
            width: 24px; height: 22px; border: 0; border-radius: 6px; background: #232730;
            color: #c3c8d4; cursor: pointer; font-size: 13px;
          }
          .hd button:hover { background: #2e333e; }
          .bd { padding: 10px; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
          .status { font-size: 12px; color: #aeb5c4; }
          .status b { color: #fff; font-weight: 600; }
          .btns { display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 6px; }
          .btns button {
            padding: 7px 0; border: 0; border-radius: 8px; cursor: pointer; font-size: 12.5px;
            font-weight: 600; transition: filter .15s;
          }
          .btns button:hover { filter: brightness(1.12); }
          .btns button:disabled { opacity: .45; cursor: not-allowed; }
          #start { background: #00bebd; color: #05201f; }
          #pause { background: #3a3f4b; color: #dfe3ec; }
          #stop  { background: #3a3f4b; color: #ffb4b4; }
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
          .fld { display: flex; flex-direction: column; gap: 2px; }
          .fld.full { grid-column: 1 / -1; }
          .fld label { font-size: 11px; color: #8b93a4; }
          .fld input[type=text], .fld input[type=number] {
            background: #1c1f26; border: 1px solid #2e333e; color: #e7e8ee;
            border-radius: 6px; padding: 5px 7px; font-size: 12px; width: 100%;
          }
          .fld input:focus { outline: none; border-color: #00bebd; }
          .chk { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #c6ccd8; }
          .chk input { accent-color: #00bebd; }
          .row { display: flex; gap: 12px; flex-wrap: wrap; }
          .log {
            background: #0d0f13; border: 1px solid #232730; border-radius: 8px;
            height: 132px; overflow: auto; padding: 6px 8px; font-size: 11.5px;
            font-family: Consolas, "Courier New", monospace; line-height: 1.55;
          }
          .log div { color: #9aa2b2; word-break: break-all; }
          .log .ok { color: #4ade9b; }
          .log .skip { color: #6b7383; }
          .log .warn { color: #f5b544; }
          .log .err { color: #ff6b6b; }
          .log .dry { color: #b48cff; }
          .foot { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #767e8e; }
          .foot a { color: #6f8aa8; text-decoration: none; cursor: pointer; }
          .foot a:hover { text-decoration: underline; }
          .mini {
            display: none; width: 46px; height: 46px; border-radius: 50%; border: 0;
            background: #00bebd; color: #05201f; font-weight: 700; font-size: 12px;
            cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,.45);
          }
          .collapsed .wrap { display: none; }
          .collapsed .mini { display: block; }
        </style>
        <div class="wrap">
          <div class="hd" id="hd">
            <span class="dot" id="dot"></span><b>BOSS 自动打招呼</b>
            <span class="ver">v${VERSION}</span>
            <span class="sp"></span>
            <button id="mini" title="收起">—</button>
          </div>
          <div class="bd">
            <div class="status" id="status">状态：<b>空闲</b></div>
            <div class="btns">
              <button id="start">▶ 开始</button>
              <button id="pause" disabled>⏸ 暂停</button>
              <button id="stop" disabled>⏹ 停止</button>
            </div>
            <div class="grid">
              <div class="fld"><label>间隔最小（秒）</label><input type="number" id="minDelay" min="2" max="600"></div>
              <div class="fld"><label>间隔最大（秒）</label><input type="number" id="maxDelay" min="3" max="900"></div>
              <div class="fld"><label>今日上限</label><input type="number" id="dailyCap" min="1" max="300"></div>
              <div class="fld"><label>本次上限</label><input type="number" id="runCap" min="1" max="300"></div>
              <div class="fld full"><label>必含关键词（逗号分隔，空=不限）</label><input type="text" id="include"></div>
              <div class="fld full"><label>排除关键词（只看职位名）</label><input type="text" id="exclude"></div>
              <div class="fld"><label>薪资下限（K，0=不限）</label><input type="number" id="minSalaryK" min="0" max="200"></div>
              <div class="fld"><label>每发 N 条长休息</label><input type="number" id="longRestEvery" min="0" max="100"></div>
              <div class="fld full"><label>公司黑名单（逗号分隔）</label><input type="text" id="blacklist"></div>
            </div>
            <div class="row">
              <label class="chk"><input type="checkbox" id="skipGreeted"> 跳过已打过招呼</label>
              <label class="chk"><input type="checkbox" id="dryRun"> 试运行（不发送）</label>
            </div>
            <div class="log" id="log"></div>
            <div class="foot">
              <span>本地记录 <b id="cnt">0</b> 条</span><span class="sp"></span>
              <a id="clear">清空记录</a><a id="reset">恢复默认</a><a id="scan">自检</a>
            </div>
          </div>
        </div>
        <button class="mini" id="expand" title="展开">BOSS</button>
      `;

      host.style.cssText =
        'position:fixed;right:18px;bottom:18px;z-index:2147483000;display:block;';

      document.documentElement.appendChild(host);
      this.host = host;
      this.root = shadow;
      this.built = true;

      this.el = {
        dot: shadow.getElementById('dot'),
        status: shadow.getElementById('status'),
        start: shadow.getElementById('start'),
        pause: shadow.getElementById('pause'),
        stop: shadow.getElementById('stop'),
        log: shadow.getElementById('log'),
        cnt: shadow.getElementById('cnt'),
        hd: shadow.getElementById('hd'),
      };

      // 拖拽
      const hd = shadow.getElementById('hd');
      let dragging = false, dx = 0, dy = 0;
      hd.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        const r = host.getBoundingClientRect();
        dx = e.clientX - r.left;
        dy = e.clientY - r.top;
        host.style.right = 'auto';
        host.style.bottom = 'auto';
        host.style.left = r.left + 'px';
        host.style.top = r.top + 'px';
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        host.style.left = clamp(e.clientX - dx, 0, innerWidth - 60) + 'px';
        host.style.top = clamp(e.clientY - dy, 0, innerHeight - 40) + 'px';
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        store.write('panelPos', { left: host.style.left, top: host.style.top });
      });

      // 折叠
      shadow.getElementById('mini').addEventListener('click', () => host.classList.add('collapsed'));
      shadow.getElementById('expand').addEventListener('click', () => host.classList.remove('collapsed'));

      // 按钮
      shadow.getElementById('start').addEventListener('click', () => runner.start());
      shadow.getElementById('pause').addEventListener('click', () => {
        if (runner.paused) runner.resume(); else runner.pause();
      });
      shadow.getElementById('stop').addEventListener('click', () => runner.stop('手动停止'));
      shadow.getElementById('clear').addEventListener('click', () => {
        greeted = {};
        store.write('greeted', greeted);
        stats = { date: dayStr(), sent: 0 };
        store.write('stats', stats);
        panel.log('info', '已清空本地记录');
        panel.render();
      });
      shadow.getElementById('scan').addEventListener('click', () => selfCheck());
      shadow.getElementById('reset').addEventListener('click', () => {
        // 用户改过脚本里的 DEFAULT_CFG 时，点这个就能把新默认值套上来
        Object.keys(DEFAULT_CFG).forEach((k) => { cfg[k] = DEFAULT_CFG[k]; });
        saveCfg();
        panel.fillInputs();
        panel.render();
        panel.log('info', `已恢复默认参数：今日上限 ${cfg.dailyCap}、本次上限 ${cfg.runCap}、间隔 ${cfg.minDelay}~${cfg.maxDelay} 秒`);
      });

      // 配置双向绑定
      const bind = (id, key, type) => {
        const input = shadow.getElementById(id);
        if (type === 'bool') {
          input.checked = !!cfg[key];
          input.addEventListener('change', () => { cfg[key] = input.checked; saveCfg(); });
        } else if (type === 'num') {
          input.value = cfg[key];
          input.addEventListener('change', () => {
            cfg[key] = toNum(input.value, DEFAULT_CFG[key]);
            if (key === 'minDelay' && cfg.minDelay > cfg.maxDelay) cfg.maxDelay = cfg.minDelay;
            if (key === 'maxDelay' && cfg.maxDelay < cfg.minDelay) cfg.minDelay = cfg.maxDelay;
            saveCfg();
            panel.fillInputs();
          });
        } else {
          input.value = cfg[key] || '';
          input.addEventListener('change', () => { cfg[key] = input.value; saveCfg(); });
        }
      };
      bind('minDelay', 'minDelay', 'num');
      bind('maxDelay', 'maxDelay', 'num');
      bind('dailyCap', 'dailyCap', 'num');
      bind('runCap', 'runCap', 'num');
      bind('include', 'include', 'text');
      bind('exclude', 'exclude', 'text');
      bind('minSalaryK', 'minSalaryK', 'num');
      bind('longRestEvery', 'longRestEvery', 'num');
      bind('blacklist', 'blacklist', 'text');
      bind('skipGreeted', 'skipGreeted', 'bool');
      bind('dryRun', 'dryRun', 'bool');

      this.render();
    },

    fillInputs() {
      if (!this.built) return;
      const s = this.root;
      s.getElementById('minDelay').value = cfg.minDelay;
      s.getElementById('maxDelay').value = cfg.maxDelay;
      s.getElementById('dailyCap').value = cfg.dailyCap;
      s.getElementById('runCap').value = cfg.runCap;
      s.getElementById('include').value = cfg.include || '';
      s.getElementById('exclude').value = cfg.exclude || '';
      s.getElementById('minSalaryK').value = cfg.minSalaryK;
      s.getElementById('longRestEvery').value = cfg.longRestEvery;
      s.getElementById('blacklist').value = cfg.blacklist || '';
      s.getElementById('skipGreeted').checked = !!cfg.skipGreeted;
      s.getElementById('dryRun').checked = !!cfg.dryRun;
    },

    render() {
      if (!this.built) return;
      const r = runner;
      const label = r.state === 'running' ? '运行中' : r.state === 'paused' ? '已暂停' : r.state === 'stopping' ? '停止中' : '空闲';
      const today = stats.sent || 0;
      this.el.status.innerHTML =
        `状态：<b>${label}</b> · 今日 <b>${today}</b>/${cfg.dailyCap} · 本次 <b>${r.runSent}</b>/${cfg.runCap}` +
        (r.stopReason ? `<br><span style="color:#f5b544">${r.stopReason}</span>` : '');
      this.el.dot.className = 'dot ' + (r.state === 'running' ? 'run' : r.state === 'paused' ? 'pause' : r.state === 'stopping' ? 'stop' : '');
      this.el.start.disabled = r.state === 'running' || r.state === 'paused' || r.state === 'stopping';
      this.el.pause.disabled = !(r.state === 'running' || r.state === 'paused');
      this.el.stop.disabled = r.state === 'idle' || r.state === 'stopping';
      this.el.pause.textContent = r.paused ? '▶ 继续' : '⏸ 暂停';
      this.el.cnt.textContent = Object.keys(greeted).length;
    },

    log(type, msg) {
      const line = { t: nowStr(), type, msg };
      this.logs.push(line);
      if (this.logs.length > 300) this.logs.shift();
      if (this.built) {
        const d = document.createElement('div');
        d.className = type;
        d.textContent = `${line.t} ${msg}`;
        this.el.log.appendChild(d);
        while (this.el.log.childNodes.length > 80) this.el.log.removeChild(this.el.log.firstChild);
        this.el.log.scrollTop = this.el.log.scrollHeight;
      }
      try { console.log(`[BAG ${line.t}] ${msg}`); } catch (e) {}
      this.render();
    },
  };

  const log = (type, msg) => panel.log(type, msg);

  /* ============================================================
   * 5. 核心流程
   * ============================================================ */
  const runner = {
    state: 'idle', // idle | running | paused | stopping
    paused: false,
    stopReason: '',
    runSent: 0,
    runSkipped: 0,
    runFailed: 0,
    consecutiveFail: 0,
    sentInRow: 0,
    seen: new Set(),
    lastClickedId: '',
    scrollTries: 0,

    async start() {
      if (this.state === 'running' || this.state === 'paused') return;
      if (!TEST && !/\/web\/geek\/jobs/.test(location.pathname)) {
        log('warn', '当前不在职位列表页，正在跳转…');
        try { sessionStorage.setItem(PREFIX + 'autorun', '1'); } catch (e) {}
        location.href = 'https://www.zhipin.com/web/geek/jobs/';
        return;
      }
      ensureToday();
      this.state = 'running';
      this.paused = false;
      this.stopReason = '';
      this.runSent = 0;
      this.runSkipped = 0;
      this.runFailed = 0;
      this.consecutiveFail = 0;
      this.sentInRow = 0;
      this.seen = new Set();
      this.scrollTries = 0;
      panel.render();
      log('info', `开始运行（今日已发 ${stats.sent}/${cfg.dailyCap}，本次上限 ${cfg.runCap}${cfg.dryRun ? '，试运行' : ''}）`);
      // 参数体检：明显激进的组合提醒一下（不拦，只是提醒）
      if (cfg.dailyCap > 60) log('warn', `今日上限 ${cfg.dailyCap} 条偏多：平台自己也有每日上限（一般几十条），建议 30~40`);
      if (cfg.runCap > 40) log('warn', `本次上限 ${cfg.runCap} 条偏多：建议 10~20，跑完歇一会儿再跑下一轮`);
      if (cfg.minDelay < 5) log('warn', `间隔最小 ${cfg.minDelay} 秒偏快：低于 8 秒容易被判定为机器操作`);
      this.loop();
    },

    pause() {
      if (this.state !== 'running') return;
      this.paused = true;
      this.state = 'paused';
      panel.render();
      log('warn', '已暂停');
    },

    resume() {
      if (this.state !== 'paused') return;
      this.paused = false;
      this.state = 'running';
      panel.render();
      log('info', '继续运行');
    },

    stop(reason) {
      if (this.state === 'idle' || this.state === 'stopping') return;
      this.state = 'stopping';
      this.stopReason = reason || '';
      panel.render();
      log('warn', '停止：' + (reason || ''));
    },

    async loop() {
      while (this.state === 'running') {
        if (this.paused) { await sleep(400); continue; }
        try {
          if (looksBlocked()) { this.stop('页面出现安全验证，请手动处理后重试'); break; }
          if ((stats.sent || 0) >= cfg.dailyCap) { this.stop('已达今日上限 ' + cfg.dailyCap + ' 条'); break; }
          if (this.runSent >= cfg.runCap) { this.stop('已达本次上限 ' + cfg.runCap + ' 条'); break; }
          if (this.consecutiveFail >= 15) {
            this.stop(`连续 ${this.consecutiveFail} 个职位都失败，页面可能改版了，点「自检」看日志`);
            break;
          }

          const job = this.pick();
          if (!job) {
            const grown = await this.loadMore();
            if (!grown) { this.stop('当前列表已没有可打招呼的职位'); break; }
            continue;
          }

          const res = await this.greetOne(job);
          await this.handleResult(job, res);

          if (this.state !== 'running') break;

          // 节奏控制：只有真的发出去了才按「间隔」等；失败/跳过只是翻页，短停即可
          const sent = res && res.status === 'ok';
          const wait = (sent ? rand(cfg.minDelay, cfg.maxDelay) : rand(1.2, 2.8)) * 1000;
          const rest = sent && cfg.longRestEvery > 0 && this.sentInRow > 0 && this.sentInRow % cfg.longRestEvery === 0;
          if (rest) {
            const r = rand(45, 90);
            log('info', `已连发 ${this.sentInRow} 条，休息 ${r} 秒`);
            for (let i = 0; i < r * 4 && this.state === 'running'; i++) await sleep(250);
            this.sentInRow += 0.5; // 避免重复触发
          } else {
            for (let i = 0; i < wait / 250 && this.state === 'running'; i++) await sleep(250);
          }
        } catch (err) {
          console.error('[BAG]', err);
          this.runFailed++;
          log('err', '异常：' + (err && err.message ? err.message : err));
          await sleep(1500);
        }
      }
      if (this.state === 'stopping' || this.state === 'running') {
        this.state = 'idle';
        panel.render();
      }
    },

    /** 从当前列表挑下一个 */
    pick() {
      const cards = scanCards();
      for (const c of cards) {
        if (this.seen.has(c.id)) continue;
        if (cfg.skipGreeted && greeted[c.id]) {
          this.seen.add(c.id);
          continue;
        }
        const why = filterReason(c);
        if (why) {
          this.seen.add(c.id);
          this.runSkipped++;
          log('skip', `跳过「${c.title || '?'}」· ${c.company || ''}：${why}`);
          continue;
        }
        return c;
      }
      return null;
    },

    async loadMore() {
      const before = scanCards().length;
      const sc = scrollTarget();
      if (!sc || this.scrollTries >= 3) return false;
      this.scrollTries++;
      sc.scrollTop = sc.scrollHeight;
      await sleep(2200);
      const after = scanCards().length;
      if (after > before) { this.scrollTries = 0; return true; }
      return false;
    },

    /** 打开一个职位并打招呼 */
    async greetOne(job) {
      this.seen.add(job.id);
      this.lastClickedId = job.id;
      log('info', `打开：${job.title}${job.salary ? ' · ' + job.salary : ''}`);

      if (job.el && job.el.scrollIntoView) {
        try { job.el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
      }
      await sleep(rand(150, 350));

      const title = normText(job.title);
      const before = normText(detailText());

      // 详情是不是已经切到这个职位了？
      // 1) 右侧能拿到 jobId → 直接精确比对（最可靠）
      // 2) 拿不到 → 比标题：归一后相等就算（详情标题常截掉「（广州）」「-出差」这类后缀）
      // 3) 标题对不上但正文确实换了内容，且标题高度相似 → 也算
      const same = () => {
        const t = normText(detailText());
        if (!t) return false;
        const dj = detailJobId();
        if (dj) return dj === job.id;
        const a = normTitle(detailTitle());
        const b = normTitle(title);
        if (a && b && a === b) return true;
        if (t === before) return false; // 右侧压根没变，肯定不是
        if (!b) return t !== before;
        if (a && (a.includes(b) || b.includes(a))) return true;
        if (a && a.slice(0, 4) === b.slice(0, 4)) return true;
        return false;
      };

      // 第一个职位默认已展示在右侧，这时不必再点卡片
      let opened = same();
      if (!opened) {
        clickEl(job.el);
        opened = await waitFor(() => same(), 6000, 150);
      }

      if (!opened) {
        // 可能是整页跳到了职位详情
        if (/\/job_detail\//.test(location.pathname)) {
          log('warn', '进入了职位详情页，尝试在此页打招呼');
        } else {
          const changed = normText(detailText()) !== before;
          return {
            status: 'fail',
            reason:
              `详情没切到这个职位（卡片「${job.title}」，右侧「${detailTitle() || '未识别'}」，` +
              `正文${changed ? '变了但标题不符' : '没变化'}）`,
          };
        }
      }

      await sleep(rand(300, 700));

      const btn = findChatButton();
      if (!btn) {
        if (/继续沟通/.test(detailText())) return { status: 'skip', reason: '已沟通过' };
        return { status: 'fail', reason: '没找到「立即沟通」按钮' };
      }
      if (textOf(btn) === '继续沟通') return { status: 'skip', reason: '已沟通过' };

      if (cfg.dryRun) {
        return { status: 'dry' };
      }

      clickEl(btn);
      return await this.waitOutcome(job);
    },

    async waitOutcome(job) {
      const t0 = Date.now();
      while (Date.now() - t0 < 12000) {
        if (this.state !== 'running') return { status: 'aborted' };
        if (/\/web\/geek\/chat/.test(location.pathname)) {
          await sleep(800);
          log('ok', `✓ 已发送：${job.title}（跳转到聊天页）`);
          return { status: 'ok' };
        }
        const dlg = findDialog();
        if (dlg) {
          const t = textOf(dlg);
          if (/验证|滑块|人机|安全检测|频繁|异常/.test(t)) return { status: 'blocked', text: t };
          if (/上限|次数|明日|明天|限制|稍后再试/.test(t)) return { status: 'limit', text: t };
          if (/发送简历|附件简历/.test(t)) return { status: 'resume', text: t };
          if (/已向BOSS发送消息|发送成功|沟通成功|消息已发送/.test(t)) {
            await dismissDialog(dlg);
            return { status: 'ok', text: t };
          }
          await dismissDialog(dlg);
          return { status: 'unknown', text: t };
        }
        // 没有弹窗，但按钮已变成「继续沟通」——说明已经发出去了
        const b = findChatButton();
        if (b && textOf(b) === '继续沟通') return { status: 'ok', text: '按钮已变为继续沟通' };
        await sleep(250);
      }
      return { status: 'timeout' };
    },

    async handleResult(job, res) {
      switch (res.status) {
        case 'ok':
          markGreeted(job);
          stats.sent = (stats.sent || 0) + 1;
          store.write('stats', stats);
          this.runSent++;
          this.sentInRow++;
          this.consecutiveFail = 0;
          log('ok', `✓ 已打招呼：${job.title} · ${job.company || ''}`);
          break;
        case 'dry':
          this.seen.add(job.id);
          this.runSkipped++;
          log('dry', `[试运行] 会打招呼：${job.title} · ${job.company || ''} · ${job.salary || ''}`);
          break;
        case 'skip':
          this.runSkipped++;
          this.consecutiveFail = 0;
          log('skip', `跳过「${job.title}」：${res.reason || '已沟通'}`);
          break;
        case 'limit':
          this.stop('平台提示沟通次数受限：' + (res.text || '').slice(0, 40));
          break;
        case 'blocked':
          this.stop('触发安全验证，请手动完成后重试');
          break;
        case 'resume':
          this.stop('需要先发送简历：' + (res.text || '').slice(0, 40));
          break;
        case 'unknown':
          this.runFailed++;
          this.consecutiveFail++;
          log('warn', `未知弹窗，已跳过这个职位：${(res.text || '').slice(0, 60)}`);
          break;
        case 'timeout':
          this.runFailed++;
          this.consecutiveFail++;
          log('warn', `点了「立即沟通」但 12 秒内没看到结果，跳过这个职位：${job.title}`);
          break;
        case 'aborted':
          break;
        default:
          this.runFailed++;
          this.consecutiveFail++;
          log('err', `失败「${job.title}」：${res.reason || res.status}（已跳过，继续下一个）`);
      }
      panel.render();
    },
  };

  /* ============================================================
   * 6. 自检
   * ============================================================ */
  function selfCheck() {
    const cards = scanCards();
    const btn = findChatButton();
    log('info', `自检：列表 ${cards.length} 个职位，详情按钮 ${btn ? '「' + textOf(btn) + '」' : '未找到'}`);
    cards.slice(0, 6).forEach((c) => log('info', `  · ${c.title} | ${c.salary || '-'} | ${c.company || '-'}`));
    if (!btn) log('warn', '未找到「立即沟通」：请确认右侧已打开某个职位');
  }

  /* ============================================================
   * 7. 启动
   * ============================================================ */
  function boot() {
    if (document.getElementById('bag-host')) return;
    panel.build();
    const pos = store.read('panelPos', null);
    if (pos && pos.left && pos.top) {
      panel.host.style.right = 'auto';
      panel.host.style.bottom = 'auto';
      panel.host.style.left = pos.left;
      panel.host.style.top = pos.top;
    }
    log('info', `已加载 v${VERSION}，${IS_ZHIPIN ? '在 BOSS 直聘页面' : '测试页面'}`);

    let auto = false;
    try { auto = sessionStorage.getItem(PREFIX + 'autorun') === '1'; sessionStorage.removeItem(PREFIX + 'autorun'); } catch (e) {}
    if (auto) setTimeout(() => runner.start(), 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 调试 / 测试接口
  window.__BAG__ = {
    version: VERSION,
    cfg,
    runner,
    panel,
    start: () => runner.start(),
    stop: (r) => runner.stop(r || '手动停止'),
    scanCards,
    findChatButton,
    findDialog,
    selfCheck,
    dbg: () => {
      const sel = '[class*="job-detail"], .job-detail, [class*="job-sec"], [class*="detail-box"]';
      const all = $$(sel);
      return {
        candsAll: all.length,
        candsVisible: all.filter(isVisible).length,
        candsLong: all.filter((el) => isVisible(el) && textOf(el).length > 40).length,
        cands: all.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            cls: String(el.className).slice(0, 40),
            tag: el.tagName,
            len: textOf(el).length,
            w: Math.round(r.width),
            h: Math.round(r.height),
            vis: isVisible(el),
          };
        }),
        rootTag: detailRoot() ? detailRoot().tagName + '.' + detailRoot().className : 'none',
        title: detailTitle(),
        textHead: detailText().slice(0, 50),
        chatBtn: findChatButton() ? textOf(findChatButton()) : 'none',
      };
    },
    report: () => ({
      version: VERSION,
      state: runner.state,
      stopReason: runner.stopReason,
      dryRun: !!cfg.dryRun,
      runSent: runner.runSent,
      runSkipped: runner.runSkipped,
      runFailed: runner.runFailed,
      todaySent: stats.sent || 0,
      greetedCount: Object.keys(greeted).length,
      greeted: Object.keys(greeted),
      log: panel.logs.slice(-60).map((x) => `${x.t} [${x.type}] ${x.msg}`),
    }),
  };
})();
