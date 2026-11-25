/**
 * Step C：管理マスター・処理台帳への書き込み。
 * 書き込み先は管理用ブックだけ。F-2R公開Sheetsには一切書かない（IDが同じなら起動時に停止）。
 *
 * 1回の実行の流れ（スクリプトロック内）
 *   1. 処理台帳の「処理中」行を管理マスターと照合して復旧（前回の途中停止）
 *   2. F-2R公開データと管理マスターを読み、候補を判定（Step Bと同じ判定）
 *   3. 反映がある場合だけ、管理マスターを日時付きタブへ複製（バックアップ）
 *   4. 1件ずつ：台帳に「処理中」→ 管理マスター書込み → 読み戻し照合 → 台帳を「マスター反映済み」
 *      保留は台帳に「保留」と理由を記録（以後は自動で再判定しない。再判定は台帳行を削除）
 */
function pmApplyRun_(props) {
  var masterId = props[PM.PROP.MASTER_ID];
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(PM.LOCK_WAIT_MS)) throw new Error('別の実行が処理中のため中止（スクリプトロックを取得できない）');
  var log = [];
  try {
    var book = pmOpenMasterForWrite_(props);
    var ledger = pmLedger_(book);
    pmRecover_(book, ledger, log);
    SpreadsheetApp.flush();

    var f2r = pmReadF2r_(props[PM.PROP.F2R_ID]);
    var master = pmReadMaster_(masterId);
    var judged = pmJudgeAll(f2r, master, { startAt: props[PM.PROP.START_AT] });
    judged.warnings.forEach(function (w) { log.push('[警告] ' + w); });
    if (!judged.results.length) log.push('処理対象なし');

    if (judged.results.some(function (r) { return r.decision === '反映'; })) log.push('バックアップ: ' + pmBackup_(book));

    var sheet = book.getSheetByName(PM.TAB.master);
    judged.results.forEach(function (r) {
      var base = { flow_id: 'text:' + r.flow_id, application_number: r.application_number, form_key: r.form_key, status: r.status,
                   decided_at: r.decided_at, decision: r.decision, management_id: r.management_id,
                   f2r_generation: f2r.control.generation };
      if (r.decision === '保留') {
        pmLedgerAppend_(ledger, Object.assign(base, { stage: PM.STAGE.HOLD, reasons: r.reasons.join(' / '), lookup_status: '' }));
        log.push(r.application_number + ' → 保留を記録');
        return;
      }
      var row = pmLedgerAppend_(ledger, Object.assign(base, {
        stage: PM.STAGE.PROCESSING, reasons: r.warnings.join(' / '),
        before_json: r.before ? JSON.stringify(r.before) : '', after_json: JSON.stringify(r.after), lookup_status: '' }));
      SpreadsheetApp.flush();
      pmWriteProduct_(sheet, r.before, r.after);
      SpreadsheetApp.flush();
      var now = pmReadProduct_(sheet, r.management_id);
      if (!now || !pmSameProduct_(now.values, r.after)) {
        pmLedgerUpdate_(ledger, row, { stage: PM.STAGE.ERROR, reasons: '書込み後の読み戻しが期待値と不一致' });
        throw new Error(r.application_number + ' の書込み後検証に失敗。以降の処理を中止');
      }
      pmLedgerUpdate_(ledger, row, { stage: PM.STAGE.APPLIED, lookup_status: '未反映' });
      log.push(r.application_number + ' → 反映 ' + r.management_id + (r.before
        ? '（' + r.diff.map(function (d) { return d.column + ' "' + d.before + '"→"' + d.after + '"'; }).join(', ') + '）'
        : '（新規追加: ' + r.after['型番'] + '）'));
    });
    // Step D：公開ファイルの再生成と rakumo 再取込（設定があるときだけ）
    var sp = PropertiesService.getScriptProperties();
    if (sp.getProperty(PM_RAKUMO.LOOKUP_PROPS.active) && sp.getProperty(PM_RAKUMO.LOOKUP_PROPS.inactive)) pmPublishRun_(props, book, log);
    else log.push('公開ファイルの設定（LOOKUP_*_SPREADSHEET_ID）がないため公開は行わない');
    return { log: log, judged: judged };
  } finally {
    lock.releaseLock();
  }
}

