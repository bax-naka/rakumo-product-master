/**
 * Step D：公開用ルックアップ（製品マスター(仮)・(削除)）の再生成と rakumo への再取込。
 *
 * 公開ファイル：管理マスターから全件を作り直し、内容が違うときだけ先頭シートを書き換える（ファイルIDは維持）。
 *   列は公開9列（列名・列順を変えない）、値は名称付き表示・rakumo取込規則で正規化・書式なしテキスト。
 * 再取込：LOOKUP_REFRESH_ENABLED=true のときだけ LookupData REFRESH を呼ぶ。
 *   完了判定は rakumo の時計だけで行う：REFRESH前の lastRefreshed より新しくなり、isBuilding が無く、
 *   rowCount と列名が書き込んだ内容と一致したら「最新」。
 * 状態は管理用ブックの「公開状態」タブに役割（active/inactive）ごとに記録する。
 *   最新 / 取込待ち（ファイル更新済み・REFRESH未要求）/ 取込中（REFRESH要求済み）/ エラー
 * 両方が「最新」になった回に、処理台帳の「マスター反映済み」行を「完了」（lookup_status=反映済み）にする。
 */
var PM_PUB = {
  TAB: '公開状態',
  HEADER: ['role', 'spreadsheet_id', 'lookup_id', 'status', 'rows', 'written_at', 'refresh_base', 'refresh_requested_at', 'last_refreshed', 'note', 'updated_at'],
  ROLES: { active: '有効', inactive: '無効' },
  MAX_CELL: 100, MAX_ROWS: 20000,
  POLL_TIMES: 12, POLL_MS: 5000,
  STUCK_MINUTES: 30,
  ST: { OK: '最新', WAIT: '取込待ち', BUILDING: '取込中', ERROR: 'エラー' }
};

/** 単独実行用（書込み・再取込）。WRITE_ENABLED=true のときだけ動く */
function pmPublishLookups() {
  var props = pmProps_();
  if (!props[PM.PROP.WRITE_ENABLED]) { pmLog_('WRITE_ENABLED が true ではないため公開ファイルを更新しません。'); return; }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(PM.LOCK_WAIT_MS)) throw new Error('別の実行が処理中のため中止（スクリプトロックを取得できない）');
  try { var log = []; pmPublishRun_(props, pmOpenMasterForWrite_(props), log); log.forEach(pmLog_); }
  finally { lock.releaseLock(); }
}

/** ロック取得済みの前提で呼ぶ */
function pmPublishRun_(props, book, log) {
  var sp = PropertiesService.getScriptProperties();
  var refreshOn = String(sp.getProperty('LOOKUP_REFRESH_ENABLED') || '').trim().toLowerCase() === 'true';
  SpreadsheetApp.flush();
  var master = pmReadMaster_(props[PM.PROP.MASTER_ID]);
  var desired = pmBuildPublic_(master);
  var state = pmPubState_(book);

  // 1) 公開ファイル
  Object.keys(PM_PUB.ROLES).forEach(function (role) {
    var ssId = (sp.getProperty(PM_RAKUMO.LOOKUP_PROPS[role]) || '').trim();
    if (!ssId) throw new Error('Script Property 未設定: ' + PM_RAKUMO.LOOKUP_PROPS[role]);
    if (ssId === props[PM.PROP.F2R_ID] || ssId === props[PM.PROP.MASTER_ID]) throw new Error('公開ファイルのIDがF-2R公開Sheetsまたは管理用ブックと同じ: ' + role);
    var st = pmPubGet_(state, role);
    if (st.spreadsheet_id && st.spreadsheet_id !== ssId) { st.status = PM_PUB.ST.WAIT; st.lookup_id = ''; }
    st.spreadsheet_id = ssId;
    var sheet = SpreadsheetApp.openById(ssId).getSheets()[0];
    var want = [PM.LOOKUP_COLUMNS].concat(desired[role]);
    if (pmSameTable_(pmReadTableTrimmed_(sheet), want)) { log.push('[' + role + '] 公開ファイルは最新（' + desired[role].length + '行）'); }
    else {
      sheet.clearContents();
      sheet.getRange(1, 1, want.length, PM.LOOKUP_COLUMNS.length).setNumberFormat('@').setValues(want);
      SpreadsheetApp.flush();
      if (!pmSameTable_(pmReadTableTrimmed_(sheet), want)) { st.status = PM_PUB.ST.ERROR; st.note = '公開ファイル書込み後の読み戻しが不一致'; pmPubSave_(state); throw new Error('[' + role + '] 公開ファイルの書込み後検証に失敗'); }
      st.status = PM_PUB.ST.WAIT; st.written_at = pmNowText_(); st.refresh_base = ''; st.refresh_requested_at = ''; st.note = '';
      log.push('[' + role + '] 公開ファイルを更新（' + desired[role].length + '行）');
    }
    st.rows = String(desired[role].length);
  });

  // 2) rakumo 再取込
  if (!refreshOn) {
    log.push('LOOKUP_REFRESH_ENABLED が true ではないため、rakumo の再取込は行いません（必要なら管理画面で手動更新）');
  } else {
    var list = pmLookupList_();
    Object.keys(PM_PUB.ROLES).forEach(function (role) { pmRefreshOne_(pmPubGet_(state, role), list, log); });
  }

  // 3) 処理台帳
  var allOk = Object.keys(PM_PUB.ROLES).every(function (r) { return pmPubGet_(state, r).status === PM_PUB.ST.OK; });
  var noError = Object.keys(PM_PUB.ROLES).every(function (r) { return pmPubGet_(state, r).status !== PM_PUB.ST.ERROR; });
  var ledger = pmLedger_(book), n = 0;
  pmLedgerRows_(ledger).forEach(function (L) {
    if (L.stage !== PM.STAGE.APPLIED) return;
    if (allOk) { pmLedgerUpdate_(ledger, L._row, { stage: PM.STAGE.DONE, lookup_status: '反映済み' }); n++; }
    else if (noError && L.lookup_status !== 'ファイル更新済み') { pmLedgerUpdate_(ledger, L._row, { lookup_status: 'ファイル更新済み' }); }
  });
  if (n) log.push('処理台帳: ' + n + '件を完了にしました');
  // 今回の実行で新たにエラーになった公開先（通知用）
  var before = JSON.parse(state.loaded || '{}');
  state.newErrors = Object.keys(PM_PUB.ROLES).filter(function (r) {
    return pmPubGet_(state, r).status === PM_PUB.ST.ERROR && !(before[r] && before[r].status === PM_PUB.ST.ERROR);
  }).map(function (r) { return r + ': ' + pmPubGet_(state, r).note; });
  pmPubSave_(state);
  return state;
}

