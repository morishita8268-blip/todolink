/* ToDoリンク — Googleカレンダー連携モジュール
 * バックエンド不要。ブラウザから Google Identity Services で
 * アクセストークンを取り、Calendar API v3 を直接叩く。
 */
(function (global) {
  'use strict';

  var SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly'
  ].join(' ');
  var GIS_SRC = 'https://accounts.google.com/gsi/client';
  var API = 'https://www.googleapis.com/calendar/v3';
  var TOKEN_KEY = 'todolink.gtoken';
  var PRIVATE_KEY = 'todolinkId';

  // ToDoの色(0-7) → Googleカレンダーの colorId
  var COLOR_MAP = ['9', '11', '6', '5', '10', '3', '8', '7'];

  var state = {
    clientId: '',
    tokenClient: null,
    token: null,     // {access_token, exp}
    gisReady: false
  };

  function loadGis() {
    if (state.gisReady) return Promise.resolve();
    if (global.google && global.google.accounts) { state.gisReady = true; return Promise.resolve(); }
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = GIS_SRC; s.async = true; s.defer = true;
      s.onload = function () { state.gisReady = true; res(); };
      s.onerror = function () { rej(new Error('Googleのライブラリを読み込めませんでした（オフライン？）')); };
      document.head.appendChild(s);
    });
  }

  function loadStoredToken() {
    try {
      var raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      var t = JSON.parse(raw);
      if (!t || !t.access_token || t.exp < Date.now() + 60000) return null;
      return t;
    } catch (e) { return null; }
  }
  function storeToken(t) {
    state.token = t;
    try {
      if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  function ensureClient() {
    if (!state.clientId) throw new Error('クライアントIDが未設定です（設定 → 接続設定）');
    if (state.tokenClient) return state.tokenClient;
    state.tokenClient = global.google.accounts.oauth2.initTokenClient({
      client_id: state.clientId,
      scope: SCOPES,
      callback: function () {} // 都度差し替える
    });
    return state.tokenClient;
  }

  /** interactive=false なら同意画面を出さずに更新を試みる */
  function getToken(interactive) {
    var cur = state.token || loadStoredToken();
    if (cur && cur.exp > Date.now() + 60000) { state.token = cur; return Promise.resolve(cur.access_token); }
    return loadGis().then(function () {
      return new Promise(function (res, rej) {
        var client = ensureClient();
        client.callback = function (resp) {
          if (resp && resp.access_token) {
            var t = { access_token: resp.access_token, exp: Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000 };
            storeToken(t);
            res(t.access_token);
          } else {
            rej(new Error((resp && resp.error_description) || (resp && resp.error) || '認証に失敗しました'));
          }
        };
        client.error_callback = function (err) { rej(new Error((err && err.message) || '認証がキャンセルされました')); };
        try {
          client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
        } catch (e) { rej(e); }
      });
    });
  }

  function api(path, opts) {
    opts = opts || {};
    return getToken(false).then(function (tok) {
      return fetch(API + path, {
        method: opts.method || 'GET',
        headers: Object.assign(
          { Authorization: 'Bearer ' + tok },
          opts.body ? { 'Content-Type': 'application/json' } : {}
        ),
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    }).then(function (r) {
      if (r.status === 401) { storeToken(null); throw new Error('認証が切れました。もう一度「接続する」を押してください。'); }
      if (r.status === 204) return null;
      return r.json().then(function (j) {
        if (!r.ok) {
          var m = (j && j.error && j.error.message) || ('HTTP ' + r.status);
          var err = new Error(m); err.status = r.status; throw err;
        }
        return j;
      });
    });
  }

  /* ---------- 日時ヘルパー ---------- */
  function tz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo'; }
    catch (e) { return 'Asia/Tokyo'; }
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function offsetStr(d) {
    var o = -d.getTimezoneOffset();
    var sign = o >= 0 ? '+' : '-';
    o = Math.abs(o);
    return sign + pad(Math.floor(o / 60)) + ':' + pad(o % 60);
  }
  function rfc3339(dateStr, timeStr) {
    var p = dateStr.split('-').map(Number);
    var t = (timeStr || '00:00').split(':').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2], t[0], t[1], 0);
    return dateStr + 'T' + pad(t[0]) + ':' + pad(t[1]) + ':00' + offsetStr(d);
  }
  function addDays(dateStr, n) {
    var p = dateStr.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2] + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  var WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  function rrule(rep) {
    if (!rep || rep.type === 'none') return null;
    if (rep.type === 'daily') return ['RRULE:FREQ=DAILY'];
    if (rep.type === 'weekly') {
      var days = (rep.weekdays && rep.weekdays.length ? rep.weekdays : [new Date().getDay()]).map(function (i) { return WD[i]; });
      return ['RRULE:FREQ=WEEKLY;BYDAY=' + days.join(',')];
    }
    if (rep.type === 'monthly') return ['RRULE:FREQ=MONTHLY;BYMONTHDAY=' + (rep.monthday || 1)];
    return null;
  }

  function buildEvent(todo) {
    var ev = {
      summary: (todo.done ? '✅ ' : '') + todo.text,
      description: (todo.note ? todo.note + '\n\n' : '') + '— ToDoリンク',
      colorId: COLOR_MAP[todo.color || 0],
      extendedProperties: { private: {} },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] }
    };
    ev.extendedProperties.private[PRIVATE_KEY] = todo.id;
    if (todo.dueTime) {
      ev.start = { dateTime: rfc3339(todo.dueDate, todo.dueTime), timeZone: tz() };
      var endH = todo.dueTime.split(':').map(Number);
      var end = new Date(2000, 0, 1, endH[0], endH[1] + 30);
      ev.end = { dateTime: rfc3339(todo.dueDate, pad(end.getHours()) + ':' + pad(end.getMinutes())), timeZone: tz() };
      if (end.getHours() < endH[0]) { // 23:45 など日跨ぎ
        ev.end = { dateTime: rfc3339(addDays(todo.dueDate, 1), '00:00'), timeZone: tz() };
      }
    } else {
      ev.start = { date: todo.dueDate };
      ev.end = { date: addDays(todo.dueDate, 1) };
      ev.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: -540 }] }; // 当日9:00
    }
    var rr = rrule(todo.repeat);
    if (rr) ev.recurrence = rr;
    return ev;
  }

  /* ---------- 公開API ---------- */
  var GCal = {
    PRIVATE_KEY: PRIVATE_KEY,

    /** Googleのライブラリを先に読み込んでおく。
     *  iOS Safari はボタン押下から時間が空くとポップアップを塞ぐので、
     *  接続ボタンを押した瞬間に同期的に認証を開始できる状態にしておく必要がある。 */
    preload: function () { return loadGis().catch(function () {}); },

    setClientId: function (id) {
      if (id !== state.clientId) { state.tokenClient = null; }
      state.clientId = (id || '').trim();
    },
    hasClientId: function () { return !!state.clientId; },
    isConnected: function () {
      var t = state.token || loadStoredToken();
      return !!(t && t.exp > Date.now());
    },
    connect: function () {
      return loadGis().then(function () { return getToken(true); }).then(function () { return true; });
    },
    disconnect: function () {
      var t = state.token || loadStoredToken();
      storeToken(null);
      state.tokenClient = null;
      if (t && global.google && global.google.accounts && global.google.accounts.oauth2) {
        try { global.google.accounts.oauth2.revoke(t.access_token, function () {}); } catch (e) {}
      }
      return Promise.resolve();
    },

    /** all=true なら読めるカレンダーを全部（書き込めないものも含む） */
    listCalendars: function (all) {
      var role = all ? 'reader' : 'writer';
      return api('/users/me/calendarList?minAccessRole=' + role + '&maxResults=100').then(function (r) {
        return (r.items || []).filter(function (c) { return !c.deleted; }).map(function (c) {
          return {
            id: c.id,
            name: c.summaryOverride || c.summary,
            primary: !!c.primary,
            color: c.backgroundColor || '#3f96f3',
            selected: c.selected !== false,
            canWrite: c.accessRole === 'owner' || c.accessRole === 'writer'
          };
        });
      });
    },

    /** ログイン中のアカウントのメールアドレス */
    whoami: function () {
      return api('/calendars/primary').then(function (r) { return (r && r.id) || ''; });
    },

    /** 複数カレンダーの予定をまとめて取得し、開始順に並べて返す */
    listUpcomingMulti: function (cals, days) {
      var self = this;
      var out = [];
      return cals.reduce(function (p, c) {
        return p.then(function () {
          return self.listUpcoming(c.id, days).then(function (evs) {
            evs.forEach(function (e) {
              e.calendarId = c.id;
              e.calendarName = c.name;
              e.color = c.color;
              out.push(e);
            });
          }).catch(function () { /* 1つ読めなくても止めない */ });
        });
      }, Promise.resolve()).then(function () {
        out.sort(function (a, b) {
          var ka = a.date + 'T' + (a.time || '00:00');
          var kb = b.date + 'T' + (b.time || '00:00');
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
        return out;
      });
    },

    /** ToDoをカレンダーに作成／更新。イベントIDを返す */
    push: function (calendarId, todo) {
      var body = buildEvent(todo);
      var cal = encodeURIComponent(calendarId);
      if (todo.gcalEventId) {
        return api('/calendars/' + cal + '/events/' + encodeURIComponent(todo.gcalEventId), { method: 'PATCH', body: body })
          .then(function (r) { return r.id; })
          .catch(function (e) {
            if (e.status === 404 || e.status === 410) { // 消えていたら作り直す
              return api('/calendars/' + cal + '/events', { method: 'POST', body: body }).then(function (r) { return r.id; });
            }
            throw e;
          });
      }
      return api('/calendars/' + cal + '/events', { method: 'POST', body: body }).then(function (r) { return r.id; });
    },

    remove: function (calendarId, eventId) {
      return api('/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId), { method: 'DELETE' })
        .catch(function (e) { if (e.status === 404 || e.status === 410) return null; throw e; });
    },

    /** 直近 days 日ぶんの予定を取得（このアプリ由来かどうかも返す） */
    listUpcoming: function (calendarId, days) {
      var now = new Date();
      var from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var to = new Date(from.getTime() + days * 86400000);
      var q = '?singleEvents=true&orderBy=startTime&maxResults=250'
        + '&timeMin=' + encodeURIComponent(from.toISOString())
        + '&timeMax=' + encodeURIComponent(to.toISOString());
      return api('/calendars/' + encodeURIComponent(calendarId) + '/events' + q).then(function (r) {
        return (r.items || []).filter(function (e) { return e.status !== 'cancelled'; }).map(function (e) {
          var ext = (e.extendedProperties && e.extendedProperties.private) || {};
          return {
            id: e.id,
            title: e.summary || '(無題の予定)',
            allDay: !!(e.start && e.start.date),
            date: (e.start && (e.start.date || (e.start.dateTime || '').slice(0, 10))) || '',
            time: (e.start && e.start.dateTime) ? e.start.dateTime.slice(11, 16) : '',
            endTime: (e.end && e.end.dateTime) ? e.end.dateTime.slice(11, 16) : '',
            location: e.location || '',
            recurring: !!e.recurringEventId,
            fromTodolink: !!ext[PRIVATE_KEY],
            todoId: ext[PRIVATE_KEY] || null,
            htmlLink: e.htmlLink || ''
          };
        });
      });
    }
  };

  global.GCal = GCal;
})(window);
