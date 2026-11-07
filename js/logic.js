/**
 * 2048 核心逻辑 —— 纯函数，不碰 DOM。
 *
 * 浏览器里挂到 window.Game2048，Node 里通过 module.exports 导出，
 * 这样同一份代码既能跑游戏，也能单独写测试验证合并规则。
 *
 * 棋盘单元格是三种状态之一：
 *   null        —— 空格，可以落子
 *   Tile        —— { id, value, row, col }，可移动、可合并
 *   Obstacle    —— { obstacle: true, row, col }，不可动、不可合并、不可落子，
 *                  并且会把它所在的那一行/列切断成若干独立段
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Game2048 = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 支持的棋盘尺寸 */
  var SIZES = [4, 5, 6];

  /** 尺寸对应的胜利目标值 */
  var GOAL_BY_SIZE = { 4: 2048, 5: 4096, 6: 8192 };

  var DEFAULT_SIZE = 4;
  var START_TILES = 2;

  /** 旧 4×4 目标值，保留导出以免旧调用方拿到 undefined */
  var WIN_VALUE = 2048;

  var tileSeq = 0;

  function nextTileId() {
    tileSeq += 1;
    return tileSeq;
  }

  function createTile(value, row, col) {
    return { id: nextTileId(), value: value, row: row, col: col };
  }

  function createObstacle(row, col) {
    return { obstacle: true, row: row, col: col };
  }

  function isObstacle(cell) {
    return !!cell && cell.obstacle === true;
  }

  /** 非空且不是障碍，才是一个方块 */
  function isTile(cell) {
    return !!cell && cell.obstacle !== true;
  }

  function emptyBoard(size) {
    var board = [];
    for (var r = 0; r < size; r++) {
      var row = [];
      for (var c = 0; c < size; c++) row.push(null);
      board.push(row);
    }
    return board;
  }

  /** 只统计 null —— 障碍不能被落子，不算空格 */
  function emptyCells(board) {
    var cells = [];
    for (var r = 0; r < board.length; r++) {
      var row = board[r];
      for (var c = 0; c < row.length; c++) {
        if (row[c] === null) cells.push([r, c]);
      }
    }
    return cells;
  }

  function tiles(board) {
    var out = [];
    for (var r = 0; r < board.length; r++) {
      var row = board[r];
      for (var c = 0; c < row.length; c++) {
        if (isTile(row[c])) out.push(row[c]);
      }
    }
    return out;
  }

  function obstacles(board) {
    var out = [];
    for (var r = 0; r < board.length; r++) {
      var row = board[r];
      for (var c = 0; c < row.length; c++) {
        if (isObstacle(row[c])) out.push(row[c]);
      }
    }
    return out;
  }

  /** 障碍输出 -1，空格输出 0，方块输出其值 */
  function toValues(board) {
    return board.map(function (row) {
      return row.map(function (cell) {
        if (isObstacle(cell)) return -1;
        if (isTile(cell)) return cell.value;
        return 0;
      });
    });
  }

  /** -1 还原成障碍，0 建成空格，其余建成方块；缺行缺列按 0 处理 */
  function boardFromValues(values) {
    var size = values.length;
    var board = emptyBoard(size);
    for (var r = 0; r < size; r++) {
      var row = values[r] || [];
      for (var c = 0; c < size; c++) {
        var value = row[c];
        if (value === -1) board[r][c] = createObstacle(r, c);
        else if (value) board[r][c] = createTile(value, r, c);
      }
    }
    return board;
  }

  /** 在随机空格落一个子：90% 是 2，10% 是 4。random 可注入，便于测试。 */
  function spawnRandom(board, random) {
    var rand = random || Math.random;
    var cells = emptyCells(board);
    if (!cells.length) return null;
    var cell = cells[Math.min(cells.length - 1, Math.floor(rand() * cells.length))];
    var value = rand() < 0.9 ? 2 : 4;
    var tile = createTile(value, cell[0], cell[1]);
    board[cell[0]][cell[1]] = tile;
    return tile;
  }

  /** 随机把一个空格变成障碍并写进 board；没有空格时返回 null */
  function addObstacle(board, random) {
    var rand = random || Math.random;
    var cells = emptyCells(board);
    if (!cells.length) return null;
    var cell = cells[Math.min(cells.length - 1, Math.floor(rand() * cells.length))];
    var obstacle = createObstacle(cell[0], cell[1]);
    board[cell[0]][cell[1]] = obstacle;
    return obstacle;
  }

  /**
   * 开新局：opts = { size, obstacleCount, random }。
   * 障碍先摆好再落子，保证开局的两个方块不会被障碍顶掉。
   */
  function newGame(opts) {
    var options = opts || {};
    var size = options.size || DEFAULT_SIZE;
    var random = options.random;

    var board = emptyBoard(size);
    var obstacleCount = Math.max(0, Math.floor(options.obstacleCount || 0));
    for (var i = 0; i < obstacleCount; i++) {
      if (!addObstacle(board, random)) break;
    }

    var spawned = [];
    for (var j = 0; j < START_TILES; j++) {
      var tile = spawnRandom(board, random);
      if (tile) spawned.push(tile);
    }
    return { board: board, spawned: spawned };
  }

  /**
   * 把某一行/列按「移动方向」展开成一条从前排到后排的坐标序列。
   * 所有方向都归约成「读成一条线 -> 往索引 0 压」这一个逻辑，
   * 省掉了四套容易写错的遍历。
   */
  function lineCoords(dir, index, size) {
    var coords = [];
    for (var i = 0; i < size; i++) {
      if (dir === 'left') coords.push([index, i]);
      else if (dir === 'right') coords.push([index, size - 1 - i]);
      else if (dir === 'up') coords.push([i, index]);
      else if (dir === 'down') coords.push([size - 1 - i, index]);
      else throw new Error('未知方向: ' + dir);
    }
    return coords;
  }

  /**
   * 计算一条线里 [start, end) 这一段的结果，写回 next。
   * 段内写回位置从 start 开始 —— 段不从 0 开始时不能假设写指从 0 起。
   * 没变就返回 false。
   */
  function compactSegment(board, next, coords, start, end, out) {
    var line = [];
    for (var i = start; i < end; i++) {
      var cell = board[coords[i][0]][coords[i][1]];
      if (isTile(cell)) line.push(cell);
    }

    var write = start;
    var read = 0;
    while (read < line.length) {
      var current = line[read];
      var partner = line[read + 1];
      var target = coords[write];
      var row = target[0];
      var col = target[1];

      if (partner && partner.value === current.value) {
        // 合并时新建方块、读指针跨过两个源块，保证一次移动内不会二次合并
        var merged = createTile(current.value * 2, row, col);
        next[row][col] = merged;
        out.slides.push({ tile: current, row: row, col: col });
        out.slides.push({ tile: partner, row: row, col: col });
        out.merges.push({
          tile: merged,
          row: row,
          col: col,
          sources: [current, partner],
          value: merged.value
        });
        out.gained += merged.value;
        out.changed = true;
        read += 2;
      } else {
        if (current.row !== row || current.col !== col) out.changed = true;
        next[row][col] = current;
        current.row = row;
        current.col = col;
        out.slides.push({ tile: current, row: row, col: col });
        read += 1;
      }

      write += 1;
    }
  }

  /**
   * 计算一次移动的结果，不修改入参棋盘的数值（但会更新存活方块的 row/col）。
   *
   * 每条线先按障碍切成若干段，每段独立执行「读取 -> 压缩 -> 合并 -> 写回」；
   * 障碍本身原样搬到新棋盘，坐标不变。
   *
   * 返回：
   *   board   —— 移动后的新棋盘
   *   slides  —— [{tile, row, col}] 需要播放位移动画的方块（含被吃掉的两个源块）
   *   merges  —— [{tile, row, col, sources:[a,b], value}] 合成的新块
   *   gained  —— 本次得分
   *   changed —— 棋盘是否真的变了（位移或合并都算变）
   */
  function computeMove(board, dir) {
    var size = board.length;
    var next = emptyBoard(size);
    var out = { slides: [], merges: [], gained: 0, changed: false };

    for (var index = 0; index < size; index++) {
      var coords = lineCoords(dir, index, size);
      var segStart = 0;

      for (var pos = 0; pos <= size; pos++) {
        var blocked = pos < size && isObstacle(board[coords[pos][0]][coords[pos][1]]);
        if (pos < size && !blocked) continue;

        // pos 是段结束位置（障碍前 / 线尾），先处理 [segStart, pos)
        if (pos > segStart) {
          compactSegment(board, next, coords, segStart, pos, out);
        }
        // 障碍原样落到新棋盘
        if (blocked) {
          var obstacleCell = coords[pos];
          next[obstacleCell[0]][obstacleCell[1]] = board[obstacleCell[0]][obstacleCell[1]];
          segStart = pos + 1;
        }
      }
    }

    return {
      board: next,
      slides: out.slides,
      merges: out.merges,
      gained: out.gained,
      changed: out.changed
    };
  }

  /**
   * 还有空格，或存在相邻同值，就还能走。
   * 障碍既不等于 null，也不等于任何方块，直接跳过。
   */
  function hasMoves(board) {
    var size = board.length;
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        var cell = board[r][c];
        if (!cell) return true;
        if (!isTile(cell)) continue;
        if (c + 1 < size) {
          var right = board[r][c + 1];
          if (isTile(right) && right.value === cell.value) return true;
        }
        if (r + 1 < size) {
          var down = board[r + 1][c];
          if (isTile(down) && down.value === cell.value) return true;
        }
      }
    }
    return false;
  }

  /** 不传 goal 时按棋盘尺寸取目标值 */
  function hasWon(board, goal) {
    var target = goal || GOAL_BY_SIZE[board.length] || GOAL_BY_SIZE[DEFAULT_SIZE];
    return tiles(board).some(function (tile) {
      return tile.value >= target;
    });
  }

  function maxValue(board) {
    return tiles(board).reduce(function (max, tile) {
      return tile.value > max ? tile.value : max;
    }, 0);
  }

  return {
    SIZES: SIZES,
    GOAL_BY_SIZE: GOAL_BY_SIZE,
    WIN_VALUE: WIN_VALUE,
    createTile: createTile,
    createObstacle: createObstacle,
    isTile: isTile,
    emptyBoard: emptyBoard,
    emptyCells: emptyCells,
    tiles: tiles,
    obstacles: obstacles,
    toValues: toValues,
    boardFromValues: boardFromValues,
    spawnRandom: spawnRandom,
    addObstacle: addObstacle,
    newGame: newGame,
    computeMove: computeMove,
    hasMoves: hasMoves,
    hasWon: hasWon,
    maxValue: maxValue
  };
});