/** 管理マスター → 公開用の行（管理マスターの行順） */
function pmBuildPublic_(master) {
  var out = { active: [], inactive: [] }, bad = [];
  Object.keys(master.products).forEach(function (id) {
    var p = master.products[id], role = p['管理状態'] === '有効' ? 'active' : p['管理状態'] === '無効' ? 'inactive' : null;
    if (!role) { bad.push(id + ' の管理状態が不正: ' + p['管理状態']); return; }
    var row = PM.LOOKUP_COLUMNS.map(function (c) { return pmToDisplay_(master, c, p); });
    row.forEach(function (v, i) {
      if (/^（未定義コード/.test(v)) bad.push(id + ' ' + PM.LOOKUP_COLUMNS[i] + ' が対応表にない');
      if (v.length > PM_PUB.MAX_CELL) bad.push(id + ' ' + PM.LOOKUP_COLUMNS[i] + ' が' + PM_PUB.MAX_CELL + '文字を超える');
    });
    if (!row[0]) bad.push(id + ' の型番が空（A列の空欄以降は取り込まれない）');
    out[role].push(row);
  });
  if (out.active.length > PM_PUB.MAX_ROWS || out.inactive.length > PM_PUB.MAX_ROWS) bad.push('行数が上限を超える');
  if (bad.length) throw new Error('公開用データを作れない:\n - ' + bad.join('\n - '));
  return out;
}

function pmReadTableTrimmed_(sheet) {
  var lr = sheet.getLastRow(), lc = sheet.getLastColumn();
  if (!lr || !lc) return [];
  return sheet.getRange(1, 1, lr, lc).getDisplayValues().map(function (r) {
    var x = r.map(String); while (x.length && x[x.length - 1] === '') x.pop(); return x;
  });
}
function pmSameTable_(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    var x = a[i], y = b[i].slice(); while (y.length && y[y.length - 1] === '') y.pop();
    if (x.length !== y.length) return false;
    for (var j = 0; j < x.length; j++) if (x[j] !== y[j]) return false;
  }
  return true;
}

