/**
 * 跨模块集成端到端回归（真实 Chrome + CDP，零第三方依赖，进仓库可复跑）。
 *
 * 单测管各模块自身，控制器 e2e 管一条主线，四模块联动 e2e 管日常链路；
 * 这里只测「A 的改动把 B 弄坏」这类组合：
 *   1. 双人模式下打开复盘抽屉：不崩、不出现导出战报入口（双人本来就没有复盘日志）；
 *   2. 每日局的战报页脚「第 N 次」与每日条是同一个 N；
 *   3. 托管 + 复盘 + 限时叠加：开托管 → 开复盘 → 关复盘，计时与托管都回来；
 *   4. 双人结束 → 切回经典 → 走一步 → 战报入口照常（双人没把战报依赖弄坏）；
 *   5. 320px 下第四个模式按钮 / 双人比分块 / 战报按钮不溢出；1280×800 棋盘不被裁，
 *      切到双人后每日条收起、页脚仍在视口内。
 *
 * 启动方式刻意与 test/app.e2e.js、test/features.e2e.js 保持一致（复制而非 import）：
 * 三个套件互不依赖，任何一个改动都不会把另一个带崩。
 *
 * 用法：node test/integration.e2e.js [--allow-skip]
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
const PORT = 9700 + (process.pid % 200);
const USER_DIR = path.join(os.tmpdir(), 'e2e-2048-integration-' + Date.now());

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

/** 右列三块：左移必能走，托管也一定有步可走 */
const BOARD_RIGHT_COL = [
  [0, 0, 0, 2],
  [0, 0, 0, 4],
  [0, 0, 0, 0],
  [0, 0, 0, 8]
];

