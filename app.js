(() => {
  'use strict';
  // ---------- 配置 ----------
  // 素材：即梦一镜到底视频（3184×1792，24fps，15.07 秒），拆成 1440×810 序列帧 frames/0000–0360。
  // 0–5.5 秒踏云走近，5.5–7.6 秒凝视镜头，约 7.7 秒闭眼、转身，9.6–10.5 秒镜头拉高俯拍，10.5–14.6 秒向右走出画面。
  const FPS = 24, LAST_FRAME = 360, DURATION = LAST_FRAME / FPS;
  const SRC_W = 1440, SRC_H = 810;
  // 老虎抠像（系统主体识别）只做标题可见的前段：masks/NNN.webp 上下两格依次是第 2N、2N+1 帧，透明度即老虎。
  const MASK_LAST = 192, MASK_W = 960, MASK_H = 540;
  // 开场：页面打开后，老虎从远处踏云走近几步（0 → INTRO_T 秒），停下就是首页
  const INTRO_T = 2.2, INTRO_SECS = 2.6, INTRO_DELAY = 500;
  // 吸附点（视频秒数）。hold：停在这里时定格，镜头极慢地推向这一点（比例坐标），zoom 为推近幅度
  const STAGES = [
    { t: INTRO_T, hold: [0.5, 0.42], zoom: 0.025 },  // 01 首页：走近几步的白虎、标题、理念
    { t: 6.4, hold: [0.5, 0.36], zoom: 0.045 },      // 02 凝视镜头，标题分开，出现 EXPLORE
    { t: 15.0 },                               // 03 俯拍雪地，老虎已走出，目录
    { t: 15.0, hold: [0.5, 0.52], zoom: 0.035 }, // 04 结尾：同一片雪地缓慢推近，目录换成 THANK YOU 和下载
  ];
  const CONTENTS_STAGE = 2, END_STAGE = 3;
  const END_W = 0.9;                       // 目录到结尾的切换时长（秒），这段画面不动，只换文字
  // 姓名和联系方式：填上就会显示在结尾页，点击可复制；留空则不显示
  const CONTACT = { name: '', email: '', wechat: '' };
  // 播放速度（相对原速）：走出画面这段放慢到 0.57 倍（0.62 偏快、约 0.52 偏慢）
  const rate = t => lerp(1.1, 0.57, smoothstep(9.8, 10.8, t));
  // 放慢段补了中间帧（光流插帧）：第 i 帧和 i+1 帧之间多一张。每 4 张竖着拼成 frames/midNN.webp（文件数有上限）。
  // 播放位置用"半帧"计：槽位 2i 是原帧，2i+1 是中间帧（只在 MID_FROM 之后有）
  const MID_FROM = 236, MID_PER = 4, LAST_SLOT = LAST_FRAME * 2;
  const hasSlot = s => s >= 0 && s <= LAST_SLOT && ((s & 1) === 0 || ((s >> 1) >= MID_FROM && (s >> 1) < LAST_FRAME));
  const HOLD_SECS = 7;                     // 定格推近的时长
  const FAST_MS = 1000;                    // 快进时剩下的动作最多播多久
  const CARDS_T = 11.8;                    // 播到这里，四张目录卡片几乎同时升起（按时间动画，不跟视频进度）
  const READY_FRAME = 160;                 // 走近到凝视的帧加载完就进入页面，其余在后台继续

  const film = document.getElementById('film'), fctx = film.getContext('2d');
  const front = document.getElementById('front'), tctx = front.getContext('2d');
  const root = document.documentElement;
  const navButtons = [...document.querySelectorAll('[data-nav]')];
  const explore = document.querySelector('.explore'), contents = document.querySelector('.contents'), endEl = document.querySelector('.end');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
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
      if (!reduced.matches && !introDone) introStart = performance.now() + INTRO_DELAY; else introDone = true;
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
  let vw, vh, dpr, scale, ox, oy, portrait;
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
    const u = smoothstep(INTRO_T + 0.2, 6.2, t);
    css('--split', `${(u * vw * (portrait ? .2 : .13)).toFixed(1)}px`);
    css('--tk', (1 + u * .12).toFixed(4));
    css('--ty', `${(-u * vh * .035).toFixed(1)}px`);
    const titleO = 1 - smoothstep(7.6, 8.6, t);
    css('--title-o', titleO.toFixed(3));
    css('--intro-o', (1 - smoothstep(INTRO_T + 0.15, INTRO_T + 1.4, t)).toFixed(3));
    // EXPLORE：开场走近时就出现，老虎转身前淡出
    const ex = smoothstep(0.9, 2.0, t) * (1 - smoothstep(7.2, 7.9, t));
    css('--explore-o', ex.toFixed(3));
    explore.classList.toggle('on', ex > .5);
    const co = smoothstep(10.6, 12.4, t);
    // 结尾：e 为 0–1，目录淡出、卡片沉下，THANK YOU 和下载浮现
    const e = clamp((w - stageW[CONTENTS_STAGE]) / END_W, 0, 1);
    const coEnd = co * (1 - smoothstep(0, .55, e));
    css('--contents-o', coEnd.toFixed(3));
    css('--head-y', `${((1 - co) * 30 - e * 26).toFixed(1)}px`);
    contents.classList.toggle('on', co > .6 && e < .5);
    contents.classList.toggle('in', t > CARDS_T && e < .22);
    const eo = smoothstep(.4, 1, e);
    css('--end-o', eo.toFixed(3));
    css('--end-y', `${((1 - eo) * 30).toFixed(1)}px`);
    endEl.classList.toggle('on', e > .7);
    css('--progress', (t / DURATION).toFixed(4));
    const scene = e > .5 ? 'end' : t > 11 ? 'contents' : 'portfolio';
    if (scene !== lastScene) {
      lastScene = scene;
      const info = { portfolio: ['01', 'PORTFOLIO', '0', ''], contents: ['02', 'CONTENTS', '2', '继续下滑 <span>↓</span>'], end: ['03', 'THANK YOU', '3', '向上回到目录 <span>↑</span>'] }[scene];
      document.getElementById('sceneNo').textContent = info[0];
      document.getElementById('sceneName').textContent = info[1];
      navButtons.forEach(b => b.setAttribute('aria-current', String(b.dataset.nav === info[2])));
      document.getElementById('hint').innerHTML = info[3];
    }
    return titleO > .01;
  }

  let w = 0, dirty = true, hold = 0, dir = 1, lastFrame = -1;
  let introStart = 0, introDone = false;   // introStart 为 0：还没加载完，停在第一帧
  // 开场播到第几秒：缓起缓停，像走几步停下；一有操作就结束开场
  function introTime(now) {
    if (!introStart) return 0;
    const x = clamp((now - introStart) / (INTRO_SECS * 1000), 0, 1);
    if (x >= 1) introDone = true;
    return INTRO_T * (1 - Math.cos(Math.PI * x)) / 2;
  }
  function draw(now) {
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.imageSmoothingQuality = 'high';
    const t = introDone ? timeAtW(w) : introTime(now);
    const i = nearDecoded(frameAt(t), tween && tween.fast ? 16 : 4);
    const st = STAGES[stageAt(w)];
    if (st.hold) anchor = st.hold;
    zoom = 1 + (st.zoom || 0) * hold * hold * (3 - 2 * hold);
    drawFilm(i);
    drawFront(i, updateText(t));
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
    const resting = introDone && !tween && !dragging && STAGES[n].hold && Math.abs(w - stageW[n]) < 0.01 && !reduced.matches;
    const h = resting ? Math.min(1, hold + dt / HOLD_SECS) : Math.max(0, hold - dt * 2.5);
    const holdChanged = h !== hold;
    hold = h;
    if (moving || holdChanged || dirty || (!introDone && introStart)) { draw(now); dirty = false; }
    requestAnimationFrame(tick);
  }

  // ---------- 播放到停点：settled 只在整段播完后才更新，中途被打断也不会算错方向 ----------
  let settled = 0, tween = null, dragging = false, wVel = 0, tweenLast = 0;
  // fast：快进（播放中同方向再滑一次、点顶部导航），剩下的动作约 1 秒播完，画面仍是连续的
  function goTo(i, fast) {
    i = clamp(i, 0, LAST);
    introDone = true;
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
    const t = Math.min(1, (now - tween.start) / tween.dur);
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
    if (openIdx >= 0) { readerWheel(e); return; }
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
      if (e.key === 'Escape') { e.preventDefault(); if (!zoomer.hidden) closeZoom(); else closeWork(); return; }
      if (!zoomer.hidden || e.repeat || ((e.key === ' ' || e.key === 'Enter') && e.target.closest('button, a'))) return;
      const forward = ['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key) || (e.key === ' ' && !e.shiftKey);
      const back = ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key) || (e.key === ' ' && e.shiftKey);
      if (forward || back) { e.preventDefault(); flip(at + (forward ? 1 : -1)); }
      else if (e.key === 'Home') { e.preventDefault(); flip(0); }
      else if (e.key === 'End') { e.preventDefault(); flip(slides().length - 1); }
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
  // EXPLORE：和往下滑一次一样，播放中再点就快进
  explore.addEventListener('click', () => step(1));

  // 底部进度条：按住拖动可以逐帧看动作，松手后顺着拖动的方向把这段动作播完
  const bar = document.querySelector('.bar');
  const dragTo = e => {
    const r = bar.getBoundingClientRect();
    const t = clamp((e.clientX - r.left) / r.width, 0, 1) * DURATION;
    const nw = wallAt(Math.max(INTRO_T, t)) - W0;
    dir = Math.sign(nw - w) || dir;
    w = nw; dirty = true;
  };
  bar.addEventListener('pointerdown', e => { dragging = true; introDone = true; tween = null; bar.setPointerCapture(e.pointerId); dragTo(e); });
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
  const MORPH_MS = 620, MORPH_EASE = 'cubic-bezier(.22,1,.36,1)', PAGE_RADIUS = .0125;
  const $ = id => document.getElementById(id);
  const reader = $('reader'), rPages = $('rPages'), rEnd = $('rEnd'), rStage = $('rStage'), rRail = $('rRail'), rPrev = $('rPrev'), rNext = $('rNext');
  const zoomer = $('zoomer'), zScroll = $('zScroll'), zImg = $('zImg');
  const cards = [...document.querySelectorAll('[data-work]')];
  const narrow = matchMedia('(max-aspect-ratio:4/5)');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sheetOf = (i, p) => `works/wk-${i + 1}-${p >> 1}.webp`;
  const slotPos = p => (p & 1 ? '0 100%' : '0 0');
  let afterClose = null, openIdx = -1, busy = false, pushed = false, returnFocus = null, at = 0, flying = null, flipToken = 0, swiped = false;
  const savedAt = {};   // 每个作品看到第几页，再次打开时接着看

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
      a.addEventListener('click', e => { e.preventDefault(); switchWork(i + 1); });
      rEnd.append(a);
    } else {
      const p = document.createElement('p');
      p.className = 'r-done'; p.textContent = '四个作品已全部看完';
      rEnd.append(p);
      const dl = document.createElement('button');
      dl.className = 'r-download'; dl.innerHTML = '下载完整作品集 <i aria-hidden="true">↓</i>';
      dl.addEventListener('click', () => { afterClose = () => goTo(END_STAGE, true); closeWork(); });
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
      `<figure class="r-page"><img data-src="${sheetOf(i, p)}" alt="${alt}" width="2560" height="1440" decoding="async" style="object-position:${slotPos(p)}"></figure>`
    ).join('');
    rPages.append(rEnd);
    rRail.innerHTML = work.pages.map((alt, p) => `<button class="r-tick" aria-label="第 ${p + 1} 页：${alt}" title="${alt}"></button>`).join('');
    fillEnd(i);
    syncPager();
  }
  const pageEls = () => [...rPages.querySelectorAll('.r-page')];
  const slides = () => [...rPages.children];
  const lastPageEl = () => { const els = pageEls(); return els[Math.min(at, els.length - 1)]; };
  // 一张图里有两页，提前把前后几页要用的图读好，翻页时不会露底色
  function loadImg(el) {
    const img = el && el.querySelector('img');
    if (img && !img.getAttribute('src')) { img.src = img.dataset.src; img.decode().catch(() => {}); }
    return img;
  }
  function syncPager() {
    const s = slides(), n = s.length - 1;
    s.forEach((el, k) => el.classList.toggle('on', k === at));
    for (let k = at - 1; k <= at + 2; k++) loadImg(s[k]);
    $('rAt').textContent = Math.min(at + 1, n);
    [...rRail.children].forEach((b, k) => {
      b.classList.toggle('done', k <= at);
      if (k === at) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    rPrev.hidden = at === 0;
    rNext.hidden = at === n;
    reader.classList.toggle('at-end', at === n);
  }

  // 翻页：页面框不动，下一页淡入盖住当前页，画面同时从略大的尺寸缓缓落定，延续首页的镜头推近
  // 先让当前页淡出，再让下一页淡入，避免两页文字叠在一起看不清
  const OUT_MS = 200, IN_DELAY = 120, IN_MS = 380, PUSH_MS = 900, PUSH_SCALE = 1.045, PUSH_EASE = 'cubic-bezier(.16,1,.3,1)';
  function landFlip() {
    if (!flying) return;
    const f = flying;
    flying = null;
    f.anims.forEach(a => a.cancel());
    f.els.forEach(el => el.classList.remove('fly', 'upper'));
  }
  function pushIn(incoming, outgoing) {
    incoming.classList.add('fly', 'upper');
    outgoing.classList.add('fly');
    const pushes = [...incoming.children].map(c => c.animate([{ transform: `scale(${PUSH_SCALE})` }, { transform: 'none' }], { duration: PUSH_MS, delay: IN_DELAY, easing: PUSH_EASE, fill: 'backwards' }));
    const anims = [
      outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: OUT_MS, easing: 'ease-in', fill: 'forwards' }),
      incoming.animate([{ opacity: 0 }, { opacity: 1 }], { duration: IN_MS, delay: IN_DELAY, easing: 'ease-out', fill: 'backwards' }),
      ...pushes,
    ];
    const mine = { els: [incoming, outgoing], anims };
    flying = mine;
    pushes[0].onfinish = () => { if (flying === mine) landFlip(); };
  }
  async function flip(to) {
    if (busy || openIdx < 0 || !zoomer.hidden) return;
    landFlip();
    const s = slides();
    if (to < 0 || to >= s.length || to === at) return;
    const token = ++flipToken, img = loadImg(s[to]);
    if (img && !img.complete) {
      await Promise.race([img.decode().catch(() => {}), sleep(260)]);
      if (token !== flipToken || openIdx < 0) return;
    }
    const outgoing = s[at];
    at = to;
    syncPager();
    if (!reduced.matches) pushIn(s[to], outgoing);
  }

  // 滚轮和触控板：一次滑动翻一页，松手后的惯性全部忽略，和首页同样的判断
  let rWheelLast = 0, rWheelArmed = true, rWheelAcc = 0;
  function readerWheel(e) {
    if (e.ctrlKey || !zoomer.hidden) return;   // 触控板双指捏合是缩放；放大图自己滚动
    e.preventDefault();
    const now = performance.now(), major = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    const v = major * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
    if (now - rWheelLast > 220 || (!rWheelArmed && Math.abs(v) > 12 && Math.sign(v) !== Math.sign(rWheelAcc))) { rWheelArmed = true; rWheelAcc = 0; }
    rWheelLast = now;
    if (!rWheelArmed) return;
    rWheelAcc += v;
    if (Math.abs(rWheelAcc) > 24) { rWheelArmed = false; flip(at + Math.sign(rWheelAcc)); }
  }
  rPrev.addEventListener('click', () => flip(at - 1));
  rNext.addEventListener('click', () => flip(at + 1));
  rRail.addEventListener('click', e => {
    const b = e.target.closest('.r-tick');
    if (b) flip([...rRail.children].indexOf(b));
  });

  // 手指：往上或往左滑看下一页，往下或往右滑看上一页
  let touch = null;
  rStage.addEventListener('touchstart', e => {
    swiped = false;
    touch = e.touches.length > 1 ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  rStage.addEventListener('touchend', e => {
    if (!touch) return;
    const t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    const major = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
    touch = null;
    if (Math.abs(major) < 36) return;
    swiped = true;
    flip(at + (major < 0 ? 1 : -1));
  }, { passive: true });

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
    at = savedAt[i] || 0;
    document.body.classList.add('reading');
    buildPages(i);
    reader.hidden = false;
    if (push) pushHash(i);
    const motion = !instant && !reduced.matches && coversImg;
    const card = cards[i];
    const target = lastPageEl();
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
    flipToken++;
    landFlip();
    savedAt[i] = at < WORKS[i].pages.length ? at : 0;   // 看完了下次从头开始
    const card = cards[i];
    if (!reduced.matches && coversImg) {
      const page = lastPageEl();
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
    savedAt[openIdx] = 0;
    flipToken++;
    landFlip();
    reader.classList.remove('pages-in');
    await sleep(reduced.matches ? 0 : 240);
    openIdx = i;
    returnFocus = cards[i];
    at = 0;
    buildPages(i);
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
    if (img && narrow.matches && !swiped) openZoom(img);
  });
  $('zClose').addEventListener('click', closeZoom);

  // ---------- 结尾页：下载完整作品集、联系方式、再看一遍 ----------
  const PDF_NAME = (CONTACT.name ? CONTACT.name + '-' : '') + 'UI作品集-2026.pdf';
  const dlLink = document.querySelector('.dl');
  dlLink.setAttribute('download', PDF_NAME);
  document.getElementById('dlAgain').addEventListener('click', () => goTo(0, true));
  // 预览环境不能直接下载，要走它提供的保存确认；正式部署后就是浏览器直接下载
  dlLink.addEventListener('click', async e => {
    if (!window.claude || !window.claude.use) return;
    e.preventDefault();
    const label = dlLink.querySelector('.dl-state');
    try {
      label.textContent = '准备中…';
      const dl = await window.claude.use('downloads');
      if (!dl) { label.textContent = ''; window.open(dlLink.href, '_blank'); return; }
      const blob = await (await fetch(dlLink.href)).blob();
      label.textContent = '';
      await dl.save({ filename: PDF_NAME, data: blob });
    } catch (err) {
      label.textContent = err && err.code === 'declined' ? '' : '下载没有成功，请再试一次';
    }
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

  // 检查用：读状态
  window.whiteTiger = { state: () => ({ mode: useImg ? 'img' : 'blob', w, t: timeAtW(w), frame: lastFrame / 2, introDone, settled, hold, zoom, tween: tween ? tween.stage : null, loadedFrames, masks: masks.filter(Boolean).length, decoded: [...decoded.values()].filter(Boolean).length, vw, vh, openIdx, busy }) };

  layout();
  if (deepWork >= 0) { introDone = true; w = stageW[CONTENTS_STAGE]; settled = CONTENTS_STAGE; openWork(deepWork, { instant: true, push: false }); }
  requestAnimationFrame(tick);
  loadAll();
  loadCovers();
})();
