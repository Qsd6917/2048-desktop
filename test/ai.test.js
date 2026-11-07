/**
 * 2048 AI 走子建议测试（纯 Node，无依赖）
 * 运行：node test/ai.test.js
 *
 * 棋盘用数值矩阵描述：0 = 空格，-1 = 障碍，其余 = 方块值。
 * 时间相关断言一律给足宽松上限，只用来抓「卡死」和「预算完全失控」，
 * 不追求精确的毫秒级约束。
 */
const G = require('../js/logic.js');
const AI = require('../js/ai.js');

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

function ok(name, condition, detail) {
  if (condition) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail === undefined ? '' : '\n        ' + detail));
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

/** 数值矩阵 -> 真实棋盘（方块 / 障碍对象） */
function board(rows) {
  return G.boardFromValues(rows);
}

const DIRS = ['up', 'right', 'down', 'left'];

/* ---------- 局面生成 ---------- */

/** 固定种子伪随机，保证测试可复现 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TILE_POOL = [2, 4, 8, 16, 32, 64];

/**
 * 随机局面：按 fillRate 落子，最后强制留出至少 2 个空格，
 * 这样 hasMoves 一定为 true，省掉「生成死局再重来」的循环。
 */
function randomBoard(rand, size, fillRate) {
  const rows = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) {
      row.push(rand() < fillRate ? TILE_POOL[Math.floor(rand() * TILE_POOL.length)] : 0);
    }
    rows.push(row);
  }

  const cells = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (rows[r][c] === 0) cells.push([r, c]);
    }
  }
  while (cells.length < 2) {
    const r = Math.floor(rand() * size);
    const c = Math.floor(rand() * size);
    if (rows[r][c] !== 0) {
      rows[r][c] = 0;
      cells.push([r, c]);
    }
  }
  return rows;
}

/** 在棋盘副本上验证某个方向是否真的能改变棋盘（避免污染原局面） */
function moveChanges(rows, dir) {
  return G.computeMove(board(rows), dir).changed === true;
}

/**
 * 深快照：记录每个格子的种类与所有可观察字段。
 * 用来检查 suggest 有没有把真实棋盘的方块坐标搜乱。
 */
function snapshot(bd) {
  return bd.map((row) =>
    row.map((cell) => {
      if (cell === null) return 'null';
      if (cell.obstacle === true) return 'obstacle:' + cell.row + ',' + cell.col;
      return 'tile:' + cell.id + ':' + cell.value + '@' + cell.row + ',' + cell.col;
    })
  );
}

/** 中盘局面：4×4，够复杂但没满 */
const MID_4 = [
  [1024, 512, 64, 8],
  [32, 128, 16, 4],
  [8, 32, 2, 0],
  [4, 16, 0, 0]
];

/* ---------- 结构 ---------- */

group('结构', () => {
  eq('DIRECTIONS 为 up/right/down/left', AI.DIRECTIONS, DIRS);
  ok('evaluate 是函数', typeof AI.evaluate === 'function');
  ok('suggest 是函数', typeof AI.suggest === 'function');
});

/* ---------- evaluate ---------- */

group('evaluate 返回有限数', () => {
  const cases = [
    ['4×4 空盘', G.emptyBoard(4)],
    ['5×5 空盘', G.emptyBoard(5)],
    ['6×6 空盘', G.emptyBoard(6)],
    ['4×4 中盘', board(MID_4)],
    ['4×4 满盘', board([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]])],
    ['4×4 含障碍', board([[2, -1, 4, 0], [-1, 8, 0, 0], [0, 0, 16, 0], [0, 0, 0, 0]])],
    ['6×6 含障碍', board([[-1, 2, 0, 0, 4, 0], [0, 0, -1, 0, 0, 8], [0, 16, 0, 0, 0, 0], [0, 0, 0, 32, 0, 0], [0, 0, 0, 0, 64, 0], [0, 0, 0, 0, 0, 128]])],
    ['只有一个方块', board([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])],
    ['全障碍', board([[-1, -1], [-1, -1]])]
  ];
  for (const [name, bd] of cases) {
    let value;
    let error = null;
    try {
      value = AI.evaluate(bd);
    } catch (err) {
      error = err;
    }
    ok(
      name + ' -> 有限数',
      error === null && typeof value === 'number' && Number.isFinite(value),
      error ? '抛异常: ' + error.message : '实际 ' + str(value)
    );
  }
});

