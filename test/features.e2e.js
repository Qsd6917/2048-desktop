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

  /**
   * 轮询等粒子落笔。合并特效排在滑行动画之后（约 110ms），慢机上首帧可能更晚；
   * 单点采样一旦踩空就会假红，这里给约 1s 的预算。
   */
  async function waitForPixels(budgetMs) {
    const deadline = Date.now() + budgetMs;
    let pixels = 0;
    while (Date.now() < deadline) {
      pixels = await fxPixels();
      if (pixels > 0) return pixels;
      await wait(60);
    }
    return pixels;
  }

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

  // 独立起一局每日，注入一份已知盘面 + 非 0 分数：
  // 3 步可能一步都没合并，0 → 0 的分数断言等于没测。
  await wipe();
  await click('#dailyChallenge');
  await wait(400);
  const t2Key = await evalJs('Game2048Rng.dateKey(new Date())');
  await inject({ daily: t2Key, values: BOARD_RIGHT_COL, score: 120 });

  await playMoves(3);
  const beforeMoves = await stateMoves();
  const beforeScore = Number((await text('#score')).replace(/,/g, ''));
  const beforeSig = await sig();
  const beforeState = await savedState();
  const beforeLog = beforeState && beforeState.reviewLog
    ? beforeState.reviewLog.moves.length
    : -1;

  check('确实走了 3 步', beforeMoves === 3, String(beforeMoves));
  check('刷新前的分数不为 0（恢复断言才有区分力）', beforeScore > 0, String(beforeScore));
  check('复盘日志与步数一致', beforeLog === beforeMoves, beforeLog + ' / ' + beforeMoves);

  await reload();

  check('刷新后分数恢复到刷新前',
    Number((await text('#score')).replace(/,/g, '')) === beforeScore,
    beforeScore + ' -> ' + (await text('#score')));
  check('刷新后盘面完全一致', (await sig()) === beforeSig);
  check('刷新后每日条仍是「第 1 次」', /第 1 次/.test(await text('#dailyMeta')),
    await text('#dailyMeta'));
  check('刷新后每日条按钮变成「重新开始」', (await text('#dailyStart')) === '重新开始',
    await text('#dailyStart'));

  // 复盘面板只能从恢复出来的日志渲染：日志没续上就会退回空状态。
  // 这一步必须在「再走一步」之前看，否则新的一步也会让面板变成非空。
  await click('#reviewOpen');
  await wait(260);
  // 空状态里没有 .metric：取不到就返回 null，让断言报红而不是整个套件抛异常
  const reviewScore = await evalJs(`(function () {
    var el = document.querySelector('#reviewBody .metric .metric__value');
    return el ? el.textContent.replace(/,/g, '') : null;
  })()`);
  check('刷新后复盘面板续上了这一局（不是空状态）',
    (await evalJs('document.querySelectorAll("#reviewBody .review-empty").length')) === 0 &&
      (await evalJs('document.querySelectorAll("#reviewBody .metrics").length')) === 1);
  check('复盘面板的分数与刷新前一致', reviewScore === String(beforeScore),
    reviewScore + ' vs ' + beforeScore);

  await press('Escape');
  await wait(200);
  check('Esc 关闭复盘', (await hidden('#reviewSheet')) === true);

  // 再走一步：应用会重新落盘，此时读到的步数只能是 3 -> 4。
  // 若 readSaved 把 moves 丢了，这里会从 1 开始数，断言就会红。
  const dirs = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];
  let afterMoves = beforeMoves;
  for (let i = 0; i < dirs.length && afterMoves === beforeMoves; i++) {
    await press(dirs[i]);
    await wait(500);
    afterMoves = await stateMoves();
  }

  check('刷新后再走一步，步数从 3 接着数到 4', afterMoves === 4,
    beforeMoves + ' -> ' + afterMoves);

  const afterState = await savedState();
  const afterLog = afterState && afterState.reviewLog
    ? afterState.reviewLog.moves.length
    : -1;

  check('刷新后复盘日志从 3 步接着记到 4 步', afterLog === 4, beforeLog + ' -> ' + afterLog);
  check('刷新后复盘日志仍属于今天',
    Boolean(afterState) && afterState.daily === t2Key,
    afterState && afterState.daily);

  /* ---------- T2b 坏存档的标量钳制 ---------- */
  console.log('\n[T2b] 坏存档：Infinity / 超大 rngCount 不冻死页面');

  const badKey = await evalJs('Game2048Rng.dateKey(new Date())');
  await wipe();
  await evalJs(`(function () {
    var key = ${JSON.stringify(badKey)};
    Game2048Storage.set(Game2048Storage.KEYS.settings, { size: 4, mode: 'classic', sound: false });
    // 手改存档：JSON 里的 1e999 会解析成 Infinity，1e12 是会让 Rng.skip 空转到冻页面的值
    localStorage.setItem('game2048.v2.state',
      '{"version":2,"size":4,"mode":"classic",' +
      '"values":[[2,0,0,0],[0,4,0,0],[0,0,8,0],[0,0,0,16]],' +
      '"score":1e999,"won":false,"keepPlaying":false,"remainingMs":1e999,' +
      '"obstaclesAdded":1e12,"moves":3,"recordedMoves":3,"perfectRecorded":1e12,' +
      '"daily":"' + key + '","rngCount":1e12,"dailyRecorded":true,"dailyRecordedMoves":3}');
    return 1;
  })()`);
  await reload();   // 没有钳制时，Rng.skip(1e12) 会把页面冻在首帧，reload 直接超时

  check('Infinity 分数折成 0 而不是显示 Infinity',
    (await text('#score')) === '0', await text('#score'));

  await press('ArrowRight');
  await wait(500);
  const clamped = await savedState();
  check('超大 rngCount 被钳到 1e5 附近（不是 1e12）',
    Boolean(clamped) && clamped.rngCount <= 100010,
    clamped && String(clamped.rngCount));
  check('超大 obstaclesAdded 被钳到盘面格数以内',
    Boolean(clamped) && clamped.obstaclesAdded <= 16,
    clamped && String(clamped.obstaclesAdded));
  check('正常步数不被坏字段带偏', Boolean(clamped) && clamped.moves === 4,
    clamped && String(clamped.moves));

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

  /* ---------- T4b 落盘 summary 被写坏时，复盘抽屉与计时都要活着 ---------- */
  console.log('\n[T4b] 落盘 summary 是 {} 时：抽屉照常打开，关闭后计时恢复');

  await wipe();
  await evalJs(`(function () {
    var key = Game2048Rng.dateKey(new Date());
    var grid = [[1024, 512, 64, 8], [32, 128, 16, 4], [8, 32, 2, 0], [4, 16, 0, 0]];
    Game2048Storage.set(Game2048Storage.KEYS.settings, { size: 4, mode: 'timed', sound: false });
    Game2048Storage.set(Game2048Storage.KEYS.state, {
      version: 2, size: 4, mode: 'timed',
      values: [[2, 2, 0, 0], [4, 8, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      score: 0, won: false, keepPlaying: false,
      remainingMs: 60000, obstaclesAdded: 0, moves: 0,
      recorded: false, recordedMoves: 0,
      daily: key, rngCount: 0, dailyRecorded: false, dailyRecordedMoves: 0,
      // 进行中的日志还是空壳，复盘只能拿落盘的那份（summary 已经被写坏）
      reviewLog: { version: 1, date: key, moves: [], summary: null }
    });
    Game2048Storage.set(Game2048Storage.KEYS.review + '.' + key, {
      version: 1, date: key,
      moves: [
        { d: 'left', v: grid, g: 8, b: 'left', s: 10, t: 10 },
        { d: 'right', v: grid, g: 8, b: 'up', s: 12, t: 9 }
      ],
      summary: {},   // 手改 / 写截断的样子
      meta: { score: 480, moves: 2, maxTile: 1024, won: false }
    });
    return 1;
  })()`);
  await reload();

  const timerBefore = await text('#timer');
  await click('#reviewOpen');
  await wait(1200);

  check('脏 summary 也能打开复盘抽屉', (await hidden('#reviewSheet')) === false);
  check('抽屉用日志重算出了四格指标',
    (await evalJs('document.querySelectorAll("#reviewBody .metrics .metric").length')) === 4);
  const consistency = await evalJs(`(function () {
    var items = document.querySelectorAll('#reviewBody .metric');
    for (var i = 0; i < items.length; i++) {
      if (items[i].querySelector('.metric__label').textContent === '一致性') {
        return items[i].querySelector('.metric__value').textContent;
      }
    }
    return null;
  })()`);
  check('一致性由日志重算（2 步里对 1 步 = 50%）', consistency === '50%', consistency);
  check('抽屉打开期间限时局不扣时', (await text('#timer')) === timerBefore,
    timerBefore + ' -> ' + (await text('#timer')));

  await press('Escape');
  await wait(1400);
  check('关闭复盘后限时局恢复计时', (await text('#timer')) !== timerBefore,
    timerBefore + ' -> ' + (await text('#timer')));

  /* ---------- T4c 启动时清理过期复盘键 ---------- */
  console.log('\n[T4c] 启动时清掉过期 review.<日期>，保留期内的不动');

  await evalJs(`(function () {
    var today = Game2048Rng.dateKey(new Date());
    var old = Game2048Daily.shiftKey(today, -100);           // 超出保留期、但在 maxAge 120 天以内
    var yesterday = Game2048Daily.shiftKey(today, -1);       // 保留期内
    localStorage.setItem('game2048.v2.review.' + old, '{"moves":[]}');
    Game2048Storage.set('review.' + yesterday, { version: 1, date: yesterday, moves: [], summary: null });
    return 1;
  })()`);

  const purgeList = JSON.parse(await evalJs(`(function () {
    var today = Game2048Rng.dateKey(new Date());
    var old = Game2048Daily.shiftKey(today, -100);
    var list = Game2048Review.staleKeys(today, 14, 120);
    return JSON.stringify({ length: list.length, old: old, hasOld: list.indexOf('review.' + old) >= 0 });
  })()`));
  check('页面里算出的清理列表覆盖 100 天前的键',
    purgeList.length === 106 && purgeList.hasOld === true, JSON.stringify(purgeList));

  await reload();

  const purge = JSON.parse(await evalJs(`(function () {
    var today = Game2048Rng.dateKey(new Date());
    var old = Game2048Daily.shiftKey(today, -100);
    var yesterday = Game2048Daily.shiftKey(today, -1);
    return JSON.stringify({
      today: localStorage.getItem('game2048.v2.review.' + today) !== null,
      yesterday: localStorage.getItem('game2048.v2.review.' + yesterday) !== null,
      old: localStorage.getItem('game2048.v2.review.' + old) !== null
    });
  })()`));

  check('超出保留期的复盘键被清掉', purge.old === false, JSON.stringify(purge));
  check('保留期内的复盘键原样还在', purge.today === true && purge.yesterday === true,
    JSON.stringify(purge));

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

  /* ---------- T5b 换局清掉上一局的特效 ---------- */
  console.log('\n[T5b] 通关后立刻「新游戏」，上一局的彩带不能落在新棋盘上');

  await wipe();
  await click('#dailyChallenge');
  await wait(400);
  const winKey = await evalJs('Game2048Rng.dateKey(new Date())');
  await inject({ daily: winKey, values: [[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] });

  await press('ArrowLeft');
  const winPixels = await waitForPixels(1500);
  check('通关时彩带真的画在粒子层上', winPixels > 0, 'alpha px=' + winPixels);

  // 彩带在滑行动画后就开撒，浮层要等动画收尾才弹：先等浮层真的打开再断言层叠
  for (let i = 0; i < 30 && (await hidden('#overlay')); i++) await wait(100);

  // 彩带在飞的同时，浮层文字必须压在粒子之上（M2 的层叠回归）
  const stack = JSON.parse(await evalJs(`(function () {
    var canvas = document.getElementById('fx');
    var title = document.getElementById('overlayTitle');
    var rect = title.getBoundingClientRect();
    var hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return JSON.stringify({
      overlayOpen: !document.getElementById('overlay').hidden,
      bodyClass: document.body.classList.contains('is-overlay-open'),
      z: getComputedStyle(canvas).zIndex,
      hitTag: hit ? hit.tagName : null
    });
  })()`));

  check('浮层打开时 #fx 降到 0 层（应用抬到粒子之上）',
    stack.overlayOpen === true && stack.z === '0', stack.z);
  check('浮层打开时 body 挂上 is-overlay-open', stack.bodyClass === true);
  check('浮层标题中心取到的不是 canvas', stack.hitTag !== 'CANVAS', String(stack.hitTag));

  await click('#newGame');
  await wait(200);
  const afterRestart = await fxPixels();
  check('点「新游戏」后上一局特效被清空', afterRestart === 0, 'alpha px=' + afterRestart);

  const zState = JSON.parse(await evalJs(`(function () {
    return JSON.stringify({
      z: getComputedStyle(document.getElementById('fx')).zIndex,
      bodyClass: document.body.classList.contains('is-overlay-open')
    });
  })()`));
  check('浮层关闭后 #fx 回到 40 层', zState.z === '40', zState.z);
  check('浮层关闭后 body 的类也摘掉', zState.bodyClass === false);

  /* ---------- T5c reduce 下抽屉没有入场动画 ---------- */
  console.log('\n[T5c] reduce-motion：抽屉不做淡入/滑入');

  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  });
  await click('#reviewOpen');
  await wait(80);

  const sheetAnim = JSON.parse(await evalJs(`(function () {
    var sheet = document.getElementById('reviewSheet');
    var panel = sheet.querySelector('.sheet__panel');
    return JSON.stringify({
      open: !sheet.hidden,
      sheetName: getComputedStyle(sheet).animationName,
      panelName: getComputedStyle(panel).animationName
    });
  })()`));
  check('reduce 下抽屉照常打开', sheetAnim.open === true);
  check('reduce 下 .sheet 的 animation-name 为 none',
    sheetAnim.sheetName === 'none', sheetAnim.sheetName);
  check('reduce 下 .sheet__panel 的 animation-name 为 none',
    sheetAnim.panelName === 'none', sheetAnim.panelName);

  await press('Escape');
  await wait(150);
  await send('Emulation.setEmulatedMedia', { features: [] });
  check('撤销 reduce 模拟后抽屉已关闭', (await hidden('#reviewSheet')) === true);

  /* ---------- T6 四模块联动冒烟 ---------- */
  console.log('\n[T6] 四模块联动：一步合并打穿四个模块');

  await wipe();
  await click('#dailyChallenge');
  await wait(400);
  const todayKey = await evalJs('Game2048Rng.dateKey(new Date())');
  await inject({ daily: todayKey, values: BOARD_MERGE_PAIR });

  const mergesBefore = (await savedProfile()).stats.merges;

  await press('ArrowLeft');
  const pixelCount = await waitForPixels(1000);
  await wait(300);

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
      games: 14, bestScore: 32000, bestTile: 2048, totalMoves: 900,
      bySize: {
        '4': { games: 11, bestScore: 32000 },   // 打过大分
        '5': { games: 3, bestScore: 0 },        // 打完但一分没拿，也要算玩过
        '6': { games: 0, bestScore: 0 }         // 只有空档，没真打过
      }
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
  check('玩过的尺寸都播种（0 分收场的局也算）',
    Boolean(seeded) && seeded.stats.sizes['4'] === 1 && seeded.stats.sizes['5'] === 1,
    JSON.stringify(seeded && seeded.stats.sizes));
  check('没打过的尺寸不播种',
    Boolean(seeded) && seeded.stats.sizes['6'] === undefined,
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

  // 每日条默认 hidden：元素不参与布局时 rect 全是 0，
  // 不断言它可见，下面的「不溢出 / 不重叠」就是恒真的空断言。
  await click('#dailyChallenge');
  await wait(500);

  const barVisible = (await evalJs('document.getElementById("dailyBar").hidden')) === false;
  check('320px 下每日条真的可见（几何断言才有意义）', barVisible);

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
      dailyHidden: document.getElementById('dailyBar').hidden,
      docWidth: document.documentElement.scrollWidth,
      viewWidth: window.innerWidth
    });
  })()`));

  check('窄屏探测取到了两排按钮与三段每日条',
    narrow.rows.length === 2 && narrow.rows[0].length === 5 &&
      narrow.rows[1].length === 3 && narrow.kids.length === 3,
    narrow.rows.map((row) => row.length).join('/') + ' · kids=' + narrow.kids.length);
  check('窄屏探测时每日条仍可见（不是靠 hidden 蒙混）',
    narrow.dailyHidden === false && narrow.daily.right > narrow.daily.left + 100 &&
      narrow.daily.width > 0,
    'hidden=' + narrow.dailyHidden + ' w=' + narrow.daily.width);

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
    // 真实测量：页脚、状态行、两排控制条与设置面板的最下缘
    function bottom(selector) {
      var el = document.querySelector(selector);
      return el ? el.getBoundingClientRect().bottom : 0;
    }
    var rows = ['.controls', '.controls--sub', '.settings'];
    var controlsBottom = 0;
    for (var i = 0; i < rows.length; i++) {
      var b = bottom(rows[i]);
      if (b > controlsBottom) controlsBottom = b;
    }
    return JSON.stringify({
      top: board.top, bottom: board.bottom, width: board.width,
      appWidth: app.width,
      footerBottom: bottom('.footer'),
      statusBottom: bottom('#status'),
      controlsBottom: controlsBottom,
      docHeight: document.documentElement.scrollHeight,
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
  // 高度预算的实测：页脚 / 状态行 / 控制条都必须真的落在视口内，
  // 且整页不能有纵向滚动（scrollHeight 比 innerHeight 多 1px 以内算舍入）
  check('1280×800 下页脚、状态行、控制条都没被挤出视口',
    wide.footerBottom <= wide.viewHeight + 0.5 &&
      wide.statusBottom <= wide.viewHeight + 0.5 &&
      wide.controlsBottom <= wide.viewHeight + 0.5,
    'footer ' + Math.round(wide.footerBottom) +
      ' · status ' + Math.round(wide.statusBottom) +
      ' · controls ' + Math.round(wide.controlsBottom) + ' / vh ' + wide.viewHeight);
  check('1280×800 下没有纵向溢出',
    wide.docHeight <= wide.viewHeight + 1,
    wide.docHeight + ' <= ' + wide.viewHeight + ' + 1');

  await send('Emulation.clearDeviceMetricsOverride');
  await wait(200);

  /* ---------- T10 结算后补算的评分回流落盘 ---------- */
  console.log('\n[T10] 结算瞬间只算完几步时，补算结果要回写落盘');

  // 在页面脚本之前挂一个观测器：记下每一次 review.<date> 落盘的 summary.scored。
  // 这样「结算那份」和「排空后的回写」都能拿到确定值，不受 CDP 采样时机影响。
  const observer = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(function () {
      var api = null;
      window.__reviewWrites = [];
      Object.defineProperty(window, 'Game2048Storage', {
        configurable: true,
        get: function () { return api; },
        set: function (value) {
          api = value;
          var original = value.set;
          value.set = function (key, val) {
            if (typeof key === 'string' && key.indexOf('review.') === 0 && val && val.summary) {
              window.__reviewWrites.push(val.summary.scored);
            }
            return original(key, val);
          };
        }
      });
    })()`
  });

  // 32 步待评分（b 全为 null）；6×6 盘面 + 12 个方块，AI 每步都会吃满 24ms 预算 ——
  // 结算时的 60ms 预算最多算完两三步，剩下的只能靠空闲回调继续算。
  const pendingKey = await evalJs(`(function () {
    var key = Game2048Rng.dateKey(new Date());
    var moves = [];
    for (var i = 0; i < 32; i++) {
      var v = [];
      for (var r = 0; r < 6; r++) {
        var row = [];
        for (var c = 0; c < 6; c++) {
          row.push((r + c) % 3 === 0 ? Math.pow(2, 1 + ((r * 6 + c) % 6)) : 0);
        }
        v.push(row);
      }
      moves.push({ d: 'left', v: v, g: 8, b: null, s: null, t: null });
    }
    Game2048Storage.set(Game2048Storage.KEYS.settings, { size: 4, mode: 'timed', sound: false });
    Game2048Storage.set(Game2048Storage.KEYS.state, {
      version: 2, size: 4, mode: 'timed',
      values: [[2, 2, 0, 0], [4, 8, 0, 0], [16, 32, 0, 0], [64, 128, 0, 0]],
      score: 120, won: false, keepPlaying: false,
      // 200ms 后第一次 tick 就超时结算：此时队列里必然还压着大部分待评分
      remainingMs: 200, obstaclesAdded: 0, moves: 32,
      recorded: false, recordedMoves: 0,
      daily: key, rngCount: 0, dailyRecorded: false, dailyRecordedMoves: 0,
      perfectRecorded: 0,
      reviewLog: { version: 1, date: key, moves: moves, summary: null }
    });
    return key;
  })()`);
  await reload();

  const reviewStored = () => evalJs(`(function () {
    var log = Game2048Storage.get(Game2048Storage.KEYS.review + '.' + ${JSON.stringify(pendingKey)}, null);
    if (!log || !log.moves) return JSON.stringify(null);
    var scored = 0;
    for (var i = 0; i < log.moves.length; i++) {
      var m = log.moves[i];
      // 与 summarize 同一判定口径：方向与两个分数都齐才算「算完」
      if (m && m.b !== null && typeof m.s === 'number' && typeof m.t === 'number') scored++;
    }
    return JSON.stringify({
      total: log.moves.length,
      scoredEntries: scored,
      summaryScored: log.summary ? log.summary.scored : -1,
      writes: window.__reviewWrites || [],
      overlay: !document.getElementById('overlay').hidden
    });
  })()`);

  let settle = null;
  for (let i = 0; i < 120 && !settle; i++) {
    const snap = JSON.parse(await reviewStored());
    if (snap && snap.overlay) settle = snap;
    else await wait(50);
  }
  check('超时结算真的发生并落盘了复盘',
    Boolean(settle) && settle.total === 32 && settle.writes.length >= 1,
    settle && 'total ' + settle.total + ' · writes ' + JSON.stringify(settle.writes));

  let drained = settle;
  for (let i = 0; i < 200; i++) {
    if (drained && drained.scoredEntries === drained.total &&
        drained.summaryScored === drained.total) break;
    await wait(100);
    const snap = JSON.parse(await reviewStored());
    if (snap) drained = snap;
  }

  check('队列排空后所有步都算完了评分',
    Boolean(drained) && drained.scoredEntries === drained.total,
    drained && drained.scoredEntries + ' / ' + drained.total);
  check('结算瞬间落盘的是半成品（说明补算确有积压）',
    Boolean(settle) && settle.writes[0] < settle.total,
    settle && settle.writes[0] + ' / ' + settle.total);
  check('排空后又落了一次盘，scored 追平全部步数',
    Boolean(drained) && drained.writes.length >= 2 &&
      drained.writes[drained.writes.length - 1] === drained.total,
    drained && JSON.stringify(drained.writes));
  check('落盘 summary.scored 单调不减（重复落盘不会回退）',
    Boolean(drained) && drained.writes.every((v, i) => i === 0 || v >= drained.writes[i - 1]),
    drained && JSON.stringify(drained.writes));

  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: observer.identifier });

  /* ---------- T11 控制台 ---------- */
  console.log('\n[T11] 控制台');
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
