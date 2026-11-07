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

  /* ---------- 常量 ---------- */

  /** 撤销栈深度 */
  var UNDO_LIMIT = 20;
  /** 触摸滑动的最小位移，太小会被当成点击 */
  var SWIPE_THRESHOLD = 24;
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

  /** 三种玩法模式；timeLimitMs 为 0 表示不计时，obstacles 是开局埋的障碍数 */
  var MODES = {
    classic: { label: '经典', timeLimitMs: 0, obstacles: 0 },
    timed: { label: '限时', timeLimitMs: 180000, obstacles: 0 },
    obstacle: { label: '障碍', timeLimitMs: 0, obstacles: 2 }
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
    board: document.getElementById('board'),
    grid: document.getElementById('gridLayer'),
    tiles: document.getElementById('tileLayer'),
    score: document.getElementById('score'),
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
    hint: document.getElementById('hint'),
    autoplay: document.getElementById('autoplay'),
    openSettings: document.getElementById('openSettings'),
    settingsPanel: document.getElementById('settingsPanel'),
    sizeGroup: document.getElementById('sizeGroup'),
    modeGroup: document.getElementById('modeGroup'),
    soundToggle: document.getElementById('soundToggle')
  };

  var renderer = Renderer.create({
    boardEl: els.board,
    gridEl: els.grid,
    tileEl: els.tiles
  });

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
    recordedMoves: 0
  };

  /* ---------- 定时器句柄（换局/换设置必须全部清掉） ---------- */

  var tickTimer = null;      // 倒计时 setInterval
  var tickLast = 0;          // 上一次扣时的基准时刻，避免累计漂移
  var autoplayTimer = null;  // 托管 / 提示用 setTimeout
  var autoplay = false;      // 托管开关（与定时器分开管理）

  /** 动画期间缓冲的玩家方向：最多一格，只保留最后一次按键（不进撤销语义） */
  var pendingDir = null;

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

  function setStatus(text) {
    if (els.status) els.status.textContent = text;
  }

  /** 动画中、结算浮层挡住棋盘、或这一局已经结束时，都不接受新输入 */
  function isLocked() {
    return state.over || state.busy || !els.overlay.hidden;
  }

  /** 毫秒 -> mm:ss（向上取整，这样 180000 显示 03:00 而不是 02:59） */
  function formatClock(ms) {
    var total = Math.ceil(Math.max(0, ms) / 1000);
    var mm = Math.floor(total / 60);
    var ss = total % 60;
    return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  /* ---------- 渲染 ---------- */

  function renderHud() {
    els.score.textContent = String(state.score);
    els.best.textContent = String(Math.max(stats.bestScore, state.score));
    els.goal.textContent = String(goalValue());
    els.maxTile.textContent = String(G.maxValue(state.board));
    els.undo.disabled = state.history.length === 0;
    els.board.setAttribute('aria-label', settings.size + '×' + settings.size + ' 棋盘');
    renderTimer();
  }

  function renderTimer() {
    if (!els.timer) return;

    if (MODES[settings.mode].timeLimitMs <= 0) {
      els.timer.hidden = true;
      els.timer.textContent = '';
      els.timer.classList.remove('is-urgent');
      return;
    }

    var ms = Math.max(0, Math.round(state.remainingMs));
    els.timer.hidden = false;
    els.timer.textContent = formatClock(ms);
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

    if (els.autoplay) {
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
      recordedMoves: state.recordedMoves
    });
  }

  /** 存档里的一格只能是：null/0 空格、-1 障碍、2 的正整数次幂方块 */
  function isValidCell(value) {
    if (value === null || value === 0 || value === -1) return true;
    if (typeof value !== 'number' || !isFinite(value) || value < 2) return false;
    var exponent = Math.log2(value);
    return exponent === Math.floor(exponent) && exponent <= 30;
  }

  /** 读档并校验形状；任何一处不合法就整份丢弃（宁可从新局开始，也不要白屏） */
  function readSaved() {
    var data = Storage.get(Storage.KEYS.state, null);
    if (!data || typeof data !== 'object') return null;

    var size = Math.floor(Number(data.size));
    if (G.SIZES.indexOf(size) < 0) return null;
    if (!Object.prototype.hasOwnProperty.call(MODES, data.mode)) return null;

    var values = data.values;
    if (!Array.isArray(values) || values.length !== size) return null;
    for (var r = 0; r < size; r++) {
      if (!Array.isArray(values[r]) || values[r].length !== size) return null;
      // 合法 JSON 也可能装着脏数据（手改 / 别的脚本写坏），逐格校验，
      // 否则 boardFromValues 会造出 value 为字符串的方块，之后合并全变 NaN
      for (var c = 0; c < size; c++) {
        if (!isValidCell(values[r][c])) return null;
      }
    }

    var limit = MODES[data.mode].timeLimitMs;
    var remaining = Math.max(0, Math.floor(Number(data.remainingMs) || 0));
    if (limit > 0) remaining = Math.min(remaining, limit);
    else remaining = 0;

    var moves = Math.max(0, Math.floor(Number(data.moves) || 0));
    var recorded = data.recorded === true;
    var recordedMoves = Math.max(0, Math.floor(Number(data.recordedMoves) || 0));

    if (typeof data.recorded !== 'boolean') {
      // 早期 v2 存档没有入账标记：won 为 true 说明「达成目标」时已经记过一局，
      // 这里保守地把已有步数当成已入账 —— 宁可少记，也不要把同一局算两次。
      recorded = data.won === true;
      recordedMoves = recorded ? moves : 0;
    }
    if (!recorded) recordedMoves = 0;
    if (recordedMoves > moves) recordedMoves = moves;

    return {
      size: size,
      mode: data.mode,
      values: values,
      score: Math.max(0, Math.floor(Number(data.score) || 0)),
      won: Boolean(data.won),
      keepPlaying: Boolean(data.keepPlaying),
      remainingMs: remaining,
      obstaclesAdded: Math.max(0, Math.floor(Number(data.obstaclesAdded) || 0)),
      moves: moves,
      recorded: recorded,
      recordedMoves: recordedMoves
    };
  }

  /* ---------- 撤销栈 ---------- */

  function pushHistory() {
    state.history.push({
      values: G.toValues(state.board),   // 走之前的棋盘（含障碍）
      score: state.score,
      won: state.won,
      keepPlaying: state.keepPlaying,
      remainingMs: state.remainingMs,
      obstaclesAdded: state.obstaclesAdded,
      moves: state.moves
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
    if (MODES[settings.mode].timeLimitMs <= 0) {
      renderTimer();
      return;
    }
    if (state.over || state.remainingMs <= 0) {
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

  /* ---------- 一局的开始与结束 ---------- */

  function startNewGame() {
    stopCountdown();
    clearAutoplayTimer();

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
    pendingDir = null;
    state.remainingMs = MODES[settings.mode].timeLimitMs;
    state.obstaclesAdded = MODES[settings.mode].obstacles;

    var game = G.newGame({
      size: settings.size,
      obstacleCount: MODES[settings.mode].obstacles
    });
    state.board = game.board;

    // 先 setSize：它会清掉渲染层的障碍账本，否则新一局的障碍落在旧坐标上不会淡入
    renderer.setSize(settings.size);
    renderer.renderBoard(state.board, { instant: true });

    hideOverlay();
    renderHud();
    syncControls();
    saveState();
    startCountdown();

    setStatus(
      settings.size + '×' + settings.size + ' · ' + MODES[settings.mode].label +
      ' · 目标 ' + goalValue() + '，用方向键开始'
    );

    scheduleAutoplay(AUTOPLAY_DELAY_MS);
  }

  /** 幂等：一局只结算一次，谁先触发算谁的 */
  function finishGame(reason) {
    if (state.over) return;

    state.over = true;
    state.busy = false;
    pendingDir = null;   // 结算了就不再兑现缓冲，免得留到下一局去

    stopCountdown();
    disableAutoplay();
    recordGame();
    renderHud();

    if (reason === 'win') {
      Audio.win();
      showWinOverlay();
    } else if (reason === 'time') {
      Audio.gameover();
      showTimeOverlay();
    } else {
      Audio.gameover();
      showStuckOverlay();
    }

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
   */
  function recordGame() {
    var firstTime = !state.recorded;
    var extraMoves = Math.max(0, state.moves - state.recordedMoves);
    if (!firstTime && extraMoves === 0) return;   // 继续挑战期间没有新进展，不必写盘

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

    var tile = G.maxValue(state.board);
    if (state.score > stats.bestScore) stats.bestScore = state.score;
    if (tile > stats.bestTile) stats.bestTile = tile;

    var sizeBucket = stats.bySize[String(settings.size)];
    if (sizeBucket && state.score > sizeBucket.bestScore) sizeBucket.bestScore = state.score;

    Storage.saveStats(stats);
  }

  /* ---------- 走一步 ---------- */

  /**
   * 走一步（真正落子的唯一入口）。
   * @returns {boolean} 是否真的走了一步；被锁、或这个方向推不动都返回 false
   */
  function applyMove(dir) {
    if (isLocked()) return false;

    var result = G.computeMove(state.board, dir);
    if (!result.changed) return false;   // 这个方向推不动，不消耗步数、不留快照

    var session = state.session;

    pushHistory();

    state.busy = true;
    state.board = result.board;    // computeMove 的结果只能消费一次，直接接管
    var spawned = G.spawnRandom(state.board);
    state.moves += 1;

    if (result.gained) addScore(result.gained);
    renderHud();
    playMoveSound(result);

    renderer
      .playMove({
        slides: result.slides,
        merges: result.merges,
        spawned: spawned,
        board: state.board   // 注意：此刻还没有本回合新长出来的障碍
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

  function playMoveSound(result) {
    var merges = result.merges || [];
    var best = 0;
    for (var i = 0; i < merges.length; i++) {
      if (merges[i].value > best) best = merges[i].value;
    }
    // 一次移动里只发一个音：取最大合并值，避免多重合奏糊成一片
    if (best) Audio.merge(best);
    else Audio.move();
  }

  /* ---------- 玩家输入入口 ---------- */

  /**
   * 玩家的一次走子意图（键盘与滑动都走这里）。
   *
   * 动画在播时不能立刻落子，但也不能把意图丢掉——只留最后一格，
   * 等这一步收尾时由 flushPendingDir() 兑现。
   *
   * @returns {boolean} 是否立刻走了一步
   */
  function queueMove(dir) {
    if (state.over || !els.overlay.hidden) return false;   // 已结算 / 浮层挡着：不接受也不缓冲

    if (state.busy) {
      pendingDir = dir;
      return false;
    }

    var moved = applyMove(dir);
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

  /** 动画播完之后的收尾：长障碍、判胜负、决定是否继续托管 */
  function finishTurn() {
    if (state.over) {   // 动画期间时间到，已经结算
      state.busy = false;
      return;
    }

    if (shouldAddObstacle()) addObstacleNow();

    state.busy = false;
    renderHud();

    if (!state.won && !state.keepPlaying && G.hasWon(state.board, goalValue())) {
      state.won = true;
      finishGame('win');
      return;
    }

    if (!G.hasMoves(state.board)) {
      finishGame('stuck');
      return;
    }

    saveState();
    setStatus(
      '得分 ' + state.score + ' · 最大 ' + G.maxValue(state.board) + ' · 已走 ' + state.moves + ' 步'
    );

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
    var obstacle = G.addObstacle(state.board);
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
    stopCountdown();
    state.session += 1;   // 作废在途动画回调
    state.busy = false;
    pendingDir = null;    // 缓冲的是「撤销前那一手之后」的意图，跟着一起作废

    state.board = G.boardFromValues(snapshot.values);
    state.score = snapshot.score;
    state.won = snapshot.won;
    state.keepPlaying = snapshot.keepPlaying;
    state.remainingMs = snapshot.remainingMs;
    state.obstaclesAdded = snapshot.obstaclesAdded;
    state.moves = snapshot.moves;
    state.over = false;

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
    if (autoplay) {
      disableAutoplay();
      setStatus('托管已关闭');
      return;
    }
    if (state.over) {
      setStatus('这一局已经结束，先开新局');
      return;
    }

    autoplay = true;
    syncControls();
    setStatus('托管已开启');
    scheduleAutoplay(AUTOPLAY_DELAY_MS);
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
    els.overlay.hidden = false;

    // 结算浮层是唯一的强提示：读屏用户如果不把焦点送进去，根本不知道这一局结束了
    var primary = els.overlayActions.querySelector('.btn--primary') ||
      els.overlayActions.querySelector('button');
    if (primary) primary.focus();

    // 浮层挡着棋盘时不给倒计时扣时间，玩家可以慢慢想
    stopCountdown();
  }

  function hideOverlay() {
    // 焦点在浮层里的话，关掉后要还给棋盘，键盘玩家不必再 Tab 一遍
    var hadFocus = els.overlay.contains(document.activeElement);
    els.overlay.hidden = true;
    if (hadFocus && els.board) els.board.focus();
  }

  /** 通用按钮组：再来一局必给；有历史才给撤销 */
  function endingActions(withUndo) {
    var actions = [{ label: '再来一局', primary: true, onClick: startNewGame }];
    if (withUndo) actions.push({ label: '撤销一步', onClick: undo });
    return actions;
  }

  function showWinOverlay() {
    var actions = [
      { label: '继续挑战', primary: true, onClick: continuePlaying },
      { label: '再来一局', onClick: startNewGame }
    ];
    if (state.history.length) actions.push({ label: '撤销一步', onClick: undo });

    showOverlay(
      'win',
      '达成目标',
      '你做出了 ' + goalValue() + '，' + MODES[settings.mode].label + '模式通关。本局 ' +
        state.score + ' 分，还能继续往上冲。',
      actions
    );
  }

  function showTimeOverlay() {
    showOverlay(
      'lose',
      '时间到',
      '本局 ' + state.score + ' 分，最大方块 ' + G.maxValue(state.board) + '，走了 ' +
        state.moves + ' 步。',
      endingActions(state.history.length > 0)
    );
  }

  function showStuckOverlay() {
    showOverlay(
      'lose',
      '走不动了',
      '棋盘上没有空格也没有可合并的方块。本局 ' + state.score + ' 分，最大方块 ' +
        G.maxValue(state.board) + '，走了 ' + state.moves + ' 步。',
      endingActions(state.history.length > 0)
    );
  }

  /** 达成目标后接着玩：won 保持 true，所以不会二次弹窗 */
  function continuePlaying() {
    state.keepPlaying = true;
    state.over = false;

    hideOverlay();
    renderHud();
    saveState();

    if (MODES[settings.mode].timeLimitMs > 0) startCountdown();

    setStatus('继续挑战 · 目标已达成，往上接着冲');
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
  }

  /* ---------- 输入 ---------- */

  function onKeyDown(event) {
    if (event.isComposing) return;

    var key = (event.key || '').toLowerCase();
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

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    pointerStart = { x: event.clientX, y: event.clientY };
  }

  function onPointerUp(event) {
    if (!pointerStart) return;

    var dx = event.clientX - pointerStart.x;
    var dy = event.clientY - pointerStart.y;
    pointerStart = null;

    if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return;

    if (Math.abs(dx) > Math.abs(dy)) {
      queueMove(dx > 0 ? 'right' : 'left');
    } else {
      queueMove(dy > 0 ? 'down' : 'up');
    }
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

    bindChoiceGroup(els.sizeGroup, 'size', setSize);
    bindChoiceGroup(els.modeGroup, 'mode', setMode);

    document.addEventListener('keydown', onKeyDown);

    els.board.addEventListener('pointerdown', onPointerDown);
    els.board.addEventListener('pointerup', onPointerUp);
    els.board.addEventListener('pointercancel', function () {
      pointerStart = null;
    });
  }

  /* ---------- 启动 ---------- */

  function init() {
    settings = normalizeSettings(Storage.get(Storage.KEYS.settings, null));
    Audio.setEnabled(settings.sound);
    stats = Storage.loadStats();

    bindControls();

    var saved = readSaved();
    var restored = false;

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

    if (MODES[settings.mode].timeLimitMs > 0) startCountdown();

    setStatus(
      '接着上一局 · ' + settings.size + '×' + settings.size + ' · ' +
      MODES[settings.mode].label + ' · 得分 ' + state.score
    );
  }

  init();
})(window);
