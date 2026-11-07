/**
 * 2048 音效 —— 全部用 WebAudio 现场合成，不引入任何音频文件。
 *
 * 设计要点：
 *   - AudioContext 延迟到第一次真正发声时才创建，并在用户手势内 resume()，
 *     避免页面加载即被自动播放策略拦成 suspended；
 *   - 浏览器没有 WebAudio（或被禁用）时，所有方法都是安全的空操作；
 *   - setEnabled(false) 之后所有方法立刻返回，连 AudioContext 都不碰。
 */
(function (global) {
  'use strict';

  var AudioCtor = global.AudioContext || global.webkitAudioContext;

  /** 合并音的基础音量；move 要更轻，否则每步都吵 */
  var MERGE_GAIN = 0.06;
  var MOVE_GAIN = 0.03;

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

  /** 以 2 为底的对数（老环境没有 Math.log2） */
  function log2(value) {
    return Math.log(value) / Math.LN2;
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

  /** 普通移动：60ms 短促低音 */
  function move() {
    if (!enabled) return;
    tone(126, 60, 'sine', MOVE_GAIN, 0);
  }

  /**
   * 合并：音高随方块数值升高。
   * 基频 = 220 * 2^((log2(value) - 1) / 12)，每翻一倍方块升高一个半音。
   */
  function merge(value) {
    if (!enabled) return;
    var v = Number(value);
    if (!(v > 0)) {
      move();
      return;
    }
    var frequency = 220 * Math.pow(2, (log2(v) - 1) / 12);
    tone(frequency, 80, 'triangle', MERGE_GAIN, 0);
  }

  /** 达成目标：上行三连音 */
  function win() {
    if (!enabled) return;
    tone(523.25, 130, 'triangle', MERGE_GAIN, 0);
    tone(659.25, 130, 'triangle', MERGE_GAIN, 90);
    tone(783.99, 220, 'triangle', MERGE_GAIN, 180);
  }

  /** 结束：下行三连音 */
  function gameover() {
    if (!enabled) return;
    tone(311.13, 150, 'sine', MERGE_GAIN, 0);
    tone(261.63, 150, 'sine', MERGE_GAIN, 120);
    tone(207.65, 260, 'sine', MERGE_GAIN, 240);
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
    win: win,
    gameover: gameover
  };
})(window);
