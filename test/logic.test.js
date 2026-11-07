/**
 * 2048 核心逻辑测试（纯 Node，无依赖）
 * 运行：node test/logic.test.js
 *
 * 棋盘用数值矩阵描述：0 = 空格，-1 = 障碍，其余 = 方块值。
 */
const G = require('../js/logic.js');

let pass = 0;
let fail = 0;

function str(value) {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

function eq(name, actual, expected) {
  if (str(actual) === str(expected)) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + '\n        实际 ' + str(actual) + '\n        期望 ' + str(expected));
  }
}

/** 一组断言：内部抛异常时记一条失败，不影响后面分组继续跑。 */
function group(name, fn) {
  console.log('\n' + name);
  try {
    fn();
  } catch (err) {
    fail++;
    console.log('  FAIL  分组执行异常: ' + (err && err.message ? err.message : err));
  }
}

/* ---------- 断言 helper ----------
 * 尺寸规则：assertMove / assertColumn 以 expected.length 作为棋盘边长；
 * 给定的行按序填入，缺的行补零、缺的列补零。
 */
function padTo(rows, size) {
  const out = [];
  for (let r = 0; r < size; r++) {
    const src = rows[r] || [];
    const row = [];
    for (let c = 0; c < size; c++) row.push(src[c] === undefined ? 0 : src[c]);
    out.push(row);
  }
  return out;
}

function runMove(rows, size, dir) {
  return G.computeMove(G.boardFromValues(padTo(rows, size)), dir);
}

/** 比较移动后第一行的数值。 */
function assertMove(rows, dir, expected) {
  const size = expected.length;
  const res = runMove(rows, size, dir);
  eq('移动 ' + dir + ' ' + str(padTo(rows, size)[0]) + ' => ' + str(expected),
    G.toValues(res.board)[0], expected);
}

/** 比较移动后第一列的数值。 */
function assertColumn(rows, dir, expected) {
  const size = expected.length;
  const res = runMove(rows, size, dir);
  eq('列 ' + dir + ' ' + str(padTo(rows, size).map((row) => row[0])) + ' => ' + str(expected),
    G.toValues(res.board).map((row) => row[0]), expected);
}

/** 比较整盘数值。 */
function assertBoard(rows, dir, expected) {
  const res = runMove(rows, rows.length, dir);
  eq('整盘 ' + dir, G.toValues(res.board), expected);
  return res;
}

function assertGained(rows, dir, expected) {
  const size = rows[0].length;
  const res = runMove(rows, size, dir);
  eq('得分 ' + dir + ' ' + str(padTo(rows, size)) + ' => ' + expected, res.gained, expected);
}

function assertChanged(rows, dir, expected) {
  const size = rows[0].length;
  const res = runMove(rows, size, dir);
  eq('changed ' + dir + ' ' + str(padTo(rows, size)[0]) + ' => ' + expected, res.changed, expected);
}

const EMPTY = (size) => new Array(size).fill(0);

/* ================= 1. 常量与工厂 ================= */
group('[1] 常量与工厂', () => {
  eq('GOAL_BY_SIZE', G.GOAL_BY_SIZE, { 4: 2048, 5: 4096, 6: 8192 });
  eq('SIZES', G.SIZES, [4, 5, 6]);

  const tile = G.createTile(8, 2, 3);
  eq('createTile 值', tile.value, 8);
  eq('createTile 坐标', [tile.row, tile.col], [2, 3]);
  eq('createTile 有自增 id', typeof tile.id === 'number' && tile.id > 0, true);
  eq('createTile 不是障碍', tile.obstacle === undefined, true);

  const obstacle = G.createObstacle(1, 2);
  eq('createObstacle 标记', obstacle.obstacle, true);
  eq('createObstacle 坐标', [obstacle.row, obstacle.col], [1, 2]);

  eq('isTile(null)', G.isTile(null), false);
  eq('isTile(障碍)', G.isTile(obstacle), false);
  eq('isTile(方块)', G.isTile(tile), true);
});

