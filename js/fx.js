/**
 * 2048 全屏粒子层 —— 合并爆点、目标环、连击扫光、通关彩带、死局落尘。
 *
 * 浏览器里挂到 window.Game2048Fx，Node 里通过 module.exports 导出；
 * 加载本文件不碰 document / window，只有调用 create() 才会去拿 canvas。
 *
 * 分两部分：
 *   1. 纯函数 planBurst / palette / planConfetti / planDust —— 只产出粒子数据，
 *      随机源可注入（默认 Math.random），所以测试能拿固定随机断言确定性；
 *   2. create() —— 一块 position:fixed 的 canvas + 单个 rAF 循环，没有粒子时自动停。
 *
 * 坐标约定：全部是视口 CSS 像素，与 getBoundingClientRect 同一套坐标，
 * 因此 renderer.getCellCenter() 的结果可以直接当爆点用。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Game2048Fx = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TAU = Math.PI * 2;

  /** 同屏粒子硬上限：超出丢最旧的，防止连击叠到掉帧 */
  var MAX_PARTICLES = 900;

  /** 方块配色，必须与 styles.css 的 .tile__inner[data-value] 保持一致 */
  var PALETTE = {
    2: '#eee4da',
    4: '#ede0c8',
    8: '#f2b179',
    16: '#f59563',
    32: '#f67c5f',
    64: '#f65e3b',
    128: '#edcf72',
    256: '#edcc61',
    512: '#edc850',
    1024: '#edc53f',
    2048: '#edc22e'
  };

  /** 超出 2048 的方块在样式里是深炭色，粒子跟着走 */
  var SUPER_COLOR = '#3f3b33';

  var BURST_MIN = 8;
  var BURST_MAX = 46;
  var BURST_GRAVITY = 420;
  var CONFETTI_GRAVITY = 180;
  var DUST_GRAVITY = 40;

  /** 彩带用的颜色环：方块色轮着来，保证每一片都能在纸面上看见 */
  var CONFETTI_COLORS = [
    '#f2b179', '#f67c5f', '#edcf72', '#edcc61',
    '#edc850', '#8fbf7f', '#7fa8c9', '#c98fb4'
  ];

  /** 落尘的灰：比棋盘底色深一点，压在木纹上也不抢眼 */
  var DUST_COLOR = '#8d8274';

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function log2(value) {
    return Math.log(value) / Math.LN2;
  }

  /** 取注入的随机源；没给就用 Math.random */
  function randomOf(options) {
    return options && typeof options.random === 'function' ? options.random : Math.random;
  }

  function hex2(number) {
    var text = Math.round(clamp(number, 0, 255)).toString(16);
    return text.length < 2 ? '0' + text : text;
  }

  /** 往白色方向提亮，用来给同色粒子做深浅两层 */
  function lighten(hex, amount) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);

    function mix(channel) {
      return channel + (255 - channel) * amount;
    }

    return '#' + hex2(mix(r)) + hex2(mix(g)) + hex2(mix(b));
  }

  /**
   * 方块值 -> 粒子配色。
   * @param {number} value
   * @returns {{main: string, alt: string}} alt 是同色提亮，颗粒有层次
   */
  function palette(value) {
    var v = Number(value);
    var main = PALETTE[v] || SUPER_COLOR;
    return { main: main, alt: lighten(main, 0.22) };
  }

  /**
   * 合并爆点。
   * @param {{value:number, combo?:number, x:number, y:number, random?:Function}} options
   * @returns {Array<object>} 粒子数组（纯数据，可序列化）
   */
  function planBurst(options) {
    var opts = options || {};
    var value = Number(opts.value) > 0 ? Number(opts.value) : 2;
    var combo = Number(opts.combo) > 0 ? Math.floor(Number(opts.combo)) : 0;
    var x = Number(opts.x) || 0;
    var y = Number(opts.y) || 0;
    var random = randomOf(opts);
    var colors = palette(value);

    var degree = Math.round(log2(value));
    var count = clamp(6 + degree * 3 + combo * 2, BURST_MIN, BURST_MAX);
    // 值越大，出现大颗粒的概率越高；上限留 0.85，保证总有小碎屑
    var bigChance = clamp((degree - 5) / 6, 0, 0.85);

    var particles = [];
    var step = TAU / count;
    var start = random() * TAU;

    for (var i = 0; i < count; i++) {
      // 角度均分 + 最多半个扇区的抖动，看起来是「炸开」而不是「花瓣」
      var angle = start + step * i + (random() - 0.5) * step * 0.7;
      var speed = 60 + random() * 160;
      var size = 3 + random() * 2 + (random() < bigChance ? 2 : 0);

      particles.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: BURST_GRAVITY,
        life: 0.55 + random() * 0.5,
        age: 0,
        size: size,
        // 方块与圆点各半：全方块太硬，全圆点又和木纹糊在一起
        shape: i % 2 === 0 ? 'square' : 'dot',
        color: i % 4 === 3 ? colors.alt : colors.main,
        rot: random() * TAU,
        spin: (random() - 0.5) * 12
      });
    }

    return particles;
  }

  /**
   * 通关彩带：从顶部整幅宽度撒下来。
   * @param {{width:number, height:number, count?:number, random?:Function}} options
   */
  function planConfetti(options) {
    var opts = options || {};
    var width = Number(opts.width) > 0 ? Number(opts.width) : 0;
    var height = Number(opts.height) > 0 ? Number(opts.height) : 0;
    var count = Number(opts.count);
    if (!(count > 0)) count = 120;
    count = Math.min(Math.floor(count), MAX_PARTICLES);
    var random = randomOf(opts);

    var particles = [];
    for (var i = 0; i < count; i++) {
      particles.push({
        x: random() * width,
        // 起点略高于视口，落下来的第一秒才不会被看到凭空出现
        y: -20 - random() * Math.min(120, height * 0.2),
        vx: (random() - 0.5) * 90,
        vy: 60 + random() * 120,
        gravity: CONFETTI_GRAVITY,
        life: 2.2 + random() * 1.2,
        age: 0,
        size: 4 + random() * 5,
        shape: i % 3 === 0 ? 'dot' : 'square',
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        rot: random() * TAU,
        spin: (random() - 0.5) * 10
      });
    }

    return particles;
  }

  /**
   * 死局/超时的落尘：低初速、灰、寿命长，慢慢从上方沉下来。
   * @param {{width:number, height:number, count?:number, random?:Function}} options
   */
  function planDust(options) {
    var opts = options || {};
    var width = Number(opts.width) > 0 ? Number(opts.width) : 0;
    var height = Number(opts.height) > 0 ? Number(opts.height) : 0;
    var count = Number(opts.count);
    if (!(count > 0)) count = 40;
    count = Math.min(Math.floor(count), MAX_PARTICLES);
    var random = randomOf(opts);

    var particles = [];
    for (var i = 0; i < count; i++) {
      particles.push({
        x: random() * width,
        y: -10 - random() * Math.min(160, height * 0.25),
        vx: (random() - 0.5) * 16,
        vy: 18 + random() * 26,
        gravity: DUST_GRAVITY,
        life: 2.4 + random() * 1.4,
        age: 0,
        size: 2 + random() * 3,
        shape: 'dot',
        color: DUST_COLOR,
        rot: 0,
        spin: 0
      });
    }

    return particles;
  }

  /**
   * 创建一块全屏粒子画布。
   * @param {{canvas?: HTMLCanvasElement, reduceMotion?: boolean}} options
   *        reduceMotion 为 true 时所有特效方法都是空操作（音效不受影响）。
   * @returns {object} burst / confetti / dust / ring / sweep / shake / resize / stop / stats
   */
  function create(options) {
    var opts = options || {};
    var canvas = opts.canvas || null;
    var reduceMotion = opts.reduceMotion === true;
    var doc = canvas && canvas.ownerDocument ? canvas.ownerDocument : null;
    var win = doc && doc.defaultView ? doc.defaultView : null;
    var ctx = canvas && typeof canvas.getContext === 'function'
      ? canvas.getContext('2d')
      : null;

    var particles = [];
    var rings = [];
    var sweeps = [];
    var width = 0;
    var height = 0;
    var dpr = 1;
    var rafId = null;
    var lastTs = 0;
    var running = false;
    var shakeTimer = null;
    var shakeEl = null;

    /* ---------- 尺寸 ---------- */

    /** 按视口与 DPR 重置画布；后台恢复、窗口缩放都会调 */
    function resize() {
      if (!canvas || !ctx || !win) return;

      width = Math.max(0, win.innerWidth || 0);
      height = Math.max(0, win.innerHeight || 0);
      // 高 DPR 屏上封顶 2：再高的倍率对这点粒子没有可见收益，只烧填充率
      dpr = Math.min(2, win.devicePixelRatio || 1);

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      // 改 width/height 会把变换矩阵重置，必须重新设一次
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /* ---------- 循环 ---------- */

    function ensureLoop() {
      if (running || !ctx) return;
      if (doc && doc.hidden) return;   // 后台标签页不跑 rAF，恢复时再起

      running = true;
      lastTs = 0;
      rafId = win.requestAnimationFrame(frame);
    }

    function pause() {
      running = false;
      if (rafId !== null && win) win.cancelAnimationFrame(rafId);
      rafId = null;
    }

    function frame(timestamp) {
      rafId = null;
      if (!running) return;

      var dt = lastTs ? (timestamp - lastTs) / 1000 : 1 / 60;
      lastTs = timestamp;
      if (!(dt > 0)) dt = 1 / 60;
      // 切回来时 timestamp 会跳一大截，夹住避免粒子瞬移
      if (dt > 0.05) dt = 0.05;

      step(dt);
      draw();

      if (particles.length || rings.length || sweeps.length) {
        rafId = win.requestAnimationFrame(frame);
      } else {
        running = false;
      }
    }

    function step(dt) {
      var alive = [];
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.age += dt;
        if (p.age >= p.life) continue;
        p.vy += p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;
        alive.push(p);
      }
      particles = alive;

      rings = rings.filter(function (ring) {
        ring.age += dt;
        return ring.age < ring.life;
      });

      sweeps = sweeps.filter(function (sweep) {
        sweep.age += dt;
        return sweep.age < sweep.life;
      });
    }

    /* ---------- 绘制 ---------- */

    function draw() {
      if (!ctx) return;

      ctx.clearRect(0, 0, width, height);

      for (var s = 0; s < sweeps.length; s++) drawSweep(sweeps[s]);
      for (var r = 0; r < rings.length; r++) drawRing(rings[r]);

      for (var i = 0; i < particles.length; i++) drawParticle(particles[i]);
      ctx.globalAlpha = 1;
    }

    function drawParticle(p) {
      var progress = p.age / p.life;
      // 先亮后暗：平方衰减在深色木纹上比线性更耐看
      ctx.globalAlpha = clamp(1 - progress * progress, 0, 1);
      ctx.fillStyle = p.color;

      if (p.shape === 'square') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size / 2, 0, TAU);
        ctx.fill();
      }
    }

    function drawRing(ring) {
      var progress = ring.age / ring.life;
      var radius = 8 + (ring.maxRadius - 8) * progress;

      ctx.globalAlpha = clamp(1 - progress, 0, 1) * 0.85;
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = Math.max(0.5, 4 * (1 - progress));
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, radius, 0, TAU);
      ctx.stroke();
    }

    function drawSweep(sweep) {
      var progress = sweep.age / sweep.life;
      var band = Math.max(80, height * 0.3);
      var top = -band + progress * (height + band * 2);

      var gradient = ctx.createLinearGradient(0, top, 0, top + band);
      gradient.addColorStop(0, 'rgba(255, 250, 236, 0)');
      gradient.addColorStop(0.5, 'rgba(255, 250, 236, 0.16)');
      gradient.addColorStop(1, 'rgba(255, 250, 236, 0)');

      ctx.globalAlpha = 1;
      ctx.fillStyle = gradient;
      ctx.fillRect(0, top, width, band);
    }

    /* ---------- 特效入口 ---------- */

    /** 把粒子并进池子，超出上限丢最旧的 */
    function append(list) {
      if (!list || !list.length) return;

      for (var i = 0; i < list.length; i++) particles.push(list[i]);
      if (particles.length > MAX_PARTICLES) {
        particles.splice(0, particles.length - MAX_PARTICLES);
      }
      ensureLoop();
    }

    function burst(list) {
      if (reduceMotion) return;
      append(list);
    }

    function confetti(count) {
      if (reduceMotion) return;
      var n = Number(count);
      if (!(n > 0)) n = 120;
      append(planConfetti({ width: width, height: height, count: n }));
    }

    function dust(count) {
      if (reduceMotion) return;
      var n = Number(count);
      if (!(n > 0)) n = 40;
      append(planDust({ width: width, height: height, count: n }));
    }

    function ring(x, y, value) {
      if (reduceMotion) return;

      var v = Number(value) > 0 ? Number(value) : 2;
      rings.push({
        x: Number(x) || 0,
        y: Number(y) || 0,
        age: 0,
        life: 0.62,
        color: palette(v).main,
        maxRadius: clamp(64 + Math.round(log2(v)) * 9, 70, 210)
      });
      if (rings.length > 12) rings.splice(0, rings.length - 12);
      ensureLoop();
    }

    function sweep() {
      if (reduceMotion) return;

      sweeps.push({ age: 0, life: 0.78 });
      if (sweeps.length > 3) sweeps.splice(0, sweeps.length - 3);
      ensureLoop();
    }

    /**
     * 震屏：给 .app 加一个短暂动画，强度写进 --shake。
     * @param {number} intensity 0.1~1，1 约等于 7px 位移
     */
    function shake(intensity) {
      if (reduceMotion || !doc) return;

      var app = doc.querySelector('.app');
      if (!app) return;

      var amount = clamp(Number(intensity) || 0.4, 0.1, 1);
      app.style.setProperty('--shake', String(amount));

      // 连击时上一次动画可能还没结束，先摘再挂才会重播
      app.classList.remove('is-shaking');
      void app.offsetWidth;
      app.classList.add('is-shaking');

      shakeEl = app;
      if (shakeTimer !== null) win.clearTimeout(shakeTimer);
      shakeTimer = win.setTimeout(function () {
        shakeTimer = null;
        if (shakeEl) shakeEl.classList.remove('is-shaking');
        shakeEl = null;
      }, 380);
    }

    /** 停循环并清空所有特效（换局或关页面时用） */
    function stop() {
      pause();
      particles = [];
      rings = [];
      sweeps = [];

      if (shakeTimer !== null && win) win.clearTimeout(shakeTimer);
      shakeTimer = null;
      if (shakeEl) shakeEl.classList.remove('is-shaking');
      shakeEl = null;

      if (ctx) ctx.clearRect(0, 0, width, height);
    }

    function stats() {
      return {
        particles: particles.length,
        rings: rings.length,
        sweeps: sweeps.length,
        running: running,
        reduceMotion: reduceMotion
      };
    }

    /* ---------- 自适应与可见性 ---------- */

    if (canvas && ctx) {
      resize();

      if (win) {
        win.addEventListener('resize', resize);
        doc.addEventListener('visibilitychange', function () {
          if (doc.hidden) {
            pause();
            return;
          }
          resize();   // 后台期间视口可能变了（旋转/分屏），先对齐再继续
          if (particles.length || rings.length || sweeps.length) ensureLoop();
        });
      }
    }

    return {
      burst: burst,
      confetti: confetti,
      dust: dust,
      ring: ring,
      sweep: sweep,
      shake: shake,
      resize: resize,
      stop: stop,
      stats: stats
    };
  }

  return {
    MAX_PARTICLES: MAX_PARTICLES,
    palette: palette,
    planBurst: planBurst,
    planConfetti: planConfetti,
    planDust: planDust,
    create: create
  };
});
