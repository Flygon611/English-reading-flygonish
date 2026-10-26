/* 浏览器语音朗读：词 / 句 / 段落。找不到英语语音时返回 false，由 UI 提示。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});

  var supported = typeof window.speechSynthesis !== 'undefined';
  var voices = [];
  var preferred = null;

  function refreshVoices() {
    if (!supported) return;
    voices = window.speechSynthesis.getVoices() || [];
    if (!preferred || !voices.length) pick();
    else if (voices.indexOf(preferred) < 0) pick();
  }
  function pick() {
    var en = voices.filter(function (v) { return /^en[-_]/i.test(v.lang); });
    preferred = en[0] || null;
    var order = ['en-US', 'en-GB', 'en'];
    for (var i = 0; i < order.length && en.length; i++) {
      var m = en.filter(function (v) { return v.lang.replace('_', '-').toLowerCase() === order[i].toLowerCase(); });
      if (m.length) { preferred = m[0]; break; }
    }
    if (!preferred) preferred = voices[0] || null;
  }
  if (supported) {
    refreshVoices();
    if (typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
      window.speechSynthesis.onvoiceschanged = refreshVoices;
    }
  }

  function speak(text, opts) {
    opts = opts || {};
    if (!supported || !text) return false;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    var u = new SpeechSynthesisUtterance(String(text));
    var s = DR.store ? DR.store.settings() : {};
    u.lang = 'en-US';
    if (/^[a-z'’-]+$/i.test(String(text).trim()) || opts.word) {
      u.rate = 0.9;
      u.text = String(text);
    } else {
      u.rate = 0.95;
    }
    if (preferred) { u.voice = preferred; u.lang = preferred.lang; }
    u.pitch = 1;
    u.volume = 1;
    u.onerror = function (e) { if (opts.onError) opts.onError(e); };
    window.speechSynthesis.speak(u);
    return true;
  }
  function stop() { if (supported) { try { window.speechSynthesis.cancel(); } catch (e) {} } }
  function hasVoice() {
    refreshVoices();
    return voices.some(function (v) { return /^en[-_]/i.test(v.lang); });
  }

  DR.tts = { supported: supported, speak: speak, stop: stop, hasVoice: hasVoice, refresh: refreshVoices };
})();
