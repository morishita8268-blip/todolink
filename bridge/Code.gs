/**
 * ToDoリンク ブリッジ（Google Apps Script）
 *
 * アプリがGoogleに直接ログインする代わりに、このスクリプトが
 * 「持ち主本人の権限」でカレンダーを読み書きする中継役。
 * アプリ側にGoogleのアクセス権を持たせないので、1時間ごとの再接続が要らなくなる。
 *
 * 設定するのは KEY だけ。アプリの設定に入れる「合言葉」と同じ文字列にする。
 * この合言葉を知っている人は、持ち主のカレンダーを読み書きできる。人に見せないこと。
 */
const KEY = '__PASTE_KEY_HERE__';

const TAG = 'todolinkId';
const COLOR_MAP = ['9', '11', '6', '5', '10', '3', '8', '7'];   // アプリの色番号 → カレンダーの色番号
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

function doGet() {
  return json_({ ok: true, app: 'todolink-bridge' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: '読み取れないリクエストです' });
  }
  if (!req || req.key !== KEY) return json_({ ok: false, error: '合言葉が違います' });

  try {
    switch (req.action) {
      case 'ping':
        return json_({ ok: true, account: Session.getEffectiveUser().getEmail() });
      case 'calendars':
        return json_({ ok: true, calendars: listCalendars_() });
      case 'events':
        return json_({ ok: true, events: listEvents_(req.calendarIds || [], Number(req.days) || 14, req.tz) });
      case 'upsert':
        return json_({ ok: true, id: upsert_(req.calendarId, req.todo || {}, req.tz) });
      case 'remove':
        remove_(req.calendarId, req.eventId);
        return json_({ ok: true });
      default:
        return json_({ ok: false, error: '知らない操作です: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function tz_(t) {
  return t || Session.getScriptTimeZone() || 'Asia/Tokyo';
}

function calOf_(id) {
  var c = id ? CalendarApp.getCalendarById(id) : null;
  return c || CalendarApp.getDefaultCalendar();
}

/* ---------- 読む ---------- */

function listCalendars_() {
  return CalendarApp.getAllCalendars().map(function (c) {
    return {
      id: c.getId(),
      name: c.getName(),
      primary: c.isMyPrimaryCalendar(),
      color: c.getColor(),
      selected: !c.isHidden(),
      canWrite: c.isOwnedByMe() || c.isMyPrimaryCalendar()
    };
  });
}

function listEvents_(ids, days, tz) {
  tz = tz_(tz);
  var scriptTz = Session.getScriptTimeZone();
  var todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var from = Utilities.parseDate(todayStr + ' 00:00', tz, 'yyyy-MM-dd HH:mm');
  var to = new Date(from.getTime() + days * 86400000);
  var out = [];

  ids.forEach(function (id) {
    var cal = CalendarApp.getCalendarById(id);
    if (!cal) return;
    var name = cal.getName();
    var color = cal.getColor();

    cal.getEvents(from, to).forEach(function (ev) {
      var allDay = ev.isAllDayEvent();
      // 終日の日付は「スクリプトの時間帯の0時」で返ってくるので、その時間帯で日付にする
      var start = allDay ? ev.getAllDayStartDate() : ev.getStartTime();
      var evId = ev.getId();
      out.push({
        id: evId,
        title: ev.getTitle() || '(無題の予定)',
        allDay: allDay,
        date: Utilities.formatDate(start, allDay ? scriptTz : tz, 'yyyy-MM-dd'),
        time: allDay ? '' : Utilities.formatDate(start, tz, 'HH:mm'),
        endTime: allDay ? '' : Utilities.formatDate(ev.getEndTime(), tz, 'HH:mm'),
        location: ev.getLocation() || '',
        recurring: ev.isRecurringEvent(),
        fromTodolink: !!ev.getTag(TAG),
        todoId: ev.getTag(TAG) || null,
        calendarId: id,
        calendarName: name,
        color: color,
        htmlLink: 'https://calendar.google.com/calendar/event?eid=' +
          Utilities.base64EncodeWebSafe(evId.split('@')[0] + ' ' + id).replace(/=+$/, '')
      });
    });
  });

  out.sort(function (a, b) {
    var ka = a.date + 'T' + (a.time || '00:00');
    var kb = b.date + 'T' + (b.time || '00:00');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}

/* ---------- 探す ---------- */

// 以前のアプリはAPIのIDを保存していた。CalendarApp は末尾に @google.com が付くIDを使うので両方試す。
function idCandidates_(eventId) {
  var list = [eventId];
  if (eventId && eventId.indexOf('@') < 0) list.push(eventId + '@google.com');
  return list;
}

function findEvent_(cal, eventId) {
  if (!eventId) return null;
  var ids = idCandidates_(eventId);
  for (var i = 0; i < ids.length; i++) {
    try {
      var ev = cal.getEventById(ids[i]);
      if (ev) return ev;
    } catch (e) {}
  }
  return null;
}

function findSeries_(cal, eventId) {
  if (!eventId) return null;
  var ids = idCandidates_(eventId);
  for (var i = 0; i < ids.length; i++) {
    try {
      var s = cal.getEventSeriesById(ids[i]);
      if (s) return s;
    } catch (e) {}
  }
  return null;
}

/* ---------- 書く ---------- */

function recurrence_(rep, dueDate) {
  if (!rep || !rep.type || rep.type === 'none') return null;
  var r = CalendarApp.newRecurrence();
  if (rep.type === 'daily') {
    r.addDailyRule();
    return r;
  }
  if (rep.type === 'weekly') {
    var days = (rep.weekdays && rep.weekdays.length) ? rep.weekdays : [weekdayOf_(dueDate)];
    r.addWeeklyRule().onlyOnWeekdays(days.map(function (i) { return CalendarApp.Weekday[WEEKDAYS[i]]; }));
    return r;
  }
  if (rep.type === 'monthly') {
    r.addMonthlyRule().onlyOnMonthDay(Number(rep.monthday) || 1);
    return r;
  }
  return null;
}

function weekdayOf_(ymd) {
  var p = String(ymd).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]).getDay();
}

function setMeta_(ev, t) {
  try { ev.setTag(TAG, String(t.id || '')); } catch (e) {}
  try { ev.setColor(COLOR_MAP[t.color || 0] || '9'); } catch (e) {}
}

/** 同じToDoの予定があれば中身を書き換える。無ければ作る。IDを返す。 */
function upsert_(calendarId, t, tz) {
  tz = tz_(tz);
  if (!t.dueDate) throw new Error('日付がないので予定にできません');

  var cal = calOf_(calendarId);
  var title = (t.done ? '✅ ' : '') + (t.text || '');
  var description = (t.note ? t.note + '\n\n' : '') + '— ToDoリンク';
  var rec = recurrence_(t.repeat, t.dueDate);

  var start = null, end = null, day = null;
  if (t.dueTime) {
    start = Utilities.parseDate(t.dueDate + ' ' + t.dueTime, tz, 'yyyy-MM-dd HH:mm');
    end = new Date(start.getTime() + 30 * 60000);
  } else {
    day = Utilities.parseDate(t.dueDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  // 繰り返しが絡まない単発の予定は、その場で書き換える（通知が二重に来ないように作り直さない）
  var existing = findEvent_(cal, t.gcalEventId);
  if (existing && !existing.isRecurringEvent() && !rec) {
    existing.setTitle(title);
    existing.setDescription(description);
    if (start) {
      existing.setTime(start, end);
      try { existing.removeAllReminders(); existing.addPopupReminder(0); } catch (e) {}
    } else {
      existing.setAllDayDate(day);
    }
    setMeta_(existing, t);
    return existing.getId();
  }

  // 繰り返しが絡む・見つからない → 古いものを消して作り直す
  var old = findSeries_(cal, t.gcalEventId);
  if (old) old.deleteEventSeries();

  var opts = { description: description };
  var ev;
  if (start) {
    ev = rec ? cal.createEventSeries(title, start, end, rec, opts) : cal.createEvent(title, start, end, opts);
    try { ev.removeAllReminders(); ev.addPopupReminder(0); } catch (e) {}
  } else {
    ev = rec ? cal.createAllDayEventSeries(title, day, rec, opts) : cal.createAllDayEvent(title, day, opts);
  }
  setMeta_(ev, t);
  return ev.getId();
}

function remove_(calendarId, eventId) {
  var s = findSeries_(calOf_(calendarId), eventId);
  if (s) s.deleteEventSeries();
}