/* ================= 2. 三态棋盘 ================= */
group('[2] 三态棋盘：空 / 方块 / 障碍', () => {
  const fresh = G.emptyBoard(5);
  eq('emptyBoard 行数', fresh.length, 5);
  eq('emptyBoard 全空', fresh.every((row) => row.length === 5 && row.every((cell) => cell === null)), true);
  eq('emptyBoard 空格数', G.emptyCells(fresh).length, 25);

  const values = [
    [2, -1, 0, 4],
    [0, 0, 0, 0],
    [8, 0, -1, 0],
    [0, 0, 0, 16]
  ];
  const board = G.boardFromValues(values);
  eq('toValues 往返一致', G.toValues(board), values);
  eq('障碍输出 -1', G.toValues(board)[0][1], -1);
  eq('空格输出 0', G.toValues(board)[0][2], 0);
  eq('boardFromValues 建出障碍', G.isTile(board[0][1]) === false && board[0][1].obstacle === true, true);
  eq('tiles 只数方块', G.tiles(board).length, 4);
  eq('obstacles 只数障碍', G.obstacles(board).length, 2);
  eq('obstacles 坐标正确', G.obstacles(board).map((o) => [o.row, o.col]), [[0, 1], [2, 2]]);
  eq('emptyCells 不数障碍', G.emptyCells(board).length, 16 - 4 - 2);
  eq('emptyCells 只给 null 格', G.emptyCells(board).some((cell) => !G.isTile(board[cell[0]][cell[1]]) && !!board[cell[0]][cell[1]]), false);
});

/* ================= 3. 合并规则 ================= */
group('[3] 合并规则（一次移动内不二次合并）', () => {
  assertMove([[2, 2, 4, 0]], 'left', [4, 4, 0, 0]);
  assertMove([[2, 2, 2, 2]], 'left', [4, 4, 0, 0]);
  assertMove([[4, 4, 4, 0]], 'left', [8, 4, 0, 0]);
  assertMove([[2, 2, 2, 0]], 'right', [0, 0, 2, 4]);
  assertMove([[2, 0, 0, 2]], 'left', [4, 0, 0, 0]);
  assertMove([[0, 2, 0, 4]], 'right', [0, 0, 2, 4]);
});

/* ================= 4. 纵向 ================= */
group('[4] 纵向移动', () => {
  const column = [[2, 0, 0, 0], [2, 0, 0, 0], [4, 0, 0, 0], [4, 0, 0, 0]];
  assertColumn(column, 'up', [4, 8, 0, 0]);
  assertColumn(column, 'down', [0, 0, 4, 8]);
});

/* ================= 5. 得分 ================= */
group('[5] 得分', () => {
  assertGained([[2, 2, 0, 0]], 'left', 4);
  assertGained([[2, 2, 0, 0], [4, 4, 0, 0]], 'left', 12);
  assertGained([[1024, 1024, 0, 0]], 'left', 2048);
});

/* ================= 6. changed ================= */
group('[6] changed 判定', () => {
  assertChanged([[2, 4, 8, 16]], 'left', false);
  assertChanged([[0, 2, 4, 8]], 'left', true);
  assertChanged([[2, 2, 0, 0]], 'left', true);
});