/** 1つのルックアップについて REFRESH を要求・完了確認する */
function pmRefreshOne_(st, list, log) {
  var tag = '[' + st.role + '] ';
  if (st.status === PM_PUB.ST.OK || st.status === PM_PUB.ST.ERROR) {
    if (st.status === PM_PUB.ST.ERROR) log.push(tag + '公開状態がエラーのため再取込しない（' + st.note + '）');
    return;
  }
  var hits = list.filter(function (x) { return String(x.spreadsheetId) === st.spreadsheet_id; });
  if (hits.length !== 1) { st.status = PM_PUB.ST.ERROR; st.note = 'spreadsheetIdに一致するルックアップが' + hits.length + '件'; log.push(tag + st.note); return; }
  st.lookup_id = String(hits[0].id);
  var g = pmLookupGet_(st.lookup_id);

  if (st.status === PM_PUB.ST.WAIT) {
    if (g.isBuilding) { log.push(tag + 'rakumo側で更新中のため、次回に再取込を要求'); return; }
    st.refresh_base = String(g.lastRefreshed || '');
    try { pmRakumoRequest_('POST', '/lookup-data/' + encodeURIComponent(st.lookup_id) + '/refresh', {}); }
    catch (e) {
      if (e.httpStatus === 400) { log.push(tag + 'REFRESHが400（更新中）。次回に再要求'); return; }
      throw e;
    }
    st.status = PM_PUB.ST.BUILDING; st.refresh_requested_at = pmNowText_();
    log.push(tag + 'REFRESHを要求（id=' + st.lookup_id + '）');
  }
  for (var i = 0; i < PM_PUB.POLL_TIMES; i++) {
    if (pmRefreshDone_(st, g, log)) return;
    Utilities.sleep(PM_PUB.POLL_MS);
    g = pmLookupGet_(st.lookup_id);
  }
  if (pmRefreshDone_(st, g, log)) return;
  var age = (Date.parse(pmNowText_()) - Date.parse(st.refresh_requested_at)) / 60000;
  if (age > PM_PUB.STUCK_MINUTES) { st.status = PM_PUB.ST.ERROR; st.note = 'REFRESH要求から' + Math.round(age) + '分経っても完了しない'; log.push(tag + st.note); }
  else log.push(tag + '取込中のまま。次回に完了を確認');
}
function pmRefreshDone_(st, g, log) {
  st.last_refreshed = String(g.lastRefreshed || '');
  if (g.isBuilding) return false;
  var base = Date.parse(st.refresh_base || '1970-01-01T00:00:00Z'), now = Date.parse(st.last_refreshed || '');
  if (!(now > base)) return false;
  var labels = (g.columns || []).map(function (c) { return String(c.label); });
  if (String(g.rowCount) !== st.rows || labels.join('|') !== PM.LOOKUP_COLUMNS.join('|')) {
    st.status = PM_PUB.ST.ERROR; st.note = '再取込後の行数/列が不一致（rowCount=' + g.rowCount + ' 期待=' + st.rows + '）';
    log.push('[' + st.role + '] ' + st.note); return true;
  }
  st.status = PM_PUB.ST.OK; st.note = '';
  log.push('[' + st.role + '] rakumo再取込を確認（rowCount=' + g.rowCount + ' lastRefreshed=' + g.lastRefreshed + '）');
  return true;
}

/* ---------- 公開状態タブ ---------- */
function pmPubState_(book) {
  var sh = book.getSheetByName(PM_PUB.TAB);
  if (!sh) {
    sh = book.insertSheet(PM_PUB.TAB);
    sh.getRange(1, 1, 1, PM_PUB.HEADER.length).setNumberFormat('@').setValues([PM_PUB.HEADER]);
    sh.setFrozenRows(1);
  }
  var h = sh.getRange(1, 1, 1, PM_PUB.HEADER.length).getDisplayValues()[0];
  PM_PUB.HEADER.forEach(function (x, i) { if (h[i] !== x) throw new Error('公開状態タブの見出しが想定と違う: ' + (i + 1) + '列目'); });
  var rows = {}, n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 1, n, PM_PUB.HEADER.length).getDisplayValues().forEach(function (v) {
    var o = {}; PM_PUB.HEADER.forEach(function (k, j) { o[k] = v[j]; }); if (o.role) rows[o.role] = o;
  });
  return { sheet: sh, rows: rows, loaded: JSON.stringify(rows) };
}
function pmPubGet_(state, role) {
  if (!state.rows[role]) { var o = {}; PM_PUB.HEADER.forEach(function (k) { o[k] = ''; }); o.role = role; o.status = PM_PUB.ST.WAIT; state.rows[role] = o; }
  return state.rows[role];
}
function pmPubSave_(state) {
  if (JSON.stringify(state.rows) === state.loaded) return;            // 変化がなければ書かない
  var now = pmNowText_();
  var data = Object.keys(PM_PUB.ROLES).filter(function (r) { return state.rows[r]; }).map(function (r) {
    state.rows[r].updated_at = now; return PM_PUB.HEADER.map(function (k) { return String(state.rows[r][k] == null ? '' : state.rows[r][k]); });
  });
  if (data.length) state.sheet.getRange(2, 1, data.length, PM_PUB.HEADER.length).setNumberFormat('@').setValues(data);
}
