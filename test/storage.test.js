/**
 * js/storage.js 单元测试（纯 Node，无依赖）
 * 运行：node test/storage.test.js
 *
 * 为什么单独测：storage.js 是 IIFE + `window` 宿主，整份逻辑跑在浏览器里，
 * 但它的核心承诺（写不进去时不能骗人）在浏览器里极难复现——配额满、隐私模式
 * 收紧都是环境态。这里用假的 localStorage 把「探测能写、正式写失败」精确造出来。
 *
 * 覆盖：
 *   1. localStorage 整体不可用（连读属性都抛）→ 全部走内存，不冒异常；
 *   2. 探测通过、正式写入抛 QuotaExceededError → 降级到内存并重写，
 *      不抛异常、返回值不撒谎、刚写的值立刻读得回来；
 *   3. 降级前的历史统计不能在界面上凭空消失；
 *   4. 旧存档 / 坏 JSON / 负数 / 非数字 → loadStats 补默认值，绝不抛。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'storage.js'), 'utf8');

let pass = 0;
let fail = 0;

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
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, '实际 ' + a + '\n        期望 ' + e);
}

/**
 * 可控的假 localStorage。
 *
 * @param {{limitWrites?: number, throwOnAccess?: boolean}} options
 *        limitWrites：前 N 次 setItem 成功，之后抛 QuotaExceededError
 *        （探测正好用掉 1 次写入，所以 limitWrites=1 就是「探测通过、正式写失败」）
 */
function fakeLocalStorage(options) {
  const opts = options || {};
  const data = Object.create(null);
  let writes = 0;

  const ls = {
    data: data,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      writes++;
      if (typeof opts.limitWrites === 'number' && writes > opts.limitWrites) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
    /** 测试中途收紧配额（模拟玩到一半写满） */
    limitAfter(n) {
      opts.limitWrites = n;
    },
    writes() {
      return writes;
    }
  };

  if (opts.throwOnAccess) {
    // 隐私模式下连访问方法属性本身都抛异常
    ['getItem', 'setItem', 'removeItem'].forEach(function (name) {
      Object.defineProperty(ls, name, {
        get() {
          throw new Error('SecurityError');
        }
      });
    });
  }

  return ls;
}

/** 在沙箱里加载 storage.js，返回挂在假 window 上的 API */
function loadStorage(localStorage) {
  const win = { localStorage: localStorage };
  const sandbox = { window: win };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'js/storage.js' });
  if (!win.Game2048Storage) throw new Error('storage.js 没有挂载 Game2048Storage');
  return win.Game2048Storage;
}

/* ---------- 1. localStorage 整体不可用 ---------- */

console.log('\nlocalStorage 不可用时的内存降级');

{
  const S = loadStorage(fakeLocalStorage({ throwOnAccess: true }));
  let threw = false;
  try {
    S.set(S.KEYS.state, { a: 1 });
  } catch (e) {
    threw = true;
  }
  ok('set 不抛异常', threw === false);
  eq('刚写的值能读回来', S.get(S.KEYS.state, null), { a: 1 });
  eq('没写过的键返回 fallback', S.get('nope', 'fb'), 'fb');
}

/* ---------- 2. 探测通过、正式写入失败 ---------- */

console.log('\n探测通过但写入抛 QuotaExceededError');

{
  const ls = fakeLocalStorage({ limitWrites: 1 });   // 只允许探测那一次写
  const S = loadStorage(ls);

  let threw = false;
  let result = null;
  try {
    result = S.set(S.KEYS.state, { board: [1, 2, 3], score: 42 });
  } catch (e) {
    threw = true;
  }

  ok('set 不抛异常', threw === false);
  ok('set 返回 true（内存降级算写成功）', result === true, '实际 ' + result);
  eq('降级后 get 立刻读得到刚写的值', S.get(S.KEYS.state, null), { board: [1, 2, 3], score: 42 });

  // 关键对比：真实 localStorage 里确实没有（写失败了），
  // 但接口层面必须自洽 —— 否则界面显示「已保存」而刷新后全丢。
  ok('真实存储里确实没有这份数据（前提成立）',
    ls.getItem('game2048.v2.state') === null, String(ls.getItem('game2048.v2.state')));
}

/* ---------- 3. 降级不丢历史统计 ---------- */

console.log('\n降级时把旧数据搬进内存');

{
  const ls = fakeLocalStorage();
  const S = loadStorage(ls);

  S.saveStats({ games: 3, bestScore: 4096, bestTile: 512, totalMoves: 120, bySize: { 4: { games: 3, bestScore: 4096 } } });
  eq('统计先正常落盘', S.loadStats().games, 3);

  ls.limitAfter(ls.writes());   // 从下一次写入开始配额满

  ok('后续写入降级成功', S.set(S.KEYS.state, { score: 7 }) === true);
  eq('降级后历史统计还在', S.loadStats().games, 3);
  eq('降级后新写的数据也在', S.get(S.KEYS.state, null), { score: 7 });
  eq('saveStats 也能在降级后写成功', S.saveStats({ games: 4 }), true);
  eq('降级后统计读得到最新值', S.loadStats().games, 4);
}

/* ---------- 4. 坏存档一律补默认值 ---------- */

console.log('\n旧存档与坏数据');

{
  const ls = fakeLocalStorage();
  ls.data['game2048.v2.stats'] = JSON.stringify({ games: '3', bestScore: -5 });
  const S = loadStorage(ls);

  const stats = S.loadStats();
  eq('缺字段补 0', stats, { games: 3, bestScore: 0, bestTile: 0, totalMoves: 0, bySize: {} });
}

{
  const ls = fakeLocalStorage();
  ls.data['game2048.v2.stats'] = '{ 这不是 JSON';
  const S = loadStorage(ls);
  eq('坏 JSON 退回默认统计', S.loadStats(), { games: 0, bestScore: 0, bestTile: 0, totalMoves: 0, bySize: {} });
}

{
  const ls = fakeLocalStorage();
  ls.data['game2048.v2.stats'] = JSON.stringify({
    games: 2.9,
    bestScore: 'abc',
    bestTile: null,
    totalMoves: Infinity,
    bySize: { 5: { games: '1', bestScore: -3 }, bad: 'x' }
  });
  const S = loadStorage(ls);
  eq('非数字/负数/小数都被折成非负整数', S.loadStats(), {
    games: 2,
    bestScore: 0,
    bestTile: 0,
    totalMoves: 0,
    bySize: { 5: { games: 1, bestScore: 0 } }
  });
}

/* ---------- 5. 序列化失败 ---------- */

console.log('\n无法序列化的值');

{
  const S = loadStorage(fakeLocalStorage());
  const cyclic = {};
  cyclic.self = cyclic;
  eq('循环引用返回 false 而不是抛异常', S.set('state', cyclic), false);
  eq('写失败后读回 fallback', S.get('state', 'none'), 'none');
  eq('undefined 也不写入', S.set('state', undefined), false);
}

/* ---------- 汇总 ---------- */

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
