/**
 * 2048 AI 复盘数据层测试（纯 Node，无依赖）
 * 运行：node test/review.test.js
 *
 * 只测纯函数：日志追加、汇总口径、文案规则。
 * 所有局面用数值矩阵描述（0 空格 / -1 障碍 / 其余方块值）。
 */
const Review = require('../js/review.js');

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

/** 4×4 数值矩阵，用于迷你盘面 */
const GRID = [
  [1024, 512, 64, 8],
  [32, 128, 16, 4],
  [8, 32, 2, 0],
  [4, 16, 0, 0]
];

/** 一条走子记录 */
function entry(d, s, t, b) {
  return { d: d, v: GRID, g: 8, b: b, s: s, t: t };
}

/** 造一份已评分的日志（按给定 [d, b, s, t] 序列） */
function logFrom(rows, meta) {
  let log = Review.emptyLog('20261107');
  rows.forEach((row) => {
    log = Review.appendMove(log, entry(row[0], row[2], row[3], row[1]));
  });
  return log;
}

/* ---------- 结构 ---------- */

group('结构', () => {
  eq('LOG_VERSION 为 1', Review.LOG_VERSION, 1);
  eq('MAX_MOVES 为 240', Review.MAX_MOVES, 240);
  ok('emptyLog 是函数', typeof Review.emptyLog === 'function');
  ok('appendMove 是函数', typeof Review.appendMove === 'function');
  ok('normalizeLog 是函数', typeof Review.normalizeLog === 'function');
  ok('pickLog 是函数', typeof Review.pickLog === 'function');
  ok('summarize 是函数', typeof Review.summarize === 'function');
  ok('analyze 是函数', typeof Review.analyze === 'function');
  ok('TILE_COLORS 带经典色板', Review.TILE_COLORS['2'].background === '#eee4da' &&
    Review.TILE_COLORS['2048'].background === '#edc22e');
});

group('colorFor 覆盖空格 / 障碍 / 超大块', () => {
  eq('空格走 empty', Review.colorFor(0), Review.TILE_COLORS.empty);
  eq('障碍走 obstacle', Review.colorFor(-1), Review.TILE_COLORS.obstacle);
  eq('2 用经典色', Review.colorFor(2), Review.TILE_COLORS['2']);
  eq('未知大块退回 big', Review.colorFor(8192), Review.TILE_COLORS.big);
});

/* ---------- emptyLog / appendMove ---------- */

group('emptyLog', () => {
  eq('空日志形状固定', Review.emptyLog('20261107'), {
    version: 1,
    date: '20261107',
    moves: [],
    summary: null
  });
  eq('非法日期折成空串', Review.emptyLog(20261107).date, '');
});

group('appendMove 不修改入参', () => {
  const log = Review.emptyLog('20261107');
  const item = entry('left', 10, 10, null);

  const next = Review.appendMove(log, item);

  eq('原日志仍是空的', log.moves.length, 0);
  eq('入参 entry 未被评分污染', item.b, null);
  eq('新日志多一步', next.moves.length, 1);
  ok('返回的是新对象', next !== log);
  ok('新日志里的 entry 是副本', next.moves[0] !== item);
  ok('values 也做了深拷贝', next.moves[0].v[0] !== item.v[0]);
  eq('字段原样保留', [next.moves[0].d, next.moves[0].g, next.moves[0].s, next.moves[0].t],
    ['left', 8, 10, 10]);

  next.moves[0].v[0][0] = 999;
  eq('改新日志不会回头改入参', item.v[0][0], 1024);
});

group('appendMove 超上限丢最旧', () => {
  let log = Review.emptyLog('20261107');
  for (let i = 0; i < 245; i++) {
    log = Review.appendMove(log, { d: 'left', v: GRID, g: i, b: null, s: null, t: null });
  }

  eq('长度封顶 240', log.moves.length, 240);
  eq('保留的是最新的 240 步（首步 g=5）', log.moves[0].g, 5);
  eq('末步是最新一步', log.moves[239].g, 244);
});

