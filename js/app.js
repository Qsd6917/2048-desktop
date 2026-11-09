/**
 * 2048 控制器 —— 玩法状态机、输入、模式、托管、提示、统计与音效。
 *
 * 分工：
 *   - 规则（合并、障碍、胜负）全在 js/logic.js，这里不重复实现；
 *   - 走子决策在 js/ai.js；
 *   - 棋盘的 DOM 与动画全在 js/renderer.js，这里只下指令；
 *   - 存档在 js/storage.js，声音在 js/audio.js。
 *
 * 状态机的两个核心不变式：
 *   1. 一局只有一个 session 号。换局 / 撤销都会 +1，所有挂在异步回调上的旧逻辑
 *      先比对 session，不匹配就立刻退出，绝不改动新一局的状态。
 *   2. 动画在播（state.busy）时不再启动新的一步，避免连续走子把动画堆叠起来；
 *      但玩家这期间的输入不丢：留一格 pendingDir，等这一步收尾时兑现。
 *      托管走同一条路径，所以托管也不会自己踩自己。
 */
(function (global) {
  'use strict';

  var G = global.Game2048;
  var AI = global.Game2048AI;
  var Renderer = global.Game2048Renderer;
  var Storage = global.Game2048Storage;
  var Audio = global.Game2048Audio;
  var Rng = global.Game2048Rng;
  var Daily = global.Game2048Daily;
  var Duel = global.Game2048Duel;
  var Review = global.Game2048Review;
  var Achievements = global.Game2048Achievements;
  var Fx = global.Game2048Fx;
  var Report = global.Game2048Report;

  /* ---------- 常量 ---------- */

  /** 撤销栈深度 */
  var UNDO_LIMIT = 20;
  /** 触摸滑动的最小位移，太小会被当成点击 */
  var SWIPE_THRESHOLD = 24;
  /** 触屏抬手判定用的更小阈值：手指短促一划也该走一步 */
  var SWIPE_THRESHOLD_TOUCH = 12;
  /** 拖动跟手：超过这个位移就锁定主轴，抬手不再被抖动改方向 */
  var DRAG_LOCK_PX = 6;
  /** 方块跟随手指的比例；小于 1 是阻尼，避免整块棋盘被拖飞 */
  var DRAG_FOLLOW = 0.55;
  /** 跟手位移上限，按棋盘边长的比例算 */
  var DRAG_MAX_RATIO = 0.22;
  /** 触屏按实测高度定棋盘边长时的下限与留白 */
  var FIT_MIN_PX = 260;
  var FIT_GAP_PX = 6;
  /** 托管每一步之间的间隔 */
  var AUTOPLAY_DELAY_MS = 220;
  /** 方向提示的光晕时长 */
  var HINT_MS = 600;
  /** 剩余时间进入「紧急」样式的阈值 */
  var URGENT_MS = 30000;
  /** 障碍模式每走多少步长一个障碍 */
  var OBSTACLE_EVERY = 10;
  /** 给 AI 的时间预算；托管每步只等 220ms，这里必须留余量 */
  var AI_BUDGET_MS = 120;
  /** 倒计时刷新间隔 */
  var TICK_MS = 200;
  /** 跨日检查间隔：页面一直开着也要能在午夜后放弃旧的每日身份 */
  var DAILY_CHECK_MS = 60000;
  /** 复盘异步评分：单步给 AI 的时间预算（必须在空闲回调里跑，不能拖慢走子） */
  var EVAL_BUDGET_MS = 24;
  /** 复盘评分队列上限：积压太多时丢最旧的，宁可少评几步也不无限占内存 */
  var EVAL_QUEUE_LIMIT = 32;
  /** requestIdleCallback 的兜底超时：一直没空闲也必须找机会算 */
  var EVAL_IDLE_TIMEOUT_MS = 400;
  /** 结算时同步补算剩余评分的总预算 */
  var FLUSH_BUDGET_MS = 60;
  /** 滑行动画时长：粒子要与合成块弹出的同一帧出现，必须和 renderer 的 SLIDE_MS 一致 */
  var SLIDE_MS = 110;
  /** 连击清零的空档阈值 */
  var COMBO_GAP_MS = 1200;
  /** 连击上限：再多也只是同一个音，没必要无限涨 */
  var COMBO_MAX = 9;
  /** 到这个连击数才给扫光与状态提示 */
  var COMBO_FX_AT = 3;
  /** 大块合并的门槛：到这个值，音频加高八度、视觉加环与震屏 */
  var ACCENT_VALUE = 256;
  /** 读档标量上界：手改/损坏存档写进 1e12 或 Infinity 时不能被当真 */
  var SAVE_MAX_SCORE = 1e9;
  var SAVE_MAX_MOVES = 1e6;
  /** rngCount 上限：一局 240 步 × 4 次取数也远小于它，再大只能是在冻页面 */
  var SAVE_MAX_RNG_COUNT = 1e5;
  /** 成就解锁提示：同屏最多几条 */
  var TOAST_LIMIT = 3;
  /** 成就解锁提示的停留时长 */
  var TOAST_MS = 4000;
  /**
   * 焦点陷阱的候选元素。
   * 刻意只收这几种：模态里可聚焦的东西就这些，多开会把静态文本也卷进循环。
   */
  var FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  /**
   * 四种玩法模式；timeLimitMs 为 0 表示不计时，obstacles 是开局埋的障碍数。
   * duel 只是把得分拆成两人份，棋盘规则仍是同一套（见 js/duel.js）。
   */
  var MODES = {
    classic: { label: '经典', timeLimitMs: 0, obstacles: 0 },
    timed: { label: '限时', timeLimitMs: 180000, obstacles: 0 },
    obstacle: { label: '障碍', timeLimitMs: 0, obstacles: 2 },
    duel: { label: '双人', timeLimitMs: 0, obstacles: 0 }
  };

  var DIR_LABEL = { up: '上', right: '右', down: '下', left: '左' };

  var KEY_TO_DIR = {
    arrowleft: 'left',
    arrowright: 'right',
    arrowup: 'up',
    arrowdown: 'down',
    a: 'left',
    d: 'right',
    w: 'up',
    s: 'down'
  };

  /* ---------- DOM ---------- */

  var els = {
    app: document.getElementById('app'),
    board: document.getElementById('board'),
    grid: document.getElementById('gridLayer'),
    tiles: document.getElementById('tileLayer'),
    score: document.getElementById('score'),
    scoreBox: document.getElementById('scoreBox'),
    bestBox: document.getElementById('bestBox'),
    // 双人：两个玩家分数块与回合条；非双人模式整块隐藏
    p1Block: document.getElementById('p1Block'),
    p2Block: document.getElementById('p2Block'),
    p1Score: document.getElementById('p1Score'),
    p2Score: document.getElementById('p2Score'),
    duelBar: document.getElementById('duelBar'),
    turnLabel: document.getElementById('turnLabel'),
    best: document.getElementById('best'),
    gain: document.getElementById('scoreGain'),
    goal: document.getElementById('goal'),
    maxTile: document.getElementById('maxTile'),
    timer: document.getElementById('timer'),
    overlay: document.getElementById('overlay'),
    overlayTitle: document.getElementById('overlayTitle'),
    overlayText: document.getElementById('overlayText'),
    overlayActions: document.getElementById('overlayActions'),
    newGame: document.getElementById('newGame'),
    undo: document.getElementById('undo'),
    status: document.getElementById('status'),
    // 视觉隐藏的播报节点：每步的得分 / 步数只写可视行，别占满 polite live region
    statusAnnounce: document.getElementById('statusAnnounce'),
    hint: document.getElementById('hint'),
    autoplay: document.getElementById('autoplay'),
    openSettings: document.getElementById('openSettings'),
    settingsPanel: document.getElementById('settingsPanel'),
    sizeGroup: document.getElementById('sizeGroup'),
    modeGroup: document.getElementById('modeGroup'),
    soundToggle: document.getElementById('soundToggle'),
    dailyBar: document.getElementById('dailyBar'),
    dailyDate: document.getElementById('dailyDate'),
    dailyMeta: document.getElementById('dailyMeta'),
    dailyStart: document.getElementById('dailyStart'),
    dailyChallenge: document.getElementById('dailyChallenge'),
    reviewOpen: document.getElementById('reviewOpen'),
    reviewSheet: document.getElementById('reviewSheet'),
    reviewClose: document.getElementById('reviewClose'),
    reviewBody: document.getElementById('reviewBody'),
    achOpen: document.getElementById('achOpen'),
    achSheet: document.getElementById('achSheet'),
    achClose: document.getElementById('achClose'),
    achBody: document.getElementById('achBody'),
    achToasts: document.getElementById('achToasts')
  };

  var renderer = Renderer.create({
    boardEl: els.board,
    gridEl: els.grid,
    tileEl: els.tiles
  });

  /**
   * 全屏粒子层。canvas 缺失或模块没加载时是 null，所有调用点都必须先判空。
   * 「减少动态效果」创建时按系统偏好关掉粒子与震屏；运行中改偏好由 fx 自己监听
   * matchMedia 的 change 即时生效（音效不受影响，声音不属于动态效果）。
   */
  var fx = Fx
    ? Fx.create({
        canvas: document.getElementById('fx'),
        reduceMotion: !!(global.matchMedia &&
          global.matchMedia('(prefers-reduced-motion: reduce)').matches)
      })
    : null;

  /* ---------- 设置 ---------- */

  var settings = { size: 4, mode: 'classic', sound: true };

  /** 把任意来源的设置整理成合法值，坏字段逐个回退到默认 */
  function normalizeSettings(raw) {
    var out = { size: 4, mode: 'classic', sound: true };
    if (!raw || typeof raw !== 'object') return out;

    var size = Math.floor(Number(raw.size));
    if (G.SIZES.indexOf(size) >= 0) out.size = size;
    if (Object.prototype.hasOwnProperty.call(MODES, raw.mode)) out.mode = raw.mode;
    if (typeof raw.sound === 'boolean') out.sound = raw.sound;

    return out;
  }

  function persistSettings() {
    Storage.set(Storage.KEYS.settings, {
      size: settings.size,
      mode: settings.mode,
      sound: settings.sound
    });
  }

  /* ---------- 一局的状态 ---------- */

  var stats = Storage.loadStats();

  /**
   * 成就档案（Task 4）。与 stats 刻意分开存：stats 是历史战绩，
   * 这里是成就口径的累计指标，任何一边被写坏都不会污染另一边。
   * 模块缺失时保持 null，所有入口都先判空。
   */
  var profile = Achievements ? loadOrSeedProfile() : null;
  /** 档案有改动但还没落盘；批量落盘靠它避免同一次操作写多遍 */
  var profileDirty = false;

  /**
   * 读档案；档案还不存在（老玩家第一次装到带成就的版本）时用历史战绩播种。
   *
   * 只补 bestScore / bestTile / sizes 三项：它们能从 stats 精确还原，
   * games / totalMoves 之类的累计值 stats 口径不同，硬折算会把成就虚增。
   * 播种完立刻 evaluate 一次 —— 历史最高分对应的成就当场就该是解锁状态，
   * 否则「主界面写着历史最高 32000、成就里两万分却是 0/20000」会一直补不上。
   * 已有档案一律原样读入，绝不覆盖玩家自己的进度。
   */
  function loadOrSeedProfile() {
    var raw = Storage.get(Storage.KEYS.profile, null);
    if (raw !== null && raw !== undefined) return Achievements.normalizeProfile(raw);

    var sizes = {};
    var keys = Object.keys(stats.bySize || {});
    for (var i = 0; i < keys.length; i++) {
      var bucket = stats.bySize[keys[i]];
      if (!bucket) continue;
      // 「玩过这个尺寸」有两种证据：打完过（games）或拿过分（bestScore）。
      // 只看 bestScore 会漏掉开局就没合并、0 分收场的局。
      if (bucket.games > 0 || bucket.bestScore > 0) sizes[keys[i]] = 1;
    }

    var seeded = Achievements.addStats(Achievements.emptyProfile(), {
      bestScore: stats.bestScore,
      bestTile: stats.bestTile,
      sizes: sizes
    });
    var result = Achievements.evaluate(seeded, Date.now());
    Storage.set(Storage.KEYS.profile, result.profile);
    return result.profile;
  }

  var state = {
    board: null,
    score: 0,
    won: false,
    keepPlaying: false,
    over: false,
    /** 本局已走步数（撤销会跟着回退，障碍节奏因此也是可撤销的） */
    moves: 0,
    /** 限时模式剩余毫秒；其它模式恒为 0 */
    remainingMs: 0,
    /** 本局已生成的障碍数，用于封顶 */
    obstaclesAdded: 0,
    history: [],
    /** 动画播放中：期间不再启动新的一步 */
    busy: false,
    /** 一局的身份号，换局/撤销时自增，用来作废在途异步回调 */
    session: 0,
    /**
     * 这一局是否已经入过账。注意它只表示「记过一次」，不表示「局已经结束」：
     * 达成目标记一次后玩家还能点「继续挑战」接着玩，那时会按增量补记。
     */
    recorded: false,
    /** 已经计入统计的步数；继续挑战后结算时只补记多出来的部分 */
    recordedMoves: 0,
    /** 每日挑战的日期键（YYYYMMDD）；普通局为 null */
    dailyKey: null,
    /** 每日挑战的随机源；普通局为 null */
    dailyRng: null,
    /** 已从每日序列取了多少个数，存档后按它快进回同一位置 */
    rngCount: 0,
    /** 本局每日成绩是否已入账（finishes 的一次性闸门） */
    dailyRecorded: false,
    /** 本局已计入每日 totalMoves 的步数；继续挑战后只补记增量 */
    dailyRecordedMoves: 0,
    /** 本局是否用过撤销（结果类成就用；随局面落盘，刷新后不归零） */
    undoUsed: false,
    /** 本局已计入 perfectMoves 的「与 AI 一致步数」，结算两次只补增量 */
    perfectRecorded: 0,
    /**
     * 本局通关是否已经计入 wins / modeWins / undoWins。
     * 不能复用 recorded：超时先结算过一次的局，撤销后再通关时 recorded 已为 true，
     * 但通关尚未入账。跟局面一起落盘，跨刷新也不会重复加。
     */
    winRecorded: false,
    /** 本局复盘日志（每日局才建；普通局为 null） */
    reviewLog: null,
    /** 连击数：本步有合并则 +1，无合并步或空档超时清零 */
    combo: 0,
    /** 连击计时点（Date.now()），用来判断空档是否已经超过 COMBO_GAP_MS */
    comboAt: 0,
    /**
     * 双人模式：当前该谁走（0 / 1）与两人各自累计的合并得分。
     * 只在 settings.mode === 'duel' 时有意义；state.score 仍是两人合计，
     * 存档、战报、HUD 的「得分」都继续按总分走，拆分只发生在展示层与判胜处。
     */
    turn: 0,
    players: emptyPlayers()
  };

  /* ---------- 定时器句柄（换局/换设置必须全部清掉） ---------- */

  var tickTimer = null;      // 倒计时 setInterval
  var tickLast = 0;          // 上一次扣时的基准时刻，避免累计漂移
  var autoplayTimer = null;  // 托管 / 提示用 setTimeout
  var autoplay = false;      // 托管开关（与定时器分开管理）
  /**
   * 托管是不是被抽屉「临时」关掉的（运行时标志，不落盘）。
   * 抽屉打开时 isLocked() 会挡住棋盘输入，排了期也走不动；显式关掉、关闭抽屉时再恢复，
   * 按钮状态才和 AI 的实际行为一致。
   */
  var autoplayPausedBySheet = false;

  /** 动画期间缓冲的玩家方向：最多一格，只保留最后一次按键（不进撤销语义） */
  var pendingDir = null;

  /* ---------- 复盘评分队列（挂在空闲回调上，绝不在走子路径里算 AI） ---------- */

  /** 待评分记录：{ entry }，entry 是 reviewLog.moves 里的同一对象，算完直接写回 */
  var evalQueue = [];
  /** 空闲/延时回调句柄；null 表示没有在途任务 */
  var evalTimer = null;
  /** 句柄是 requestIdleCallback 还是 setTimeout，取消时要用对 API */
  var evalTimerIsIdle = false;
  /** 打开复盘抽屉前的焦点，关闭时归还 */
  var reviewReturnFocus = null;
  /** 打开成就面板前的焦点，关闭时归还 */
  var achReturnFocus = null;

  /* ---------- 小工具 ---------- */

  /**
   * 当前尺寸的目标值。
   *
   * 刻意不用 G.WIN_VALUE 兜底：它恒为 2048，只对 4×4 成立，
   * 兜底会把「GOAL_BY_SIZE 缺键」这种配置错误静默变成错误的胜负判定。
   * 宁可让 undefined 直接暴露到界面上，也不让错误悄悄通过。
   */
  function goalValue() {
    return G.GOAL_BY_SIZE[settings.size];
  }

  function maxObstacles() {
    // 上限 = 棋盘尺寸（brief 规定），防止障碍把棋盘埋死
    return settings.size;
  }

  /**
   * 写状态行。
   *
   * 可视文本与播报文本分开：#status 每走一步都要刷新（得分 / 最大 / 步数），
   * 那是噪声 —— 若整句进 polite live region，就会每 300ms 播报一条，把撤销 / 托管 /
   * 连击 / 战报这些真正需要读屏听到的反馈顶掉。silent 为真时只写可视节点。
   *
   * @param {string} text 状态行文本
   * @param {boolean} [silent] 只更新可视文本，不触发读屏播报
   */
  function setStatus(text, silent) {
    if (els.status) els.status.textContent = text;
    if (!silent && els.statusAnnounce) els.statusAnnounce.textContent = text;
  }

  /** 当前是不是双人对战；模式判断散在十几处，集中成一句好读也好改 */
  function isDuel() {
    return settings.mode === 'duel';
  }

  /** 双人比分的安全读取（坏值已在 duel.js 里归零） */
  function playerScore(index) {
    return Duel.scoreOf(state.players, index);
  }

  /**
   * 一份全新的零分比分表。
   *
   * 长度由 Duel.PLAYER_COUNT 决定，不在 app.js 里再写一遍 2：
   * 人数一旦变，duel.js 的 normalize / attribute / winnerOf 会跟着走，
   * 而这里若还写死 [0, 0]，新局与读档就会比 normalize 少一格。
   */
  function emptyPlayers() {
    var players = [];
    for (var i = 0; i < Duel.PLAYER_COUNT; i++) players.push(0);
    return players;
  }

  /** 动画中、结算浮层挡住棋盘、抽屉开着、或这一局已经结束时，都不接受新输入 */
  function isLocked() {
    return state.over || state.busy || !els.overlay.hidden || isReviewOpen() || isAchOpen();
  }

  /**
   * 把 Tab / Shift+Tab 关在模态容器内：走到最后一个可聚焦元素后回第一个，反向反之。
   *
   * 只做首尾循环，不碰 inert —— 背景控件用键盘走不到就够了，改动面最小。
   * 容器里一个可聚焦元素都没有时什么都不做，让浏览器按默认行为走。
   *
   * @param {HTMLElement} container 模态容器（.sheet 或 #overlay）
   * @param {KeyboardEvent} event keydown 事件
   * @returns {boolean} 是否已经把焦点改到了另一端（调用方据此 preventDefault）
   */
  function trapFocus(container, event) {
    if (!container) return false;

    var nodes = container.querySelectorAll(FOCUSABLE);
    var items = [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].disabled) continue;
      // display:none / hidden 的元素 offsetParent 为 null，跳过才不会把焦点送进看不见的按钮
      if (nodes[i].offsetParent === null) continue;
      items.push(nodes[i]);
    }
    if (!items.length) return false;

    var index = items.indexOf(document.activeElement);

    if (event.shiftKey) {
      // 焦点不在容器内（刚打开、或停在容器本身）时，反向也先落到最后一个
      if (index <= 0) {
        items[items.length - 1].focus();
        return true;
      }
      return false;
    }

    if (index === -1 || index === items.length - 1) {
      items[0].focus();
      return true;
    }
    return false;
  }

  /** 毫秒 -> mm:ss（向上取整，这样 180000 显示 03:00 而不是 02:59） */
  function formatClock(ms) {
    var total = Math.ceil(Math.max(0, ms) / 1000);
    var mm = Math.floor(total / 60);
    var ss = total % 60;
    return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  /* ---------- 每日挑战 ---------- */

  /** 今天的日期键；本地时区，跨日判断以它为准 */
  function todayKey() {
    return Rng.dateKey(new Date());
  }

  /**
   * 每日挑战的种子串。
   * 前缀是规格的一部分，改动会让所有历史种子漂移（测试里有 golden 断言）。
   */
  function dailySeed(key) {
    return '2048-daily-' + key;
  }

  /**
   * 所有落子随机的唯一入口。
   * 每日局用日期种子序列（并记下取数个数），普通局直接 Math.random。
   */
  function nextRandom() {
    if (!state.dailyKey || typeof state.dailyRng !== 'function') return Math.random();
    state.rngCount += 1;
    return state.dailyRng();
  }

  /**
   * 按当前 rngCount 重建每日随机源。
   *
   * 随机函数是闭包，没法往回退；撤销 / 读档要回到序列的某个位置，
   * 只能重新 create 再 skip 到同一个计数。非每日局保持 null。
   */
  function restoreDailyRng() {
    if (!state.dailyKey) {
      state.dailyRng = null;
      return;
    }

    var rng = Rng.create(dailySeed(state.dailyKey));
    Rng.skip(rng, state.rngCount);
    state.dailyRng = rng.next;
  }

  /** 千分位自实现：不依赖 toLocaleString 的地区行为 */
  function formatNumber(value) {
    var text = String(Math.max(0, Math.floor(Number(value) || 0)));
    var out = '';
    for (var i = 0; i < text.length; i++) {
      if (i > 0 && (text.length - i) % 3 === 0) out += ',';
      out += text.charAt(i);
    }
    return out;
  }

  function loadDailyStore() {
    return Daily.normalizeStore(Storage.get(Storage.KEYS.daily, null));
  }

  function saveDailyStore(store) {
    Storage.set(Storage.KEYS.daily, store);
  }

  /**
   * 重绘每日条：日期 + 第几次 / 今日最佳 + 连续天数。
   * 处于每日局时按钮改成「重新开始」，普通局是「开始挑战」。
   */
  /* ---------- 触屏布局：按实测可用高度定棋盘边长 ---------- */

  var fitSignature = '';
  var lastFitSize = 0;
  var lastAppWidth = 0;
  /** 紧凑档阈值：与 styles.css 的 body.is-compact 对应 */
  var COMPACT_VH = 720;
  /** 基准视口尺寸只在宽度变化时更新：地址栏收放不该让正滑到一半的棋盘变形 */
  var stableVw = 0;
  var stableVh = 0;

  function isTouchLayout() {
    return !!(global.matchMedia && global.matchMedia('(pointer: coarse)').matches);
  }

  /** 只有会改变「棋盘之外占用」的状态才需要重算，每步走子不触发同步布局 */
  function layoutSignature() {
    return [
      settings.mode, settings.size,
      els.dailyBar.hidden, els.duelBar.hidden,
      els.settingsPanel ? els.settingsPanel.hidden : false,
      els.timer.hidden
    ].join('|');
  }

  function requestBoardFit() {
    if (!isTouchLayout()) return;
    var sig = layoutSignature();
    if (sig === fitSignature) return;
    fitSignature = sig;
    // 同步算，不排 rAF：无头 / 后台标签页里帧回调可能被节流甚至不派发，
    // 棋盘尺寸这种一次性布局不能押在「下一帧一定会来」上。
    // 有 signature 去重，正常走子（每步 renderHud）不会触发同步布局读取。
    fitBoardSize();
  }

  /**
   * 触屏下用真实占用反推棋盘边长。
   *
   * 原来的做法是 CSS 里写死「视口高 - 固定开销」，但不同手机的刘海、系统字号、
   * 设置面板开合、每日条显隐都会改动这笔开销，猜出来的数不是溢出就是留一大块白。
   * 这里直接量棋盘顶部到视口顶部已经用掉多少，剩下的就是棋盘能占的高度。
   *
   * boardTop 用文档坐标，页面滚动过也算得准；基准高度 stableVh 只在宽度变化时更新，
   * 所以地址栏收起/展开不会让棋盘尺寸跟着抖。
   */
  function fitBoardSize() {
    if (!els.board || !els.app) return;
    if (!isTouchLayout()) {
      els.board.style.removeProperty('max-width');   // 桌面完全交回 CSS
      document.body.classList.remove('is-compact');
      lastFitSize = 0;
      return;
    }

    var vw = global.innerWidth;
    var vh = global.innerHeight;
    if (vw !== stableVw || !stableVh) {
      stableVw = vw;
      stableVh = vh;
    }
    // 紧凑档也只看稳定高度，地址栏收放不会让按钮/间距中途换一档
    document.body.classList.toggle('is-compact', stableVh <= COMPACT_VH);

    var scrolled = global.pageYOffset || 0;
    var boardTopDoc = els.board.getBoundingClientRect().top + scrolled;
    var footer = document.querySelector('.footer');
    var footerH = footer ? footer.getBoundingClientRect().height : 0;
    var bottomPad = parseFloat(global.getComputedStyle(document.body).paddingBottom) || 0;
    var available = stableVh - boardTopDoc - footerH - bottomPad - FIT_GAP_PX;
    var size = Math.round(Math.min(els.app.clientWidth, Math.max(FIT_MIN_PX, available)));

    // 收敛保护：ResizeObserver 会因棋盘尺寸变化再回调一次，
    // 算出的值没变就一个字节都不写，避免观察循环。
    if (size === lastFitSize) return;
    lastFitSize = size;
    els.board.style.maxWidth = size + 'px';
    renderer.layout();   // 格子尺寸跟着新边长立刻重算，不等 ResizeObserver 回调
  }

  function renderDailyBar() {
    if (!els.dailyBar) return;

    var key = state.dailyKey || todayKey();
    var store = loadDailyStore();
    var record = Daily.bestOf(store, key);
    var streak = Daily.streakOf(store, todayKey());
    var meta = [];

    if (record && record.attempts > 0) {
      meta.push('第 ' + record.attempts + ' 次');
      meta.push('今日最佳 ' + formatNumber(record.bestScore));
    } else {
      meta.push('今日尚未挑战');
    }
    if (streak.current > 0) meta.push('连续 ' + streak.current + ' 天');

    // 双人打不了每日挑战：这条信息在双人下没有意义，露出来的按钮还会把人拽回经典。
    // 常驻的话两条信息条叠加 43px（34 高 + 9 间距），正好把 1280×800 的预算顶穿。
    els.dailyBar.hidden = isDuel();
    els.dailyDate.textContent = Rng.dateLabel(key);
    els.dailyMeta.textContent = meta.join(' · ');
    els.dailyStart.textContent = state.dailyKey ? '重新开始' : '开始挑战';
    requestBoardFit();
  }

  /**
   * 跨日检查：每日局一旦跨天就放弃每日身份，棋盘照常继续，只是不再走种子序列。
   * 每步收尾、标签页重新可见、以及 60 秒轮询各调一次。
   */
  function ensureDailyFresh() {
    var today = todayKey();

    if (state.dailyKey && state.dailyKey !== today) {
      state.dailyKey = null;
      state.dailyRng = null;
      state.rngCount = 0;
      state.dailyRecorded = false;
      state.dailyRecordedMoves = 0;
      // 跨日后这一局不再属于今日挑战，复盘入账标记一并归零
      state.perfectRecorded = 0;
      resetReviewLog(null);   // 跨日后这一局不再属于今天的挑战，复盘也不该落盘
      setStatus('新的一天 · 今日挑战已刷新');
      saveState();
    }

    renderDailyBar();
  }

  /* ---------- 复盘 ---------- */

  /**
   * 给一步补算 AI 分数并写回 entry。
   * 只在空闲回调 / 结算补算里调用 —— applyMove 的同步路径里绝不能出现 AI.suggest。
   */
  function processEvalEntry(item) {
    if (!item || !item.entry) return;

    var entry = item.entry;
    if (entry.b !== null) return;   // 已经算过，避免重复搜索

    var values = Array.isArray(entry.v) ? entry.v : [];
    if (!values.length) return;

    var move = AI.suggest(G.boardFromValues(values), { timeBudgetMs: EVAL_BUDGET_MS });
    if (!move || !move.scores) return;

    entry.b = move.dir;
    entry.s = move.score;

    var actual = move.scores[entry.d];
    entry.t = typeof actual === 'number' && isFinite(actual) ? actual : null;
  }

  /** 一次空闲回调只处理 1 条，剩下的再排下一次，避免一次性占满主线程 */
  function runEval() {
    evalTimer = null;
    evalTimerIsIdle = false;
    if (!evalQueue.length) return;

    processEvalEntry(evalQueue.shift());
    if (evalQueue.length) {
      scheduleEval();
      return;
    }

    // 队列排空且这一局已经结算：补算出来的评分必须回流到落盘复盘，
    // 否则 summary / perfectMoves 永远停在结算瞬间那 2–3 步上（刷新后数字倒退）。
    // persistReview 按增量入账，重复调用安全。
    if (state.over) persistReview();
  }

  function scheduleEval() {
    if (evalTimer !== null || !evalQueue.length) return;

    if (typeof global.requestIdleCallback === 'function') {
      evalTimerIsIdle = true;
      evalTimer = global.requestIdleCallback(runEval, { timeout: EVAL_IDLE_TIMEOUT_MS });
    } else {
      evalTimerIsIdle = false;
      evalTimer = global.setTimeout(runEval, 0);
    }
  }

  function clearEvalTimer() {
    if (evalTimer === null) return;

    if (evalTimerIsIdle && typeof global.cancelIdleCallback === 'function') {
      global.cancelIdleCallback(evalTimer);
    } else {
      global.clearTimeout(evalTimer);
    }
    evalTimer = null;
    evalTimerIsIdle = false;
  }

  /**
   * 启动时清掉过期的复盘键。
   *
   * 每天一份 25–30KB 的复盘，攒到 150–200 天就会吃满 5MB 配额；配额一满，
   * Storage.set 降级到内存 —— 之后整局只活在内存里，刷新即失。
   * 键名能按日期算出来（Review.staleKeys），不必枚举 localStorage。
   *
   * 清理是「顺手做的好事」：任何一步失败都必须吞掉，不能影响启动。
   */
  function purgeStaleReviews() {
    var stale;
    try {
      stale = Review.staleKeys(todayKey(), Review.KEEP_DAYS, Review.MAX_AGE_DAYS);
    } catch (e) {
      return;   // 算不出键就当没有过期数据：启动优先
    }

    for (var i = 0; i < stale.length; i++) {
      try {
        Storage.remove(stale[i]);
      } catch (e) {
        /* 删不掉就留着，下一次启动再试 */
      }
    }
  }

  /**
   * 换局时重置复盘：每日局建一份空日志，普通局置 null。
   * 队列与在途回调一起清掉，免得上一步的评分写进新一局。
   */
  function resetReviewLog(dateKey) {
    clearEvalTimer();
    evalQueue.length = 0;
    state.reviewLog = dateKey ? Review.emptyLog(dateKey) : null;
  }

  /**
   * 读档后恢复复盘日志：已评分的步原样保留，b 还是 null 的重新排队补算。
   * 存档里的步与局面同步写入，所以「刷新前走了多少步」复盘就覆盖多少步。
   *
   * @param {*} raw 存档里的日志
   * @param {string} dateKey 当前局面的日期键
   */
  function restoreReviewLog(raw, dateKey) {
    clearEvalTimer();
    evalQueue.length = 0;

    var log = Review.normalizeLog(raw, dateKey);
    state.reviewLog = log;

    for (var i = 0; i < log.moves.length; i++) {
      if (log.moves[i].b === null) evalQueue.push({ entry: log.moves[i] });
    }
    while (evalQueue.length > EVAL_QUEUE_LIMIT) evalQueue.shift();
    scheduleEval();
  }

  /**
   * 撤销后丢掉已经被裁掉的待办评分。
   *
   * 按对象身份判断（entry 是否还在日志里），不用入队下标：
   * 日志满 240 步后下标与绝对步号不再一一对应，按下标过滤会错杀仍然存在的待办。
   */
  function trimEvalQueue() {
    var moves = state.reviewLog ? state.reviewLog.moves : [];
    var kept = [];

    for (var i = 0; i < evalQueue.length; i++) {
      if (moves.indexOf(evalQueue[i].entry) >= 0) kept.push(evalQueue[i]);
    }

    evalQueue.length = 0;
    for (var j = 0; j < kept.length; j++) evalQueue.push(kept[j]);
  }

  /**
   * 撤销时把复盘日志裁回快照步数。
   *
   * 日志有 240 步上限，不能拿「快照步数」当长度直接用：
   * 先按本次撤销掉了几步从尾部砍，再和日志实际长度取交集；
   * 这样即使更早的步已经被截断，也能准确丢掉刚撤销的那一步。
   */
  function trimReviewOnUndo(targetMoves) {
    if (!state.reviewLog) return;

    var dropped = Math.max(0, state.moves - Math.max(0, Math.floor(Number(targetMoves) || 0)));
    var length = state.reviewLog.moves.length;
    var keep = Math.max(0, length - dropped);

    clearEvalTimer();
    if (length > keep) state.reviewLog.moves.length = keep;
    trimEvalQueue();
    if (evalQueue.length) scheduleEval();
  }

  /**
   * 走子成功后追加一条复盘记录，并把这一步排进评分队列。
   * 只做 push 和排期，不做任何搜索 —— 连续快速按键时不会有额外卡顿。
   */
  function enqueueReviewMove(dir, valuesBefore, gained) {
    if (!state.reviewLog) return;

    state.reviewLog = Review.appendMove(state.reviewLog, {
      d: dir,
      v: valuesBefore,
      g: gained,
      b: null,
      s: null,
      t: null
    });

    evalQueue.push({
      entry: state.reviewLog.moves[state.reviewLog.moves.length - 1]
    });
    while (evalQueue.length > EVAL_QUEUE_LIMIT) evalQueue.shift();
    scheduleEval();
  }

  /** 同步补算队列里剩下的评分；预算用完就停，宁可少评几步也不卡住结算 */
  function flushEvalQueue(options) {
    var budget = options && typeof options.budgetMs === 'number' ? options.budgetMs : FLUSH_BUDGET_MS;
    if (budget < 0) budget = 0;

    clearEvalTimer();
    var deadline = Date.now() + budget;
    while (evalQueue.length && Date.now() < deadline) {
      processEvalEntry(evalQueue.shift());
    }
  }

  /**
   * 把当前内存日志汇总并落盘 review.<dateKey>，按本局增量补记「与 AI 一致步数」。
   *
   * 幂等：同一份日志重复调用只会覆盖同一个键，perfectMoves 只补新增的一致步数
   * （recordReviewAchievements 内部按 state.perfectRecorded 补差）。
   * 所以结算时调一次、异步补算排空后再调一次都安全。
   */
  function persistReview() {
    if (!state.reviewLog) return;
    if (!state.dailyKey || state.dailyKey !== todayKey()) return;

    var meta = {
      score: state.score,
      moves: state.moves,
      maxTile: G.maxValue(state.board),
      won: state.won
    };

    var summary = Review.summarize(state.reviewLog, meta);

    Storage.set(Storage.KEYS.review + '.' + state.dailyKey, {
      version: state.reviewLog.version,
      date: state.reviewLog.date,
      moves: state.reviewLog.moves,
      summary: summary,
      // meta 不属于 summarize 的返回值，但刷新后要还原指标行，跟着日志一起存
      meta: meta
    });

    // 成就口径的「与 AI 一致步数」跟复盘同一时机入账（内部按本局增量补差）
    recordReviewAchievements(summary);
  }

  /**
   * 结算时落盘复盘：补算剩余评分 -> 汇总 -> 写入 review.<dateKey>。
   *
   * 一局最多结算两次：达成目标先写一份，继续挑战后卡死 / 超时再覆盖同一键。
   * 两次都基于同一份内存日志，所以第二次天然覆盖整局；日志留到开新局才重置。
   *
   * 60ms 预算只够算 2–3 步；剩下的交给空闲回调继续算，算完由 runEval 再落一次盘。
   */
  function finalizeReview() {
    if (!state.reviewLog) return;
    if (!state.dailyKey || state.dailyKey !== todayKey()) return;

    flushEvalQueue({ budgetMs: FLUSH_BUDGET_MS });
    persistReview();

    // 继续挑战会接着这局玩：日志与未算完的队列都留着继续累积。
    // 最终结算同样不在这里清空 —— 只有开新局 / 换每日 / 撤销才会重置或裁剪。
    if (evalQueue.length) scheduleEval();
  }

  /** 非负整数，用于把存档里的脏数据折成 0 */
  function countOf(value) {
    var number = Number(value);
    if (!isFinite(number) || number <= 0) return 0;
    return Math.floor(number);
  }

  /**
   * 非负整数 + 上界，专门给读档用。
   *
   * Infinity 与 1e12 这类值都「是数字」，只做 Math.floor 会原样带进状态：
   * 分数显示成 Infinity、rngCount 让启动时的 Rng.skip 线性空转。
   * 非有限数或负数取 0，超过 max 取 max。
   *
   * @param {*} value 存档里的原始值
   * @param {number} max 该字段的合理上界
   * @returns {number} 0..max 的整数
   */
  function safeCount(value, max) {
    var number = Number(value);
    if (!isFinite(number) || number <= 0) return 0;
    number = Math.floor(number);
    return number > max ? max : number;
  }

  /** 推理复盘用的本局指标：优先内存局，其次落盘日志，最后退回当日战绩 */
  function reviewMetaOf(live, stored, record) {
    if (live) {
      return {
        score: state.score,
        moves: state.moves,
        maxTile: G.maxValue(state.board),
        won: state.won
      };
    }

    var saved = stored && stored.meta;
    if (saved && typeof saved === 'object') {
      return {
        score: countOf(saved.score),
        moves: countOf(saved.moves),
        maxTile: countOf(saved.maxTile),
        won: saved.won === true
      };
    }

    return {
      score: record ? record.bestScore : 0,
      moves: record ? record.bestMoves : 0,
      maxTile: record ? record.bestTile : 0,
      won: record ? record.won : false
    };
  }

  /** analysis 里只会有本模块生成的数字与中文，仍然统一转义，防止以后接用户输入 */
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function metricHtml(label, value) {
    return '<div class="metric">' +
      '<span class="metric__label">' + escapeHtml(label) + '</span>' +
      '<span class="metric__value">' + escapeHtml(value) + '</span>' +
      '</div>';
  }

  /** 一条关键失误：左边 4×4 迷你盘面，右边两行文字 */
  function blunderHtml(entry) {
    // 落盘 summary 可能被手改：条目不是对象、delta 不是数字都按空值渲染，
    // 绝不让脏数据把整个复盘抽屉炸掉（那会连带停掉限时局的计时）
    var item = entry && typeof entry === 'object' ? entry : {};
    var delta = isFinite(Number(item.delta)) ? Number(item.delta) : 0;
    var rows = Array.isArray(item.values) ? item.values : [];
    var cells = [];

    for (var r = 0; r < rows.length; r++) {
      var row = Array.isArray(rows[r]) ? rows[r] : [];
      for (var c = 0; c < row.length; c++) {
        var value = row[c];
        var color = Review.colorFor(value);
        cells.push(
          '<span class="mini-cell" style="background:' + color.background +
          ';color:' + color.color + '">' + (value > 0 ? value : '') + '</span>'
        );
      }
    }

    var dirLabel = Review.DIR_LABEL[item.dir] || '';
    var bestLabel = Review.DIR_LABEL[item.bestDir] || '';

    return '<div class="blunder">' +
      '<div class="mini-grid" aria-hidden="true">' + cells.join('') + '</div>' +
      '<div class="blunder__text">' +
        '<p class="blunder__title">第 ' + item.index + ' 步 向' + escapeHtml(dirLabel) + '</p>' +
        '<p class="blunder__sub">AI 建议 向' + escapeHtml(bestLabel) +
          ' · 亏 ' + delta.toFixed(1) + '</p>' +
      '</div>' +
    '</div>';
  }

  /**
   * 渲染复盘正文。
   * @param {object} log 日志
   * @param {object} summary summarize 结果
   * @param {{headline:string, paragraphs:Array, tips:Array}} analysis 文案
   * @param {object} ctx analyze 的输入上下文（这里只用到指标行）
   */
  function renderReview(log, summary, analysis, ctx) {
    if (!els.reviewBody) return;

    var parts = [];
    parts.push('<p class="review-headline">' + escapeHtml(analysis.headline) + '</p>');

    parts.push('<div class="metrics">');
    parts.push(metricHtml('分数', formatNumber(ctx.score)));
    parts.push(metricHtml('一致性', summary.scored > 0 ? Math.round(summary.consistency * 100) + '%' : '—'));
    parts.push(metricHtml('平均让子', summary.scored > 0 ? summary.avgLoss.toFixed(2) : '—'));
    parts.push(metricHtml('评级', summary.grade));
    parts.push('</div>');

    if (summary.worst.length) {
      parts.push('<h3 class="review-sub">关键失误</h3>');
      var limit = Math.min(3, summary.worst.length);
      for (var i = 0; i < limit; i++) parts.push(blunderHtml(summary.worst[i]));
    }

    parts.push('<h3 class="review-sub">分析</h3>');
    for (var p = 0; p < analysis.paragraphs.length; p++) {
      parts.push('<p class="review-p">' + escapeHtml(analysis.paragraphs[p]) + '</p>');
    }

    parts.push('<h3 class="review-sub">建议</h3>');
    parts.push('<ul class="review-tips">');
    for (var t = 0; t < analysis.tips.length; t++) {
      parts.push('<li>' + escapeHtml(analysis.tips[t]) + '</li>');
    }
    parts.push('</ul>');

    els.reviewBody.innerHTML = parts.join('');
  }

  /** 空状态：今天还没打每日挑战 */
  function renderReviewEmpty() {
    if (!els.reviewBody) return;

    els.reviewBody.innerHTML = '<div class="review-empty">' +
      '<p class="review-empty__text">今天还没打每日挑战</p>' +
      '<button class="btn btn--primary" id="reviewGoDaily" type="button">去挑战</button>' +
    '</div>';

    var go = document.getElementById('reviewGoDaily');
    if (go) {
      go.addEventListener('click', function () {
        closeReview();
        startDaily();
      });
    }
  }

  /** 取今天该显示的复盘：有步数的进行中日志优先，空日志不遮蔽落盘的那份 */
  function renderReviewSheet() {
    if (!els.reviewBody) return;

    var key = todayKey();
    var live = state.reviewLog && state.reviewLog.date === key ? state.reviewLog : null;
    var stored = Storage.get(Storage.KEYS.review + '.' + key, null);
    // 「有步数的优先」：完成今日挑战后再点每日挑战，空壳 live 不能盖掉已落盘的复盘
    var log = Review.pickLog(live, stored);
    var liveLog = log && log === live ? live : null;

    if (!log) {
      renderReviewEmpty();
      return;
    }

    var store = loadDailyStore();
    var record = Daily.bestOf(store, key);
    // meta 与 summary 必须跟同一份日志走：显示落盘日志时用落盘的本局指标。
    var meta = reviewMetaOf(liveLog, stored, record);
    // 落盘 summary 不可信（{}、手改、写截断），字段不齐就按日志现场重算 ——
    // 下游渲染直接 .toFixed / .length，脏数据会在 stopCountdown() 之后炸掉抽屉。
    var summary = log.summary && !liveLog && Review.isUsableSummary(log.summary)
      ? log.summary
      : Review.summarize(log, meta);

    // 近 7 日按「不含今天」算：recent 取 8 天，丢掉末位今天
    var history = [];
    var recentDays = Daily.recent(store, key, 8);
    for (var i = 0; i < recentDays.length - 1; i++) {
      history.push({ date: recentDays[i].date, bestScore: recentDays[i].bestScore });
    }

    var streak = Daily.streakOf(store, key);
    var ctx = {
      dateLabel: Rng.dateLabel(key),
      score: meta.score,
      maxTile: meta.maxTile,
      moves: meta.moves,
      history: history,
      streak: streak.current,
      bestToday: record ? record.bestScore : 0
    };

    renderReview(log, summary, Review.analyze(summary, ctx), ctx);
    // 入口与正文同源：渲染的是哪份日志，导出的就是哪份。
    // live 用当前棋盘的盘面，落盘用日志里能还原的最后一份。
    appendReportEntry(log, meta, !!liveLog);
  }

  /** 渲染失败时的兜底内容：抽屉照常打开，玩家能关掉它，计时就会恢复 */
  function renderReviewError() {
    if (!els.reviewBody) return;
    els.reviewBody.innerHTML = '<div class="review-empty">' +
      '<p class="review-empty__text">复盘数据读不出来，换一局再试试</p>' +
    '</div>';
  }

  /* ---------- 抽屉的公共行为：互斥、计时与托管的暂停恢复 ---------- */

  /**
   * 当前打开的抽屉 id；没有打开时返回 null。
   *
   * 刻意以 DOM 的 hidden 为准（isReviewOpen / isAchOpen），不另存一份「打开顺序」的影子状态：
   * 两个抽屉互斥，任何时刻最多一个开着，所以「栈顶」= 唯一开着的那个。
   * 影子状态要靠每个打开/关闭路径成对维护，漏一处就会让键盘判断永久错位（Esc 关不掉、
   * 方向键失效），而 DOM 是唯一事实来源，不会跑到别处去。
   */
  function openSheetId() {
    if (isAchOpen()) return 'ach';
    if (isReviewOpen()) return 'review';
    return null;
  }

  /** 抽屉打开：正在托管的话先暂停并记住，关闭时才知道要不要恢复 */
  function pauseAutoplayForSheet() {
    if (!autoplay) return;
    autoplayPausedBySheet = true;
    disableAutoplay();
  }

  /**
   * 抽屉关闭后恢复托管。
   * 另一个抽屉还开着、或抽屉背后这一局已经结算（浮层在等玩家）时都不恢复：
   * 前者要继续保持暂停，后者恢复出来的只会是一个「按钮亮着但 AI 不动」的假开启。
   */
  function resumeAutoplayAfterSheet() {
    if (!autoplayPausedBySheet) return;
    if (isReviewOpen() || isAchOpen()) return;

    autoplayPausedBySheet = false;
    if (state.over || !state.board) return;
    enableAutoplay();
  }

  /**
   * 关掉一个抽屉。
   *
   * @param {string} id 'review' 或 'ach'
   * @param {{keepFocus?: boolean, keepPaused?: boolean}} [options]
   *        keepFocus  不归还焦点：互斥切换时焦点交给紧接着打开的面板
   *        keepPaused 不恢复计时与托管：同上，两件事都由下一个面板接管
   */
  function closeSheet(id, options) {
    var sheet = id === 'ach' ? els.achSheet : els.reviewSheet;
    if (!sheet || sheet.hidden) return;

    var keepFocus = !!options && options.keepFocus === true;
    var keepPaused = !!options && options.keepPaused === true;

    sheet.hidden = true;
    // 背景滚动锁属于「还有抽屉开着」：两个抽屉互斥，这里总能正确解除
    if (!isReviewOpen() && !isAchOpen()) document.body.classList.remove('is-sheet-open');

    // 计时与托管的恢复放在同一个开关后面：互斥切换时它们由新面板接管，
    // 这里提前恢复会出现「刚起表就被下一个面板停掉」和「托管在面板背后空转」两种抖动
    if (!keepPaused) {
      startCountdown();   // 抽屉守卫写在 startCountdown 里：另一个还开着就不起表
      resumeAutoplayAfterSheet();
    }

    var target = id === 'ach' ? achReturnFocus : reviewReturnFocus;
    if (id === 'ach') achReturnFocus = null;
    else reviewReturnFocus = null;

    if (keepFocus) return;

    var entrance = id === 'ach' ? els.achOpen : els.reviewOpen;
    // 归还目标可能已不可见（被互斥切换关掉、或被重渲染过），这种时候退回入口按钮
    if (target && target !== document.body && typeof target.focus === 'function' &&
        document.contains(target) && target.offsetParent !== null) {
      target.focus();
    } else if (entrance) {
      entrance.focus();
    }
  }

  function openReview() {
    if (!els.reviewSheet) return;

    // 抽屉互斥：成就开着就先关掉它。焦点与「暂停」都不断档，
    // 由这个面板接手 —— 否则关掉下层会把焦点还给已经被遮住的入口按钮。
    var inherited = null;
    if (isAchOpen()) {
      inherited = achReturnFocus;
      achReturnFocus = null;
      closeSheet('ach', { keepFocus: true, keepPaused: true });
    }

    pauseAutoplayForSheet();   // 抽屉挡住棋盘，托管排了期也走不动：显式暂停
    stopCountdown();           // 限时局看复盘不计时：抽屉开着时不能被判超时
    reviewReturnFocus = inherited || document.activeElement;
    try {
      renderReviewSheet();
    } catch (err) {
      // 计时已经停了，这里绝不能再抛出去：否则抽屉没打开、closeSheet 也永远不会被调用，
      // 限时局从此不扣时。宁可显示一句错误提示，让玩家关掉抽屉恢复计时。
      renderReviewError();
    } finally {
      els.reviewSheet.hidden = false;
      document.body.classList.add('is-sheet-open');
      if (els.reviewClose) els.reviewClose.focus();
    }
  }

  function closeReview() {
    closeSheet('review');
  }

  /** 复盘抽屉是否开着；开着时锁住棋盘输入与托管 */
  function isReviewOpen() {
    return !!els.reviewSheet && els.reviewSheet.hidden === false;
  }

  /* ---------- 成就 ---------- */

  /** 解锁日期文案：时间戳 -> YYYY-MM-DD（本地时区） */
  function stampLabel(stamp) {
    var date = new Date(stamp);
    if (!isFinite(date.getTime())) return '—';

    var month = date.getMonth() + 1;
    var day = date.getDate();
    return date.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' +
      (day < 10 ? '0' : '') + day;
  }

  /** 成就入口按钮上的计数：x/25 */
  function renderAchCount() {
    if (!els.achOpen || !Achievements || !profile) return;
    els.achOpen.textContent = '成就 ' + Achievements.countUnlocked(profile) + '/' +
      Achievements.DEFINITIONS.length;
  }

  /** 一张成就卡片：解锁显示日期，锁定显示进度条（aria-disabled 但仍可聚焦） */
  function achCardHtml(def) {
    var unlockedAt = profile.unlocked[def.id];
    var isUnlocked = typeof unlockedAt === 'number';
    var parts = [];

    parts.push('<article class="ach-card' + (isUnlocked ? ' is-unlocked' : '') + '"' +
      ' tabindex="0"' + (isUnlocked ? '' : ' aria-disabled="true"') + '>');
    parts.push('<header class="ach-card__head">');
    parts.push('<span class="ach-tier ach-tier--' + escapeHtml(def.tier) + '">' +
      escapeHtml(Achievements.TIERS[def.tier] || '') + '</span>');
    parts.push('<span class="ach-card__name">' + escapeHtml(def.name) + '</span>');
    parts.push('</header>');
    parts.push('<p class="ach-card__desc">' + escapeHtml(def.desc) + '</p>');

    if (isUnlocked) {
      parts.push('<p class="ach-card__date">解锁于 ' + escapeHtml(stampLabel(unlockedAt)) + '</p>');
    } else {
      var progress = Achievements.progressOf(def, profile.stats);
      var percent = Math.round(progress.ratio * 100);
      parts.push('<div class="ach-progress" role="progressbar" aria-valuemin="0"' +
        ' aria-valuemax="' + progress.target + '" aria-valuenow="' + progress.current +
        '" aria-label="' + escapeHtml(def.name) + '进度">');
      parts.push('<span class="ach-progress__fill" style="width:' + percent + '%"></span>');
      parts.push('</div>');
      // 达成即解锁，所以锁定的卡片 current 一定小于 target，直接显示原始值
      parts.push('<p class="ach-progress__text">' + progress.current + ' / ' +
        progress.target + '</p>');
    }

    parts.push('</article>');
    return parts.join('');
  }

  function renderAchSheet() {
    if (!els.achBody || !Achievements || !profile) return;

    var total = Achievements.DEFINITIONS.length;
    var cards = [];

    for (var i = 0; i < total; i++) cards.push(achCardHtml(Achievements.DEFINITIONS[i]));

    els.achBody.innerHTML =
      '<div class="ach-summary">' +
        '<span class="ach-summary__count">已解锁 ' +
          Achievements.countUnlocked(profile) + ' / ' + total + '</span>' +
        '<span class="ach-summary__hint">累计指标 · 跨局保留</span>' +
      '</div>' +
      '<div class="ach-grid">' + cards.join('') + '</div>';
  }

  /** 渲染失败时的兜底内容：面板照常打开，玩家能关掉它，计时与托管就会恢复 */
  function renderAchError() {
    if (!els.achBody) return;
    els.achBody.innerHTML = '<div class="ach-summary">' +
      '<span class="ach-summary__count">成就数据读不出来，关掉面板再试试</span>' +
    '</div>';
  }

  function openAchievements() {
    if (!els.achSheet) return;

    // 与复盘同一套互斥：复盘开着就先关掉，焦点与暂停都由这个面板接手续管
    var inherited = null;
    if (isReviewOpen()) {
      inherited = reviewReturnFocus;
      reviewReturnFocus = null;
      closeSheet('review', { keepFocus: true, keepPaused: true });
    }

    pauseAutoplayForSheet();   // 与复盘一致：面板开着时托管暂停，关闭后再恢复
    stopCountdown();           // 与复盘一致：面板开着时不计时，避免背面被判超时
    achReturnFocus = inherited || document.activeElement;
    try {
      renderAchSheet();
    } catch (err) {
      // 与 openReview 同理：时钟已经停了、托管也暂停了，这里再抛出去抽屉就不会打开，
      // closeSheet 永远不会被调用 —— 倒计时永久停住、暂停标志卡在 true。
      // 宁可显示一句兜底，也要让抽屉开得出来、关得掉。
      renderAchError();
    } finally {
      els.achSheet.hidden = false;
      document.body.classList.add('is-sheet-open');
      if (els.achClose) els.achClose.focus();
    }
  }

  function closeAchievements() {
    closeSheet('ach');
  }

  /** 成就面板是否开着；开着时锁住棋盘输入与托管 */
  function isAchOpen() {
    return !!els.achSheet && els.achSheet.hidden === false;
  }

  /** 一条解锁提示：点击打开成就面板，4s 后自己消失 */
  function showAchievementToast(def) {
    if (!els.achToasts || !def) return;

    // 同屏只留最新的 3 条：一次解锁很多条时优先看到最后解锁的
    while (els.achToasts.children.length >= TOAST_LIMIT) {
      els.achToasts.removeChild(els.achToasts.firstChild);
    }

    var toast = document.createElement('button');
    toast.type = 'button';
    toast.className = 'toast toast--' + def.tier;
    toast.innerHTML =
      '<span class="toast__tier ach-tier ach-tier--' + escapeHtml(def.tier) + '">' +
        escapeHtml(Achievements.TIERS[def.tier] || '') + '</span>' +
      '<span class="toast__text">' +
        '<strong>' + escapeHtml(def.name) + '</strong>' +
        '<small>' + escapeHtml(def.desc) + '</small>' +
      '</span>';
    toast.addEventListener('click', openAchievements);

    els.achToasts.appendChild(toast);

    global.setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, TOAST_MS);
  }

  /** 新一轮解锁：音效与彩带每批只播一次，提示最多 3 条 */
  function announceUnlocks(ids) {
    if (!ids || !ids.length) return;

    Audio.achievement();
    if (fx) fx.confetti(60);

    var limit = Math.min(ids.length, TOAST_LIMIT);
    for (var i = 0; i < limit; i++) {
      var def = Achievements.findById(ids[i]);
      if (def) showAchievementToast(def);
    }
  }

  function commitProfile() {
    if (!profileDirty || !profile) return;
    Storage.set(Storage.KEYS.profile, profile);
    profileDirty = false;
  }

  /**
   * 统计入口：合并增量 -> 结算新解锁 -> 落盘 -> 刷新入口计数 -> 播提示。
   * 所有成就统计都必须从这里走，避免某条路径漏掉 evaluate。
   */
  function applyProfile(patch) {
    if (!Achievements || !profile) return;

    profile = Achievements.addStats(profile, patch);
    profileDirty = true;

    var result = Achievements.evaluate(profile, Date.now());
    profile = result.profile;

    commitProfile();
    renderAchCount();
    announceUnlocks(result.unlockedNow);
  }

  /** 走一步：合并组数累加，单步最多合并数与连击只取历史最大 */
  function recordMoveAchievements(mergeCount, combo) {
    // 双人局不进成就口径：否则两人的合作盘会把「单步合并数 / 连击」刷成个人纪录
    if (isDuel()) return;

    var merges = countOf(mergeCount);
    applyProfile({
      merges: merges,
      maxMergesInMove: merges,
      maxCombo: countOf(combo)
    });
  }

  /**
   * 一局入账，与 recordGame 同一口径：
   *   games / sizes 只在首次入账时 +1，
   *   wins / modeWins / undoWins 由 winRecorded 做闸门（一局只加一次通关），
   *   bestScore / bestTile 每次都提交（零增量结算也要把最好成绩推上去），
   *   totalMoves 跟着「继续挑战」的增量推进。
   */
  function recordGameAchievements(firstTime, extraMoves, tile) {
    var patch = { bestScore: state.score, bestTile: countOf(tile) };
    if (firstTime) patch.games = 1;
    if (extraMoves > 0) patch.totalMoves = extraMoves;

    if (firstTime) {
      patch.sizes = {};
      patch.sizes[String(settings.size)] = 1;
    }

    // 通关类成就不能挂在 firstTime 上：限时局超时先记过一局、撤销后再通关时
    // extraMoves 恰好为 0 且 firstTime 为 false，挂 firstTime 就整批漏记。
    var firstWin = state.won && !state.winRecorded;
    if (firstWin) {
      patch.wins = 1;
      patch.modeWins = {};
      patch.modeWins[settings.mode] = 1;
      if (!state.undoUsed) patch.undoWins = 1;
    }

    applyProfile(patch);

    // 闸门必须在落账之后再关：applyProfile 在成就档案缺失时会直接 return，
    // 先关闸门就会让这一局通关永久丢失（之后的结算全被闸门挡在外面）。
    // 它是 void，无法判断成功，所以靠「档案缺失时不落盘」的既有语义兜底：
    // 那种情况下本局本来也没记上，闸门开着至少留了下次补记的机会。
    if (firstWin) state.winRecorded = true;
  }

  /** 进入每日挑战：dailyPlays +1，连续天数取「今天往回数」的结果（只增不减） */
  function recordDailyStartAchievements(streak) {
    applyProfile({ dailyPlays: 1, dailyStreak: countOf(streak) });
  }

  /** 每日挑战达成目标；由 recordDailyResult 的 finish 闸门保证一局只加一次 */
  function recordDailyWinAchievements() {
    applyProfile({ dailyWins: 1 });
  }

  /**
   * 复盘汇总落盘时累加「与 AI 一致步数」。
   * 同一局可能结算两次（达成目标 + 最终结算），所以按本局已计入的数量补差；
   * 同一天多打几局则各自实际累加，不做跨局去重。
   *
   * 已知下限：复盘日志只留最近 240 步（review.js 的 MAX_MOVES），
   * 超长局更早的步会被裁掉，perfectMoves 因此会少记 —— 只少不多，不会误加。
   */
  function recordReviewAchievements(summary) {
    if (!summary || !Achievements) return;

    var matched = countOf(summary.matched);
    var delta = Achievements.matchedDelta(state.perfectRecorded, matched);
    if (delta <= 0) return;

    state.perfectRecorded = matched;
    applyProfile({ perfectMoves: delta });
  }

  /* ---------- 渲染 ---------- */

  /** 背景档位的阈值：2 起步，64 / 512 / 2048 / 4096+ 各进一档 */
  var STAGE_STEPS = [64, 512, 2048, 4096];
  /** 最近一次写入的档位：档位没变就不碰 documentElement 的样式 */
  var stageLevel = -1;

  /**
   * 背景随最大方块渐变：只把档位写进 --stage-tint / --stage-glow，
   * 具体色值全在 styles.css 里由纸张与木色派生。
   *
   * @param {number} maxTile 当前棋盘的最大方块
   */
  function renderStage(maxTile) {
    var level = 0;
    for (var i = 0; i < STAGE_STEPS.length; i++) {
      if (maxTile >= STAGE_STEPS[i]) level = i + 1;
    }
    if (level === stageLevel) return;
    stageLevel = level;

    var root = document.documentElement;
    root.style.setProperty('--stage-tint', 'var(--stage-tint-' + level + ')');
    root.style.setProperty('--stage-glow', 'var(--stage-glow-' + level + ')');
  }

  function renderHud() {
    var maxTile = G.maxValue(state.board);
    var duel = isDuel();
    els.score.textContent = String(state.score);
    els.best.textContent = String(Math.max(stats.bestScore, state.score));
    els.goal.textContent = String(goalValue());
    els.maxTile.textContent = String(maxTile);
    // 双人没有撤销栈，这里也要知道模式：只按 history 判断会在双人下留一个可点的撤销。
    els.undo.disabled = isDuel() || state.history.length === 0;
    els.board.setAttribute('aria-label', settings.size + '×' + settings.size + ' 棋盘');
    renderDuelHud(duel);
    renderStage(maxTile);
    renderTimer();
    requestBoardFit();
  }

  /**
   * 双人的两块比分与回合条：非双人模式整块收起，只留原来的总分。
   * 节点齐全才写，缺一块就整段跳过（老页面 / 裁剪过的页面也不抛）。
   *
   * @param {boolean} duel 当前是否双人模式
   */
  function renderDuelHud(duel) {
    if (els.scoreBox) els.scoreBox.hidden = duel;
    // 「最高」是个人历史最高与两人合计分的 max，双人下读不出任何有用结论，整格收起
    if (els.bestBox) els.bestBox.hidden = duel;

    if (els.p1Block && els.p2Block && els.p1Score && els.p2Score) {
      els.p1Block.hidden = !duel;
      els.p2Block.hidden = !duel;
      els.p1Score.textContent = String(playerScore(0));
      els.p2Score.textContent = String(playerScore(1));
      // 当前走子的一方加底色：两人共用一块棋盘，最容易混的就是「该谁了」；
      // 结算之后没有「该谁」，谁都不高亮。
      els.p1Block.classList.toggle('is-active', duel && !state.over && state.turn === 0);
      els.p2Block.classList.toggle('is-active', duel && !state.over && state.turn === 1);
    }

    if (els.duelBar && els.turnLabel) {
      els.duelBar.hidden = !duel;
      // 结算后不能再写「轮到玩家 N」—— 浮层标题可能正是「玩家 N 达成目标」，同屏自相矛盾
      if (!duel) els.turnLabel.textContent = '';
      else if (state.over) els.turnLabel.textContent = '本局结束';
      else els.turnLabel.textContent = '轮到玩家 ' + (state.turn + 1);
    }
  }

  function renderTimer() {
    if (!els.timer) return;

    if (MODES[settings.mode].timeLimitMs <= 0) {
      els.timer.hidden = true;
      els.timer.textContent = '';
      els.timer.classList.remove('is-urgent');
      // 整格收起时把标签退回静态说明，免得读屏沿用上一局残留的秒数
      els.timer.setAttribute('aria-label', '剩余时间');
      return;
    }

    var ms = Math.max(0, Math.round(state.remainingMs));
    var clock = formatClock(ms);
    els.timer.hidden = false;
    els.timer.textContent = clock;
    // aria-label 是静态属性，不会跟着 textContent 走：不主动刷新的话，
    // 可访问名从初始化起恒为「剩余时间」，倒计时数值被它整个挡住。
    // 归零（00:00）也要照写 —— 那一刻才是最该被听到的状态。
    els.timer.setAttribute('aria-label', '剩余时间 ' + clock);
    // 归零的那一刻（00:00）仍要保持紧急样式：那时才是真正最该被看见的状态
    els.timer.classList.toggle('is-urgent', ms <= URGENT_MS);
  }

  /** 把当前设置同步到按钮的视觉与 aria 状态 */
  function syncControls() {
    var sizeButtons = els.sizeGroup ? els.sizeGroup.querySelectorAll('[data-size]') : [];
    for (var i = 0; i < sizeButtons.length; i++) {
      var sizeActive = Number(sizeButtons[i].getAttribute('data-size')) === settings.size;
      sizeButtons[i].setAttribute('aria-pressed', sizeActive ? 'true' : 'false');
      sizeButtons[i].classList.toggle('is-active', sizeActive);
    }

    var modeButtons = els.modeGroup ? els.modeGroup.querySelectorAll('[data-mode]') : [];
    for (var j = 0; j < modeButtons.length; j++) {
      var modeActive = modeButtons[j].getAttribute('data-mode') === settings.mode;
      modeButtons[j].setAttribute('aria-pressed', modeActive ? 'true' : 'false');
      modeButtons[j].classList.toggle('is-active', modeActive);
    }

    if (els.soundToggle) {
      els.soundToggle.setAttribute('aria-pressed', settings.sound ? 'true' : 'false');
      els.soundToggle.classList.toggle('is-active', settings.sound);
      els.soundToggle.textContent = settings.sound ? '音效：开' : '音效：关';
    }

    // 双人模式没有撤销栈（pushHistory 不入栈），按钮也就没有可撤的一步；
    // 这里显式压住而不是等 renderHud，是因为设置面板切换时按钮会先于新局刷新。
    if (els.undo) els.undo.disabled = isDuel() ? true : state.history.length === 0;

    if (els.autoplay) {
      // 托管在双人下是禁用的：两人轮流本来就是玩法本身，AI 不能替任何一方走
      els.autoplay.disabled = isDuel();
      els.autoplay.setAttribute('aria-pressed', autoplay ? 'true' : 'false');
      els.autoplay.classList.toggle('is-active', autoplay);
      els.autoplay.textContent = autoplay ? '托管：开' : '托管：关';
    }
  }

  function addScore(delta) {
    state.score += delta;
    els.gain.textContent = '+' + delta;
    els.gain.classList.remove('is-shown');
    void els.gain.offsetWidth;   // 强制重排，让动画能重播
    els.gain.classList.add('is-shown');
  }

  /* ---------- 存档 ---------- */

  function saveState() {
    // 结算掉的局面不再续存：下次打开应该是新的一局
    if (!state.board || state.over) {
      Storage.remove(Storage.KEYS.state);
      return;
    }

    Storage.set(Storage.KEYS.state, {
      version: 2,
      size: settings.size,
      mode: settings.mode,
      values: G.toValues(state.board),
      score: state.score,
      won: state.won,
      keepPlaying: state.keepPlaying,
      remainingMs: Math.round(state.remainingMs),
      obstaclesAdded: state.obstaclesAdded,
      moves: state.moves,
      // 入账幂等标记必须跟着局面一起存：否则「达成目标 → 继续挑战 → 关页 → 重开」
      // 之后 recorded 归零，再结算一次就会把同一局的 games 再加一遍。
      recorded: state.recorded,
      recordedMoves: state.recordedMoves,
      // 通关入账闸门必须跟着局面存：否则「超时 → 撤销 → 通关 → 刷新 → 再结算」
      // 会让同一局多记一次 wins / modeWins。
      winRecorded: state.winRecorded,
      // 本局已计入 perfectMoves 的一致步数也必须跟着局面存：否则
      // 「达成目标 → 继续挑战 → 关页 → 重开 → 再结算」会把同一局的 matched 再累加一遍。
      perfectRecorded: state.perfectRecorded,
      // 用过撤销也必须跟着局面存：否则「撤销 → 刷新 → 通关」之后 undoUsed 归零，
      // 这一局会被当成「没用过撤销」而多记一次 undoWins。
      undoUsed: state.undoUsed,
      // 每日身份与随机序列位置必须跟局面一起存：读档后接着长出来的方块
      // 才能和没关页面时完全一致；dailyRecorded 则保证一局只记一次成绩。
      daily: state.dailyKey,
      rngCount: state.rngCount,
      dailyRecorded: state.dailyRecorded,
      dailyRecordedMoves: state.dailyRecordedMoves,
      // 复盘日志跟着局面一起存：刷新后复盘仍覆盖整局。
      // 只有每日局才写，普通局不白增体积（约 15–25KB / 240 步）。
      reviewLog: state.dailyKey ? state.reviewLog : null,
      // 双人：轮到谁 + 两人各自累计。刷新后必须原样接着走，
      // 否则重启会把比分抹平，等于把这一局判给后手。
      turn: state.turn,
      players: state.players.slice()
    });
  }

  /** 读档并校验形状；任何一处不合法就整份丢弃（宁可从新局开始，也不要白屏） */
  function readSaved() {
    var data = Storage.get(Storage.KEYS.state, null);
    if (!data || typeof data !== 'object') return null;

    var size = Math.floor(Number(data.size));
    if (G.SIZES.indexOf(size) < 0) return null;
    if (!Object.prototype.hasOwnProperty.call(MODES, data.mode)) return null;

    var values = data.values;
    // 盘面形状 + 逐格取值都交给 storage 层校验（-1/0/2^n 白名单），
    // 任何一处不合法整份丢弃（宁可从新局开始，也不要合并出 NaN）
    if (!Storage.validateValues(values, size)) return null;

    var limit = MODES[data.mode].timeLimitMs;
    // 所有标量都走 safeCount：非有限数 / 负数归 0，超上界封顶。
    // 只做 Math.floor 挡不住 Infinity 与 1e12（后者会让 rngCount 空转到冻页面）。
    // 无计时的模式上界是 0，读回的 remaining 必为 0 —— 这不是「时间用完了」，
    // 而是「这一局没有倒计时」；renderTimer 只认 MODES[...].timeLimitMs，不看这个值。
    var remaining = safeCount(data.remainingMs, limit > 0 ? limit : 0);

    var moves = safeCount(data.moves, SAVE_MAX_MOVES);
    var recorded = data.recorded === true;
    // 上界就是 moves，safeCount 已经钳过；这里再比一次属于死代码，别加回来。
    var recordedMoves = safeCount(data.recordedMoves, moves);

    if (typeof data.recorded !== 'boolean') {
      // 早期 v2 存档没有入账标记：won 为 true 说明「达成目标」时已经记过一局，
      // 这里保守地把已有步数当成已入账 —— 宁可少记，也不要把同一局算两次。
      recorded = data.won === true;
      recordedMoves = recorded ? moves : 0;
    }
    if (!recorded) recordedMoves = 0;

    // 旧存档没有 daily/rngCount：按普通局处理，棋盘照常恢复。
    var daily = Rng.isDateKey(data.daily) ? data.daily : null;
    var rngCount = daily ? safeCount(data.rngCount, SAVE_MAX_RNG_COUNT) : 0;
    var dailyRecorded = !!daily && data.dailyRecorded === true;
    // 老存档没有 dailyRecordedMoves 时按「当前步数都已入账」处理，
    // 宁可少补，也不要在继续挑战后把已记过的步数再加一遍。
    var dailyRecordedMoves = 0;
    if (dailyRecorded) {
      dailyRecordedMoves = data.dailyRecordedMoves === undefined
        ? moves
        : safeCount(data.dailyRecordedMoves, moves);
    }

    // 复盘日志跟局面一起存；日期以每日键为准，普通局不认这份日志
    var reviewLog = daily ? Review.normalizeLog(data.reviewLog, daily) : null;

    // 本局已入账的一致步数。老存档没有这个字段时按 0 处理 —— 宁可少记，
    // 也不能因为缺字段把整块棋盘丢掉；普通局不进复盘口径，恒为 0。
    var perfectRecorded = 0;
    if (daily) {
      perfectRecorded = safeCount(data.perfectRecorded, moves);
    }

    // 老存档没有 undoUsed 字段：按「这一局没用过撤销」处理，与旧行为一致
    var undoUsed = Boolean(data.undoUsed);
    // 老存档没有 winRecorded 字段：按 false 处理（规格口径）。
    // 代价是极老的「已通关且已入账」存档在下次结算时会多补一次 wins；新存档不会。
    var winRecorded = Boolean(data.winRecorded);

    // 双人：老存档没有这两个字段时按「玩家 1 先走、两人 0 分」恢复，
    // 不因为缺字段把整盘丢掉；两位玩家的分数与总分同一套 safeCount 口径。
    var turn = safeCount(data.turn, 1);
    var playersIn = Array.isArray(data.players) ? data.players : [];
    var players = [];
    for (var p = 0; p < Duel.PLAYER_COUNT; p++) {
      players.push(safeCount(playersIn[p], SAVE_MAX_SCORE));
    }

    return {
      size: size,
      mode: data.mode,
      values: values,
      score: safeCount(data.score, SAVE_MAX_SCORE),
      won: Boolean(data.won),
      keepPlaying: Boolean(data.keepPlaying),
      remainingMs: remaining,
      // 障碍一局最多长 size 个（与 maxObstacles() 同一口径），远小于 size²。
      // 按格数封顶的话，坏档里读到 36 会让 shouldAddObstacle() 恒 false，
      // 障碍模式在整局里静默失效且没有任何提示。
      obstaclesAdded: safeCount(data.obstaclesAdded, size),
      moves: moves,
      recorded: recorded,
      recordedMoves: recordedMoves,
      daily: daily,
      rngCount: rngCount,
      dailyRecorded: dailyRecorded,
      dailyRecordedMoves: dailyRecordedMoves,
      perfectRecorded: perfectRecorded,
      undoUsed: undoUsed,
      winRecorded: winRecorded,
      turn: turn,
      players: players,
      reviewLog: reviewLog
    };
  }

  /* ---------- 撤销栈 ---------- */

  function pushHistory() {
    // 双人模式不支持撤销：干脆不存快照。撤销按钮因为没有历史自然禁用，
    // Ctrl+Z 调到的 undo() 也会在「历史为空」处直接返回，不必另设一道拦截。
    if (isDuel()) return;

    state.history.push({
      values: G.toValues(state.board),   // 走之前的棋盘（含障碍）
      score: state.score,
      won: state.won,
      keepPlaying: state.keepPlaying,
      remainingMs: state.remainingMs,
      obstaclesAdded: state.obstaclesAdded,
      moves: state.moves,
      // 随机序列位置也要回退：否则撤销后重走同一步会重掷新块
      rngCount: state.rngCount
    });
    if (state.history.length > UNDO_LIMIT) state.history.shift();
  }

  /* ---------- 定时器 ---------- */

  function stopCountdown() {
    if (tickTimer !== null) {
      global.clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  /** 只在限时模式、且有剩余时间时才起表；重复调用等价于重设基准 */
  function startCountdown() {
    stopCountdown();
    // 抽屉挡着棋盘、或这一局已经结束时一律不起表。
    // 这一条统一管住所有「关掉一个抽屉就恢复计时」的口子：closeSheet、undo、
    // startNewGame、continuePlaying 都不必各自再判一次「另一个抽屉还开着吗」。
    if (isReviewOpen() || isAchOpen() || state.over) return;
    if (MODES[settings.mode].timeLimitMs <= 0) {
      renderTimer();
      return;
    }
    if (state.remainingMs <= 0) {
      renderTimer();
      return;
    }
    tickLast = Date.now();
    tickTimer = global.setInterval(onTick, TICK_MS);
    renderTimer();
  }

  function onTick() {
    var now = Date.now();
    var delta = now - tickLast;
    tickLast = now;

    state.remainingMs = Math.max(0, state.remainingMs - delta);
    renderTimer();

    if (state.remainingMs <= 0) {
      stopCountdown();
      finishGame('time');   // finishGame 自带幂等保护
    }
  }

  function clearAutoplayTimer() {
    if (autoplayTimer !== null) {
      global.clearTimeout(autoplayTimer);
      autoplayTimer = null;
    }
  }

  function disableAutoplay() {
    var wasOn = autoplay;
    autoplay = false;
    clearAutoplayTimer();
    if (wasOn) syncControls();
  }

  /**
   * 开启托管并排期。
   * 与 toggleAutoplay 的开启分支、抽屉关闭后的恢复共用，避免两处各写一遍
   * 「置位 + syncControls + scheduleAutoplay」。
   */
  function enableAutoplay() {
    autoplayPausedBySheet = false;   // 真的开了就不存在「被抽屉暂停」这回事
    autoplay = true;
    syncControls();
    scheduleAutoplay(AUTOPLAY_DELAY_MS);
  }

  /* ---------- 一局的开始与结束 ---------- */

  /**
   * 进入今天的每日挑战：固定 4×4 经典，随机序列由日期种子决定。
   * 每调一次算一次新的尝试（attempts +1），所以从界面点「重新开始」也走这里。
   */
  function startDaily() {
    // 每日挑战强制 4×4 经典，等于换一局：与 applySettingsChange 同一规则，托管必须先关。
    // 否则玩家点「每日挑战」本意是手动打，结果 AI 代为接管还白白消耗一次尝试。
    disableAutoplay();
    state.dailyKey = todayKey();
    state.dailyRng = Rng.create(dailySeed(state.dailyKey)).next;
    state.rngCount = 0;
    state.dailyRecorded = false;
    state.dailyRecordedMoves = 0;
    // 每次进入每日挑战都是新的一局：复盘一致步数的入账标记从头计
    state.perfectRecorded = 0;

    settings.size = 4;
    settings.mode = 'classic';
    persistSettings();

    var store = loadDailyStore();
    store = Daily.startAttempt(store, state.dailyKey, Date.now());
    saveDailyStore(store);
    // 提前把今天算进连续天数：连续记录只增不减，断签风险由每日条另行提示
    recordDailyStartAchievements(Daily.streakOf(store, state.dailyKey).current);

    startNewGame({ keepDaily: true });
    if (fx) fx.sweep();
    Audio.dailyStart();
    renderDailyBar();
    setStatus(
      '每日挑战 ' + Rng.dateLabel(state.dailyKey) +
      ' · 4×4 经典 · 同一天开局固定，刷新可续'
    );
  }

  /**
   * 开新局。
   * @param {{keepDaily?: boolean}} options keepDaily 为 true 时保留每日身份与随机序列，
   *        供 startDaily 使用；普通重开一律回到 Math.random。
   */
  function startNewGame(options) {
    var keepDaily = !!options && options.keepDaily === true;

    stopCountdown();
    clearAutoplayTimer();
    // 换局一律作废「被抽屉暂停」的记忆：新的一局该不该托管由调用方的 autoplay 决定
    autoplayPausedBySheet = false;
    state.session += 1;
    state.history.length = 0;
    state.score = 0;
    state.won = false;
    state.keepPlaying = false;
    state.over = false;
    state.busy = false;
    state.moves = 0;
    state.recorded = false;
    state.recordedMoves = 0;
    state.winRecorded = false;
    state.dailyRecorded = false;
    state.dailyRecordedMoves = 0;
    state.undoUsed = false;
    state.perfectRecorded = 0;
    // 双人：新局一律玩家 1 先走、两人 0 分；非双人模式下这两个字段不参与逻辑
    state.turn = 0;
    state.players = emptyPlayers();
    // 连击属于「这一局的手感」，换局一律从头数
    resetCombo();
    // 上一局的彩带 / 落尘不能落到新棋盘上：通关后立刻「再来一局」是最常见的路径
    if (fx) fx.stop();
    if (!keepDaily) {
      state.dailyKey = null;
      state.dailyRng = null;
      state.rngCount = 0;
    }
    // 每日局从空日志开始记；普通局直接置空，避免把上一局的复盘带进来
    resetReviewLog(state.dailyKey);
    pendingDir = null;
    state.remainingMs = MODES[settings.mode].timeLimitMs;
    state.obstaclesAdded = MODES[settings.mode].obstacles;

    var game = G.newGame({
      size: settings.size,
      obstacleCount: MODES[settings.mode].obstacles,
      random: nextRandom
    });
    state.board = game.board;

    // 先 setSize：它会清掉渲染层的障碍账本，否则新一局的障碍落在旧坐标上不会淡入
    renderer.setSize(settings.size);
    // 开局走非即时路径：两个方块 60ms 错峰 + appear 弹出（撤销/读档才是 instant）
    renderer.renderBoard(state.board);

    hideOverlay();
    renderHud();
    syncControls();
    renderDailyBar();
    saveState();
    startCountdown();

    if (isDuel()) {
      setStatus(
        settings.size + '×' + settings.size + ' · 双人对战 · 玩家 1 先走 · 目标 ' + goalValue()
      );
    } else {
      setStatus(
        settings.size + '×' + settings.size + ' · ' + MODES[settings.mode].label +
        ' · 目标 ' + goalValue() + '，用方向键开始'
      );
    }

    scheduleAutoplay(AUTOPLAY_DELAY_MS);
  }

  /**
   * 结算入账：记账、落盘复盘、刷新 HUD，外加这一局该有的音效与粒子。
   *
   * 与「弹不弹浮层」拆开，是因为托管到目标时不要浮层（浮层会夺焦点并停掉托管），
   * 但这一局仍然必须记上 —— 否则「托管打到 2048」在统计里等于没发生。
   */
  function bankResult(reason) {
    recordGame();
    finalizeReview();   // 每日局结算时补算评分并落盘（内部自带条件与幂等）
    renderHud();

    if (reason === 'win' || reason === 'win-stuck') {
      Audio.win();
      if (fx) fx.confetti(120);   // 全屏彩带
    } else {
      Audio.gameover();
      if (fx) fx.dust(40);        // 死局/超时：缓慢落尘
    }
  }

  /** 幂等：一局只结算一次，谁先触发算谁的 */
  function finishGame(reason) {
    if (state.over) return;

    state.over = true;
    state.busy = false;
    pendingDir = null;   // 结算了就不再兑现缓冲，免得留到下一局去

    stopCountdown();
    disableAutoplay();
    bankResult(reason);

    if (reason === 'win') showWinOverlay();
    else if (reason === 'time') showTimeOverlay();
    else showStuckOverlay();   // 'stuck' 与 'win-stuck' 都是死局浮层，区别只在音效与粒子

    saveState();   // over 状态下等价于移除存档
  }

  /**
   * 结算入账。
   *
   * 一局可能入账两次：「达成目标」先记一次，玩家点「继续挑战」再玩到死局/超时又是一次。
   * 所以这里按「增量」补记，而不是靠一个终身有效的布尔一刀切：
   *   - games / bySize[size].games 只加一次（一局就是一局）；
   *   - totalMoves 加上次入账之后新增的步数；
   *   - bestScore / bestTile 取 max。
   * 这样继续挑战期间的分数与步数都不会丢，刷新后「最高」也不会倒退。
   *
   * 零增量不等于零进展：撤销回退后再合出目标时 extraMoves 恰好为 0，
   * 但分数、最大块、通关都可能刚刚推进。所以这里只跳过 games / totalMoves 的加数，
   * 后面的 max 更新、落盘、成就与每日结算一律照走。
   */
  function recordGame() {
    // 双人局不进个人纪录：不写 stats、不写成就、不写每日战绩。
    // 守卫必须在读 stats 之前 —— 这里连读档都不该发生，免得把两人合作的分算进个人最高。
    if (isDuel()) return;

    var firstTime = !state.recorded;
    var extraMoves = Math.max(0, state.moves - state.recordedMoves);

    var tile = G.maxValue(state.board);
    stats = Storage.loadStats();

    if (firstTime) {
      stats.games += 1;
      var key = String(settings.size);
      var bucket = stats.bySize[key];
      if (!bucket) bucket = { games: 0, bestScore: 0 };
      bucket.games += 1;
      stats.bySize[key] = bucket;
      state.recorded = true;
    }

    stats.totalMoves += extraMoves;
    state.recordedMoves += extraMoves;

    if (state.score > stats.bestScore) stats.bestScore = state.score;
    if (tile > stats.bestTile) stats.bestTile = tile;

    var sizeBucket = stats.bySize[String(settings.size)];
    if (sizeBucket && state.score > sizeBucket.bestScore) sizeBucket.bestScore = state.score;

    Storage.saveStats(stats);

    // 成就按 recordGame 的同一口径入账：首次记局数，之后只补增量
    recordGameAchievements(firstTime, extraMoves, tile);

    // 每日战绩与统计同一时机入账：首次结算记 finish，继续挑战后的每次增量结算
    // 把本局最新的分数/步数/最大块补进去。
    recordDailyResult();
  }

  /**
   * 每日成绩入账（幂等）。
   *
   * finishes 由 state.dailyRecorded 做一次性闸门：一局只 +1；
   * bestScore / bestMoves / bestTile / totalMoves 则每次结算都推进到本局最新值。
   * 「继续挑战」后的第二次结算只把新增步数补进 totalMoves，不重复算 finish。
   */
  function recordDailyResult() {
    if (!state.dailyKey || state.dailyKey !== todayKey()) return;

    var movesDelta = Math.max(0, state.moves - state.dailyRecordedMoves);
    var countFinish = !state.dailyRecorded;
    var tile = G.maxValue(state.board);

    // 零步增量不等于零进展：超时后撤销再通关时步数正好回到已入账值，
    // 但分数 / 最大块 / 达标都可能刚推进，今日最佳仍要跟着走。
    // 只有三项都没超过已记录值时才真的跳过写盘。
    if (!countFinish && movesDelta === 0) {
      var today = loadDailyStore().days[state.dailyKey];
      var advanced = !today ||
        state.score > today.bestScore ||
        tile > today.bestTile ||
        (state.won && !today.won);
      if (!advanced) return;
    }

    saveDailyStore(Daily.recordResult(loadDailyStore(), state.dailyKey, {
      score: state.score,
      moves: state.moves,
      maxTile: tile,
      won: state.won
    }, Date.now(), { finish: countFinish, movesDelta: movesDelta }));

    if (countFinish) state.dailyRecorded = true;
    state.dailyRecordedMoves = state.moves;
    // 每日达标只跟 finish 闸门走：继续挑战后的增量结算不再重复计数
    if (countFinish && state.won) recordDailyWinAchievements();
    renderDailyBar();
  }

  /* ---------- 走一步 ---------- */

  /** 以 2 为底的对数（震屏强度按值分级用） */
  function log2(value) {
    return Math.log(value) / Math.LN2;
  }

  /** 连击归零；换局、撤销、空档超时都走这里 */
  function resetCombo() {
    state.combo = 0;
    state.comboAt = 0;
  }

  /**
   * 刷新连击。
   * 有合并就 +1（封顶 COMBO_MAX），没有合并立刻清零；
   * 上一步距今已超过 COMBO_GAP_MS 的算新的一串，从 1 重新数。
   *
   * @param {boolean} hasMerge 本步有没有合并
   * @returns {number} 刷新后的连击数
   */
  function bumpCombo(hasMerge) {
    var now = Date.now();

    if (!hasMerge) {
      resetCombo();
      return 0;
    }

    if (state.comboAt && now - state.comboAt >= COMBO_GAP_MS) state.combo = 0;

    state.combo = Math.min(COMBO_MAX, state.combo + 1);
    state.comboAt = now;
    return state.combo;
  }

  /** 空档超时就清零：只在收尾时检查，慢下来的玩家不该一直挂着连击 */
  function expireCombo() {
    if (!state.combo || !state.comboAt) return;
    if (Date.now() - state.comboAt >= COMBO_GAP_MS) resetCombo();
  }

  /**
   * 合并特效：音效与粒子共用这一个入口，保证听见的和看见的是同一件事。
   * 坐标取渲染层的格子中心（视口坐标），所以粒子会从合并格飞出去、跨出棋盘。
   *
   * 注意顺序：连击音效先响，再判视觉层 —— 音效不该被「粒子模块没加载/没有 canvas」
   * 这种视觉侧问题门控掉。
   *
   * @param {Array} merges computeMove 的合并列表（含 row/col/value）
   * @param {number} combo 本步的连击数
   */
  function emitMergeFx(merges, combo) {
    if (combo >= COMBO_FX_AT) Audio.comboSpark(combo);
    if (!fx) return;

    for (var i = 0; i < merges.length; i++) {
      var merge = merges[i];
      var pos = renderer.getCellCenter(merge.row, merge.col);

      fx.burst(Fx.planBurst({
        value: merge.value,
        combo: combo,
        x: pos.x,
        y: pos.y
      }));

      if (merge.value >= ACCENT_VALUE) {
        fx.ring(pos.x, pos.y, merge.value);
        fx.shake(0.4 + log2(merge.value) * 0.02);
      }
    }

    if (combo >= COMBO_FX_AT) fx.sweep();
  }

  /**
   * 把合并特效排到滑行结束那一刻，与合成块弹出同帧。
   * 延迟期间可能换局或撤销，回调里按 session 作废。
   */
  function scheduleMergeFx(merges, combo, session) {
    if (!merges.length) return;

    global.setTimeout(function () {
      if (state.session !== session) return;
      emitMergeFx(merges, combo);
    }, SLIDE_MS);
  }

  /**
   * 走一步（真正落子的唯一入口）。
   * @param {string} dir 方向
   * @param {{touch?: boolean}} [moveOpts] 触摸手势传入 touch:true：
   *        逻辑立即结算、不等滑行动画，方块位置仍照常写（CSS 过渡负责视觉滑动）。
   * @returns {boolean} 是否真的走了一步；被锁、或这个方向推不动都返回 false
   */
  function applyMove(dir, moveOpts) {
    if (isLocked()) return false;

    var result = G.computeMove(state.board, dir);
    if (!result.changed) return false;   // 这个方向推不动，不消耗步数、不留快照

    var session = state.session;
    // 复盘要的是「这一步之前」的盘面，必须赶在接管 result.board 之前取
    var valuesBefore = G.toValues(state.board);
    var combo = bumpCombo(result.merges.length > 0);
    recordMoveAchievements(result.merges.length, combo);

    pushHistory();

    state.busy = true;
    state.board = result.board;    // computeMove 的结果只能消费一次，直接接管
    var spawned = G.spawnRandom(state.board, nextRandom);
    state.moves += 1;

    enqueueReviewMove(dir, valuesBefore, result.gained);

    if (result.gained) {
      addScore(result.gained);
      // 双人：这一步的得分（含一步多次合并的合计）归当前走子的人。
      // 换人发生在 finishTurn 的判胜之后，所以此刻 state.turn 还是刚走子的人。
      if (isDuel()) state.players = Duel.attribute(state.players, state.turn, result.gained);
    }
    renderHud();
    playMoveSound(result);
    scheduleMergeFx(result.merges, combo, session);

    renderer
      .playMove({
        slides: result.slides,
        merges: result.merges,
        spawned: spawned,
        board: state.board   // 注意：此刻还没有本回合新长出来的障碍
      }, {
        // 触摸抬手要的是「立刻响应」：animate:false 让 playMove 同步完成 DOM 收尾并
        // 立即 resolve，state.busy 只存在一个微任务。方块坐标照常写，
        // .tile 的 CSS transition 仍会滑过去，视觉不打折、输入零等待。
        animate: !(moveOpts && moveOpts.touch)
      })
      .then(function (completed) {
        if (state.session !== session) return;   // 已经换局或撤销，这一手作废
        if (!completed) {
          state.busy = false;
          return;
        }
        finishTurn();
      });

    return true;
  }

  /**
   * 本步的声音：有合并就按合并值播琶音（一步多组也不会糊），没有就是滑动声。
   * 音高、连击加成、大块加花全交给 audio + tuning，这里只负责把「发生了什么」递过去。
   */
  function playMoveSound(result) {
    var merges = result.merges || [];
    if (!merges.length) {
      Audio.move();
      return;
    }

    var values = [];
    var best = 0;
    for (var i = 0; i < merges.length; i++) {
      values.push(merges[i].value);
      if (merges[i].value > best) best = merges[i].value;
    }

    // ≥256 与连击是两个独立条件：前者看本次最大合并值，后者看连击数
    Audio.playMergeSet(values, state.combo, { accent: best >= ACCENT_VALUE });
  }

  /* ---------- 玩家输入入口 ---------- */

  /**
   * 玩家的一次走子意图（键盘与滑动都走这里）。
   *
   * 动画在播时不能立刻落子，但也不能把意图丢掉——只留最后一格，
   * 等这一步收尾时由 flushPendingDir() 兑现。
   *
   * 双人例外：不缓冲。换人发生在动画收尾，缓冲下来的方向会以对手的身份走掉、
   * 分数也记给对手，所以双人下动画期的按键直接丢弃（见下方 state.busy 分支）。
   * 触摸手势走 touch:true 的零等待路径，动画期几乎不存在，缓冲基本不会被用到。
   *
   * @param {string} dir 方向
   * @param {{touch?: boolean}} [moveOpts] 交给 applyMove 的时序选项
   * @returns {boolean} 是否立刻走了一步
   */
  function queueMove(dir, moveOpts) {
    if (state.over || !els.overlay.hidden) return false;   // 已结算 / 浮层挡着：不接受也不缓冲

    if (state.busy) {
      // 双人：缓冲的这一格会活到 finishTurn 末尾，而换人发生在它之前 ——
      // 玩家 1 在动画里按的方向会以玩家 2 的身份走一步、分也记给玩家 2。
      // 所以双人下不缓冲，直接丢掉这一次按键。调用方都只看「这一步有没有走成」，
      // 不写状态行，连按也不会刷屏，只是多出来的那几下不生效。
      if (isDuel()) return false;
      pendingDir = dir;
      return false;
    }

    var moved = applyMove(dir, moveOpts);
    if (moved) disableAutoplay();   // 只有真的走了一步才算从 AI 手里接管
    return moved;
  }

  /**
   * 兑现动画期间缓冲的方向（一步收尾时调一次）。
   * 方向推不动就不关托管——玩家的这一下本来就无效，不该顺手把 AI 停掉。
   *
   * @returns {boolean} 是否真的又走了一步
   */
  function flushPendingDir() {
    if (!pendingDir) return false;

    var dir = pendingDir;
    pendingDir = null;
    if (!applyMove(dir)) return false;

    disableAutoplay();
    return true;
  }

  /** 动画播完之后的收尾：跨日检查、长障碍、判胜负、决定是否继续托管 */
  function finishTurn() {
    ensureDailyFresh();

    if (state.over) {   // 动画期间时间到，已经结算
      state.busy = false;
      return;
    }

    if (shouldAddObstacle()) addObstacleNow();

    state.busy = false;
    renderHud();

    if (!state.won && !state.keepPlaying && G.hasWon(state.board, goalValue())) {
      state.won = true;
      // 双人：完成目标的是「刚走完这一步的人」，胜负在这一刻定下。
      // 必须赶在换人之前判，也不给「继续挑战」——继续玩会让 won 常真，
      // 之后谁达成目标都不会再判，一局就没有胜者了。
      if (isDuel()) {
        finishGame('win');
        return;
      }
      // 托管时目标只是中途里程碑：入账、放特效，然后原地接着跑。
      // 一弹浮层就 disableAutoplay + stopCountdown，无人值守的托管会冻在目标这一步。
      if (autoplay) {
        autoContinue();
        return;
      }
      finishGame('win');
      return;
    }

    if (!G.hasMoves(state.board)) {
      finishGame('stuck');
      return;
    }

    // 双人：换人放在判胜与死局之后 —— 这一手若已分出胜负，turn 保持为胜者；
    // 正常续走才轮到对手。renderHud 要再刷一次，回合标签与高亮才跟得上。
    if (isDuel()) {
      // 换人前清掉缓冲：与 undo() 同语义，任何路径留下的上一人意图都不该带到下一回合。
      // 双人下 queueMove 已经拒绝缓冲，这里是第二道保险。
      pendingDir = null;
      state.turn = Duel.nextTurn(state.turn);
      renderHud();
    }

    saveState();
    // 每步的得分 / 步数是可视噪声，不进 live region（silent=true）：
    // 否则每 300ms 一条播报，撤销 / 托管 / 连击的反馈永远听不到。
    if (isDuel()) {
      setStatus(
        '轮到玩家 ' + (state.turn + 1) + ' · 玩家 1 ' + playerScore(0) +
        ' 分 / 玩家 2 ' + playerScore(1) + ' 分 · 已走 ' + state.moves + ' 步',
        true
      );
    } else {
      setStatus(
        '得分 ' + state.score + ' · 最大 ' + G.maxValue(state.board) + ' · 已走 ' + state.moves + ' 步',
        true
      );
    }

    // 连击状态压在日常状态后面：慢下来（>= 1200ms 空档）就该消失。
    // 双人下状态行的第一诉求是「该谁走」，所以不让连击把它盖掉。
    expireCombo();
    if (!isDuel() && state.combo >= COMBO_FX_AT) {
      setStatus(
        '连击 ×' + state.combo + ' · 得分 ' + state.score +
        ' · 最大 ' + G.maxValue(state.board),
        true
      );
    }

    // 这一步刚好收尾，把动画期间缓冲的方向兑现掉；兑现成功就不再排托管
    if (flushPendingDir()) return;

    scheduleAutoplay(AUTOPLAY_DELAY_MS);
  }

  function shouldAddObstacle() {
    if (settings.mode !== 'obstacle') return false;
    if (state.moves <= 0 || state.moves % OBSTACLE_EVERY !== 0) return false;
    return state.obstaclesAdded < maxObstacles();
  }

  function addObstacleNow() {
    var obstacle = G.addObstacle(state.board, nextRandom);
    if (!obstacle) return;   // 没有空格，这一步就不长了

    state.obstaclesAdded += 1;
    // 整盘重绘：新障碍走 is-new 淡入，老障碍静默摆回原位
    renderer.renderBoard(state.board, { instant: true });
    Audio.move();
  }

  /* ---------- 撤销 ---------- */

  function undo() {
    if (!state.history.length) return;

    var snapshot = state.history.pop();

    disableAutoplay();
    // 撤销等于玩家接管：连「被抽屉暂停」的记忆一起作废，
    // 否则之后关掉抽屉会按那条记忆把托管又拉起来，玩家撤销完还得再关一次。
    autoplayPausedBySheet = false;
    stopCountdown();
    state.undoUsed = true;
    state.session += 1;   // 作废在途动画回调
    state.busy = false;
    pendingDir = null;    // 缓冲的是「撤销前那一手之后」的意图，跟着一起作废
    resetCombo();         // 撤销把这一步的合并也退回去了，连击不该留着

    // 复盘跟着回退：裁掉被撤销的步，并作废它们的待办评分（必须在改 state.moves 之前算）
    trimReviewOnUndo(snapshot.moves);

    state.board = G.boardFromValues(snapshot.values);
    state.score = snapshot.score;
    state.won = snapshot.won;
    state.keepPlaying = snapshot.keepPlaying;
    state.remainingMs = snapshot.remainingMs;
    state.obstaclesAdded = snapshot.obstaclesAdded;
    state.moves = snapshot.moves;
    state.rngCount = snapshot.rngCount || 0;
    state.over = false;

    // 随机序列回到走这一步之前的位置：重走同一步会得到同样的新块
    restoreDailyRng();

    hideOverlay();
    renderer.renderBoard(state.board, { instant: true });
    renderHud();

    // 限时模式：把剩余时间也退回去，并从「现在」重新起表
    if (MODES[settings.mode].timeLimitMs > 0 && state.remainingMs > 0) startCountdown();
    else renderTimer();

    saveState();
    setStatus('已撤销一步 · 得分 ' + state.score);
  }

  /* ---------- 提示 ---------- */

  function showHint() {
    if (isLocked()) return;

    var move = AI.suggest(state.board, { timeBudgetMs: AI_BUDGET_MS });
    if (!move) {
      setStatus('这一步已经无处可走了');
      return;
    }

    renderer.flashDirection(move.dir, HINT_MS);
    setStatus('建议：向' + DIR_LABEL[move.dir]);
  }

  /* ---------- 托管 ---------- */

  function scheduleAutoplay(delay) {
    clearAutoplayTimer();
    if (!autoplay || state.over) return;

    var session = state.session;
    var wait = typeof delay === 'number' && delay >= 0 ? delay : AUTOPLAY_DELAY_MS;

    autoplayTimer = global.setTimeout(function () {
      autoplayTimer = null;
      if (state.session !== session) return;
      if (!autoplay || state.over) return;

      if (state.busy) {   // 正常不会走到，兜底防止和手动操作撞车
        scheduleAutoplay(AUTOPLAY_DELAY_MS);
        return;
      }

      var move = AI.suggest(state.board, { timeBudgetMs: AI_BUDGET_MS });
      if (!move) {
        disableAutoplay();
        setStatus('托管结束：无处可走');
        return;
      }

      applyMove(move.dir);
    }, wait);
  }

  function toggleAutoplay() {
    // 双人下 AI 不能替任何一方走：两人轮流本身就是玩法，直接拒绝并说清楚
    if (isDuel()) {
      setStatus('双人模式不支持托管');
      return;
    }
    if (autoplay) {
      disableAutoplay();
      setStatus('托管已关闭');
      return;
    }
    // 抽屉开着时棋盘被锁住，排了期也走不动：直接拒绝，别让按钮亮着骗人
    if (isReviewOpen() || isAchOpen()) {
      setStatus('先关掉面板再开托管');
      return;
    }
    if (state.over) {
      setStatus('这一局已经结束，先开新局');
      return;
    }

    enableAutoplay();
    setStatus('托管已开启');
  }

  /* ---------- 战报 ---------- */

  /** 成就口径的解锁计数；模块缺失时给一个能安全渲染的空值 */
  function achievementsSummary() {
    if (!Achievements) return { unlocked: 0, total: 0 };
    return {
      unlocked: profile ? Achievements.countUnlocked(profile) : 0,
      total: Achievements.DEFINITIONS.length
    };
  }

  /** 结算时这一局的战报入参：盘面直接取当前棋盘 */
  function currentReportData() {
    var key = todayKey();
    var isDaily = state.dailyKey === key;
    var store = loadDailyStore();
    var record = isDaily ? Daily.bestOf(store, key) : null;

    return {
      date: key,
      size: state.board ? state.board.length : settings.size,
      score: state.score,
      maxTile: state.board ? G.maxValue(state.board) : 0,
      moves: state.moves,
      mode: settings.mode,
      // 跨日后这一局已经不算今日挑战，按普通局出卡，避免写进今天的连续天数
      daily: isDaily
        ? {
            streak: Daily.streakOf(store, key).current,
            attempt: record ? record.attempts : 0
          }
        : null,
      achievements: achievementsSummary(),
      values: state.board ? G.toValues(state.board) : []
    };
  }

  /**
   * 落盘日志里最后一个盘面。
   *
   * 日志的 v 存的是「走这一步之前」的局面，也没有记录最后落下的新方块，
   * 所以这张缩略图是最后一手之前的样子 —— 日志能提供的最后一份，够用作纪念。
   */
  function lastLogValues(log) {
    var moves = log && Array.isArray(log.moves) ? log.moves : [];
    for (var i = moves.length - 1; i >= 0; i--) {
      var values = moves[i] && Array.isArray(moves[i].v) ? moves[i].v : null;
      if (values && values.length) return values;
    }
    return [];
  }

  /**
   * 复盘抽屉的战报入参。
   *
   * meta 与 values 由调用方从「当前正在渲染的那份日志」取：进行中的局取内存 meta 与
   * 当前棋盘，落盘日志取落盘 meta 与日志里能还原的盘面。这里只补当天的每日口径。
   * 每日挑战固定 4×4 经典，模式不取当前设置（玩家可能已经换了模式再来看复盘）。
   *
   * @param {{score:number, moves:number, maxTile:number}} meta 本局指标
   * @param {number[][]} values 与 meta 同一局的盘面
   */
  function reviewReportData(meta, values) {
    var key = todayKey();
    var store = loadDailyStore();
    var record = Daily.bestOf(store, key);

    return {
      date: key,
      size: values.length || 4,
      score: meta.score,
      maxTile: meta.maxTile,
      moves: meta.moves,
      mode: 'classic',
      daily: {
        streak: Daily.streakOf(store, key).current,
        attempt: record ? record.attempts : 0
      },
      achievements: achievementsSummary(),
      values: values
    };
  }

  /**
   * 把战报下载成 PNG。
   * 失败只写状态行：结算浮层还开着，绝不能因为下载失败打断结算流程。
   * @param {?Blob} blob 已生成的图片
   * @param {object} model 战报模型（文件名从这里取）
   */
  function downloadReportBlob(blob, model) {
    if (!blob) {
      setStatus('战报生成失败');
      return;
    }

    var url = null;
    var link = null;
    try {
      url = global.URL.createObjectURL(blob);
      link = document.createElement('a');
      link.href = url;
      link.download = Report.fileName(model);
      document.body.appendChild(link);
      link.click();
      setStatus('战报已保存 · ' + link.download);
    } catch (err) {
      setStatus('战报生成失败');
    } finally {
      if (link && link.parentNode) link.parentNode.removeChild(link);
      if (url) {
        global.setTimeout(function () {
          global.URL.revokeObjectURL(url);
        }, 1000);
      }
    }
  }

  /**
   * 组装并下载一张战报。
   * @param {Function} buildData 返回 buildModel 入参的函数（便于把取数一起包进 try）
   */
  function saveReport(buildData) {
    if (!Report) {
      setStatus('战报生成失败');
      return;
    }

    var model;
    try {
      model = Report.buildModel(buildData());
    } catch (err) {
      setStatus('战报生成失败');
      return;
    }

    var canvas;
    try {
      canvas = Report.render(model);
    } catch (err) {
      canvas = null;
    }
    if (!canvas) {
      setStatus('战报生成失败');
      return;
    }

    Report.toBlob(canvas).then(function (blob) {
      downloadReportBlob(blob, model);
    }, function () {
      setStatus('战报生成失败');
    });
  }

  /** 结算浮层的「保存战报」 */
  function saveCurrentReport() {
    saveReport(currentReportData);
  }

  /** 结算浮层的按钮项：调用方追加在既有按钮之后 */
  function reportAction() {
    return { label: '保存战报', onClick: saveCurrentReport };
  }

  /**
   * 复盘正文底部追加「导出今日战报」。
   *
   * 与正文同源：抽屉里渲染的是哪份日志（进行中的 live 或落盘的 stored），
   * 导出的就是哪份 —— 否则玩家看着进行中的盘面，存下来却是上一局的卡。
   * 没有步数、或盘面还原不出来时不渲染：与其给一个点了没反应的按钮，不如不出现。
   *
   * @param {object} log 当前渲染的日志
   * @param {object} meta 与该日志配套的本局指标
   * @param {boolean} isLive 是否是进行中的内存日志
   */
  function appendReportEntry(log, meta, isLive) {
    if (!els.reviewBody || !Report) return;
    if (!log || !Array.isArray(log.moves) || !log.moves.length) return;

    // live 取当前棋盘；落盘日志取它记录的最后一份盘面。取不到就不给入口。
    var values = isLive ? (state.board ? G.toValues(state.board) : []) : lastLogValues(log);
    if (!values.length) return;

    var foot = document.createElement('div');
    foot.className = 'review-foot';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.id = 'reviewReport';
    btn.textContent = '导出今日战报';
    btn.addEventListener('click', function () {
      saveReport(function () {
        return reviewReportData(meta, values);
      });
    });

    foot.appendChild(btn);
    els.reviewBody.appendChild(foot);
  }

  /* ---------- 浮层 ---------- */

  function showOverlay(tone, title, text, actions) {
    els.overlayTitle.textContent = title;
    els.overlayText.textContent = text;
    els.overlayActions.innerHTML = '';

    actions.forEach(function (action) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn' + (action.primary ? ' btn--primary' : '');
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      els.overlayActions.appendChild(btn);
    });

    els.overlay.classList.toggle('is-win', tone === 'win');
    els.overlay.classList.toggle('is-lose', tone === 'lose');
    // 双人死局同分不是失败也不是胜利，单独一档中性色，别刷成任何一方的输赢
    els.overlay.classList.toggle('is-draw', tone === 'draw');
    els.overlay.hidden = false;
    // 浮层打开时把整个应用抬到粒子层之上（见 styles.css 的 body.is-overlay-open #fx）。
    // 不移动 canvas：它一旦进 .app，震屏的 transform 会让 fixed 变成相对 .app 定位，粒子跟着抖。
    document.body.classList.add('is-overlay-open');

    // 结算浮层是唯一的强提示：读屏用户如果不把焦点送进去，根本不知道这一局结束了。
    // 但抽屉开着时焦点必须留在玩家正在看的面板里，不能被背后的浮层抢走。
    var primary = els.overlayActions.querySelector('.btn--primary') ||
      els.overlayActions.querySelector('button');
    if (primary && !isReviewOpen() && !isAchOpen()) primary.focus();

    // 浮层挡着棋盘时不给倒计时扣时间，玩家可以慢慢想
    stopCountdown();
  }

  function hideOverlay() {
    // 焦点在浮层里的话，关掉后要还给棋盘，键盘玩家不必再 Tab 一遍
    var hadFocus = els.overlay.contains(document.activeElement);
    els.overlay.hidden = true;
    document.body.classList.remove('is-overlay-open');
    if (hadFocus && els.board) els.board.focus();
  }

  /**
   * 结算浮层里的「再来一局」：
   * 当日每日局续一场每日挑战（仍用今天的种子），其余情况按普通新局处理。
   */
  function restartSame() {
    if (state.dailyKey && state.dailyKey === Rng.dateKey(new Date())) startDaily();
    else startNewGame();
  }

  /** 通用按钮组：再来一局必给；有历史才给撤销 */
  function endingActions(withUndo) {
    var actions = [{ label: '再来一局', primary: true, onClick: restartSame }];
    if (withUndo) actions.push({ label: '撤销一步', onClick: undo });
    return actions;
  }

  function showWinOverlay() {
    // 双人：达成目标的一方就是终点。不给「继续挑战」（见 finishTurn 的说明），
    // 也不给战报 —— 战报按个人纪录口径出卡，双人局本来就刻意不入个人纪录。
    if (isDuel()) {
      var winner = state.turn + 1;
      showOverlay(
        'win',
        '玩家 ' + winner + ' 达成目标',
        '玩家 ' + winner + ' 合出了 ' + goalValue() + '。玩家 1 ' + playerScore(0) +
          ' 分 / 玩家 2 ' + playerScore(1) + ' 分。',
        [{ label: '再来一局', primary: true, onClick: restartSame }]
      );
      return;
    }

    var actions = [
      { label: '继续挑战', primary: true, onClick: continuePlaying },
      { label: '再来一局', onClick: restartSame }
    ];
    if (state.history.length) actions.push({ label: '撤销一步', onClick: undo });
    // 战报排在既有按钮之后：结算的第一诉求仍是继续玩 / 重开
    actions.push(reportAction());

    showOverlay(
      'win',
      '达成目标',
      '你做出了 ' + goalValue() + '，' + MODES[settings.mode].label + '模式通关。本局 ' +
        state.score + ' 分，还能继续往上冲。',
      actions
    );
  }

  function showTimeOverlay() {
    var actions = endingActions(state.history.length > 0);
    actions.push(reportAction());

    showOverlay(
      'lose',
      '时间到',
      '本局 ' + state.score + ' 分，最大方块 ' + G.maxValue(state.board) + '，走了 ' +
        state.moves + ' 步。',
      actions
    );
  }

  function showStuckOverlay() {
    // 双人：死局按比分判胜负，相同则平局。胜者用 win 调性，平局走中性，
    // 不把「有人赢了」的局刷成失败色。
    if (isDuel()) {
      var winner = Duel.winnerOf(state.players);
      var title = winner === null ? '平局' : '玩家 ' + (winner + 1) + ' 获胜';
      showOverlay(
        winner === null ? 'draw' : 'win',
        title,
        '玩家 1 ' + playerScore(0) + ' 分 / 玩家 2 ' + playerScore(1) +
          ' 分。棋盘上没有空格也没有可合并的方块。',
        [{ label: '再来一局', primary: true, onClick: restartSame }]
      );
      return;
    }

    var actions = endingActions(state.history.length > 0);
    actions.push(reportAction());

    showOverlay(
      'lose',
      '走不动了',
      '棋盘上没有空格也没有可合并的方块。本局 ' + state.score + ' 分，最大方块 ' +
        G.maxValue(state.board) + '，走了 ' + state.moves + ' 步。',
      actions
    );
  }

  /** 达成目标后接着玩：won 保持 true，所以不会二次弹窗 */
  function continuePlaying() {
    state.keepPlaying = true;
    state.over = false;

    // 达成目标的那一步可能同时把棋盘走死（满盘 + 无可合并）：
    // 直接续跑会留下一个「方向键毫无反应」的棋盘，永远不会再结算。
    // finishGame 开头有 over 守卫，所以必须先复位 over 再进结算。
    if (!G.hasMoves(state.board)) {
      finishGame('stuck');
      return;
    }

    hideOverlay();
    renderHud();
    saveState();

    if (MODES[settings.mode].timeLimitMs > 0) startCountdown();

    setStatus('继续挑战 · 目标已达成，往上接着冲');
    scheduleAutoplay(AUTOPLAY_DELAY_MS);
  }

  /**
   * 托管到达目标后的原地续跑。
   *
   * 状态与「继续挑战」一致（keepPlaying + won 保持 true），区别只有三点：
   * 不弹浮层（会夺焦点）、不停托管（否则整局冻在这一步）、不停计时（限时局照走）。
   * 这一局该记的分、该放的彩带、该入的复盘一样不少，只是没有一个要人点的按钮。
   *
   * 例外：这一步收尾时若有缓冲方向（玩家在动画里按了键），说明玩家正在接管 ——
   * 那就关托管、入账、兑现那一手，不再排下一轮托管。
   */
  function autoContinue() {
    state.over = false;
    state.keepPlaying = true;

    // 托管走到目标时玩家正好按了方向：这一下就是接管信号。
    // finishTurn 的常规收尾会 flushPendingDir，但 autoContinue 直接 return 会跳过它，
    // 缓冲的方向就被推迟到「AI 又多走一步」之后。这里先关托管、入账落盘，
    // 再当场兑现这一手，不排下一轮托管。
    if (pendingDir) {
      disableAutoplay();
      bankResult('win');
      saveState();
      // 方向推不动、棋盘又已无解时不能就这么收场：否则又留下一个没有浮层的死盘
      if (!flushPendingDir() && !G.hasMoves(state.board)) finishGame('stuck');
      return;
    }

    // 与 continuePlaying 同理：托管走到目标那一步可能同时无解。
    // 判定必须放在 bankResult 之前：无解就直接以「通关即死局」结算一次，
    // 通关仍由 winRecorded 闸门补记（state.won 已为 true，不会漏）。
    // 走 'win-stuck' 而不是 'stuck'：这一步确实打成了目标，胜利音效与彩带该有；
    // 浮层仍是死局那份（这一局到此为止），只是不再叠一层失败音把胜利压掉。
    if (!G.hasMoves(state.board)) {
      finishGame('win-stuck');
      return;
    }

    bankResult('win');
    saveState();

    setStatus('目标已达成 · 托管继续往上冲');
    scheduleAutoplay(AUTOPLAY_DELAY_MS);
  }

  /* ---------- 设置切换 ---------- */

  function applySettingsChange() {
    // 换尺寸/换模式等于换一局：托管必须先关掉。
    // 只清定时器是不够的 —— autoplay 还是 true，startNewGame 一收尾就会重新排期，
    // 玩家切到 5×5 会立刻被 AI 接管。
    disableAutoplay();
    persistSettings();
    Audio.setEnabled(settings.sound);
    syncControls();
    startNewGame();
  }

  function setSize(size) {
    var value = Math.floor(Number(size));
    if (G.SIZES.indexOf(value) < 0 || value === settings.size) return;
    settings.size = value;
    applySettingsChange();
  }

  function setMode(mode) {
    if (!Object.prototype.hasOwnProperty.call(MODES, mode) || mode === settings.mode) return;
    settings.mode = mode;
    applySettingsChange();
  }

  function toggleSound() {
    settings.sound = !settings.sound;
    persistSettings();
    Audio.setEnabled(settings.sound);
    syncControls();
    if (settings.sound) Audio.move();   // 开启时给个即时反馈（同时完成上下文解锁）
    setStatus(settings.sound ? '音效已开启' : '音效已关闭');
  }

  function toggleSettingsPanel() {
    var willOpen = els.settingsPanel.hidden;
    els.settingsPanel.hidden = !willOpen;
    els.openSettings.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    els.openSettings.classList.toggle('is-active', willOpen);
    requestBoardFit();   // 面板开合改了棋盘之外的占用
  }

  /* ---------- 输入 ---------- */

  function onKeyDown(event) {
    if (event.isComposing) return;

    var key = (event.key || '').toLowerCase();

    // 抽屉开着时只认 Esc 与 Tab：方向键、R、撤销都等关掉之后再起作用。
    // 目标按 DOM 推导（两个抽屉互斥，最多一个开着），不再维护「后打开的」栈：
    // 少一份影子状态，就不会出现「栈和实际可见的抽屉错位、键盘永久失效」。
    var sheetId = openSheetId();
    if (sheetId) {
      if (key === 'escape') {
        event.preventDefault();
        closeSheet(sheetId);
      } else if (key === 'tab') {
        if (trapFocus(sheetId === 'ach' ? els.achSheet : els.reviewSheet, event)) {
          event.preventDefault();
        }
      }
      return;
    }

    // 结算浮层也是模态：Tab 只在浮层里循环，方向键照旧被 isLocked() 挡住
    if (key === 'tab' && !els.overlay.hidden) {
      if (trapFocus(els.overlay, event)) event.preventDefault();
      return;
    }

    var withModifier = event.ctrlKey || event.metaKey;

    if (withModifier && key === 'z') {
      event.preventDefault();
      undo();
      return;
    }
    if (withModifier || event.altKey) return;

    if (key === 'r') {
      event.preventDefault();
      startNewGame();
      return;
    }

    var dir = KEY_TO_DIR[key];
    if (!dir) return;

    event.preventDefault();
    queueMove(dir);   // 手动接管即关闭托管；动画期间按下的一律先进 1 格缓冲
  }

  var pointerStart = null;

  /** 只有手指/笔（或触屏设备）才需要拖动预览；鼠标拖动不挪方块 */
  function wantsDragPreview(event) {
    return event.pointerType === 'touch' || event.pointerType === 'pen' || isTouchLayout();
  }

  function clearDragPreview() {
    if (!els.tiles) return;
    els.tiles.classList.remove('is-dragging');
    els.tiles.style.removeProperty('transform');
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    clearDragPreview();
    pointerStart = {
      x: event.clientX,
      y: event.clientY,
      id: event.pointerId,
      preview: wantsDragPreview(event),
      axis: null,
      dir: null,
      boardSize: els.board ? els.board.clientWidth : 0
    };

    // 手指很容易滑出棋盘边界；不捕获指针的话 pointerup 就落在别处，
    // 这一划会整个丢掉。老浏览器可能没有这个 API，包一层保护。
    if (event.pointerId !== undefined && els.board.setPointerCapture) {
      try {
        els.board.setPointerCapture(event.pointerId);
      } catch (err) {
        // 捕获失败不影响起点记录，pointerup 落在棋盘内时仍然有效
      }
    }
  }

  /**
   * 跟手预览：手指一动，整层方块就沿着主轴平移，不等抬手。
   * 主轴在第一次越过 DRAG_LOCK_PX 时锁定，后面手指轻微抖动不会改方向；
   * 位移带阻尼与上限，避免整块棋盘被拖出边界。
   * 这里只做视觉位移，一步棋仍然只在抬手时落（玩法与交互不变）。
   */
  function onPointerMove(event) {
    if (!pointerStart || !pointerStart.preview) return;
    if (event.pointerId !== undefined && pointerStart.id !== undefined &&
        event.pointerId !== pointerStart.id) return;

    var dx = event.clientX - pointerStart.x;
    var dy = event.clientY - pointerStart.y;
    var ax = Math.abs(dx);
    var ay = Math.abs(dy);

    if (!pointerStart.axis) {
      if (Math.max(ax, ay) < DRAG_LOCK_PX) return;
      pointerStart.axis = ax > ay ? 'x' : 'y';
      pointerStart.dir = pointerStart.axis === 'x'
        ? (dx > 0 ? 'right' : 'left')
        : (dy > 0 ? 'down' : 'up');
    }

    var delta = pointerStart.axis === 'x' ? dx : dy;
    var maxOffset = Math.max(1, pointerStart.boardSize * DRAG_MAX_RATIO);
    var offset = Math.max(-maxOffset, Math.min(maxOffset, delta * DRAG_FOLLOW));
    var ox = pointerStart.axis === 'x' ? offset : 0;
    var oy = pointerStart.axis === 'y' ? offset : 0;

    els.tiles.classList.add('is-dragging');
    els.tiles.style.transform =
      'translate3d(' + ox.toFixed(1) + 'px,' + oy.toFixed(1) + 'px,0)';
  }

  function onPointerCancel() {
    pointerStart = null;
    clearDragPreview();
  }

  function onPointerUp(event) {
    if (!pointerStart) return;

    var dx = event.clientX - pointerStart.x;
    var dy = event.clientY - pointerStart.y;
    var axis = pointerStart.axis;
    var dir = pointerStart.dir;
    var preview = pointerStart.preview;
    pointerStart = null;
    clearDragPreview();

    var threshold = preview ? SWIPE_THRESHOLD_TOUCH : SWIPE_THRESHOLD;
    var reached = axis
      ? Math.abs(axis === 'x' ? dx : dy) >= threshold
      : Math.max(Math.abs(dx), Math.abs(dy)) >= threshold;
    if (!reached) return;

    if (!dir) {
      dir = Math.abs(dx) > Math.abs(dy)
        ? (dx > 0 ? 'right' : 'left')
        : (dy > 0 ? 'down' : 'up');
    }

    // 触摸这一手走零等待路径：逻辑立刻结算，不等 285ms 动画；
    // 键盘与托管仍走原路径，busy / pendingDir 的语义保持不变。
    queueMove(dir, preview ? { touch: true } : null);
  }

  /* ---------- 绑定 ---------- */

  function bindChoiceGroup(groupEl, attr, handler) {
    if (!groupEl) return;
    var buttons = groupEl.querySelectorAll('[data-' + attr + ']');
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          handler(btn.getAttribute('data-' + attr));
        });
      })(buttons[i]);
    }
  }

  function bindControls() {
    els.newGame.addEventListener('click', startNewGame);
    els.undo.addEventListener('click', undo);

    if (els.hint) els.hint.addEventListener('click', showHint);
    if (els.autoplay) els.autoplay.addEventListener('click', toggleAutoplay);
    if (els.openSettings) els.openSettings.addEventListener('click', toggleSettingsPanel);
    if (els.soundToggle) els.soundToggle.addEventListener('click', toggleSound);

    // 每日条里的按钮与第二排入口都进同一条路径（achOpen 由后续任务接）
    if (els.dailyStart) els.dailyStart.addEventListener('click', startDaily);
    if (els.dailyChallenge) els.dailyChallenge.addEventListener('click', startDaily);

    if (els.reviewOpen) els.reviewOpen.addEventListener('click', openReview);
    if (els.reviewClose) els.reviewClose.addEventListener('click', closeReview);
    if (els.reviewSheet) {
      els.reviewSheet.addEventListener('click', function (event) {
        // 点在遮罩（面板之外）才关，点面板内部不冒泡误关
        if (event.target === els.reviewSheet) closeReview();
      });
    }

    if (els.achOpen) els.achOpen.addEventListener('click', openAchievements);
    if (els.achClose) els.achClose.addEventListener('click', closeAchievements);
    if (els.achSheet) {
      els.achSheet.addEventListener('click', function (event) {
        if (event.target === els.achSheet) closeAchievements();
      });
    }

    bindChoiceGroup(els.sizeGroup, 'size', setSize);
    bindChoiceGroup(els.modeGroup, 'mode', setMode);

    document.addEventListener('keydown', onKeyDown);
    // 页面在后台时计时器可能被节流，回到前台时补一次跨日检查
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) ensureDailyFresh();
    });

    els.board.addEventListener('pointerdown', onPointerDown);
    els.board.addEventListener('pointermove', onPointerMove);
    els.board.addEventListener('pointerup', onPointerUp);
    els.board.addEventListener('pointercancel', onPointerCancel);
    // 指针捕获解除只是通知，pointerup 可能紧随其后：只收预览，不抹掉起点
    els.board.addEventListener('lostpointercapture', clearDragPreview);

    // 用布局变化兜底：浏览器缩放、旋屏、开发者工具改视口时，
    // resize / matchMedia 的 change 不一定都派发，但 .app 的尺寸一定会变。
    // fitBoardSize 用 lastFitSize 收敛，不会因为自己改了棋盘又回调而打转。
    if (global.ResizeObserver && els.app) {
      new global.ResizeObserver(function () {
        var w = els.app.clientWidth;
        // 只有宽度变化才值得重算：地址栏收放、紧凑档切换改的是高度，
        // 跟着重算会让棋盘尺寸在手势中途抖动。
        if (w === lastAppWidth) return;
        lastAppWidth = w;
        fitSignature = '';
        requestBoardFit();
      }).observe(els.app);
    }

    // 只有宽度变化才重算棋盘尺寸：手机地址栏收放只改高度，
    // 跟着它改棋盘会让正拖到一半的手势突然失去参照。
    global.addEventListener('resize', function () {
      if (global.innerWidth !== stableVw) {
        fitSignature = '';
        requestBoardFit();
      }
    });

    var coarseQuery = global.matchMedia && global.matchMedia('(pointer: coarse)');
    if (coarseQuery && coarseQuery.addEventListener) {
      coarseQuery.addEventListener('change', function (event) {
        fitSignature = '';
        if (event.matches) requestBoardFit();
        else els.board.style.removeProperty('max-width');
      });
    }
  }

  /* ---------- 启动 ---------- */

  function init() {
    settings = normalizeSettings(Storage.get(Storage.KEYS.settings, null));
    Audio.setEnabled(settings.sound);
    stats = Storage.loadStats();

    // 先清理过期的每日复盘，再让后续写入去争配额
    purgeStaleReviews();

    bindControls();
    renderAchCount();
    global.setInterval(ensureDailyFresh, DAILY_CHECK_MS);

    var saved = readSaved();
    var restored = false;
    var dailyExpired = false;

    if (saved) {
      // 存档比设置更权威：它记录的才是真正在玩的局面
      settings.size = saved.size;
      settings.mode = saved.mode;
      // 尺寸/模式被存档改写后立刻落盘：否则这份存档一旦被移除（结算 / 清缓存），
      // 下次启动会退回改之前的旧设置，玩家会莫名其妙回到上一个尺寸
      persistSettings();

      state.board = G.boardFromValues(saved.values);
      // 死局、或者限时局的表已经走完，都不值得续存：直接开新的一局
      var playable = G.hasMoves(state.board);
      var timeLeft = saved.mode !== 'timed' || saved.remainingMs > 0;
      if (playable && timeLeft) {
        restored = true;
        state.score = saved.score;
        state.won = saved.won;
        state.keepPlaying = saved.keepPlaying;
        state.remainingMs = saved.remainingMs;
        state.obstaclesAdded = saved.obstaclesAdded;
        state.moves = saved.moves;
        // 入账标记跟着局面一起还原，保证同一局永远只记一次
        state.recorded = saved.recorded;
        state.recordedMoves = saved.recordedMoves;
        // 通关闸门同样随局面还原：超时→撤销→通关→刷新后不会再记一次 wins
        state.winRecorded = saved.winRecorded;
        // 用过撤销标记跟着局面还原：刷新后通关仍按「用过撤销」判 undoWins
        state.undoUsed = saved.undoUsed;
        // 双人：回合与两人比分随局面还原，刷新后接着轮到同一个人
        state.turn = saved.turn;
        state.players = saved.players;

        if (saved.daily) {
          if (saved.daily === todayKey()) {
            // 同一天：恢复每日身份，并把随机序列快进到存档时的位置
            state.dailyKey = saved.daily;
            state.rngCount = saved.rngCount;
            state.dailyRecorded = saved.dailyRecorded;
            state.dailyRecordedMoves = saved.dailyRecordedMoves;
            // 复盘入账标记跟着局面还原，刷新后同一局再结算不会重复累加 perfectMoves
            state.perfectRecorded = saved.perfectRecorded;
            restoreDailyRng();
            // 复盘日志随局面存档：刷新前走了多少步，复盘就覆盖多少步；
            // 没算完的步重新排队补评分
            restoreReviewLog(saved.reviewLog, saved.daily);
          } else {
            // 跨日：盘面照常恢复，只是不再属于今天的挑战
            dailyExpired = true;
          }
        }
      }
    }

    if (!restored) {
      startNewGame();
      var record = stats.games > 0
        ? ' · 历史最高 ' + stats.bestScore + ' 分（共 ' + stats.games + ' 局）'
        : '';
      setStatus(
        settings.size + '×' + settings.size + ' · ' + MODES[settings.mode].label +
        ' · 目标 ' + goalValue() + record
      );
      return;
    }

    renderer.setSize(settings.size);
    renderer.renderBoard(state.board, { instant: true });
    hideOverlay();
    renderHud();
    syncControls();
    renderDailyBar();

    if (MODES[settings.mode].timeLimitMs > 0) startCountdown();

    if (dailyExpired) {
      setStatus('昨日挑战已结束 · 今日可重新挑战');
    } else {
      setStatus(
        '接着上一局 · ' + settings.size + '×' + settings.size + ' · ' +
        MODES[settings.mode].label + ' · 得分 ' + state.score
      );
    }
  }

  init();
  requestBoardFit();
})(window);
