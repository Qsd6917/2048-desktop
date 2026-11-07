/**
 * js/rng.js 单元测试（纯 Node，无依赖）
 * 运行：node test/rng.test.js
 *
 * 覆盖：
 *   1. FNV-1a 的已知值、同输入同输出；
 *   2. mulberry32 的取值范围与 .count；
 *   3. 同种子序列完全一致、不同种子序列不同；
 *   4. skip 与逐次调用等价（存档恢复靠它）；
 *   5. 日期键补零、本地时区、展示文案与合法性边界。
 */
'use strict';

const Rng = require('../js/rng.js');

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

/** 连续取 n 个数 */
function take(rng, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(rng.next());
  return out;
}

/* ---------- 1. 哈希 ---------- */

group('hashString（FNV-1a）', function () {
  eq('空串返回偏移基准', Rng.hashString(''), 2166136261);
  eq('null 按空串处理', Rng.hashString(null), 2166136261);
  eq('undefined 按空串处理', Rng.hashString(undefined), 2166136261);

  // FNV-1a 的公开参考值，钉死算法（换实现时序列会变，测试必须先红）
  eq('"a" 的已知值', Rng.hashString('a'), 0xe40c292c);
  eq('"foobar" 的已知值', Rng.hashString('foobar'), 0xbf9cf968);

  const one = Rng.hashString('2048-daily-20261107');
  const two = Rng.hashString('2048-daily-20261107');
  eq('同输入同输出', one, two);
  ok('结果是 uint32', one >= 0 && one <= 4294967295 && one === (one >>> 0), String(one));
  ok('不同输入不同输出', one !== Rng.hashString('2048-daily-20261108'));
});

/* ---------- 2. mulberry32 ---------- */

group('mulberry32', function () {
  const rand = Rng.mulberry32(123456789);
  ok('函数对象带 count', typeof rand.count === 'number');
  eq('初始 count 为 0', rand.count, 0);

  let inRange = true;
  let isNumber = true;
  const values = [];
  for (let i = 0; i < 1000; i++) {
    const value = rand();
    values.push(value);
    if (typeof value !== 'number' || !isFinite(value)) isNumber = false;
    if (!(value >= 0 && value < 1)) inRange = false;
  }

  ok('返回值都是有限数字', isNumber);
  ok('全部落在 [0,1)', inRange);
  eq('count 跟着调用次数走', rand.count, 1000);
  ok('不是常数序列', values[0] !== values[1] || values[1] !== values[2]);
});

/* ---------- 3. create 的可复现性 ---------- */

group('create（种子随机源）', function () {
  const a = Rng.create('2048-daily-20261107');
  const b = Rng.create('2048-daily-20261107');
  const seriesA = take(a, 20);
  const seriesB = take(b, 20);

  eq('同 key 两次序列完全一致', seriesA, seriesB);
  eq('count 同步到 20', a.count, 20);

  const c = Rng.create('2048-daily-20261108');
  const seriesC = take(c, 5);
  ok('不同 key 前 5 个数不同', str(seriesA.slice(0, 5)) !== str(seriesC));

  // golden：种子的前缀是规格的一部分（'2048-daily-' + 日期键），
  // 这三个数一旦漂移，所有每日开局都会变，必须让测试先红。
  eq('golden：带前缀种子的前 3 个数固定',
    take(Rng.create('2048-daily-20261107'), 3),
    [0.20320546091534197, 0.1592360173817724, 0.7802721995394677]);

  eq('固定种子串可复现', take(Rng.create('2048-daily-20261107'), 3),
    take(Rng.create('2048-daily-20261107'), 3));
});

/* ---------- 4. skip ---------- */

group('skip（存档恢复）', function () {
  const fast = Rng.create('2048-daily-20261107');
  Rng.skip(fast, 10);

  const slow = Rng.create('2048-daily-20261107');
  take(slow, 10);

  eq('对象形式：skip(10) 后下一个值与逐次调用一致', fast.next(), slow.next());
  eq('skip 会推进 count', fast.count, 11);
  eq('skip 后剩余序列仍一致', take(fast, 5), take(slow, 5));

  const bareFast = Rng.mulberry32(42);
  Rng.skip(bareFast, 7);
  const bareSlow = Rng.mulberry32(42);
  for (let i = 0; i < 7; i++) bareSlow();
  eq('函数形式同样等价', bareFast(), bareSlow());

  const noop = Rng.create('x');
  Rng.skip(noop, 0);
  Rng.skip(noop, -3);
  Rng.skip(noop, 'abc');
  eq('0 / 负数 / 非数字都不推进', noop.count, 0);
  eq('skip 不改变序列起点', noop.next(), Rng.create('x').next());

  // 坏存档防线：1e12 / Infinity 若照原样线性空转，页面会在首帧前冻死。
  // 这两条一旦退化成「真的跳」，测试会因为跑不完而超时 —— 本身就是防线。
  const huge = Rng.create('2048-daily-20261107');
  Rng.skip(huge, 1e12);
  eq('1e12 步按 0 处理，不推进 count', huge.count, 0);
  eq('超大值之后序列仍从起点开始', huge.next(), Rng.create('2048-daily-20261107').next());

  const infinite = Rng.create('2048-daily-20261107');
  Rng.skip(infinite, Infinity);
  Rng.skip(infinite, NaN);
  eq('Infinity / NaN 也按 0 处理', infinite.count, 0);
  eq('坏值之后仍能继续取数', typeof infinite.next(), 'number');
  ok('坏值之后取到的仍是有限数', isFinite(infinite.next()));
});

/* ---------- 5. 日期键 ---------- */

group('dateKey / dateLabel / isDateKey', function () {
  eq('本地时区 2026-11-07', Rng.dateKey(new Date(2026, 10, 7)), '20261107');
  eq('月日补零', Rng.dateKey(new Date(2026, 0, 1)), '20260101');
  eq('深夜仍算当天（不能走 UTC）', Rng.dateKey(new Date(2026, 10, 7, 23, 59, 59)), '20261107');
  eq('非法日期返回空串', Rng.dateKey(new Date('x')), '');

  eq('1月1日 不补零', Rng.dateLabel('20260101'), '1月1日');
  eq('11月7日', Rng.dateLabel('20261107'), '11月7日');
  eq('12月31日', Rng.dateLabel('20261231'), '12月31日');
  eq('非法键返回空串', Rng.dateLabel('2026'), '');

  ok('普通日期合法', Rng.isDateKey('20261107') === true);
  ok('下界 20000101 合法', Rng.isDateKey('20000101') === true);
  ok('上界 29991231 合法', Rng.isDateKey('29991231') === true);
  ok('早于下界拒绝', Rng.isDateKey('19991231') === false);
  ok('晚于上界拒绝', Rng.isDateKey('30000101') === false);
  ok('7 位拒绝', Rng.isDateKey('2026110') === false);
  ok('9 位拒绝', Rng.isDateKey('202611070') === false);
  ok('含字母拒绝', Rng.isDateKey('2026110x') === false);
  ok('把数字当日期键拒绝', Rng.isDateKey(20261107) === false);
  ok('空串拒绝', Rng.isDateKey('') === false);
  ok('null 拒绝', Rng.isDateKey(null) === false);
  ok('undefined 拒绝', Rng.isDateKey(undefined) === false);
});

/* ---------- 汇总 ---------- */

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
