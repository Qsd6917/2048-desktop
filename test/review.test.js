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
  // 4096+ 用 styles.css 的 --tile-bg，比经典色板更深的炭色
  eq('超大块色与棋盘一致', Review.TILE_COLORS.big.background, '#3f3b33');
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
    dropped: 0,
    summary: null
  });
  eq('非法日期折成空串', Review.emptyLog(20261107).date, '');
  eq('新日志没有丢弃任何步', Review.emptyLog('20261107').dropped, 0);
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

group('appendMove 截断不静默：dropped 计数', () => {
  const MAX = Review.MAX_MOVES;
  let log = Review.emptyLog('20261107');

  // 恰好到上限：一步都没丢
  for (let i = 0; i < MAX; i++) {
    log = Review.appendMove(log, { d: 'left', v: GRID, g: i, b: null, s: null, t: null });
  }
  eq('刚好 240 步时 dropped 仍为 0', log.dropped, 0);
  eq('刚好 240 步时长度不截断', log.moves.length, MAX);

  // 再灌 37 步：溢出多少就记多少
  for (let i = MAX; i < MAX + 37; i++) {
    log = Review.appendMove(log, { d: 'left', v: GRID, g: i, b: null, s: null, t: null });
  }
  eq('dropped 记下被丢掉的 37 步', log.dropped, 37);
  eq('长度仍封顶在 MAX_MOVES', log.moves.length, MAX);
  eq('第一步是被保留窗口的第一条（g=37）', log.moves[0].g, 37);
  eq('最后一步仍在日志里', log.moves[log.moves.length - 1].g, MAX + 36);
  eq('dropped + 长度 = 本局总步数', log.dropped + log.moves.length, MAX + 37);

  // 一次性灌 500 步（每次 append 都只溢出 1 步，逐次累加）
  let big = Review.emptyLog('20261107');
  for (let i = 0; i < 500; i++) {
    big = Review.appendMove(big, { d: 'up', v: GRID, g: i, b: null, s: null, t: null });
  }
  eq('长局 dropped 累计到 260', big.dropped, 500 - MAX);
  eq('长局长度仍是 240', big.moves.length, MAX);
  eq('长局末步是最新一步', big.moves[MAX - 1].g, 499);
});

group('appendMove 累加已有的 dropped（读回存档后继续追加）', () => {
  // 模拟从存档读回的日志：已经丢了 12 步，只剩 3 步
  const stored = {
    version: 1,
    date: '20261107',
    moves: [
      { d: 'left', v: GRID, g: 1, b: null, s: null, t: null },
      { d: 'left', v: GRID, g: 2, b: null, s: null, t: null },
      { d: 'left', v: GRID, g: 3, b: null, s: null, t: null }
    ],
    dropped: 12,
    summary: null
  };

  const next = Review.appendMove(stored, { d: 'right', v: GRID, g: 4, b: null, s: null, t: null });
  eq('dropped 原样带过（没溢出时不涨）', next.dropped, 12);
  eq('步数正常 +1', next.moves.length, 4);
  eq('入参 dropped 未被改写', stored.dropped, 12);

  // 老日志没有 dropped 字段：按 0 处理
  const legacy = { version: 1, date: '20261107', moves: stored.moves.slice(), summary: null };
  const after = Review.appendMove(legacy, { d: 'right', v: GRID, g: 4, b: null, s: null, t: null });
  eq('老日志缺 dropped 时按 0 起算', after.dropped, 0);
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
  eq('读档时自己截断的 5 步也记进 dropped', capped.dropped, 5);
});

