(() => {
  'use strict';
  // ---------- 配置 ----------
  // 素材：即梦一镜到底视频（3184×1792，24fps，15.07 秒），拆成 1440×810 序列帧 frames/0000–0360。
  // 0–5.5 秒踏云走近，5.5–7.6 秒凝视镜头，约 7.7 秒闭眼、转身，9.6–10.5 秒镜头拉高俯拍，10.5–14.6 秒向右走出画面。
  const FPS = 24, LAST_FRAME = 360, DURATION = LAST_FRAME / FPS;
  const SRC_W = 1440, SRC_H = 810;
  // 老虎抠像（系统主体识别）只做标题可见的前段：masks/NNN.webp 上下两格依次是第 2N、2N+1 帧，透明度即老虎。
  const MASK_LAST = 192, MASK_W = 960, MASK_H = 540;
  // 开场：页面打开后，老虎从远处踏云走到近景（0 → INTRO_T 秒），近景就是首页的默认位置
  const INTRO_T = 6.4, INTRO_DELAY = 500;
  // 吸附点（视频秒数）。hold：停在这里时定格，镜头极慢地推向这一点（比例坐标），zoom 为推近幅度
  const STAGES = [
    { t: INTRO_T, hold: [0.5, 0.36], zoom: 0.045 },  // 01 首页：近景凝视镜头，标题分开，EXPLORE 引导
    { t: 15.0 },                               // 02 俯拍雪地，老虎已走出，目录
    { t: 15.0, hold: [0.5, 0.52], zoom: 0.035 }, // 03 结尾：同一片雪地缓慢推近，目录换成 THANK YOU 和下载
  ];
  const CONTENTS_STAGE = 1, END_STAGE = 2;
  const END_W = 0.9;                       // 目录到结尾的切换时长（秒），这段画面不动，只换文字
  // 姓名和联系方式：填上就会显示在结尾页，点击可复制；留空则不显示
  const CONTACT = { name: '', email: '', wechat: '' };
  // 播放速度（相对原速）。点击后为了让目录早点出来：凝视段几乎不动，2 倍速带过；闭眼转身段 1.5 倍，
  // 到镜头快速拉高之前回落到 1.1 倍（那一下本来就快，不能再加）；走出画面段 0.9 倍（放慢过头用户嫌拖，原速又嫌快）
  const rate = t => lerp(1.1, 0.9, smoothstep(9.8, 10.8, t)) * (1 + smoothstep(6.4, 6.7, t) * lerp(1, 0.36, smoothstep(7.2, 7.6, t)) * (1 - smoothstep(8.6, 9.5, t)));
  // 放慢段补了中间帧（光流插帧）：第 i 帧和 i+1 帧之间多一张。每 4 张竖着拼成 frames/midNN.webp（文件数有上限）。
  // 播放位置用"半帧"计：槽位 2i 是原帧，2i+1 是中间帧（只在 MID_FROM 之后有）
  const MID_FROM = 236, MID_PER = 4, LAST_SLOT = LAST_FRAME * 2;
  const hasSlot = s => s >= 0 && s <= LAST_SLOT && ((s & 1) === 0 || ((s >> 1) >= MID_FROM && (s >> 1) < LAST_FRAME));
  const HOLD_SECS = 7;                     // 定格推近的时长
  const FAST_MS = 1000;                    // 快进时剩下的动作最多播多久
  // 四张卡片紧跟在老虎身后连着出现（实际间隔约 0.4 秒）。老虎从左往右走出去，四个位置约在 12.1 / 12.6 / 13.0 / 13.4 秒让开，
  // 再早会压在老虎脚上
  const CARD_T = [12.35, 12.7, 13.05, 13.4];
  const CARD_GAP = 130;                    // 快进或从结尾页回来时几张会同时到点：按这个间隔（毫秒）排队，不一起蹦出来
  const READY_FRAME = 160;                 // 走近到凝视的帧加载完就进入页面，其余在后台继续

  const film = document.getElementById('film'), fctx = film.getContext('2d');
  const front = document.getElementById('front'), tctx = front.getContext('2d');
  const root = document.documentElement;
  const navButtons = [...document.querySelectorAll('[data-nav]')];
  const explore = document.querySelector('.explore'), contents = document.querySelector('.contents'), endEl = document.querySelector('.end');
  const cardItems = [...document.querySelectorAll('.cards li')], cardOn = cardItems.map(() => false);
  let cardFree = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  // 箭头流动：把箭头换成同一格里叠着的两支，鼠标移上去（或键盘聚焦）时整组顺着箭头方向移动一格；播完才接受下一次
  const AF_DIR = { '↗': [1, -1], '→': [1, 0], '↓': [0, 1], '↑': [0, -1] };
  const afHTML = (glyph, [dx, dy], cls = '') => `<span class="af${cls && ' ' + cls}" style="--dx:${dx};--dy:${dy}" aria-hidden="true"><span class="af-in"><span>${glyph}</span><span>${glyph}</span></span></span>`;
  function arrowFlow(host, trigger = host, dir) {
    const glyph = host.innerHTML.trim();
    const d = dir || AF_DIR[glyph] || [0, 1];
    host.innerHTML = afHTML(glyph, d, d[0] && d[1] ? 'diag' : '');
    const af = host.firstElementChild;
    const play = () => { if (!reduced.matches) af.classList.add('go'); };
    af.addEventListener('animationend', () => af.classList.remove('go'));
    trigger.addEventListener('pointerenter', play);
    trigger.addEventListener('focus', play);
    return af;
  }
  const LAST = STAGES.length - 1;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const frameAt = t => {   // 返回槽位
    const f = t * FPS;
    return f >= MID_FROM ? clamp(Math.round(f * 2), 0, LAST_SLOT) : clamp(Math.round(f), 0, LAST_FRAME) * 2;
  };

  // ---------- 时间换算：W(t) 为按 rate 播到 t 需要的秒数，滚动位置与它成正比 ----------
  const WSTEP = 0.01, WT = [0];
  for (let i = 1; i * WSTEP <= DURATION + 1e-9; i++) WT.push(WT[i - 1] + WSTEP / rate((i - 0.5) * WSTEP));
  function wallAt(t) {
    const x = clamp(t, 0, DURATION) / WSTEP, i = Math.min(Math.floor(x), WT.length - 2);
    return lerp(WT[i], WT[i + 1], x - i);
  }
  function timeAtWall(w) {
    let lo = 0, hi = WT.length - 1;
    if (w <= 0) return 0;
    if (w >= WT[hi]) return DURATION;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (WT[m] <= w) lo = m; else hi = m; }
    return (lo + (w - WT[lo]) / (WT[hi] - WT[lo])) * WSTEP;
  }

  // ---------- 序列帧与抠像加载：按时间顺序，前段优先 ----------
  const frames = [], masks = [], midSheets = [];
  let loadedFrames = 0, started = false;
  const pad = (n, w) => String(n).padStart(w, '0');
  // 图片读成文件数据（Blob），之后在后台线程解码，播放时不占主线程；读不了时退回普通图片。网络偶尔丢一张，重试两次
  let useImg = false, blobOk = false;
  const loadImage = (src, into, i, tries = 3) => new Promise(done => {
    const retry = () => tries > 1 ? setTimeout(() => loadImage(src, into, i, tries - 1).then(done), 400) : done();
    if (!useImg) {
      fetch(src).then(r => r.ok ? r.blob() : Promise.reject(r.status))
        .then(b => { into[i] = b; blobOk = true; done(); })
        .catch(() => {
          // 一张都没读成功、重试也失败：说明这里不允许这样读，改用普通图片
          if (tries <= 1 && !blobOk) { useImg = true; loadImage(src, into, i).then(done); } else retry();
        });
      return;
    }
    const img = new Image();
    img.onload = () => { into[i] = img; done(); };
    img.onerror = retry;
    img.src = src;
  });
  async function loadAll() {
    const jobs = [];
    for (let i = 0; i <= LAST_FRAME; i++) {
      jobs.push(() => loadImage(`frames/${pad(i, 4)}.webp`, frames, i * 2).then(() => { loadedFrames++; progressLoad(); }));
      if (i >= MID_FROM && i < LAST_FRAME && (i - MID_FROM) % MID_PER === 0) {
        const g = (i - MID_FROM) / MID_PER;
        jobs.push(() => loadImage(`frames/mid${pad(g, 2)}.webp`, midSheets, g));
      }
      if (i % 2 === 0 && i <= MASK_LAST) jobs.push(() => loadImage(`masks/${pad(i / 2, 3)}.webp`, masks, i / 2));
    }
    let next = 0;
    const worker = async () => { while (next < jobs.length) await jobs[next++](); };
    if (deepWork >= 0) jobs.reverse();   // 从作品链接直接打开：先加载目录那一帧
    await Promise.all(Array.from({ length: 6 }, worker));
    progressLoad(true);
  }
  function progressLoad(all) {
    let ahead = 0;
    for (let i = 0; i <= READY_FRAME; i++) if (frames[i * 2]) ahead++;
    document.getElementById('loaderBar').style.width = `${Math.round(ahead / (READY_FRAME + 1) * 100)}%`;
    if (!started && (all || ahead > READY_FRAME || (deepWork >= 0 && frames[LAST_SLOT]))) {
      started = true; document.body.classList.add('ready'); dirty = true;
      keepDecoded(deepWork >= 0 ? LAST_SLOT : Math.max(0, lastFrame), dir);   // 进入页面前先把走近的帧解码好，第一次滑动就不卡
      if (deepWork < 0) {
        if (reduced.matches) w = 0;
        else { const now = performance.now(); tween = { from: w, to: 0, stage: 0, start: now + INTRO_DELAY, dur: W0 * 1000 }; tweenLast = now; }
      }
    }
    // 从作品链接直接打开时，先把目录那一帧解码好，关闭阅读页时背景才有画面
    if (deepWork >= 0) { if (loadedFrames <= 48) { keepDecoded(LAST_SLOT, 1); dirty = true; } }
    else if (loadedFrames === 1) { keepDecoded(0, 1); dirty = true; }
  }

  // ---------- 预解码：当前位置前后一段帧提前解码成位图，播放时不再临时解码，走路才不会一顿一顿 ----------
  const decoded = new Map();   // 键：'f24' 槽位、'm6' 抠像图；值：ImageBitmap，或 null 表示正在解码
  const maskKey = s => (s & 1) === 0 && (s >> 1) <= MASK_LAST ? 'm' + (s >> 2) : null;
  // 中间帧整张拼图只解码一次（键 'g' + 拼图号），绘制时从拼图里取对应那一格
  const midGroup = s => Math.floor(((s >> 1) - MID_FROM) / MID_PER);
  const slotKey = s => (s & 1) ? 'g' + midGroup(s) : 'f' + s;
  const slotY = s => (s & 1) ? (((s >> 1) - MID_FROM) % MID_PER) * SRC_H : 0;
  function keepDecoded(center, dir) {   // center 为槽位
    const ahead = innerWidth < 800 ? 48 : 80, behind = 16;
    const lo = center - (dir < 0 ? ahead : behind), hi = center + (dir < 0 ? behind : ahead);
    const want = new Set();
    for (let s = Math.max(0, lo); s <= Math.min(LAST_SLOT, hi); s++) {
      if (!hasSlot(s)) continue;
      want.add(slotKey(s));
      const m = maskKey(s);
      if (m) want.add(m);
    }
    for (const [key, bmp] of decoded) if (!want.has(key)) { if (bmp) bmp.close(); decoded.delete(key); }
    // 近处先解码
    const order = [...want].sort((a, b) => Math.abs(num(a) - center) - Math.abs(num(b) - center));
    for (const key of order) {
      if (decoded.has(key)) continue;
      const n = +key.slice(1);
      const img = key[0] === 'm' ? masks[n] : key[0] === 'g' ? midSheets[n] : frames[n];
      if (!img) continue;
      decoded.set(key, null);
      createImageBitmap(img).then(bmp => {
        if (decoded.has(key) && decoded.get(key) === null) { decoded.set(key, bmp); dirty = true; } else bmp.close();
      }).catch(() => decoded.delete(key));
    }
  }
  const num = key => key[0] === 'f' ? +key.slice(1) : key[0] === 'g' ? (MID_FROM + +key.slice(1) * MID_PER) * 2 + MID_PER : +key.slice(1) * 4;
  // 某帧还没解码好（比如快进时）：就近挑一张已解码好的帧（前后几帧内），画面照样连续、不会卡住
  function nearDecoded(i, r) {   // 槽位
    for (let d = 0; d <= r; d++) for (const j of [i + d * dir, i - d * dir]) {
      if (!hasSlot(j) || !decoded.get(slotKey(j))) continue;
      const m = maskKey(j);
      if (m && !decoded.get(m)) continue;
      return j;
    }
    return i;
  }
  const isImg = x => x instanceof HTMLImageElement;
  function frameSource(i) {   // 返回 [图, 在图里的纵向位置]
    for (let d = 0; d <= 120; d++) for (const j of [i + d * dir, i - d * dir]) {   // 用最近一张解码好的
      const bmp = hasSlot(j) && decoded.get(slotKey(j));
      if (bmp) return [bmp, slotY(j)];
    }
    for (let d = 0; d <= LAST_SLOT; d++) {      // 退回普通图片的情况
      if (isImg(frames[i - d])) return [frames[i - d], 0];
      if (isImg(frames[i + d])) return [frames[i + d], 0];
    }
    return null;
  }

  // ---------- 滚动轨道 ----------
  // ---------- 位置：w 为从首页起按 rate 播放到当前画面的秒数 ----------
  // 不用页面滚动：滚轮、手指、键盘只负责"去下一个/上一个停点"，动作按原视频节奏整段播完
  let vw, vh, dpr, scale, ox, oy, portrait, splitMax = 0;
  const TITLE_NEAR = .62, TITLE_PORTRAIT = .88;   // 近景时标题的缩放比例；竖屏老虎铺满屏幕，标题改到左下角文字上方
  const W0 = wallAt(INTRO_T);
  const stageW = STAGES.map(s => wallAt(s.t) - W0);
  stageW[END_STAGE] = stageW[CONTENTS_STAGE] + END_W;
  const timeAtW = w => timeAtWall(W0 + w);
  const stageAt = w => stageW.reduce((best, s, i) => Math.abs(s - w) < Math.abs(stageW[best] - w) ? i : best, 0);
  function layout() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    vw = Math.max(1, innerWidth); vh = Math.max(1, innerHeight); portrait = vw / vh < .8;
    for (const c of [film, front]) { c.width = Math.round(vw * dpr); c.height = Math.round(vh * dpr); }
    scale = Math.max(vw / SRC_W, vh / SRC_H);
    ox = (vw - SRC_W * scale) / 2;
    oy = (vh - SRC_H * scale) / 2;
    // 近景时标题缩小，PORT 和 FOLIO 左右贴到屏幕边距内，完整摆在老虎两侧
    const titleW = document.querySelector('.title .l').offsetWidth + document.querySelector('.title .r').offsetWidth;
    splitMax = (vw / 2 - titleW * TITLE_NEAR / 2 - vw * .03) / TITLE_NEAR;
    dirty = true;
  }

  // ---------- 绘制：z 为定格推近的倍数，以两眼之间为中心 ----------
  let zoom = 1, anchor = [0.5, 0.5];
  function placement() {
    const w = SRC_W * scale * zoom, h = SRC_H * scale * zoom;
    const ax = ox + anchor[0] * SRC_W * scale, ay = oy + anchor[1] * SRC_H * scale;
    return [ax - anchor[0] * w, ay - anchor[1] * h, w, h];
  }
  // 底层画整帧；标题还看得见时，上层只画抠出的老虎，让它挡在标题前面
  function drawFilm(i) {
    const src = frameSource(i);
    if (src) fctx.drawImage(src[0], 0, src[1], SRC_W, SRC_H, ...placement());
  }
  function drawFront(i, titleVisible) {
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, front.width, front.height);
    const pick = (key, raw) => decoded.get(key) || (isImg(raw) ? raw : null);
    const m = maskKey(i);
    if (!titleVisible || !m) return;
    const sheet = pick(m, masks[i >> 2]), img = pick('f' + i, frames[i]);
    if (!sheet || !img) return;
    const box = placement();
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.drawImage(sheet, 0, ((i >> 1) & 1) * MASK_H, MASK_W, MASK_H, ...box);
    tctx.globalCompositeOperation = 'source-in';
    tctx.drawImage(img, ...box);
    tctx.globalCompositeOperation = 'source-over';
  }

  // 文字跟着镜头：标题在老虎走近时向两边分开、放大，俯拍时目录从上下浮现
  let lastScene = '';
  function updateText(t) {
    const css = (k, v) => root.style.setProperty(k, v);
    const u = smoothstep(2.4, 6.2, t);
    css('--split', `${(portrait ? 0 : u * splitMax).toFixed(1)}px`);
    css('--tk', (portrait ? TITLE_PORTRAIT : 1 - u * (1 - TITLE_NEAR)).toFixed(4));
    css('--ty', `${(portrait ? 0 : -u * vh * .035).toFixed(1)}px`);
    const titleO = 1 - smoothstep(7.6, 8.6, t);
    css('--title-o', titleO.toFixed(3));
    css('--intro-o', (1 - smoothstep(INTRO_T + 0.15, INTRO_T + 1.4, t)).toFixed(3));
    // EXPLORE：老虎走到近景时出现并开始水波纹；点击后打出一圈波纹，随老虎转身淡出
    const ex = smoothstep(5.1, 6.1, t) * (1 - smoothstep(6.75, 7.35, t));
    css('--explore-o', ex.toFixed(3));
    explore.classList.toggle('on', ex > .5);
    const leaving = !!tween && tween.stage !== 0 && tween.to > w;
    explore.classList.toggle('pulse', ex > .6 && !leaving);
    explore.classList.toggle('go', leaving && ex > .02);
    const co = smoothstep(10.6, 12.4, t);   // CONTENTS 和目录随着老虎走出画面一起出现
    // 结尾：e 为 0–1，目录淡出、卡片沉下，THANK YOU 和下载浮现
    const e = clamp((w - stageW[CONTENTS_STAGE]) / END_W, 0, 1);
    const coEnd = co * (1 - smoothstep(0, .55, e));
    css('--contents-o', coEnd.toFixed(3));
    css('--head-y', `${((1 - co) * 30 - e * 26).toFixed(1)}px`);
    contents.classList.toggle('on', co > .6 && e < .5);
    const nowMs = performance.now();
    cardItems.forEach((li, k) => {
      const on = t > CARD_T[k] && e < .22;
      if (on === cardOn[k]) return;
      cardOn[k] = on;
      const wait = on ? Math.max(0, cardFree - nowMs) : 0;   // 收起时不排队，一起走
      if (on) cardFree = nowMs + wait + CARD_GAP;
      li.style.transitionDelay = wait ? `${Math.round(wait)}ms` : '';
      li.style.setProperty('--d', `${Math.round(wait)}ms`);   // 卡片的淡入动画用同一个延迟
      li.classList.toggle('show', on);
    });
    const eo = smoothstep(.4, 1, e);
    css('--end-o', eo.toFixed(3));
    css('--end-y', `${((1 - eo) * 30).toFixed(1)}px`);
    endEl.classList.toggle('on', e > .7);
    css('--progress', (t / DURATION).toFixed(4));
    const scene = e > .5 ? 'end' : t > 11 ? 'contents' : 'portfolio';
    if (scene !== lastScene) {
      lastScene = scene;
      const info = { portfolio: ['01', 'PORTFOLIO', '0', ''], contents: ['02', 'CONTENTS', '1', '继续下滑' + afHTML('↓', AF_DIR['↓'], 'loop')], end: ['03', 'THANK YOU', '2', '向上回到目录' + afHTML('↑', AF_DIR['↑'], 'loop')] }[scene];
      document.getElementById('sceneNo').textContent = info[0];
      document.getElementById('sceneName').textContent = info[1];
      navButtons.forEach(b => b.setAttribute('aria-current', String(b.dataset.nav === info[2])));
      document.getElementById('hint').innerHTML = info[3];
    }
    return titleO > .01;
  }

  let w = -W0, dirty = true, hold = 0, dir = 1, lastFrame = -1, sceneVer = 0, titleShown = true;   // 从第 0 秒开始，开场走到 w=0 就是近景
  function draw(now) {
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.imageSmoothingQuality = 'high';
    const t = timeAtW(w);
    const i = nearDecoded(frameAt(t), tween && tween.fast ? 16 : 4);
    const st = STAGES[stageAt(w)];
    if (st.hold) anchor = st.hold;
    zoom = 1 + (st.zoom || 0) * hold * hold * (3 - 2 * hold);
    drawFilm(i);
    titleShown = updateText(t);
    drawFront(i, titleShown);
    sceneVer++;
    if (i !== lastFrame) { keepDecoded(i, dir); lastFrame = i; }
  }

  // ---------- 主循环 ----------
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000) || 0.016;
    last = now;
    const moving = !!tween;
    if (tween) stepTween(now);
    // 停在带 hold 的停点：定格并缓慢推近；一动就快速退回
    const n = stageAt(w);
    const resting = !tween && !dragging && STAGES[n].hold && Math.abs(w - stageW[n]) < 0.01 && !reduced.matches;
    const h = resting ? Math.min(1, hold + dt / HOLD_SECS) : Math.max(0, hold - dt * 2.5);
    const holdChanged = h !== hold;
    hold = h;
    if (moving || holdChanged || dirty) { draw(now); dirty = false; }
    if (glass) glass.frame(now);
    requestAnimationFrame(tick);
  }

  // ---------- 播放到停点：settled 只在整段播完后才更新，中途被打断也不会算错方向 ----------
  let settled = 0, tween = null, dragging = false, wVel = 0, tweenLast = 0;
  // fast：快进（播放中同方向再滑一次、点顶部导航），剩下的动作约 1 秒播完，画面仍是连续的
  function goTo(i, fast) {
    i = clamp(i, 0, LAST);
    const to = stageW[i];
    if (tween && tween.stage === i && (!fast || tween.fast)) return;
    if (Math.abs(to - w) < 0.005) { tween = null; w = to; settled = i; dirty = true; return; }
    if (reduced.matches) { tween = null; w = to; settled = i; dirty = true; return; }
    dir = Math.sign(to - w);
    const dist = Math.abs(to - w), now = performance.now();
    if (fast) {
      const dur = clamp(dist * 1000, 300, FAST_MS);
      // 接着当前的速度加速，不会先停一下再快进
      const v0 = tween && Math.sign(wVel) === dir ? Math.abs(wVel) : 0;
      tween = { from: w, to, stage: i, start: now, dur, fast: true, m0: clamp(v0 * dur / dist, 0, 2.5) };
    } else {
      // 时长 = 按 rate 播完这段的秒数，老虎走出那段自然变慢
      tween = { from: w, to, stage: i, start: now, dur: clamp(dist * 1000, 450, 20000) };
    }
    tweenLast = now;
    keepDecoded(Math.max(0, lastFrame), dir);   // 方向一变，立刻把前方的帧排上解码
  }
  function stepTween(now) {
    const t = clamp((now - tween.start) / tween.dur, 0, 1);
    let e;
    if (tween.fast) {
      // 起点接上当前速度，中段加快，结尾缓停
      e = t * (1 - t) * (1 - t) * tween.m0 + t * t * (3 - 2 * t);
    } else {
      // 两头缓起缓停（各占 12%，最长 0.6 秒），中间匀速，步伐保持原视频的节奏
      const a = Math.min(0.12, 600 / tween.dur), v = 1 / (1 - a);
      e = t < a ? v * t * t / (2 * a) : t > 1 - a ? 1 - v * (1 - t) * (1 - t) / (2 * a) : v * (t - a / 2);
    }
    const nw = lerp(tween.from, tween.to, e);
    if (now > tweenLast) wVel = (nw - w) / (now - tweenLast);
    tweenLast = now;
    w = nw;
    if (t === 1) { w = tween.to; settled = tween.stage; tween = null; wVel = 0; dirty = true; }   // 结尾精确落在停点那一帧
  }
  // 往 d（1 下 / -1 上）方向去下一个停点。正在往同一方向播放时快进，反方向则掉头
  function step(d) {
    if (tween && Math.sign(tween.to - w) === d) { goTo(tween.stage, true); return; }
    const ahead = stageW.map((s, i) => i).filter(i => d > 0 ? stageW[i] > w + 0.005 : stageW[i] < w - 0.005);
    if (!ahead.length) return;
    goTo(d > 0 ? ahead[0] : ahead[ahead.length - 1]);
  }

  // 滚轮：一次滑动只触发一次。停顿超过 220ms 才算新的一次，所以松手后的惯性滚动全部忽略
  let wheelLast = 0, wheelAcc = 0, wheelArmed = true;
  addEventListener('wheel', e => {
    if (openIdx >= 0) {   // 作品页是普通滚动；鼠标停在顶部导航上时也能滚
      if (zoomer.hidden && e.target.closest && e.target.closest('.header')) { e.preventDefault(); reader.scrollBy(0, e.deltaY * (e.deltaMode === 1 ? 16 : 1)); }
      return;
    }
    e.preventDefault();
    const now = performance.now();
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vh : 1), a = Math.abs(dy);
    // 停顿超过 220ms 才算新的一次；惯性中途换了方向（往回滑）也算新的一次
    if (now - wheelLast > 220 || (!wheelArmed && a > 12 && Math.sign(dy) !== Math.sign(wheelAcc))) { wheelArmed = true; wheelAcc = 0; }
    wheelLast = now;
    if (!wheelArmed || dragging) return;
    wheelAcc += dy;
    if (Math.abs(wheelAcc) > 24) { wheelArmed = false; step(Math.sign(wheelAcc)); }
  }, { passive: false });
  // 手指：上滑去下一个停点，下滑回上一个
  let touchY = null;
  addEventListener('touchstart', e => { touchY = openIdx >= 0 || e.target.closest('.bar') ? null : e.touches[0].clientY; }, { passive: true });
  addEventListener('touchmove', e => { if (touchY !== null) e.preventDefault(); }, { passive: false });
  addEventListener('touchend', e => {
    if (touchY === null) return;
    const dy = touchY - e.changedTouches[0].clientY;
    touchY = null;
    if (Math.abs(dy) > 36) step(Math.sign(dy));
  }, { passive: true });
  addEventListener('keydown', e => {
    if (openIdx >= 0) {
      if (e.key === 'Escape') { e.preventDefault(); if (!zoomer.hidden) closeZoom(); else closeWork(); }
      return;
    }
    if ((e.key === ' ' || e.key === 'Enter') && e.target.closest('button, a')) return;
    const down = ['ArrowDown', 'PageDown'].includes(e.key) || (e.key === ' ' && !e.shiftKey);
    const up = ['ArrowUp', 'PageUp'].includes(e.key) || (e.key === ' ' && e.shiftKey);
    if (down || up) { e.preventDefault(); step(down ? 1 : -1); }
    else if (e.key === 'Home') { e.preventDefault(); goTo(0); }
    else if (e.key === 'End') { e.preventDefault(); goTo(LAST, true); }
  });
  // 顶部导航：快进直达
  document.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', e => {
    e.preventDefault();
    const n = Number(el.dataset.go);
    if (openIdx < 0) { goTo(n, true); return; }
    if (busy) return;
    // 在作品里点导航：先收回作品，目录不用再动，首页和下载接着走过去
    if (n !== CONTENTS_STAGE) afterClose = () => goTo(n, true);
    closeWork();
  }));
  // EXPLORE：老虎走出画面，然后目录展现
  explore.addEventListener('click', () => goTo(CONTENTS_STAGE));
  arrowFlow(explore.querySelector('i'), explore, [0, 1]);
  arrowFlow(document.querySelector('.dl-btn i'), document.querySelector('.dl'), [0, 1]);
  document.querySelectorAll('[data-work]').forEach(card => arrowFlow(card.querySelector('.top i'), card));
  // 鼠标靠近时按钮被轻轻吸过去，离开后弹回
  if (matchMedia('(hover: hover)').matches) {
    const RANGE = 150, PULL = .24, MAX = 14;
    addEventListener('pointermove', e => {
      if (!explore.classList.contains('on')) return;
      const r = explore.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), d = Math.hypot(dx, dy);
      const k = d < RANGE ? Math.min(MAX / Math.max(d, 1), PULL) : 0;
      explore.style.setProperty('--mx', `${(dx * k).toFixed(1)}px`);
      explore.style.setProperty('--my', `${(dy * k).toFixed(1)}px`);
    }, { passive: true });
  }

  // 底部进度条：按住拖动可以逐帧看动作，松手后顺着拖动的方向把这段动作播完
  const bar = document.querySelector('.bar');
  const dragTo = e => {
    const r = bar.getBoundingClientRect();
    const t = clamp((e.clientX - r.left) / r.width, 0, 1) * DURATION;
    const nw = wallAt(Math.max(INTRO_T, t)) - W0;
    dir = Math.sign(nw - w) || dir;
    w = nw; dirty = true;
  };
  bar.addEventListener('pointerdown', e => { dragging = true; tween = null; bar.setPointerCapture(e.pointerId); dragTo(e); });
  bar.addEventListener('pointermove', e => { if (dragging) dragTo(e); });
  const dragEnd = () => {
    if (!dragging) return;
    dragging = false;
    const n = stageAt(w);
    if (Math.abs(w - stageW[n]) < 0.005) goTo(n); else step(dir);
  };
  bar.addEventListener('pointerup', dragEnd);
  bar.addEventListener('pointercancel', dragEnd);

  addEventListener('resize', layout);

  // ---------- 作品：点目录卡片，卡片放大成阅读页，内容是 Figma 终稿每页的高清图 ----------
  // 为了控制文件数，每两页竖拼成一张 works/wk-作品-序号.webp（2560×2888，中间留 8px），用 object-position 取上半或下半
  const WORKS = [
    { slug: 'e-service', no: '01', title: 'E服务小程序', focal: '74% 50%', pages: ['人保寿险 E服务 项目封面', '业务目标与体验策略拆解', '竞品分析', '首页体验重构方案', '首页重构', '个人中心重构', '权益中心重构：构建分层认知与服务触达', '设计总览：部分活动长图展示', '界面总览 THE END'] },
    { slug: 'tai-life', no: '02', title: '泰生活 APP', focal: '76% 50%', pages: ['泰生活项目封面', '老年用户特征', '简化信息内容，减弱信息干扰', '操作层设计', '缺省页设计', '界面总览 THE END'] },
    { slug: 'cai-ling-tong', no: '03', title: '采灵通', focal: '6% 50%', pages: ['采销数智化 SaaS 平台项目封面', '业务背景', '竞品分析', '制定规范', '高效经营概览与数据决策', '高效检索与批量处理', '结构化表单与准入辅助设计', '可视化搭建与灵活配置', '可视化搭建与桌面端渲染'] },
    { slug: 'other-works', no: '04', title: '其他作品', focal: '70% 50%', pages: ['AI 赋能运营设计：开学元气补给', 'AI 赋能运营设计：开学焕新计划', 'AI 赋能运营设计：活动主视觉', 'AI 赋能运营设计：大会主视觉', 'AI 赋能运营设计：数据大屏', 'AI 赋能运营设计：数据大屏'] },
  ];
  const MORPH_MS = 620, MORPH_EASE = 'cubic-bezier(.22,1,.36,1)', PAGE_RADIUS = 0;
  const $ = id => document.getElementById(id);
  const reader = $('reader'), rPages = $('rPages'), rEnd = $('rEnd');
  const zoomer = $('zoomer'), zScroll = $('zScroll'), zImg = $('zImg');
  const cards = [...document.querySelectorAll('[data-work]')];
  const narrow = matchMedia('(max-aspect-ratio:4/5)');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sheetOf = (i, p) => `works/wk-${i + 1}-${p >> 1}.webp`;
  const slotPos = p => (p & 1 ? '0 100%' : '0 0');
  let afterClose = null, openIdx = -1, busy = false, pushed = false, returnFocus = null;
  const savedTop = {};   // 每个作品看到哪里，再次打开时接着看

  const hashOf = i => `#/works/${WORKS[i].slug}`;
  const parseHash = () => {
    const m = location.hash.match(/^#\/works\/([\w-]+)/);
    return m ? WORKS.findIndex(x => x.slug === m[1]) : -1;
  };
  const deepWork = parseHash();
  const pushHash = i => { try { history.pushState({ work: i }, '', hashOf(i)); pushed = true; } catch { pushed = false; } };
  const replaceHash = i => { try { history.replaceState(null, '', i < 0 ? location.pathname + location.search : hashOf(i)); } catch { /* 不支持改地址时只切换画面 */ } };

  // 封面：四张存在一张图里，每张卡片取自己那一格
  const COVER_W = 1920, COVER_H = 1080;   // 卡片在高清屏上约 700 像素高，封面要比它大才清楚
  let coversImg = null;
  function coverCanvas(i) {
    const c = document.createElement('canvas');
    c.width = COVER_W; c.height = COVER_H;
    c.style.objectPosition = WORKS[i].focal;
    if (coversImg) c.getContext('2d').drawImage(coversImg, 0, i * COVER_H, COVER_W, COVER_H, 0, 0, COVER_W, COVER_H);
    return c;
  }
  async function loadCovers() {
    const img = new Image();
    img.src = 'works/covers.webp';
    try { await img.decode(); } catch { return; }
    coversImg = img;
    cards.forEach((card, i) => {
      const s = document.createElement('span');
      s.className = 'cover';
      s.append(coverCanvas(i));
      card.prepend(s);
    });
    if (openIdx >= 0) fillEnd(openIdx);
  }

  function fillEnd(i) {
    rEnd.textContent = '';
    if (i < WORKS.length - 1) {
      const n = WORKS[i + 1], a = document.createElement('a');
      a.className = 'r-next'; a.href = hashOf(i + 1);
      a.innerHTML = `<span class="r-next-text"><small>下一个作品</small><b>${n.no}</b><strong>${n.title}</strong></span><span class="r-thumb"></span><i aria-hidden="true">→</i>`;
      a.querySelector('.r-thumb').append(coverCanvas(i + 1));
      arrowFlow(a.querySelector('i'), a);
      a.addEventListener('click', e => { e.preventDefault(); switchWork(i + 1); });
      rEnd.append(a);
    } else {
      const p = document.createElement('p');
      p.className = 'r-done'; p.textContent = '四个作品已全部看完';
      rEnd.append(p);
      const dl = document.createElement('a');
      dl.className = 'r-download'; dl.href = PDF_URL; dl.innerHTML = '<span>下载完整作品集</span><i aria-hidden="true">↓</i>';
      const dlText = dl.firstChild, dlArrow = dl.lastChild;
      arrowFlow(dlArrow, dl);
      const dlShow = st => { dlText.textContent = st === 'ok' ? '已开始下载' : st === 'fail' ? '下载没有成功，请再试一次' : '下载完整作品集'; dlArrow.hidden = !!st; };
      bindDownload(dl, st => {
        dlShow(st);
        if (st === 'ok') setTimeout(() => dlShow(''), 2400);
      });
      rEnd.append(dl);
    }
    const back = document.createElement('button');
    back.className = 'r-back'; back.textContent = '回到目录';
    back.addEventListener('click', () => closeWork());
    rEnd.append(back);
  }
  function buildPages(i) {
    const work = WORKS[i];
    $('rNo').textContent = work.no;
    $('rTitle').textContent = work.title;
    $('rOf').textContent = work.pages.length;
    rPages.innerHTML = work.pages.map((alt, p) =>
      `<figure class="r-page"><img src="${sheetOf(i, p)}" alt="${alt}" width="2560" height="1440" decoding="async" style="object-position:${slotPos(p)}"></figure>`
    ).join('');
    // 一个作品总共不到 2MB，打开时全部解码好，快速滑动也不会露出底色
    rPages.querySelectorAll('img').forEach(img => img.decode().catch(() => {}));
    fillEnd(i);
  }
  const pageEls = () => [...rPages.querySelectorAll('.r-page')];
  // 无缝长页：滚动完全交给浏览器，这里只根据位置算页码和进度
  function currentIndex() {
    const first = rPages.firstElementChild, n = rPages.childElementCount;
    if (!first) return 0;
    return clamp(Math.floor((reader.scrollTop + reader.clientHeight / 2 - rPages.offsetTop) / first.offsetHeight), 0, n - 1);
  }
  const currentPageEl = () => pageEls()[currentIndex()];
  function syncProgress() {
    const max = reader.scrollHeight - reader.clientHeight;
    $('rAt').textContent = currentIndex() + 1;
    $('rLine').style.transform = `scaleX(${max > 0 ? clamp(reader.scrollTop / max, 0, 1) : 0})`;
  }
  reader.addEventListener('scroll', syncProgress, { passive: true });

  // 卡片和页面之间的过渡：用封面图从一个位置放大/缩小到另一个位置
  function flight(i, from, to) {
    const el = document.createElement('div');
    el.className = 'morph';
    el.append(coverCanvas(i));
    document.body.append(el);
    const box = r => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: `${r.radius}px` });
    const anim = el.animate([box(from), box(to)], { duration: MORPH_MS, easing: MORPH_EASE, fill: 'both' });
    return { el, done: anim.finished.catch(() => {}) };
  }
  const rectOf = (el, radius) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, radius }; };
  const pageRadius = el => el.getBoundingClientRect().width * PAGE_RADIUS;
  const firstReady = el => { const img = el && el.querySelector('img'); return img ? Promise.race([img.decode().catch(() => {}), sleep(1600)]) : null; };

  async function openWork(i, { instant = false, push = true } = {}) {
    if (busy || openIdx >= 0) return;
    busy = true;
    openIdx = i;
    returnFocus = cards[i];
    document.body.classList.add('reading');
    buildPages(i);
    reader.hidden = false;
    reader.scrollTop = savedTop[i] || 0;
    syncProgress();
    if (push) pushHash(i);
    const motion = !instant && !reduced.matches && coversImg;
    const card = cards[i];
    const target = currentPageEl();
    if (motion) {
      card.style.visibility = 'hidden';
      const f = flight(i, rectOf(card, 20), rectOf(target, pageRadius(target)));
      requestAnimationFrame(() => reader.classList.add('show'));
      await f.done;
      card.style.visibility = '';   // 阅读页已经盖住目录，这里就还原，否则切到下一个作品再返回时这张卡片会一直不见
      await firstReady(target);
      reader.classList.add('pages-in');
      f.el.classList.add('out');
      await sleep(200);
      f.el.remove();
    } else {
      reader.classList.add('show', 'pages-in');
    }
    busy = false;
    reader.focus({ preventScroll: true });
  }

  async function finishClose() {
    const i = openIdx;
    if (i < 0 || busy) return;
    busy = true;
    savedTop[i] = reader.scrollTop + reader.clientHeight / 2 < rEnd.offsetTop ? reader.scrollTop : 0;   // 看完了下次从头开始
    const card = cards[i];
    if (!reduced.matches && coversImg) {
      const page = currentPageEl();
      const f = flight(i, rectOf(page, pageRadius(page)), rectOf(card, 20));
      card.style.visibility = 'hidden';
      reader.classList.remove('pages-in');
      reader.classList.remove('show');
      await f.done;
      card.style.visibility = '';
      f.el.classList.add('out');
      await sleep(180);
      f.el.remove();
    } else {
      reader.classList.remove('show', 'pages-in');
      card.style.visibility = '';
      await sleep(reduced.matches ? 0 : 260);
    }
    reader.hidden = true;
    rPages.textContent = '';
    document.body.classList.remove('reading');
    openIdx = -1;
    busy = false;
    dirty = true;
    if (returnFocus) returnFocus.focus({ preventScroll: true });
    if (afterClose) { const fn = afterClose; afterClose = null; fn(); }
  }
  function closeWork() {
    if (openIdx < 0 || busy) return;
    if (pushed) { pushed = false; history.back(); return; }   // 走浏览器的返回，地址和历史记录一起对上
    replaceHash(-1);
    finishClose();
  }

  // 从一个作品直接看下一个：不回目录，淡出换内容
  async function switchWork(i) {
    if (busy || openIdx < 0 || i === openIdx) return;
    busy = true;
    savedTop[openIdx] = 0;
    reader.classList.remove('pages-in');
    await sleep(reduced.matches ? 0 : 240);
    openIdx = i;
    returnFocus = cards[i];
    buildPages(i);
    reader.scrollTop = 0;
    syncProgress();
    replaceHash(i);
    await firstReady(pageEls()[0]);
    reader.classList.add('pages-in');
    busy = false;
    reader.focus({ preventScroll: true });
  }

  addEventListener('popstate', () => {
    const i = parseHash();
    if (i < 0 && openIdx >= 0) finishClose();
    else if (i >= 0 && openIdx < 0) openWork(i, { push: false });
    else if (i >= 0 && i !== openIdx) switchWork(i);
  });

  cards.forEach((card, i) => {
    card.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;   // 新标签打开时走浏览器默认
      e.preventDefault();
      openWork(i);
    });
    // 鼠标移上去就开始下载前两页，点开时基本已经就绪
    const warm = () => { if (!card.dataset.warm) { card.dataset.warm = 1; new Image().src = sheetOf(i, 0); } };
    card.addEventListener('pointerenter', warm);
    card.addEventListener('focus', warm);
  });

  // 竖屏手机：横版页面字小，点一下铺满屏幕高度，左右滑动细看
  let zoomFrom = null;
  function openZoom(img) {
    zImg.src = img.currentSrc || img.src;
    zImg.alt = img.alt;
    zImg.style.objectPosition = img.style.objectPosition;
    zoomer.hidden = false;
    zScroll.scrollLeft = 0;
    zoomFrom = img;
    $('zClose').focus();
  }
  function closeZoom() {
    zoomer.hidden = true;
    zImg.removeAttribute('src');
    if (zoomFrom) reader.focus({ preventScroll: true });
    zoomFrom = null;
  }
  rPages.addEventListener('click', e => {
    const img = e.target.closest('.r-page img');
    if (img && narrow.matches) openZoom(img);
  });
  $('zClose').addEventListener('click', closeZoom);

  // ---------- 结尾页：下载完整作品集、联系方式、再看一遍 ----------
  const PDF_NAME = (CONTACT.name ? CONTACT.name + '-' : '') + 'UI作品集-2026.pdf';
  const PDF_URL = 'portfolio/portfolio-2026.pdf';
  document.getElementById('dlAgain').addEventListener('click', () => goTo(0, true));
  // 点击直接下载；预览环境不能直接下载，要走它提供的保存确认
  function bindDownload(link, show) {
    link.setAttribute('download', PDF_NAME);
    link.addEventListener('click', async e => {
      if (!window.claude || !window.claude.use) { show('ok'); return; }
      e.preventDefault();
      try {
        const dl = await window.claude.use('downloads');
        if (!dl) { window.open(link.href, '_blank'); return; }
        const blob = await (await fetch(link.href)).blob();
        await dl.save({ filename: PDF_NAME, data: blob });
        show('ok');
      } catch (err) {
        show(err && err.code === 'declined' ? '' : 'fail');
      }
    });
  }
  const navDl = document.getElementById('navDl'), navMark = navDl.lastElementChild, navAf = arrowFlow(navMark, navDl);
  bindDownload(navDl, st => {
    navMark.replaceChildren(st === 'ok' ? '✓' : st === 'fail' ? '!' : navAf);
    if (st) setTimeout(() => navMark.replaceChildren(navAf), 2000);
  });
  arrowFlow(document.querySelector('#dlAgain span'), document.getElementById('dlAgain'));
  const dlState = document.querySelector('.dl-state');
  bindDownload(document.querySelector('.dl'), st => {
    dlState.textContent = st === 'ok' ? '已开始下载' : st === 'fail' ? '下载没有成功，请再试一次' : '';
    if (st === 'ok') setTimeout(() => { dlState.textContent = ''; }, 2400);
  });
  (function fillContact() {
    const box = document.getElementById('endContact');
    const items = [['邮箱', CONTACT.email], ['微信', CONTACT.wechat]].filter(x => x[1]);
    if (CONTACT.name) { const b = document.createElement('b'); b.textContent = CONTACT.name; box.append(b); }
    items.forEach(([k, v]) => {
      const btn = document.createElement('button');
      btn.textContent = `${k} ${v}`;
      btn.setAttribute('aria-label', `复制${k} ${v}`);
      btn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(v); } catch { return; }
        const old = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = old; }, 1200);
      });
      box.append(btn);
    });
    box.hidden = !box.childElementCount;
  })();


  // ---------- 鼠标冰晶尾巴：光点后面拖出一条会自己流动、打卷的透明雾尾，背后的画面（视频帧 + PORTFOLIO 标题 + 抠出的老虎）在里面变虚、轻微折射 ----------
  // 照参考录屏：头部是一片较宽的透明液体，甩动时会卷成环、继续流动（灵动来自流体模拟）；
  // 尾巴靠“变细”消失——只显示浓度过了门槛的部分，浓度下降时可见范围往里收，最后只剩一条细细的轮廓线再消失，不会晕成一团。
  // 这一层在老虎之上、文字按钮之下；只在有鼠标的横屏电脑上开，停手后尾巴消失就整层休眠。
  const glass = (() => {
    // 形态按对比样片 A「适中灵动」：轻推力 + 强打卷，液体留在路径上原地卷动，不会被冲到末端堆成一团。
    // 放进网站后存在感太强，又把雾调淡、虚化减半、亮边基本去掉、消失加快（haze/blur/edge/spec/diss）
    const CFG = { push: .13, curl: 20, velR: .0015, dyeR: .003, amt0: .2, amtK: 700, diss: 1.25, a0: .12, a1: .26, b0: .14, b1: .8, useMax: 1, edge: .2, refr: .04, haze: .25, blur: 2.5, spec: .08 };
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches || reduced.matches) return null;
    const canvas = document.getElementById('glass');
    const gl = canvas && canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) { if (canvas) canvas.remove(); return null; }
    const VS = `#version 300 es
    precision highp float;
    in vec2 aPos; uniform vec2 texel;
    out vec2 vUv, vL, vR, vT, vB;
    void main(){ vUv=aPos*.5+.5; vL=vUv-vec2(texel.x,0.); vR=vUv+vec2(texel.x,0.); vT=vUv+vec2(0.,texel.y); vB=vUv-vec2(0.,texel.y); gl_Position=vec4(aPos,0.,1.); }`;
    const head = `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv, vL, vR, vT, vB; out vec4 o;\n`;
    const FS = {
      splat: `uniform sampler2D uT; uniform float aspect, radius, cap, useMax; uniform vec3 color; uniform vec2 point;
        void main(){ vec2 p=vUv-point; p.x*=aspect; vec3 b=texture(uT,vUv).xyz, s=exp(-dot(p,p)/radius)*color;
          o=vec4(useMax>.5?max(b,s):clamp(b+s,-cap,cap),1.); }`,   // 液体用取大不叠加：同一处反复经过也不会越堆越多
      advect: `uniform sampler2D uVel, uSrc; uniform vec2 velTexel; uniform float dt, diss;
        void main(){ vec2 c=vUv-dt*texture(uVel,vUv).xy*velTexel; o=clamp(texture(uSrc,c)/(1.+diss*dt),-3000.,3000.); if(any(isnan(o))) o=vec4(0.); }`,
      div: `uniform sampler2D uVel;
        void main(){ vec2 C=texture(uVel,vUv).xy; float L=texture(uVel,vL).x,R=texture(uVel,vR).x,T=texture(uVel,vT).y,B=texture(uVel,vB).y;
          if(vL.x<0.)L=-C.x; if(vR.x>1.)R=-C.x; if(vT.y>1.)T=-C.y; if(vB.y<0.)B=-C.y; o=vec4(.5*(R-L+T-B),0.,0.,1.); }`,
      curl: `uniform sampler2D uVel;
        void main(){ float L=texture(uVel,vL).y,R=texture(uVel,vR).y,T=texture(uVel,vT).x,B=texture(uVel,vB).x; o=vec4(.5*(R-L-T+B),0.,0.,1.); }`,
      vort: `uniform sampler2D uVel, uCurl; uniform float curl, dt;
        void main(){ float L=texture(uCurl,vL).x,R=texture(uCurl,vR).x,T=texture(uCurl,vT).x,B=texture(uCurl,vB).x,C=texture(uCurl,vUv).x;
          vec2 f=.5*vec2(abs(T)-abs(B),abs(R)-abs(L)); f/=length(f)+1e-4; f*=curl*C; f.y*=-1.;
          o=vec4(clamp(texture(uVel,vUv).xy+f*dt,-1000.,1000.),0.,1.); }`,
      press: `uniform sampler2D uP, uDiv;
        void main(){ float L=texture(uP,vL).x,R=texture(uP,vR).x,T=texture(uP,vT).x,B=texture(uP,vB).x; o=vec4((L+R+T+B-texture(uDiv,vUv).x)*.25,0.,0.,1.); }`,
      grad: `uniform sampler2D uP, uVel;
        void main(){ float L=texture(uP,vL).x,R=texture(uP,vR).x,T=texture(uP,vT).x,B=texture(uP,vB).x; o=vec4(texture(uVel,vUv).xy-vec2(R-L,T-B),0.,1.); }`,
      scale: `uniform sampler2D uT; uniform float k; void main(){ o=k*texture(uT,vUv); }`,
      show: `uniform sampler2D uDye, uVel, uFilm, uTitle, uFront; uniform vec2 dyeTexel, velTexel; uniform float time, a0, a1, b0, b1, edge, refr, haze, blur, spec; uniform int hasTitle, hasFront;
        float dd(vec2 uv){ float d=texture(uDye,uv).x; return isnan(d)||isinf(d)?0.:clamp(d,0.,4.); }
        float body(vec2 uv){ return smoothstep(b0,b1,dd(uv)); }
        vec3 scene(vec2 uv){
          vec2 s=clamp(vec2(uv.x,1.-uv.y),0.,1.);
          vec3 c=texture(uFilm,s).rgb;
          if(hasTitle==1){ vec4 t=texture(uTitle,s); c=mix(c,t.rgb,t.a); }
          if(hasFront==1){ vec4 f=texture(uFront,s); c=mix(c,f.rgb,f.a); }
          return c;
        }
        void main(){
          float d=dd(vUv), a=smoothstep(a0,a1,d);   // 门槛：浓度下降时可见范围往里收，尾巴变细消失
          if(a<.003){ o=vec4(0.); return; }
          float c=body(vUv);
          vec2 e=dyeTexel*1.5;
          vec2 n=vec2(body(vUv+vec2(e.x,0.))-body(vUv-vec2(e.x,0.)), body(vUv+vec2(0.,e.y))-body(vUv-vec2(0.,e.y)));
          float g=length(n);
          vec2 fl=clamp(texture(uVel,vUv).xy*velTexel,-6.,6.)*.006*c;
          vec2 base=vUv-(n*refr+fl);                   // 轻微折射 + 顺着流速的扭曲
          float r=1.+blur*c;                          // 磨砂：越厚越虚
          vec3 acc=vec3(0.);
          for(int k=0;k<10;k++){ float fk=float(k), an=fk*2.39996, rr=r*sqrt((fk+.5)/10.); acc+=scene(base+vec2(cos(an),sin(an))*rr*dyeTexel); }
          vec3 col=acc/10.;
          col=mix(col,vec3(.95,.97,1.),haze*c)+.02*c;  // 薄薄一层白雾
          float rim=smoothstep(.05,.4,g)*(1.-c*.6);   // 外沿一条细细的冰蓝淡金轮廓
          col+=mix(vec3(.78,.9,1.),vec3(1.,.86,.6),.5+.5*sin(time*.5+vUv.x*4.))*rim*edge;
          vec3 N=normalize(vec3(-n*3.,1.));
          col+=pow(max(dot(N,normalize(vec3(-.45,.55,1.))),0.),40.)*spec*c;
          o=vec4(col*a,a)*.94;
        }`,
    };
    const compile = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
    const prog = {};
    try {
      const vs = compile(gl.VERTEX_SHADER, VS);
      for (const [name, src] of Object.entries(FS)) {
        const pr = gl.createProgram();
        gl.attachShader(pr, vs); gl.attachShader(pr, compile(gl.FRAGMENT_SHADER, head + src));
        gl.bindAttribLocation(pr, 0, 'aPos'); gl.linkProgram(pr);
        if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
        const u = {}, n = gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS);
        for (let k = 0; k < n; k++) { const info = gl.getActiveUniform(pr, k); u[info.name] = gl.getUniformLocation(pr, info.name); }
        prog[name] = { p: pr, u };
      }
    } catch (err) { console.warn('glass off:', err); canvas.remove(); return null; }
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const texParams = () => {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    const targets = [];
    function target(tw, th) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex); texParams();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, tw, th, 0, gl.RGBA, gl.HALF_FLOAT, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const t = { tex, fb, w: tw, h: th, texel: [1 / tw, 1 / th] };
      targets.push(t);
      return t;
    }
    const pair = (tw, th) => ({ a: target(tw, th), b: target(tw, th), flip() { const x = this.a; this.a = this.b; this.b = x; } });
    function clearAll() {
      gl.clearColor(0, 0, 0, 0);
      for (const t of targets) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.viewport(0, 0, t.w, t.h); gl.clear(gl.COLOR_BUFFER_BIT); }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    // 画面纹理：底层视频帧、标题（按 DOM 的位置和渐变画到一张画布上）、抠出的老虎
    const sceneTex = [0, 1, 2].map(() => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); texParams(); return t; });
    const titleCanvas = document.createElement('canvas'), tc = titleCanvas.getContext('2d');
    const TITLE_PARTS = [
      ['.title .l', [[0, '#111a4d'], [.45, '#1d2a66'], [.78, '#33508e'], [1, '#7d97c4']]],
      ['.title .r', [[0, '#9fb2d6'], [.22, '#5b4aa0'], [.48, '#7a2c8c'], [.7, '#b51d7d'], [1, '#4c1b6e']]],
    ].map(([sel, stops]) => [document.querySelector(sel), stops]);
    function drawTitle() {
      tc.setTransform(1, 0, 0, 1, 0, 0);
      tc.clearRect(0, 0, titleCanvas.width, titleCanvas.height);
      const op = parseFloat(root.style.getPropertyValue('--title-o'));
      tc.globalAlpha = Number.isFinite(op) ? op : 1;
      for (const [el, stops] of TITLE_PARTS) {
        const r = el.getBoundingClientRect(), W = el.offsetWidth, H = el.offsetHeight;
        if (!W) continue;
        const k = r.width / W, cs = getComputedStyle(el);
        tc.setTransform(dpr * k, 0, 0, dpr * k, r.left * dpr, r.top * dpr);
        tc.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        if ('letterSpacing' in tc) tc.letterSpacing = cs.letterSpacing;
        tc.textBaseline = 'alphabetic'; tc.textAlign = 'left';
        const m = tc.measureText(el.textContent), asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent;
        const y = (H - (asc + desc)) / 2 + asc;   // 和 CSS 一样：行高 .8 时字形按半行距居中
        const ang = 100 * Math.PI / 180, dx = Math.sin(ang), dy = -Math.cos(ang), L = Math.abs(W * dx) + Math.abs(H * dy);
        const grad = tc.createLinearGradient(W / 2 - dx * L / 2, H / 2 - dy * L / 2, W / 2 + dx * L / 2, H / 2 + dy * L / 2);
        stops.forEach(([at, c]) => grad.addColorStop(at, c));
        tc.fillStyle = grad;
        tc.fillText(el.textContent, 0, y);
      }
    }
    function upload(t, src) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); }

    let vel, dye, pres, divT, curlT, cw = 0, ch = 0;
    function size() {
      if (film.width === cw && film.height === ch) return;
      cw = film.width; ch = film.height;
      canvas.width = cw; canvas.height = ch; titleCanvas.width = cw; titleCanvas.height = ch;
      for (const t of targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
      targets.length = 0;
      const sim = s => [Math.max(8, Math.round(vw * s)), Math.max(8, Math.round(vh * s))];
      const [a, b] = sim(1 / 7), [c, d] = sim(1 / 2);
      vel = pair(a, b); pres = pair(a, b); divT = target(a, b); curlT = target(a, b); dye = pair(c, d);
      clearAll();
      uploadedVer = -1;
    }
    function run(name, out, uniforms) {
      const { p, u } = prog[name];
      gl.useProgram(p);
      let unit = 0;
      for (const [k, v] of Object.entries(uniforms)) {
        if (!u[k]) continue;
        if (v && v.tex) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, v.tex); gl.uniform1i(u[k], unit++); }
        else if (Array.isArray(v)) (v.length === 2 ? gl.uniform2fv : gl.uniform3fv).call(gl, u[k], v);
        else gl.uniform1f(u[k], v);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb); gl.viewport(0, 0, out.w, out.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 输入：光点（比鼠标慢半拍）每帧走过的路段沿路打几下；液体量跟速度走，慢下来或停住几乎不加，光标处不会堆成一团
    const splats = [], cur = { x: -99, y: -99, dx: -99, dy: -99, rx: -99, ry: -99, inside: false };
    let lastHead = null, lastInput = -1e9, awake = false, warmed = false, uploadedVer = -1, t0 = performance.now(), prev = t0;
    const blocked = () => portrait || document.body.classList.contains('reading') || !document.body.classList.contains('ready');
    const dot = document.createElement('div'), ring = document.createElement('div');
    dot.className = 'cur-dot'; ring.className = 'cur-ring';
    document.body.append(dot, ring);
    addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      cur.x = e.clientX; cur.y = e.clientY;
      if (!cur.inside) { cur.inside = true; cur.dx = cur.rx = cur.x; cur.dy = cur.ry = cur.y; lastHead = null; }
      if (blocked()) return;
      lastInput = performance.now();
      if (!awake) { awake = true; size(); uploadedVer = -1; lastHead = null; }
    }, { passive: true });
    document.documentElement.addEventListener('mouseleave', () => { cur.inside = false; lastHead = null; });
    addEventListener('blur', () => { cur.inside = false; lastHead = null; });
    function record(dt) {
      const x = cur.dx, y = cur.dy;
      if (!lastHead) { lastHead = { x, y }; return; }
      const mx = x - lastHead.x, my = y - lastHead.y, dist = Math.hypot(mx, my);
      if (dist < .5) return;
      const vx = mx / Math.max(dt, 1 / 240), vy = my / Math.max(dt, 1 / 240);
      const steps = Math.min(10, Math.max(1, Math.ceil(dist / 12)));
      for (let k = 1; k <= steps; k++) splats.push({ x: lastHead.x + mx * k / steps, y: lastHead.y + my * k / steps, vx, vy, n: steps });
      lastHead = { x, y };
    }

    function sleep() {
      awake = false; splats.length = 0; lastHead = null;
      clearAll();   // 画布一直留在页面上，只是清成全透明；切换显示/隐藏会让浏览器重建图层，第一下会卡
    }
    function frame(now) {
      const dt = Math.min((now - prev) / 1000, 1 / 30) || 0; prev = now;
      // 光标跟随：光点追得快、细圈慢半拍；看作品时藏起来
      const showCur = cur.inside && !blocked();
      document.body.classList.toggle('cur-on', showCur);
      if (showCur) {
        cur.dx += (cur.x - cur.dx) * .3; cur.dy += (cur.y - cur.dy) * .3;
        cur.rx += (cur.x - cur.rx) * .14; cur.ry += (cur.y - cur.ry) * .14;
        dot.style.transform = `translate(${cur.dx.toFixed(1)}px,${cur.dy.toFixed(1)}px)`;
        ring.style.transform = `translate(${cur.rx.toFixed(1)}px,${cur.ry.toFixed(1)}px)`;
      }
      // 预热：显卡第一次用这些着色器、第一次传大纹理时会卡几百毫秒，所以在加载画面还盖着时先空跑一帧
      if (!warmed && !awake && !portrait) {
        warmed = true;
        size(); splats.push({ x: 0, y: 0, vx: 0, vy: 0, n: 1 }); simulate(dt, now); clearAll();
        canvas.style.visibility = 'visible';
        return;
      }
      if (!awake) return;
      if (now - lastInput > 3200 || blocked()) { sleep(); return; }
      if (showCur) record(dt);
      simulate(dt, now);
    }
    function simulate(dt, now) {
      size();
      const aspect = vw / vh;
      for (const s of splats) {
        const pt = [s.x / vw, 1 - s.y / vh], speed = Math.hypot(s.vx, s.vy);
        const vk = vel.a.w / vw * CFG.push / s.n;
        run('splat', vel.b, { uT: vel.a, aspect, radius: CFG.velR, cap: 3000, useMax: 0, color: [s.vx * vk, -s.vy * vk, 0], point: pt, texel: vel.a.texel }); vel.flip();
        run('splat', dye.b, { uT: dye.a, aspect, radius: CFG.dyeR, cap: 1.3, useMax: CFG.useMax, color: [Math.min(1, CFG.amt0 + speed / CFG.amtK) / (CFG.useMax ? 1 : Math.sqrt(s.n)), 0, 0], point: pt, texel: dye.a.texel }); dye.flip();
      }
      splats.length = 0;
      const vt = vel.a.texel;
      run('curl', curlT, { uVel: vel.a, texel: vt });
      run('vort', vel.b, { uVel: vel.a, uCurl: curlT, curl: CFG.curl, dt, texel: vt }); vel.flip();
      run('div', divT, { uVel: vel.a, texel: vt });
      run('scale', pres.b, { uT: pres.a, k: .8, texel: vt }); pres.flip();
      for (let k = 0; k < 20; k++) { run('press', pres.b, { uP: pres.a, uDiv: divT, texel: vt }); pres.flip(); }
      run('grad', vel.b, { uP: pres.a, uVel: vel.a, texel: vt }); vel.flip();
      run('advect', vel.b, { uVel: vel.a, uSrc: vel.a, velTexel: vt, dt, diss: .3, texel: vt }); vel.flip();
      run('advect', dye.b, { uVel: vel.a, uSrc: dye.a, velTexel: vt, dt, diss: CFG.diss, texel: dye.a.texel }); dye.flip();
      // 画面变了才重新上传（老虎在走、标题在动时）
      if (uploadedVer !== sceneVer) {
        uploadedVer = sceneVer;
        upload(sceneTex[0], film);
        if (titleShown) { drawTitle(); upload(sceneTex[1], titleCanvas); upload(sceneTex[2], front); }
      }
      const { p, u } = prog.show;
      gl.useProgram(p);
      [dye.a.tex, vel.a.tex, ...sceneTex].forEach((tex, k) => { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, tex); });
      gl.uniform1i(u.uDye, 0); gl.uniform1i(u.uVel, 1); gl.uniform1i(u.uFilm, 2); gl.uniform1i(u.uTitle, 3); gl.uniform1i(u.uFront, 4);
      gl.uniform2fv(u.dyeTexel, dye.a.texel); gl.uniform2fv(u.velTexel, vt);
      gl.uniform1f(u.time, (now - t0) / 1000);
      ['a0', 'a1', 'b0', 'b1', 'edge', 'refr', 'haze', 'blur', 'spec'].forEach(k => gl.uniform1f(u[k], CFG[k]));
      gl.uniform1i(u.hasTitle, titleShown ? 1 : 0); gl.uniform1i(u.hasFront, titleShown ? 1 : 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    return { frame };
  })();

  // 检查用：读状态
  window.whiteTiger = { state: () => ({ mode: useImg ? 'img' : 'blob', w, t: timeAtW(w), frame: lastFrame / 2, settled, hold, zoom, tween: tween ? tween.stage : null, loadedFrames, masks: masks.filter(Boolean).length, decoded: [...decoded.values()].filter(Boolean).length, vw, vh, openIdx, busy }) };

  layout();
  if (deepWork >= 0) { w = stageW[CONTENTS_STAGE]; settled = CONTENTS_STAGE; openWork(deepWork, { instant: true, push: false }); }
  requestAnimationFrame(tick);
  loadAll();
  loadCovers();
})();
