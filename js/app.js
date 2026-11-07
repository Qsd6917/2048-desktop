(function () {
  'use strict';

  var G = window.Game2048;

  var SIZE = 4;
  var SLIDE_MS = 110;   // 必须和 styles.css 里 .tile 的 transition 时长一致
  var POP_MS = 175;     // 合成块的弹出动画时长
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
    overlay: document.getElementById('overlay'),
    overlayTitle: document.getElementById('overlayTitle'),
    overlayText: document.getElementById('overlayText'),
    overlayActions: document.getElementById('overlayActions'),
    newGame: document.getElementById('newGame'),
    undo: document.getElementById('undo'),
    status: document.getElementById('status')
  };

  var state = {
    board: G.emptyBoard(SIZE),
    score: 0,
    best: 0,
    won: false,
    keepPlaying: false,
    over: false,
    history: []
  };

  var nodes = new Map();   // tile.id -> { el, inner, text }
  var generation = 0;      // 重开 / 撤销时自增，用来丢弃过期的动画回调

  /* ---------- 尺寸 ---------- */
  function layout() {
    var width = els.board.clientWidth;
    if (!width) return;
    var pad = Math.max(7, Math.round(width * 0.026));
    var gap = Math.max(7, Math.round(width * 0.026));
    var cell = (width - pad * 2 - gap * (SIZE - 1)) / SIZE;
    els.board.style.setProperty('--pad', pad + 'px');
    els.board.style.setProperty('--gap', gap + 'px');
    els.board.style.setProperty('--cell', cell + 'px');
    els.board.style.setProperty('--radius', Math.max(4, Math.round(cell * 0.055)) + 'px');
  }

  function buildGrid() {
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < SIZE * SIZE; i++) {
      var cell = document.createElement('div');
      cell.className = 'grid-cell';
      fragment.appendChild(cell);
    }
    els.grid.innerHTML = '';
    els.grid.appendChild(fragment);
  }

  /* ---------- 方块渲染 ---------- */
  function createNode(tile) {
    var el = document.createElement('div');
    el.className = 'tile';
    // 先定好初始位置再插进 DOM，避免第一帧从 (0,0) 飞过来
    el.style.setProperty('--x', String(tile.col));
    el.style.setProperty('--y', String(tile.row));

    var inner = document.createElement('div');
    inner.className = 'tile__inner';

    var text = document.createElement('span');
    text.className = 'tile__value';
    inner.appendChild(text);
    el.appendChild(inner);

    els.tiles.appendChild(el);

    var node = { el: el, inner: inner, text: text };
    nodes.set(tile.id, node);
    return node;
  }

  function paint(node, tile) {
    node.text.textContent = String(tile.value);
    node.inner.dataset.value = String(tile.value);
    node.inner.classList.toggle('len3', tile.value >= 100 && tile.value < 1000);
    node.inner.classList.toggle('len4', tile.value >= 1000);
    node.inner.classList.toggle('is-super', tile.value > G.WIN_VALUE);
  }

  /**
   * 让一个方块出现在棋盘上。
   * 已存在的方块只更新坐标（靠 CSS transition 滑过去）；
   * 新建的方块按 instant / merged / appear 三种方式入场。
   */
  function mountTile(tile, options) {
    var opts = options || {};
    var node = nodes.get(tile.id);
    var created = false;

    if (!node) {
      node = createNode(tile);
      created = true;
    }

    paint(node, tile);

    if (!created) {
      node.el.style.setProperty('--x', String(tile.col));
      node.el.style.setProperty('--y', String(tile.row));
      return node;
    }

    if (opts.instant) return node;

    node.inner.classList.add(opts.merged ? 'anim-merge' : 'anim-appear');
    if (opts.delay) node.inner.style.animationDelay = opts.delay + 'ms';
    return node;
  }

  function moveTileNode(tile, row, col) {
    var node = nodes.get(tile.id);
    if (!node) return;
    node.el.style.setProperty('--x', String(col));
    node.el.style.setProperty('--y', String(row));
  }

  function removeTile(id) {
    var node = nodes.get(id);
    if (!node) return;
    node.el.remove();
    nodes.delete(id);
  }

  function clearTiles() {
    nodes.forEach(function (node) {
      node.el.remove();
    });
    nodes.clear();
  }

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

    G.tiles(state.board).forEach(function (tile) {
      mountTile(tile, { instant: true });
    });

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

    var gen = generation;
    state.board = result.board;

    // 1. 所有参与移动的方块先滑到目标格（包括马上要被吃掉的两个源块）
    result.slides.forEach(function (slide) {
      moveTileNode(slide.tile, slide.row, slide.col);
    });

    // 2. 合成出来的新块立刻建好但延迟出场，滑动结束的瞬间才亮起
    result.merges.forEach(function (merge) {
      mountTile(merge.tile, { merged: true, delay: SLIDE_MS });
    });

    // 3. 滑动结束后把被合并掉的源块从 DOM 移除
    var consumed = [];
    result.merges.forEach(function (merge) {
      consumed = consumed.concat(merge.sources);
    });
    window.setTimeout(function () {
      if (gen !== generation) return;
      consumed.forEach(function (tile) {
        removeTile(tile.id);
      });
    }, SLIDE_MS);

    // 4. 落一个新子
    var spawned = G.spawnRandom(state.board);
    if (spawned) mountTile(spawned, { delay: SLIDE_MS });

    if (result.gained) addScore(result.gained);
    renderScore();

    // 5. 判定胜负
    if (!state.won && !state.keepPlaying && G.hasWon(state.board)) {
      state.won = true;
      window.setTimeout(function () {
        if (gen !== generation) return;
        showWin();
      }, SLIDE_MS + POP_MS);
    } else if (!G.hasMoves(state.board)) {
      state.over = true;
      window.setTimeout(function () {
        if (gen !== generation) return;
        showGameOver();
      }, SLIDE_MS + POP_MS);
    }

    saveState();
    setStatus('得分 ' + state.score + ' · 最大 ' + G.maxValue(state.board) + ' · 已走 ' + state.history.length + ' 步');
  }

  /* ---------- 撤销 / 重开 ---------- */
  function rebuild(values) {
    clearTiles();
    state.board = G.boardFromValues(values);
    G.tiles(state.board).forEach(function (tile) {
      mountTile(tile, { instant: true });
    });
  }

  function undo() {
    if (!state.history.length) return;

    var snapshot = state.history.pop();
    generation += 1;     // 让还没执行的动画回调全部失效

    hideOverlay();
    state.over = false;
    state.won = snapshot.won;
    state.keepPlaying = snapshot.keepPlaying;
    state.score = snapshot.score;

    rebuild(snapshot.values);
    renderScore();
    saveState();
    setStatus('已撤销一步');
  }

  function startNewGame() {
    generation += 1;
    clearTiles();

    state.history.length = 0;
    state.score = 0;
    state.won = false;
    state.keepPlaying = false;
    state.over = false;

    var game = G.newGame(SIZE);
    state.board = game.board;
    game.spawned.forEach(function (tile, index) {
      mountTile(tile, { delay: index * 60 });
    });

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
    buildGrid();
    layout();

    var storedBest = 0;
    try {
      storedBest = Number(storage.getItem(BEST_KEY)) || 0;
    } catch (e) {
      storedBest = 0;
    }
    state.best = storedBest;

    var restored = restoreState();
    if (!restored) {
      var game = G.newGame(SIZE);
      state.board = game.board;
      game.spawned.forEach(function (tile, index) {
        mountTile(tile, { delay: index * 60 });
      });
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

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(layout).observe(els.board);
    }
    window.addEventListener('resize', layout);

    if (!G.hasMoves(state.board)) {
      state.over = true;
      showGameOver();
    } else if (restored) {
      setStatus('接着上一局 · 得分 ' + state.score + ' · 最大 ' + G.maxValue(state.board));
    }
  }

  init();
})();