group('normalizeLog 读回 dropped', () => {
  const moves = [];
  for (let i = 0; i < 10; i++) moves.push({ d: 'left', v: GRID, g: i, b: null, s: null, t: null });

  const kept = Review.normalizeLog({ version: 1, date: '20261107', moves: moves, dropped: 42 }, '20261107');
  eq('带 dropped 的日志保住该值', kept.dropped, 42);
  eq('步数没到上限时不额外截断', kept.moves.length, 10);

  const legacy = Review.normalizeLog({ version: 1, date: '20261107', moves: moves }, '20261107');
  eq('老日志没有该字段时读回 0', legacy.dropped, 0);

  eq('非法 dropped（字符串 / 负数 / NaN）一律折成 0',
    [Review.normalizeLog({ moves: moves, dropped: 'x' }, '20261107').dropped,
      Review.normalizeLog({ moves: moves, dropped: -3 }, '20261107').dropped,
      Review.normalizeLog({ moves: moves, dropped: NaN }, '20261107').dropped], [0, 0, 0]);
  eq('非对象输入 dropped 为 0', Review.normalizeLog(null, '20261107').dropped, 0);

  // 存档本身已截断（dropped=260）又被洗一遍：不能把 dropped 丢掉或翻倍
  const already = [];
  for (let i = 0; i < 240; i++) already.push({ d: 'left', v: GRID, g: i, b: null, s: null, t: null });
  const roundTrip = Review.normalizeLog({ moves: already, dropped: 260 }, '20261107');
  eq('已在上限内的日志 dropped 原样保留', roundTrip.dropped, 260);
  eq('长度仍是 240', roundTrip.moves.length, 240);

  // normalizeLog 幂等：洗两遍结果一致
  eq('洗两遍结果一致', Review.normalizeLog(roundTrip, '20261107'), roundTrip);
});

group('summarize 用 dropped 补回真实步号', () => {
  // 日志只留了 3 步，dropped 说前面丢了 7 步 —— meta.moves 缺失时也应按 dropped 补号
  const rows = [
    ['left', 'up', 10, 8],
    ['right', 'up', 10, 7],
    ['down', 'up', 10, 6]
  ];
  const log = logFrom(rows);
  log.dropped = 7;

  const withMeta = Review.summarize(log, { score: 0, moves: 10, maxTile: 0, won: false });
  eq('meta.moves 与 dropped 一致时步号不变', withMeta.worst.map((w) => w.index), [10, 9, 8]);

  const noMeta = Review.summarize(log, null);
  eq('meta.moves 缺失时退回用 dropped 补号', noMeta.worst.map((w) => w.index), [10, 9, 8]);
});

/* ---------- staleKeys / isUsableSummary ---------- */

group('staleKeys 只列出该清理的复盘键', () => {
  const keys = Review.staleKeys('20261107', 14, 120);

  eq('长度 = maxAge - keepDays', keys.length, 106);
  ok('不含今天（正在玩 / 刚结算的那份必须留着）', keys.indexOf('review.20261107') < 0);
  ok('保留期内（14 天）一个都不删',
    keys.indexOf('review.20261106') < 0 && keys.indexOf('review.20261024') < 0);
  ok('保留期外第一天开始删', keys.indexOf('review.20261023') >= 0);
  ok('含 maxAge 当天', keys.indexOf('review.20260710') >= 0);
  ok('比 maxAge 更早的不在列表里（如 20260709 / 19980101）',
    keys.indexOf('review.20260709') < 0 && keys.indexOf('review.19980101') < 0);
  ok('每个 key 都以 review. 开头且日期是 8 位数字',
    keys.every((k) => k.indexOf('review.') === 0 && /^\d{8}$/.test(k.slice(7))),
    keys[0] + ' … ' + keys[keys.length - 1]);
  ok('没有重复键', new Set(keys).size === keys.length);

  // 跨年窗口：20260210 往前 120 天落在上一年，20251231 / 20260101 都在清理范围内
  const crossYear = Review.staleKeys('20260210', 14, 120);
  ok('跨年窗口能同时列出 20251231 与 20260101',
    crossYear.indexOf('review.20251231') >= 0 && crossYear.indexOf('review.20260101') >= 0);
  ok('跨年窗口同样不含当天的键', crossYear.indexOf('review.20260210') < 0);

  eq('不传 keepDays/maxAge 时用默认 14 / 120', Review.staleKeys('20261107'), keys);
  eq('非法日期键返回空数组', Review.staleKeys('2026-11-07', 14, 120), []);
  eq('maxAge 不大于 keepDays 时没有要删的', Review.staleKeys('20261107', 120, 120), []);
});

