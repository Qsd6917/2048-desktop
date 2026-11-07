/**
 * 四模块联动端到端回归（真实 Chrome + CDP，零第三方依赖，进仓库可复跑）。
 *
 * 覆盖 appraisal 里跨模块才能验证的几条：
 *   1. 同一天两次开局完全一致（每日挑战的种子确定性，含坐标）；
 *   2. 走几步后刷新，分数 / 步数 / 盘面 / 每日条 / 复盘日志全部续上；
 *   3. 成就面板的卡片数、顶部计数格式、Esc 关闭与焦点归还；
 *   4. 没打每日时复盘的「空状态 + 去挑战」；
 *   5. #fx 铺满视口且不吃指针事件；
 *   6. 一步合并同时打穿四个模块（成就 merges、粒子、复盘日志、每日条）；
 *   7. 老玩家首次装到带成就的版本时，档案用历史战绩播种（且不覆盖已有档案）；
 *   8. undoUsed 随局面落盘，刷新后不会把「用过撤销」忘掉；
 *   9. 320px 窄屏不横向溢出/不重叠、1280×800 棋盘不被裁切、抽屉内可滚动。
 *
 * 启动方式刻意与 test/app.e2e.js 保持一致（复制而非 import）：两个套件互不依赖，
 * 任何一个改动都不会把另一个带崩。
 *
 * 用法：node test/features.e2e.js [--allow-skip]
 * 需要本机有 Chrome（或 Edge），可用 CHROME_PATH 指定。
 * 找不到浏览器（或 Node 版本不够）时默认**以非零码退出**：CI 上宁可红，
 * 也不能出现「通过但一条断言都没跑」。确实需要在无浏览器机器上跳过时，
 * 显式加 --allow-skip，输出会写明这一轮没有覆盖任何用例。
 */
'use strict';

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ALLOW_SKIP = process.argv.indexOf('--allow-skip') >= 0;

const PAGE = 'file:///' + path.join(__dirname, '..', 'index.html').replace(/\\/g, '/');
const PORT = 9500 + (process.pid % 200);
const USER_DIR = path.join(os.tmpdir(), 'e2e-2048-features-' + Date.now());

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

/** 右列三块：左移必能走，撤销后盘面回到这一份，再左移仍能走 */
const BOARD_RIGHT_COL = [
  [0, 0, 0, 2],
  [0, 0, 0, 4],
  [0, 0, 0, 8],
  [0, 0, 0, 0]
];

/** 一步左移就合并出 4：用来同时触发粒子、成就 merges 与复盘记录 */
const BOARD_MERGE_PAIR = [
  [2, 2, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0]
];

const SIG = `(function () {
  return Array.prototype.slice.call(document.querySelectorAll('#tileLayer .tile'))
    .map(function (el) {
      return el.style.getPropertyValue('--x') + ',' + el.style.getPropertyValue('--y') + '=' +
        (el.classList.contains('tile--obstacle') ? 'OBS' : el.textContent.trim());
    }).sort().join('|');
})()`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  PASS ' + name + (detail ? '  [' + detail + ']' : ''));
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? '  [' + detail + ']' : ''));
  }
}

