/**
 * 2048 成就档案测试（纯 Node，无依赖）
 * 运行：node test/achievements.test.js
 *
 * 只测纯数据层：定义表、进度、解锁、档案整理与增量合并。
 * 时间戳一律由测试注入，模块内不读系统时钟，所以结果可固定断言。
 */
const A = require('../js/achievements.js');

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

function group(name, fn) {
  console.log('\n' + name);
  try {
    fn();
  } catch (err) {
    fail++;
    console.log('  FAIL  分组执行异常: ' + (err && err.message ? err.message : err));
  }
}

/** 规定的 25 条：id / metric / target / tier，顺序即界面顺序 */
const EXPECTED = [
  ['first_game', 'games', 1, 'bronze'],
  ['score_1k', 'bestScore', 1000, 'bronze'],
  ['score_5k', 'bestScore', 5000, 'silver'],
  ['score_20k', 'bestScore', 20000, 'gold'],
  ['tile_128', 'bestTile', 128, 'bronze'],
  ['tile_256', 'bestTile', 256, 'bronze'],
  ['tile_512', 'bestTile', 512, 'silver'],
  ['tile_1024', 'bestTile', 1024, 'silver'],
  ['tile_2048', 'bestTile', 2048, 'gold'],
  ['tile_4096', 'bestTile', 4096, 'gold'],
  ['games_10', 'games', 10, 'bronze'],
  ['games_50', 'games', 50, 'silver'],
  ['games_100', 'games', 100, 'gold'],
  ['moves_1k', 'totalMoves', 1000, 'bronze'],
  ['moves_5k', 'totalMoves', 5000, 'silver'],
  ['merge_4', 'maxMergesInMove', 4, 'silver'],
  ['combo_3', 'maxCombo', 3, 'bronze'],
  ['combo_5', 'maxCombo', 5, 'silver'],
  ['daily_1', 'dailyPlays', 1, 'bronze'],
  ['daily_7', 'dailyStreak', 7, 'silver'],
  ['daily_30', 'dailyStreak', 30, 'gold'],
  ['daily_win', 'dailyWins', 1, 'silver'],
  ['perfect_10', 'perfectMoves', 10, 'silver'],
  ['size_6', 'sizes.6', 1, 'bronze'],
  ['obstacle_win', 'modeWins.obstacle', 1, 'silver']
];

const ZERO_STATS = {
  games: 0,
  totalMoves: 0,
  bestScore: 0,
  bestTile: 0,
  wins: 0,
  merges: 0,
  maxCombo: 0,
  maxMergesInMove: 0,
  dailyPlays: 0,
  dailyStreak: 0,
  dailyWins: 0,
  perfectMoves: 0,
  undoWins: 0,
  sizes: {},
  modeWins: {}
};

/** 只给 stats 造一份档案，unlocked 为空 */
function profileWith(stats) {
  return A.addStats(A.emptyProfile(), stats);
}

/* ---------- 定义表 ---------- */

group('定义表', () => {
  eq('VERSION 为 1', A.VERSION, 1);
  eq('档位文案', A.TIERS, { bronze: '铜', silver: '银', gold: '金' });
  eq('成就条数 25', A.DEFINITIONS.length, 25);
  ok('条数 >= 24', A.DEFINITIONS.length >= 24);

  const ids = A.DEFINITIONS.map((def) => def.id);
  eq('id 唯一', new Set(ids).size, ids.length);

  let fieldsOk = true;
  let missing = '';
  A.DEFINITIONS.forEach((def) => {
    ['id', 'name', 'desc', 'tier', 'metric', 'target'].forEach((key) => {
      if (def[key] === undefined || def[key] === null || def[key] === '') {
        fieldsOk = false;
        missing += def.id + '.' + key + ' ';
      }
    });
    if (typeof def.target !== 'number' || def.target <= 0) fieldsOk = false;
    if (!Object.prototype.hasOwnProperty.call(A.TIERS, def.tier)) fieldsOk = false;
  });
  ok('每条字段齐全且合法', fieldsOk, missing);

  eq('id / metric / target / tier 与规定表逐条一致',
    A.DEFINITIONS.map((def) => [def.id, def.metric, def.target, def.tier]),
    EXPECTED);
});

/* ---------- 空档案 ---------- */

group('emptyProfile', () => {
  const profile = A.emptyProfile();
  eq('形状', profile, { version: 1, stats: ZERO_STATS, unlocked: {} });
  ok('每次返回新对象', profile !== A.emptyProfile());
  ok('stats 不共享', profile.stats !== A.emptyProfile().stats);
  eq('emptyStats 与档案里的 stats 一致', A.emptyStats(), ZERO_STATS);
});

/* ---------- normalizeProfile ---------- */