function pmOpenMasterForWrite_(props) {
  var id = props[PM.PROP.MASTER_ID];
  if (!id || id === props[PM.PROP.F2R_ID]) throw new Error('書込み先IDが不正（F-2R公開Sheetsには書き込まない）');
  return SpreadsheetApp.openById(id);
}

/* ---------- 処理台帳 ---------- */
function pmLedger_(book) {
  var sh = book.getSheetByName(PM.TAB.ledger);
  if (!sh) {
    sh = book.insertSheet(PM.TAB.ledger);
    sh.getRange(1, 1, 1, PM.LEDGER_HEADER.length).setNumberFormat('@').setValues([PM.LEDGER_HEADER]);
    sh.setFrozenRows(1);
  }
  var header = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getDisplayValues()[0];
  PM.LEDGER_HEADER.forEach(function (h, i) { if (header[i] !== h) throw new Error('処理台帳の見出しが想定と違う: ' + (i + 1) + '列目 "' + header[i] + '"（期待 "' + h + '"）'); });
  return sh;
}
function pmLedgerRows_(sh) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, PM.LEDGER_HEADER.length).getDisplayValues().map(function (v, i) {
    var o = { _row: i + 2 }; PM.LEDGER_HEADER.forEach(function (h, j) { o[h] = v[j]; }); return o;
  });
}
function pmLedgerAppend_(sh, rec) {
  var stamp = pmNowText_();
  rec.created_at = stamp; rec.updated_at = stamp;
  var row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, PM.LEDGER_HEADER.length).setNumberFormat('@')
    .setValues([PM.LEDGER_HEADER.map(function (h) { return rec[h] == null ? '' : String(rec[h]); })]);
  return row;
}
function pmLedgerUpdate_(sh, row, fields) {
  fields.updated_at = pmNowText_();
  Object.keys(fields).forEach(function (k) {
    var c = PM.LEDGER_HEADER.indexOf(k);
    if (c < 0) throw new Error('台帳の列がない: ' + k);
    sh.getRange(row, c + 1).setNumberFormat('@').setValue(String(fields[k]));
  });
}
function pmNowText_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX"); }

/* ---------- 前回の途中停止からの復旧 ---------- */
function pmRecover_(book, ledger, log) {
  var sheet = book.getSheetByName(PM.TAB.master);
  pmLedgerRows_(ledger).forEach(function (L) {
    if (L.stage === PM.STAGE.ERROR) throw new Error('処理台帳に「エラー」の行がある（' + L.application_number + '）。内容を確認し、対処してから台帳行を直すまで処理しない');
    if (L.stage !== PM.STAGE.PROCESSING) return;
    var after = JSON.parse(L.after_json), before = L.before_json ? JSON.parse(L.before_json) : null;
    var now = pmReadProduct_(sheet, L.management_id);
    if (now && pmSameProduct_(now.values, after)) {
      pmLedgerUpdate_(ledger, L._row, { stage: PM.STAGE.APPLIED, lookup_status: '未反映' });
      log.push('復旧: ' + L.application_number + ' は反映済みだったため台帳を更新');
      return;
    }
    var untouched = before ? (now && pmSameProduct_(now.values, before)) : !now;
    if (!untouched) {
      pmLedgerUpdate_(ledger, L._row, { stage: PM.STAGE.ERROR, reasons: '途中停止後に管理マスターが反映前とも反映後とも一致しない' });
      throw new Error('復旧不可: ' + L.application_number + '（' + L.management_id + '）。管理マスターを確認すること');
    }
    pmWriteProduct_(sheet, before, after);
    SpreadsheetApp.flush();
    var chk = pmReadProduct_(sheet, L.management_id);
    if (!chk || !pmSameProduct_(chk.values, after)) {
      pmLedgerUpdate_(ledger, L._row, { stage: PM.STAGE.ERROR, reasons: '復旧時の書込み後検証に失敗' });
      throw new Error('復旧時の書込み後検証に失敗: ' + L.application_number);
    }
    pmLedgerUpdate_(ledger, L._row, { stage: PM.STAGE.APPLIED, lookup_status: '未反映' });
    log.push('復旧: ' + L.application_number + ' を再反映');
  });
}

