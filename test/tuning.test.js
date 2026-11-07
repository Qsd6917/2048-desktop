/**
 * 2048 音阶测试（纯 Node，无依赖）
 * 运行：node test/tuning.test.js
 *
 * 只测映射规则：音级、MIDI、频率、琶音延迟与音量、连击加花、各结算音数。
 */
const Tuning = require('../js/tuning.js');

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

function near(name, actual, expected, tolerance) {
  const eps = tolerance === undefined ? 0.01 : tolerance;
  ok(name, Math.abs(actual - expected) <= eps, '实际 ' + actual + ' 期望 ' + expected);
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

group('五声音阶常量', function () {
  eq('PENTATONIC 为宫调五声', Tuning.PENTATONIC, [0, 2, 4, 7, 9]);
  eq('基准音是 C4', Tuning.BASE_MIDI, 60);
  near('midiToFreq(69) = 440', Tuning.midiToFreq(69), 440, 0.001);
});

group('noteForValue：基础映射', function () {
  const two = Tuning.noteForValue(2);
  eq('2 -> degree 0', two.degree, 0);
  eq('2 -> midi 60 (C4)', two.midi, 60);
  eq('2 -> freq 261.63', two.freq, 261.63);

  near('2 的频率接近 261.63', two.freq, 261.6255653, 0.01);

  eq('4 -> D4', Tuning.noteForValue(4).midi, 62);
  eq('8 -> E4', Tuning.noteForValue(8).midi, 64);
  eq('16 -> G4', Tuning.noteForValue(16).midi, 67);
  eq('32 -> A4', Tuning.noteForValue(32).midi, 69);
  eq('32 -> 440Hz', Tuning.noteForValue(32).freq, 440);

  eq('64 跨八度到 C5', Tuning.noteForValue(64).midi, 72);
  eq('64 -> 523.25', Tuning.noteForValue(64).freq, 523.25);
  eq('128 -> D5', Tuning.noteForValue(128).midi, 74);
  eq('2048 -> C6', Tuning.noteForValue(2048).midi, 84);
  eq('2048 -> 1046.5', Tuning.noteForValue(2048).freq, 1046.5);
});

group('noteForValue：钳制', function () {
  eq('1 退到最低音', Tuning.noteForValue(1).midi, 60);
  eq('0 退到最低音', Tuning.noteForValue(0).midi, 60);
  eq('负数退到最低音', Tuning.noteForValue(-8).midi, 60);
  eq('NaN 退到最低音', Tuning.noteForValue(NaN).midi, 60);

  const huge = Tuning.noteForValue(1e9);
  eq('超大值 degree 封顶 15', huge.degree, 15);
  eq('超大值停在 C7', huge.midi, 96);

  const odd = Tuning.noteForValue(6);   // 非 2 的幂：round(log2 6)=3 -> degree 2
  eq('非 2 的幂按就近音级', odd.degree, 2);
});

group('mergeNotes：琶音', function () {
  const notes = Tuning.mergeNotes([2, 8, 32], 0);
  eq('三个音', notes.length, 3);
  eq('延迟 0/55/110', notes.map(function (n) { return n.delayMs; }), [0, 55, 110]);
  eq('频率升序', notes.map(function (n) { return n.freq; }), [261.63, 329.63, 440]);
  near('第一个音 gain 0.055', notes[0].gain, 0.055, 1e-9);
  near('第二个音 gain 0.055/1.3', notes[1].gain, 0.055 / 1.3, 1e-9);
  near('第三个音 gain 0.055/1.6', notes[2].gain, 0.055 / 1.6, 1e-9);
  ok('每个音都有正时长', notes.every(function (n) { return n.durMs > 0; }));

  const sorted = Tuning.mergeNotes([32, 2, 8], 0);
  eq('入参乱序也按值升序', sorted.map(function (n) { return n.freq; }), [261.63, 329.63, 440]);

  const dedup = Tuning.mergeNotes([8, 2, 8, 2], 0);
  eq('去重', dedup.length, 2);

  const capped = Tuning.mergeNotes([2, 4, 8, 16, 32, 64], 0);
  eq('最多 4 个音', capped.length, 4);

  eq('空输入不发声', Tuning.mergeNotes([], 0), []);
  eq('非数字输入被丢弃', Tuning.mergeNotes([NaN, -4, 0], 0), []);
});

group('mergeNotes：连击加花', function () {
  const plain = Tuning.mergeNotes([64], 2);
  const spark = Tuning.mergeNotes([64], 3);

  eq('combo 2 只有一个音', plain.length, 1);
  eq('combo 3 追加一个音', spark.length, 2);

  const base = spark[0];
  const ghost = spark[1];
  eq('高八度', ghost.freq, base.freq * 2);
  eq('延迟 = 上一个 + 40', ghost.delayMs, base.delayMs + 40);
  near('音量为上一个的 0.35', ghost.gain, base.gain * 0.35, 1e-9);
  eq('accent 在高位', ghost.freq > base.freq, true);
});

group('结算音', function () {
  eq('win 五音', Tuning.winNotes().length, 5);
  eq('win 为上行', Tuning.winNotes().map(function (n) { return n.freq; }),
    [523.25, 587.33, 659.26, 783.99, 1046.5]);

  const lose = Tuning.loseNotes();
  eq('lose 四音', lose.length, 4);
  ok('lose 为下行', lose[0].freq > lose[1].freq && lose[1].freq > lose[2].freq &&
    lose[2].freq > lose[3].freq);
  eq('lose 收在 C4', lose[3].freq, 261.63);

  const ach = Tuning.achievementNotes();
  eq('achievement 四音', ach.length, 4);
  eq('achievement 间隔 80ms', ach.map(function (n) { return n.delayMs; }), [0, 80, 160, 240]);
  eq('achievement 收在 C6', ach[3].freq, 1046.5);

  const daily = Tuning.dailyStartNotes();
  eq('dailyStart 两音', daily.length, 2);
  eq('dailyStart 间隔 90ms', daily.map(function (n) { return n.delayMs; }), [0, 90]);
  eq('dailyStart 为 G4 C5', daily.map(function (n) { return n.freq; }), [392, 523.25]);
});

group('纯函数性', function () {
  const a = Tuning.mergeNotes([2, 8], 5);
  const b = Tuning.mergeNotes([2, 8], 5);
  eq('同一输入结果一致', a, b);

  const first = Tuning.winNotes();
  first[0].freq = 1;
  eq('返回新数组，不污染内部状态', Tuning.winNotes()[0].freq, 523.25);
});

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) process.exit(1);
