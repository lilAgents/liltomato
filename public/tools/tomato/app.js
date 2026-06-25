/*
 * lilTomato — native vanilla rebuild of the React Pomodoro timer for
 * lilagents.com/tools/tomato/. Framework-free port of the original reducer
 * state machine, Web Audio engine, localStorage persistence, stats, and the
 * Header / TimerCard / TaskList / SettingsModal / ReportView / Toast / Runtime
 * effect engines. Follows the SITE's dark mode (.dark on <html>); no in-tool
 * light/dark toggle.
 */
(function () {
  'use strict';

  var root = document.getElementById('tomato-app');
  if (!root) return;

  // ----------------------------------------------------------------- consts
  var KEY = 'liltomato-v1';
  var ACTIVE_KEY = 'liltomato-active-task';
  var IDLE_MS = 900;
  var ICON = '/tools/tomato/tomato.svg';
  var BASE_TITLE = document.title;

  var defaultSettings = {
    pomodoroMinutes: 25,
    shortMinutes: 5,
    longMinutes: 15,
    longBreakInterval: 4,
    autoStartBreaks: true,
    autoStartPomodoros: false,
    useSequence: true,
    taskAutoCheck: false,
    taskCheckToBottom: true,
    alarmPreset: 'bell',
    alarmVolume: 0.5,
    alarmRepeat: 1,
    focusPreset: 'none',
    focusVolume: 0.5,
    focusCustomUrl: '',
    darkWhenRunning: false,
    browserNotify: false,
    reminderMinutes: 0,
  };

  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // ------------------------------------------------------------------ utils
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function formatMMSS(seconds) {
    var s = Math.max(0, seconds);
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  function minutesForMode(mode, s) {
    if (mode === 'short') return s.shortMinutes;
    if (mode === 'long') return s.longMinutes;
    return s.pomodoroMinutes;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ------------------------------------------------------------------ audio
  var audioCtx = null;
  function getCtx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    return audioCtx;
  }
  function resumeAudio() {
    try {
      var ctx = getCtx();
      if (ctx.state === 'suspended') return ctx.resume();
    } catch (e) { /* no audio */ }
    return Promise.resolve();
  }
  function beep(freq, duration, volume, type) {
    try {
      var ctx = getCtx();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      gain.gain.value = volume * 0.3;
      osc.connect(gain);
      gain.connect(ctx.destination);
      var now = ctx.currentTime;
      osc.start(now);
      osc.stop(now + duration);
    } catch (e) { /* no audio */ }
  }
  function playAlarmPreset(preset, volume, repeat) {
    if (preset === 'none') return;
    resumeAudio();
    var v = clamp(volume, 0, 1);
    var times = clamp(Math.floor(repeat), 1, 10);
    var i = 0;
    function ring() {
      if (preset === 'bell') {
        beep(880, 0.12, v);
        setTimeout(function () { beep(660, 0.15, v); }, 120);
      } else if (preset === 'kitchen') {
        beep(523, 0.08, v, 'triangle');
        setTimeout(function () { beep(784, 0.08, v, 'triangle'); }, 100);
        setTimeout(function () { beep(1046, 0.12, v, 'triangle'); }, 200);
      } else {
        beep(990, 0.1, v, 'square');
        setTimeout(function () { beep(1320, 0.08, v, 'square'); }, 90);
      }
      i++;
      if (i < times) setTimeout(ring, 450);
    }
    ring();
  }

  var noiseSource = null;
  var customAudioEl = null;
  function startFocusAmbient(preset, volume, customUrl) {
    resumeAudio();
    stopFocusAmbient();
    if (preset === 'custom' && customUrl && customUrl.trim()) {
      var el = new Audio(customUrl.trim());
      el.loop = true;
      el.volume = clamp(volume, 0, 1);
      customAudioEl = el;
      var p = el.play();
      if (p && p.catch) p.catch(function () { /* blocked */ });
      return;
    }
    if (preset !== 'brown') return;
    try {
      var ctx = getCtx();
      var bufferSize = 2 * ctx.sampleRate;
      var buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      var data = buffer.getChannelData(0);
      var last = 0;
      for (var i = 0; i < bufferSize; i++) {
        var white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      }
      var src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      var gain = ctx.createGain();
      gain.gain.value = clamp(volume, 0, 1) * 0.08;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start();
      noiseSource = src;
    } catch (e) { /* no audio */ }
  }
  function stopFocusAmbient() {
    if (customAudioEl) {
      try { customAudioEl.pause(); } catch (e) { /* */ }
      customAudioEl = null;
    }
    if (noiseSource) {
      try { noiseSource.stop(); } catch (e) { /* */ }
      noiseSource = null;
    }
  }

  // ----------------------------------------------------------------- notify
  function requestNotificationPermission() {
    if (!('Notification' in window)) return Promise.resolve('denied');
    if (Notification.permission === 'granted') return Promise.resolve('granted');
    if (Notification.permission === 'denied') return Promise.resolve('denied');
    try { return Notification.requestPermission(); } catch (e) { return Promise.resolve('denied'); }
  }
  function notifyDone(title, body, enabled) {
    if (!enabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body: body, icon: ICON }); } catch (e) { /* */ }
  }

  // ------------------------------------------------------------------ stats
  function todayStart() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function weekStart() {
    var d = new Date();
    var day = d.getDay();
    var diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function countPomodoros(events, since) {
    return events.filter(function (e) { return e.at >= since && e.type === 'pomodoro_completed'; }).length;
  }
  function minutesByType(events, since) {
    var acc = { pomodoro_completed: 0, short_completed: 0, long_completed: 0 };
    events.forEach(function (e) { if (e.at >= since) acc[e.type] += e.durationMinutes; });
    return acc;
  }

  // ---------------------------------------------------------------- storage
  function defaultTimerSlice(settings) {
    return {
      mode: 'pomodoro',
      status: 'idle',
      remainingSeconds: minutesForMode('pomodoro', settings) * 60,
      streakSinceLong: 0,
    };
  }
  function normalizeTimer(t, settings) {
    t = t || {};
    var mode = t.mode === 'short' || t.mode === 'long' ? t.mode : 'pomodoro';
    var status = t.status === 'running' || t.status === 'paused' ? t.status : 'idle';
    var full = minutesForMode(mode, settings) * 60;
    var remaining = typeof t.remainingSeconds === 'number' && t.remainingSeconds >= 0
      ? Math.min(t.remainingSeconds, full) : full;
    if (status === 'idle') remaining = full;
    var streak = typeof t.streakSinceLong === 'number' && t.streakSinceLong >= 0
      ? t.streakSinceLong % Math.max(1, settings.longBreakInterval) : 0;
    return {
      mode: mode,
      status: status === 'running' ? 'paused' : status,
      remainingSeconds: remaining,
      streakSinceLong: streak,
    };
  }
  function mergeSettings(raw) {
    var s = {};
    for (var k in defaultSettings) s[k] = defaultSettings[k];
    if (raw && typeof raw === 'object') {
      for (var j in defaultSettings) {
        if (Object.prototype.hasOwnProperty.call(raw, j)) s[j] = raw[j];
      }
    }
    return s;
  }
  function loadState() {
    try {
      var rawStr = localStorage.getItem(KEY);
      if (!rawStr) return null;
      var parsed = JSON.parse(rawStr);
      if (parsed.version !== 1) return null;
      var settings = mergeSettings(parsed.settings);
      return {
        settings: settings,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        stats: Array.isArray(parsed.stats) ? parsed.stats : [],
        timer: normalizeTimer(parsed.timer, settings),
      };
    } catch (e) { return null; }
  }
  function saveState(st) {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        version: 1,
        settings: st.settings,
        tasks: st.tasks,
        stats: st.stats,
        timer: st.timer,
      }));
    } catch (e) { /* quota / unavailable */ }
  }
  function exportJson(st) {
    return JSON.stringify({
      version: 1,
      settings: st.settings,
      tasks: st.tasks,
      stats: st.stats,
      timer: st.timer,
    }, null, 2);
  }
  function importJson(text) {
    try {
      var parsed = JSON.parse(text);
      if (parsed.version !== 1) return null;
      var settings = mergeSettings(parsed.settings);
      return {
        settings: settings,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        stats: Array.isArray(parsed.stats) ? parsed.stats : [],
        timer: normalizeTimer(parsed.timer, settings),
      };
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- reducer
  function sortTasks(tasks, checkToBottom) {
    var copy = tasks.slice();
    if (checkToBottom) {
      copy.sort(function (a, b) {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return a.order - b.order;
      });
    } else {
      copy.sort(function (a, b) { return a.order - b.order; });
    }
    return copy.map(function (t, i) {
      return { id: t.id, title: t.title, done: t.done, order: i };
    });
  }

  function completePhase(state) {
    var settings = state.settings;
    var timer = state.timer;
    var mode = timer.mode;
    var streakSinceLong = timer.streakSinceLong;
    var durationMin = minutesForMode(mode, settings);

    var evtType = mode === 'pomodoro' ? 'pomodoro_completed'
      : mode === 'short' ? 'short_completed' : 'long_completed';

    var event = { id: uuid(), type: evtType, at: Date.now(), durationMinutes: durationMin };
    var nextStats = state.stats.concat([event]);

    var nextMode = mode;
    var nextStreak = streakSinceLong;
    var nextRemaining = 0;
    var nextStatus = 'idle';

    if (settings.useSequence) {
      if (mode === 'pomodoro') {
        var n = streakSinceLong + 1;
        var isLong = n % settings.longBreakInterval === 0;
        nextMode = isLong ? 'long' : 'short';
        nextStreak = isLong ? 0 : n;
        nextRemaining = (isLong ? settings.longMinutes : settings.shortMinutes) * 60;
      } else if (mode === 'short') {
        nextMode = 'pomodoro';
        nextRemaining = settings.pomodoroMinutes * 60;
      } else {
        nextMode = 'pomodoro';
        nextStreak = 0;
        nextRemaining = settings.pomodoroMinutes * 60;
      }
      var autoStart = (mode === 'pomodoro' && settings.autoStartBreaks) ||
        ((mode === 'short' || mode === 'long') && settings.autoStartPomodoros);
      nextStatus = autoStart ? 'running' : 'idle';
    } else {
      nextRemaining = minutesForMode(mode, settings) * 60;
      if (mode === 'pomodoro') nextStreak = streakSinceLong + 1;
      if (mode === 'long') nextStreak = 0;
    }

    return assign({}, state, {
      stats: nextStats,
      timer: {
        mode: settings.useSequence ? nextMode : mode,
        status: nextStatus,
        remainingSeconds: nextRemaining,
        streakSinceLong: nextStreak,
      },
    });
  }

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (src) for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  function reducer(state, action) {
    switch (action.type) {
      case 'HYDRATE':
      case 'IMPORT':
        return action.payload;
      case 'SETTINGS_PATCH': {
        var merged = assign({}, state.settings, action.payload);
        var timer = state.timer;
        if (state.timer.status === 'idle') {
          var full = minutesForMode(timer.mode, merged) * 60;
          timer = assign({}, timer, { remainingSeconds: full });
        }
        return assign({}, state, { settings: merged, timer: timer });
      }
      case 'SETTINGS_OPEN':
        return assign({}, state, { settingsOpen: action.open });
      case 'VIEW':
        return assign({}, state, { view: action.view });
      case 'TOAST':
        return assign({}, state, { toast: action.message });
      case 'SET_MODE': {
        if (state.timer.status === 'running') return state;
        var fullM = minutesForMode(action.mode, state.settings) * 60;
        return assign({}, state, {
          timer: assign({}, state.timer, { mode: action.mode, remainingSeconds: fullM }),
        });
      }
      case 'START': {
        if (state.timer.status === 'running') return state;
        if (state.timer.remainingSeconds <= 0) {
          var fullS = minutesForMode(state.timer.mode, state.settings) * 60;
          return assign({}, state, {
            timer: assign({}, state.timer, { status: 'running', remainingSeconds: fullS }),
          });
        }
        return assign({}, state, { timer: assign({}, state.timer, { status: 'running' }) });
      }
      case 'PAUSE':
        if (state.timer.status !== 'running') return state;
        return assign({}, state, { timer: assign({}, state.timer, { status: 'paused' }) });
      case 'RESET': {
        var fullR = minutesForMode(state.timer.mode, state.settings) * 60;
        return assign({}, state, {
          timer: assign({}, state.timer, { status: 'idle', remainingSeconds: fullR }),
        });
      }
      case 'TICK': {
        if (state.timer.status !== 'running') return state;
        var next = state.timer.remainingSeconds - 1;
        if (next > 0) {
          return assign({}, state, { timer: assign({}, state.timer, { remainingSeconds: next }) });
        }
        return completePhase(state);
      }
      case 'TASK_ADD': {
        var order = state.tasks.length === 0 ? 0
          : Math.max.apply(null, state.tasks.map(function (t) { return t.order; })) + 1;
        var task = { id: uuid(), title: (action.title || '').trim() || 'Task', done: false, order: order };
        return assign({}, state, {
          tasks: sortTasks(state.tasks.concat([task]), state.settings.taskCheckToBottom),
        });
      }
      case 'TASK_UPDATE':
        return assign({}, state, {
          tasks: state.tasks.map(function (t) {
            return t.id === action.id ? assign({}, t, { title: action.title }) : t;
          }),
        });
      case 'TASK_TOGGLE': {
        var toggled = state.tasks.map(function (t) {
          if (t.id !== action.id) return t;
          return assign({}, t, { done: !t.done });
        });
        return assign({}, state, { tasks: sortTasks(toggled, state.settings.taskCheckToBottom) });
      }
      case 'TASK_DELETE':
        return assign({}, state, {
          tasks: state.tasks.filter(function (t) { return t.id !== action.id; }),
        });
      case 'TASK_REORDER': {
        var ordered = state.tasks.slice().sort(function (a, b) { return a.order - b.order; });
        var moved = ordered.splice(action.from, 1)[0];
        ordered.splice(action.to, 0, moved);
        return assign({}, state, {
          tasks: ordered.map(function (t, i) { return assign({}, t, { order: i }); }),
        });
      }
      case 'TASK_MARK_DONE':
        return assign({}, state, {
          tasks: sortTasks(
            state.tasks.map(function (t) {
              return t.id === action.id ? assign({}, t, { done: true }) : t;
            }),
            state.settings.taskCheckToBottom
          ),
        });
      default:
        return state;
    }
  }

  // ------------------------------------------------------------------ store
  var initial = {
    settings: defaultSettings,
    tasks: [],
    stats: [],
    timer: defaultTimerSlice(defaultSettings),
    view: 'main',
    settingsOpen: false,
    toast: null,
  };

  var state = (function () {
    var loaded = loadState();
    if (!loaded) return initial;
    return assign({}, initial, {
      settings: loaded.settings,
      tasks: loaded.tasks,
      stats: loaded.stats,
      timer: loaded.timer,
    });
  })();

  var activeTaskId = (function () {
    try {
      var r = localStorage.getItem(ACTIVE_KEY);
      return r ? JSON.parse(r) : null;
    } catch (e) { return null; }
  })();

  var reminderFired = false;
  var forcedDark = false;
  var focusKey = 'off';
  var tickTimer = null;
  var editingId = null;
  var settingsTab = 'Timers';

  function dispatch(action) {
    var prev = state;
    state = reducer(state, action);
    onChange(prev);
  }
  function setActiveTaskId(id) {
    var prev = activeTaskId;
    activeTaskId = id;
    try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(id)); } catch (e) { /* */ }
    if (prev !== id) renderTasks();
  }

  // ---------------------------------------------------------------- effects
  function manageTick() {
    var running = state.timer.status === 'running';
    if (running && !tickTimer) {
      tickTimer = window.setInterval(function () { dispatch({ type: 'TICK' }); }, 1000);
    } else if (!running && tickTimer) {
      window.clearInterval(tickTimer);
      tickTimer = null;
    }
  }
  function manageFocusAudio() {
    var timer = state.timer, settings = state.settings;
    var run = timer.status === 'running' && timer.mode === 'pomodoro' && settings.focusPreset !== 'none';
    var key = run ? settings.focusPreset + '|' + settings.focusVolume + '|' + settings.focusCustomUrl : 'off';
    if (key === focusKey) return;
    focusKey = key;
    if (!run) { stopFocusAmbient(); return; }
    if (settings.focusPreset === 'brown') startFocusAmbient('brown', settings.focusVolume, '');
    else if (settings.focusPreset === 'custom') startFocusAmbient('custom', settings.focusVolume, settings.focusCustomUrl);
  }
  function manageReminder() {
    var timer = state.timer, settings = state.settings;
    var m = settings.reminderMinutes;
    if (m <= 0 || timer.status !== 'running') return;
    var target = Math.round(m * 60);
    if (timer.remainingSeconds !== target || reminderFired) return;
    reminderFired = true;
    notifyDone('lilTomato', m + ' minute(s) left', settings.browserNotify);
    dispatch({ type: 'TOAST', message: m + ' minute(s) left' });
    setTimeout(function () { dispatch({ type: 'TOAST', message: null }); }, 4000);
  }
  function restoreSiteTheme() {
    var userTheme = null;
    try { userTheme = localStorage.getItem('theme'); } catch (e) { /* */ }
    var sys = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = userTheme === 'dark' || (!userTheme && sys);
    document.documentElement.classList.toggle('dark', dark);
  }
  function manageTheme() {
    var running = state.timer.status === 'running';
    if (state.settings.darkWhenRunning && running) {
      document.documentElement.classList.add('dark');
      forcedDark = true;
    } else if (forcedDark) {
      forcedDark = false;
      restoreSiteTheme();
    }
  }
  function updateDocTitle() {
    if (state.timer.status === 'running') {
      document.title = formatMMSS(state.timer.remainingSeconds) + ' · lilTomato';
    } else {
      document.title = BASE_TITLE;
    }
  }

  function onChange(prev) {
    saveState(state);

    // Side effects keyed off a single new completion event (stats grew by one).
    if (state.stats.length === prev.stats.length + 1) {
      var last = state.stats[state.stats.length - 1];
      playAlarmPreset(state.settings.alarmPreset, state.settings.alarmVolume, state.settings.alarmRepeat);
      var label = last.type === 'pomodoro_completed' ? 'Focus session complete'
        : last.type === 'short_completed' ? 'Short break over' : 'Long break over';
      notifyDone('lilTomato', label, state.settings.browserNotify);
      if (state.settings.taskAutoCheck && activeTaskId && last.type === 'pomodoro_completed') {
        dispatch({ type: 'TASK_MARK_DONE', id: activeTaskId });
      }
    }

    manageTick();
    manageFocusAudio();
    manageReminder();
    manageTheme();
    updateDocTitle();

    // reset the per-session reminder latch when the timer stops or the phase changes
    if (state.timer.status !== 'running' || state.timer.mode !== prev.timer.mode) {
      reminderFired = false;
    }

    renderTimer();
    if (state.tasks !== prev.tasks || state.settings !== prev.settings) renderTasks();
    if (state.settingsOpen !== prev.settingsOpen) renderSettings();
    if (state.view !== prev.view) renderReport();
    if (state.toast !== prev.toast) renderToast();
  }

  // ------------------------------------------------------------------- view
  var els = {};
  var MODES = [
    { id: 'pomodoro', label: 'Pomodoro' },
    { id: 'short', label: 'Short break' },
    { id: 'long', label: 'Long break' },
  ];

  function buildApp() {
    root.className = 'tmto-app';
    root.innerHTML =
      '<div class="tmto-bar" id="tmtoBar">' +
        '<a class="tmto-brand" href="https://lilagents.com/" target="_blank">' +
          '<img src="' + ICON + '" alt="" width="32" height="32"/>' +
          '<span>lilTomato</span>' +
        '</a>' +
        '<div class="tmto-actions">' +
          '<button type="button" class="tmto-pill" id="tmtoReport">Report</button>' +
          '<button type="button" class="tmto-pill" id="tmtoSettings">Settings</button>' +
          '<button type="button" class="tmto-pill" id="tmtoFs" title="Fullscreen">Fullscreen</button>' +
        '</div>' +
      '</div>' +
      '<div class="tmto-main" id="tmtoMain">' +
        '<section class="tmto-card tmto-timer">' +
          '<div class="tmto-modes" id="tmtoModes"></div>' +
          '<div class="tmto-collapse is-closed" id="tmtoCycleWrap"><div><p class="tmto-cycle" id="tmtoCycle"></p></div></div>' +
          '<div class="tmto-time" role="timer" aria-label="Time remaining" id="tmtoTime">00:00</div>' +
          '<div class="tmto-controls">' +
            '<button type="button" class="tmto-primary" id="tmtoToggle">Start</button>' +
            '<button type="button" class="tmto-ghost" id="tmtoReset">Reset</button>' +
          '</div>' +
          '<div class="tmto-collapse tmto-hintwrap" id="tmtoHintWrap"><div><p class="tmto-hint" id="tmtoHint"></p></div></div>' +
        '</section>' +
        '<div class="tmto-collapse tmto-taskswrap" id="tmtoTasksWrap"><div>' +
          '<section class="tmto-card tmto-tasks">' +
            '<h2 class="tmto-tasks__title">Tasks</h2>' +
            '<ul class="tmto-tasklist" id="tmtoTaskList"></ul>' +
            '<div class="tmto-add">' +
              '<input type="text" class="tmto-input" id="tmtoTaskInput" placeholder="Add a task" autocomplete="off"/>' +
              '<button type="button" class="tmto-add__btn" id="tmtoAdd">Add</button>' +
            '</div>' +
            '<p class="tmto-tasknote" id="tmtoTaskNote"></p>' +
          '</section>' +
        '</div></div>' +
      '</div>' +
      '<footer class="tmto-foot" id="tmtoFoot">Made with <span aria-hidden="true">❤️</span> by ' +
        '<a href="https://lilagents.com/" target="_blank">lilAgents</a></footer>' +
      '<div id="tmtoModalMount"></div>' +
      '<div id="tmtoReportMount"></div>' +
      '<div class="tmto-toast" id="tmtoToast" hidden></div>';

    els.bar = root.querySelector('#tmtoBar');
    els.modes = root.querySelector('#tmtoModes');
    els.cycleWrap = root.querySelector('#tmtoCycleWrap');
    els.cycle = root.querySelector('#tmtoCycle');
    els.time = root.querySelector('#tmtoTime');
    els.toggle = root.querySelector('#tmtoToggle');
    els.reset = root.querySelector('#tmtoReset');
    els.hintWrap = root.querySelector('#tmtoHintWrap');
    els.hint = root.querySelector('#tmtoHint');
    els.taskList = root.querySelector('#tmtoTaskList');
    els.taskInput = root.querySelector('#tmtoTaskInput');
    els.taskNote = root.querySelector('#tmtoTaskNote');
    els.foot = root.querySelector('#tmtoFoot');
    els.modalMount = root.querySelector('#tmtoModalMount');
    els.reportMount = root.querySelector('#tmtoReportMount');
    els.toast = root.querySelector('#tmtoToast');

    // mode buttons (static)
    els.modes.innerHTML = MODES.map(function (m) {
      return '<button type="button" class="tmto-mode" data-mode="' + m.id + '">' + m.label + '</button>';
    }).join('');

    wireApp();
  }

  function wireApp() {
    root.querySelector('#tmtoReport').addEventListener('click', function () {
      dispatch({ type: 'VIEW', view: 'report' });
    });
    root.querySelector('#tmtoSettings').addEventListener('click', function () {
      dispatch({ type: 'SETTINGS_OPEN', open: true });
    });
    root.querySelector('#tmtoFs').addEventListener('click', toggleFullscreen);

    els.modes.addEventListener('click', function (e) {
      var btn = e.target.closest('.tmto-mode');
      if (!btn) return;
      resumeAudio();
      dispatch({ type: 'SET_MODE', mode: btn.getAttribute('data-mode') });
    });
    els.toggle.addEventListener('click', function () {
      resumeAudio();
      dispatch({ type: state.timer.status === 'running' ? 'PAUSE' : 'START' });
    });
    els.reset.addEventListener('click', function () {
      dispatch({ type: 'RESET' });
    });

    els.taskInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') addTaskFromInput();
    });
    root.querySelector('#tmtoAdd').addEventListener('click', addTaskFromInput);

    // task list interactions (delegated)
    els.taskList.addEventListener('click', onTaskListClick);
    els.taskList.addEventListener('change', onTaskListChange);
  }

  function addTaskFromInput() {
    var v = els.taskInput.value;
    if (!v.trim()) return;
    dispatch({ type: 'TASK_ADD', title: v });
    els.taskInput.value = '';
  }

  function orderedTasks() {
    return state.tasks.slice().sort(function (a, b) { return a.order - b.order; });
  }

  function onTaskListClick(e) {
    var li = e.target.closest('li[data-id]');
    if (!li) return;
    var id = li.getAttribute('data-id');
    var idx = Number(li.getAttribute('data-index'));
    var act = e.target.closest('[data-act]');
    if (!act) {
      // clicking the title text opens inline edit
      if (e.target.closest('.tmto-task__title')) startEdit(id);
      return;
    }
    var a = act.getAttribute('data-act');
    if (a === 'focus') {
      setActiveTaskId(activeTaskId === id ? null : id);
    } else if (a === 'up') {
      dispatch({ type: 'TASK_REORDER', from: idx, to: idx - 1 });
    } else if (a === 'down') {
      dispatch({ type: 'TASK_REORDER', from: idx, to: idx + 1 });
    } else if (a === 'delete') {
      if (activeTaskId === id) setActiveTaskId(null);
      dispatch({ type: 'TASK_DELETE', id: id });
    }
  }
  function onTaskListChange(e) {
    var li = e.target.closest('li[data-id]');
    if (!li) return;
    if (e.target.matches('input[type="checkbox"]')) {
      dispatch({ type: 'TASK_TOGGLE', id: li.getAttribute('data-id') });
    }
  }

  function startEdit(id) {
    editingId = id;
    renderTasks();
    var input = els.taskList.querySelector('input.tmto-task__edit');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  function commitEdit(id, value) {
    editingId = null;
    dispatch({ type: 'TASK_UPDATE', id: id, title: value });
    renderTasks();
  }

  // ----------------------------------------------------------- render timer
  var lastCycleSig = '';
  function renderTimer() {
    var timer = state.timer, settings = state.settings;
    var running = timer.status === 'running';

    els.time.textContent = formatMMSS(timer.remainingSeconds);
    els.time.setAttribute('aria-live', running ? 'polite' : 'off');

    els.toggle.textContent = running ? 'Pause' : timer.status === 'paused' ? 'Resume' : 'Start';

    var modeBtns = els.modes.querySelectorAll('.tmto-mode');
    modeBtns.forEach(function (b) {
      var on = b.getAttribute('data-mode') === timer.mode;
      b.classList.toggle('is-active', on);
      b.disabled = running;
    });

    var showCycle = settings.useSequence && timer.mode === 'pomodoro';
    els.cycleWrap.classList.toggle('is-closed', !showCycle);
    if (showCycle) {
      var sig = timer.streakSinceLong + '/' + settings.longBreakInterval;
      if (sig !== lastCycleSig) {
        lastCycleSig = sig;
        var dots = '';
        for (var i = 0; i < settings.longBreakInterval; i++) {
          dots += '<span class="tmto-dot' + (i < timer.streakSinceLong ? ' is-on' : '') + '"></span>';
        }
        var cur = Math.min(timer.streakSinceLong + 1, settings.longBreakInterval);
        els.cycle.innerHTML =
          '<span>Pomodoro ' + cur + ' of ' + settings.longBreakInterval + '</span>' +
          '<span class="tmto-dots">' + dots + '</span>';
      }
    } else {
      lastCycleSig = '';
    }

    els.hint.textContent = timer.mode === 'pomodoro'
      ? 'Stay on task. One pomodoro at a time.'
      : 'Recharge — you earned this break.';
  }

  // ----------------------------------------------------------- render tasks
  function renderTasks() {
    var ordered = orderedTasks();
    if (ordered.length === 0) {
      els.taskList.innerHTML = '<li class="tmto-task tmto-task--empty">No tasks yet. Add one below to stay focused.</li>';
    } else {
      els.taskList.innerHTML = ordered.map(function (t, index) {
        var isActive = activeTaskId === t.id;
        var titleCell = editingId === t.id
          ? '<input class="tmto-task__edit" value="' + escapeHtml(t.title) + '"/>'
          : '<button type="button" class="tmto-task__title' + (t.done ? ' is-done' : '') + '">' + escapeHtml(t.title) + '</button>';
        return '<li class="tmto-task' + (isActive ? ' is-active' : '') + '" data-id="' + t.id + '" data-index="' + index + '">' +
          '<input type="checkbox" class="tmto-task__check"' + (t.done ? ' checked' : '') + ' aria-label="Complete ' + escapeHtml(t.title) + '"/>' +
          '<div class="tmto-task__main">' + titleCell + '</div>' +
          '<div class="tmto-task__actions">' +
            '<button type="button" class="tmto-task__focus" data-act="focus">' + (isActive ? 'Active' : 'Focus') + '</button>' +
            '<button type="button" class="tmto-task__move" data-act="up"' + (index === 0 ? ' disabled' : '') + ' aria-label="Move up">↑</button>' +
            '<button type="button" class="tmto-task__move" data-act="down"' + (index === ordered.length - 1 ? ' disabled' : '') + ' aria-label="Move down">↓</button>' +
            '<button type="button" class="tmto-task__del" data-act="delete">Delete</button>' +
          '</div>' +
        '</li>';
      }).join('');

      var edit = els.taskList.querySelector('input.tmto-task__edit');
      if (edit) {
        var li = edit.closest('li[data-id]');
        var id = li.getAttribute('data-id');
        edit.addEventListener('blur', function () { commitEdit(id, edit.value); });
        edit.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') commitEdit(id, edit.value);
          else if (e.key === 'Escape') { editingId = null; renderTasks(); }
        });
      }
    }
    els.taskNote.textContent = state.settings.taskCheckToBottom
      ? 'Completed tasks sink to the bottom.'
      : 'Order follows your manual sort.';
  }

  // -------------------------------------------------------- render settings
  var SETTINGS_TABS = ['Timers', 'Tasks', 'Sound', 'Theme', 'Notifications', 'Data'];

  function renderSettings() {
    if (!state.settingsOpen) {
      els.modalMount.innerHTML = '';
      return;
    }
    els.modalMount.innerHTML =
      '<div class="tmto-modal" id="tmtoModal" role="dialog" aria-modal="true" aria-label="Settings">' +
        '<div class="tmto-modal__card tmto-modal__card--wide">' +
          '<div class="tmto-modal__head">' +
            '<h2>Settings</h2>' +
            '<button type="button" class="tmto-x" data-close>Close</button>' +
          '</div>' +
          '<div class="tmto-modal__body">' +
            '<nav class="tmto-tabs" id="tmtoTabs">' +
              SETTINGS_TABS.map(function (t) {
                return '<button type="button" class="tmto-tab' + (t === settingsTab ? ' is-active' : '') + '" data-tab="' + t + '">' + t + '</button>';
              }).join('') +
            '</nav>' +
            '<div class="tmto-panel" id="tmtoPanel"></div>' +
          '</div>' +
          '<div class="tmto-modal__foot">' +
            '<button type="button" class="tmto-primary tmto-primary--sm" data-close>Done</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var modal = els.modalMount.querySelector('#tmtoModal');
    modal.addEventListener('click', function (e) {
      if (e.target === modal || e.target.closest('[data-close]')) {
        dispatch({ type: 'SETTINGS_OPEN', open: false });
      }
    });
    modal.querySelector('#tmtoTabs').addEventListener('click', function (e) {
      var b = e.target.closest('.tmto-tab');
      if (!b) return;
      settingsTab = b.getAttribute('data-tab');
      modal.querySelectorAll('.tmto-tab').forEach(function (t) {
        t.classList.toggle('is-active', t === b);
      });
      renderPanel();
    });
    renderPanel();
  }

  function patch(p) { dispatch({ type: 'SETTINGS_PATCH', payload: p }); }

  function fieldNumber(label, key, min, max) {
    return '<label class="tmto-field"><span>' + label + '</span>' +
      '<input type="number" min="' + min + '" max="' + max + '" value="' + state.settings[key] +
      '" data-num="' + key + '" data-min="' + min + '"/></label>';
  }
  function toggleRow(label, key, hint) {
    var on = !!state.settings[key];
    return '<div class="tmto-togglewrap">' +
      '<button type="button" class="tmto-toggle' + (on ? ' is-on' : '') + '" role="switch" aria-checked="' + on + '" data-toggle="' + key + '">' +
        '<span class="tmto-toggle__label">' + label + '</span>' +
        '<span class="tmto-switch"><span class="tmto-switch__knob"></span></span>' +
      '</button>' +
      (hint ? '<p class="tmto-hint tmto-hint--field">' + hint + '</p>' : '') +
    '</div>';
  }

  function renderPanel() {
    var panel = els.modalMount.querySelector('#tmtoPanel');
    if (!panel) return;
    var s = state.settings;
    var html = '';

    if (settingsTab === 'Timers') {
      html =
        '<div class="tmto-grid3">' +
          fieldNumber('Pomodoro (min)', 'pomodoroMinutes', 1, 180) +
          fieldNumber('Short break (min)', 'shortMinutes', 1, 120) +
          fieldNumber('Long break (min)', 'longMinutes', 1, 180) +
        '</div>' +
        fieldNumber('Long break every N pomodoros', 'longBreakInterval', 1, 12) +
        toggleRow('Use Pomodoro sequence', 'useSequence', 'Pomodoro → short break, repeat; long break after every N pomodoros.') +
        toggleRow('Auto-start breaks', 'autoStartBreaks') +
        toggleRow('Auto-start pomodoros after breaks', 'autoStartPomodoros');
    } else if (settingsTab === 'Tasks') {
      html =
        toggleRow('Auto-check active task when a pomodoro completes', 'taskAutoCheck') +
        toggleRow('Move completed tasks to the bottom', 'taskCheckToBottom');
    } else if (settingsTab === 'Sound') {
      html =
        '<label class="tmto-field"><span>Alarm sound</span>' +
          '<select data-select="alarmPreset">' +
            opt('none', 'None', s.alarmPreset) + opt('bell', 'Bell', s.alarmPreset) +
            opt('kitchen', 'Kitchen', s.alarmPreset) + opt('chime', 'Chime', s.alarmPreset) +
          '</select></label>' +
        rangeField('Alarm volume', 'alarmVolume', s.alarmVolume) +
        fieldNumber('Alarm repeat', 'alarmRepeat', 1, 10) +
        '<button type="button" class="tmto-pill tmto-pill--test" id="tmtoTestAlarm">Test alarm</button>' +
        '<hr class="tmto-hr"/>' +
        '<label class="tmto-field"><span>Focus / ambient sound</span>' +
          '<select data-select="focusPreset">' +
            opt('none', 'None', s.focusPreset) + opt('brown', 'Brown noise', s.focusPreset) +
            opt('custom', 'Custom URL', s.focusPreset) +
          '</select></label>' +
        (s.focusPreset === 'custom'
          ? '<label class="tmto-field"><span>Audio URL (loop)</span><input type="url" placeholder="https://" value="' + escapeHtml(s.focusCustomUrl) + '" data-text="focusCustomUrl"/></label>'
          : '') +
        rangeField('Focus volume', 'focusVolume', s.focusVolume);
    } else if (settingsTab === 'Theme') {
      html =
        '<p class="tmto-note">lilTomato follows this site’s light/dark setting. Use the theme switch in the top navigation to change it.</p>' +
        toggleRow('Prefer dark mode while the timer is running', 'darkWhenRunning', 'Temporarily switches the whole site to dark while a session runs, then restores your setting.');
    } else if (settingsTab === 'Notifications') {
      html =
        toggleRow('Browser notification when a session ends', 'browserNotify') +
        fieldNumber('Reminder (minutes before end, 0 = off)', 'reminderMinutes', 0, 60) +
        '<p class="tmto-note">Notifications require permission. This tool runs entirely in your browser — no accounts or servers.</p>';
    } else if (settingsTab === 'Data') {
      html =
        '<p class="tmto-note">Export everything (settings, tasks, stats) as JSON. Import replaces your stored data.</p>' +
        '<div class="tmto-datarow">' +
          '<button type="button" class="tmto-primary tmto-primary--sm" id="tmtoExport">Export JSON</button>' +
          '<label class="tmto-pill tmto-pill--file">Import JSON<input type="file" accept="application/json" id="tmtoImport" hidden/></label>' +
        '</div>';
    }

    panel.innerHTML = html;
    wirePanel(panel);
  }

  function opt(value, label, current) {
    return '<option value="' + value + '"' + (value === current ? ' selected' : '') + '>' + label + '</option>';
  }
  function rangeField(label, key, val) {
    return '<label class="tmto-field"><span>' + label + ' <em class="tmto-rangeval" data-rangeval="' + key + '">' + Math.round(val * 100) + '%</em></span>' +
      '<input type="range" min="0" max="1" step="0.05" value="' + val + '" data-range="' + key + '"/></label>';
  }

  function wirePanel(panel) {
    panel.querySelectorAll('[data-num]').forEach(function (input) {
      input.addEventListener('input', function () {
        var key = input.getAttribute('data-num');
        var min = Number(input.getAttribute('data-min'));
        var n = Number(input.value);
        if (!isFinite(n)) n = min;
        var p = {}; p[key] = Math.max(min, n);
        patch(p);
      });
    });
    panel.querySelectorAll('[data-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-toggle');
        var next = !state.settings[key];
        if (key === 'browserNotify' && next) {
          requestNotificationPermission().then(function () {
            var p = {}; p[key] = next; patch(p);
            btn.classList.toggle('is-on', next);
            btn.setAttribute('aria-checked', String(next));
          });
          return;
        }
        var p = {}; p[key] = next; patch(p);
        btn.classList.toggle('is-on', next);
        btn.setAttribute('aria-checked', String(next));
      });
    });
    panel.querySelectorAll('[data-select]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var key = sel.getAttribute('data-select');
        var p = {}; p[key] = sel.value; patch(p);
        if (key === 'focusPreset') renderPanel();
      });
    });
    panel.querySelectorAll('[data-range]').forEach(function (rng) {
      rng.addEventListener('input', function () {
        var key = rng.getAttribute('data-range');
        var v = Number(rng.value);
        var p = {}; p[key] = v; patch(p);
        var label = panel.querySelector('[data-rangeval="' + key + '"]');
        if (label) label.textContent = Math.round(v * 100) + '%';
      });
    });
    panel.querySelectorAll('[data-text]').forEach(function (input) {
      input.addEventListener('input', function () {
        var key = input.getAttribute('data-text');
        var p = {}; p[key] = input.value; patch(p);
      });
    });

    var testBtn = panel.querySelector('#tmtoTestAlarm');
    if (testBtn) testBtn.addEventListener('click', function () {
      resumeAudio();
      playAlarmPreset(state.settings.alarmPreset, state.settings.alarmVolume, state.settings.alarmRepeat);
    });

    var exportBtn = panel.querySelector('#tmtoExport');
    if (exportBtn) exportBtn.addEventListener('click', function () {
      var json = exportJson(state);
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'liltomato-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
    });
    var importInput = panel.querySelector('#tmtoImport');
    if (importInput) importInput.addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var parsed = importJson(String(reader.result));
        if (!parsed) {
          dispatch({ type: 'TOAST', message: 'Invalid backup file' });
          setTimeout(function () { dispatch({ type: 'TOAST', message: null }); }, 3000);
          return;
        }
        dispatch({
          type: 'IMPORT',
          payload: {
            settings: parsed.settings,
            tasks: parsed.tasks,
            stats: parsed.stats,
            timer: parsed.timer,
            view: 'main',
            settingsOpen: false,
            toast: 'Backup restored',
          },
        });
        setTimeout(function () { dispatch({ type: 'TOAST', message: null }); }, 3000);
      };
      reader.readAsText(file);
      e.target.value = '';
    });
  }

  // ---------------------------------------------------------- render report
  function renderReport() {
    if (state.view !== 'report') {
      els.reportMount.innerHTML = '';
      return;
    }
    var stats = state.stats;
    var t0 = todayStart();
    var w0 = weekStart();
    var todayP = countPomodoros(stats, t0);
    var weekP = countPomodoros(stats, w0);
    var mToday = minutesByType(stats, t0);
    var mWeek = minutesByType(stats, w0);

    function card(title, p, m) {
      var breakMin = m.short_completed + m.long_completed;
      return '<div class="tmto-stat">' +
        '<div class="tmto-stat__label">' + title + '</div>' +
        '<div class="tmto-stat__big">' + p + ' <span>pomodoros</span></div>' +
        '<div class="tmto-stat__sub">~' + m.pomodoro_completed + ' min focus</div>' +
        '<div class="tmto-stat__sub">~' + breakMin + ' min on breaks</div>' +
      '</div>';
    }

    els.reportMount.innerHTML =
      '<div class="tmto-modal" id="tmtoReportModal" role="dialog" aria-modal="true" aria-label="Report">' +
        '<div class="tmto-modal__card">' +
          '<div class="tmto-modal__head">' +
            '<h2>Report</h2>' +
            '<button type="button" class="tmto-x" data-close>Close</button>' +
          '</div>' +
          '<div class="tmto-modal__body tmto-modal__body--pad">' +
            '<div class="tmto-stats">' + card('Today', todayP, mToday) + card('This week', weekP, mWeek) + '</div>' +
            '<p class="tmto-note">Stats are stored locally in your browser. Clearing site data resets history.</p>' +
          '</div>' +
        '</div>' +
      '</div>';

    var modal = els.reportMount.querySelector('#tmtoReportModal');
    modal.addEventListener('click', function (e) {
      if (e.target === modal || e.target.closest('[data-close]')) {
        dispatch({ type: 'VIEW', view: 'main' });
      }
    });
  }

  // ----------------------------------------------------------- render toast
  function renderToast() {
    if (!state.toast) {
      els.toast.hidden = true;
      els.toast.innerHTML = '';
      return;
    }
    els.toast.hidden = false;
    els.toast.innerHTML = escapeHtml(state.toast) +
      '<button type="button" class="tmto-toast__x" aria-label="Dismiss">×</button>';
    els.toast.querySelector('.tmto-toast__x').addEventListener('click', function () {
      dispatch({ type: 'TOAST', message: null });
    });
  }

  // ------------------------------------------------------------- fullscreen
  function getFsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  function requestFs(el) {
    if (el.requestFullscreen) return el.requestFullscreen();
    if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  }
  function exitFs() {
    if (document.exitFullscreen) return document.exitFullscreen();
    if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
  }
  function toggleFullscreen() {
    if (getFsElement() === root) exitFs();
    else { try { requestFs(root); } catch (e) { /* */ } }
  }

  var chromeVisible = true;
  var idleTimer = null;
  function isFullscreen() { return getFsElement() === root; }
  function chromeShouldHide() {
    return isFullscreen() && !chromeVisible && !state.settingsOpen && state.view !== 'report';
  }
  function applyChrome() {
    root.classList.toggle('is-chrome-hidden', chromeShouldHide());
  }
  function scheduleHide() {
    if (idleTimer) clearTimeout(idleTimer);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    idleTimer = setTimeout(function () { chromeVisible = false; applyChrome(); }, IDLE_MS);
  }
  function bumpChrome() {
    chromeVisible = true;
    applyChrome();
    if (isFullscreen()) scheduleHide();
  }
  function onFsChange() {
    var fs = isFullscreen();
    root.classList.toggle('is-fullscreen', fs);
    // Hide the site chrome (Layout header/footer + TaglinePattern) for a truly
    // distraction-free "just the timer" view; CSS keys off this <html> class.
    document.documentElement.classList.toggle('tomato-fullscreen', fs);
    if (fs) {
      chromeVisible = true;
      applyChrome();
      window.addEventListener('mousemove', bumpChrome);
      window.addEventListener('touchstart', bumpChrome, { passive: true });
      bumpChrome();
    } else {
      chromeVisible = true;
      root.classList.remove('is-chrome-hidden');
      window.removeEventListener('mousemove', bumpChrome);
      window.removeEventListener('touchstart', bumpChrome);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }
  }
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // -------------------------------------------------------------- keyboard
  // Track whether the tool is on screen so the Space shortcut only takes over
  // when the user is actually looking at the timer (otherwise Space keeps its
  // normal page-scroll behaviour on this content site page).
  var toolInView = true;
  try {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { toolInView = en.isIntersecting; });
    }, { threshold: 0.25 });
    io.observe(root);
  } catch (e) { /* no IO; default to in-view */ }

  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space') {
      // Let native activation/scroll happen for focused controls and form fields.
      var t = e.target;
      if (t && t.closest && t.closest('input, textarea, select, button, a, [role="switch"]')) return;
      // Only hijack Space while the tool is engaged (fullscreen, focused, or in view).
      var engaged = isFullscreen() || toolInView ||
        (document.activeElement && root.contains(document.activeElement));
      if (!engaged) return;
      e.preventDefault();
      resumeAudio();
      dispatch({ type: state.timer.status === 'running' ? 'PAUSE' : 'START' });
    } else if (e.key === 'Escape') {
      if (state.settingsOpen) dispatch({ type: 'SETTINGS_OPEN', open: false });
      else if (state.view === 'report') dispatch({ type: 'VIEW', view: 'main' });
    }
  });

  // ------------------------------------------------------------------- init
  buildApp();
  renderTimer();
  renderTasks();
  renderSettings();
  renderReport();
  renderToast();
  manageTick();
  updateDocTitle();

  // Resume the audio context on the first user gesture (autoplay policy).
  document.addEventListener('pointerdown', function once() {
    resumeAudio();
    document.removeEventListener('pointerdown', once);
  }, { once: true });
})();