group('appendMove 容错', () => {
  const next = Review.appendMove(null, { d: 'bogus', v: 'x', g: 'y', b: 'up', s: NaN, t: 3 });
  eq('非法方向折成 null', next.moves[0].d, null);
  eq('非法数值折成 0 / null', [next.moves[0].g, next.moves[0].s, next.moves[0].t], [0, null, 3]);
  eq('非法 values 折成空数组', next.moves[0].v, []);
  eq('缺日志时日期为空串', next.date, '');
});

group('pickLog 选日志的优先级', () => {
  const liveLog = Review.appendMove(Review.emptyLog('20261107'), entry('left', 10, 9, 'up'));
  const stored = {
    version: 1,
    date: '20261107',
    moves: liveLog.moves.slice(),
    summary: { grade: 'B' },
    meta: { score: 1234 }
  };

  eq('有步数的 live 优先', Review.pickLog(liveLog, stored), liveLog);
  eq('空 live 不遮蔽已落盘的复盘', Review.pickLog(Review.emptyLog('20261107'), stored), stored);
  eq('两份都空时返回 null（空状态）',
    Review.pickLog(Review.emptyLog('20261107'), Review.emptyLog('20261107')), null);
  eq('live 结构不合法时回落落盘', Review.pickLog({ date: '20261107' }, stored), stored);
  eq('落盘结构不合法时返回 null', Review.pickLog(null, { moves: 'x' }), null);
  ok('落盘没有步数也不展示', Review.pickLog(null, { moves: [] }) === null);
});

group('normalizeLog 洗存档数据', () => {
  const raw = {
    version: 1,
    date: '20250101',
    moves: [
      { d: 'left', v: GRID, g: 4, b: 'up', s: 9, t: 8 },
      null,
      { d: 'wat', v: 'x', g: 'y' }
    ],
    summary: { grade: 'A' }
  };
  const log = Review.normalizeLog(raw, '20261107');

  eq('日期以传入的每日键为准', log.date, '20261107');
  eq('非法条目保留占位（下标不能错位）', log.moves.length, 3);
  eq('不信任存档里的 summary', log.summary, null);
  eq('已评分字段原样保留', [log.moves[0].b, log.moves[0].s, log.moves[0].t], ['up', 9, 8]);
  eq('空条目洗成空壳', [log.moves[1].d, log.moves[1].b, log.moves[1].v], [null, null, []]);
  eq('非法方向折成 null', log.moves[2].d, null);
  ok('values 是深拷贝', log.moves[0].v[0] !== GRID[0]);
  eq('非对象输入给空日志', Review.normalizeLog(null, '20261107').moves, []);

  const many = [];
  for (let i = 0; i < 245; i++) many.push({ d: 'left', v: GRID, g: i, b: null, s: null, t: null });
  const capped = Review.normalizeLog({ moves: many }, '20261107');
  eq('同样按 240 步截断', capped.moves.length, 240);
  eq('保留最新一步', capped.moves[239].g, 244);
});

/* ---------- summarize ---------- */

group('summarize 的一致率 / 平均亏损 / 最差步', () => {
  const rows = [
    ['left', 'left', 10, 10],     // 一致，亏 0
    ['right', 'up', 12, 9],       // 不一致，亏 3
    ['up', 'up', 8, 10],          // 一致，t > s 按 0 计
    ['down', 'left', 15, 12.5],   // 不一致，亏 2.5
    ['up', null, null, null]      // 未评分，整步跳过
  ];
  const summary = Review.summarize(logFrom(rows), { score: 1234, moves: 5, maxTile: 1024, won: false });

  eq('只统计已评分步', summary.scored, 4);
  eq('一致步数', summary.matched, 2);
  eq('一致率 2/4', summary.consistency, 0.5);
  eq('平均亏损 (3+2.5)/4', summary.avgLoss, 1.375);
  eq('评级 C', summary.grade, 'C');
  eq('最差两步按亏损排序', summary.worst.map((w) => [w.index, w.dir, w.bestDir, w.delta]), [
    [2, 'right', 'up', 3],
    [4, 'down', 'left', 2.5]
  ]);
  eq('最差步带走了走子前盘面', summary.worst[0].values, GRID);
  ok('盘面是副本', summary.worst[0].values[0] !== GRID[0]);
});