/* ================= 7. 障碍分段 ================= */
group('[7] 障碍把一行切成多段', () => {
  // 障碍阻隔合并：向左后两个 2 各在各的段里，不能合并
  const blocked = G.boardFromValues([
    [2, -1, 2, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ]);
  const res = G.computeMove(blocked, 'left');
  eq('障碍两侧同值不合并', G.toValues(res.board)[0], [2, -1, 2, 0]);
  eq('障碍两侧同值时 changed = false', res.changed, false);
  eq('障碍两侧同值时 gained = 0', res.gained, 0);
  eq('障碍位置不动', [G.toValues(res.board)[0][1], G.isTile(res.board[0][1])], [-1, false]);

  // 障碍右侧独立压缩：[0, 障碍, 2, 2] 向左 => [0, 障碍, 4, 0]
  assertMove([[0, -1, 2, 2]], 'left', [0, -1, 4, 0]);
  assertMove([[0, -1, 2, 2]], 'right', [0, -1, 0, 4]);

  // 边界一：障碍在行首，段从偏移 1 开始
  assertMove([[-1, 2, 2, 0]], 'left', [-1, 4, 0, 0]);
  assertMove([[-1, 2, 2, 0]], 'right', [-1, 0, 0, 4]);
  assertMove([[-1, 2, 0, 2]], 'left', [-1, 4, 0, 0]);

  // 边界二：障碍在行中，两侧各自压缩、各自合并（障碍不动，段从各自偏移写起）
  assertMove([[2, 2, -1, 2, 2]], 'left', [4, 0, -1, 4, 0]);
  assertMove([[2, 2, -1, 2, 2]], 'right', [0, 4, -1, 0, 4]);

  // 边界三：障碍在行尾
  assertMove([[2, 2, 0, -1]], 'left', [4, 0, 0, -1]);
  assertMove([[2, 2, 0, -1]], 'right', [0, 0, 4, -1]);

  // 整行都是障碍：完全不动
  assertMove([[-1, -1, -1, -1]], 'left', [-1, -1, -1, -1]);
  assertChanged([[-1, -1, -1, -1]], 'up', false);

  // 纵向被障碍切断
  assertColumn([[2, 0, 0, 0], [-1, 0, 0, 0], [2, 0, 0, 0], [2, 0, 0, 0]], 'up', [2, -1, 4, 0]);
  assertColumn([[2, 0, 0, 0], [-1, 0, 0, 0], [2, 0, 0, 0], [2, 0, 0, 0]], 'down', [2, -1, 0, 4]);

  // 障碍自身不参与合并、也不被吞掉
  const mixed = G.boardFromValues([
    [2, 2, -1, 4],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ]);
  const up = G.computeMove(mixed, 'up');
  eq('向上移动后障碍仍在原位', G.obstacles(up.board).map((o) => [o.row, o.col]), [[0, 2]]);
  eq('向上移动后障碍值仍为 -1', G.toValues(up.board)[0][2], -1);
});

/* ================= 8. 落子 ================= */
group('[8] 落子与开局', () => {
  let call = 0;
  const four = G.spawnRandom(G.emptyBoard(4), () => (call++ === 0 ? 0 : 0.95));
  eq('第二个随机数 >= 0.9 时出 4', four.value, 4);

  const board = G.emptyBoard(4);
  const tile = G.spawnRandom(board, () => 0);
  eq('spawnRandom 返回方块且写入 board', board[tile.row][tile.col] === tile, true);

  // 障碍不能落子：唯一的 null 格被落子，其余全是障碍或方块
  const crowded = G.emptyBoard(4);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (r === 3 && c === 3) continue;
      crowded[r][c] = (r + c) % 2 === 0 ? G.createObstacle(r, c) : G.createTile(2, r, c);
    }
  }
  const only = G.spawnRandom(crowded, () => 0);
  eq('唯一空格被落子', [only.row, only.col], [3, 3]);
  eq('落子不覆盖障碍', G.obstacles(crowded).length, 7);

  // 满盘（无 null）时 spawnRandom 返回 null
  const full = G.boardFromValues([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]);
  eq('满盘 spawnRandom 返回 null', G.spawnRandom(full), null);
  const allObstacle = G.boardFromValues([[-1, -1], [-1, -1]]);
  eq('全障碍 spawnRandom 返回 null', G.spawnRandom(allObstacle), null);

  // 开局
  const game = G.newGame({ size: 5, obstacleCount: 2, random: () => 0.5 });
  eq('newGame 棋盘尺寸', G.toValues(game.board).length, 5);
  eq('newGame 开局方块数', game.spawned.length, 2);
  eq('newGame 开局方块都在棋盘上', G.tiles(game.board).length, 2);
  eq('newGame 障碍数', G.obstacles(game.board).length, 2);
  eq('newGame 开局方块都是 2', game.spawned.every((t) => t.value === 2), true);

  const plain = G.newGame({ size: 6, random: () => 0.5 });
  eq('newGame 默认无开局障碍', G.obstacles(plain.board).length, 0);
  eq('newGame 6 尺寸', plain.board.length, 6);

  const insane = G.newGame({ size: 4, obstacleCount: 99, random: () => 0.5 });
  eq('障碍数超出格数时封顶在 16', G.obstacles(insane.board).length, 16);
  eq('塞满障碍后没有方块可落', insane.spawned.length, 0);
});

/* ================= 9. 判负 ================= */
group('[9] hasMoves 判负', () => {
  const dead = G.boardFromValues([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2]
  ]);
  eq('满盘无相邻同值 => 无法移动', G.hasMoves(dead), false);

  const adjacent = G.boardFromValues([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 4]
  ]);
  eq('存在相邻同值 => 还能移动', G.hasMoves(adjacent), true);

  const hole = G.boardFromValues([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 0, 2]
  ]);
  eq('存在空格 => 还能移动', G.hasMoves(hole), true);
  eq('空盘 => 还能移动', G.hasMoves(G.emptyBoard(4)), true);

  // 满盘，被障碍隔开的两块同值不算可动
  const blockedDead = G.boardFromValues([
    [2, -1, 4, 2],
    [8, 4, 2, -1],
    [2, -1, 8, 4],
    [4, 2, 4, -1]
  ]);
  eq('障碍隔开的相邻同值不算可动', G.hasMoves(blockedDead), false);

  const blockedAlive = G.boardFromValues([
    [2, 2, 4, 2],
    [8, 4, 2, -1],
    [2, -1, 8, 4],
    [4, 2, 4, -1]
  ]);
  eq('把障碍换成方块后出现相邻同值', G.hasMoves(blockedAlive), true);

  eq('单格满盘无法移动', G.hasMoves(G.boardFromValues([[2]])), false);
});

