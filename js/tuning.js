/**
 * 2048 音阶 —— 把方块数值映射成五声音阶上的音，纯函数，不碰 DOM。
 *
 * 浏览器里挂到 window.Game2048Tuning，Node 里通过 module.exports 导出。
 *
 * 为什么用五声（宫调）而不是半音阶：合并是高频事件，半音阶在连续合并时很容易
 * 撞出小二度的浑浊感；五声音阶里任意两音叠在一起都是协和的，翻倍升级听起来
 * 是「往上走」而不是「越来越尖」。
 *
 * 映射规则：方块每翻一倍升一级 degree，degree 在五声里循环、每 5 级跨一个八度。
 * 于是 2→C4、64→C5、2048→C6，尺寸再大也只会在最高音上钳住，不会跑出听觉范围。
 *
 * 所有音都只描述「怎么发声」（频率/延迟/时长/音量），由 js/audio.js 现场合成。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Game2048Tuning = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 五声音阶（宫调）的半音偏移：宫 商 角 徵 羽 */
  var PENTATONIC = [0, 2, 4, 7, 9];

  /** 基准音 MIDI 60 = C4，对应方块 2 */
  var BASE_MIDI = 60;

  /** 音级上限：1e9 这种超大块也只在最高音上停住 */
  var MAX_DEGREE = 15;

  /** 一次移动最多取几个合并音：再多就糊成噪音了 */
  var MAX_MERGE_NOTES = 4;

  /** 合并琶音相邻两音的间隔，以及单音时长 */
  var MERGE_STEP_MS = 55;
  var MERGE_DUR_MS = 90;

  /** 合并音的基础音量；第 i 个音按 1/(1+0.3i) 递减 */
  var MERGE_BASE_GAIN = 0.055;

  /** 连击加花：多出来那个高八度弱音的相对音量与追加延迟 */
  var COMBO_GHOST_GAIN = 0.35;
  var COMBO_GHOST_DELAY_MS = 40;

  /** 以 2 为底的对数（不依赖 Math.log2，保持与老环境一致） */
  function log2(value) {
    return Math.log(value) / Math.LN2;
  }

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  /** 频率保留两位小数：测试要拿定值断言，浮动尾数没意义 */
  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  /** MIDI 音高 -> 频率（A4 = 440Hz = MIDI 69） */
  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /**
   * 方块数值 -> 一个音。
   * @param {number} value 方块数值（2 的幂）
   * @returns {{degree: number, midi: number, freq: number}}
   */
  function noteForValue(value) {
    var v = Number(value);
    if (!isFinite(v) || v <= 0) v = 1;   // 0 / NaN / 负数都退到最低音

    var degree = clamp(Math.round(log2(v)) - 1, 0, MAX_DEGREE);
    var midi = BASE_MIDI + PENTATONIC[degree % 5] + 12 * Math.floor(degree / 5);

    return { degree: degree, midi: midi, freq: round2(midiToFreq(midi)) };
  }

  /**
   * 把一堆方块值整理成「升序、去重、最多 4 个」的音级列表。
   * 一次移动可能同时合出 4/8/32，按值排序听起来才像一段上行琶音。
   */
  function normalizeValues(values) {
    var list;
    if (Array.isArray(values)) list = values;
    else if (values === undefined || values === null) list = [];
    else list = [values];

    var seen = {};
    var out = [];

    for (var i = 0; i < list.length; i++) {
      var v = Number(list[i]);
      if (!(v > 0)) continue;
      if (seen[v]) continue;
      seen[v] = true;
      out.push(v);
    }

    out.sort(function (a, b) { return a - b; });
    if (out.length > MAX_MERGE_NOTES) out.length = MAX_MERGE_NOTES;
    return out;
  }

  /**
   * 合并音：一步里所有合并值的琶音。
   * @param {Array<number>} values 合并出来的方块值
   * @param {number} [combo] 当前连击数；>= 3 时追加一个高八度弱音
   * @returns {Array<{freq: number, delayMs: number, durMs: number, gain: number}>}
   */
  function mergeNotes(values, combo) {
    var list = normalizeValues(values);
    var notes = [];

    for (var i = 0; i < list.length; i++) {
      notes.push({
        freq: noteForValue(list[i]).freq,
        delayMs: i * MERGE_STEP_MS,
        durMs: MERGE_DUR_MS,
        gain: MERGE_BASE_GAIN / (1 + 0.3 * i)
      });
    }

    if (Number(combo) >= 3 && notes.length) {
      var last = notes[notes.length - 1];
      notes.push({
        freq: round2(last.freq * 2),
        delayMs: last.delayMs + COMBO_GHOST_DELAY_MS,
        durMs: MERGE_DUR_MS,
        gain: last.gain * COMBO_GHOST_GAIN
      });
    }

    return notes;
  }

  /** 一串 MIDI 音 -> 等间隔音符表 */
  function sequence(midis, stepMs, durMs, gain) {
    var notes = [];
    for (var i = 0; i < midis.length; i++) {
      notes.push({
        freq: round2(midiToFreq(midis[i])),
        delayMs: i * stepMs,
        durMs: durMs,
        gain: gain
      });
    }
    return notes;
  }

  /** 达成目标：上行五音 C5 D5 E5 G5 C6 */
  function winNotes() {
    return sequence([72, 74, 76, 79, 84], 110, 150, 0.055);
  }

  /** 死局/超时：下行四音 A4 G4 E4 C4 */
  function loseNotes() {
    return sequence([69, 67, 64, 60], 130, 170, 0.055);
  }

  /** 成就解锁：C5 E5 G5 C6，四音上行 */
  function achievementNotes() {
    return sequence([72, 76, 79, 84], 80, 120, 0.055);
  }

  /** 每日挑战开始：G4 C5 两音 */
  function dailyStartNotes() {
    return sequence([67, 72], 90, 130, 0.05);
  }

  return {
    PENTATONIC: PENTATONIC,
    BASE_MIDI: BASE_MIDI,
    MAX_DEGREE: MAX_DEGREE,
    midiToFreq: midiToFreq,
    noteForValue: noteForValue,
    mergeNotes: mergeNotes,
    winNotes: winNotes,
    loseNotes: loseNotes,
    achievementNotes: achievementNotes,
    dailyStartNotes: dailyStartNotes
  };
});