group('isUsableSummary 只认字段齐全的落盘 summary', () => {
  const good = Review.summarize(
    logFrom([['left', 'left', 10, 10], ['right', 'up', 12, 9]]),
    { score: 30, moves: 2, maxTile: 8, won: false }
  );

  ok('summarize 的产物一定可用', Review.isUsableSummary(good) === true);
  ok('空对象不可用', Review.isUsableSummary({}) === false);
  ok('worst 不是数组不可用', Review.isUsableSummary({ worst: 'x' }) === false);
  ok('worst 里混进空对象不可用',
    Review.isUsableSummary({ worst: [{}], avgLoss: 1, consistency: 0.5, scored: 2 }) === false);
  ok('worst 条目缺 delta 不可用',
    Review.isUsableSummary({ worst: [{ index: 3 }], avgLoss: 1, consistency: 0.5, scored: 2 }) === false);
  ok('worst 条目 delta 是字符串不可用',
    Review.isUsableSummary({ worst: [{ index: 3, delta: '2' }], avgLoss: 1, consistency: 0.5, scored: 2 }) === false);
  ok('worst 条目齐全则可用',
    Review.isUsableSummary({ worst: [{ index: 3, delta: 2 }], avgLoss: 1, consistency: 0.5, scored: 2 }) === true);
  ok('指标是字符串不可用',
    Review.isUsableSummary({ worst: [], avgLoss: '1.2', consistency: 0, scored: 0 }) === false);
  ok('缺 scored 不可用',
    Review.isUsableSummary({ worst: [], avgLoss: 1, consistency: 0.5 }) === false);
  ok('缺 consistency 不可用',
    Review.isUsableSummary({ worst: [], avgLoss: 1, scored: 2 }) === false);
  ok('null / 字符串 / 数组都不可用',
    Review.isUsableSummary(null) === false && Review.isUsableSummary('{}') === false &&
      Review.isUsableSummary([]) === false);
});

group('落盘 summary 被写成 {} 时退回日志重算', () => {
  const log = logFrom([['left', 'left', 10, 10], ['right', 'up', 12, 9]]);
  const meta = { score: 30, moves: 2, maxTile: 8, won: false };
  // 模拟 review.<today> 落盘成 { summary: {} }（手改 / 写截断）
  const stored = { version: 1, date: '20261107', moves: log.moves, summary: {}, meta: meta };

  ok('落盘的 {} 判为不可用', Review.isUsableSummary(stored.summary) === false);

  const summary = Review.isUsableSummary(stored.summary)
    ? stored.summary
    : Review.summarize(stored, meta);

  eq('重算出的 summary 字段齐全',
    [summary.scored, summary.matched, typeof summary.avgLoss, Array.isArray(summary.worst)],
    [2, 1, 'number', true]);

  const out = Review.analyze(summary, {
    dateLabel: '11月7日', score: 30, maxTile: 8, moves: 2, history: [], streak: 0, bestToday: 30
  });
  ok('文案能正常生成（下游 toFixed / length 不会抛）',
    out.headline.indexOf('30 分') >= 0 && out.paragraphs.length === 3 && out.tips.length === 3,
    out.headline);
});

group('评分补算回流后 summary 与半成品不同', () => {
  // 24 步待评分；结算瞬间的 60ms 预算只够算 2 步（模拟 flushEvalQueue）
  const rows = [];
  for (let i = 0; i < 24; i++) rows.push(['left', null, null, null]);
  const log = logFrom(rows);
  const meta = { score: 160, moves: 24, maxTile: 1024, won: false };

  log.moves[0] = { d: 'left', v: GRID, g: 8, b: 'left', s: 10, t: 10 };
  log.moves[1] = { d: 'left', v: GRID, g: 8, b: 'up', s: 12, t: 9 };
  const partial = Review.summarize(log, meta);

  // 模拟空闲回调把队列排空：剩下的步全部补上评分
  for (let i = 2; i < log.moves.length; i++) {
    log.moves[i] = { d: 'left', v: GRID, g: 8, b: 'left', s: 10, t: 10 };
  }
  const full = Review.summarize(log, meta);

  eq('结算瞬间只统计算完的 2 步', partial.scored, 2);
  eq('排空后统计全部 24 步', full.scored, 24);
  ok('两次 summary 不同（回流确实会改变落盘内容）', str(partial) !== str(full));
  ok('半成品的平均亏损被 2 步样本放大',
    partial.avgLoss > full.avgLoss, partial.avgLoss + ' vs ' + full.avgLoss);
  eq('同一日志重算幂等', Review.summarize(log, meta), full);
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