group('normalizeProfile', () => {
  eq('非对象退回空档案', A.normalizeProfile(null), A.emptyProfile());
  eq('字符串退回空档案', A.normalizeProfile('oops'), A.emptyProfile());

  const dirty = {
    version: 99,
    stats: {
      games: '7',
      totalMoves: -3,
      bestScore: NaN,
      bestTile: 4096.9,
      maxCombo: Infinity,
      sizes: { '4': 1, '6': 2, '9': 0 },
      modeWins: { obstacle: 3, classic: 0 }
    },
    unlocked: {
      first_game: 1700000000000,
      score_1k: 0,
      score_5k: -5,
      tile_128: 1.5,
      tile_256: '1700000000000',
      tile_512: NaN,
      tile_1024: null,
      unknown_id: 1700000000000
    }
  };

  const profile = A.normalizeProfile(dirty);
  eq('version 固定为 1', profile.version, 1);
  eq('数值字段逐字段回退', {
    games: profile.stats.games,
    totalMoves: profile.stats.totalMoves,
    bestScore: profile.stats.bestScore,
    bestTile: profile.stats.bestTile,
    maxCombo: profile.stats.maxCombo,
    maxMergesInMove: profile.stats.maxMergesInMove
  }, { games: 7, totalMoves: 0, bestScore: 0, bestTile: 4096, maxCombo: 0, maxMergesInMove: 0 });
  eq('sizes 丢掉非正数项', profile.stats.sizes, { '4': 1, '6': 2 });
  eq('modeWins 丢掉非正数项', profile.stats.modeWins, { obstacle: 3 });
  eq('unlocked 只留合法 id 与正整数时间戳', profile.unlocked, { first_game: 1700000000000 });
  ok('入参未被修改', dirty.stats.games === '7' && dirty.unlocked.score_1k === 0);

  const again = A.normalizeProfile(profile);
  eq('幂等', again, profile);
});

/* ---------- addStats ---------- */

group('addStats', () => {
  const base = profileWith({ games: 3, totalMoves: 100, bestScore: 800 });
  const before = JSON.parse(JSON.stringify(base));

  const next = A.addStats(base, {
    games: 1,
    totalMoves: 5,
    merges: 2,
    dailyPlays: 1,
    dailyWins: 1,
    perfectMoves: 4,
    wins: 1,
    undoWins: 1,
    bestScore: 500,       // 比现有小：不覆盖
    bestTile: 256,
    maxCombo: 3,
    maxMergesInMove: 4,
    dailyStreak: 7,
    sizes: { '4': 1, '6': 1 },
    modeWins: { obstacle: 1 }
  });

  eq('相加字段累加', {
    games: next.stats.games,
    totalMoves: next.stats.totalMoves,
    merges: next.stats.merges,
    dailyPlays: next.stats.dailyPlays,
    dailyWins: next.stats.dailyWins,
    perfectMoves: next.stats.perfectMoves,
    wins: next.stats.wins,
    undoWins: next.stats.undoWins
  }, {
    games: 4,
    totalMoves: 105,
    merges: 2,
    dailyPlays: 1,
    dailyWins: 1,
    perfectMoves: 4,
    wins: 1,
    undoWins: 1
  });

  eq('取大字段取较大值', {
    bestScore: next.stats.bestScore,
    bestTile: next.stats.bestTile,
    maxCombo: next.stats.maxCombo,
    maxMergesInMove: next.stats.maxMergesInMove,
    dailyStreak: next.stats.dailyStreak
  }, {
    bestScore: 800,
    bestTile: 256,
    maxCombo: 3,
    maxMergesInMove: 4,
    dailyStreak: 7
  });

  eq('sizes 并入', next.stats.sizes, { '4': 1, '6': 1 });
  eq('modeWins 并入', next.stats.modeWins, { obstacle: 1 });

  const second = A.addStats(next, { sizes: { '6': 1, '4': 1 }, modeWins: { obstacle: 2 } });
  eq('sizes 是存在性标记（同尺寸不叠加）', second.stats.sizes, { '4': 1, '6': 1 });
  eq('modeWins 是计数（按次累加）', second.stats.modeWins, { obstacle: 3 });

  eq('不改原对象', base, before);
  eq('未知字段被忽略', A.addStats(base, { mystery: 9 }), base);
  eq('空 patch 等价于整理一遍', A.addStats(base, null), base);
});

/* ---------- progressOf ---------- */

