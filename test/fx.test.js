/**
 * 2048 全屏粒子纯函数测试（纯 Node，无依赖）
 * 运行：node test/fx.test.js
 *
 * 只测数据层：粒子数、取值范围、配色、随机可注入（确定性）。
 * DOM 部分（create）需要 canvas，不在 Node 里测。
 */
const Fx = require('../js/fx.js');

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

/** 线性同余，只要同种子同序列即可；不是为了随机质量 */
function seeded(seed) {
  let state = seed >>> 0;
  return function () {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function allFinite(particles, fields) {
  for (const p of particles) {
    for (const field of fields) {
      if (typeof p[field] !== 'number' || !isFinite(p[field])) return false;
    }
  }
  return true;
}

const PHYSICS = ['x', 'y', 'vx', 'vy', 'gravity', 'life', 'age', 'size', 'rot', 'spin'];

group('palette：与样式表配色一致', function () {
  eq('2', Fx.palette(2).main, '#eee4da');
  eq('4', Fx.palette(4).main, '#ede0c8');
  eq('8', Fx.palette(8).main, '#f2b179');
  eq('16', Fx.palette(16).main, '#f59563');
  eq('32', Fx.palette(32).main, '#f67c5f');
  eq('64', Fx.palette(64).main, '#f65e3b');
  eq('128', Fx.palette(128).main, '#edcf72');
  eq('256', Fx.palette(256).main, '#edcc61');
  eq('512', Fx.palette(512).main, '#edc850');
  eq('1024', Fx.palette(1024).main, '#edc53f');
  eq('2048', Fx.palette(2048).main, '#edc22e');
  eq('超范围回到深炭色', Fx.palette(4096).main, '#3f3b33');
  eq('无值也回到深炭色', Fx.palette(NaN).main, '#3f3b33');

  ok('alt 是合法的十六进制', /^#[0-9a-f]{6}$/.test(Fx.palette(2048).alt), Fx.palette(2048).alt);
  ok('alt 与 main 不同（有层次）', Fx.palette(2048).alt !== Fx.palette(2048).main);
});

group('planBurst：粒子数', function () {
  const cases = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
  let previous = 0;
  let monotonic = true;

  for (const value of cases) {
    const list = Fx.planBurst({ value: value, combo: 0, x: 10, y: 20, random: seeded(7) });
    ok('值 ' + value + ' 粒子数在 8..46', list.length >= 8 && list.length <= 46, '实际 ' + list.length);
    if (list.length < previous) monotonic = false;
    previous = list.length;
  }
  ok('粒子数随 value 单调不减', monotonic);

  const low = Fx.planBurst({ value: 2, combo: 0, x: 0, y: 0, random: seeded(3) }).length;
  const high = Fx.planBurst({ value: 2048, combo: 0, x: 0, y: 0, random: seeded(3) }).length;
  ok('2048 的粒子比 2 多', high > low, low + ' vs ' + high);

  const c0 = Fx.planBurst({ value: 64, combo: 0, x: 0, y: 0, random: seeded(5) }).length;
  const c5 = Fx.planBurst({ value: 64, combo: 5, x: 0, y: 0, random: seeded(5) }).length;
  ok('连击增加粒子', c5 > c0, c0 + ' vs ' + c5);

  const clamped = Fx.planBurst({ value: 1e9, combo: 9, x: 0, y: 0, random: seeded(9) });
  eq('上限钳在 46', clamped.length, 46);

  const tiny = Fx.planBurst({ value: 2, combo: 0, x: 0, y: 0, random: seeded(9) });
  ok('下限不小于 8', tiny.length >= 8);
});

group('planBurst：物理量', function () {
  const list = Fx.planBurst({ value: 512, combo: 3, x: 100, y: 200, random: seeded(11) });

  ok('所有物理量都是有限数', allFinite(list, PHYSICS));

  let speedOk = true;
  let lifeOk = true;
  let sizeOk = true;
  let originOk = true;
  let gravityOk = true;

  for (const p of list) {
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (speed < 59.9 || speed > 220.1) speedOk = false;
    if (p.life < 0.55 || p.life > 1.05) lifeOk = false;
    if (p.size < 3 || p.size > 7) sizeOk = false;
    if (p.x !== 100 || p.y !== 200) originOk = false;
    if (p.gravity !== 420) gravityOk = false;
  }

  ok('初速落在 60..220', speedOk);
  ok('寿命落在 0.55..1.05', lifeOk);
  ok('尺寸落在 3..7', sizeOk);
  ok('从合并格出发', originOk);
  ok('重力 420', gravityOk);

  const squares = list.filter(function (p) { return p.shape === 'square'; }).length;
  const dots = list.filter(function (p) { return p.shape === 'dot'; }).length;
  ok('只有 square / dot 两种形状', squares + dots === list.length);
  ok('方块与圆点各占一半', Math.abs(squares - dots) <= 1, squares + ' vs ' + dots);

  const colors = new Set(list.map(function (p) { return p.color; }));
  ok('颜色来自 palette', colors.has(Fx.palette(512).main), Array.from(colors).join(','));
});

group('planBurst：确定性', function () {
  const input = { value: 32, combo: 2, x: 5, y: 6 };
  const a = Fx.planBurst(Object.assign({ random: seeded(42) }, input));
  const b = Fx.planBurst(Object.assign({ random: seeded(42) }, input));
  eq('同一随机序列结果完全一致', a, b);

  const c = Fx.planBurst(Object.assign({ random: seeded(43) }, input));
  ok('换随机序列结果不同', str(a) !== str(c));

  const fallback = Fx.planBurst({ value: 2, x: 0, y: 0 });
  ok('默认 Math.random 也能产出有限粒子', allFinite(fallback, PHYSICS));
  eq('元素个数不为 0', fallback.length > 0, true);
});

group('planConfetti', function () {
  const width = 1280;
  const height = 720;
  const list = Fx.planConfetti({ width: width, height: height, count: 120, random: seeded(21) });

  eq('数量按参数来', list.length, 120);
  ok('所有物理量有限', allFinite(list, PHYSICS));
  ok('x 落在 0..width', list.every(function (p) { return p.x >= 0 && p.x <= width; }));
  ok('从顶部开始', list.every(function (p) { return p.y < 0; }));

  let lifeOk = true;
  for (const p of list) {
    if (p.life < 2.2 || p.life > 3.4) lifeOk = false;
  }
  ok('寿命落在 2.2..3.4', lifeOk);

  const again = Fx.planConfetti({ width: width, height: height, count: 120, random: seeded(21) });
  eq('同种子结果一致', list, again);

  const fallback = Fx.planConfetti({ width: width, height: height });
  eq('默认 120 片', fallback.length, 120);

  const zero = Fx.planConfetti({ width: 0, height: 0, count: 4, random: seeded(1) });
  ok('零尺寸下 x 仍有限且为 0', zero.every(function (p) { return p.x === 0; }));
});

group('planDust', function () {
  const list = Fx.planDust({ width: 800, height: 600, count: 40, random: seeded(31) });

  eq('数量按参数来', list.length, 40);
  ok('所有物理量有限', allFinite(list, PHYSICS));
  ok('x 落在 0..width', list.every(function (p) { return p.x >= 0 && p.x <= 800; }));
  ok('初速很低（低于 burst）', list.every(function (p) { return Math.abs(p.vx) <= 8 && p.vy <= 60; }));
  ok('寿命长于 2 秒', list.every(function (p) { return p.life >= 2.4; }));
  ok('全是圆点', list.every(function (p) { return p.shape === 'dot'; }));
  ok('统一灰色', new Set(list.map(function (p) { return p.color; })).size === 1);
});

group('create：无画布时退化为空操作', function () {
  const empty = Fx.create({});
  empty.burst([{ x: 0, y: 0, vx: 1, vy: 1, gravity: 1, life: 1, age: 0, size: 3, shape: 'dot', color: '#000', rot: 0, spin: 0 }]);
  empty.burst([{ x: 0, y: 0 }]);
  empty.confetti(120);
  empty.dust(40);
  empty.ring(10, 10, 256);
  empty.sweep();
  empty.shake(0.8);
  empty.resize();
  eq('burst/confetti/ring 一个都不攒', empty.stats().particles, 0);
  eq('环与扫光也不攒', empty.stats().rings + empty.stats().sweeps, 0);
  eq('running 恒为 false', empty.stats().running, false);
  empty.stop();
  eq('stop 可重复调用', empty.stats().particles, 0);

  // 有 canvas 但没有 2D 上下文（极老环境/被禁用）：同样整体退化
  const noCtx = Fx.create({
    canvas: { getContext: function () { return null; }, ownerDocument: { defaultView: {} } }
  });
  noCtx.burst([{ x: 1, y: 1 }]);
  eq('拿不到 2D 上下文也不攒粒子', noCtx.stats().particles, 0);

  eq('reduceMotion 如实回传', Fx.create({ reduceMotion: true }).stats().reduceMotion, true);
});

group('常量', function () {
  eq('粒子池上限 900', Fx.MAX_PARTICLES, 900);
});

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) process.exit(1);
