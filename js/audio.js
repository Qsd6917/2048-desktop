/**
 * 2048 音效 —— 全部用 WebAudio 现场合成，不引入任何音频文件。
 *
 * 设计要点：
 *   - AudioContext 延迟到第一次真正发声时才创建，并在用户手势内 resume()，
 *     避免页面加载即被自动播放策略拦成 suspended；
 *   - 浏览器没有 WebAudio（或被禁用）时，所有方法都是安全的空操作；
 *   - setEnabled(false) 之后所有方法立刻返回，连 AudioContext 都不碰；
 *   - 音高不在本文件里算：五声音阶映射全在 js/tuning.js，这里只负责把
 *     音符表（freq/delayMs/durMs/gain）逐一合成出来。
 */
(function (global) {
  'use strict';

  var AudioCtor = global.AudioContext || global.webkitAudioContext;
  var Tuning = global.Game2048Tuning;

  var MOVE_GAIN = 0.03;

  /** 合并与结算音用的波形：三角波比正弦多一层泛音，木质感更接近纸牌 */
  var NOTE_TYPE = 'triangle';

  var context = null;
  var enabled = true;

  /** 取（或惰性创建）AudioContext；不可用时返回 null */
  function ensureContext() {
    if (!AudioCtor) return null;

    if (!context) {
      try {
        context = new AudioCtor();
      } catch (e) {
        context = null;
        AudioCtor = null;   // 以后别再试了
        return null;
      }
    }

    // 自动播放策略下默认是 suspended，必须在用户手势里唤醒
    if (context.state === 'suspended' && typeof context.resume === 'function') {
      try {
        context.resume();
      } catch (e) {
        /* 唤不醒也不影响玩 */
      }
    }

    return context;
  }

  /**
   * 发一个包络成型的音。
   * @param {number} frequency 频率 Hz
   * @param {number} durationMs 时长毫秒
   * @param {OscillatorType} type 波形
   * @param {number} gain 峰值增益（0~1）
   * @param {number} [delayMs] 相对当前的延迟，用于串成音阶
   */
  function tone(frequency, durationMs, type, gain, delayMs) {
    if (!enabled) return;
    var ac = ensureContext();
    if (!ac) return;

    var startAt = ac.currentTime + (delayMs || 0) / 1000;
    var duration = durationMs / 1000;
    // 起音留 12ms 防止爆音；收尾直接落到极小值，靠指数曲线自然衰减
    var attack = Math.min(0.012, duration * 0.3);

    var osc = ac.createOscillator();
    var amp = ac.createGain();

    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(frequency, startAt);

    // 指数包络不能到 0，用极小值代替
    amp.gain.setValueAtTime(0.0001, startAt);
    amp.gain.exponentialRampToValueAtTime(gain, startAt + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    osc.connect(amp);
    amp.connect(ac.destination);

    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }

  /**
   * 按音符表逐音发声。
   * @param {Array<{freq:number, delayMs:number, durMs:number, gain:number}>} notes
   * @param {OscillatorType} [type]
   */
  function playNotes(notes, type) {
    if (!enabled || !notes) return;
    for (var i = 0; i < notes.length; i++) {
      var note = notes[i];
      tone(note.freq, note.durMs, type || NOTE_TYPE, note.gain, note.delayMs);
    }
  }

  /** 普通移动：60ms 短促低音 */
  function move() {
    if (!enabled) return;
    tone(126, 60, 'sine', MOVE_GAIN, 0);
  }

  /**
   * 单组合并：音高由方块值沿五声音阶决定。
   * @param {number} value 合并出来的方块值
   * @param {number} [combo] 连击数；>= 3 时多一个高八度弱音
   */
  function merge(value, combo) {
    if (!enabled) return;

    var v = Number(value);
    if (!(v > 0)) {
      move();
      return;
    }
    if (!Tuning) return;   // 脚本没按顺序加载时宁可不响，也不要抛错

    playNotes(Tuning.mergeNotes([v], combo || 0), NOTE_TYPE);
  }

  /**
   * 一步里多组合并：按方块值升序播一段琶音。
   * @param {Array<number>} values
   * @param {number} [combo]
   */
  function playMergeSet(values, combo) {
    if (!enabled || !Tuning) return;

    var notes = Tuning.mergeNotes(values, combo || 0);
    if (!notes.length) {
      move();
      return;
    }
    playNotes(notes, NOTE_TYPE);
  }

  /** 达成目标：上行五音 */
  function win() {
    if (!enabled || !Tuning) return;
    playNotes(Tuning.winNotes(), NOTE_TYPE);
  }

  /** 死局/超时：下行四音 */
  function gameover() {
    if (!enabled || !Tuning) return;
    playNotes(Tuning.loseNotes(), 'sine');
  }

  /** 成就解锁：四音上行（本任务只提供接口，界面由成就模块触发） */
  function achievement() {
    if (!enabled || !Tuning) return;
    playNotes(Tuning.achievementNotes(), NOTE_TYPE);
  }

  /** 每日挑战开始：两音上行 */
  function dailyStart() {
    if (!enabled || !Tuning) return;
    playNotes(Tuning.dailyStartNotes(), NOTE_TYPE);
  }

  /**
   * 连击亮点：音高随连击数上行，两声短促叠音。
   * @param {number} combo
   */
  function comboSpark(combo) {
    if (!enabled || !Tuning) return;

    var level = Math.min(9, Math.max(1, Math.floor(Number(combo) || 1)));
    var frequency = Tuning.midiToFreq(84 + level * 2);
    tone(frequency, 90, 'sine', 0.05, 0);
    tone(frequency * 1.5, 110, 'sine', 0.035, 70);
  }

  /**
   * 开关音效。关闭时不 suspend AudioContext —— 留着上下文，
   * 再次开启能立刻发声，不用等重新授权。
   */
  function setEnabled(value) {
    enabled = Boolean(value);
  }

  function isEnabled() {
    return enabled;
  }

  global.Game2048Audio = {
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    move: move,
    merge: merge,
    playMergeSet: playMergeSet,
    win: win,
    gameover: gameover,
    achievement: achievement,
    dailyStart: dailyStart,
    comboSpark: comboSpark
  };
})(window);
