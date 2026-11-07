/**
 * 2048 控制器 —— 玩法状态、输入、存档、浮层。
 * 棋盘上的 DOM 与动画全部交给 Game2048Renderer（js/renderer.js）。
 */
(function () {
  'use strict';

  var G = window.Game2048;
  var Renderer = window.Game2048Renderer;

  var SIZE = 4;
  var UNDO_LIMIT = 20;
  var BEST_KEY = 'game2048.best';
  var STATE_KEY = 'game2048.state';
  var SWIPE_THRESHOLD = 24;

  /* ---------- 本地存储（file:// 下可能被禁用，降级到内存） ---------- */
  var storage = (function () {
    try {
      var probe = '__probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return window.localStorage;
    } catch (e) {
      var memory = Object.create(null);
      return {
        getItem: function (key) {
          return key in memory ? memory[key] : null;
        },
        setItem: function (key, value) {
          memory[key] = String(value);
        },
        removeItem: function (key) {
          delete memory[key];
        }
      };
    }
  })();

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
    status: document.getElementById('status')
  };

  var renderer = Renderer.create({
    boardEl: els.board,
    gridEl: els.grid,
    tileEl: els.tiles
  });

  var state = {
    board: G.emptyBoard(SIZE),
    score: 0,
    best: 0,
    won: false,
    keepPlaying: false,
    over: false,
    history: []
  };

  /* ---------- 分数 ---------- */
  function addScore(delta) {
    state.score += delta;
    if (state.score > state.best) {
      state.best = state.score;
      try {
        storage.setItem(BEST_KEY, String(state.best));
      } catch (e) {
        /* 存不进去也不影响玩 */
      }
    }
    els.gain.textContent = '+' + delta;
    els.gain.classList.remove('is-shown');
    void els.gain.offsetWidth;  // 强制重排，让动画能重播
    els.gain.classList.add('is-shown');
  }

  function renderScore() {
    els.score.textContent = String(state.score);
    els.best.textContent = String(state.best);
    if (els.goal) els.goal.textContent = String(G.GOAL_BY_SIZE[SIZE]);
    if (els.maxTile) els.maxTile.textContent = String(G.maxValue(state.board));
    els.undo.disabled = state.history.length === 0;
  }

  function setStatus(text) {
    if (els.status) els.status.textContent = text;
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
  }

  function hideOverlay() {
    els.overlay.hidden = true;
  }

  function showWin() {
    showOverlay('win', '拿到 2048 了', '继续玩还能往上冲，别停在这儿。', [
      {
        label: '继续挑战',
        primary: true,
        onClick: function () {
          state.keepPlaying = true;
          hideOverlay();
          saveState();
        }
      },
      { label: '重新开始', onClick: startNewGame }
    ]);
  }

  function showGameOver() {
    var actions = [{ label: '再来一局', primary: true, onClick: startNewGame }];
    if (state.history.length) {
      actions.push({ label: '撤销一步', onClick: undo });
    }
    showOverlay(
      'lose',
      '走不动了',
      '本局 ' + state.score + ' 分，最大方块 ' + G.maxValue(state.board) + '。',
      actions
    );
  }

  function isBlocked() {
    return state.over || !els.overlay.hidden;
  }

  /* ---------- 存档 ---------- */
  function saveState() {
    try {
      storage.setItem(
        STATE_KEY,
        JSON.stringify({
          values: G.toValues(state.board),
          score: state.score,
          won: state.won,
          keepPlaying: state.keepPlaying
        })
      );
    } catch (e) {
      /* 忽略 */
    }
  }

  /** 读档成功时把局面写进 state（渲染由调用方负责） */
  function restoreState() {
    var raw;
    try {
      raw = storage.getItem(STATE_KEY);
    } catch (e) {
      return false;
    }
    if (!raw) return false;

    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return false;
    }

    if (!data || !Array.isArray(data.values) || data.values.length !== SIZE) return false;
    var shapeOk = data.values.every(function (row) {
      return Array.isArray(row) && row.length === SIZE;
    });
    if (!shapeOk) return false;

    state.score = Number(data.score) || 0;
    state.won = Boolean(data.won);
    state.keepPlaying = Boolean(data.keepPlaying);
    state.board = G.boardFromValues(data.values);

    return true;
  }

  /* ---------- 走一步 ---------- */
  function pushHistory() {
    state.history.push({
      values: G.toValues(state.board),
      score: state.score,
      won: state.won,
      keepPlaying: state.keepPlaying
    });
    if (state.history.length > UNDO_LIMIT) state.history.shift();
  }

  function applyMove(dir) {
    if (isBlocked()) return;

    var result = G.computeMove(state.board, dir);
    if (!result.changed) return;

    pushHistory();

    state.board = result.board;

    // 落子属于规则，放在控制器里；渲染层只负责把它演出来
    var spawned = G.spawnRandom(state.board);

    if (result.gained) addScore(result.gained);
    renderScore();

    // 胜负先判定（立刻影响存档与是否还能走），浮层等动画播完再弹
    var ending = null;
    if (!state.won && !state.keepPlaying && G.hasWon(state.board)) {
      state.won = true;
      ending = 'win';
    } else if (!G.hasMoves(state.board)) {
      state.over = true;
      ending = 'lose';
    }

    saveState();
    setStatus('得分 ' + state.score + ' · 最大 ' + G.maxValue(state.board) + ' · 已走 ' + state.history.length + ' 步');

    renderer
      .playMove({
        slides: result.slides,
        merges: result.merges,
        spawned: spawned,
        board: state.board
      })
      .then(function (completed) {
        // 动画被撤销/重开打断时 completed 为 false，这一局已经作废，不再弹结算
        if (!completed || !ending) return;
        if (ending === 'win') showWin();
        else showGameOver();
      });
  }

  /* ---------- 撤销 / 重开 ---------- */
  function undo() {
    if (!state.history.length) return;

    var snapshot = state.history.pop();

    hideOverlay();
    state.over = false;
    state.won = snapshot.won;
    state.keepPlaying = snapshot.keepPlaying;
    state.score = snapshot.score;

    // renderBoard 内部会自增渲染层的 generation，未完成的动画回调与 Promise 一并作废
    state.board = G.boardFromValues(snapshot.values);
    renderer.renderBoard(state.board, { instant: true });

    renderScore();
    saveState();
    setStatus('已撤销一步');
  }

  function startNewGame() {
    state.history.length = 0;
    state.score = 0;
    state.won = false;
    state.keepPlaying = false;
    state.over = false;

    var game = G.newGame({ size: SIZE });
    state.board = game.board;
    // 不带 instant：两个开局方块错开入场，和基线表现一致
    renderer.renderBoard(state.board);

    hideOverlay();
    renderScore();
    saveState();
    setStatus('新的一局，用方向键开始');
  }

  /* ---------- 输入 ---------- */
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
    if (dir) {
      event.preventDefault();
      applyMove(dir);
    }
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
      applyMove(dx > 0 ? 'right' : 'left');
    } else {
      applyMove(dy > 0 ? 'down' : 'up');
    }
  }

  /* ---------- 启动 ---------- */
  function init() {
    renderer.setSize(SIZE);   // 建 4×4 网格并清空全部方块

    var storedBest = 0;
    try {
      storedBest = Number(storage.getItem(BEST_KEY)) || 0;
    } catch (e) {
      storedBest = 0;
    }
    state.best = storedBest;

    var restored = restoreState();
    if (restored) {
      renderer.renderBoard(state.board, { instant: true });
    } else {
      var game = G.newGame({ size: SIZE });
      state.board = game.board;
      renderer.renderBoard(state.board);
    }

    renderScore();

    els.newGame.addEventListener('click', startNewGame);
    els.undo.addEventListener('click', undo);
    document.addEventListener('keydown', onKeyDown);
    els.board.addEventListener('pointerdown', onPointerDown);
    els.board.addEventListener('pointerup', onPointerUp);
    els.board.addEventListener('pointercancel', function () {
      pointerStart = null;
    });

    if (!G.hasMoves(state.board)) {
      state.over = true;
      showGameOver();
    } else if (restored) {
      setStatus('接着上一局 · 得分 ' + state.score + ' · 最大 ' + G.maxValue(state.board));
    }
  }

  init();
})();
