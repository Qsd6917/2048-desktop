/**
 * 2048 核心逻辑测试（纯 Node，无依赖）
 * 运行：node test/logic.test.js
 */
const G = require('../js/logic.js');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + '\n        got      ' + a + '\n        expected ' + e);
  }
}

function move(values, dir) {
  const res = G.computeMove(G.boardFromValues(values), dir);
  return { values: G.toValues(res.board), gained: res.gained, changed: res.changed };
}

function row(values, dir) {
  return move([values, [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], dir);
}

console.log('\n[1] 一次移动内不许二次合并');
check('2 2 4 0 向左 => 4 4 0 0', row([2, 2, 4, 0], 'left').values[0], [4, 4, 0, 0]);
check('2 2 2 2 向左 => 4 4 0 0', row([2, 2, 2, 2], 'left').values[0], [4, 4, 0, 0]);
check('4 4 4 0 向左 => 8 4 0 0', row([4, 4, 4, 0], 'left').values[0], [8, 4, 0, 0]);
check('2 2 2 0 向右 => 0 0 2 4', row([2, 2, 2, 0], 'right').values[0], [0, 0, 2, 4]);

console.log('\n[2] 空格压缩与远程合并');
check('2 0 0 2 向左 => 4 0 0 0', row([2, 0, 0, 2], 'left').values[0], [4, 0, 0, 0]);
check('2 0 4 0 向左 => 2 4 0 0', row([2, 0, 4, 0], 'left').values[0], [2, 4, 0, 0]);
check('0 2 0 4 向右 => 0 0 2 4', row([0, 2, 0, 4], 'right').values[0], [0, 0, 2, 4]);

console.log('\n[3] 纵向');
const column = [
  [2, 0, 0, 0],
  [2, 0, 0, 0],
  [4, 0, 0, 0],
  [4, 0, 0, 0]
];
check('列 [2,2,4,4] 向上 => [4,8,0,0]', move(column, 'up').values.map((r) => r[0]), [4, 8, 0, 0]);
check('列 [2,2,4,4] 向下 => [0,0,4,8]', move(column, 'down').values.map((r) => r[0]), [0, 0, 4, 8]);

console.log('\n[4] 得分与 changed 标记');
const stuck = row([2, 4, 8, 16], 'left');
check('无位移时 changed = false', stuck.changed, false);
check('无位移时 gained = 0', stuck.gained, 0);
check('2 2 向左得分 = 4', row([2, 2, 0, 0], 'left').gained, 4);
check('两行分别为 2 2 / 4 4 得分 = 12',
  move([[2, 2, 0, 0], [4, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 'left').gained, 12);
check('1024 1024 得分 = 2048', row([1024, 1024, 0, 0], 'left').gained, 2048);

console.log('\n[5] 结束判定');
const dead = G.boardFromValues([
  [2, 4, 2, 4],
  [4, 2, 4, 2],
  [2, 4, 2, 4],
  [4, 2, 4, 2]
]);
check('满盘无相邻同值 => 无法移动', G.hasMoves(dead), false);
const adjacent = G.boardFromValues([
  [2, 4, 2, 4],
  [4, 2, 4, 2],
  [2, 4, 2, 4],
  [4, 2, 4, 4]
]);
check('存在相邻同值 => 还能移动', G.hasMoves(adjacent), true);
const hole = G.boardFromValues([
  [2, 4, 2, 4],
  [4, 2, 4, 2],
  [2, 4, 2, 4],
  [4, 2, 0, 2]
]);
check('存在空格 => 还能移动', G.hasMoves(hole), true);
check('1024 未达成 2048', G.hasWon(G.boardFromValues([[1024, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])), false);
check('2048 已达成', G.hasWon(G.boardFromValues([[2048, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])), true);

console.log('\n[6] 落子');
const seeded = G.newGame(4, () => 0.5);
check('开局有 2 个方块', G.tiles(seeded.board).length, 2);
check('开局方块都是 2', G.tiles(seeded.board).every((t) => t.value === 2), true);

let call = 0;
const four = G.spawnRandom(G.emptyBoard(4), () => (call++ === 0 ? 0 : 0.95));
check('第二个随机数 >= 0.9 时出 4', four.value, 4);

console.log('\n[7] 不修改入参棋盘的数值');
const source = G.boardFromValues([
  [2, 2, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0]
]);
G.computeMove(source, 'left');
check('原棋盘数值不变', G.toValues(source)[0], [2, 2, 0, 0]);

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