group('progressOf', () => {
  const firstGame = A.findById('first_game');
  const zero = A.progressOf(firstGame, A.emptyStats());
  eq('没进度', zero, { current: 0, target: 1, ratio: 0, done: false });

  const perfect = A.findById('perfect_10');
  eq('9/10 不解锁', A.progressOf(perfect, A.emptyStats()), {
    current: 0, target: 10, ratio: 0, done: false
  });
  eq('9/10 的 ratio', A.progressOf(perfect, { perfectMoves: 9 }).ratio, 0.9);
  eq('10/10 达成', A.progressOf(perfect, { perfectMoves: 10 }), {
    current: 10, target: 10, ratio: 1, done: true
  });
  eq('超额时 ratio 钳制在 1', A.progressOf(perfect, { perfectMoves: 42 }), {
    current: 42, target: 10, ratio: 1, done: true
  });

  const size6 = A.findById('size_6');
  eq('sizes.6 路径：缺键为 0', A.progressOf(size6, A.emptyStats()), {
    current: 0, target: 1, ratio: 0, done: false
  });
  eq('sizes.6 路径：键为 6 时命中', A.progressOf(size6, { sizes: { '6': 1 } }).done, true);
  eq('sizes.6 路径：别的尺寸不算', A.progressOf(size6, { sizes: { '4': 1 } }).done, false);

  const obstacleWin = A.findById('obstacle_win');
  eq('modeWins.obstacle 命中', A.progressOf(obstacleWin, { modeWins: { obstacle: 1 } }).done, true);
  eq('modeWins.classic 不算障碍', A.progressOf(obstacleWin, { modeWins: { classic: 1 } }).done, false);
});

/* ---------- evaluate ---------- */

group('evaluate', () => {
  const now = 1700000000000;
  const stats = { games: 1, bestScore: 2048, bestTile: 2048, totalMoves: 10 };
  const first = A.evaluate(profileWith(stats), now);

  eq('首次解锁按 DEFINITIONS 顺序返回全部达标项', first.unlockedNow, [
    'first_game',
    'score_1k',
    'tile_128',
    'tile_256',
    'tile_512',
    'tile_1024',
    'tile_2048'
  ]);
  eq('时间戳由参数注入',
    first.unlockedNow.map((id) => first.profile.unlocked[id]),
    first.unlockedNow.map(() => now));
  eq('已解锁条数', A.countUnlocked(first.profile), 7);
  eq('未达标的保持未解锁', first.profile.unlocked.games_10, undefined);

  const second = A.evaluate(first.profile, now + 1000);
  eq('第二次调用不再返回', second.unlockedNow, []);
  eq('第二次调用不改时间戳', second.profile.unlocked.first_game, now);

  const noNow = A.evaluate(profileWith({ games: 1 }), undefined);
  eq('未注入时间戳时退回 1（不读系统时钟）', noNow.profile.unlocked.first_game, 1);

  const badNow = A.evaluate(profileWith({ games: 1 }), -5);
  eq('非法时间戳同样退回 1', badNow.profile.unlocked.first_game, 1);

  // perfect_10 的边界：9 步不解锁，凑到 10 步才解锁
  const nine = A.evaluate(profileWith({ perfectMoves: 9 }), now);
  eq('9 步没有 perfect_10', nine.unlockedNow.indexOf('perfect_10'), -1);

  const ten = A.evaluate(A.addStats(nine.profile, { perfectMoves: 1 }), now);
  eq('10 步解锁 perfect_10', ten.unlockedNow, ['perfect_10']);
  eq('解锁时间戳', ten.profile.unlocked.perfect_10, now);

  // 一次只补一条：9 -> 10 之前已经解锁的不会被重新触发
  const combo = A.evaluate(profileWith({ maxCombo: 3 }), now);
  eq('combo_3 在 3 连击解锁', combo.unlockedNow, ['combo_3']);
  eq('combo_5 需要 5 连击', A.evaluate(profileWith({ maxCombo: 4 }), now).unlockedNow,
    ['combo_3']);
  eq('combo_5 在 5 连击解锁',
    A.evaluate(profileWith({ maxCombo: 5 }), now).unlockedNow, ['combo_3', 'combo_5']);

  // 映射字段的解锁
  eq('sizes.6 解锁', A.evaluate(profileWith({ sizes: { '6': 1 } }), now).unlockedNow, ['size_6']);
  eq('modeWins.obstacle 解锁',
    A.evaluate(profileWith({ modeWins: { obstacle: 1 } }), now).unlockedNow, ['obstacle_win']);
});

/* ---------- 查询小工具 ---------- */

group('查询', () => {
  eq('findById 命中', A.findById('tile_2048').name, '二〇四八');
  eq('findById 未知 id 为 null', A.findById('nope'), null);
  eq('countUnlocked 空档案为 0', A.countUnlocked(A.emptyProfile()), 0);
  eq('countUnlocked 脏入参不崩', A.countUnlocked(null), 0);
});

console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail === 0 ? 0 : 1;
