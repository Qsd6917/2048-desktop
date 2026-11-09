/**
 * 控制器端到端回归（真实 Chrome + CDP，零第三方依赖，进仓库可复跑）。
 *
 * 覆盖 Task 4 返工修复的三条：
 *   1. 动画期间的按键不再被静默丢弃（1 格 pendingDir 缓冲；真走一步才关托管）；
 *   2. 「继续挑战」之后的第二次结算按增量补记统计（games 不重复加）；
 *   3. goalValue() 不再用 WIN_VALUE 兜底（4/5/6 各自 2048/4096/8192）。
 *
 * 用法：node test/app.e2e.js [--allow-skip]
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
const PORT = 9300 + (process.pid % 200);
const USER_DIR = path.join(os.tmpdir(), 'e2e-2048-app-' + Date.now());

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

/** 右列三块：按左之后必能再按右（左把方块压到 col0，右一定推得动） */
const BOARD_RIGHT_COL = [
  [0, 0, 0, 2],
  [0, 0, 0, 4],
  [0, 0, 0, 0],
  [0, 0, 0, 8]
];

/** 一步左移就合并出 2048（4×4 的目标），先赢再「继续挑战」 */
const BOARD_WIN_IN_ONE = [
  [1024, 1024, 0, 0],
  [2, 4, 0, 0],
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
  console.log('SKIP 端到端回归：' + reason);
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
  const stats = async () => JSON.parse(await evalJs('JSON.stringify(Game2048Storage.loadStats())'));
  const overlayHidden = () => evalJs('document.getElementById("overlay").hidden');
  const autoplayOn = async () =>
    (await evalJs('document.getElementById("autoplay").getAttribute("aria-pressed")')) === 'true';

  /** 状态栏里的「已走 N 步」；没走到那一步时为 null */
  async function statusMoves() {
    const m = /已走 (\d+) 步/.exec((await text('#status')) || '');
    return m ? Number(m[1]) : null;
  }

  /**
   * 等状态行命中正则。
   * 战报下载要等 canvas.toBlob 的异步回调，固定 sleep 在慢机上会踩线；
   * 这里每 50ms 轮询一次，最多等 2s，超时返回最后一帧（由断言决定红绿）。
   *
   * @param {RegExp} pattern 期望的状态行
   * @param {string} [before] 点击前的状态行；命中这条旧文案就继续等，
   *        否则会读到上一条「战报已保存」，把没更新的那次当成成功
   * @param {number} [timeoutMs] 超时上限，默认 2000
   * @returns {Promise<string>} 最后一次读到的状态行
   */
  async function waitStatus(pattern, before, timeoutMs) {
    const limit = typeof timeoutMs === 'number' ? timeoutMs : 2000;
    const stale = before === undefined ? '' : String(before);
    const deadline = Date.now() + limit;
    let last = '';
    while (Date.now() < deadline) {
      last = (await text('#status')) || '';
      if (last !== stale && pattern.test(last)) return last;
      await wait(50);
    }
    return last;
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

  /**
   * 注入一份存档（含设置），重载后从这份盘面继续。
   * extra 用来补双人的 players / turn 等字段；不传时与原行为一致。
   *
   * @param {number[][]} values 盘面
   * @param {string} mode 模式
   * @param {object} [extra] 追加到存档对象上的字段
   */
  async function loadBoard(values, mode, extra) {
    const state = Object.assign({
      version: 2, size: 4, mode: mode,
      values: values,
      score: 0, won: false, keepPlaying: false,
      remainingMs: mode === 'timed' ? 180000 : 0,
      obstaclesAdded: 0, moves: 0
    }, extra || {});

    await evalJs(`(function () {
      Game2048Storage.set(Game2048Storage.KEYS.settings, { size: 4, mode: ${JSON.stringify(mode)}, sound: false });
      Game2048Storage.set(Game2048Storage.KEYS.state, ${JSON.stringify(state)});
      return 1;
    })()`);
    await reload();
  }

  /**
   * 在固定随机源下跑一段用例：Math.random 恒为 0，落子必为 2。
   * try/finally 保证断言抛错也会还原，不把假随机留给后面的小节。
   *
   * @param {Function} fn 用例主体（async）
   */
  async function withFixedRandom(fn) {
    await evalJs('window.__realRandomBackup = Math.random, Math.random = function () { return 0; }, 1');
    try {
      return await fn();
    } finally {
      await evalJs('Math.random = window.__realRandomBackup, delete window.__realRandomBackup, 1');
    }
  }

  /**
   * 在加速时钟下跑一段用例：Date.now 变成「基准 + 真实流逝 × 倍率」。
   * 计时器只在这个窗口内被催快，窗口之外一律用真实时间。
   *
   * @param {Function} fn 用例主体（async）
   * @param {number} [speed] 加速倍率，默认 300
   */
  async function withFakeClock(fn, speed) {
    const rate = typeof speed === 'number' ? speed : 300;
    await evalJs(`(function () {
      window.__realNowBackup = Date.now.bind(Date);
      var t0 = window.__realNowBackup();
      Date.now = function () { return t0 + (window.__realNowBackup() - t0) * ${rate}; };
      return 1;
    })()`);
    try {
      return await fn();
    } finally {
      await evalJs('Date.now = window.__realNowBackup, delete window.__realNowBackup, 1');
    }
  }

  await wait(500);

  /* ---------- T1 动画期间连打，输入不丢 ---------- */
  console.log('\n[T1] 动画期间连打按键');

  await loadBoard(BOARD_RIGHT_COL, 'classic');
  check('注入盘面已还原', (await evalJs(SIG)).indexOf('=1024') < 0 && (await evalJs(SIG)).indexOf('=8') >= 0, await evalJs(SIG));

  await press('ArrowLeft');
  await wait(30);            // 第一步正在播动画（约 285ms）
  await press('ArrowRight'); // 会被缓冲，动画结束立刻兑现
  await wait(900);
  check('两下连打走了两步', (await statusMoves()) === 2, '已走 ' + (await statusMoves()) + ' 步');

  await loadBoard(BOARD_RIGHT_COL, 'classic');
  await press('ArrowLeft');
  await wait(250);           // 动画末尾（约 285ms）再按
  await press('ArrowRight');
  await wait(900);
  check('动画末尾的按键也不丢', (await statusMoves()) === 2, '已走 ' + (await statusMoves()) + ' 步');

  /* ---------- T2 动画期按键 + 托管 ---------- */
  console.log('\n[T2] 动画期按键与托管');

  await loadBoard(BOARD_RIGHT_COL, 'classic');
  await press('ArrowLeft');   // 手动第一步，开始播动画
  await wait(40);
  await click('#autoplay');   // 动画里打开托管
  await wait(40);
  await press('ArrowRight');  // 这一下被缓冲；旧实现会「既不走子又关托管」
  await wait(900);
  check('缓冲的这一步真的走了（没有被吞）', (await statusMoves()) === 2, '已走 ' + (await statusMoves()) + ' 步');
  check('走子落地后托管关闭', (await autoplayOn()) === false,
    'aria-pressed=' + (await evalJs('document.getElementById("autoplay").getAttribute("aria-pressed")')));

  const frozen = await evalJs(SIG);
  await wait(900);
  check('托管关闭后没有幽灵回调继续走子', (await evalJs(SIG)) === frozen);

  /* ---------- T3 继续挑战后的第二次结算 ---------- */
  console.log('\n[T3] 继续挑战后的结算入账');

  const before = await stats();
  await loadBoard(BOARD_WIN_IN_ONE, 'timed');
  await press('ArrowLeft');
  await wait(700);
  check('达成目标浮层出现', (await overlayHidden()) === false);
  check('胜利文案', (await text('#overlayTitle')) === '达成目标', await text('#overlayTitle'));

  const afterWin = await stats();
  check('胜利时记了一局', afterWin.games === before.games + 1, before.games + ' -> ' + afterWin.games);
  check('胜利时 totalMoves 记了 1', afterWin.totalMoves === before.totalMoves + 1, String(afterWin.totalMoves));
  check('胜利时 bestScore 记了 2048', afterWin.bestScore === Math.max(before.bestScore, 2048), String(afterWin.bestScore));

  await evalJs('document.querySelectorAll("#overlayActions button")[0].click(), 1');   // 继续挑战
  await wait(300);
  check('继续挑战后浮层关闭', (await overlayHidden()) === true);

  const dirs = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];
  for (let i = 0; i < dirs.length; i++) {
    await press(dirs[i]);
    await wait(420);
  }
  const movesPlayed = await statusMoves();
  check('继续挑战期间还能继续走子', typeof movesPlayed === 'number' && movesPlayed > 1, '已走 ' + movesPlayed + ' 步');

  // 把表跑完，制造同一局的第二次结算（旧实现会因 recorded 直接 return）
  await withFakeClock(async () => {
    await wait(1600);
  });

  check('时间到浮层出现', (await text('#overlayTitle')) === '时间到', await text('#overlayTitle'));

  const summary = (await text('#overlayText')) || '';
  const scoreMatch = /本局 (\d+) 分/.exec(summary);
  const movesMatch = /走了 (\d+) 步/.exec(summary);
  check('结算文案里有分数与步数', Boolean(scoreMatch && movesMatch), summary);

  const finalScore = scoreMatch ? Number(scoreMatch[1]) : -1;
  const finalMoves = movesMatch ? Number(movesMatch[1]) : -1;
  const afterEnd = await stats();

  check('继续挑战期间压死的局也只算一局', afterEnd.games === before.games + 1, before.games + ' -> ' + afterEnd.games);
  check('totalMoves 不漏记继续挑战的步数',
    afterEnd.totalMoves === before.totalMoves + finalMoves,
    before.totalMoves + ' + ' + finalMoves + ' -> ' + afterEnd.totalMoves);
  check('bestScore 取到最终分数', afterEnd.bestScore === Math.max(before.bestScore, finalScore),
    finalScore + ' / best=' + afterEnd.bestScore);
  check('bySize 的局数也只加一次', (afterEnd.bySize['4'] ? afterEnd.bySize['4'].games : 0) ===
    ((before.bySize['4'] ? before.bySize['4'].games : 0) + 1));

  /* ---------- T4 刷新后「最高」不倒退 ---------- */
  console.log('\n[T4] 刷新后的顶栏最高分');
  await reload();
  const bestText = Number(await text('#best'));
  check('刷新后「最高」等于入账的 bestScore', bestText === afterEnd.bestScore,
    bestText + ' vs ' + afterEnd.bestScore);
  check('刷新后「最高」不低于本局最终分', bestText >= finalScore, bestText + ' >= ' + finalScore);

  /* ---------- T5 入账幂等跨刷新 ---------- */
  /* 「达成目标 → 继续挑战 → 关页 → 重开 → 再结算」只能算一局、步数不能重复计 */
  console.log('\n[T5] 达成目标后刷新再结算，统计不重复');

  const beforeIdem = await stats();
  await loadBoard(BOARD_WIN_IN_ONE, 'timed');
  await press('ArrowLeft');
  await wait(700);
  const idemWin = await stats();
  check('这一局胜利记了一局', idemWin.games === beforeIdem.games + 1,
    beforeIdem.games + ' -> ' + idemWin.games);

  await evalJs('document.querySelectorAll("#overlayActions button")[0].click(), 1');   // 继续挑战
  await wait(300);
  await press('ArrowDown');
  await wait(600);

  const savedSnapshot = JSON.parse(await evalJs(
    'JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.state, null))'
  ));
  check('存档里带上了 recorded 标记', Boolean(savedSnapshot) && savedSnapshot.recorded === true,
    JSON.stringify(savedSnapshot && { recorded: savedSnapshot.recorded, moves: savedSnapshot.moves }));
  check('recordedMoves 停在达成目标时的步数（不再随局面归零）',
    Boolean(savedSnapshot) && savedSnapshot.recordedMoves === 1 && savedSnapshot.moves >= 1,
    JSON.stringify(savedSnapshot && { recordedMoves: savedSnapshot.recordedMoves, moves: savedSnapshot.moves }));

  await reload();   // 模拟「关页面再打开」

  check('刷新后仍从上一局继续（浮层未弹）', (await overlayHidden()) === true);

  await withFakeClock(async () => {
    await wait(1600);
  });

  check('刷新后超时能正常结算', (await text('#overlayTitle')) === '时间到', await text('#overlayTitle'));

  const idemSummary = (await text('#overlayText')) || '';
  const idemMoves = /走了 (\d+) 步/.exec(idemSummary);
  const idemFinalMoves = idemMoves ? Number(idemMoves[1]) : -1;
  const afterIdem = await stats();

  check('刷新后再结算，games 不再 +1', afterIdem.games === beforeIdem.games + 1,
    beforeIdem.games + ' -> ' + afterIdem.games);
  check('刷新后再结算，totalMoves 只补记增量',
    afterIdem.totalMoves === beforeIdem.totalMoves + idemFinalMoves,
    beforeIdem.totalMoves + ' + ' + idemFinalMoves + ' -> ' + afterIdem.totalMoves);

  /* ---------- T6 三尺寸目标值 / aria-label / 换尺寸关托管 ---------- */
  console.log('\n[T6] 三尺寸目标值与无障碍标签');
  await click('#modeGroup [data-mode="classic"]');
  await wait(400);

  const goals = [];
  const labels = [];
  const sizes = [4, 5, 6];
  for (let i = 0; i < sizes.length; i++) {
    await click('#sizeGroup [data-size="' + sizes[i] + '"]');
    await wait(400);
    goals.push(await text('#goal'));
    labels.push(await evalJs('document.getElementById("board").getAttribute("aria-label")'));
  }
  check('4/5/6 目标值 2048/4096/8192', goals.join('/') === '2048/4096/8192', goals.join('/'));
  check('aria-label 跟着尺寸走', labels.join('/') === '4×4 棋盘/5×5 棋盘/6×6 棋盘', labels.join('/'));

  await click('#autoplay');
  await wait(60);
  const autoplayBefore = await autoplayOn();
  await click('#sizeGroup [data-size="4"]');
  await wait(250);
  check('换尺寸时托管自动关闭', autoplayBefore === true && (await autoplayOn()) === false,
    '切换前 ' + autoplayBefore + ' / 切换后 ' + (await autoplayOn()));

  /* ---------- T7 存档覆盖设置后必须落盘 ---------- */
  console.log('\n[T7] 存档里的尺寸/模式要写回设置');

  await evalJs(`(function () {
    Game2048Storage.set(Game2048Storage.KEYS.settings, { size: 4, mode: 'classic', sound: false });
    var values = [];
    for (var r = 0; r < 6; r++) {
      var row = [];
      for (var c = 0; c < 6; c++) row.push(r === 0 && c === 0 ? 2 : 0);
      values.push(row);
    }
    Game2048Storage.set(Game2048Storage.KEYS.state, {
      version: 2, size: 6, mode: 'obstacle', values: values,
      score: 0, won: false, keepPlaying: false, remainingMs: 0, obstaclesAdded: 0, moves: 0
    });
    return 1;
  })()`);
  await reload();
  check('存档里的 6×6 被还原',
    (await text('#goal')) === '8192' &&
    (await evalJs('document.getElementById("board").getAttribute("aria-label")')) === '6×6 棋盘',
    await text('#goal'));

  const savedSettings = JSON.parse(await evalJs(
    'JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.settings, null))'
  ));
  check('存档覆盖后的设置已经落盘',
    Boolean(savedSettings) && savedSettings.size === 6 && savedSettings.mode === 'obstacle',
    JSON.stringify(savedSettings));

  await evalJs('Game2048Storage.remove(Game2048Storage.KEYS.state), 1');
  await reload();
  check('存档被移除后仍停在 6×6/障碍', (await text('#goal')) === '8192', await text('#goal'));

  /* ---------- T8 00:00 仍是紧急态 ---------- */
  console.log('\n[T8] 倒计时归零的样式');

  await loadBoard(BOARD_RIGHT_COL, 'timed');
  await withFakeClock(async () => {
    await wait(1400);
  }, 400);

  const timeUpTitle = await text('#overlayTitle');
  const clockText = await text('#timer');
  const clockUrgent = await evalJs('document.getElementById("timer").classList.contains("is-urgent")');
  check('时间到', timeUpTitle === '时间到', timeUpTitle);
  check('00:00 保留 is-urgent 紧急样式', clockText === '00:00' && clockUrgent === true,
    clockText + ' / urgent=' + clockUrgent);

  /* ---------- T9 全屏粒子层的运行时行为 ---------- */
  console.log('\n[T9] 全屏粒子层');

  const fxRect = JSON.parse(await evalJs(`(function () {
    var r = document.getElementById('fx').getBoundingClientRect();
    return JSON.stringify({
      w: r.width, h: r.height,
      iw: window.innerWidth, ih: window.innerHeight,
      pe: getComputedStyle(document.getElementById('fx')).pointerEvents
    });
  })()`));
  check('#fx 铺满视口', Math.abs(fxRect.w - fxRect.iw) <= 1 && Math.abs(fxRect.h - fxRect.ih) <= 1,
    fxRect.w + '×' + fxRect.h + ' / 视口 ' + fxRect.iw + '×' + fxRect.ih);
  check('#fx 不吃指针事件', fxRect.pe === 'none', fxRect.pe);

  // 自建一个离屏实例单独测上限/可见性，不动正式粒子层
  await evalJs(`window.__fxProbe = Game2048Fx.create({ canvas: document.createElement('canvas') }), 1`);

  const capStats = JSON.parse(await evalJs(`(function () {
    var burst = [];
    for (var i = 0; i < 40; i++) {
      burst = burst.concat(Game2048Fx.planBurst({ value: 2048, combo: 9, x: 100, y: 100 }));
    }
    // 6 批 × 46 个 ≈ 2700，远超 900 的上限
    for (var k = 0; k < 6; k++) window.__fxProbe.burst(burst);
    return JSON.stringify(window.__fxProbe.stats());
  })()`));
  check('粒子池上限 900（超出丢最旧）', capStats.particles === 900, 'particles=' + capStats.particles);

  const runningAtFirst = await evalJs(`(function () {
    window.__fxProbe.burst(Game2048Fx.planBurst({ value: 8, x: 10, y: 10 }));
    return window.__fxProbe.stats().running;
  })()`);
  check('有粒子时 rAF 在跑', runningAtFirst === true);

  // 伪造 hidden：直接改写 document.hidden 再派发真实事件，走的是与浏览器同一条处理路径
  await evalJs(`(function () {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: function () { return true; }
    });
    document.dispatchEvent(new Event('visibilitychange'));
    return 1;
  })()`);
  check('页面 hidden 后 rAF 停下', (await evalJs('window.__fxProbe.stats().running')) === false);

  await evalJs(`(function () {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    return 1;
  })()`);
  check('回到前台后 rAF 继续', (await evalJs('window.__fxProbe.stats().running')) === true);
  await evalJs('window.__fxProbe.stop(), 1');
  const stopped = JSON.parse(await evalJs('JSON.stringify(window.__fxProbe.stats())'));
  check('stop 之后循环与粒子都清空',
    stopped.particles === 0 && stopped.rings === 0 && stopped.sweeps === 0 && stopped.running === false,
    JSON.stringify(stopped));

  // 真实合并走一遍映射表第 2 行：≥256 要有环 + 震屏，音频要带 accent
  await loadBoard([
    [128, 128, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ], 'classic');

  /** 装上音阶探针：只记录调用参数，不关心是否真的发声 */
  const installTuningSpy = `(function () {
    window.__tuningCalls = [];
    var real = Game2048Tuning.mergeNotes;
    Game2048Tuning.mergeNotes = function (values, combo, opts) {
      window.__tuningCalls.push({
        values: values.slice(),
        combo: combo,
        accent: !!(opts && opts.accent === true)
      });
      return real(values, combo, opts);
    };
    Game2048Audio.setEnabled(true);   // loadBoard 为了安静把音效关了
    return 1;
  })()`;

  await evalJs(installTuningSpy);
  await press('ArrowLeft');
  await wait(150);
  check('合出 256', (await evalJs(SIG)).indexOf('=256') >= 0, await evalJs(SIG));
  check('≥256 触发震屏',
    (await evalJs('document.getElementById("app").classList.contains("is-shaking")')) === true);

  const calls256 = JSON.parse(await evalJs('JSON.stringify(window.__tuningCalls || [])'));
  check('≥256 的合并把 accent 传给了音阶层',
    calls256.length === 1 && calls256[0].accent === true && calls256[0].values.indexOf(256) >= 0,
    JSON.stringify(calls256));

  await wait(460);
  check('震屏自动收掉',
    (await evalJs('document.getElementById("app").classList.contains("is-shaking")')) === false);

  // 小合并不该带 accent
  await loadBoard([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ], 'classic');
  await evalJs(installTuningSpy);
  await press('ArrowLeft');
  await wait(150);
  const callsSmall = JSON.parse(await evalJs('JSON.stringify(window.__tuningCalls || [])'));
  check('小于 256 的合并不带 accent',
    callsSmall.length === 1 && callsSmall[0].accent === false,
    JSON.stringify(callsSmall));

  // 先建一个「未开启 reduce」的实例并真的撒出粒子：下一段验证运行中切换偏好
  const runtimeBefore = JSON.parse(await evalJs(`(function () {
    window.__fxLive = Game2048Fx.create({ canvas: document.createElement('canvas') });
    window.__fxLive.burst(Game2048Fx.planBurst({ value: 2048, x: 10, y: 10 }));
    return JSON.stringify(window.__fxLive.stats());
  })()`));
  check('切换偏好前粒子正常发射',
    runtimeBefore.particles > 0 && runtimeBefore.reduceMotion === false,
    JSON.stringify(runtimeBefore));

  // 强制「减少动态效果」：与 app.js 一样按 matchMedia 建实例，再触发 burst
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  });
  check('系统偏好已强制为 reduce',
    (await evalJs('matchMedia("(prefers-reduced-motion: reduce)").matches')) === true);

  await wait(120);
  const runtimeAfter = JSON.parse(await evalJs('JSON.stringify(window.__fxLive.stats())'));
  check('运行中切到 reduce：已在飞的粒子立刻清空',
    runtimeAfter.reduceMotion === true && runtimeAfter.particles === 0 && runtimeAfter.running === false,
    JSON.stringify(runtimeAfter));
  await evalJs('window.__fxLive.stop(), delete window.__fxLive, 1');

  const reducedStats = JSON.parse(await evalJs(`(function () {
    window.__fxProbe = Game2048Fx.create({
      canvas: document.createElement('canvas'),
      reduceMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
    });
    window.__fxProbe.burst(Game2048Fx.planBurst({ value: 2048, combo: 9, x: 10, y: 10 }));
    window.__fxProbe.confetti(120);
    window.__fxProbe.dust(40);
    window.__fxProbe.ring(10, 10, 256);
    window.__fxProbe.sweep();
    return JSON.stringify(window.__fxProbe.stats());
  })()`));
  check('reduce 下粒子/环/扫光恒为 0',
    reducedStats.particles + reducedStats.rings + reducedStats.sweeps === 0,
    JSON.stringify(reducedStats));
  check('reduce 下 rAF 不启动', reducedStats.running === false);
  await evalJs('window.__fxProbe.stop(), delete window.__fxProbe, 1');

  // reduce 下 renderer.playMove 只等 1ms：连按两下不该被 285ms 的 busy 卡住
  // 上一段的小合并走完再换盘：动画收尾时还会落一次盘，抢在它前面注入会被覆盖
  await wait(320);
  await loadBoard(BOARD_RIGHT_COL, 'classic');
  // 重载后重新下发一次偏好：媒体模拟属于页面级状态，别让 reload 时序决定这条用例的成败
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  });
  check('换盘后系统偏好仍是 reduce',
    (await evalJs('matchMedia("(prefers-reduced-motion: reduce)").matches')) === true);
  await press('ArrowLeft');
  await wait(30);
  await press('ArrowDown');
  await wait(200);
  check('reduce 下输入不再被动画等待锁住（200ms 内走完两步）',
    (await statusMoves()) >= 2, '已走 ' + (await statusMoves()) + ' 步');

  await send('Emulation.setEmulatedMedia', { features: [] });
  check('媒体模拟已撤销',
    (await evalJs('matchMedia("(prefers-reduced-motion: reduce)").matches')) === false);

  /* ---------- T11 成就系统 ---------- */
  console.log('\n[T11] 成就：计数、面板与提示条');

  // 档案与历史战绩一起清空：现在新档案会用 stats 播种，
  // 只删档案会按历史最高分补出一批已解锁成就，测不到「全新玩家」这一档。
  await evalJs(`(function () {
    Game2048Storage.remove(Game2048Storage.KEYS.profile);
    Game2048Storage.remove(Game2048Storage.KEYS.stats);
    return 1;
  })()`);
  await reload();
  check('清空档案后首次进入是 0/25', (await text('#achOpen')) === '成就 0/25',
    await text('#achOpen'));

  await loadBoard(BOARD_WIN_IN_ONE, 'timed');
  await press('ArrowLeft');
  await wait(700);

  const achProfile = JSON.parse(await evalJs(
    'JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.profile, null))'
  ));
  const unlockedIds = achProfile ? Object.keys(achProfile.unlocked) : [];
  check('成就档案已落盘', Boolean(achProfile) && achProfile.version === 1,
    JSON.stringify(achProfile && achProfile.stats));
  check('一局后 games 记了 1', Boolean(achProfile) && achProfile.stats.games === 1,
    achProfile && String(achProfile.stats.games));
  check('达成目标解锁 first_game', unlockedIds.indexOf('first_game') >= 0, unlockedIds.join(','));
  check('2048 解锁 tile_2048', unlockedIds.indexOf('tile_2048') >= 0, unlockedIds.join(','));
  check('解锁时间戳是正整数',
    Boolean(achProfile) && typeof achProfile.unlocked.first_game === 'number' &&
      achProfile.unlocked.first_game > 0,
    achProfile && String(achProfile.unlocked.first_game));

  const achLabel = await text('#achOpen');
  const achMatch = /^成就 (\d+)\/25$/.exec(achLabel || '');
  check('成就按钮显示 x/25 且与档案一致',
    Boolean(achMatch) && Number(achMatch[1]) === unlockedIds.length,
    achLabel + ' / unlocked=' + unlockedIds.length);

  const toastCount = await evalJs('document.querySelectorAll("#achToasts .toast").length');
  check('解锁时右下角出现提示条', toastCount >= 1, 'toasts=' + toastCount);
  check('提示条同屏最多 3 条', toastCount <= 3, 'toasts=' + toastCount);

  await evalJs('document.getElementById("achOpen").focus(), 1');
  await click('#achOpen');
  await wait(180);
  check('成就面板打开', (await evalJs('document.getElementById("achSheet").hidden')) === false);
  check('面板里 25 张卡片',
    (await evalJs('document.querySelectorAll("#achBody .ach-card").length')) === 25);

  const unlockedCards = await evalJs('document.querySelectorAll("#achBody .ach-card.is-unlocked").length');
  check('解锁卡片数与档案一致', unlockedCards === unlockedIds.length,
    unlockedCards + ' vs ' + unlockedIds.length);

  check('锁定卡片 aria-disabled 且仍可聚焦', await evalJs(`(function () {
    var card = document.querySelector('#achBody .ach-card[aria-disabled="true"]');
    return !!card && card.getAttribute('tabindex') === '0';
  })()`));
  check('锁定卡片带进度条', (await evalJs(
    'document.querySelectorAll("#achBody .ach-card[aria-disabled=\\"true\\"] .ach-progress").length'
  )) > 0);
  check('解锁卡片显示解锁日期',
    /^解锁于 \d{4}-\d{2}-\d{2}$/.test((await text('#achBody .ach-card.is-unlocked .ach-card__date')) || ''),
    await text('#achBody .ach-card.is-unlocked .ach-card__date'));
  check('顶部显示已解锁汇总',
    ((await text('#achBody .ach-summary__count')) || '').indexOf('已解锁 ' + unlockedIds.length + ' / 25') === 0,
    await text('#achBody .ach-summary__count'));

  await press('Escape');
  await wait(150);
  check('Esc 关闭成就面板', (await evalJs('document.getElementById("achSheet").hidden')) === true);
  check('关闭后焦点回到成就入口',
    (await evalJs('document.activeElement && document.activeElement.id')) === 'achOpen',
    await evalJs('document.activeElement && document.activeElement.id'));

  /* ---------- T12 刷新后同一局不重复累加 perfectMoves ---------- */
  console.log('\n[T12] 每日局刷新后再结算，perfectMoves 不翻倍');

  const todayKey = await evalJs('Game2048Rng.dateKey(new Date())');
  await evalJs(`(function () {
    var key = ${JSON.stringify(todayKey)};
    Game2048Storage.set(Game2048Storage.KEYS.settings, { size: 4, mode: 'timed', sound: false });
    Game2048Storage.set(Game2048Storage.KEYS.profile, {
      version: 1, stats: { perfectMoves: 5 }, unlocked: {}
    });
    Game2048Storage.set(Game2048Storage.KEYS.state, {
      version: 2, size: 4, mode: 'timed',
      values: [[2, 2, 0, 0], [4, 8, 0, 0], [16, 32, 0, 0], [64, 128, 0, 0]],
      score: 100, won: true, keepPlaying: true,
      remainingMs: 3000, obstaclesAdded: 0, moves: 6,
      recorded: true, recordedMoves: 2,
      daily: key, rngCount: 0, dailyRecorded: true, dailyRecordedMoves: 2,
      perfectRecorded: 5,
      reviewLog: {
        version: 1, date: key,
        moves: [
          { d: 'left', v: [[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], g: 4, b: 'left', s: 10, t: 10 },
          { d: 'up', v: [[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], g: 4, b: 'left', s: 10, t: 8 }
        ],
        summary: null
      }
    });
    return 1;
  })()`);
  await reload();

  check('读档后仍是这一局每日局', (await text('#dailyStart')) === '重新开始',
    await text('#dailyStart'));

  const restoredProfile = JSON.parse(await evalJs(
    'JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.profile, null))'
  ));
  check('读档没有把 perfectMoves 归零',
    Boolean(restoredProfile) && restoredProfile.stats.perfectMoves === 5,
    restoredProfile && String(restoredProfile.stats.perfectMoves));

  // 再走一步触发 saveState，确认入账标记真的写进了存档
  await press('ArrowLeft');
  await wait(500);
  const savedMid = JSON.parse(await evalJs(
    'JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.state, null))'
  ));
  check('存档里带上了 perfectRecorded',
    Boolean(savedMid) && savedMid.perfectRecorded === 5,
    JSON.stringify(savedMid && { perfectRecorded: savedMid.perfectRecorded, moves: savedMid.moves }));

  // 加速时间跑到超时，触发同一局的第二次汇总
  await withFakeClock(async () => {
    await wait(1600);
  });
  check('时间到正常结算', (await text('#overlayTitle')) === '时间到', await text('#overlayTitle'));

  const afterSecond = JSON.parse(await evalJs(
    'JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.profile, null))'
  ));
  check('同一局再结算后 perfectMoves 仍是 5（没有翻倍）',
    Boolean(afterSecond) && afterSecond.stats.perfectMoves === 5,
    afterSecond && String(afterSecond.stats.perfectMoves));

  /* ---------- T13 托管达成目标后不中断 ---------- */
  console.log('\n[T13] 托管达成目标后继续跑');

  // 两行各摆一对 1024：上下左右无论 AI 选哪个方向都会合出 2048，
  // 这样断言不依赖 expectimax 具体挑哪一步。
  await loadBoard([
    [1024, 1024, 0, 0],
    [1024, 1024, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ], 'classic');

  const beforeT13 = await stats();
  const winsBefore = await evalJs(`(function () {
    var p = Game2048Storage.get(Game2048Storage.KEYS.profile, null);
    return p && p.stats && typeof p.stats.wins === 'number' ? p.stats.wins : 0;
  })()`);

  await click('#autoplay');

  let maxSeen = 0;
  for (let i = 0; i < 50 && maxSeen < 2048; i++) {
    await wait(100);
    maxSeen = await evalJs(`(function () {
      var nodes = document.querySelectorAll('#tileLayer [data-value]');
      var max = 0;
      for (var k = 0; k < nodes.length; k++) {
        var v = Number(nodes[k].getAttribute('data-value'));
        if (v > max) max = v;
      }
      return max;
    })()`);
  }

  check('托管把 2048 打出来了', maxSeen >= 2048, '最大 ' + maxSeen);

  // 方块在动画开端就进了 DOM，判胜负与落盘在动画收尾（约 285ms）之后，
  // 这里等这一步结算完再读存档，否则读到的是注入时那份还没走子过的状态。
  await wait(700);

  check('达成目标没有弹结算浮层', (await overlayHidden()) === true);
  check('托管没有被停掉', (await autoplayOn()) === true);

  const atWin = JSON.parse(await evalJs(
    'JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.state, null))'
  ));
  check('存档里这一局还在进行',
    Boolean(atWin) && atWin.won === true && atWin.keepPlaying === true,
    JSON.stringify(atWin && { won: atWin.won, keepPlaying: atWin.keepPlaying, moves: atWin.moves }));

  const movesAtWin = atWin ? atWin.moves : 0;
  await wait(1500);
  const later = JSON.parse(await evalJs(
    'JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.state, null))'
  ));
  check('目标之后托管继续走子',
    Boolean(later) && later.moves > movesAtWin,
    movesAtWin + ' -> ' + (later && later.moves));

  const winsAfter = await evalJs(`(function () {
    var p = Game2048Storage.get(Game2048Storage.KEYS.profile, null);
    return p && p.stats && typeof p.stats.wins === 'number' ? p.stats.wins : 0;
  })()`);
  check('不弹浮层也没有漏记通关', winsAfter === winsBefore + 1, winsBefore + ' -> ' + winsAfter);

  const afterT13 = await stats();
  check('这一局照常记进游戏数', afterT13.games === beforeT13.games + 1,
    beforeT13.games + ' -> ' + afterT13.games);

  if (await autoplayOn()) {
    await click('#autoplay');
    await wait(300);
  }

  /* ---------- T14 达成目标同时死局 ---------- */
  console.log('\n[T14] 达成目标那一步同时死局，继续挑战要结算');

  /**
   * 从渲染层还原当前盘面并问规则层「还能不能走」。
   * 只用来确认构造出来的确实是死局，不依赖控制器内部状态。
   */
  const boardHasMoves = () => evalJs(`(function () {
    var size = 4;
    var values = [];
    for (var r = 0; r < size; r++) {
      var row = [];
      for (var c = 0; c < size; c++) row.push(0);
      values.push(row);
    }
    var nodes = document.querySelectorAll('#tileLayer .tile');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].classList.contains('tile--obstacle')) continue;
      var r2 = Number(nodes[i].style.getPropertyValue('--y'));
      var c2 = Number(nodes[i].style.getPropertyValue('--x'));
      values[r2][c2] = Number(nodes[i].textContent);
    }
    return Game2048.hasMoves(Game2048.boardFromValues(values));
  })()`);

  // 审计报告 C1 的矩阵：向左 1024+1024 -> 2048 之后只剩 (0,3) 一个空格，
  // 落 2 就满盘无解。Math.random 固定为 0，让落子恒为 2（不赌 90% 概率）。
  await loadBoard([
    [1024, 1024, 2, 4],
    [8, 16, 32, 64],
    [128, 256, 512, 2],
    [4, 8, 16, 32]
  ], 'classic');

  await withFixedRandom(async () => {
    await press('ArrowLeft');
    await wait(800);
  });

  check('先弹出达成目标', (await text('#overlayTitle')) === '达成目标', await text('#overlayTitle'));
  check('这一步之后棋盘确实无解', (await boardHasMoves()) === false);

  const statsBeforeContinue = await stats();
  await evalJs('document.querySelectorAll("#overlayActions button")[0].click(), 1');   // 继续挑战
  await wait(400);
  const statsAfterContinue = await stats();

  // 旧实现：overlay 被 hideOverlay 关掉、over 复位后不再判死局，标题仍停在「达成目标」，
  // 棋盘按方向键毫无反应，也永远不会有第二次结算。
  check('继续挑战后立刻结算为死局', (await text('#overlayTitle')) === '走不动了', await text('#overlayTitle'));
  check('死局浮层是打开的', (await overlayHidden()) === false);
  // 同一步的二次结算（win -> stuck）不能重复记局、重复计步：
  // recordGame 的 firstTime / extraMoves 两个增量口径各锁一条。
  check('二次结算不重复记局', statsAfterContinue.games === statsBeforeContinue.games,
    statsBeforeContinue.games + ' -> ' + statsAfterContinue.games);
  check('二次结算不重复计步', statsAfterContinue.totalMoves === statsBeforeContinue.totalMoves,
    statsBeforeContinue.totalMoves + ' -> ' + statsAfterContinue.totalMoves);
  check('死局浮层带撤销入口', await evalJs(`(function () {
    var btns = document.querySelectorAll('#overlayActions button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].textContent.trim() === '撤销一步') return true;
    }
    return false;
  })()`));

  /* ---------- T15 零增量结算补齐 bestTile ---------- */
  console.log('\n[T15] 时间到 -> 撤销一步 -> 合出 2048，bestTile 仍要推进');

  const profileWins = () => evalJs(`(function () {
    var p = Game2048Storage.get(Game2048Storage.KEYS.profile, null);
    return p && p.stats && typeof p.stats.wins === 'number' ? p.stats.wins : 0;
  })()`);

  // 战绩清零：否则上一节已经记过 2048，旧实现的漏记会被历史值掩盖
  await evalJs('Game2048Storage.remove(Game2048Storage.KEYS.stats), 1');
  await loadBoard(BOARD_WIN_IN_ONE, 'timed');
  const winsBeforeZero = await profileWins();

  await press('ArrowDown');   // 先走一步不合成：把 recordedMoves 推到 1
  await wait(600);
  check('拖延的这一步没合出 2048', (await statusMoves()) === 1, '已走 ' + (await statusMoves()) + ' 步');

  await withFakeClock(async () => {
    await wait(1600);
  });
  check('时间到先结算一次', (await text('#overlayTitle')) === '时间到', await text('#overlayTitle'));

  check('时间到浮层里点了撤销一步', (await evalJs(`(function () {
    var btns = document.querySelectorAll('#overlayActions button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].textContent.trim() === '撤销一步') { btns[i].click(); return true; }
    }
    return false;
  })()`)) === true);
  await wait(400);

  await press('ArrowLeft');   // 回到原步数，同时合出 2048：extraMoves 恰为 0
  await wait(800);
  check('撤销后合出 2048 弹出达成目标', (await text('#overlayTitle')) === '达成目标', await text('#overlayTitle'));

  const statsAfterZero = await stats();
  // 旧实现：recordGame 在 !firstTime && extraMoves === 0 处直接 return，
  // bestTile 停在上一次结算的 1024，这里必然是 1024。
  check('零增量结算把 bestTile 推到 2048', statsAfterZero.bestTile === 2048, String(statsAfterZero.bestTile));
  check('零增量结算也把 bestScore 推到本局分数', statsAfterZero.bestScore === 2048, String(statsAfterZero.bestScore));

  /* ---------- T16 同一局 wins 只记一次 ---------- */
  console.log('\n[T16] 通关只记一次 wins');

  // 旧实现：这次通关走的是「已 recorded + 零增量」，recordGame 提前返回，
  // recordGameAchievements 根本没被调用，wins 一次都没加。
  check('通关把 wins 恰好 +1', (await profileWins()) === winsBeforeZero + 1,
    winsBeforeZero + ' -> ' + (await profileWins()));

  await evalJs('document.querySelectorAll("#overlayActions button")[0].click(), 1');   // 继续挑战
  await wait(400);

  await withFakeClock(async () => {
    await wait(1600);
  });
  check('同一局再结算一次', (await text('#overlayTitle')) === '时间到', await text('#overlayTitle'));

  // 没有 winRecorded 闸门时，第二次结算会再写一遍 wins / modeWins，这里会变成 +2。
  check('同一局再结算 wins 仍是 +1', (await profileWins()) === winsBeforeZero + 1,
    winsBeforeZero + ' -> ' + (await profileWins()));

  /* ---------- T17 托管 + 复盘抽屉：打开暂停、关闭恢复 ---------- */
  console.log('\n[T17] 托管与复盘抽屉：打开即暂停，关闭后继续跑');

  /**
   * 存档里的当前步数；结算后存档会被移除，返回 -1 让断言看得出异常。
   * 走子收尾都会 saveState，所以它等价于「AI 有没有真的走」。
   */
  const savedMoves = async () => {
    const raw = await evalJs(
      'JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.state, null))'
    );
    const saved = JSON.parse(raw);
    return saved && typeof saved.moves === 'number' ? saved.moves : -1;
  };
  const sheetHidden = (id) => evalJs(`document.getElementById(${JSON.stringify(id)}).hidden`);

  await loadBoard(BOARD_RIGHT_COL, 'classic');
  await click('#autoplay');

  // 先确认托管真的在走，否则后面的「步数不动」可能只是 AI 从没起来
  let movesBeforeSheet = 0;
  for (let i = 0; i < 25 && movesBeforeSheet < 2; i++) {
    await wait(120);
    movesBeforeSheet = await savedMoves();
  }
  check('托管已经走了两步以上', movesBeforeSheet >= 2, '已走 ' + movesBeforeSheet + ' 步');

  await click('#reviewOpen');
  await wait(250);
  check('复盘抽屉已打开', (await sheetHidden('reviewSheet')) === false);

  // 打开的那一刻可能正好在播一步的动画：先等它收尾，再取「冻结」基准
  await wait(400);
  const frozenMoves = await savedMoves();
  await wait(600);
  const stillMoves = await savedMoves();
  // 旧实现只 stopCountdown，不暂停托管：已排期的那一步被 isLocked() 挡回后
  // 回调直接结束、不再排期 —— 步数确实不动，但托管其实已经死了（下一条断言才红）
  check('抽屉打开期间托管不再走子', stillMoves === frozenMoves, frozenMoves + ' -> ' + stillMoves);

  await press('Escape');
  await wait(150);
  check('关闭复盘后托管仍显示「开」', (await autoplayOn()) === true,
    'aria-pressed=' + (await evalJs('document.getElementById("autoplay").getAttribute("aria-pressed")')));

  // 旧实现：autoplay 仍为 true 但没有任何在途定时器，手不动，1.5s 后步数不会变
  await wait(1500);
  const resumedMoves = await savedMoves();
  check('关闭复盘后 1.5s 内托管继续走子', resumedMoves > stillMoves,
    stillMoves + ' -> ' + resumedMoves);

  if (await autoplayOn()) {
    await click('#autoplay');
    await wait(300);
  }

  /* ---------- T18 两个抽屉互斥，Esc 关后打开的那个 ---------- */
  console.log('\n[T18] 两个抽屉互斥：只剩一个可见，Esc 关后打开的那个');

  await loadBoard(BOARD_RIGHT_COL, 'classic');
  // 先把焦点放到复盘入口：这样「打开复盘之前的元素」是 #reviewOpen 而不是 body。
  // 否则关闭成就时会靠 fallback 回到 #achOpen，即使删掉 returnFocus 继承也照样绿。
  await evalJs('document.getElementById("reviewOpen").focus(), 1');
  await click('#reviewOpen');
  await wait(250);
  check('复盘抽屉已打开', (await sheetHidden('reviewSheet')) === false);

  await click('#achOpen');   // 复盘开着时再从入口打开成就
  await wait(250);

  const visibleSheets = await evalJs(`(function () {
    var ids = ['reviewSheet', 'achSheet'];
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      if (!document.getElementById(ids[i]).hidden) out.push(ids[i]);
    }
    return out.join(',');
  })()`);
  // 旧实现两个 sheet 可以同时 hidden=false：这里会读到 "reviewSheet,achSheet"
  check('同时只允许一个抽屉可见', visibleSheets === 'achSheet', visibleSheets || '(都不可见)');
  check('复盘在成就打开时就已关掉', (await sheetHidden('reviewSheet')) === true);

  await press('Escape');
  await wait(200);
  // 旧实现的 onKeyDown 先判 isReviewOpen()，Esc 关的是下层复盘，成就面板留在屏幕上
  check('Esc 关掉的是后打开的成就面板', (await sheetHidden('achSheet')) === true);
  // 成就面板继承的是「打开复盘之前的元素」：不继承时这里会退回 #achOpen
  check('关闭成就后焦点回到打开复盘之前的元素（returnFocus 被继承）',
    (await evalJs('document.activeElement && document.activeElement.id')) === 'reviewOpen',
    await evalJs('document.activeElement && document.activeElement.id'));

  /* ---------- T19 抽屉的焦点陷阱 + 状态行的可访问性 ---------- */
  console.log('\n[T19] 复盘抽屉里的 Tab 不逃到背景控件');

  await loadBoard(BOARD_RIGHT_COL, 'classic');
  // 面板里只有一个可聚焦元素时，「14 次 Tab 都没逃出去」说服力不够（陷阱与浏览器默认
  // 都可能停在原地）。清掉今天的复盘记录，让抽屉落在带「去挑战」按钮的空状态，
  // 这样面板里有两个可聚焦元素，回卷才是真的把焦点从末位送回首位。
  await evalJs(`(function () {
    var key = Game2048Rng.dateKey(new Date());
    Game2048Storage.remove(Game2048Storage.KEYS.review + '.' + key);
    return 1;
  })()`);
  await click('#reviewOpen');
  await wait(250);
  check('打开后焦点落在关闭按钮上',
    (await evalJs('document.activeElement && document.activeElement.id')) === 'reviewClose',
    await evalJs('document.activeElement && document.activeElement.id'));

  /**
   * 模拟一次 Tab 并回报落点。
   *
   * 合成的 KeyboardEvent 不会触发浏览器默认的「移动焦点」，所以这里按全局 DOM 顺序
   * 手动补上默认行为 —— 只有应用 preventDefault（也就是焦点陷阱接住了）时才跳过这一补。
   * 少了这一步，旧代码会「看起来也没逃出去」，断言就失去意义。
   */
  const tabStep = (shift) => evalJs(`(function (back) {
    var SEL = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    function visible(root) {
      var nodes = root.querySelectorAll(SEL);
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].disabled || nodes[i].offsetParent === null) continue;
        out.push(nodes[i]);
      }
      return out;
    }
    function name(el) {
      if (!el) return 'null';
      if (el.id) return '#' + el.id;
      var text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 12);
      return (el.className || el.tagName) + ':' + text;
    }
    var ev = new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: back, bubbles: true, cancelable: true
    });
    var prevented = false;
    function spy(e) { if (e === ev) prevented = e.defaultPrevented; }
    document.addEventListener('keydown', spy);
    document.dispatchEvent(ev);
    document.removeEventListener('keydown', spy);

    if (!prevented) {
      var all = visible(document);
      var index = all.indexOf(document.activeElement);
      var next = all[(index + (back ? -1 : 1) + all.length) % all.length];
      if (next) next.focus();
    }

    var sheet = document.getElementById('reviewSheet');
    return JSON.stringify({
      inside: sheet.contains(document.activeElement),
      who: name(document.activeElement),
      prevented: prevented
    });
  })(${shift ? 'true' : 'false'})`);

  const escaped = [];
  const visited = {};
  let caught = 0;
  for (let i = 0; i < 14; i++) {
    const step = JSON.parse(await tabStep(false));
    if (!step.inside) escaped.push(i + ':' + step.who);
    if (step.prevented) caught++;
    visited[step.who] = true;
  }
  // 旧实现没有任何拦住 Tab 的地方，焦点走出抽屉正文后会落到背景的 #newGame 等按钮上
  check('连按 14 次 Tab，焦点始终在复盘面板内', escaped.length === 0, escaped.join(' ') || 'ok');

  const visitedNames = Object.keys(visited);
  // 「一直没逃出去」还要证明焦点真的在面板里走动，否则单个元素原地打转也能绿
  check('14 次 Tab 走过了面板里不止一个可聚焦元素', visitedNames.length > 1,
    visitedNames.join(' → '));
  check('末位 Tab 被焦点陷阱接住并回卷', caught >= 1, 'caught=' + caught);

  /**
   * 单独构造一次「最后一个可聚焦元素 → 第一个」：把焦点显式放到面板末位再按 Tab，
   * 只认应用自己完成的转移，不依赖上一条的累计结果。
   */
  const wrap = JSON.parse(await evalJs(`(function () {
    var SEL = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    var sheet = document.getElementById('reviewSheet');
    var nodes = sheet.querySelectorAll(SEL);
    var items = [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].disabled || nodes[i].offsetParent === null) continue;
      items.push(nodes[i]);
    }
    function name(el) {
      if (!el) return 'null';
      if (el.id) return '#' + el.id;
      return el.className || el.tagName;
    }
    var first = items[0];
    var last = items[items.length - 1];
    if (!first || !last || first === last) {
      return JSON.stringify({ count: items.length, ok: false, after: '不足两个可聚焦元素' });
    }
    last.focus();
    var ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    var prevented = false;
    function spy(e) { if (e === ev) prevented = e.defaultPrevented; }
    document.addEventListener('keydown', spy);
    document.dispatchEvent(ev);
    document.removeEventListener('keydown', spy);
    return JSON.stringify({
      count: items.length,
      first: name(first),
      last: name(last),
      after: name(document.activeElement),
      ok: prevented && document.activeElement === first
    });
  })()`));
  check('最后一个可聚焦元素按 Tab 回到第一个', wrap.ok === true,
    wrap.count + ' 个元素，' + wrap.last + ' -> ' + wrap.after);

  const escapedBack = [];
  for (let i = 0; i < 3; i++) {
    const step = JSON.parse(await tabStep(true));
    if (!step.inside) escapedBack.push(i + ':' + step.who);
  }
  check('Shift+Tab 也不会逃出面板', escapedBack.length === 0, escapedBack.join(' ') || 'ok');

  await press('Escape');
  await wait(150);

  // M7：可视状态行与读屏播报节点分工，计时器的可访问名要带上倒计时数值。
  // 限时局才有计时器：换成 timed 盘面再量，否则 classic 下 #timer 是 hidden + 空文本。
  await loadBoard(BOARD_RIGHT_COL, 'timed');
  await wait(200);

  const liveRegions = JSON.parse(await evalJs(`(function () {
    var bar = document.getElementById('status');
    var ann = document.getElementById('statusAnnounce');
    var box = ann ? ann.getBoundingClientRect() : null;
    return JSON.stringify({
      statusRole: bar.getAttribute('role'),
      statusLive: bar.getAttribute('aria-live'),
      annRole: ann ? ann.getAttribute('role') : null,
      annLive: ann ? ann.getAttribute('aria-live') : null,
      annDisplay: ann ? getComputedStyle(ann).display : null,
      annWidth: box ? box.width : -1,
      annHeight: box ? box.height : -1
    });
  })()`));

  check('#status 只承担可视文本，不再是 live region',
    liveRegions.statusRole === null && liveRegions.statusLive === null,
    liveRegions.statusRole + ' / ' + liveRegions.statusLive);
  check('独立的播报节点是 polite 的 live region',
    liveRegions.annRole === 'status' && liveRegions.annLive === 'polite',
    liveRegions.annRole + ' / ' + liveRegions.annLive);
  // 视觉隐藏不能靠 display:none / visibility:hidden —— 那样连播报一起没了
  check('播报节点视觉隐藏（1px）但仍参与渲染',
    liveRegions.annDisplay !== 'none' &&
      liveRegions.annWidth <= 1 && liveRegions.annHeight <= 1,
    liveRegions.annDisplay + ' · ' +
      Math.round(liveRegions.annWidth) + '×' + Math.round(liveRegions.annHeight));

  const clockOf = () => evalJs(`(function () {
    var timer = document.getElementById('timer');
    return JSON.stringify({ clock: timer.textContent, label: timer.getAttribute('aria-label') });
  })()`).then(JSON.parse);

  const clock1 = await clockOf();
  check('#timer 的 aria-label 带当前倒计时数值',
    /^\d{2}:\d{2}$/.test(clock1.clock) && clock1.label === '剩余时间 ' + clock1.clock,
    clock1.clock + ' / ' + clock1.label);

  await wait(1200);   // 跨过一个 200ms tick，mm:ss 必然变化
  const clock2 = await clockOf();
  check('倒计时走一格后 aria-label 跟着变（不是恒定的静态标签）',
    clock2.clock !== clock1.clock && clock2.label === '剩余时间 ' + clock2.clock,
    clock1.label + ' -> ' + clock2.label);

  // 每步文案只进可视行；撤销这类真正的反馈才进播报节点
  await press('ArrowLeft');
  await wait(700);
  const afterStep = JSON.parse(await evalJs(`(function () {
    return JSON.stringify({
      moves: (Game2048Storage.get(Game2048Storage.KEYS.state, null) || {}).moves,
      visible: document.getElementById('status').textContent,
      announced: document.getElementById('statusAnnounce').textContent
    });
  })()`));
  check('走一步后可视状态行照常写步数文案', afterStep.moves === 1 && /已走\s*1\s*步/.test(afterStep.visible),
    'moves=' + afterStep.moves + ' · ' + afterStep.visible);
  check('走一步后播报节点没有变成步数文案', /已走/.test(afterStep.announced) === false,
    JSON.stringify(afterStep.announced));

  // press 只发 key，撤销的组合键要单独构造
  await evalJs(
    'document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })), 1'
  );
  await wait(400);
  const announcedUndo = await evalJs('document.getElementById("statusAnnounce").textContent');
  check('Ctrl+Z 撤销后播报节点含「撤销」', /撤销/.test(announcedUndo), announcedUndo);

  /* ---------- T20 每日挑战先关托管 ---------- */
  console.log('\n[T20] 托管中点每日挑战：先关托管再开新局');

  await loadBoard(BOARD_RIGHT_COL, 'classic');
  await click('#autoplay');
  await wait(900);
  check('托管已经走起来', (await autoplayOn()) === true && (await savedMoves()) > 0,
    'moves=' + (await savedMoves()));

  await click('#dailyChallenge');
  await wait(250);
  // 旧实现 startDaily 不走 applySettingsChange，autoplay 仍为 true，
  // startNewGame 收尾重新排期，玩家点的「每日挑战」立刻被 AI 接管
  check('进入每日挑战后托管是关的', (await autoplayOn()) === false,
    'aria-pressed=' + (await evalJs('document.getElementById("autoplay").getAttribute("aria-pressed")')));

  await wait(1200);
  const dailyMoves = await savedMoves();
  check('每日挑战没有被 AI 接管', dailyMoves === 0, 'moves=' + dailyMoves);

  /* ---------- T21 战报卡片 ---------- */
  console.log('\n[T21] 结算战报与复盘入口');

  await loadBoard(BOARD_WIN_IN_ONE, 'classic');
  await press('ArrowLeft');
  await wait(700);
  check('达成目标浮层出现（战报前置条件）', (await overlayHidden()) === false);

  const overlayLabels = JSON.parse(await evalJs(
    'JSON.stringify(Array.prototype.map.call(document.querySelectorAll("#overlayActions button"),' +
    ' function (btn) { return btn.textContent; }))'
  ));
  check('结算浮层有「保存战报」', overlayLabels.indexOf('保存战报') >= 0, overlayLabels.join(' / '));
  check('「保存战报」排在既有按钮之后', overlayLabels[overlayLabels.length - 1] === '保存战报',
    overlayLabels.join(' / '));

  const beforeSave = await text('#status');
  await evalJs(`(function () {
    var buttons = document.querySelectorAll('#overlayActions button');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].textContent === '保存战报') { buttons[i].click(); return 1; }
    }
    return 0;
  })()`);
  const saveStatus = await waitStatus(/战报已保存/, beforeSave);
  check('点击「保存战报」不写失败文案', saveStatus.indexOf('战报生成失败') < 0, saveStatus);
  check('点击后状态行给出文件名', /战报已保存 · 2048-\d{8}-\d+\.png/.test(saveStatus || ''), saveStatus);

  // 真实绘制：页面内走完整的 buildModel -> render -> toDataURL，再采样三块区域
  const probe = JSON.parse(await evalJs(`(function () {
    var model = Game2048Report.buildModel({
      date: '2026-11-07', size: 4, score: 123456, maxTile: 1024, moves: 88,
      mode: 'classic', daily: null, achievements: { unlocked: 3, total: 25 },
      values: [
        [1024, 1024, 64, 8],
        [32, 128, 16, 4],
        [8, 32, 2, 4],
        [2, 4, 8, 16]
      ]
    });
    var canvas = Game2048Report.render(model);
    if (!canvas) return JSON.stringify({ ok: false });

    var data = canvas.toDataURL('image/png');
    var ctx = canvas.getContext('2d');

    // 一块 100×100 区域里的颜色种数：>1 说明这块真的画了东西（不是纯底色）
    function colorCount(x, y) {
      var pixels = ctx.getImageData(x, y, 100, 100).data;
      var seen = {};
      var count = 0;
      for (var i = 0; i < pixels.length; i += 4) {
        var key = pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2];
        if (!seen[key]) { seen[key] = 1; count++; }
      }
      return count;
    }

    return JSON.stringify({
      ok: true,
      width: canvas.width,
      height: canvas.height,
      length: data.length,
      // 棋盘中心：方块层
      colors: colorCount(Math.floor(canvas.width / 2) - 50, Math.floor(canvas.height / 2) - 50),
      // 标题区：drawTexts 的标题 / 副标题（96,88 对应 CSS 48,44）
      titleColors: colorCount(96, 88),
      // 统计区：第一格「分数」的标签与数值（110,1360 对应 CSS 55,680）
      statsColors: colorCount(110, 1360),
      name: Game2048Report.fileName(model)
    });
  })()`));

  check('render 返回 1440×1920 的 2 倍图', probe.ok === true && probe.width === 1440 &&
    probe.height === 1920, probe.width + '×' + probe.height);
  check('toDataURL 长度 > 5000（真的画了内容）', probe.length > 5000, 'len=' + probe.length);
  check('中心 100×100 区域不是纯色', probe.colors > 1, probe.colors + ' 种颜色');
  check('标题区 100×100 不是纯色（文字层真的画了）', probe.titleColors > 1,
    probe.titleColors + ' 种颜色');
  check('统计区 100×100 不是纯色（统计格真的画了）', probe.statsColors > 1,
    probe.statsColors + ' 种颜色');
  check('文件名符合 2048-YYYYMMDD-<score>.png', probe.name === '2048-20261107-123456.png', probe.name);

  // 关掉结算浮层，进入复盘入口的两种状态
  await evalJs(`(function () {
    var buttons = document.querySelectorAll('#overlayActions button');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].textContent === '再来一局') { buttons[i].click(); return 1; }
    }
    return 0;
  })()`);
  await wait(400);
  check('点「再来一局」后浮层关闭', (await overlayHidden()) === true);

  await evalJs(`(function () {
    var key = Game2048Rng.dateKey(new Date());
    Game2048Storage.remove(Game2048Storage.KEYS.review + '.' + key);
    return 1;
  })()`);
  await click('#reviewOpen');
  await wait(300);
  check('今天没有落盘日志时不渲染导出按钮',
    (await evalJs('!!document.getElementById("reviewReport")')) === false);
  await press('Escape');
  await wait(200);

  // 有日志但盘面还原不出来（v 为空）：不能导出一张「空棋盘 + 有数字」的卡
  await evalJs(`(function () {
    var key = Game2048Rng.dateKey(new Date());
    Game2048Storage.set(Game2048Storage.KEYS.review + '.' + key, {
      version: 1,
      date: key,
      moves: [{ d: 'left', v: [], g: 0, b: null, s: null, t: null }],
      summary: null,
      meta: { score: 32, moves: 1, maxTile: 2, won: false }
    });
    return 1;
  })()`);
  await click('#reviewOpen');
  await wait(300);
  check('日志有步数但盘面还原不出来时不渲染导出按钮',
    (await evalJs('!!document.getElementById("reviewReport")')) === false);
  await press('Escape');
  await wait(200);

  await evalJs(`(function () {
    var key = Game2048Rng.dateKey(new Date());
    Game2048Storage.set(Game2048Storage.KEYS.review + '.' + key, {
      version: 1,
      date: key,
      moves: [{
        d: 'left',
        v: [[2, 2, 4, 8], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        g: 4, b: null, s: null, t: null
      }],
      summary: null,
      meta: { score: 1024, moves: 12, maxTile: 4, won: false }
    });
    return 1;
  })()`);
  await click('#reviewOpen');
  await wait(300);
  check('有落盘日志时出现「导出今日战报」',
    (await evalJs('!!document.getElementById("reviewReport")')) === true);
  const beforeReviewSave = await text('#status');
  await evalJs('document.getElementById("reviewReport").click(), 1');
  const reviewStatus = await waitStatus(/战报已保存/, beforeReviewSave);
  check('复盘导出不写失败文案',
    (reviewStatus || '').indexOf('战报生成失败') < 0 && /战报已保存/.test(reviewStatus || ''),
    reviewStatus);
  await press('Escape');
  await wait(200);

  // 进行中的每日局：抽屉渲染的是 live 日志，导出必须用 live 的 meta 与当前盘面，
  // 而不是旁边那份 score 1024 的落盘日志 —— 玩家看着哪局，存的就该是哪局。
  await click('#dailyChallenge');
  await wait(600);
  const liveDirs = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];
  for (let i = 0; i < liveDirs.length; i++) {
    await press(liveDirs[i]);
    await wait(450);
    if ((await savedMoves()) > 0) break;
  }
  check('每日局已经走了一步（live 日志有步数）', (await savedMoves()) > 0,
    'moves=' + (await savedMoves()));
  const liveScore = await evalJs('Game2048Storage.get(Game2048Storage.KEYS.state).score');

  await click('#reviewOpen');
  await wait(300);
  check('只有 live 日志有步数时也渲染导出按钮',
    (await evalJs('!!document.getElementById("reviewReport")')) === true);
  const beforeLiveSave = await text('#status');
  await evalJs('document.getElementById("reviewReport").click(), 1');
  const liveStatus = await waitStatus(/战报已保存/, beforeLiveSave);
  check('导出的是进行中这局（不是落盘那局的 1024 分）',
    (liveStatus || '').indexOf('-' + liveScore + '.png') >= 0,
    liveStatus + ' / live=' + liveScore);
  await press('Escape');
  await wait(200);

  /* ---------- T22 双人对战 ---------- */
  console.log('\n[T22] 双人对战');

  // 先走 UI：点设置面板里的「双人」，看 HUD 换成两块比分、两个按钮被压住
  await click('#modeGroup [data-mode="duel"]');
  await wait(600);
  check('切到双人后两个玩家分数块可见',
    await evalJs('!document.getElementById("p1Block").hidden && ' +
      '!document.getElementById("p2Block").hidden'));
  check('双人下隐藏原来的总分块', await evalJs('document.getElementById("scoreBox").hidden'));
  check('双人下撤销按钮禁用', await evalJs('document.getElementById("undo").disabled'));
  check('双人下托管按钮禁用', await evalJs('document.getElementById("autoplay").disabled'));
  check('双人下计时器隐藏', await evalJs('document.getElementById("timer").hidden'));
  check('双人下「最高」块也隐藏（个人最高与合计分不可比）',
    await evalJs('document.getElementById("bestBox").hidden'));

  // 两行各有一对 2+2：一步左移合计 8 分，正好验证「一步多次合并全归当前玩家」
  const BOARD_DUEL_PAIRS = [
    [2, 2, 0, 0],
    [0, 0, 2, 2],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ];
  await loadBoard(BOARD_DUEL_PAIRS, 'duel', { players: [0, 0], turn: 0 });
  check('注入双人盘面后轮到玩家 1', (await text('#turnLabel')) === '轮到玩家 1',
    await text('#turnLabel'));

  await withFixedRandom(async () => {
    await press('ArrowLeft');
    await wait(900);
    check('玩家 1 一次走子拿满 8 分', (await text('#p1Score')) === '8', await text('#p1Score'));
    check('玩家 2 仍是 0 分', (await text('#p2Score')) === '0', await text('#p2Score'));
    check('走完一步换到玩家 2', (await text('#turnLabel')) === '轮到玩家 2',
      await text('#turnLabel'));
    check('双人下撤销按钮仍然禁用（没有历史）',
      await evalJs('document.getElementById("undo").disabled'));

    await press('ArrowDown');   // 左列两个 4 合成 8，这一步归玩家 2
    await wait(900);
    check('玩家 2 走子后拿到 8 分', (await text('#p2Score')) === '8', await text('#p2Score'));
    check('玩家 1 保持 8 分', (await text('#p1Score')) === '8', await text('#p1Score'));
    check('再走一步换回玩家 1', (await text('#turnLabel')) === '轮到玩家 1',
      await text('#turnLabel'));
  });

  // 存档：刷新后两人比分与回合都要原样接着走
  const duelSaved = JSON.parse(await evalJs(
    'JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.state))'));
  check('存档里带上 players / turn',
    Boolean(duelSaved) && duelSaved.turn === 0 &&
      JSON.stringify(duelSaved.players) === '[8,8]',
    duelSaved ? 'turn=' + duelSaved.turn + ' players=' + JSON.stringify(duelSaved.players) : 'null');

  await reload();
  check('刷新后两人比分保持', (await text('#p1Score')) === '8' && (await text('#p2Score')) === '8',
    (await text('#p1Score')) + ' / ' + (await text('#p2Score')));
  check('刷新后回合保持为玩家 1', (await text('#turnLabel')) === '轮到玩家 1',
    await text('#turnLabel'));

  // 动画期连按：双人不缓冲。旧实现会把第二下留到换人之后，以玩家 2 的身份走掉并记分
  // （沿用 T1 的连打写法：30ms 间隔，远小于约 285ms 的动画窗口）。
  await loadBoard(BOARD_DUEL_PAIRS, 'duel', { players: [0, 0], turn: 0 });
  await withFixedRandom(async () => {
    await press('ArrowLeft');
    await wait(30);
    await press('ArrowDown');   // 会被丢掉：这一下仍在玩家 1 的动画期
    await wait(900);
  });
  const duelRapid = JSON.parse(await evalJs(
    'JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.state))'));
  check('双人动画期连按只走一步', Boolean(duelRapid) && duelRapid.moves === 1,
    duelRapid ? 'moves=' + duelRapid.moves : 'null');
  check('双人动画期连按不会记到对手账上',
    Boolean(duelRapid) && JSON.stringify(duelRapid.players) === '[8,0]',
    duelRapid ? 'players=' + JSON.stringify(duelRapid.players) : 'null');
  check('双人动画期连按后仍轮到玩家 2', (await text('#turnLabel')) === '轮到玩家 2',
    await text('#turnLabel'));

  // 返程：切回经典，双人的分块与回合条收起，按钮恢复可用（新模型最容易坏的方向）
  await withFixedRandom(async () => {
    await click('#modeGroup [data-mode="classic"]');
    await wait(600);
    await press('ArrowLeft');   // 新局先走一步，撤销才有内容
    await wait(900);
  });
  check('切回经典后总分块恢复可见', await evalJs('!document.getElementById("scoreBox").hidden'));
  check('切回经典后「最高」恢复可见', await evalJs('!document.getElementById("bestBox").hidden'));
  check('切回经典后两个玩家分块收起', await evalJs(
    'document.getElementById("p1Block").hidden && document.getElementById("p2Block").hidden'));
  check('切回经典后回合条收起', await evalJs('document.getElementById("duelBar").hidden'));
  check('切回经典后托管按钮可用', await evalJs('!document.getElementById("autoplay").disabled'));
  check('切回经典后撤销按钮可用', await evalJs('!document.getElementById("undo").disabled'));

  // 死局：一步左移把唯一的空格补满，盘面变成无合并的棋盘，按比分判胜负
  const BOARD_DUEL_STUCK = [
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [0, 4, 2, 4]
  ];

  await loadBoard(BOARD_DUEL_STUCK, 'duel', { players: [8, 4], turn: 0, score: 12 });
  await withFixedRandom(async () => {
    await press('ArrowLeft');
    await wait(900);
  });
  check('双人死局按比分判玩家 1 获胜', (await text('#overlayTitle')) === '玩家 1 获胜',
    await text('#overlayTitle'));
  check('死局文案带两人比分', /玩家 1 8 分 \/ 玩家 2 4 分/.test((await text('#overlayText')) || ''),
    await text('#overlayText'));
  check('分出胜负的浮层走 win 调性，不是平局', await evalJs(`(function () {
    var o = document.getElementById('overlay');
    return o.classList.contains('is-win') && !o.classList.contains('is-draw');
  })()`));

  await loadBoard(BOARD_DUEL_STUCK, 'duel', { players: [6, 6], turn: 0, score: 12 });
  await withFixedRandom(async () => {
    await press('ArrowLeft');
    await wait(900);
  });
  check('双人死局同分判平局', (await text('#overlayTitle')) === '平局', await text('#overlayTitle'));
  // 平局既不写「有人赢了」的 win 色，也不写失败色：单开一档 is-draw 走中性
  check('平局浮层用 is-draw，不落 win / lose', await evalJs(`(function () {
    var o = document.getElementById('overlay');
    return o.classList.contains('is-draw') &&
      !o.classList.contains('is-win') && !o.classList.contains('is-lose');
  })()`));
  check('平局标题色走中性档（--ink-faint），不是胜利金', await evalJs(`(function () {
    var o = document.getElementById('overlay');
    var title = document.getElementById('overlayTitle');
    var draw = getComputedStyle(title).color;
    o.classList.add('is-win');
    var gold = getComputedStyle(title).color;
    o.classList.remove('is-win');
    // 用一个临时节点读 --ink-faint 的解析值：平局色应当就是它，而不是碰巧和金色不同
    var probe = document.createElement('span');
    probe.style.color = 'var(--ink-faint)';
    document.body.appendChild(probe);
    var neutral = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    return draw !== gold && draw === neutral;
  })()`));

  // 胜负：合出目标值的一方获胜，判定必须发生在换人之前
  const statsBeforeDuelWin = await stats();
  await loadBoard([
    [1024, 1024, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ], 'duel', { players: [4, 8], turn: 1, score: 12 });
  await press('ArrowLeft');
  await wait(900);
  check('双人达成目标浮层打开', (await overlayHidden()) === false);
  check('标题写「玩家 2 达成目标」（刚走完这一步的人获胜）',
    (await text('#overlayTitle')) === '玩家 2 达成目标', await text('#overlayTitle'));
  check('结算后回合条不再显示轮次',
    (await text('#turnLabel')) === '本局结束', await text('#turnLabel'));
  check('双人结算不给「继续挑战」', await evalJs(`(function () {
    var buttons = document.querySelectorAll('#overlayActions button');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].textContent === '继续挑战') return false;
    }
    return true;
  })()`));

  const statsAfterDuelWin = await stats();
  check('双人局不写 stats（games 不变）', statsAfterDuelWin.games === statsBeforeDuelWin.games,
    statsBeforeDuelWin.games + ' -> ' + statsAfterDuelWin.games);
  check('双人局不写 totalMoves', statsAfterDuelWin.totalMoves === statsBeforeDuelWin.totalMoves,
    statsBeforeDuelWin.totalMoves + ' -> ' + statsAfterDuelWin.totalMoves);

  /* ---------- T23 控制台 ---------- */
  console.log('\n[T23] 控制台');
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
