/**
 * 2048 核心逻辑 —— 纯函数，不碰 DOM。
 *
 * 浏览器里挂到 window.Game2048，Node 里通过 module.exports 导出，
 * 这样同一份代码既能跑游戏，也能单独写测试验证合并规则。
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

  var WIN_VALUE = 2048;
  var START_TILES = 2;

  var tileSeq = 0;

  function nextTileId() {
    tileSeq += 1;
    return tileSeq;
  }

  function createTile(value, row, col) {
    return { id: nextTileId(), value: value, row: row, col: col };
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

  function emptyCells(board) {
    var cells = [];
    for (var r = 0; r < board.length; r++) {
      for (var c = 0; c < board.length; c++) {
        if (!board[r][c]) cells.push([r, c]);
      }
    }
    return cells;
  }

  function tiles(board) {
    var out = [];
    for (var r = 0; r < board.length; r++) {
      for (var c = 0; c < board.length; c++) {
        if (board[r][c]) out.push(board[r][c]);
      }
    }
    return out;
  }

  function toValues(board) {
    return board.map(function (row) {
      return row.map(function (tile) {
        return tile ? tile.value : 0;
      });
    });
  }

  function boardFromValues(values) {
    var board = emptyBoard(values.length);
    for (var r = 0; r < values.length; r++) {
      for (var c = 0; c < values.length; c++) {
        if (values[r][c]) board[r][c] = createTile(values[r][c], r, c);
      }
    }
    return board;
  }

  /** 在随机空格落一个子：90% 是 2，10% 是 4。random 可注入，便于测试。 */
  function spawnRandom(board, random) {
    var rand = random || Math.random;
    var cells = emptyCells(board);
    if (!cells.length) return null;
    var cell = cells[Math.floor(rand() * cells.length)];
    var value = rand() < 0.9 ? 2 : 4;
    var tile = createTile(value, cell[0], cell[1]);
    board[cell[0]][cell[1]] = tile;
    return tile;
  }

  function newGame(size, random) {
    var board = emptyBoard(size);
    var spawned = [];
    for (var i = 0; i < START_TILES; i++) {
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
   * 计算一次移动的结果，不修改入参棋盘（但会更新存活方块的 row/col）。
   *
   * 关键规则：同一次移动里，刚合成出来的方块不能再次合并。
   * 这里用「合并时新建 tile 对象、读指针直接跨过两个源块」来保证，
   * 所以 [2,2,4] 向左一定得到 [4,4]，不会变成 [8]。
   *
   * 返回：
   *   board   —— 移动后的新棋盘
   *   slides  —— [{tile, row, col}] 需要播放位移动画的方块（含被吃掉的两个源块）
   *   merges  —— [{tile, row, col, sources:[a,b], value}] 合成的新块
   *   gained  —— 本次得分
   *   changed —— 棋盘是否真的变了（没变就不该落子）
   */
  function computeMove(board, dir) {
    var size = board.length;
    var next = emptyBoard(size);
    var slides = [];
    var merges = [];
    var gained = 0;
    var changed = false;

    for (var index = 0; index < size; index++) {
      var coords = lineCoords(dir, index, size);
      var line = [];
      for (var k = 0; k < coords.length; k++) {
        var tile = board[coords[k][0]][coords[k][1]];
        if (tile) line.push(tile);
      }

      var write = 0;
      var read = 0;
      while (read < line.length) {
        var current = line[read];
        var partner = line[read + 1];
        var target = coords[write];
        var row = target[0];
        var col = target[1];

        if (partner && partner.value === current.value) {
          var merged = createTile(current.value * 2, row, col);
          next[row][col] = merged;
          slides.push({ tile: current, row: row, col: col });
          slides.push({ tile: partner, row: row, col: col });
          merges.push({
            tile: merged,
            row: row,
            col: col,
            sources: [current, partner],
            value: merged.value
          });
          gained += merged.value;
          changed = true;
          read += 2;
        } else {
          if (current.row !== row || current.col !== col) changed = true;
          next[row][col] = current;
          current.row = row;
          current.col = col;
          slides.push({ tile: current, row: row, col: col });
          read += 1;
        }

        write += 1;
      }
    }

    return {
      board: next,
      slides: slides,
      merges: merges,
      gained: gained,
      changed: changed
    };
  }

  /** 还有空格，或存在相邻同值，就还能走。 */
  function hasMoves(board) {
    var size = board.length;
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        var tile = board[r][c];
        if (!tile) return true;
        if (c + 1 < size) {
          var right = board[r][c + 1];
          if (right && right.value === tile.value) return true;
        }
        if (r + 1 < size) {
          var down = board[r + 1][c];
          if (down && down.value === tile.value) return true;
        }
      }
    }
    return false;
  }

  function hasWon(board) {
    return tiles(board).some(function (tile) {
      return tile.value >= WIN_VALUE;
    });
  }

  function maxValue(board) {
    return tiles(board).reduce(function (max, tile) {
      return tile.value > max ? tile.value : max;
    }, 0);
  }

  return {
    WIN_VALUE: WIN_VALUE,
    emptyBoard: emptyBoard,
    emptyCells: emptyCells,
    tiles: tiles,
    toValues: toValues,
    boardFromValues: boardFromValues,
    createTile: createTile,
    spawnRandom: spawnRandom,
    newGame: newGame,
    computeMove: computeMove,
    hasMoves: hasMoves,
    hasWon: hasWon,
    maxValue: maxValue
  };
});