group('summarize 的 worst 只收正亏损且最多 5 条', () => {
  const rows = [];
  for (let i = 0; i < 7; i++) rows.push(['left', 'up', 20 - i, 20 - i - (7 - i)]);
  rows.push(['left', 'left', 5, 5]);   // 亏 0，不入选

  const summary = Review.summarize(logFrom(rows), { score: 0, moves: rows.length, maxTile: 0, won: false });
  eq('最多 5 条', summary.worst.length, 5);
  eq('亏损从大到小', summary.worst.map((w) => w.delta), [7, 6, 5, 4, 3]);
});

group('summarize 无评分样本不崩', () => {
  const rows = [
    ['left', null, null, null],
    ['right', null, null, null]
  ];
  const summary = Review.summarize(logFrom(rows), { score: 0, moves: 2, maxTile: 0, won: false });

  eq('scored 为 0', summary.scored, 0);
  eq('一致率记 0', summary.consistency, 0);
  eq('平均亏损记 0', summary.avgLoss, 0);
  eq('worst 为空', summary.worst, []);
  eq('评级与 UI 一致记「—」', summary.grade, '—');
});

group('summarize 按本局总步数补回步号', () => {
  // 日志只留了 3 步，但玩家实际走了 10 步：步号应该是 8/9/10
  const rows = [
    ['left', 'up', 10, 8],
    ['right', 'up', 10, 7],
    ['down', 'up', 10, 6]
  ];
  const summary = Review.summarize(logFrom(rows), { score: 0, moves: 10, maxTile: 0, won: false });

  eq('步号带上截断偏移（按亏损降序）', summary.worst.map((w) => w.index), [10, 9, 8]);
});

/* ---------- analyze ---------- */

/** 一套完整的 summary，测试里按需覆盖字段 */
function summaryOf(over) {
  return Object.assign({
    grade: 'D',
    consistency: 0.4,
    avgLoss: 0.42,
    matched: 40,
    scored: 100,
    worst: [
      { index: 87, dir: 'left', bestDir: 'up', delta: 2.3, values: GRID },
      { index: 12, dir: 'right', bestDir: 'left', delta: 1.1, values: GRID }
    ]
  }, over || {});
}

function ctxOf(over) {
  return Object.assign({
    dateLabel: '11月7日',
    score: 3214,
    maxTile: 2048,
    moves: 100,
    history: [],
    streak: 0,
    bestToday: 3214
  }, over || {});
}

group('analyze 组 1：历史为空 + 一致性 0.4', () => {
  const out = Review.analyze(summaryOf(), ctxOf());

  eq('headline 含分数/一致率/平均让出',
    out.headline, '今日 3,214 分 · 与 AI 一致 40% · 平均每步让出 0.42');
  eq('第一次完成每日挑战', out.paragraphs[0], '这是你第一次完成每日挑战。');
  ok('失误分布点出开局', out.paragraphs[1].indexOf('开局') >= 0, out.paragraphs[1]);
  eq('最大单步失误文案', out.paragraphs[2], '第 87 步向左，亏了 2.3 分（AI 建议向上）。');
  eq('固定 3 条建议', out.tips.length, 3);
  ok('一致性低时提示差异比例', out.tips[0].indexOf('60%') >= 0, out.tips[0]);
  ok('失误集中开局时给角上建议',
    out.tips.some((t) => t.indexOf('角上') >= 0), out.tips.join(' / '));
});

