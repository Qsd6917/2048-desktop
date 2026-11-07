/**
 * 控制器端到端回归（真实 Chrome + CDP，零第三方依赖，进仓库可复跑）。
 *
 * 覆盖 Task 4 返工修复的三条：
 *   1. 动画期间的按键不再被静默丢弃（1 格 pendingDir 缓冲；真走一步才关托管）；
 *   2. 「继续挑战」之后的第二次结算按增量补记统计（games 不重复加）；
 *   3. goalValue() 不再用 WIN_VALUE 兜底（4/5/6 各自 2048/4096/8192）。
 *
 * 用法：node test/app.e2e.js
 * 需要本机有 Chrome（或 Edge）；找不到时打印 SKIP 并以 0 退出，
 * 这样纯逻辑测试环境不会被浏览器依赖卡住。可用 CHROME_PATH 指定浏览器。
 */
'use strict';

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

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

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('SKIP 端到端回归：本机没有找到 Chrome / Edge（可设 CHROME_PATH 指定）');
    return;
  }
  if (typeof WebSocket !== 'function') {
    console.log('SKIP 端到端回归：当前 Node 没有全局 WebSocket（需 Node 22+）');
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

  /** 注入一份存档（含设置），重载后从这份盘面继续 */
  async function loadBoard(values, mode) {
    await evalJs(`(function () {
      Game2048Storage.set(Game2048Storage.KEYS.settings, { size: 4, mode: ${JSON.stringify(mode)}, sound: false });
      Game2048Storage.set(Game2048Storage.KEYS.state, {
        version: 2, size: 4, mode: ${JSON.stringify(mode)},
        values: ${JSON.stringify(values)},
        score: 0, won: false, keepPlaying: false,
        remainingMs: ${mode === 'timed' ? 180000 : 0},
        obstaclesAdded: 0, moves: 0
      });
      return 1;
    })()`);
    await reload();
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
  await evalJs(`(function () {
    window.__realNow = Date.now.bind(Date);
    var t0 = window.__realNow();
    Date.now = function () { return t0 + (window.__realNow() - t0) * 300; };
    return 1;
  })()`);
  await wait(1600);
  await evalJs('Date.now = window.__realNow, 1');

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

  /* ---------- T5 目标值不靠 WIN_VALUE 兜底 ---------- */
  console.log('\n[T5] 三尺寸目标值');
  await click('#modeGroup [data-mode="classic"]');
  await wait(400);

  const goals = [];
  const sizes = [4, 5, 6];
  for (let i = 0; i < sizes.length; i++) {
    await click('#sizeGroup [data-size="' + sizes[i] + '"]');
    await wait(400);
    goals.push(await text('#goal'));
  }
  check('4/5/6 目标值 2048/4096/8192', goals.join('/') === '2048/4096/8192', goals.join('/'));

  /* ---------- T6 控制台 ---------- */
  console.log('\n[T6] 控制台');
  check('无异常/报错', errors.length === 0, errors.join(' ; ').slice(0, 400));

  console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
  ws.close();
  chrome.kill();
  await wait(300);
  try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E 失败：', err);
  process.exit(2);
});
