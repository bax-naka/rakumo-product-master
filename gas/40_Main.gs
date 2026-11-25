/**
 * 実行用の関数（エディタの関数選択から実行する）
 *   1. pmCheckSetup                 … 設定と読取権限の確認
 *   2. pmPreviewUpdates             … 処理候補の判定と更新プレビュー（書き込みなし）
 *   3. pmVerifyAgainstTestLedger    … テスト台帳の期待結果との突き合わせ（反映後は処理台帳と管理マスターで確認）
 *   4. pmApplyUpdates               … 管理マスター・処理台帳への書き込み（WRITE_ENABLED=true のときだけ）
 *                                      続けて公開ファイル再生成、LOOKUP_REFRESH_ENABLED=true なら rakumo 再取込
 *   5. pmPublishLookups             … 公開ファイル再生成・再取込だけを実行（WRITE_ENABLED=true のときだけ）
 *   rakumo API: 60_Rakumo.gs の pmMoveRakumoKeyToUserProperties / pmCheckLookupData
 */
function pmCheckSetup() {
  var props = pmProps_();
  var f2r = pmReadF2r_(props[PM.PROP.F2R_ID]);
  var c = f2r.control;
  pmLog_('F-2R: 有効スロット=' + f2r.slot + ' 世代=' + c.generation + ' flows=' + c.flows_count + ' items=' + c.items_count +
         ' 最終同期=' + c.last_sync_success_at + ' 最終公開=' + c.last_publish_at + ' → 整合OK');
  var m = pmReadMaster_(props[PM.PROP.MASTER_ID]);
  var n = Object.keys(m.products).length, valid = Object.keys(m.products).filter(function (k) { return m.products[k]['管理状態'] === '有効'; }).length;
  pmLog_('管理マスター: ' + n + '件（有効 ' + valid + ' / 無効 ' + (n - valid) + '）');
  pmLog_('対象Form: ' + JSON.stringify(m.forms));
  pmLog_('項目マッピング: ' + Object.keys(m.mapping).map(function (k) { return k + '=' + Object.keys(m.mapping[k]).length + 'キー'; }).join(', '));
  pmLog_('処理台帳: ' + (m.hasLedgerTab ? Object.keys(m.ledgerIds).length + '件' : 'タブなし（全件未処理として扱う）') + ' / テスト台帳: ' + m.tests.length + '件');
  pmLog_('開始基準: ' + props[PM.PROP.START_AT] + ' / 書込み: ' + (props[PM.PROP.WRITE_ENABLED] ? '有効' : '無効（WRITE_ENABLED≠true）'));
  var j = pmJudgeAll(f2r, m, { startAt: props[PM.PROP.START_AT] });
  j.warnings.forEach(function (w) { pmLog_('[警告] ' + w); });
  pmLog_('設定確認 完了（警告 ' + j.warnings.length + '件、判定対象 ' + j.results.length + '件）');
}

function pmPreviewUpdates() {
  var run = pmRun_();
  var j = run.judged;
  pmLog_('=== 更新プレビュー（書き込みなし）=== F-2R世代 ' + run.f2r.control.generation + ' / スロット ' + run.f2r.slot);
  j.warnings.forEach(function (w) { pmLog_('[警告] ' + w); });
  pmLog_('対象外 ' + j.excluded.length + '件: ' + j.excluded.map(function (e) { return e[0].application_number + '（' + e[1] + '）'; }).join(', '));
  pmLog_('判定対象 ' + j.results.length + '件（決裁日時順）');
  j.results.forEach(function (r) {
    pmLog_('--- ' + r.application_number + ' [' + r.form_key + '] status=' + r.status + ' 決裁=' + r.decided_at + ' → ' + r.decision +
           (r.management_id ? ' ' + r.management_id : ''));
    r.diff.forEach(function (d) { pmLog_('    ' + d.column + ': "' + d.before + '" → "' + d.after + '"'); });
    r.reasons.forEach(function (x) { pmLog_('    [保留理由] ' + x); });
    r.warnings.forEach(function (x) { pmLog_('    [注意] ' + x); });
  });
  pmLog_('次に採番される管理コード（プレビュー上）: ' + j.nextManagementId);
  return j;
}

function pmVerifyAgainstTestLedger() {
  var run = pmRun_();
  var v = pmVerify(run.judged, run.master);
  v.forEach(function (x) {
    pmLog_((x.ok ? 'PASS ' : 'FAIL ') + x.application_number + (x.result ? ' → ' + x.result.decision : ''));
    x.fails.forEach(function (f) { pmLog_('    ' + f); });
  });
  var ng = v.filter(function (x) { return !x.ok; }).length;
  pmLog_('結果: ' + (v.length - ng) + '/' + v.length + ' PASS');
  if (!v.length) pmLog_('テスト台帳が空です');
  return v;
}

function pmApplyUpdates() {
  var props = pmProps_();
  if (!props[PM.PROP.WRITE_ENABLED]) {
    pmLog_('WRITE_ENABLED が true ではないため書き込みません。プレビューだけ表示します。');
    return pmPreviewUpdates();
  }
  pmLog_('=== 書込み実行 ===');
  var res = pmApplyRun_(props);
  res.log.forEach(pmLog_);
  pmLog_('完了。結果は処理台帳タブで確認できます。');
  return res;
}

function pmRun_() {
  var props = pmProps_();
  var f2r = pmReadF2r_(props[PM.PROP.F2R_ID]);
  var master = pmReadMaster_(props[PM.PROP.MASTER_ID]);
  return { f2r: f2r, master: master, judged: pmJudgeAll(f2r, master, { startAt: props[PM.PROP.START_AT] }) };
}

function pmLog_(s) { console.log(s); }
