/**
 * 2048 渲染层 —— 只负责 DOM 与动画，不含任何游戏规则。
 *
 * 职责边界：
 *   - 建网格、算尺寸变量、摆放方块与障碍、播放滑动/合并/入场动画；
 *   - 不判断胜负、不算合并、不落子（这些属于 js/logic.js 与控制器）。
 *
 * 动画约定（与 styles.css 配合，不能混用）：
 *   - 外层 `.tile` 只用 transform: translate 负责位移，靠 CSS transition 滑过去；
 *   - 内层 `.tile__inner` 只用 scale 负责入场/合并的弹出效果。
 *
 * 尺寸与屏障：
 *   - 所有方块都绝对定位在 `.tile-layer` 里，坐标通过 `--x/--y` 交给 CSS 换算；
 *   - 网格格子数、棋盘边长由 `--size` 决定，因此 4/5/6 共用同一套样式。
 *
 * 棋盘三态（来自 logic.js）：null 空 / Tile {id,value,row,col} / Obstacle {obstacle:true,row,col}
 */
(function (global) {
  'use strict';

  var G = global.Game2048;

  var SLIDE_MS = 110;    // 必须和 styles.css 里 .tile 的 transition 时长一致
  var POP_MS = 175;      // 合成块弹出动画时长，必须和 .tile__inner.anim-merge 一致
  var STAGGER_MS = 60;   // renderBoard 逐个入场的间隔（新局两个方块错开出现）
  var DEFAULT_SIZE = 4;

  /**
   * 创建一个渲染器实例。
   * @param {{boardEl: HTMLElement, gridEl: HTMLElement, tileEl: HTMLElement}} options
   */
  function create(options) {
    var opts = options || {};
    var boardEl = opts.boardEl;
    var gridEl = opts.gridEl;
    var tileEl = opts.tileEl;

    if (!boardEl || !gridEl || !tileEl) {
      throw new Error('Game2048Renderer.create 需要 boardEl / gridEl / tileEl');
    }

    var size = DEFAULT_SIZE;
    var nodes = new Map();          // tile.id -> { el, inner, text, x, y }
    var obstacleNodes = new Map();  // 'obs-<r>-<c>' -> el
    var obstacleKeys = new Set();   // 渲染过的障碍，用来判断哪些是「新增」
    var generation = 0;             // 清空/换尺寸时自增，丢弃过期的动画回调
    var pending = [];               // 未完成的 playMove：{ settle }
    var layoutListeners = [];

    /* ---------- 尺寸 ---------- */

    /** 按当前边长重算 --pad/--gap/--cell/--radius，并通知布局监听者 */
    function layout() {
      var width = boardEl.clientWidth;
      if (!width) return;

      var pad = Math.max(7, Math.round(width * 0.026));
      var gap = Math.max(7, Math.round(width * 0.026));
      // 关键公式：格子宽要扣掉两侧内边距和 (size-1) 条间隙
      var cell = (width - pad * 2 - gap * (size - 1)) / size;
      var radius = Math.max(4, Math.round(cell * 0.055));

      boardEl.style.setProperty('--size', String(size));
      boardEl.style.setProperty('--pad', pad + 'px');
      boardEl.style.setProperty('--gap', gap + 'px');
      boardEl.style.setProperty('--cell', cell + 'px');
      boardEl.style.setProperty('--radius', radius + 'px');

      for (var i = 0; i < layoutListeners.length; i++) {
        layoutListeners[i]({ size: size, width: width, pad: pad, gap: gap, cell: cell });
      }
    }

    function buildGrid() {
      var fragment = document.createDocumentFragment();
      for (var i = 0; i < size * size; i++) {
        var cell = document.createElement('div');
        cell.className = 'grid-cell';
        fragment.appendChild(cell);
      }
      gridEl.innerHTML = '';
      gridEl.appendChild(fragment);
    }

    /* ---------- 方块节点 ---------- */

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

      tileEl.appendChild(el);

      var node = { el: el, inner: inner, text: text, x: tile.col, y: tile.row };
      nodes.set(tile.id, node);
      return node;
    }

    function paint(node, tile) {
      node.text.textContent = String(tile.value);
      node.inner.dataset.value = String(tile.value);
      // 字号分档：2 位以内用基础字号，3 位 / 4 位以上逐级缩小
      node.inner.classList.toggle('len2', tile.value < 100);
      node.inner.classList.toggle('len3', tile.value >= 100 && tile.value < 1000);
      node.inner.classList.toggle('len4', tile.value >= 1000);
      // 超越目标才走深色：目标值随尺寸变（4→2048 / 5→4096 / 6→8192）
      var goal = G.GOAL_BY_SIZE[size] || G.WIN_VALUE;
      node.inner.classList.toggle('is-super', tile.value > goal);
    }

    /** 记录并设置方块的新坐标（外层 translate 全靠这两个变量） */
    function placeNode(node, row, col) {
      node.el.style.setProperty('--x', String(col));
      node.el.style.setProperty('--y', String(row));
      node.x = col;
      node.y = row;
    }

    /**
     * 让一个方块出现在棋盘上。
     * 已存在的方块只更新坐标（靠 CSS transition 滑过去）；
     * 新建的方块按 instant / merged / appear 三种方式入场。
     */
    function mountTile(tile, tileOptions) {
      var tileOpts = tileOptions || {};
      var node = nodes.get(tile.id);
      var created = false;

      if (!node) {
        node = createNode(tile);
        created = true;
      }

      paint(node, tile);

      if (!created) {
        placeNode(node, tile.row, tile.col);
        return node;
      }

      if (tileOpts.instant) return node;

      node.inner.classList.add(tileOpts.merged ? 'anim-merge' : 'anim-appear');
      if (tileOpts.delay) node.inner.style.animationDelay = tileOpts.delay + 'ms';
      return node;
    }

    function removeTile(id) {
      var node = nodes.get(id);
      if (!node) return;
      node.el.remove();
      nodes.delete(id);
    }

    /* ---------- 障碍 ---------- */

    /** 障碍按 tile 渲染：需要绝对定位，内容是空 div，不设 data-value */
    function mountObstacle(obstacle) {
      var key = 'obs-' + obstacle.row + '-' + obstacle.col;
      var el = obstacleNodes.get(key);

      if (!el) {
        el = document.createElement('div');
        el.className = 'tile tile--obstacle';
        el.style.setProperty('--x', String(obstacle.col));
        el.style.setProperty('--y', String(obstacle.row));
        tileEl.appendChild(el);
        obstacleNodes.set(key, el);
      }

      // 只对「第一次见到」的障碍加入场标记，老障碍重绘时不再播动画
      if (!obstacleKeys.has(key)) {
        obstacleKeys.add(key);
        el.classList.add('is-new');
      }

      return el;
    }

    /* ---------- 对外方法 ---------- */

    /** 清空方块与障碍，并让所有未完成的 playMove 立即 resolve(false) */
    function clear() {
      generation += 1;

      var waiting = pending.slice();
      pending.length = 0;
      for (var i = 0; i < waiting.length; i++) waiting[i].settle(false);

      nodes.forEach(function (node) {
        node.el.remove();
      });
      nodes.clear();

      obstacleNodes.forEach(function (el) {
        el.remove();
      });
      obstacleNodes.clear();
      // 注意：obstacleKeys 保留 —— 它记的是「这个坐标曾经渲染过障碍」，
      // 清空 DOM 不等于障碍是新出现的。
    }

    /** 换尺寸：重建底层网格、清空所有方块，然后重算布局 */
    function setSize(nextSize) {
      var value = Math.floor(Number(nextSize));
      if (!(value > 0)) value = DEFAULT_SIZE;
      size = value;
      boardEl.style.setProperty('--size', String(size));

      obstacleKeys.clear();  // 整块棋盘换掉了，障碍重新记账
      buildGrid();
      clear();
      layout();
    }

    /**
     * 按棋盘全量重建（新局、撤销、读档用）。
     * @param {Array} board
     * @param {{instant?: boolean}} boardOptions instant 时不播入场动画；
     *        非 instant 时方块逐个错开 STAGGER_MS 出现（和基线新局一致）。
     */
    function renderBoard(board, boardOptions) {
      var boardOpts = boardOptions || {};
      clear();
      if (!board) return;

      var list = G.tiles(board);
      for (var i = 0; i < list.length; i++) {
        if (boardOpts.instant) mountTile(list[i], { instant: true });
        else mountTile(list[i], { delay: i * STAGGER_MS });
      }

      var blocks = G.obstacles(board);
      for (var j = 0; j < blocks.length; j++) mountObstacle(blocks[j]);
    }

    /**
     * 播放一次移动的全部动画。
     * @param {{slides: Array, merges: Array, spawned?: object, board?: Array}} result
     *        computeMove 的返回值，加上控制器落子后的 spawned 与新棋盘。
     * @param {{animate?: boolean}} moveOptions animate === false 时直接落到终局状态。
     * @returns {Promise<boolean>} 动画播完为 true；被 clear()/renderBoard() 取消为 false。
     *          无论哪条路径都一定会 resolve，不会悬挂。
     */
    function playMove(result, moveOptions) {
      var moveOpts = moveOptions || {};
      var animate = moveOpts.animate !== false;
      var gen = generation;

      // 1. 先让方块滑到目标格。computeMove 的 slides 里含「原地不动」的项
      //    （from === to），必须靠节点当前坐标过滤掉，否则每次都跑一遍空动画。
      var slides = result.slides || [];
      for (var i = 0; i < slides.length; i++) {
        var slide = slides[i];
        var node = nodes.get(slide.tile.id);
        if (!node) continue;
        if (node.x === slide.col && node.y === slide.row) continue;
        placeNode(node, slide.row, slide.col);
      }

      // 2. 合成出来的新块立刻建好但延迟出场，滑动结束的瞬间才亮起
      var merges = result.merges || [];
      for (var m = 0; m < merges.length; m++) {
        mountTile(merges[m].tile, animate ? { merged: true, delay: SLIDE_MS } : { instant: true });
      }

      // 3. 被合并掉的源块等滑动结束后再移除
      var consumed = [];
      for (var k = 0; k < merges.length; k++) {
        consumed = consumed.concat(merges[k].sources);
      }

      function removeConsumed() {
        for (var n = 0; n < consumed.length; n++) removeTile(consumed[n].id);
      }

      // 4. 落一个新子
      if (result.spawned) {
        mountTile(result.spawned, animate ? { delay: SLIDE_MS } : { instant: true });
      }

      // 5. 棋盘上新增的障碍（模式玩法用；本任务不会触发，接口先留好）
      if (result.board) {
        var blocks = G.obstacles(result.board);
        for (var b = 0; b < blocks.length; b++) mountObstacle(blocks[b]);
      }

      if (!animate) {
        removeConsumed();
        return Promise.resolve(true);
      }

      return new Promise(function (resolve) {
        var entry = {
          settled: false,
          settle: function (completed) {
            if (entry.settled) return;
            entry.settled = true;
            var index = pending.indexOf(entry);
            if (index >= 0) pending.splice(index, 1);
            resolve(completed);
          }
        };
        pending.push(entry);

        // 滑动结束：清掉被吃掉的源块
        global.setTimeout(function () {
          if (gen !== generation) return;   // 期间被清空过，节点已经没了
          removeConsumed();
        }, SLIDE_MS);

        // 滑动 + 弹出都结束：收尾。过期的一律按「取消」处理，保证 Promise 一定能 resolve
        global.setTimeout(function () {
          if (entry.settled) return;        // clear() 已经替它 settle 过了
          entry.settle(gen === generation);
        }, SLIDE_MS + POP_MS);
      });
    }

    /** 订阅尺寸变化（resize / 换尺寸都会触发） */
    function onLayoutChange(callback) {
      if (typeof callback === 'function') layoutListeners.push(callback);
    }

    /* ---------- 自适应 ---------- */
    if (typeof global.ResizeObserver === 'function') {
      new global.ResizeObserver(function () {
        layout();
      }).observe(boardEl);
    }
    global.addEventListener('resize', layout);

    return {
      setSize: setSize,
      layout: layout,
      renderBoard: renderBoard,
      playMove: playMove,
      clear: clear,
      onLayoutChange: onLayoutChange
    };
  }

  global.Game2048Renderer = { create: create };
})(window);