function findChrome() {
  for (let i = 0; i < CHROME_CANDIDATES.length; i++) {
    const p = CHROME_CANDIDATES[i];
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 跳过：默认算失败。
 * @param {string} reason 为什么跳过
 */
function skip(reason) {
  console.log('SKIP 四模块联动回归：' + reason);
  if (ALLOW_SKIP) {
    console.log('（--allow-skip 已开启，按通过处理 —— 注意这一轮一条断言都没跑）');
    return;
  }
  console.log('（默认把 SKIP 视为失败，避免 CI 上「绿着但没测」；确需跳过请显式加 --allow-skip）');
  process.exitCode = 3;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    skip('本机没有找到 Chrome / Edge（可设 CHROME_PATH 指定）');
    return;
  }
  if (typeof WebSocket !== 'function') {
    skip('当前 Node 没有全局 WebSocket（需 Node 22+）');
    return;
  }

  fs.mkdirSync(USER_DIR, { recursive: true });

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + USER_DIR,
    PAGE
  ], { stdio: 'ignore' });

  // 浏览器句柄的生命周期收进 try/finally：任何退出路径（包括 eval 抛异常中断）
  // 都必须杀掉无头 Chrome，不留孤儿进程。
  try {

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await wait(150);
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (e) {
      /* 浏览器还没起来 */
    }
  }
  if (!target) throw new Error('浏览器没起来（端口 ' + PORT + '）');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  const errors = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push('exception: ' + ((d.exception && d.exception.description) || d.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('console: ' + msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  function send(method, params) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: PAGE });

  async function evalJs(expression) {
    const r = await send('Runtime.evaluate', {
      expression: expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    }
    return r.result.value;
  }

  const press = (key) => evalJs(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })), 1`
  );
  const click = (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)}).click(), 1`);
  const text = (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)}).textContent`);
  const hidden = (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)}).hidden`);
  const sig = () => evalJs(SIG);

  /** 存档里的局面（含每日身份、复盘日志、入账标记） */
  async function savedState() {
    return JSON.parse(await evalJs(
      'JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.state, null))'
    ));
  }

  /** 成就档案 */
  async function savedProfile() {
    return JSON.parse(await evalJs(
      'JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.profile, null))'
    ));
  }

  /** 本局已走步数，以落盘局面为准（刷新后状态栏不再显示「已走 N 步」） */
  async function stateMoves() {
    const data = await savedState();
    return data && typeof data.moves === 'number' ? data.moves : 0;
  }

  async function reload() {
    await send('Page.reload', { ignoreCache: true });
    for (let i = 0; i < 60; i++) {
      await wait(100);
      try {
        const ok = await evalJs(
          'document.readyState === "complete" && typeof Game2048Storage === "object" && ' +
          'document.querySelectorAll("#tileLayer .tile").length > 0'
        );
        if (ok) return;
      } catch (e) {
        /* 上下文正在重建 */
      }
    }
    throw new Error('页面重载后没有就绪');
  }

  /** 清空所有本地数据并重载：回到「全新安装」的状态 */
  async function wipe() {
    await evalJs('(function () { try { localStorage.clear(); } catch (e) {} return 1; })()');
    await reload();
  }

  /** 注入一份存档（含设置）后重载；patch 里的字段覆盖默认盘面 */
  async function inject(patch) {
    const payload = Object.assign({
      version: 2, size: 4, mode: 'classic',
      values: BOARD_RIGHT_COL,
      score: 0, won: false, keepPlaying: false,
      remainingMs: 0, obstaclesAdded: 0, moves: 0
    }, patch || {});

    await evalJs(`(function () {
      var s = ${JSON.stringify(payload)};
      Game2048Storage.set(Game2048Storage.KEYS.settings, {
        size: s.size, mode: s.mode, sound: false
      });
      Game2048Storage.set(Game2048Storage.KEYS.state, s);
      return 1;
    })()`);
    await reload();
  }

  /** 一直按键直到走满 target 步（方向推不动就会自动换下一个方向） */
  async function playMoves(target) {
    const dirs = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];

    for (let guard = 0; guard < 12; guard++) {
      if ((await stateMoves()) >= target) return;
      await press(dirs[guard % dirs.length]);
      await wait(450);
    }
  }

  /** #fx 上不透明的像素数量：不为 0 就说明画布真的画出了粒子 */
  const fxPixels = () => evalJs(`(function () {
    var canvas = document.getElementById('fx');
    var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx || !canvas.width) return 0;
    var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    var total = 0;
    for (var i = 3; i < data.length; i += 4) if (data[i] > 0) total++;
    return total;
  })()`);

  await wait(500);

  /* ---------- T1 同一天两次开局完全一致 ---------- */
  console.log('\n[T1] 同日确定性：两次开局完全相同');

  await wipe();
  await click('#dailyChallenge');
  await wait(600);
  const firstSig = await sig();
  const firstCount = await evalJs('document.querySelectorAll("#tileLayer .tile").length');
  const firstMeta = await text('#dailyMeta');

  await wipe();
  await click('#dailyChallenge');
  await wait(600);
  const secondSig = await sig();
  const secondCount = await evalJs('document.querySelectorAll("#tileLayer .tile").length');

  check('两次开局都是两个方块', firstCount === 2 && secondCount === 2,
    firstCount + ' / ' + secondCount);
  check('两次开局的坐标与数值完全一致', firstSig.length > 0 && firstSig === secondSig,
    firstSig + ' vs ' + secondSig);
  check('每日条显示「第 1 次」', /第 1 次/.test(firstMeta), firstMeta);

  /* ---------- T2 走 3 步后刷新续玩 ---------- */
  console.log('\n[T2] 刷新续玩：分数 / 步数 / 盘面 / 每日条 / 复盘日志');

  await playMoves(3);
  const beforeMoves = await stateMoves();
  const beforeScore = await text('#score');
  const beforeSig = await sig();
  const beforeMeta = await text('#dailyMeta');
  const beforeState = await savedState();
  const beforeLog = beforeState && beforeState.reviewLog
    ? beforeState.reviewLog.moves.length
    : -1;

  check('确实走了 3 步', beforeMoves === 3, String(beforeMoves));
  check('复盘日志与步数一致', beforeLog === beforeMoves, beforeLog + ' / ' + beforeMoves);

  await reload();

  const afterState = await savedState();
  const afterLog = afterState && afterState.reviewLog
    ? afterState.reviewLog.moves.length
    : -1;

  check('刷新后分数不变', (await text('#score')) === beforeScore,
    beforeScore + ' -> ' + (await text('#score')));
  check('刷新后步数不变', afterState && afterState.moves === beforeMoves,
    beforeMoves + ' -> ' + (afterState && afterState.moves));
  check('刷新后盘面完全一致', (await sig()) === beforeSig);
  check('刷新后每日条仍是「第 1 次」', /第 1 次/.test(await text('#dailyMeta')),
    await text('#dailyMeta'));
  check('刷新后每日条按钮变成「重新开始」', (await text('#dailyStart')) === '重新开始',
    await text('#dailyStart'));
  check('刷新后复盘日志步数不变', afterLog === beforeLog, beforeLog + ' -> ' + afterLog);
  check('刷新后复盘日志仍属于今天',
    Boolean(afterState) && afterState.daily === (await evalJs('Game2048Rng.dateKey(new Date())')),
    afterState && afterState.daily);

  /* ---------- T3 成就面板 ---------- */
  console.log('\n[T3] 成就面板：卡片数、计数格式、Esc 与焦点');

  const profileBefore = await savedProfile();
  const unlockedBefore = profileBefore ? Object.keys(profileBefore.unlocked).length : 0;

  await evalJs('document.getElementById("achOpen").focus(), 1');
  await click('#achOpen');
  await wait(220);

  check('成就面板已打开', (await hidden('#achSheet')) === false);
  check('面板里 25 张卡片',
    (await evalJs('document.querySelectorAll("#achBody .ach-card").length')) === 25);

  const summaryCount = await text('#achBody .ach-summary__count');
  check('顶部计数格式「已解锁 x / 25」',
    summaryCount === '已解锁 ' + unlockedBefore + ' / 25', summaryCount);
  check('入口按钮计数与档案一致',
    (await text('#achOpen')) === '成就 ' + unlockedBefore + '/25', await text('#achOpen'));

  await press('Escape');
  await wait(150);
  check('Esc 关闭成就面板', (await hidden('#achSheet')) === true);
  check('关闭后焦点回到成就入口',
    (await evalJs('document.activeElement && document.activeElement.id')) === 'achOpen',
    await evalJs('document.activeElement && document.activeElement.id'));

  /* ---------- T4 复盘空状态 ---------- */
  console.log('\n[T4] 未打每日时的复盘空状态');

  await wipe();
  await click('#reviewOpen');
  await wait(220);

  const emptyText = (await text('#reviewBody')) || '';
  check('空状态文案出现', emptyText.indexOf('今天还没打每日挑战') >= 0, emptyText.slice(0, 60));
  check('空状态带「去挑战」按钮', (await text('#reviewGoDaily')) === '去挑战',
    await text('#reviewGoDaily'));

  await click('#reviewGoDaily');
  await wait(500);
  check('点「去挑战」后抽屉关闭', (await hidden('#reviewSheet')) === true);
  check('点「去挑战」后进入每日挑战', /第 1 次/.test(await text('#dailyMeta')),
    await text('#dailyMeta'));

  /* ---------- T5 整屏粒子层 ---------- */
  console.log('\n[T5] 整屏粒子层');

  const fxBox = JSON.parse(await evalJs(`(function () {
    var canvas = document.getElementById('fx');
    if (!canvas) return JSON.stringify({ missing: true });
    var rect = canvas.getBoundingClientRect();
    var style = getComputedStyle(canvas);
    return JSON.stringify({
      tag: canvas.tagName,
      position: style.position,
      pointerEvents: style.pointerEvents,
      width: rect.width,
      height: rect.height,
      viewWidth: window.innerWidth,
      viewHeight: window.innerHeight
    });
  })()`));

  check('#fx 是 fixed 的 canvas',
    fxBox.tag === 'CANVAS' && fxBox.position === 'fixed',
    fxBox.tag + ' / ' + fxBox.position);
  check('#fx 铺满视口',
    Math.abs(fxBox.width - fxBox.viewWidth) <= 1 &&
      Math.abs(fxBox.height - fxBox.viewHeight) <= 1,
    fxBox.width + '×' + fxBox.height + ' / 视口 ' + fxBox.viewWidth + '×' + fxBox.viewHeight);
  check('#fx 不吃指针事件', fxBox.pointerEvents === 'none', fxBox.pointerEvents);

  /* ---------- T6 四模块联动冒烟 ---------- */
  console.log('\n[T6] 四模块联动：一步合并打穿四个模块');

  await wipe();
  await click('#dailyChallenge');
  await wait(400);
  const todayKey = await evalJs('Game2048Rng.dateKey(new Date())');
  await inject({ daily: todayKey, values: BOARD_MERGE_PAIR });

  const mergesBefore = (await savedProfile()).stats.merges;

  await press('ArrowLeft');
  await wait(200);                 // 合并特效排在滑行 110ms 之后
  const pixelCount = await fxPixels();
  await wait(450);

  const smokeState = await savedState();
  const smokeProfile = await savedProfile();

  check('盘面合出了 4', (await sig()).indexOf('=4') >= 0, await sig());
  check('成就记下合并组数', smokeProfile.stats.merges === mergesBefore + 1,
    mergesBefore + ' -> ' + smokeProfile.stats.merges);
  check('合并后粒子层真的有像素', pixelCount > 0, 'alpha px=' + pixelCount);
  check('复盘日志记下这一步',
    Boolean(smokeState && smokeState.reviewLog) && smokeState.reviewLog.moves.length === 1,
    smokeState && smokeState.reviewLog && String(smokeState.reviewLog.moves.length));
  check('每日条仍在「第 1 次」', /第 1 次/.test(await text('#dailyMeta')),
    await text('#dailyMeta'));

  /* ---------- T7 老玩家档案播种 ---------- */
  console.log('\n[T7] 老玩家首次进入：档案用历史战绩播种');

  await wipe();
  await evalJs(`(function () {
    Game2048Storage.set(Game2048Storage.KEYS.stats, {
      games: 12, bestScore: 32000, bestTile: 2048, totalMoves: 900,
      bySize: { '4': { games: 11, bestScore: 32000 }, '6': { games: 1, bestScore: 0 } }
    });
    Game2048Storage.remove(Game2048Storage.KEYS.profile);
    return 1;
  })()`);
  await reload();

  const seeded = await savedProfile();
  const seededIds = seeded ? Object.keys(seeded.unlocked) : [];

  check('档案已按历史最高分播种', Boolean(seeded) && seeded.stats.bestScore === 32000,
    seeded && String(seeded.stats.bestScore));
  check('档案已按历史最大块播种', Boolean(seeded) && seeded.stats.bestTile === 2048,
    seeded && String(seeded.stats.bestTile));
  check('只播下真正得过分数的尺寸',
    Boolean(seeded) && seeded.stats.sizes['4'] === 1 && seeded.stats.sizes['6'] === undefined,
    JSON.stringify(seeded && seeded.stats.sizes));
  check('两万分当场解锁', seededIds.indexOf('score_20k') >= 0, seededIds.join(','));
  check('2048 相关成就当场解锁',
    seededIds.indexOf('tile_2048') >= 0 && seededIds.indexOf('tile_128') >= 0,
    seededIds.join(','));
  check('没达成过的成就保持锁定', seededIds.indexOf('size_6') < 0, seededIds.join(','));
  check('入口计数按播种后的档案刷新',
    (await text('#achOpen')) === '成就 ' + seededIds.length + '/25', await text('#achOpen'));

  await evalJs(`Game2048Storage.set(Game2048Storage.KEYS.profile, {
    version: 1, stats: { bestScore: 100, games: 2 }, unlocked: {}
  }), 1`);
  await reload();

  const kept = await savedProfile();
  check('已有档案不会被播种覆盖',
    Boolean(kept) && kept.stats.bestScore === 100 && Object.keys(kept.unlocked).length === 0,
    JSON.stringify(kept && kept.stats));

  /* ---------- T8 undoUsed 随局面落盘 ---------- */
  console.log('\n[T8] undoUsed 落盘：刷新后不把「用过撤销」忘掉');

  await wipe();
  await inject({ values: BOARD_RIGHT_COL });   // inject 内部已经重载

  await press('ArrowLeft');
  await wait(500);
  await evalJs(
    'document.dispatchEvent(new KeyboardEvent("keydown", ' +
    '{ key: "z", ctrlKey: true, bubbles: true })), 1'
  );
  await wait(450);

  const afterUndo = await savedState();
  check('撤销之后标记已写进存档',
    Boolean(afterUndo) && afterUndo.undoUsed === true,
    JSON.stringify(afterUndo && { undoUsed: afterUndo.undoUsed, moves: afterUndo.moves }));

  await reload();
  await press('ArrowLeft');
  await wait(500);

  const afterReload = await savedState();
  check('刷新后再存档仍带着撤销标记',
    Boolean(afterReload) && afterReload.undoUsed === true,
    JSON.stringify(afterReload && { undoUsed: afterReload.undoUsed, moves: afterReload.moves }));

  await wipe();
  await inject({ values: BOARD_RIGHT_COL });   // 老存档：没有 undoUsed 字段
  await press('ArrowLeft');
  await wait(500);

  const legacy = await savedState();
  check('老存档缺字段按未撤销处理',
    Boolean(legacy) && legacy.undoUsed === false,
    JSON.stringify(legacy && { undoUsed: legacy.undoUsed }));

  /* ---------- T9 窄屏 / 宽屏布局 ---------- */
  console.log('\n[T9] 320px 窄屏与 1280×800 布局');

  await send('Emulation.setDeviceMetricsOverride', {
    width: 320, height: 568, deviceScaleFactor: 1, mobile: false
  });
  await wait(400);

  const narrow = JSON.parse(await evalJs(`(function () {
    function box(el) {
      var r = el.getBoundingClientRect();
      return {
        left: r.left, right: r.right, width: r.width,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth
      };
    }
    var app = box(document.getElementById('app'));
    // 两排按钮分开收集：跨排比较会拿上一排的右缘和下一排的左缘比，必然「重叠」
    var rows = [];
    ['#extras .btn', '.controls--sub .btn'].forEach(function (selector) {
      var row = [];
      Array.prototype.forEach.call(document.querySelectorAll(selector), function (btn) {
        row.push({ id: btn.id, box: box(btn) });
      });
      rows.push(row);
    });
    var daily = box(document.getElementById('dailyBar'));
    var kids = [];
    Array.prototype.forEach.call(document.querySelectorAll('#dailyBar > *'), function (kid) {
      kids.push({ cls: kid.className || kid.id, box: box(kid) });
    });
    var board = box(document.getElementById('board'));
    return JSON.stringify({
      app: app, rows: rows, daily: daily, kids: kids, board: board,
      docWidth: document.documentElement.scrollWidth,
      viewWidth: window.innerWidth
    });
  })()`));

  const clipped = [];
  narrow.rows.forEach((row) => {
    row.forEach((item) => {
      if (item.box.scrollWidth > item.box.clientWidth + 1) clipped.push(item.id);
    });
  });
  check('320px 下按钮文字不被截断', clipped.length === 0,
    clipped.join(',') || 'ok');
  check('320px 下没有横向溢出',
    narrow.docWidth <= narrow.viewWidth,
    narrow.docWidth + ' <= ' + narrow.viewWidth);

  let overlap = null;
  narrow.rows.forEach((row) => {
    for (let i = 1; i < row.length; i++) {
      if (row[i - 1].box.right > row[i].box.left + 0.5) {
        overlap = row[i - 1].id + '/' + row[i].id;
      }
    }
  });
  check('320px 下控制条按钮不重叠', overlap === null, overlap || 'ok');
  check('320px 下每日条不溢出',
    narrow.kids.every((kid) => kid.box.right <= narrow.daily.right + 0.5),
    narrow.kids.map((kid) => kid.cls).join(','));
  check('320px 下棋盘与容器同宽',
    Math.abs(narrow.board.width - narrow.app.width) <= 1,
    narrow.board.width + ' vs ' + narrow.app.width);

  await click('#achOpen');
  await wait(260);

  const sheetBox = JSON.parse(await evalJs(`(function () {
    var panel = document.querySelector('#achSheet .sheet__panel');
    var body = document.getElementById('achBody');
    var r = panel.getBoundingClientRect();
    var style = getComputedStyle(body);
    return JSON.stringify({
      left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      overflowY: style.overflowY,
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      viewWidth: window.innerWidth, viewHeight: window.innerHeight
    });
  })()`));

  check('320px 下成就抽屉完整落在视口里',
    sheetBox.left >= 0 && sheetBox.right <= sheetBox.viewWidth + 0.5 &&
      sheetBox.top >= 0 && sheetBox.bottom <= sheetBox.viewHeight + 0.5,
    Math.round(sheetBox.left) + ',' + Math.round(sheetBox.top) + ' -> ' +
      Math.round(sheetBox.right) + ',' + Math.round(sheetBox.bottom));
  check('320px 下抽屉正文可滚动',
    sheetBox.overflowY === 'auto' && sheetBox.scrollHeight > sheetBox.clientHeight,
    sheetBox.overflowY + ' ' + sheetBox.scrollHeight + '/' + sheetBox.clientHeight);

  await press('Escape');
  await wait(200);

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false
  });
  await wait(400);

  const wide = JSON.parse(await evalJs(`(function () {
    var board = document.getElementById('board').getBoundingClientRect();
    var app = document.getElementById('app').getBoundingClientRect();
    return JSON.stringify({
      top: board.top, bottom: board.bottom, width: board.width,
      appWidth: app.width,
      viewHeight: window.innerHeight,
      docWidth: document.documentElement.scrollWidth,
      viewWidth: window.innerWidth
    });
  })()`));

  check('1280×800 下棋盘完整可见',
    wide.top >= 0 && wide.bottom <= wide.viewHeight + 0.5,
    Math.round(wide.top) + ' -> ' + Math.round(wide.bottom) + ' / vh ' + wide.viewHeight);
  check('1280×800 下棋盘没有被放大到超出容器',
    wide.width <= wide.appWidth + 1 && wide.width <= 500.5,
    wide.width + ' / app ' + wide.appWidth);
  check('1280×800 下没有横向溢出', wide.docWidth <= wide.viewWidth,
    wide.docWidth + ' <= ' + wide.viewWidth);

  await send('Emulation.clearDeviceMetricsOverride');
  await wait(200);

  /* ---------- T10 控制台 ---------- */
  console.log('\n[T10] 控制台');
  check('无异常/报错', errors.length === 0, errors.join(' ; ').slice(0, 400));

  console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
  ws.close();
  } finally {
    chrome.kill();
    await wait(300);
    try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E 失败：', err);
  process.exit(2);
});