/** 一步左移就合并出 2048（4×4 的目标） */
const BOARD_WIN_IN_ONE = [
  [1024, 1024, 0, 0],
  [2, 4, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0]
];

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
  console.log('SKIP 跨模块集成回归：' + reason);
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
  const overlayHidden = () => evalJs('document.getElementById("overlay").hidden');
  const autoplayOn = async () =>
    (await evalJs('document.getElementById("autoplay").getAttribute("aria-pressed")')) === 'true';

  /** 按按钮文字点结算浮层里的某一项；找不到时返回 false 让断言看得出来 */
  const clickOverlay = (label) => evalJs(`(function () {
    var buttons = document.querySelectorAll('#overlayActions button');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].textContent.trim() === ${JSON.stringify(label)}) { buttons[i].click(); return true; }
    }
    return false;
  })()`);

  /** 浮层按钮文字表，用来确认「有 / 没有」某个入口 */
  const overlayLabels = async () => JSON.parse(await evalJs(
    'JSON.stringify(Array.prototype.map.call(document.querySelectorAll("#overlayActions button"),' +
    ' function (btn) { return btn.textContent; }))'
  ));

  /** 存档里的当前步数；结算后存档被移除时返回 -1，让断言看得出异常 */
  async function savedMoves() {
    const raw = await evalJs('JSON.stringify(Game2048Storage.get(Game2048Storage.KEYS.state, null))');
    const saved = JSON.parse(raw);
    return saved && typeof saved.moves === 'number' ? saved.moves : -1;
  }

  /**
   * 等状态行命中正则。
   * 战报下载要等 canvas.toBlob 的异步回调，固定 sleep 在慢机上会踩线；
   * 这里每 50ms 轮询一次，最多等 2s。命中过旧文案（before）就继续等。
   *
   * @param {RegExp} pattern 期望的状态行
   * @param {string} [before] 点击前的状态行
   * @returns {Promise<string>} 最后一次读到的状态行
   */
  async function waitStatus(pattern, before) {
    const stale = before === undefined ? '' : String(before);
    const deadline = Date.now() + 2000;
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

  /** 清空所有本地数据并重载：回到「全新安装」的状态 */
  async function wipe() {
    await evalJs('(function () { try { localStorage.clear(); } catch (e) {} return 1; })()');
    await reload();
  }

  /**
   * 注入一份存档（含设置）后重载。
   * patch 覆盖默认盘面；双人局用它补 players / turn。
   *
   * @param {object} patch 存档字段
   */
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

  /**
   * 在固定随机源下跑一段用例：Math.random 恒为 0，落子必为 2。
   * finally 保证断言抛错也会还原，不把假随机留给后面的小节。
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
   * finally 保证异常时也还原，不把假时钟泄漏给后续用例。
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

  /** 依次按四个方向，直到步数真的变化；初始盘面是随机的，不能赌某个方向一定推得动 */
  async function moveOnce() {
    const dirs = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];
    for (let i = 0; i < dirs.length; i++) {
      const before = await savedMoves();
      await press(dirs[i]);
      await wait(700);
      if ((await savedMoves()) > before) return true;
    }
    return false;
  }

  await wait(500);

  /* ---------- I1 双人模式里的复盘抽屉 ---------- */
  // 红在哪：Task 5 的双人入口若沿用「每日局才清日志」之外的路径，切模式后日志会残留，
  // 抽屉就会渲染出指标；Task 4 的 appendReportEntry 若不再判「有没有步数」，空日志也会给入口。
  console.log('\n[I1] 双人模式下打开复盘抽屉');

  await wipe();
  await click('#dailyChallenge');
  await wait(500);

  const liveLog = await evalJs(`(function () {
    var s = Game2048Storage.get(Game2048Storage.KEYS.state, null);
    return s && s.reviewLog ? s.reviewLog.date : null;
  })()`);
  // 先开一局每日，让 state.reviewLog 真的有值：否则「双人下没有日志」是恒真的空断言
  check('每日局开局就带上了 live 复盘日志', Boolean(liveLog), String(liveLog));

  await click('#modeGroup [data-mode="duel"]');
  await wait(700);

  const duelLog = await evalJs(`(function () {
    var s = Game2048Storage.get(Game2048Storage.KEYS.state, null);
    return s ? { mode: s.mode, log: s.reviewLog } : null;
  })()`);
  // Task 5 的双人入口若沿用「每日局才建日志」之外的路径，这里会残留上一局的日志；
  // 只要残留，下面的抽屉就会渲染出指标并给出导出按钮。
  check('切到双人后复盘日志被清空',
    Boolean(duelLog) && duelLog.mode === 'duel' && duelLog.log === null,
    JSON.stringify(duelLog));

  await click('#reviewOpen');
  await wait(320);
  check('双人下复盘抽屉照常打开（不崩）', (await hidden('#reviewSheet')) === false);

  const duelReview = JSON.parse(await evalJs(`(function () {
    return JSON.stringify({
      empty: document.querySelectorAll('#reviewBody .review-empty').length,
      metrics: document.querySelectorAll('#reviewBody .metrics').length,
      exportBtn: !!document.getElementById('reviewReport')
    });
  })()`));
  check('双人下复盘显示空状态（没有可复盘的对局）',
    duelReview.empty === 1 && duelReview.metrics === 0, JSON.stringify(duelReview));
  check('双人下不出现「导出今日战报」入口',
    duelReview.exportBtn === false, String(duelReview.exportBtn));

  await press('Escape');
  await wait(250);
  check('关闭复盘后仍是双人模式',
    (await evalJs('document.getElementById("modeGroup").querySelector("[data-mode=\\"duel\\"]")' +
      '.getAttribute("aria-pressed")')) === 'true');
  // 抽屉锁住棋盘，关闭后必须能立刻接着走：否则双人模式等于被抽屉卡死
  check('关闭复盘后双人棋盘还能走子', (await moveOnce()) === true,
    'moves=' + (await savedMoves()));

  /* ---------- I2 每日局战报的页脚次数 ---------- */
  // 红在哪：Task 4 的 buildModel 若把 attempt 换成 streak / attempts + 1，
  // 或 app 的 currentReportData 换了取数口径，页脚与每日条就会各说各话。
  console.log('\n[I2] 战报页脚的「第 N 次」与每日条一致');

  await wipe();
  // 同一天点两次：attempts = 2，streak 仍为 1。两数分叉，页脚读错哪个都藏不住。
  await click('#dailyChallenge');
  await wait(400);
  await click('#dailyChallenge');
  await wait(600);

  const reportKey = await evalJs('Game2048Rng.dateKey(new Date())');
  await inject({ daily: reportKey, values: BOARD_WIN_IN_ONE });

  const barMeta = (await text('#dailyMeta')) || '';
  const barAttempt = /第 (\d+) 次/.exec(barMeta);
  check('每日条显示了「第 N 次」', Boolean(barAttempt), barMeta);
  // 这是 I2 的区分力前提：N 必须与连续天数不同，否则「页脚读 attempt」与
  // 「页脚读 streak」都会得到同一个数，用例就抓不住后者。
  check('每日条的第 N 次已与连续天数分叉（N=2，连续 1 天）',
    Boolean(barAttempt) && barAttempt[1] === '2' && /连续 1 天/.test(barMeta), barMeta);

  // 把 buildModel 包一层记录入参：战报是 canvas，断言只能落在模型字段上。
  // 这里同时验证 app 传给 report 的 daily.attempt 与每日条同源。
  await evalJs(`(function () {
    window.__reportModels = [];
    window.__realBuildModel = Game2048Report.buildModel;
    Game2048Report.buildModel = function (data) {
      var model = window.__realBuildModel(data);
      window.__reportModels.push({
        footer: model.footer,
        attempt: data && data.daily ? data.daily.attempt : null,
        mode: data && data.mode
      });
      return model;
    };
    return 1;
  })()`);

  try {
    await withFixedRandom(async () => {
      await press('ArrowLeft');
      await wait(700);
    });
    check('每日局达成目标后浮层有「保存战报」', (await overlayLabels()).indexOf('保存战报') >= 0,
      (await overlayLabels()).join(' / '));

    const beforeDailySave = await text('#status');
    check('点了「保存战报」', (await clickOverlay('保存战报')) === true);
    const dailySaveStatus = await waitStatus(/战报已保存/, beforeDailySave);
    check('每日局战报保存成功', /战报已保存/.test(dailySaveStatus || ''), dailySaveStatus);

    const dailyModels = JSON.parse(await evalJs('JSON.stringify(window.__reportModels || [])'));
    const footerAttempt = dailyModels.length
      ? /第 (\d+) 次$/.exec(dailyModels[0].footer || '')
      : null;
    // Task 4 的 buildModel 若改成读 streak / attempts + 1，或 app 的 currentReportData
    // 换一个来源，这里两处 N 就会对不上（页脚是玩家能看到的同一张卡）。
    check('战报页脚带「第 N 次」', Boolean(footerAttempt),
      dailyModels.length ? dailyModels[0].footer : '(没有生成模型)');
    check('页脚的 N 与每日条一致（都是 2）',
      Boolean(footerAttempt && barAttempt) && footerAttempt[1] === '2' &&
        footerAttempt[1] === barAttempt[1],
      (footerAttempt ? footerAttempt[1] : '?') + ' vs ' + (barAttempt ? barAttempt[1] : '?'));
    check('app 传给战报的 attempt 也是同一个 N',
      Boolean(dailyModels.length && barAttempt) &&
        dailyModels[0].attempt === Number(barAttempt[1]),
      dailyModels.length ? String(dailyModels[0].attempt) : '(没有生成模型)');
  } finally {
    await evalJs('Game2048Report.buildModel = window.__realBuildModel, 1');
  }

  /* ---------- I3 托管 + 复盘 + 限时 ---------- */
  // 红在哪：Task 2 的抽屉暂停/恢复若把计时与托管拆开，或 Task 1 的 closeSheet 只把
  // 托管按钮点亮却不重新排期，这里的「计时继续走 / 步数继续涨」就会有一条红。
  console.log('\n[I3] 托管 + 复盘 + 限时：暂停与恢复');

  await inject({ mode: 'timed', values: BOARD_RIGHT_COL, remainingMs: 120000 });

  const clockAtStart = await text('#timer');
  await click('#autoplay');

  let movesRunning = 0;
  for (let i = 0; i < 40 && movesRunning < 2; i++) {
    await wait(100);
    movesRunning = await savedMoves();
  }
  check('托管在限时局里走起来了', movesRunning >= 2, 'moves=' + movesRunning);

  await click('#reviewOpen');
  await wait(400);   // 等在途的那一步收尾，再取冻结基准

  const frozenMoves = await savedMoves();
  const frozenClock = await text('#timer');
  check('抽屉打开时托管按钮已关', (await autoplayOn()) === false,
    'aria-pressed=' + (await evalJs('document.getElementById("autoplay").getAttribute("aria-pressed")')));

  await wait(1200);
  check('抽屉打开期间计时冻结', (await text('#timer')) === frozenClock,
    frozenClock + ' -> ' + (await text('#timer')));
  check('抽屉打开期间托管不再走子', (await savedMoves()) === frozenMoves,
    frozenMoves + ' -> ' + (await savedMoves()));

  await press('Escape');
  await wait(300);
  const resumedClock = await text('#timer');
  check('关掉复盘后托管恢复为「开」', (await autoplayOn()) === true,
    'aria-pressed=' + (await evalJs('document.getElementById("autoplay").getAttribute("aria-pressed")')));

  await wait(1600);
  // Task 2 的抽屉暂停若把计时与托管拆开恢复，这条会停在 00:0x 不动；
  // Task 1 的托管恢复若只把按钮点亮，步数同样不动 —— 两条一起锁。
  check('关掉复盘后计时恢复走动', (await text('#timer')) !== resumedClock,
    resumedClock + ' -> ' + (await text('#timer')));
  check('关掉复盘后托管继续走子', (await savedMoves()) > frozenMoves,
    frozenMoves + ' -> ' + (await savedMoves()));
  check('计时没有因为来回开门被重置', (await text('#timer')) !== clockAtStart,
    clockAtStart + ' -> ' + (await text('#timer')));

  if (await autoplayOn()) {
    await click('#autoplay');
    await wait(300);
  }

  /* ---------- I4 双人结束 → 经典 → 一步 → 战报 ---------- */
  // 红在哪：Task 5 的结算分支若把「双人无战报」写成全局的「结算无战报」，
  // 或 Task 4 的 reportAction 在模式切换后拿不到 settings / state，经典局就会没有入口。
  console.log('\n[I4] 双人结束后回经典，战报入口照常');

  await inject({
    mode: 'duel',
    values: [[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    players: [0, 0], turn: 0
  });

  await withFixedRandom(async () => {
    await press('ArrowLeft');
    await wait(800);
  });
  check('双人达成目标浮层打开', (await overlayHidden()) === false);
  check('双人结算标题指向刚走完的一方',
    (await text('#overlayTitle')) === '玩家 1 达成目标', await text('#overlayTitle'));
  check('双人结算不给「保存战报」（不计个人纪录）',
    (await overlayLabels()).indexOf('保存战报') < 0, (await overlayLabels()).join(' / '));

  check('点「再来一局」', (await clickOverlay('再来一局')) === true);
  await wait(600);
  await click('#modeGroup [data-mode="classic"]');
  await wait(700);

  check('切回经典后两块比分收起',
    await evalJs('document.getElementById("p1Block").hidden && ' +
      'document.getElementById("p2Block").hidden'));
  check('切回经典后能正常走一步', (await moveOnce()) === true,
    'moves=' + (await savedMoves()));

  // 关键：下面切模式走的是 UI（startNewGame），不 reload —— 双人那一局留在内存里的
  // 状态（结算闸门、复盘队列、autoplay 标志）都还在。换盘会整页重载、把内存状态冲掉，
  // 那就只能证明「从存档恢复的经典局能给战报入口」，与既有 e2e 重叠，所以这里不换盘。
  await evalJs('window.__i4Token = "same-page", 1');
  await click('#modeGroup [data-mode="timed"]');
  await wait(700);

  // 这条同时是上面那段的前提：token 还在，说明后面的结算断言确实跑在
  // 「双人那局之后、没有重载」的同一个页面上。
  check('切模式没有重载页面（双人那局的内存状态仍在）',
    (await evalJs('window.__i4Token')) === 'same-page',
    String(await evalJs('window.__i4Token')));
  check('限时局计时器出现', (await hidden('#timer')) === false);

  // 烧完 3 分钟走 showTimeOverlay：这个结算分支带 reportAction()，
  // 不需要换盘就能让「保存战报」出现。
  await withFakeClock(async () => {
    await wait(1500);
  });

  check('限时烧完触发结算', (await text('#overlayTitle')) === '时间到', await text('#overlayTitle'));
  check('双人之后限时结算重新出现「保存战报」', (await overlayLabels()).indexOf('保存战报') >= 0,
    (await overlayLabels()).join(' / '));

  const beforeTimedSave = await text('#status');
  check('点了「保存战报」', (await clickOverlay('保存战报')) === true);
  const timedSaveStatus = await waitStatus(/战报已保存/, beforeTimedSave);
  check('双人之后战报仍能保存（依赖没坏）', /战报已保存/.test(timedSaveStatus || ''), timedSaveStatus);

  /* ---------- I5 320px 窄屏 ---------- */
  console.log('\n[I5] 320px：模式按钮 / 双人比分块 / 战报按钮');

  if (!(await overlayHidden())) {
    await clickOverlay('再来一局');
    await wait(400);
  }

  await send('Emulation.setDeviceMetricsOverride', {
    width: 320, height: 568, deviceScaleFactor: 1, mobile: false
  });
  await wait(400);
  await click('#modeGroup [data-mode="duel"]');
  await wait(700);

  const narrow = JSON.parse(await evalJs(`(function () {
    // 前面的浮层按钮拿过焦点，页面可能已滚到棋盘；几何断言按整页顶部量才稳定
    window.scrollTo(0, 0);
    function box(el) {
      var r = el.getBoundingClientRect();
      return {
        left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        width: r.width, height: r.height,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth
      };
    }
    var chips = [];
    var nodes = document.querySelectorAll('#modeGroup [data-mode]');
    for (var i = 0; i < nodes.length; i++) {
      chips.push({
        mode: nodes[i].getAttribute('data-mode'),
        text: nodes[i].textContent,
        box: box(nodes[i])
      });
    }
    var blocks = [];
    ['p1Block', 'p2Block'].forEach(function (id) {
      var el = document.getElementById(id);
      blocks.push({ id: id, hidden: el.hidden, box: box(el) });
    });
    var app = box(document.getElementById('app'));
    var group = box(document.getElementById('modeGroup'));
    return JSON.stringify({
      chips: chips, blocks: blocks, group: group, app: app,
      docWidth: document.documentElement.scrollWidth,
      viewWidth: window.innerWidth
    });
  })()`));

  check('320px 下四个模式按钮都已渲染', narrow.chips.length === 4,
    narrow.chips.map((c) => c.text).join('/'));

  const chipClipped = narrow.chips.filter((c) => c.box.scrollWidth > c.box.clientWidth + 1);
  check('320px 下模式按钮文字不被截断', chipClipped.length === 0,
    chipClipped.map((c) => c.text).join(',') || 'ok');

  let chipOverlap = null;
  for (let i = 1; i < narrow.chips.length; i++) {
    if (narrow.chips[i - 1].box.right > narrow.chips[i].box.left + 0.5) {
      chipOverlap = narrow.chips[i - 1].text + '/' + narrow.chips[i].text;
    }
  }
  const lastChip = narrow.chips[narrow.chips.length - 1].box;
  check('320px 下四个模式按钮互不重叠', chipOverlap === null, chipOverlap || 'ok');
  check('320px 下第四个模式按钮不溢出模式条',
    lastChip.right <= narrow.group.right + 0.5 &&
      narrow.chips[0].box.left >= narrow.group.left - 0.5,
    Math.round(narrow.chips[0].box.left) + ' -> ' + Math.round(lastChip.right) +
      ' / group ' + Math.round(narrow.group.left) + ' -> ' + Math.round(narrow.group.right));

  check('320px 下两块双人比分都可见',
    narrow.blocks.every((b) => b.hidden === false), JSON.stringify(narrow.blocks.map((b) => b.hidden)));
  check('320px 下双人比分块不互相重叠、不溢出容器',
    narrow.blocks[0].box.right <= narrow.blocks[1].box.left + 0.5 &&
      narrow.blocks[1].box.right <= narrow.app.right + 0.5 &&
      narrow.blocks[0].box.left >= narrow.app.left - 0.5,
    narrow.blocks.map((b) => Math.round(b.box.left) + '->' + Math.round(b.box.right)).join(' '));
  check('320px 下比分数字没有被截断',
    narrow.blocks.every((b) => b.box.scrollWidth <= b.box.clientWidth + 1),
    narrow.blocks.map((b) => b.box.scrollWidth + '/' + b.box.clientWidth).join(' '));
  // 横向不重叠还不够：比分块若被状态行/模式条挤下去，纵向会压住下面的控件
  check('320px 下双人比分块不压到模式条',
    narrow.blocks[1].box.bottom <= narrow.group.top + 0.5 &&
      narrow.blocks[0].box.top >= 0,
    'p2.bottom ' + Math.round(narrow.blocks[1].box.bottom) +
      ' / group.top ' + Math.round(narrow.group.top));
  check('320px 下没有横向溢出', narrow.docWidth <= narrow.viewWidth,
    narrow.docWidth + ' <= ' + narrow.viewWidth);

  // 结算浮层里的「保存战报」：四个字在 320px 下不能撑破浮层
  await click('#modeGroup [data-mode="classic"]');
  await wait(600);
  await inject({ values: BOARD_WIN_IN_ONE });
  await withFixedRandom(async () => {
    await press('ArrowLeft');
    await wait(700);
  });

  const narrowOverlay = JSON.parse(await evalJs(`(function () {
    function box(el) {
      var r = el.getBoundingClientRect();
      return {
        left: r.left, right: r.right, width: r.width,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth
      };
    }
    var actions = document.getElementById('overlayActions');
    var buttons = [];
    Array.prototype.forEach.call(actions.querySelectorAll('button'), function (btn) {
      buttons.push({ text: btn.textContent, box: box(btn) });
    });
    return JSON.stringify({
      overlay: box(document.getElementById('overlay')),
      actions: box(actions),
      buttons: buttons,
      viewWidth: window.innerWidth
    });
  })()`));

  const reportBtn = narrowOverlay.buttons.filter((b) => b.text === '保存战报')[0];
  check('320px 下结算浮层仍有「保存战报」', Boolean(reportBtn),
    narrowOverlay.buttons.map((b) => b.text).join(' / '));
  check('320px 下战报按钮不溢出浮层',
    narrowOverlay.overlay.left >= -0.5 &&
      narrowOverlay.overlay.right <= narrowOverlay.viewWidth + 0.5 &&
      narrowOverlay.actions.scrollWidth <= narrowOverlay.actions.clientWidth + 1 &&
      narrowOverlay.buttons.every((b) =>
        b.box.left >= narrowOverlay.actions.left - 0.5 &&
        b.box.right <= narrowOverlay.actions.right + 0.5 &&
        b.box.scrollWidth <= b.box.clientWidth + 1),
    Math.round(narrowOverlay.overlay.left) + '->' + Math.round(narrowOverlay.overlay.right) +
      ' / vw ' + narrowOverlay.viewWidth);

  // 复盘底部的「导出今日战报」：撑满面板宽度的按钮，窄屏下同样不能顶出去
  await clickOverlay('再来一局');
  await wait(400);
  await evalJs(`(function () {
    var key = Game2048Rng.dateKey(new Date());
    Game2048Storage.set(Game2048Storage.KEYS.review + '.' + key, {
      version: 1, date: key,
      moves: [{
        d: 'left',
        v: [[2, 2, 4, 8], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        g: 4, b: null, s: null, t: null
      }],
      summary: null,
      meta: { score: 64, moves: 1, maxTile: 4, won: false }
    });
    return 1;
  })()`);
  await click('#reviewOpen');
  await wait(350);

  const narrowReview = JSON.parse(await evalJs(`(function () {
    var panel = document.querySelector('#reviewSheet .sheet__panel');
    var body = document.getElementById('reviewBody');
    var btn = document.getElementById('reviewReport');
    if (!btn) return JSON.stringify({ missing: true });
    function box(el) {
      var r = el.getBoundingClientRect();
      return {
        left: r.left, right: r.right, width: r.width,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth
      };
    }
    return JSON.stringify({
      missing: false,
      panel: box(panel), body: box(body), btn: box(btn),
      viewWidth: window.innerWidth
    });
  })()`));

  check('320px 下复盘里的战报按钮不溢出抽屉',
    narrowReview.missing === false &&
      narrowReview.btn.left >= narrowReview.panel.left - 0.5 &&
      narrowReview.btn.right <= narrowReview.panel.right + 0.5 &&
      narrowReview.btn.right <= narrowReview.viewWidth + 0.5 &&
      narrowReview.btn.scrollWidth <= narrowReview.btn.clientWidth + 1,
    narrowReview.missing ? '(没有按钮)' :
      Math.round(narrowReview.btn.left) + '->' + Math.round(narrowReview.btn.right) +
        ' / panel ' + Math.round(narrowReview.panel.left) + '->' + Math.round(narrowReview.panel.right));

  await press('Escape');
  await wait(250);

  /* ---------- I6 1280×800 棋盘不被裁 ---------- */
  console.log('\n[I6] 1280×800：棋盘与整页高度');

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false
  });
  await wait(400);

  const wide = JSON.parse(await evalJs(`(function () {
    var board = document.getElementById('board').getBoundingClientRect();
    var app = document.getElementById('app').getBoundingClientRect();
    var footer = document.querySelector('.footer').getBoundingClientRect();
    return JSON.stringify({
      top: board.top, bottom: board.bottom, width: board.width, height: board.height,
      appWidth: app.width,
      footerBottom: footer.bottom,
      docWidth: document.documentElement.scrollWidth,
      docHeight: document.documentElement.scrollHeight,
      viewWidth: window.innerWidth,
      viewHeight: window.innerHeight
    });
  })()`));

  // 下界不能省：退化成 0×0 的棋盘也能满足「不越界」，那样这条断言就白写了
  check('1280×800 下棋盘完整落在视口内且尺寸合理',
    wide.top >= 0 && wide.bottom <= wide.viewHeight + 0.5 && wide.height >= 300,
    Math.round(wide.top) + ' -> ' + Math.round(wide.bottom) +
      ' (h ' + Math.round(wide.height) + ') / vh ' + wide.viewHeight);
  check('1280×800 下棋盘不超出容器并保持可玩尺寸',
    wide.width <= wide.appWidth + 1 && wide.width >= 300,
    wide.width + ' / app ' + wide.appWidth);
  check('1280×800 下页脚没被挤出视口并整页无纵向滚动',
    wide.footerBottom <= wide.viewHeight + 0.5 && wide.docHeight <= wide.viewHeight + 1,
    'footer ' + Math.round(wide.footerBottom) + ' · doc ' + wide.docHeight +
      ' / vh ' + wide.viewHeight);
  check('1280×800 下没有横向溢出', wide.docWidth <= wide.viewWidth,
    wide.docWidth + ' <= ' + wide.viewWidth);

  /* ---------- I6b 1280×800 双人：每日条必须收起 ---------- */
  // 现有宽屏断言只在 classic 下跑，双人是这条预算的唯一漏网场景：
  // 两条信息条同时常驻会多出 43px（34 高 + 9 间距），把 368px 棋盘撑出滚动。
  console.log('\n[I6b] 1280×800 切到双人：每日条收起、页脚不溢出');

  await click('#modeGroup [data-mode="duel"]');
  await wait(700);

  const wideDuel = JSON.parse(await evalJs(`(function () {
    var footer = document.querySelector('.footer').getBoundingClientRect();
    var duel = document.getElementById('duelBar').getBoundingClientRect();
    return JSON.stringify({
      footerBottom: footer.bottom,
      docHeight: document.documentElement.scrollHeight,
      viewHeight: window.innerHeight,
      dailyHidden: document.getElementById('dailyBar').hidden,
      duelHidden: document.getElementById('duelBar').hidden,
      duelHeight: duel.height
    });
  })()`));

  check('1280×800 双人下每日条收起（不与双人回合条叠加）',
    wideDuel.dailyHidden === true, 'hidden=' + wideDuel.dailyHidden);
  check('1280×800 双人下双人回合条可见且有高度',
    wideDuel.duelHidden === false && wideDuel.duelHeight > 0,
    'hidden=' + wideDuel.duelHidden + ' · h=' + Math.round(wideDuel.duelHeight));
  check('1280×800 双人下页脚没被挤出视口且整页无纵向滚动',
    wideDuel.footerBottom <= wideDuel.viewHeight + 0.5 &&
      wideDuel.docHeight <= wideDuel.viewHeight + 1,
    'footer ' + Math.round(wideDuel.footerBottom) + ' · doc ' + wideDuel.docHeight +
      ' / vh ' + wideDuel.viewHeight);

  await send('Emulation.clearDeviceMetricsOverride');
  await wait(200);

  /* ---------- I7 手机视口：触控尺寸、首屏棋盘、真实滑动 ---------- */
  // 用 CDP 把 Chrome 变成触屏设备；只靠改窗口宽度不会让 (pointer: coarse) 命中，
  // 那样测到的仍是鼠标样式，下面的触控断言就没有意义。
  console.log('\n[I7] 手机视口 390×844 / 360×640 / 横屏 844×390');

  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // 固定右列盘面：左移必定能走，免得随机开局让滑动断言偶发失败
  await inject({ mode: 'classic', values: BOARD_RIGHT_COL, moves: 0 });
  await wait(400);

  /** 量一次当前视口：触控目标、棋盘几何、提示文案、媒体查询命中情况 */
  const phoneProbe = async () => JSON.parse(await evalJs(`(function () {
    function minHeight(list) {
      var min = Infinity;
      for (var i = 0; i < list.length; i++) {
        var h = list[i].getBoundingClientRect().height;
        if (h > 0 && h < min) min = h;
      }
      return min === Infinity ? 0 : Math.round(min);
    }
    var board = document.getElementById('board').getBoundingClientRect();
    var keys = document.querySelector('.hint--keys');
    var touch = document.querySelector('.hint--touch');
    var viewport = document.querySelector('meta[name="viewport"]');
    return JSON.stringify({
      coarse: window.matchMedia('(pointer: coarse)').matches,
      maxWidth: document.getElementById('board').style.maxWidth,
      viewportFit: /viewport-fit\\s*=\\s*cover/.test(viewport.getAttribute('content')),
      overscroll: getComputedStyle(document.body).overscrollBehaviorY,
      touchAction: getComputedStyle(document.querySelector('.btn')).touchAction,
      mainBtnMin: minHeight(document.querySelectorAll('.controls .btn')),
      chipMin: minHeight(document.querySelectorAll('#modeGroup [data-mode]')),
      keysHint: keys ? getComputedStyle(keys).display : 'missing',
      touchHint: touch ? getComputedStyle(touch).display : 'missing',
      board: { top: board.top, bottom: board.bottom, width: board.width, height: board.height },
      docWidth: document.documentElement.scrollWidth,
      viewWidth: window.innerWidth,
      viewHeight: window.innerHeight
    });
  })()`));

  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  await wait(500);
  const phone = await phoneProbe();

  check('触屏棋盘边长由实测写入（不再靠 CSS 猜固定开销）',
    parseInt(phone.maxWidth, 10) >= 260, phone.maxWidth);

  check('手机视口被识别为触屏（pointer: coarse 命中）', phone.coarse === true,
    'coarse=' + phone.coarse);
  check('viewport-fit=cover 与防回弹、防双击缩放都已生效',
    phone.viewportFit === true && phone.overscroll === 'none' &&
      phone.touchAction === 'manipulation',
    phone.viewportFit + ' · ' + phone.overscroll + ' · ' + phone.touchAction);
  check('提示文案切成「在棋盘上滑动」',
    phone.keysHint === 'none' && phone.touchHint !== 'none',
    phone.keysHint + ' / ' + phone.touchHint);
  check('手机下控制按钮触控目标 ≥36px、模式 chip ≥28px',
    phone.mainBtnMin >= 36 && phone.chipMin >= 28,
    'btn=' + phone.mainBtnMin + ' · chip=' + phone.chipMin);
  check('390×844 下棋盘完整落在首屏且尺寸可玩',
    phone.board.top >= 0 && phone.board.bottom <= phone.viewHeight + 1 &&
      phone.board.height >= 260 && phone.board.width >= 260,
    Math.round(phone.board.top) + '->' + Math.round(phone.board.bottom) +
      ' (' + Math.round(phone.board.width) + '×' + Math.round(phone.board.height) +
      ') / vh ' + phone.viewHeight);
  check('390×844 下没有横向溢出', phone.docWidth <= phone.viewWidth,
    phone.docWidth + ' <= ' + phone.viewWidth);

  // 真实滑动：派发带 pointerType:'touch' 的 PointerEvent，走的是玩家实际用的那条路径
  const movesBefore = await savedMoves();
  await evalJs(`(function () {
    var board = document.getElementById('board');
    var r = board.getBoundingClientRect();
    var x = r.left + r.width * 0.75;
    var y = r.top + r.height * 0.5;
    var base = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', button: 0 };
    board.dispatchEvent(new PointerEvent('pointerdown',
      Object.assign({ clientX: x, clientY: y }, base)));
    board.dispatchEvent(new PointerEvent('pointerup',
      Object.assign({ clientX: x - 90, clientY: y }, base)));
    return 1;
  })()`);
  await wait(700);
  const movesAfter = await savedMoves();
  check('触屏左滑能真的走一步', movesAfter === movesBefore + 1,
    movesBefore + ' -> ' + movesAfter);

  // 小屏竖屏：空间紧，但棋盘不能被压没、操作也不能溢出
  await send('Emulation.setDeviceMetricsOverride', {
    width: 360, height: 640, deviceScaleFactor: 2, mobile: true
  });
  await wait(500);
  const small = await phoneProbe();
  check('360×640 下棋盘完整落在首屏、按钮仍够大、无横向溢出',
    small.mainBtnMin >= 36 && small.chipMin >= 28 &&
      small.board.width >= 260 && small.board.height >= 260 &&
      small.board.top >= 0 && small.board.bottom <= small.viewHeight + 1 &&
      small.docWidth <= small.viewWidth,
    'btn=' + small.mainBtnMin + ' · chip=' + small.chipMin +
      ' · board=' + Math.round(small.board.width) +
      ' (' + Math.round(small.board.top) + '->' + Math.round(small.board.bottom) +
      ' / vh ' + small.viewHeight + ') · doc=' + small.docWidth);

  // 横屏：高度不够，允许纵向滚动，但棋盘不能被压成 0，也不能横向溢出
  await send('Emulation.setDeviceMetricsOverride', {
    width: 844, height: 390, deviceScaleFactor: 2, mobile: true
  });
  await wait(500);
  const landscape = await phoneProbe();
  check('844×390 横屏下棋盘仍可玩、无横向溢出',
    landscape.board.width >= 260 && landscape.board.height >= 260 &&
      landscape.docWidth <= landscape.viewWidth,
    Math.round(landscape.board.width) + '×' + Math.round(landscape.board.height) +
      ' · doc=' + landscape.docWidth + '/' + landscape.viewWidth);

  /* ---------- I7b 跟手性：拖动预览 / 抬手即走 / 高频连滑 / 地址栏不抖动 ---------- */
  console.log('\n[I7b] 拖动跟手 / 抬手即走 / 高频连滑不丢步');

  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  await wait(400);
  await inject({ mode: 'classic', values: BOARD_RIGHT_COL, moves: 0 });
  await wait(300);

  /** 构造一次真实走向的触摸手势；withUp=false 时只按下并拖动，用来看预览 */
  const touchGesture = (dir, delta, withUp) => evalJs(`(async function () {
    var board = document.getElementById('board');
    var r = board.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var dx = ${dir === 'left' ? -1 : dir === 'right' ? 1 : 0} * ${delta};
    var dy = ${dir === 'up' ? -1 : dir === 'down' ? 1 : 0} * ${delta};
    var base = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', button: 0 };
    function fire(type, cx, cy) {
      board.dispatchEvent(new PointerEvent(type,
        Object.assign({ clientX: cx, clientY: cy }, base)));
    }
    fire('pointerdown', x, y);
    fire('pointermove', x + dx * 0.5, y + dy * 0.5);
    fire('pointermove', x + dx, y + dy);
    if (${withUp ? 'true' : 'false'}) {
      fire('pointerup', x + dx, y + dy);
      await Promise.resolve();   // 只让微任务跑完，不等任何动画或定时器
    }
    var layer = document.getElementById('tileLayer');
    var saved = Game2048Storage.get(Game2048Storage.KEYS.state, null);
    return JSON.stringify({
      moves: saved ? saved.moves : -1,
      dragging: layer.classList.contains('is-dragging'),
      transform: layer.style.transform
    });
  })()`).then(JSON.parse);

  // 连续几帧 pointermove：位移必须逐帧变大，证明是实时贴合而不是抬手时跳一下
  const follow = JSON.parse(await evalJs(`(function () {
    var board = document.getElementById('board');
    var layer = document.getElementById('tileLayer');
    var r = board.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var base = { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch', button: 0 };
    function fire(type, cx, cy) {
      board.dispatchEvent(new PointerEvent(type,
        Object.assign({ clientX: cx, clientY: cy }, base)));
    }
    fire('pointerdown', x, y);
    var samples = [];
    [10, 25, 45, 70].forEach(function (d) {
      fire('pointermove', x - d, y);
      var m = /translate3d\\((-?[\\d.]+)px/.exec(layer.style.transform);
      samples.push(m ? Number(m[1]) : 0);
    });
    fire('pointercancel', x - 70, y);
    return JSON.stringify({ samples: samples, cleared: layer.style.transform === '' });
  })()`));
  check('连续 pointermove 位移逐帧递增（方块实时贴合手指）',
    follow.samples.length === 4 && follow.samples[0] < 0 &&
      follow.samples[1] < follow.samples[0] && follow.samples[2] < follow.samples[1] &&
      follow.samples[3] < follow.samples[2],
    follow.samples.join(' -> '));
  check('手势取消后跟手预览立即收干净', follow.cleared === true,
    String(follow.cleared));

  const held = await touchGesture('left', 60, false);
  check('拖动中方块层实时跟手（is-dragging + 非零位移）',
    held.dragging === true && /translate3d\(-\d/.test(held.transform),
    held.dragging + ' · ' + held.transform);
  check('拖动预览只是视觉位移，不提前落子', held.moves === 0, 'moves=' + held.moves);

  // 抬手方向要与上面按住的手势一致：另发一次完整手势，读的是「抬手后立刻」
  const released = await touchGesture('left', 60, true);
  check('抬手后不等动画立刻走一步（零延迟结算）', released.moves === 1,
    'moves=' + released.moves);
  check('抬手后跟手预览已清除', released.dragging === false && released.transform === '',
    released.dragging + ' · ' + released.transform);

  const beforeBurst = await savedMoves();
  const burstStart = Date.now();
  const burstDirs = ['left', 'right', 'left', 'right', 'left', 'right', 'left', 'right'];
  for (let i = 0; i < burstDirs.length; i++) {
    await touchGesture(burstDirs[i], 45, true);
  }
  const burstMs = Date.now() - burstStart;
  const afterBurst = await savedMoves();
  check('连续 8 次高频滑动一步不丢', afterBurst === beforeBurst + 8,
    beforeBurst + ' -> ' + afterBurst);
  check('8 步在 1 秒内跑完（没有被 285ms 动画串行拖住）', burstMs < 1000, burstMs + 'ms');

  // 地址栏收放只改高度；棋盘尺寸不能跟着抖，否则正拖到一半会失去参照
  const sizeBefore = await evalJs('document.getElementById("board").style.maxWidth');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 760, deviceScaleFactor: 2, mobile: true
  });
  await wait(350);
  const sizeAfter = await evalJs('document.getElementById("board").style.maxWidth');
  check('视口高度变化（地址栏收放）不改变棋盘尺寸', sizeAfter === sizeBefore,
    sizeBefore + ' -> ' + sizeAfter);

  /* ---------- I7c 更多机型：小屏 / 主流 / 大屏 / 平板 ---------- */
  console.log('\n[I7c] 更多机型尺寸：320×568 / 375×667 / 412×915 / 430×932 / 768×1024');
  const phoneSizes = [[320, 568], [375, 667], [412, 915], [430, 932], [768, 1024]];
  for (let i = 0; i < phoneSizes.length; i++) {
    const pw = phoneSizes[i][0];
    const ph = phoneSizes[i][1];
    await send('Emulation.setDeviceMetricsOverride', {
      width: pw, height: ph, deviceScaleFactor: 2, mobile: true
    });
    await wait(250);
    const p = await phoneProbe();
    check(pw + '×' + ph + ' 下棋盘可玩、无横向溢出、触控目标达标',
      p.board.width >= 260 && p.board.height >= 260 &&
        p.docWidth <= p.viewWidth && p.mainBtnMin >= 36 && p.chipMin >= 28,
      'board=' + Math.round(p.board.width) + ' · doc=' + p.docWidth + '/' + p.viewWidth +
        ' · btn=' + p.mainBtnMin + '/' + p.chipMin);
  }

  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Emulation.clearDeviceMetricsOverride');
  await wait(300);

  /* ---------- I8 控制台 ---------- */
  console.log('\n[I8] 控制台');
  const dateKey = await evalJs('Game2048Rng.dateKey(new Date())');
  const longLog = {version:1,date:dateKey,dropped:60,moves:Array.from({length:240},()=>({
    d:'left',v:CENTER_TILE,g:0,b:'left',s:1,t:1
  }))};
  await inject({values:CENTER_TILE,moves:300,daily:dateKey,reviewLog:longLog});
  await press('ArrowLeft');
  await wait(500);
  await press('z'); // 无修饰键不会撤销，随后走正式 Ctrl+Z。
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))`);
  await press('ArrowRight');
  await wait(500);
  await reload();
  await click('#reviewOpen');
  check('截断后走子、撤销、重走及刷新保留正确范围',
    (await text('#reviewBody')).includes('仅分析最近 240 步，前 61 步未包含'));

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