group('analyze 组 2：与近 7 日均值比较（高）', () => {
  const out = Review.analyze(
    summaryOf({ consistency: 0.78, avgLoss: 0.5, worst: [{ index: 40, dir: 'down', bestDir: 'up', delta: 1.2, values: GRID }] }),
    ctxOf({ history: [{ date: '20261104', bestScore: 2000 }, { date: '20261105', bestScore: 3000 }, { date: '20261106', bestScore: 0 }] })
  );

  eq('headline 一致率 78%', out.headline, '今日 3,214 分 · 与 AI 一致 78% · 平均每步让出 0.50');
  eq('比均值高 714 分', out.paragraphs[0], '比近 7 日均值高 714 分。');
  ok('单步失误落在中盘', out.paragraphs[1].indexOf('中盘') >= 0, out.paragraphs[1]);
  eq('单步失误文案', out.paragraphs[2], '第 40 步向下，亏了 1.2 分（AI 建议向上）。');
  eq('规则都不触发时补满通用建议', out.tips.length, 3);
});

group('analyze 组 3：比均值低', () => {
  const out = Review.analyze(
    summaryOf({ consistency: 0.9, avgLoss: 0, worst: [] }),
    ctxOf({ score: 1000, history: [{ bestScore: 1500 }, { bestScore: 1500 }] })
  );

  eq('低 500 分', out.paragraphs[0], '比近 7 日均值低 500 分。');
  ok('没有失误时不编造失误分布', out.paragraphs[1].indexOf('没有明显失误') >= 0, out.paragraphs[1]);
  eq('没有让分时的收尾文案', out.paragraphs[2], '每一步都没有让出分数，保持得很好。');
  eq('通用建议补满 3 条', out.tips.length, 3);
});

group('analyze 组 4：最大块偏小 + 连续打卡', () => {
  const out = Review.analyze(
    summaryOf({ consistency: 0.9, avgLoss: 0, worst: [] }),
    ctxOf({ maxTile: 64, streak: 5 })
  );

  ok('最大块建议优先出现', out.tips[0].indexOf('最大块固定在一个角') >= 0, out.tips[0]);
  ok('连续打卡文案带天数', out.tips[1].indexOf('连续打卡 5 天') >= 0, out.tips[1]);
  eq('仍是 3 条', out.tips.length, 3);
});

group('analyze 组 5：平均亏损超过 0.8', () => {
  const out = Review.analyze(
    summaryOf({ consistency: 0.9, avgLoss: 1.234, worst: [] }),
    ctxOf({ avgLoss: 1.234 })
  );

  ok('平均亏损建议带 1.2', out.tips[0].indexOf('每步平均让出 1.2 分') >= 0, out.tips[0]);
  eq('headline 平均让出保留两位', out.headline.indexOf('平均每步让出 1.23') >= 0, true);
});

group('analyze 组 6：无评分样本', () => {
  const out = Review.analyze(
    summaryOf({ consistency: 0, avgLoss: 0, matched: 0, scored: 0, worst: [] }),
    ctxOf({ score: 512, history: [] })
  );

  eq('headline 说明未完成评分', out.headline, '今日 512 分 · 本局未完成评分');
  ok('不输出「100% 与 AI 不同」', out.tips.every((t) => t.indexOf('100%') < 0), out.tips.join(' / '));
  eq('仍是 3 条建议', out.tips.length, 3);
  ok('失误段落说明评分未完成',
    out.paragraphs[1].indexOf('未完成评分') >= 0 && out.paragraphs[2].indexOf('评分补算') >= 0,
    out.paragraphs.join(' / '));
});

group('analyze 同一输入输出稳定', () => {
  const a = Review.analyze(summaryOf(), ctxOf());
  const b = Review.analyze(summaryOf(), ctxOf());
  eq('两次输出完全相同', a, b);

  const missing = Review.analyze(null, null);
  ok('缺参数也不崩', missing.headline.length > 0 && missing.paragraphs.length === 3 &&
    missing.tips.length === 3, str(missing));
});

/* ---------- 汇总 ---------- */

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
