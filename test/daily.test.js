/**
 * js/daily.js 单元测试（纯 Node，无依赖）
 * 运行：node test/daily.test.js
 *
 * 覆盖：
 *   1. emptyStore 的形状与「每次都是新对象」；
 *   2. startAttempt / recordResult 的累计口径与不可变性；
 *   3. bestStreak 只增不减（连续、断签、跨月、回填旧日期）；
 *   4. streakOf 的今天未打、缺天断签、跨月/跨年连续；
 *   5. recent 的长度、顺序与今天标记；
 *   6. normalizeStore 逐字段回退、非法日期键丢弃、60 天截断。
 */
'use strict';

const Rng = require('../js/rng.js');
const Daily = require('../js/daily.js');

let pass = 0;
let fail = 0;

function str(value) {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
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

function eq(name, actual, expected) {
  const a = str(actual);
  const e = str(expected);
  ok(name, a === e, '实际 ' + a + '\n        期望 ' + e);
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

/** 把若干天都记成「开过一局」 */
function storeWith(keys) {
  let store = Daily.emptyStore();
  keys.forEach(function (key) {
    store = Daily.startAttempt(store, key, 1000);
  });
  return store;
}

/** 以 2026-01-01 为原点取日期键，方便造 70 天这种批量数据 */
function keyAt(offset) {
  return Rng.dateKey(new Date(2026, 0, 1 + offset));
}

/* ---------- 1. emptyStore ---------- */

group('emptyStore', function () {
  eq('空 store 的形状', Daily.emptyStore(), { version: 1, days: {}, bestStreak: 0 });

  const first = Daily.emptyStore();
  first.days['20261107'] = { attempts: 9 };
  first.bestStreak = 9;
  eq('每次返回新对象（days）', Daily.emptyStore().days, {});
  eq('每次返回新对象（bestStreak）', Daily.emptyStore().bestStreak, 0);
});

/* ---------- 2. startAttempt ---------- */

group('startAttempt', function () {
  const base = Daily.emptyStore();
  const once = Daily.startAttempt(base, '20261107', 1000);
  const twice = Daily.startAttempt(once, '20261107', 2000);

  eq('原对象不被修改', base.days, {});
  eq('第一次 attempts=1', once.days['20261107'].attempts, 1);
  eq('lastAt 写入', once.days['20261107'].lastAt, 1000);
  eq('第二次 attempts=2', twice.days['20261107'].attempts, 2);
  eq('lastAt 更新', twice.days['20261107'].lastAt, 2000);
  eq('未打完时 finishes 仍为 0', twice.days['20261107'].finishes, 0);
  eq('record 的 date 取自键', twice.days['20261107'].date, '20261107');

  const dirty = Daily.startAttempt(base, 'bad-key', 1);
  eq('非法日期键不写脏数据', dirty.days, {});
});

/* ---------- 3. recordResult ---------- */

group('recordResult', function () {
  const started = storeWith(['20261107', '20261107']);
  const before = str(started);

  const first = Daily.recordResult(started, '20261107',
    { score: 100, moves: 20, maxTile: 64, won: false }, 3000);
  const second = Daily.recordResult(first, '20261107',
    { score: 80, moves: 30, maxTile: 128, won: true }, 4000);

  eq('recordResult 不改入参', str(started), before);

  eq('attempts 不受 recordResult 影响', first.days['20261107'].attempts, 2);
  eq('finishes 单独累计（第一次）', first.days['20261107'].finishes, 1);
  eq('finishes 单独累计（第二次）', second.days['20261107'].finishes, 2);

  eq('bestScore 取 max（不被更低的覆盖）', second.days['20261107'].bestScore, 100);
  eq('bestMoves 取 max（步数按「最多」而不是「最少」）', second.days['20261107'].bestMoves, 30);
  eq('bestTile 取 max', second.days['20261107'].bestTile, 128);
  eq('totalMoves 累加', second.days['20261107'].totalMoves, 50);
  eq('won 取或', second.days['20261107'].won, true);
  eq('lastAt 更新到最近一次', second.days['20261107'].lastAt, 4000);
  eq('第一次 won 保持 false', first.days['20261107'].won, false);

  const noAttempt = Daily.recordResult(Daily.emptyStore(), '20261108',
    { score: 7, moves: 3, maxTile: 4, won: false }, 5000);
  eq('没开过也能记结果，attempts 仍为 0', noAttempt.days['20261108'].attempts, 0);
  eq('没有 result 时至少记一次完成', Daily.recordResult(Daily.emptyStore(), '20261109')
    .days['20261109'].finishes, 1);

  // 「继续挑战」后的二次结算：finishes 不重复，数字推进到本局最终值
  let continued = Daily.startAttempt(Daily.emptyStore(), '20261110', 1);
  continued = Daily.recordResult(continued, '20261110',
    { score: 2048, moves: 5, maxTile: 2048, won: true }, 2);
  continued = Daily.recordResult(continued, '20261110',
    { score: 3000, moves: 8, maxTile: 4096, won: true }, 3,
    { finish: false, movesDelta: 3 });

  eq('二次结算 finishes 仍为 1', continued.days['20261110'].finishes, 1);
  eq('二次结算 totalMoves 只补增量', continued.days['20261110'].totalMoves, 8);
  eq('二次结算 bestScore 取最终值', continued.days['20261110'].bestScore, 3000);
  eq('二次结算 bestMoves 取最终值', continued.days['20261110'].bestMoves, 8);
  eq('二次结算 bestTile 取最终值', continued.days['20261110'].bestTile, 4096);
  eq('二次结算 attempts 不动', continued.days['20261110'].attempts, 1);
});

/* ---------- 4. bestStreak ---------- */

group('bestStreak', function () {
  let store = Daily.emptyStore();

  store = Daily.startAttempt(store, '20261106', 1);
  store = Daily.recordResult(store, '20261106',
    { score: 10, moves: 5, maxTile: 8, won: false }, 2);
  eq('第一天打完 bestStreak=1', store.bestStreak, 1);

  store = Daily.startAttempt(store, '20261107', 3);
  store = Daily.recordResult(store, '20261107',
    { score: 20, moves: 6, maxTile: 16, won: false }, 4);
  eq('连续两天打完 bestStreak=2', store.bestStreak, 2);

  // 中间缺一天：当前连续回到 1，但历史最长不能被改小
  store = Daily.startAttempt(store, '20261109', 5);
  store = Daily.recordResult(store, '20261109',
    { score: 30, moves: 7, maxTile: 32, won: false }, 6);
  eq('断签后 bestStreak 仍保持 2', store.bestStreak, 2);

  // 跨月连续：20260131 -> 20260201
  let month = Daily.emptyStore();
  month = Daily.startAttempt(month, '20260131', 1);
  month = Daily.recordResult(month, '20260131',
    { score: 10, moves: 5, maxTile: 8, won: false }, 2);
  month = Daily.startAttempt(month, '20260201', 3);
  month = Daily.recordResult(month, '20260201',
    { score: 20, moves: 6, maxTile: 16, won: false }, 4);
  eq('跨月连续两天 bestStreak=2', month.bestStreak, 2);

  // 回填一个孤立旧日期，不能把已有的最长纪录改小
  const keep = Daily.normalizeStore({ bestStreak: 5, days: {} });
  const backfilled = Daily.recordResult(keep, '20261107',
    { score: 10, moves: 5, maxTile: 8, won: false }, 1);
  eq('回填旧日期不改小历史最长', backfilled.bestStreak, 5);
});

/* ---------- 5. streakOf ---------- */

group('streakOf', function () {
  eq('今天打了、往前连续三天', Daily.streakOf(
    storeWith(['20261105', '20261106', '20261107']), '20261107'), { current: 3, atRisk: false });

  eq('今天没打、昨天打了：连续不清零且提示风险', Daily.streakOf(
    storeWith(['20261106']), '20261107'), { current: 1, atRisk: true });

  eq('今天打了、昨天缺：只算今天', Daily.streakOf(
    storeWith(['20261107', '20261105']), '20261107'), { current: 1, atRisk: false });

  eq('缺天断签', Daily.streakOf(
    storeWith(['20261104', '20261106']), '20261107'), { current: 1, atRisk: true });

  eq('今天和昨天都没打', Daily.streakOf(
    storeWith(['20261104']), '20261107'), { current: 0, atRisk: false });

  eq('一场都没打', Daily.streakOf(Daily.emptyStore(), '20261107'), { current: 0, atRisk: false });

  eq('跨月连续（20260131 -> 20260201）', Daily.streakOf(
    storeWith(['20260131', '20260201']), '20260201'), { current: 2, atRisk: false });

  eq('跨年连续（20251231 -> 20260101）', Daily.streakOf(
    storeWith(['20251231', '20260101']), '20260101'), { current: 2, atRisk: false });

  eq('非法 todayKey 不炸', Daily.streakOf(storeWith(['20261106']), 'x'), { current: 0, atRisk: false });
});

/* ---------- 6. recent ---------- */

group('recent', function () {
  let store = storeWith(['20260131', '20260201']);
  store = Daily.recordResult(store, '20260131',
    { score: 500, moves: 40, maxTile: 256, won: true }, 1000);

  const items = Daily.recent(store, '20260201', 3);
  eq('长度恒为 n', items.length, 3);
  eq('旧 -> 新，跨月日期正确', items.map(function (item) { return item.date; }),
    ['20260130', '20260131', '20260201']);
  eq('没打过的日子 played=false', items.map(function (item) { return item.played; }),
    [false, true, true]);
  eq('bestScore 带上', items.map(function (item) { return item.bestScore; }),
    [0, 500, 0]);
  eq('won 带上', items.map(function (item) { return item.won; }),
    [false, true, false]);
  eq('只有末位是今天', items.map(function (item) { return item.isToday; }),
    [false, false, true]);

  eq('n=0 返回空数组', Daily.recent(store, '20260201', 0), []);
  eq('n 超过数据量也补满', Daily.recent(store, '20260201', 5).length, 5);
  eq('n 非法按 0 处理', Daily.recent(store, '20260201', 'x'), []);
});

/* ---------- 7. bestOf ---------- */

group('bestOf', function () {
  let store = storeWith(['20261107']);
  store = Daily.recordResult(store, '20261107',
    { score: 1234, moves: 210, maxTile: 256, won: false }, 1000);

  const record = Daily.bestOf(store, '20261107');
  eq('取到当天记录', record.bestScore, 1234);
  eq('返回副本（改它不影响 store）', (function () {
    record.bestScore = 9999;
    return Daily.bestOf(store, '20261107').bestScore;
  })(), 1234);

  eq('没打过的日子为 null', Daily.bestOf(store, '20261108'), null);
  eq('非法键为 null', Daily.bestOf(store, 'bad'), null);
});

/* ---------- 8. normalizeStore ---------- */

group('normalizeStore', function () {
  eq('null 得到空 store', Daily.normalizeStore(null),
    { version: 1, days: {}, bestStreak: 0 });

  const dirty = {
    version: 99,
    bestStreak: '4',
    days: {
      '20261107': {
        date: '19990101',
        attempts: '3',
        finishes: -2,
        bestScore: 'abc',
        bestMoves: 2.9,
        bestTile: null,
        won: 'yes',
        totalMoves: 1500,
        lastAt: -5
      },
      '2026110': { attempts: 9 },
      abcdefgh: { attempts: 9 },
      '20261108': 'not-an-object'
    }
  };

  const store = Daily.normalizeStore(dirty);
  eq('版本固定为 1', store.version, 1);
  eq('bestStreak 洗成整数', store.bestStreak, 4);
  eq('只保留合法日期键', Object.keys(store.days), ['20261107']);
  eq('记录逐字段回退', store.days['20261107'], {
    date: '20261107',
    attempts: 3,
    finishes: 0,
    bestScore: 0,
    bestMoves: 2,
    bestTile: 0,
    won: false,
    totalMoves: 1500,
    lastAt: 0
  });

  eq('days 不是对象时退回空表', Daily.normalizeStore({ days: 'x' }).days, {});

  // 70 天：只留最近 60 天
  const days = {};
  for (let i = 0; i < 70; i++) {
    days[keyAt(i)] = { attempts: i + 1 };
  }
  const trimmed = Daily.normalizeStore({ days: days });
  const kept = Object.keys(trimmed.days);

  eq('超过 60 天时截断', kept.length, 60);
  eq('丢掉最早的一天', trimmed.days[keyAt(0)], undefined);
  eq('保留第 11 天（原第 10 位）', trimmed.days[keyAt(10)].attempts, 11);
  eq('保留最后一天', trimmed.days[keyAt(69)].attempts, 70);

  // 已经满 60 天时再开一局：新增今天，仍不能超过上限
  const next = Daily.startAttempt(trimmed, keyAt(70), 1000);
  eq('新增一天后仍为 60 天', Object.keys(next.days).length, 60);
  eq('新增的那天在', next.days[keyAt(70)].attempts, 1);
  eq('最旧的那天被挤掉', next.days[keyAt(10)], undefined);
});

/* ---------- 汇总 ---------- */

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