/* ================= 10. 目标值与最大值 ================= */
group('[10] 目标值与最大值', () => {
  const five = G.boardFromValues([
    [4096, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0]
  ]);
  eq('5×5 达到 4096', G.hasWon(five, 4096), true);
  eq('5×5 未达到 8192', G.hasWon(five, 8192), false);
  eq('不传 goal 时按尺寸取目标值', G.hasWon(five), true);

  const four = G.boardFromValues([
    [2048, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ]);
  eq('4×4 达到 2048', G.hasWon(four, 2048), true);
  eq('4×4 不传 goal 时按尺寸取 2048', G.hasWon(four), true);

  const low = G.boardFromValues([[1024, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  eq('1024 未达成 2048', G.hasWon(low, 2048), false);

  eq('maxValue 取最大方块', G.maxValue(G.boardFromValues([[2, -1, 64], [0, 0, 8], [0, 0, 0]])), 64);
  eq('maxValue 无方块时为 0', G.maxValue(G.boardFromValues([[-1, 0], [0, 0]])), 0);
});

/* ================= 11. addObstacle ================= */
group('[11] addObstacle', () => {
  const board = G.emptyBoard(4);
  board[1][1] = G.createTile(2, 1, 1);
  const before = G.emptyCells(board).length;

  const obstacle = G.addObstacle(board, () => 0);
  eq('addObstacle 返回障碍', obstacle && obstacle.obstacle === true, true);
  eq('addObstacle 写入 board', board[obstacle.row][obstacle.col] === obstacle, true);
  eq('addObstacle 占用的是空格', G.isTile(board[obstacle.row][obstacle.col]), false);
  eq('addObstacle 后空格少一个', G.emptyCells(board).length, before - 1);
  eq('addObstacle 不覆盖方块', G.tiles(board).length, 1);

  const second = G.addObstacle(board, () => 0);
  eq('两次 addObstacle 不落在同一格',
    second.row !== obstacle.row || second.col !== obstacle.col, true);

  const full = G.boardFromValues([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]);
  eq('满盘 addObstacle 返回 null', G.addObstacle(full, () => 0), null);
  eq('满盘 addObstacle 不改棋盘', G.obstacles(full).length, 0);
});

/* ================= 12. 5×5 四方向 ================= */
group('[12] 5×5 四方向', () => {
  const five = [
    [2, 2, 4, 0, 0],
    [4, 0, 4, 0, 0],
    [0, 0, 0, 0, 0],
    [2, 2, 2, 2, 2],
    [0, 0, 0, 0, 0]
  ];
  const left = assertBoard(five, 'left', [
    [4, 4, 0, 0, 0],
    [8, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [4, 4, 2, 0, 0],
    [0, 0, 0, 0, 0]
  ]);
  eq('5×5 向左得分', left.gained, 20);

  const right = assertBoard(five, 'right', [
    [0, 0, 0, 4, 4],
    [0, 0, 0, 0, 8],
    [0, 0, 0, 0, 0],
    [0, 0, 2, 4, 4],
    [0, 0, 0, 0, 0]
  ]);
  eq('5×5 向右得分', right.gained, 20);

  const up = assertBoard(five, 'up', [
    [2, 4, 8, 2, 2],
    [4, 0, 2, 0, 0],
    [2, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0]
  ]);
  eq('5×5 向上得分', up.gained, 12);

  const down = assertBoard(five, 'down', [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [2, 0, 0, 0, 0],
    [4, 0, 8, 0, 0],
    [2, 4, 2, 2, 2]
  ]);
  eq('5×5 向下得分', down.gained, 12);

  // 5×5 判负
  const fiveDead = G.boardFromValues([
    [2, 4, 2, 4, 2],
    [4, 2, 4, 2, 4],
    [2, 4, 2, 4, 2],
    [4, 2, 4, 2, 4],
    [2, 4, 2, 4, 2]
  ]);
  eq('5×5 满盘无相邻同值 => 无法移动', G.hasMoves(fiveDead), false);
  const fiveAlive = G.boardFromValues([
    [2, 2, 2, 4, 2],
    [4, 2, 4, 2, 4],
    [2, 4, 2, 4, 2],
    [4, 2, 4, 2, 4],
    [2, 4, 2, 4, 2]
  ]);
  eq('5×5 存在相邻同值 => 还能移动', G.hasMoves(fiveAlive), true);
});

/* ================= 13. 6×6 四方向与障碍 ================= */
group('[13] 6×6 四方向与障碍', () => {
  const six = [
    [2, 2, 4, 8, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [4, -1, 4, 0, 0, 2],
    [0, 0, 0, 0, 0, 0],
    [8, 8, 0, 0, 2, 2],
    [2, 4, 8, 16, 32, 64]
  ];

  const left = assertBoard(six, 'left', [
    [4, 4, 8, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [4, -1, 4, 2, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [16, 4, 0, 0, 0, 0],
    [2, 4, 8, 16, 32, 64]
  ]);
  eq('6×6 向左得分', left.gained, 24);

  const right = assertBoard(six, 'right', [
    [0, 0, 0, 4, 4, 8],
    [0, 0, 0, 0, 0, 0],
    [4, -1, 0, 0, 4, 2],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 16, 4],
    [2, 4, 8, 16, 32, 64]
  ]);
  eq('6×6 向右得分', right.gained, 24);

  const sixColumn = [
    [2, 0, 0, 0, 0, 0],
    [2, 0, 0, 0, 0, 0],
    [4, 0, 0, 0, 0, 0],
    [4, 0, 0, 0, 0, 0],
    [8, 0, 0, 0, 0, 0],
    [8, 0, 0, 0, 0, 0]
  ];
  assertColumn(sixColumn, 'up', [4, 8, 16, 0, 0, 0]);
  assertColumn(sixColumn, 'down', [0, 0, 0, 4, 8, 16]);

  // 6×6 判负：满盘、无相邻同值、且同值被障碍隔开
  const sixDead = G.boardFromValues([
    [2, -1, 4, 2, 4, 2],
    [4, 2, 8, -1, 2, 4],
    [8, 4, 2, 4, 8, -1],
    [2, -1, 4, 2, 4, 2],
    [4, 2, 8, -1, 2, 4],
    [8, 4, 2, 4, 8, -1]
  ]);
  eq('6×6 被障碍隔开、无相邻同值 => 无法移动', G.hasMoves(sixDead), false);

  const sixAlive = G.boardFromValues([
    [2, 2, 4, 2, 4, 2],
    [4, 2, 8, -1, 2, 4],
    [8, 4, 2, 4, 8, -1],
    [2, -1, 4, 2, 4, 2],
    [4, 2, 8, -1, 2, 4],
    [8, 4, 2, 4, 8, -1]
  ]);
  eq('6×6 出现相邻同值 => 还能移动', G.hasMoves(sixAlive), true);
});

/* ================= 14. 退化与副作用 ================= */
group('[14] 退化情况与入参保护', () => {
  const single = G.boardFromValues([[2]]);
  const res = G.computeMove(single, 'left');
  eq('1×1 移动无变化', res.changed, false);
  eq('1×1 移动后仍是 2', G.toValues(res.board), [[2]]);

  const source = G.boardFromValues([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ]);
  G.computeMove(source, 'left');
  eq('computeMove 不修改入参数值', G.toValues(source)[0], [2, 2, 0, 0]);

  const obstacleSource = G.boardFromValues([
    [2, -1, 2, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ]);
  G.computeMove(obstacleSource, 'left');
  eq('computeMove 不修改入参里的障碍', G.toValues(obstacleSource)[0], [2, -1, 2, 0]);

  const moved = G.computeMove(G.boardFromValues([
    [2, 2, 4, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ]), 'left');
  eq('slides 覆盖每个参与移动的方块', moved.slides.length, 3);
  eq('merges 记录合成块', moved.merges.length, 1);
  eq('merges 的 value 是合成后的值', moved.merges[0].value, 4);
  eq('merges 的 sources 是两个源块', moved.merges[0].sources.length, 2);
  eq('合成块落在段内偏移 0', [moved.merges[0].row, moved.merges[0].col], [0, 0]);
});

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