group('evaluate 的排序符合直觉', () => {
  // 两组方块的多重集完全相同，只是排布不同
  const tidy = [
    [1024, 512, 256, 128],
    [64, 32, 16, 8],
    [4, 2, 0, 0],
    [4, 2, 0, 0]
  ];
  const messy = [
    [8, 16, 2, 128],
    [512, 4, 256, 64],
    [2, 1024, 32, 4],
    [0, 0, 0, 0]
  ];
  const multiset = (rows) =>
    rows
      .reduce((acc, row) => acc.concat(row), [])
      .filter((v) => v !== 0)
      .sort((a, b) => a - b);

  eq('两组多重集相同（测试前提）', multiset(tidy), multiset(messy));
  const tidyScore = AI.evaluate(board(tidy));
  const messyScore = AI.evaluate(board(messy));
  ok(
    '整齐局面评分高于散乱局面',
    tidyScore > messyScore,
    '整齐 ' + tidyScore.toFixed(3) + ' / 散乱 ' + messyScore.toFixed(3)
  );
});

/* ---------- suggest 行为 ---------- */

group('suggest 抓得住眼前的合并', () => {
  const rows = [[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const result = AI.suggest(board(rows));
  ok('返回非 null', result !== null && typeof result === 'object');
  ok('方向属于 left/right', result !== null && (result.dir === 'left' || result.dir === 'right'), '实际 ' + str(result));
  ok('score 有限', result !== null && Number.isFinite(result.score), '实际 ' + str(result && result.score));
});

group('死局返回 null', () => {
  const dead = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
  eq('hasMoves 为 false（测试前提）', G.hasMoves(board(dead)), false);
  eq('suggest 返回 null', AI.suggest(board(dead)), null);
  eq('空棋盘无合法移动，返回 null', AI.suggest(G.emptyBoard(4)), null);
});

group('返回结构完整', () => {
  const result = AI.suggest(board(MID_4));
  ok('非 null', result !== null);
  ok('dir 是合法方向', result !== null && DIRS.indexOf(result.dir) !== -1, '实际 ' + str(result && result.dir));
  ok('score 有限', result !== null && Number.isFinite(result.score), '实际 ' + str(result && result.score));
  ok('depth 是 >= 1 的整数', result !== null && Number.isInteger(result.depth) && result.depth >= 1, '实际 ' + str(result && result.depth));
});

group('不污染真实棋盘', () => {
  const bd = board(MID_4);
  const before = snapshot(bd);
  AI.suggest(bd);
  AI.suggest(bd, { timeBudgetMs: 30 });
  eq('Suggest 前后棋盘快照完全一致', snapshot(bd), before);
  eq('数值矩阵未变', G.toValues(bd), MID_4);
});

group('合法性：随机 50 个局面', () => {
  const rand = mulberry32(20261107);
  let checked = 0;
  let bad = 0;
  let wrongDir = 0;

  for (let i = 0; i < 50; i++) {
    // 前 25 个是 4×4，后 25 个混入 5×5 与 6×6
    const size = i < 25 ? 4 : i % 2 === 0 ? 5 : 6;
    const rows = randomBoard(rand, size, 0.55);
    const bd = board(rows);
    const result = AI.suggest(bd);

    if (G.hasMoves(bd)) checked++;
    else bad++;

    if (result === null) {
      wrongDir++;
      continue;
    }
    if (!moveChanges(rows, result.dir)) {
      wrongDir++;
      console.log('        非法方向 ' + result.dir + ' 局面 ' + str(rows));
    }
  }

  eq('50 个随机局面都有合法移动（测试前提）', checked, 50);
  eq('没有死局被误判', bad, 0);
  eq('suggest 给出的方向全部能改变棋盘', wrongDir, 0);
});

group('搜索碰到走死的分支也不会污染分数', () => {
  // 只剩一个空格，随便走一步再落子就可能直接死掉；
  // 这类分支的分数必须是有限数（曾经会算出 -Infinity）。
  const nearlyFull = [
    [2, 4, 8, 16],
    [32, 64, 128, 256],
    [2, 4, 8, 16],
    [32, 64, 128, 0]
  ];
  const singleHole = [
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 0, 2]
  ];

  for (const [name, rows] of [['只剩一格空位', nearlyFull], ['只有一个洞的满盘', singleHole]]) {
    const result = AI.suggest(board(rows));
    ok(
      name + ' -> 返回有限分的合法方向',
      result !== null && DIRS.indexOf(result.dir) !== -1 && Number.isFinite(result.score),
      '实际 ' + str(result)
    );
  }
});

/* ---------- 性能与预算 ---------- */

group('性能', () => {
  // 4×4 中盘连续 20 次
  const bd4 = board(MID_4);
  const start4 = Date.now();
  let maxSingle = 0;
  for (let i = 0; i < 20; i++) {
    const t = Date.now();
    const result = AI.suggest(bd4);
    const cost = Date.now() - t;
    if (cost > maxSingle) maxSingle = cost;
    if (!result) {
      fail++;
      console.log('  FAIL  第 ' + (i + 1) + ' 次 suggest 返回空');
    }
  }
  const total4 = Date.now() - start4;
  console.log('        4×4：20 次合计 ' + total4 + 'ms，单次最慢 ' + maxSingle + 'ms');
  ok('4×4 20 次总耗时 < 4000ms', total4 < 4000, '实际 ' + total4 + 'ms');
  ok('4×4 单次最慢 < 400ms', maxSingle < 400, '实际 ' + maxSingle + 'ms');

  // 5×5 一次
  const bd5 = board([
    [0, 0, 2, 4, 0],
    [0, 8, 16, 0, 0],
    [2, 0, 32, 0, 4],
    [0, 4, 0, 64, 0],
    [0, 0, 2, 0, 8]
  ]);
  const start5 = Date.now();
  const result5 = AI.suggest(bd5);
  const cost5 = Date.now() - start5;
  console.log('        5×5：单次 ' + cost5 + 'ms');
  ok('5×5 单次 < 500ms', cost5 < 500, '实际 ' + cost5 + 'ms');
  ok('5×5 返回合法方向', result5 !== null && DIRS.indexOf(result5.dir) !== -1, '实际 ' + str(result5));

  // 6×6 一次（含障碍）
  const rows6 = [
    [2, 0, 4, 0, 0, 8],
    [0, -1, 0, 16, 0, 0],
    [0, 0, 32, 0, 0, 2],
    [4, 0, 0, -1, 64, 0],
    [0, 8, 0, 0, 0, 0],
    [0, 0, 2, 0, 128, 0]
  ];
  const start6 = Date.now();
  const result6 = AI.suggest(board(rows6));
  const cost6 = Date.now() - start6;
  console.log('        6×6：单次 ' + cost6 + 'ms');
  ok('6×6 单次 < 800ms', cost6 < 800, '实际 ' + cost6 + 'ms');
  ok('6×6 返回合法方向', result6 !== null && DIRS.indexOf(result6.dir) !== -1, '实际 ' + str(result6));
  ok('6×6 方向真的能改变棋盘', result6 !== null && moveChanges(rows6, result6.dir));
});

group('时间预算真的能生效', () => {
  const bd = board(MID_4);

  const startTiny = Date.now();
  const tiny = AI.suggest(bd, { timeBudgetMs: 1 });
  const costTiny = Date.now() - startTiny;
  console.log('        预算 1ms：实际 ' + costTiny + 'ms');
  ok('极小预算仍返回合法方向', tiny !== null && DIRS.indexOf(tiny.dir) !== -1, '实际 ' + str(tiny));
  ok('极小预算不卡死（< 300ms）', costTiny < 300, '实际 ' + costTiny + 'ms');

  const startBig = Date.now();
  const big = AI.suggest(bd, { timeBudgetMs: 200 });
  const costBig = Date.now() - startBig;
  console.log('        预算 200ms：实际 ' + costBig + 'ms');
  ok('宽容预算下正常返回', big !== null && DIRS.indexOf(big.dir) !== -1, '实际 ' + str(big));
  ok('不超过预算太多（< 500ms）', costBig < 500, '实际 ' + costBig + 'ms');
  ok('预算越充足搜索越深或持平', big.depth >= tiny.depth, '200ms 深度 ' + big.depth + ' / 1ms 深度 ' + tiny.depth);

  /*
   * 上面那条「越充足越深」在「完全忽略预算」的实现上也会通过（深度恒定）。
   * 预算 0 必须连第一层都开不了，直接回退到静态评估的 depth 0 —— 这条才真正防回归。
   */
  const zero = AI.suggest(bd, { timeBudgetMs: 0 });
  ok('预算 0 时退回静态评估（depth === 0）', zero !== null && zero.depth === 0,
    '实际 ' + str(zero && zero.depth));
  ok('预算 0 仍返回能推动棋盘的合法方向',
    zero !== null && DIRS.indexOf(zero.dir) !== -1 && moveChanges(MID_4, zero.dir),
    '实际 ' + str(zero));
});

group('三种尺寸都能跑', () => {
  for (const size of G.SIZES) {
    const rows = G.toValues(G.newGame({ size, obstacleCount: 1, random: mulberry32(size * 7) }).board);
    const result = AI.suggest(G.boardFromValues(rows));
    ok(
      size + '×' + size + ' 返回合法方向',
      result !== null && DIRS.indexOf(result.dir) !== -1,
      '实际 ' + str(result)
    );
  }
});

/* ---------- 汇总 ---------- */

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