/* ---------- 管理マスターの読み書き ---------- */
function pmMasterHeader_(sheet) {
  var h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(function (x) { return String(x).trim(); });
  PM.COLUMNS.forEach(function (c) { if (h.indexOf(c) < 0) throw new Error('管理マスターに列がない: ' + c); });
  return h;
}
/** 管理コードで行を探す（見つからなければ null。重複は停止） */
function pmReadProduct_(sheet, managementId) {
  var h = pmMasterHeader_(sheet), n = sheet.getLastRow() - 1;
  if (n < 1) return null;
  var v = sheet.getRange(2, 1, n, h.length).getDisplayValues(), col = h.indexOf('管理コード'), hit = null;
  v.forEach(function (r, i) {
    if (String(r[col]).trim() !== managementId) return;
    if (hit) throw new Error('管理マスターで管理コード重複: ' + managementId);
    var o = {}; PM.COLUMNS.forEach(function (c) { o[c] = String(r[h.indexOf(c)]).trim(); });
    hit = { row: i + 2, values: o };
  });
  return hit;
}
function pmSameProduct_(a, b) { return PM.COLUMNS.every(function (c) { return String(a[c] || '') === String(b[c] || ''); }); }

/** before=null は新規追加、それ以外は差分セルだけ更新。値は書式なしテキストで書く（先頭0を保持） */
function pmWriteProduct_(sheet, before, after) {
  var h = pmMasterHeader_(sheet);
  if (!before) {
    if (pmReadProduct_(sheet, after['管理コード'])) throw new Error('追加しようとした管理コードが既にある: ' + after['管理コード']);
    var row = sheet.getLastRow() + 1;
    PM.COLUMNS.forEach(function (c) { sheet.getRange(row, h.indexOf(c) + 1).setNumberFormat('@').setValue(after[c]); });
    // 列「製品ステータス表示」など、上の行の数式を引き継ぐ
    var fcol = h.indexOf('製品ステータス表示');
    if (fcol >= 0 && row > 2) {
      var prev = sheet.getRange(row - 1, fcol + 1);
      if (prev.getFormula()) prev.copyTo(sheet.getRange(row, fcol + 1));
    }
    return;
  }
  var cur = pmReadProduct_(sheet, before['管理コード']);
  if (!cur) throw new Error('更新対象の管理コードがない: ' + before['管理コード']);
  if (!pmSameProduct_(cur.values, before)) throw new Error('更新直前の管理マスターが判定時と違う: ' + before['管理コード']);
  PM.COLUMNS.forEach(function (c) {
    if (String(before[c]) === String(after[c])) return;
    sheet.getRange(cur.row, h.indexOf(c) + 1).setNumberFormat('@').setValue(after[c]);
  });
}

/* ---------- バックアップ ---------- */
function pmBackup_(book) {
  var src = book.getSheetByName(PM.TAB.master);
  var name = PM.BACKUP_PREFIX + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  var copy = src.copyTo(book);
  copy.setName(name);
  copy.hideSheet();
  var olds = book.getSheets().map(function (s) { return s.getName(); })
    .filter(function (n) { return n.indexOf(PM.BACKUP_PREFIX) === 0; }).sort();
  olds.slice(0, Math.max(0, olds.length - PM.BACKUP_KEEP)).forEach(function (n) { book.deleteSheet(book.getSheetByName(n)); });
  return name;
}
