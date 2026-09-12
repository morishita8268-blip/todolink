/* ToDoリンク — 本体 */
(function () {
  'use strict';

  var VERSION = '1.7.1';
  var KEY = 'todolink.state.v1';
  var GCAL_TAB = '__gcal__';   // Googleカレンダー専用の仮想タブ

  var TODO_COLORS = ['#9aa0aa', '#e2445c', '#f5a524', '#22a06b', '#3f96f3', '#8b5cf6', '#ec4899', '#0d9488'];
  var THEME_COLORS = [
    '#3f96f3', '#2f6df6', '#1e40af', '#0ea5e9', '#0891b2', '#0d9488', '#22a06b', '#65a30d', '#ca8a04', '#f5a524',
    '#ea580c', '#e2445c', '#be123c', '#db2777', '#ec4899', '#a21caf', '#8b5cf6', '#6d28d9', '#4f46e5', '#475569',
    '#111827', '#7c3f00', '#8d6e63', '#5f7161', '#2d6a4f', '#1b4965', '#3a0ca3', '#9d174d', '#7f1d1d', '#0f766e'
  ];
  var WD_LABEL = ['日', '月', '火', '水', '木', '金', '土'];

  /* ---------------- state ---------------- */
  var S = null;
  var searching = false;
  var query = '';

  function uid() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function defaults() {
    var t1 = uid(), t2 = uid();
    return {
      v: 1,
      tabs: [{ id: t1, name: 'やること' }, { id: t2, name: 'スケジュール' }],
      todos: [],
      activeTabId: t1,
      settings: {
        theme: '#3f96f3', dark: 'auto', font: 3, lines: 2,
        showTabCount: true, appBadge: false, showMeta: true,
        autoReset: false, resetTime: '04:00', lastResetOn: '',
        notify: false,
        gcal: {
          clientId: '', calendarId: '', calendarName: '', account: '',
          auto: true, deleteOnDone: false, importDays: 0, lastSync: '',
          viewDays: 14
        }
      },
      calCache: { events: [], at: 0 }
    };
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      var s = JSON.parse(raw);
      var d = defaults();
      s.settings = Object.assign({}, d.settings, s.settings || {});
      s.settings.gcal = Object.assign({}, d.settings.gcal, s.settings.gcal || {});
      // パスコード機能は廃止。古い端末に残っている設定は読み込み時点で捨てる。
      if (s.settings.passHash) { delete s.settings.passHash; }
      if (!Array.isArray(s.tabs) || !s.tabs.length) { s.tabs = d.tabs; s.activeTabId = d.activeTabId; }
      if (!Array.isArray(s.todos)) s.todos = [];
      if (!s.calCache || !Array.isArray(s.calCache.events)) s.calCache = { events: [], at: 0 };
      return s;
    } catch (e) { return defaults(); }
  }
  var saveTimer = null;
  function save(now) {
    clearTimeout(saveTimer);
    var go = function () { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('保存できませんでした（容量不足？）'); } };
    if (now) go(); else saveTimer = setTimeout(go, 120);
  }

  /* ---------------- helpers ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return ymd(new Date()); }
  function parseYmd(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2400);
  }

  function tabsById(id) { return S.tabs.filter(function (t) { return t.id === id; })[0]; }
  function isCalTab() { return S.activeTabId === GCAL_TAB; }
  /** カレンダータブのときは「実在するタブ」を返す（追加先などに使う） */
  function activeTab() {
    if (isCalTab()) return tabsById(S.lastRealTabId) || S.tabs[0];
    return tabsById(S.activeTabId) || S.tabs[0];
  }
  function todosOf(tabId) { return S.todos.filter(function (t) { return t.tabId === tabId; }); }
  function openCount(tabId) { return todosOf(tabId).filter(function (t) { return !t.done; }).length; }

  /* 繰り返しを考慮した「次の日時」 */
  function nextDue(t) {
    if (!t.dueDate) return null;
    var rep = t.repeat && t.repeat.type ? t.repeat.type : 'none';
    if (rep === 'none') return t.dueDate;
    var base = new Date(); base.setHours(0, 0, 0, 0);
    var anchor = parseYmd(t.dueDate);
    if (anchor > base) return t.dueDate;
    if (rep === 'daily') {
      if (t.dueTime && new Date() > new Date(base.getTime() + toMin(t.dueTime) * 60000)) {
        return ymd(new Date(base.getTime() + 86400000));
      }
      return ymd(base);
    }
    if (rep === 'weekly') {
      var days = (t.repeat.weekdays && t.repeat.weekdays.length) ? t.repeat.weekdays : [anchor.getDay()];
      for (var i = 0; i < 8; i++) {
        var d = new Date(base.getTime() + i * 86400000);
        if (days.indexOf(d.getDay()) >= 0) {
          if (i === 0 && t.dueTime && new Date() > new Date(base.getTime() + toMin(t.dueTime) * 60000)) continue;
          return ymd(d);
        }
      }
      return ymd(base);
    }
    if (rep === 'monthly') {
      var md = t.repeat.monthday || anchor.getDate();
      var y = base.getFullYear(), m = base.getMonth();
      for (var k = 0; k < 3; k++) {
        var last = new Date(y, m + k + 1, 0).getDate();
        var d2 = new Date(y, m + k, Math.min(md, last));
        if (d2 >= base) {
          if (ymd(d2) === ymd(base) && t.dueTime && new Date() > new Date(base.getTime() + toMin(t.dueTime) * 60000)) continue;
          return ymd(d2);
        }
      }
      return ymd(base);
    }
    return t.dueDate;
  }
  function toMin(hhmm) { var p = (hhmm || '00:00').split(':').map(Number); return p[0] * 60 + p[1]; }

  function repeatLabel(rep) {
    if (!rep || rep.type === 'none') return '';
    if (rep.type === 'daily') return '毎日';
    if (rep.type === 'weekly') return '毎週' + (rep.weekdays || []).map(function (i) { return WD_LABEL[i]; }).join('・');
    if (rep.type === 'monthly') return '毎月' + (rep.monthday || 1) + '日';
    return '';
  }
  function dueLabel(t) {
    var d = nextDue(t);
    if (!d) return '';
    var day = parseYmd(d), now = parseYmd(today());
    var diff = Math.round((day - now) / 86400000);
    var head;
    if (diff === 0) head = '今日';
    else if (diff === 1) head = '明日';
    else if (diff === -1) head = '昨日';
    else if (diff < 0) head = Math.abs(diff) + '日前';
    else head = (day.getMonth() + 1) + '/' + day.getDate() + '(' + WD_LABEL[day.getDay()] + ')';
    return head + (t.dueTime ? ' ' + t.dueTime : '');
  }
  function dueClass(t) {
    var d = nextDue(t); if (!d) return '';
    var diff = Math.round((parseYmd(d) - parseYmd(today())) / 86400000);
    if (diff < 0) return 'over';
    if (diff === 0) {
      if (t.dueTime && new Date() > new Date(parseYmd(d).getTime() + toMin(t.dueTime) * 60000)) return 'over';
      return 'today';
    }
    return '';
  }

  /* ---------------- 見た目 ---------------- */
  /* スマホのキーボードが出ている分を差し引いた「実際に見えている領域」をCSSに渡す。
     これがないと、下から出るシートがキーボードの裏に隠れて入力できない。 */
  function fitViewport() {
    var vv = window.visualViewport;
    var root = document.documentElement;
    root.style.setProperty('--vvh', (vv ? vv.height : window.innerHeight) + 'px');
    root.style.setProperty('--vvtop', (vv ? vv.offsetTop : 0) + 'px');
  }
  function watchViewport() {
    fitViewport();
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fitViewport);
      window.visualViewport.addEventListener('scroll', fitViewport);
    }
    window.addEventListener('resize', fitViewport);
    window.addEventListener('orientationchange', function () { setTimeout(fitViewport, 250); });
  }

  function applyLook() {
    var st = S.settings;
    var root = document.documentElement;
    root.style.setProperty('--accent', st.theme);
    root.style.setProperty('--fs', ({ 1: '13px', 2: '14.5px', 3: '16px', 4: '18px', 5: '20px' })[st.font] || '16px');
    root.style.setProperty('--lines', String(st.lines || 2));
    var dark = st.dark === 'dark' || (st.dark === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.setAttribute('data-dark', dark ? 'true' : 'false');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#181b22' : '#ffffff');
  }

  /* ---------------- 描画 ---------------- */
  function renderTabs() {
    var bar = $('tabbar');
    bar.innerHTML = '';
    S.tabs.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'tab' + (t.id === S.activeTabId && !searching ? ' active' : '');
      b.type = 'button';
      var n = openCount(t.id);
      b.innerHTML = esc(t.name) + (S.settings.showTabCount ? '<span class="n">' + n + '</span>' : '');
      b.onclick = function () {
        if (searching) closeSearch();
        S.activeTabId = t.id; S.lastRealTabId = t.id;
        save(); renderTabs(); renderList();
        document.querySelector('.main').scrollTop = 0;
      };
      bar.appendChild(b);
    });

    // Googleカレンダー専用タブ（枠線だけで他と区別）
    var cal = document.createElement('button');
    cal.type = 'button';
    cal.className = 'tab cal' + (isCalTab() && !searching ? ' active' : '');
    cal.innerHTML = '📅 カレンダー' +
      (S.settings.showTabCount && S.calCache.events.length ? '<span class="n">' + S.calCache.events.length + '</span>' : '');
    cal.onclick = function () {
      if (searching) closeSearch();
      S.activeTabId = GCAL_TAB;
      save(); renderTabs(); renderList();
      document.querySelector('.main').scrollTop = 0;
      loadCalView(false);
    };
    bar.appendChild(cal);

    var add = document.createElement('button');
    add.className = 'tab-add'; add.type = 'button'; add.textContent = '＋';
    add.onclick = function () { addTab(); };
    bar.appendChild(add);
  }

  function visibleTodos() {
    if (searching && query) {
      var q = query.toLowerCase();
      return S.todos.filter(function (t) {
        return (t.text + ' ' + (t.note || '')).toLowerCase().indexOf(q) >= 0;
      }).sort(function (a, b) { return (a.done - b.done) || (a.order || 0) - (b.order || 0); });
    }
    var tab = activeTab();
    return todosOf(tab.id).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  }

  /* ---------------- Googleカレンダー ビュー ---------------- */
  function renderCalList() {
    $('calBar').hidden = false;
    var g = S.settings.gcal;
    $('calAccount').textContent = g.account ? g.account + ' の予定' : 'Googleカレンダーの予定';
    $('calRange').value = String(g.viewDays || 14);

    var evs = S.calCache.events || [];
    var when = S.calCache.at ? new Date(S.calCache.at).toTimeString().slice(0, 5) + ' 更新' : '未取得';
    $('calMeta').textContent = GCal.isConnected()
      ? evs.length + '件 ・ ' + when
      : '未接続 — 設定 → Googleカレンダー連携 でつないでください';

    var list = $('todoList');
    list.innerHTML = '';

    if (!evs.length) {
      $('emptyState').hidden = false;
      $('emptyText').textContent = GCal.isConnected()
        ? 'この期間に予定はありません'
        : 'Googleカレンダーにつなぐと、ここに予定が並びます';
      return;
    }
    $('emptyState').hidden = true;

    var now = new Date();
    var lastDay = '';
    evs.forEach(function (e) {
      if (e.date !== lastDay) {
        lastDay = e.date;
        var d = parseYmd(e.date);
        var head = document.createElement('li');
        var isToday = e.date === today();
        head.className = 'ev-day' + (isToday ? ' is-today' : '');
        head.innerHTML = (d.getMonth() + 1) + '月' + d.getDate() + '日'
          + '<span class="wd">' + WD_LABEL[d.getDay()] + (isToday ? '・今日' : '') + '</span>';
        list.appendChild(head);
      }
      var li = document.createElement('li');
      var ended = e.time
        ? new Date(parseYmd(e.date).getTime() + toMin(e.endTime || e.time) * 60000) < now
        : parseYmd(e.date) < parseYmd(today());
      li.className = 'ev' + (ended ? ' past' : '');
      li.style.setProperty('--c', e.color || '#3f96f3');
      var timeTxt = e.allDay ? '終日' : (e.time + (e.endTime ? '〜' + e.endTime : '〜'));
      li.innerHTML =
        '<span class="dot"></span>' +
        '<div class="ebody">' +
        '<div class="etime">' + esc(timeTxt) + (e.fromTodolink ? '<span class="mine">ToDo発</span>' : '') + '</div>' +
        '<div class="etitle">' + esc(e.title) + '</div>' +
        '<div class="ecal">' + esc(e.calendarName || '') + (e.location ? ' ・ ' + esc(e.location) : '') + '</div>' +
        '</div>';
      li.onclick = function () { openEvent(e); };
      list.appendChild(li);
    });
  }

  var viewingEvent = null;
  function openEvent(e) {
    viewingEvent = e;
    $('evTitle').textContent = e.title;
    var d = parseYmd(e.date);
    $('evWhen').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日(' + WD_LABEL[d.getDay()] + ') '
      + (e.allDay ? '終日' : e.time + (e.endTime ? '〜' + e.endTime : ''))
      + '\n' + (e.calendarName || '');
    $('evWhere').textContent = e.location || '';
    $('evWhere').hidden = !e.location;
    $('evOpen').disabled = !e.htmlLink;
    openSheet('evSheet');
  }

  function loadCalView(force) {
    var g = S.settings.gcal;
    if (!GCal.isConnected()) { if (isCalTab()) renderCalList(); return Promise.resolve(); }
    var fresh = S.calCache.at && (Date.now() - S.calCache.at < 120000);
    if (fresh && !force) { if (isCalTab()) renderCalList(); return Promise.resolve(); }

    var btn = $('calRefresh');
    btn.classList.add('spin');
    return GCal.listCalendars(true).then(function (cals) {
      var use = cals.filter(function (c) { return c.selected; });
      return GCal.listUpcomingMulti(use.length ? use : cals, Number(g.viewDays) || 14);
    }).then(function (evs) {
      S.calCache = { events: evs, at: Date.now() };
      save(true);
      renderTabs();
      if (isCalTab()) renderCalList();
    }).catch(function (e) {
      syncErrors++;
      glog('カレンダー取得失敗: ' + e.message);
      if (syncIsManual) toast('カレンダーを取得できません：' + e.message);
    }).then(function () {
      btn.classList.remove('spin');
    });
  }

  function renderList() {
    if (isCalTab() && !searching) { renderCalList(); return; }
    $('calBar').hidden = true;

    var tab = activeTab();
    if (tab && !searching) S.activeTabId = tab.id;

    var list = $('todoList');
    list.innerHTML = '';
    var items = visibleTodos();

    $('emptyState').hidden = items.length > 0;
    $('emptyText').textContent = searching
      ? (query ? '見つかりませんでした' : '調べたい言葉を入力してください')
      : '右下の ＋ から追加してください';

    items.forEach(function (t) {
      var li = document.createElement('li');
      li.className = 'todo' + (t.done ? ' done' : '');
      li.dataset.id = t.id;
      li.dataset.lines = String(S.settings.lines);
      li.style.setProperty('--c', t.done ? TODO_COLORS[t.color || 0] : TODO_COLORS[t.color || 0]);

      var meta = [];
      if (S.settings.showMeta) {
        var dl = dueLabel(t);
        if (dl) meta.push('<span class="' + dueClass(t) + '">' + esc(dl) + '</span>');
        var rl = repeatLabel(t.repeat);
        if (rl) meta.push('<span>' + esc(rl) + '</span>');
        if (t.note) meta.push('<span>📝</span>');
      }
      var tabChip = '';
      if (searching && query) {
        var tb = tabsById(t.tabId);
        if (tb) tabChip = '<span class="tabname">' + esc(tb.name) + '</span>';
      }

      li.innerHTML =
        '<button class="box" type="button" aria-label="完了"></button>' +
        '<div class="body"><div class="txt">' + esc(t.text) + '</div>' +
        (meta.length ? '<div class="meta">' + meta.join('') + '</div>' : '') + '</div>' +
        tabChip +
        calBtnHtml(t);

      li.querySelector('.box').onclick = function (e) { e.stopPropagation(); toggle(t.id); };
      li.querySelector('.body').onclick = function () { if (!justDragged) openEdit(t.id); };
      li.querySelector('.calbtn').onclick = function (e) { e.stopPropagation(); onCalBtn(t.id); };
      if (!searching) attachDrag(li);
      list.appendChild(li);
    });

    updateBadge();
  }

  /* ---------------- 行ごとのカレンダーボタン ---------------- */
  var CAL_FRAME = '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>';
  function calBtnHtml(t) {
    var on = !!t.gcalEventId;
    var mark = on ? '<path d="M8.8 15.4l2 2 4.4-4.4"/>' : '<path d="M12 13v5M9.5 15.5h5"/>';
    return '<button class="calbtn' + (on ? ' on' : '') + '" type="button" ' +
      'aria-label="' + (on ? 'カレンダーから外す' : 'カレンダーに入れる') + '" ' +
      'title="' + (on ? 'カレンダーに登録済み' : 'カレンダーに入れる') + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + CAL_FRAME + mark + '</svg></button>';
  }

  /** ボタンを押したとき。日時が無ければ先に聞く。 */
  function onCalBtn(id) {
    var t = S.todos.filter(function (x) { return x.id === id; })[0];
    if (!t) return;

    if (!GCal.hasClientId() || !GCal.isConnected()) {
      toast('先にGoogleカレンダーにつないでください');
      fillSettings(); openSheet('settingsSheet');
      return;
    }
    if (!S.settings.gcal.calendarId) { toast('同期先カレンダーを選んでください'); fillSettings(); openSheet('settingsSheet'); return; }

    // すでに入っている → 外す
    if (t.gcalEventId) {
      confirmBox('カレンダーから外す', '「' + t.text + '」の予定を削除します。ToDoは残ります。', '外す')
        .then(function (ok) {
          if (!ok) return;
          GCal.remove(S.settings.gcal.calendarId, t.gcalEventId).then(function () {
            t.gcalEventId = ''; save(); renderList(); toast('カレンダーから外しました');
          }).catch(function (e) { toast('外せませんでした：' + e.message); });
        });
      return;
    }

    // 日時が無いと予定にできないので、その場で聞く
    if (!t.dueDate) {
      editing = JSON.parse(JSON.stringify(t));
      openDue('row', editing);
      return;
    }
    pushOne(t);
  }

  function updateBadge() {
    if (!('setAppBadge' in navigator)) return;
    try {
      var n = S.todos.filter(function (t) { return !t.done; }).length;
      if (S.settings.appBadge && n) navigator.setAppBadge(n); else navigator.clearAppBadge();
    } catch (e) {}
  }

  /* ---------------- ToDo操作 ---------------- */
  function addTodo(text) {
    var tab = activeTab();
    var orders = todosOf(tab.id).map(function (t) { return t.order || 0; });
    var max = orders.length ? Math.max.apply(null, orders) : 0;
    var t = {
      id: uid(), tabId: tab.id, text: text, note: '', done: false,
      color: composeColor, order: max + 1,
      dueDate: pendingDue.dueDate || '', dueTime: pendingDue.dueTime || '',
      repeat: pendingDue.repeat ? JSON.parse(JSON.stringify(pendingDue.repeat)) : { type: 'none' },
      gcalEventId: '', createdAt: Date.now()
    };
    S.todos.push(t);
    clearPendingDue();
    save(); renderTabs(); renderList();
    if (t.dueDate && S.settings.gcal.auto && GCal.isConnected() && S.settings.gcal.calendarId) pushOne(t);
  }

  function toggle(id) {
    var t = S.todos.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var repeating = t.repeat && t.repeat.type && t.repeat.type !== 'none';
    if (!t.done && repeating) {
      t.lastDoneOn = today();
      toast('「' + t.text.slice(0, 14) + '」完了。次回に持ち越しました');
      save(); renderTabs(); renderList();
      return;
    }
    t.done = !t.done;
    t.doneAt = t.done ? Date.now() : 0;
    save(); renderTabs(); renderList();
    if (t.done && t.gcalEventId && S.settings.gcal.deleteOnDone && GCal.isConnected()) {
      GCal.remove(S.settings.gcal.calendarId, t.gcalEventId).then(function () {
        t.gcalEventId = ''; save(); renderList();
      }).catch(function () {});
    } else if (t.gcalEventId && GCal.isConnected() && S.settings.gcal.auto) {
      pushOne(t, true);
    }
  }

  function removeTodo(id) {
    var t = S.todos.filter(function (x) { return x.id === id; })[0];
    if (t && t.gcalEventId && GCal.isConnected() && S.settings.gcal.calendarId) {
      GCal.remove(S.settings.gcal.calendarId, t.gcalEventId).catch(function () {});
    }
    S.todos = S.todos.filter(function (x) { return x.id !== id; });
    save(); renderTabs(); renderList();
  }

  function clearDone() {
    if (isCalTab()) { toast('カレンダータブでは使えません'); return; }
    var tab = activeTab();
    var gone = todosOf(tab.id).filter(function (t) { return t.done; });
    if (!gone.length) { toast('完了したToDoはありません'); return; }
    confirmBox('完了を削除', '「' + tab.name + '」の完了した ' + gone.length + ' 件を削除します。', '削除する').then(function (ok) {
      if (!ok) return;
      gone.forEach(function (t) {
        if (t.gcalEventId && GCal.isConnected() && S.settings.gcal.calendarId) {
          GCal.remove(S.settings.gcal.calendarId, t.gcalEventId).catch(function () {});
        }
      });
      S.todos = S.todos.filter(function (t) { return !(t.tabId === tab.id && t.done); });
      save(); renderTabs(); renderList();
      toast(gone.length + ' 件削除しました');
    });
  }

  /* ---------------- 並べ替え（長押しドラッグ） ---------------- */
  var dragEl = null, justDragged = false;
  function attachDrag(li) {
    var timer = null, startY = 0, active = false, pid = null;

    li.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.box')) return;
      pid = e.pointerId;
      startY = e.clientY;
      timer = setTimeout(function () {
        active = true;
        dragEl = li;
        li.classList.add('dragging');
        try { li.setPointerCapture(pid); } catch (err) {}
        if (navigator.vibrate) navigator.vibrate(12);
      }, 320);
    });

    li.addEventListener('pointermove', function (e) {
      if (!active) {
        if (timer && Math.abs(e.clientY - startY) > 8) { clearTimeout(timer); timer = null; }
        return;
      }
      e.preventDefault();
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || !el.closest) return;
      var over = el.closest('.todo');
      if (!over || over === dragEl || over.parentNode !== dragEl.parentNode) return;
      var r = over.getBoundingClientRect();
      over.parentNode.insertBefore(dragEl, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
    });

    var end = function () {
      clearTimeout(timer); timer = null;
      if (!active) return;
      active = false;
      li.classList.remove('dragging');
      commitOrder();
      dragEl = null;
      justDragged = true;
      setTimeout(function () { justDragged = false; }, 60);
    };
    li.addEventListener('pointerup', end);
    li.addEventListener('pointercancel', end);
    li.addEventListener('pointerleave', function () { clearTimeout(timer); timer = null; });
  }
  function commitOrder() {
    Array.prototype.forEach.call($('todoList').children, function (li, i) {
      var t = S.todos.filter(function (x) { return x.id === li.dataset.id; })[0];
      if (t) t.order = i;
    });
    save();
  }

  /* ---------------- 検索 ---------------- */
  function openSearch() {
    searching = true; query = '';
    $('searchRow').hidden = false;
    $('searchInput').value = '';
    setTimeout(function () { $('searchInput').focus(); }, 60);
    renderTabs(); renderList();
  }
  function closeSearch() {
    searching = false; query = '';
    $('searchRow').hidden = true;
    renderTabs(); renderList();
  }

  /* ---------------- タブ ---------------- */
  function addTab() {
    return ask({
      title: 'タブを追加', input: true, value: '',
      placeholder: '例：やること、スケジュール、買い物', okText: '追加'
    }).then(function (name) {
      if (name === null) return null;
      var t = { id: uid(), name: String(name).trim() || '新しいタブ' };
      S.tabs.push(t);
      S.activeTabId = t.id;
      if (searching) closeSearch();
      save(); renderTabs(); renderList();
      return t;
    });
  }
  function renderTabEditor() {
    var ul = $('tabEditList');
    ul.innerHTML = '';
    S.tabs.forEach(function (t, i) {
      var li = document.createElement('li');
      li.innerHTML =
        '<button class="mini up" type="button" title="上へ">▲</button>' +
        '<button class="mini down" type="button" title="下へ">▼</button>' +
        '<input type="text" value="' + esc(t.name) + '" maxlength="30">' +
        '<span class="mini">' + openCount(t.id) + '</span>' +
        '<button class="mini del" type="button" title="削除">✕</button>';
      li.querySelector('input').oninput = function (e) { t.name = e.target.value; save(); renderTabs(); };
      li.querySelector('.up').onclick = function () { if (i > 0) { S.tabs.splice(i - 1, 0, S.tabs.splice(i, 1)[0]); save(); renderTabEditor(); renderTabs(); } };
      li.querySelector('.down').onclick = function () { if (i < S.tabs.length - 1) { S.tabs.splice(i + 1, 0, S.tabs.splice(i, 1)[0]); save(); renderTabEditor(); renderTabs(); } };
      li.querySelector('.del').onclick = function () {
        if (S.tabs.length <= 1) { toast('タブは1つ以上必要です'); return; }
        var n = todosOf(t.id).length;
        confirmBox('タブを削除', '「' + t.name + '」を削除します。' + (n ? '中の ' + n + ' 件のToDoも一緒に消えます。' : ''), '削除する').then(function (ok) {
          if (!ok) return;
          S.todos = S.todos.filter(function (x) { return x.tabId !== t.id; });
          S.tabs = S.tabs.filter(function (x) { return x.id !== t.id; });
          if (S.activeTabId === t.id) S.activeTabId = S.tabs[0].id;
          save(); renderTabEditor(); renderTabs(); renderList();
        });
      };
      ul.appendChild(li);
    });
  }

  /* ---------------- 入力・確認ダイアログ ---------------- */
  /* 埋め込み表示やインストール済みPWAでは prompt()/confirm() が効かないので自前で持つ */
  var askResolve = null;
  function ask(opt) {
    return new Promise(function (res) {
      closeAsk(null);
      $('askTitle').textContent = opt.title || '';
      var m = $('askMsg');
      m.textContent = opt.message || '';
      m.hidden = !opt.message;
      var i = $('askInput');
      i.hidden = !opt.input;
      i.type = opt.password ? 'password' : 'text';
      i.inputMode = opt.numeric ? 'numeric' : 'text';
      i.value = opt.value || '';
      i.placeholder = opt.placeholder || '';
      $('askError').textContent = opt.error || '';
      var ok = $('askOk');
      ok.textContent = opt.okText || 'OK';
      ok.className = 'btn ' + (opt.danger ? 'danger' : 'primary');
      openSheet('askSheet');
      if (opt.input) {
        setTimeout(function () {
          fitViewport();
          try { i.focus(); i.select(); } catch (e) {}
          if (i.scrollIntoView) i.scrollIntoView({ block: 'center' });
        }, 60);
      }
      askResolve = res;
    });
  }
  function closeAsk(v) {
    if (!askResolve) return;
    var r = askResolve;
    askResolve = null;
    closeSheet('askSheet');
    r(v);
  }
  function confirmBox(title, message, okText, danger) {
    return ask({ title: title, message: message, okText: okText || 'OK', danger: danger !== false })
      .then(function (v) { return v === true; });
  }

  /* ---------------- シート ---------------- */
  function openSheet(id) { $(id).hidden = false; fitViewport(); }
  function closeSheet(id) { $(id).hidden = true; }
  function wireSheetDismiss() {
    ['addSheet', 'menuSheet', 'colorSheet', 'dueSheet', 'editSheet', 'tabSheet', 'settingsSheet', 'evSheet'].forEach(function (id) {
      var el = $(id);
      el.addEventListener('click', function (e) { if (e.target === el) closeSheet(id); });
    });
    $('askSheet').addEventListener('click', function (e) { if (e.target === $('askSheet')) closeAsk(null); });
    $('askOk').onclick = function () { closeAsk($('askInput').hidden ? true : $('askInput').value); };
    $('askCancel').onclick = function () { closeAsk(null); };
    $('askInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); closeAsk($('askInput').value); }
    });
    Array.prototype.forEach.call(document.querySelectorAll('.sheet-close'), function (b) {
      b.onclick = function () { closeSheet(b.closest('.sheet').id); };
    });
  }

  /* 色 */
  var composeColor = 0;
  function buildColorGrid(el, get, set) {
    el.innerHTML = '';
    TODO_COLORS.forEach(function (c, i) {
      var b = document.createElement('button');
      b.type = 'button'; b.style.background = c;
      if (get() === i) b.className = 'on';
      b.onclick = function () { set(i); buildColorGrid(el, get, set); };
      el.appendChild(b);
    });
  }

  /* 日時シート */
  var dueTarget = 'compose';
  var pendingDue = { dueDate: '', dueTime: '', repeat: { type: 'none' } };
  var dueWeekdays = [];
  function clearPendingDue() {
    pendingDue = { dueDate: '', dueTime: '', repeat: { type: 'none' } };
    showDuePreview();
  }
  function showDuePreview() {
    var btn = $('btnDue'), label = $('btnDueLabel'), x = $('btnDueClear');
    if (!pendingDue.dueDate) {
      label.textContent = '日時を入れる';
      btn.classList.remove('set');
      x.hidden = true;
    } else {
      label.textContent = dueLabel(pendingDue) + (repeatLabel(pendingDue.repeat) ? ' ' + repeatLabel(pendingDue.repeat) : '');
      btn.classList.add('set');
      x.hidden = false;
    }
    updateGcalHint();
  }
  /** 「カレンダーに入るのか」を追加画面で常に見せる */
  function updateGcalHint() {
    var el = $('gcalHint');
    var g = S.settings.gcal;
    if (!pendingDue.dueDate) {
      el.textContent = '日時を入れるとGoogleカレンダーにも登録できます';
      el.className = 'composer-hint';
      return;
    }
    if (GCal.isConnected() && g.calendarId && g.auto) {
      el.textContent = '📅 ' + (g.calendarName || 'カレンダー') + 'に追加されます';
      el.className = 'composer-hint on';
    } else if (GCal.isConnected() && g.calendarId) {
      el.textContent = '📅 自動追加はオフです（ToDoの編集画面から個別に送れます）';
      el.className = 'composer-hint';
    } else {
      el.textContent = '📅 未接続です（設定 → Googleカレンダー連携）';
      el.className = 'composer-hint';
    }
  }
  function renderWeekdays() {
    var row = $('weekdayRow');
    row.innerHTML = '';
    WD_LABEL.forEach(function (w, i) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = w;
      if (dueWeekdays.indexOf(i) >= 0) b.className = 'on';
      b.onclick = function () {
        var k = dueWeekdays.indexOf(i);
        if (k >= 0) dueWeekdays.splice(k, 1); else dueWeekdays.push(i);
        renderWeekdays();
      };
      row.appendChild(b);
    });
  }
  function syncRepeatRows() {
    var v = $('dueRepeat').value;
    $('weekdayRow').hidden = v !== 'weekly';
    $('monthdayRow').hidden = v !== 'monthly';
  }
  function syncQuickRows() {
    var d = $('dueDate').value, t = $('dueTime').value;
    Array.prototype.forEach.call(document.querySelectorAll('.quick[data-day]'), function (b) {
      var want = ymd(new Date(Date.now() + Number(b.dataset.day) * 86400000));
      b.classList.toggle('on', !!d && d === want);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.quick[data-time]'), function (b) {
      b.classList.toggle('on', !!t && t === b.dataset.time);
    });
  }
  function syncDueNote() {
    var el = $('dueGcalNote');
    var g = S.settings.gcal;
    if (dueTarget === 'row') {
      el.textContent = 'カレンダーに入れるには日時が必要です。決めると「' + (g.calendarName || 'カレンダー') + '」に登録します。';
      el.className = 'due-note on';
      return;
    }
    if (GCal.isConnected() && g.calendarId && g.auto) {
      el.textContent = '決定すると「' + (g.calendarName || 'カレンダー') + '」に予定として追加され、その時刻に通知が鳴ります。';
      el.className = 'due-note on';
    } else if (GCal.isConnected() && g.calendarId) {
      el.textContent = '自動追加はオフです。ToDoの編集画面から個別にカレンダーへ送れます。';
      el.className = 'due-note';
    } else {
      el.textContent = '設定 → Googleカレンダー連携 をつなぐと、ここで入れた日時がそのままカレンダーの予定になります。';
      el.className = 'due-note';
    }
  }
  function openDue(target, src) {
    dueTarget = target;
    $('dueDate').value = src.dueDate || '';
    $('dueTime').value = src.dueTime || '';
    var rep = src.repeat || { type: 'none' };
    $('dueRepeat').value = rep.type || 'none';
    dueWeekdays = (rep.weekdays || []).slice();
    $('dueMonthday').value = rep.monthday || (src.dueDate ? parseYmd(src.dueDate).getDate() : 1);
    renderWeekdays(); syncRepeatRows(); syncQuickRows(); syncDueNote();
    openSheet('dueSheet');
  }
  function readDue() {
    var d = $('dueDate').value;
    var type = $('dueRepeat').value;
    var rep = { type: type };
    if (type === 'weekly') rep.weekdays = dueWeekdays.slice().sort();
    if (type === 'monthly') rep.monthday = Number($('dueMonthday').value) || 1;
    if (!d && type !== 'none') d = today();
    return { dueDate: d, dueTime: d ? $('dueTime').value : '', repeat: rep };
  }

  /* 追加シート */
  function openAdd() {
    if (searching) closeSearch();
    if (isCalTab()) {
      // カレンダータブは読み取り専用なので、直前のタブに戻してから追加させる
      S.activeTabId = S.lastRealTabId || S.tabs[0].id;
      save(); renderTabs(); renderList();
    }
    $('addInput').value = '';
    clearPendingDue();
    $('colorSwatch').style.background = TODO_COLORS[composeColor];
    openSheet('addSheet');
    setTimeout(function () { $('addInput').focus(); }, 80);
  }
  function submitAdd() {
    var v = $('addInput').value.trim();
    if (!v) { toast('内容を入力してください'); return; }
    addTodo(v);
    closeSheet('addSheet');
  }

  /* 編集シート */
  var editing = null;
  function openEdit(id) {
    var t = S.todos.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    editing = JSON.parse(JSON.stringify(t));
    $('editText').value = t.text;
    $('editNote').value = t.note || '';
    buildColorGrid($('editColors'), function () { return editing.color || 0; }, function (i) { editing.color = i; });
    var sel = $('editTab');
    sel.innerHTML = '';
    S.tabs.forEach(function (tb) {
      var o = document.createElement('option');
      o.value = tb.id; o.textContent = tb.name;
      if (tb.id === t.tabId) o.selected = true;
      sel.appendChild(o);
    });
    $('editGcal').checked = !!t.gcalEventId || (!!t.dueDate && S.settings.gcal.auto);
    refreshEditDueBtn();
    openSheet('editSheet');
  }
  function refreshEditDueBtn() {
    var b = $('editDueBtn');
    if (!editing.dueDate) { b.textContent = '日時なし'; return; }
    b.textContent = dueLabel(editing) + (repeatLabel(editing.repeat) ? ' / ' + repeatLabel(editing.repeat) : '');
  }
  function saveEdit() {
    var t = S.todos.filter(function (x) { return x.id === editing.id; })[0];
    if (!t) { closeSheet('editSheet'); return; }
    var hadEvent = !!t.gcalEventId;
    t.text = $('editText').value.trim() || t.text;
    t.note = $('editNote').value.trim();
    t.color = editing.color || 0;
    t.tabId = $('editTab').value;
    t.dueDate = editing.dueDate || '';
    t.dueTime = editing.dueTime || '';
    t.repeat = editing.repeat || { type: 'none' };
    save(); renderTabs(); renderList();
    closeSheet('editSheet');

    var want = $('editGcal').checked && !!t.dueDate;
    if (GCal.isConnected() && S.settings.gcal.calendarId) {
      if (want) pushOne(t);
      else if (hadEvent) {
        GCal.remove(S.settings.gcal.calendarId, t.gcalEventId).then(function () { t.gcalEventId = ''; save(); renderList(); }).catch(function () {});
      }
    }
  }

  /* ---------------- Googleカレンダー ---------------- */
  function glog(msg) {
    var el = $('gcalLog');
    var line = new Date().toTimeString().slice(0, 5) + '  ' + msg;
    el.textContent = (line + '\n' + el.textContent).slice(0, 2000);
  }
  function gstatus() {
    var el = $('gcalStatus');
    var g = S.settings.gcal;
    if (!g.clientId) { el.textContent = '未設定：クライアントIDを登録してください'; el.className = 'gcal-status'; }
    else if (GCal.isConnected()) {
      el.textContent = '接続中' + (g.calendarName ? '（' + g.calendarName + '）' : '') + (g.lastSync ? ' / 最終同期 ' + g.lastSync : '');
      el.className = 'gcal-status ok';
    } else {
      el.textContent = '未接続';
      el.className = 'gcal-status';
    }
    updateGcalHint();
  }
  function pushOne(t, silent) {
    var g = S.settings.gcal;
    if (!GCal.isConnected() || !g.calendarId || !t.dueDate) return Promise.resolve();
    return GCal.push(g.calendarId, t).then(function (id) {
      t.gcalEventId = id; save(); renderList();
      if (!silent) toast('カレンダーに登録しました');
    }).catch(function (e) {
      if (!silent) toast('カレンダー登録に失敗：' + e.message);
      glog('失敗: ' + t.text + ' — ' + e.message);
    });
  }

  function loadCalendars() {
    return GCal.listCalendars().then(function (list) {
      var sel = $('gcalCalendar');
      sel.innerHTML = '';
      list.forEach(function (c) {
        var o = document.createElement('option');
        o.value = c.id; o.textContent = c.name + (c.primary ? '（メイン）' : '');
        sel.appendChild(o);
      });
      var g = S.settings.gcal;
      var known = list.filter(function (c) { return c.id === g.calendarId; })[0];
      if (!known && list.length) {
        var pri = list.filter(function (c) { return c.primary; })[0] || list[0];
        g.calendarId = pri.id; g.calendarName = pri.name;
      }
      sel.value = g.calendarId;
      save();
      return list;
    });
  }

  function syncAll(manual) {
    var g = S.settings.gcal;
    if (!GCal.hasClientId()) { if (manual) toast('先に設定でクライアントIDを登録してください'); return Promise.resolve(); }
    if (!GCal.isConnected()) { if (manual) toast('設定 → Googleカレンダー → 接続する'); return Promise.resolve(); }
    if (!g.calendarId) { if (manual) toast('同期先カレンダーを選んでください'); return Promise.resolve(); }

    var pushList = S.todos.filter(function (t) {
      return t.dueDate && !t.done && t.source !== 'gcal' && (g.auto || t.gcalEventId);
    });
    var pushed = 0, imported = 0;

    var chain = pushList.reduce(function (p, t) {
      return p.then(function () {
        return GCal.push(g.calendarId, t).then(function (id) {
          if (t.gcalEventId !== id) { t.gcalEventId = id; }
          pushed++;
        }).catch(function (e) { syncErrors++; glog('送信失敗: ' + t.text + ' — ' + e.message); });
      });
    }, Promise.resolve());

    return chain.then(function () {
      if (!g.importDays) return;
      return GCal.listUpcoming(g.calendarId, Number(g.importDays)).then(function (evs) {
        var tab = ensureImportTab();
        var known = {};
        S.todos.forEach(function (t) { if (t.gcalEventId) known[t.gcalEventId] = t; });
        evs.forEach(function (e) {
          if (e.fromTodolink) return;
          if (known[e.id]) {
            known[e.id].text = e.title;
            known[e.id].dueDate = e.date;
            known[e.id].dueTime = e.time;
            return;
          }
          S.todos.push({
            id: uid(), tabId: tab.id, text: e.title, note: '', done: false,
            color: 4, order: 1000 + imported,
            dueDate: e.date, dueTime: e.time, repeat: { type: 'none' },
            gcalEventId: e.id, source: 'gcal', createdAt: Date.now()
          });
          imported++;
        });
      });
    }).then(function () {
      g.lastSync = new Date().toTimeString().slice(0, 5);
      save(true); renderTabs(); renderList(); gstatus();
      glog('同期完了：送信 ' + pushed + ' / 取り込み ' + imported);
      if (manual) toast('同期しました（送信 ' + pushed + '・取り込み ' + imported + '）');
    }).catch(function (e) {
      syncErrors++;
      glog('エラー: ' + e.message);
      if (manual) toast('同期エラー：' + e.message);
    });
  }

  /* ---------------- 常時同期 ---------------- */
  var AUTO_SYNC_MS = 180000;   // 表示中は3分おきに自動同期
  var MIN_GAP_MS = 45000;      // 画面復帰などで連打しないための最短間隔
  var lastSyncAt = 0, syncing = false, syncTimer = null;
  var syncErrors = 0, syncIsManual = false;

  function syncAgo() {
    if (!lastSyncAt) return '同期待ち';
    var m = Math.floor((Date.now() - lastSyncAt) / 60000);
    if (m < 1) return '同期済み';
    if (m < 60) return m + '分前に同期';
    return Math.floor(m / 60) + '時間前に同期';
  }
  function setSyncUI(state) {
    var el = $('syncState'), t = $('syncText');
    if (!el) return;
    el.className = 'sync-state ' + state;
    t.textContent =
      state === 'busy' ? '同期中…' :
      state === 'ok' ? syncAgo() :
      state === 'err' ? '同期できません' :
      'カレンダー未接続';
  }
  function refreshSyncLabel() {
    var el = $('syncState');
    if (el && el.classList.contains('ok')) $('syncText').textContent = syncAgo();
  }

  /** 送信（ToDo→カレンダー）と取得（カレンダー→アプリ）をまとめて1回 */
  function syncEverything(manual) {
    if (syncing) return Promise.resolve();
    if (!GCal.hasClientId() || !GCal.isConnected()) {
      setSyncUI('off');
      if (manual) toast('設定 → Googleカレンダー連携 でつないでください');
      return Promise.resolve();
    }
    if (!manual && lastSyncAt && Date.now() - lastSyncAt < MIN_GAP_MS) return Promise.resolve();

    syncing = true;
    syncErrors = 0;
    syncIsManual = !!manual;
    setSyncUI('busy');
    return syncAll(manual)
      .then(function () { return loadCalView(true); })
      .catch(function (e) { syncErrors++; glog('同期エラー: ' + e.message); })
      .then(function () {
        syncing = false;
        if (syncErrors) {
          setSyncUI('err');
        } else {
          lastSyncAt = Date.now();
          setSyncUI('ok');
        }
      });
  }

  function startAutoSync() {
    clearInterval(syncTimer);
    syncTimer = setInterval(function () {
      if (document.visibilityState === 'visible') syncEverything(false);
    }, AUTO_SYNC_MS);
    // 表示に戻ったとき・回線が戻ったときは即座に追いつく
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') syncEverything(false);
    });
    window.addEventListener('online', function () { syncEverything(false); });
    setInterval(refreshSyncLabel, 30000);
  }

  function ensureImportTab() {
    var t = S.tabs.filter(function (x) { return x.name === '📅 カレンダー'; })[0];
    if (t) return t;
    t = { id: uid(), name: '📅 カレンダー' };
    S.tabs.push(t); save();
    return t;
  }

  /* ---------------- 自動リセット・通知 ---------------- */
  function checkAutoReset() {
    var st = S.settings;
    if (!st.autoReset) return;
    var now = new Date();
    var mark = new Date(); mark.setHours.apply(mark, (st.resetTime || '04:00').split(':').map(Number).concat([0, 0]));
    if (now < mark) return;
    if (st.lastResetOn === today()) return;
    var n = 0;
    S.todos.forEach(function (t) { if (t.done) { t.done = false; t.doneAt = 0; n++; } });
    st.lastResetOn = today();
    save(true);
    if (n) { renderTabs(); renderList(); toast('チェックを自動リセットしました（' + n + '件）'); }
  }

  var notified = {};
  function checkNotify() {
    if (!S.settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    var now = new Date();
    S.todos.forEach(function (t) {
      if (t.done || !t.dueDate) return;
      var d = nextDue(t);
      if (d !== today()) return;
      var at = new Date(parseYmd(d).getTime() + toMin(t.dueTime || '09:00') * 60000);
      var key = t.id + '@' + d;
      if (notified[key]) return;
      if (now >= at && now - at < 3600000) {
        notified[key] = 1;
        try { new Notification('ToDoリンク', { body: t.text, tag: key }); } catch (e) {}
      }
    });
  }

  /* ---------------- データ入出力 ---------------- */
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }
  function icsEscape(s) { return String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n'); }
  function exportIcs() {
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ToDoLink//JP', 'CALSCALE:GREGORIAN'];
    var stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    var n = 0;
    S.todos.forEach(function (t) {
      if (!t.dueDate || t.done) return;
      n++;
      var dstart, dend;
      if (t.dueTime) {
        var s = t.dueDate.replace(/-/g, '') + 'T' + t.dueTime.replace(':', '') + '00';
        var e = new Date(parseYmd(t.dueDate).getTime() + (toMin(t.dueTime) + 30) * 60000);
        dstart = 'DTSTART;TZID=Asia/Tokyo:' + s;
        dend = 'DTEND;TZID=Asia/Tokyo:' + ymd(e).replace(/-/g, '') + 'T' + pad(e.getHours()) + pad(e.getMinutes()) + '00';
      } else {
        var nx = new Date(parseYmd(t.dueDate).getTime() + 86400000);
        dstart = 'DTSTART;VALUE=DATE:' + t.dueDate.replace(/-/g, '');
        dend = 'DTEND;VALUE=DATE:' + ymd(nx).replace(/-/g, '');
      }
      lines.push('BEGIN:VEVENT', 'UID:' + t.id + '@todolink', 'DTSTAMP:' + stamp,
        'SUMMARY:' + icsEscape(t.text), dstart, dend);
      if (t.note) lines.push('DESCRIPTION:' + icsEscape(t.note));
      var rr = (function (rep) {
        if (!rep || rep.type === 'none') return null;
        if (rep.type === 'daily') return 'RRULE:FREQ=DAILY';
        if (rep.type === 'weekly') return 'RRULE:FREQ=WEEKLY;BYDAY=' + (rep.weekdays || []).map(function (i) { return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][i]; }).join(',');
        if (rep.type === 'monthly') return 'RRULE:FREQ=MONTHLY;BYMONTHDAY=' + (rep.monthday || 1);
        return null;
      })(t.repeat);
      if (rr) lines.push(rr);
      lines.push('BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape(t.text), 'END:VALARM');
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    if (!n) { toast('日時つきの未完了ToDoがありません'); return; }
    download('todolink-' + today() + '.ics', lines.join('\r\n'), 'text/calendar');
    toast(n + ' 件を .ics に書き出しました');
  }

  /* ---------------- 起動 ---------------- */
  function bind() {
    // ヘッダー
    $('syncState').onclick = function () {
      if (!GCal.hasClientId() || !GCal.isConnected()) { fillSettings(); openSheet('settingsSheet'); return; }
      syncEverything(true);
    };
    $('btnMenu').onclick = function () {
      $('menuVer').textContent = 'ToDoリンク v' + VERSION;
      openSheet('menuSheet');
    };
    $('btnSearch').onclick = function () { searching ? closeSearch() : openSearch(); };
    $('btnSettings').onclick = function () { fillSettings(); openSheet('settingsSheet'); };
    $('searchClose').onclick = closeSearch;
    $('searchInput').oninput = function () { query = this.value.trim(); renderList(); };

    // カレンダービュー
    $('calRange').onchange = function () {
      S.settings.gcal.viewDays = Number(this.value) || 14;
      S.calCache.at = 0;
      save(); loadCalView(true);
    };
    $('calRefresh').onclick = function () { syncEverything(true); };
    $('evOpen').onclick = function () {
      if (viewingEvent && viewingEvent.htmlLink) window.open(viewingEvent.htmlLink, '_blank', 'noopener');
      closeSheet('evSheet');
    };
    $('evToTodo').onclick = function () {
      if (!viewingEvent) return;
      var e = viewingEvent;
      var tab = tabsById(S.lastRealTabId) || S.tabs[0];
      var orders = todosOf(tab.id).map(function (t) { return t.order || 0; });
      S.todos.push({
        id: uid(), tabId: tab.id, text: e.title, note: e.location || '', done: false,
        color: 4, order: (orders.length ? Math.max.apply(null, orders) : 0) + 1,
        dueDate: e.date, dueTime: e.allDay ? '' : e.time, repeat: { type: 'none' },
        gcalEventId: e.id, source: 'gcal', createdAt: Date.now()
      });
      save(); renderTabs(); closeSheet('evSheet');
      toast('「' + tab.name + '」に入れました');
    };

    // メニュー
    $('mTabAdd').onclick = function () { closeSheet('menuSheet'); addTab(); };
    $('mTabEdit').onclick = function () { closeSheet('menuSheet'); renderTabEditor(); openSheet('tabSheet'); };
    $('mClearDone').onclick = function () { closeSheet('menuSheet'); clearDone(); };
    $('mSync').onclick = function () { closeSheet('menuSheet'); syncEverything(true); };
    $('mSettings').onclick = function () { closeSheet('menuSheet'); fillSettings(); openSheet('settingsSheet'); };

    // 追加
    $('fab').onclick = openAdd;
    $('addOk').onclick = submitAdd;
    $('addCancel').onclick = function () { closeSheet('addSheet'); };
    $('addInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitAdd(); }
    });

    // 色
    $('btnColor').onclick = function () {
      buildColorGrid($('colorGrid'), function () { return composeColor; }, function (i) {
        composeColor = i;
        $('colorSwatch').style.background = TODO_COLORS[i];
        closeSheet('colorSheet');
      });
      openSheet('colorSheet');
    };
    $('colorSwatch').style.background = TODO_COLORS[composeColor];

    // 日付と時間
    $('btnDue').onclick = function () { openDue('compose', pendingDue); };
    $('btnDueClear').onclick = function () { clearPendingDue(); };
    $('dueRepeat').onchange = syncRepeatRows;
    $('dueDate').onchange = syncQuickRows;
    $('dueTime').onchange = syncQuickRows;
    Array.prototype.forEach.call(document.querySelectorAll('.quick[data-day]'), function (b) {
      b.onclick = function () {
        $('dueDate').value = ymd(new Date(Date.now() + Number(b.dataset.day) * 86400000));
        syncQuickRows();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('.quick[data-time]'), function (b) {
      b.onclick = function () {
        $('dueTime').value = ($('dueTime').value === b.dataset.time) ? '' : b.dataset.time;
        if (!$('dueDate').value) $('dueDate').value = today();
        syncQuickRows();
      };
    });
    $('dueOk').onclick = function () {
      var d = readDue();
      if (dueTarget === 'compose') {
        pendingDue = d; showDuePreview();
      } else if (dueTarget === 'row') {
        // 行のカレンダーボタンから来た場合：その場で本体に書いて送る
        var t = S.todos.filter(function (x) { return x.id === editing.id; })[0];
        closeSheet('dueSheet');
        if (!t) return;
        if (!d.dueDate) { toast('日付を選んでください'); return; }
        t.dueDate = d.dueDate; t.dueTime = d.dueTime; t.repeat = d.repeat;
        save(); renderList();
        pushOne(t);
        return;
      } else {
        editing.dueDate = d.dueDate; editing.dueTime = d.dueTime; editing.repeat = d.repeat;
        refreshEditDueBtn();
      }
      closeSheet('dueSheet');
    };
    $('dueClear').onclick = function () {
      if (dueTarget === 'compose') clearPendingDue();
      else if (dueTarget === 'row') { /* 何もせず閉じる */ }
      else { editing.dueDate = ''; editing.dueTime = ''; editing.repeat = { type: 'none' }; refreshEditDueBtn(); }
      closeSheet('dueSheet');
    };

    // 編集
    $('editDueBtn').onclick = function () { openDue('edit', editing); };
    $('editSave').onclick = saveEdit;
    $('editCancel').onclick = function () { closeSheet('editSheet'); };
    $('editDelete').onclick = function () {
      var id = editing.id, name = editing.text;
      confirmBox('ToDoを削除', '「' + name + '」を削除します。', '削除する').then(function (ok) {
        if (!ok) return;
        removeTodo(id); closeSheet('editSheet');
      });
    };

    // タブ設定
    $('tabAdd').onclick = function () { addTab().then(function () { renderTabEditor(); }); };

    // 設定
    $('setDark').onchange = function () { S.settings.dark = this.value; save(); applyLook(); };
    $('setFont').onchange = function () { S.settings.font = Number(this.value); save(); applyLook(); };
    $('setLines').onchange = function () { S.settings.lines = Number(this.value); save(); applyLook(); renderList(); };
    $('setTabCount').onchange = function () { S.settings.showTabCount = this.checked; save(); renderTabs(); };
    $('setBadge').onchange = function () { S.settings.appBadge = this.checked; save(); updateBadge(); };
    $('setShowMeta').onchange = function () { S.settings.showMeta = this.checked; save(); renderList(); };
    $('setAutoReset').onchange = function () { S.settings.autoReset = this.checked; save(); };
    $('setResetTime').onchange = function () { S.settings.resetTime = this.value || '04:00'; save(); };
    $('setNotify').onchange = function () {
      var on = this.checked;
      if (on && 'Notification' in window && Notification.permission !== 'granted') {
        Notification.requestPermission().then(function (p) {
          S.settings.notify = (p === 'granted'); save(); $('setNotify').checked = S.settings.notify;
          if (p !== 'granted') toast('通知が許可されませんでした');
        });
      } else { S.settings.notify = on; save(); }
    };

    // Googleカレンダー
    $('gcalSaveId').onclick = function () {
      var id = $('gcalClientId').value.trim();
      S.settings.gcal.clientId = id; save(true);
      GCal.setClientId(id);
      if (id && GCal.preload) GCal.preload();
      gstatus(); toast(id ? 'クライアントIDを保存しました' : 'クライアントIDを消しました');
    };
    $('gcalConnect').onclick = function () {
      var id = $('gcalClientId').value.trim() || S.settings.gcal.clientId;
      if (!id) { toast('先にクライアントIDを登録してください'); return; }
      S.settings.gcal.clientId = id; save(true); GCal.setClientId(id);
      GCal.connect().then(function () {
        glog('接続しました'); gstatus();
        return GCal.whoami().then(function (mail) {
          if (mail && mail.indexOf('@') > 0) {
            var want = (S.settings.gcal.account || '').trim().toLowerCase();
            if (want && want !== mail.toLowerCase()) {
              toast('別のアカウント（' + mail + '）でログインされています');
              glog('注意: 想定 ' + want + ' / 実際 ' + mail);
            }
            S.settings.gcal.account = mail;
            $('gcalAccount').value = mail;
            save(true);
          }
        }).catch(function () {});
      }).then(function () {
        return loadCalendars();
      }).then(function () {
        gstatus(); toast('Googleカレンダーに接続しました');
        S.calCache.at = 0;
        return syncEverything(true);
      }).catch(function (e) {
        var m = e.message || '';
        if (/popup|closed|cancel|blocked/i.test(m)) {
          m = 'ポップアップが開けませんでした。ホーム画面のアプリではなく、Safariで開いて試してください。';
        }
        toast('接続失敗：' + m);
        glog('接続失敗: ' + (e.message || m));
      });
    };
    $('gcalAccount').onchange = function () { S.settings.gcal.account = this.value.trim(); save(true); };
    $('gcalDisconnect').onclick = function () {
      GCal.disconnect().then(function () { lastSyncAt = 0; setSyncUI('off'); gstatus(); glog('切断しました'); toast('切断しました'); });
    };
    $('gcalCalendar').onchange = function () {
      S.settings.gcal.calendarId = this.value;
      S.settings.gcal.calendarName = this.options[this.selectedIndex].textContent;
      save(); gstatus();
    };
    $('gcalAuto').onchange = function () { S.settings.gcal.auto = this.checked; save(); gstatus(); };
    $('gcalDeleteOnDone').onchange = function () { S.settings.gcal.deleteOnDone = this.checked; save(); };
    $('gcalImportRange').onchange = function () { S.settings.gcal.importDays = Number(this.value); save(); };
    $('gcalSyncNow').onclick = function () { syncEverything(true); };

    // パスコード
    // データ
    $('dataExport').onclick = function () { download('todolink-backup-' + today() + '.json', JSON.stringify(S, null, 2)); };
    $('dataImport').onclick = function () { $('dataFile').click(); };
    $('dataFile').onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        var obj;
        try {
          obj = JSON.parse(r.result);
          if (!obj.tabs || !obj.todos) throw new Error('ToDoリンクの書き出しファイルではないようです');
        } catch (err) { toast('読み込めません：' + err.message); return; }
        confirmBox('データを読み込む',
          'いまのToDo（' + S.todos.length + '件）と設定を、このファイルの内容（' + obj.todos.length + '件）で置き換えます。',
          '置き換える').then(function (ok) {
            if (!ok) return;
            S = obj;
            S.settings = Object.assign({}, defaults().settings, S.settings || {});
            S.settings.gcal = Object.assign({}, defaults().settings.gcal, S.settings.gcal || {});
            save(true); applyLook(); renderTabs(); renderList(); fillSettings();
            toast('読み込みました');
          });
      };
      r.readAsText(f);
      e.target.value = '';
    };
    $('dataIcs').onclick = exportIcs;
    $('dataReset').onclick = function () {
      ask({
        title: '全データを削除',
        message: 'ToDo ' + S.todos.length + '件・タブ ' + S.tabs.length + '個・すべての設定を消します。元に戻せません。\n続けるには「削除」と入力してください。',
        input: true, placeholder: '削除', okText: '実行する', danger: true
      }).then(function (v) {
        if (v === null) return;
        if (String(v).trim() !== '削除') { toast('中止しました'); return; }
        localStorage.removeItem(KEY);
        S = defaults(); save(true); applyLook(); renderTabs(); renderList(); fillSettings();
        toast('初期化しました');
      });
    };

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyLook);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { checkAutoReset(); renderList(); }
    });
  }

  function fillSettings() {
    var st = S.settings;
    $('setDark').value = st.dark;
    $('setFont').value = String(st.font);
    $('setLines').value = String(st.lines);
    $('setTabCount').checked = !!st.showTabCount;
    $('setBadge').checked = !!st.appBadge;
    $('setShowMeta').checked = !!st.showMeta;
    $('setAutoReset').checked = !!st.autoReset;
    $('setResetTime').value = st.resetTime || '04:00';
    $('setNotify').checked = !!st.notify;
    $('gcalClientId').value = st.gcal.clientId || '';
    // クライアントID未設定なら折りたたみを開いておく（入力欄が隠れていて気づけない事故を防ぐ）
    if ($('gcalAdv')) $('gcalAdv').open = !st.gcal.clientId;
    $('gcalAccount').value = st.gcal.account || '';
    $('gcalAuto').checked = !!st.gcal.auto;
    $('gcalDeleteOnDone').checked = !!st.gcal.deleteOnDone;
    $('gcalImportRange').value = String(st.gcal.importDays || 0);
    $('verLine').textContent = 'ToDoリンク v' + VERSION;

    var g = $('themeGrid');
    g.innerHTML = '';
    THEME_COLORS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button'; b.style.background = c;
      if (c.toLowerCase() === String(st.theme).toLowerCase()) b.className = 'on';
      b.onclick = function () { st.theme = c; save(); applyLook(); fillSettings(); };
      g.appendChild(b);
    });

    gstatus();
    if (GCal.isConnected() && !$('gcalCalendar').options.length) {
      loadCalendars().then(gstatus).catch(function (e) { glog('カレンダー一覧取得失敗: ' + e.message); });
    }
  }

  function start() {
    S = load();
    watchViewport();
    applyLook();
    wireSheetDismiss();
    bind();
    GCal.setClientId(S.settings.gcal.clientId || '');
    // 認証ライブラリを先に読み込む。iOS Safari はボタン押下から時間が空くと
    // ポップアップを塞ぐため、押した瞬間に認証を始められる状態にしておく。
    if (GCal.preload) GCal.preload();

    if (!S.lastRealTabId || !tabsById(S.lastRealTabId)) {
      S.lastRealTabId = (S.activeTabId !== GCAL_TAB && tabsById(S.activeTabId)) ? S.activeTabId : S.tabs[0].id;
    }

    (function () {
      checkAutoReset();
      renderTabs();
      renderList();
      showDuePreview();
      setInterval(function () { checkAutoReset(); checkNotify(); }, 30000);
      setSyncUI(GCal.isConnected() ? 'ok' : 'off');
      startAutoSync();
      if (GCal.isConnected()) setTimeout(function () { syncEverything(true); }, 800);
    })();

    // オフライン用キャッシュは、開発中に古いコードを掴み続ける事故のほうが大きいので停止。
    // すでに入っている端末からも確実に外す。
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(function (rs) {
        rs.forEach(function (r) { r.unregister(); });
      }).catch(function () {});
    }
    if (window.caches && caches.keys) {
      caches.keys().then(function (ks) {
        ks.forEach(function (k) { if (k.indexOf('todolink') === 0) caches.delete(k); });
      }).catch(function () {});
    }
  }

  document.addEventListener('DOMContentLoaded', start);
})();
