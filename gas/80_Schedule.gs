/**
 * 定期実行と通知（Step D）
 *
 * pmScheduledRun：時間主導トリガーから呼ぶ本番入口。WRITE_ENABLED=true のときだけ処理する。
 * 通知はマスター管理者（Script Property NOTIFY_EMAIL）だけに送る。成功時は送らない。
 *   - 今回の実行で新たに「保留」と記録した申請（申請番号・理由）
 *   - 今回の実行で新たに「エラー」になった公開先（ルックアップ）
 *   - 実行が例外で止まったとき（同じ内容は24時間に1回まで。正常に戻ったら解除）
 *   - F-2R の同期が止まっているとき（平日 9:30〜17:30 に最終同期が30分より古い。止まった1回につき1通、再開したら1通）
 * トリガーの設置・解除は pmInstallTrigger / pmRemoveTriggers を手動で実行する。
 */
var PM_SCHED = {
  HANDLER: 'pmScheduledRun',
  EVERY_MINUTES: 15,
  NOTIFY_PROP: 'NOTIFY_EMAIL',
  LAST_ERROR_PROP: 'PM_LAST_ERROR',
  REPEAT_HOURS: 24,
  SUBJECT_PREFIX: '[製品マスター連携] ',
  // F-2R 停止の検知。F-2R の定時実行は平日 9:00〜17:20 開始・5分ごと
  F2R_STALE_PROP: 'PM_F2R_STALE',
  F2R_STALE_MINUTES: 30,
  F2R_WATCH_FROM: 9 * 60 + 30,   // 9:30（JST、分）
  F2R_WATCH_TO: 17 * 60 + 30     // 17:30
};

/** 現在時刻（ms）。試験で差し替えられるよう関数にしている */
function pmNowMs_() { return Date.now(); }

/** JST の曜日（0=日）と、0時からの分 */
function pmJstClock_(ms) {
  var d = new Date(ms + 9 * 3600e3);
  return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function pmJstText_(ms) {
  var s = new Date(ms + 9 * 3600e3).toISOString();
  return s.slice(0, 10).replace(/-/g, '/') + ' ' + s.slice(11, 16);
}

/**
 * F-2R の最終同期が業務時間中に古くなっていないかを見て、止まっていれば管理者へ知らせる。
 * 同じ停止（同じ最終同期時刻）については1通だけ。再開したら再開の通知を1通送る。
 * 読み取りに失敗してもここでは止めない（本体の読み取りで同じ失敗が通知される）。
 */
function pmCheckF2rFresh_(props, nowMs) {
  var sp = PropertiesService.getScriptProperties();
  var alerted = sp.getProperty(PM_SCHED.F2R_STALE_PROP);
  var control;
  try { control = pmReadControl_(pmOpenBook_(props[PM.PROP.F2R_ID])); }
  catch (e) { pmLog_('F-2R の control を読めないため鮮度確認を省略: ' + (e && e.message)); return; }
  var lastText = String(control.last_sync_success_at || '').trim(), last = Date.parse(lastText);
  var ageMin = isNaN(last) ? Infinity : (nowMs - last) / 60000;
  var stale = ageMin > PM_SCHED.F2R_STALE_MINUTES;
  if (!stale) {
    if (alerted) {
      sp.deleteProperty(PM_SCHED.F2R_STALE_PROP);
      pmSendMail_('F-2R 同期再開', ['F-2R の同期が再開しました。', '', '最終同期（JST）: ' + pmJstText_(last)]);
    }
    return;
  }
  var c = pmJstClock_(nowMs);
  var watching = c.day >= 1 && c.day <= 5 && c.minutes >= PM_SCHED.F2R_WATCH_FROM && c.minutes <= PM_SCHED.F2R_WATCH_TO;
  if (!watching || alerted === lastText) return;
  sp.setProperty(PM_SCHED.F2R_STALE_PROP, lastText);
  pmSendMail_('F-2R 同期停止', [
    'F-2R（rakumoワークフロー同期）の同期が止まっています。止まっている間は、申請の承認が製品マスターに反映されません。', '',
    '最終同期（JST）: ' + (isNaN(last) ? '読み取れない（' + lastText + '）' : pmJstText_(last) + '（' + Math.floor(ageMin) + '分前）'), '',
    '考えられる原因:',
    '  - F-2R を動かしている PC の電源断・スリープ・ネットワーク切断',
    '  - 処理の途中停止による停止ラッチ（data/phase_f2r/schedule_halt.json）が残っている',
    '  - rakumo / Google 側の障害', '',
    '確認: タスクスケジューラ「Rakumo review F2R continuous 5m」の状態と、上記ラッチの有無。',
    'この停止について再通知はしません。同期が再開したら再開の通知を送ります。']);
}



function pmScheduledRun() {
  var props = pmProps_();
  if (!props[PM.PROP.WRITE_ENABLED]) { pmLog_('WRITE_ENABLED が true ではないため何もしません'); return; }
  pmCheckF2rFresh_(props, pmNowMs_());
  var res;
  try {
    res = pmApplyRun_(props);
  } catch (e) {
    pmNotifyError_(e);
    throw e;
  }
  res.log.forEach(pmLog_);
  PropertiesService.getScriptProperties().deleteProperty(PM_SCHED.LAST_ERROR_PROP);
  var holds = res.judged.results.filter(function (r) { return r.decision === '保留'; });
  var lines = [];
  if (holds.length) {
    lines.push('保留にした申請（管理マスターは更新していません）:');
    holds.forEach(function (r) { lines.push('・' + r.application_number + '（' + r.form_key + '、決裁 ' + r.decided_at + '）'); r.reasons.forEach(function (x) { lines.push('    - ' + x); }); });
    lines.push('', '対応: 申請者に確認のうえ、必要なら再申請してもらってください。同じ申請を再判定する場合は処理台帳の該当行を削除します。');
  }
  if (res.publishErrors && res.publishErrors.length) {
    if (lines.length) lines.push('');
    lines.push('ルックアップ公開のエラー:');
    res.publishErrors.forEach(function (x) { lines.push('・' + x); });
    lines.push('', '対応: 管理用ブックの「公開状態」タブを確認し、原因を取り除いたら status を「取込待ち」に直してください。');
  }
  if (lines.length) pmSendMail_((holds.length ? '保留 ' + holds.length + '件' : '') + (res.publishErrors.length ? (holds.length ? '・' : '') + '公開エラー' : ''), lines);
}

function pmNotifyError_(e) {
  var sp = PropertiesService.getScriptProperties(), sig = String(e && e.message || e).slice(0, 500), now = Date.parse(pmNowText_());
  var last = null; try { last = JSON.parse(sp.getProperty(PM_SCHED.LAST_ERROR_PROP) || 'null'); } catch (x) {}
  if (last && last.sig === sig && now - last.at < PM_SCHED.REPEAT_HOURS * 3600e3) return;
  sp.setProperty(PM_SCHED.LAST_ERROR_PROP, JSON.stringify({ sig: sig, at: now }));
  pmSendMail_('実行エラー', ['定期実行がエラーで止まりました。解消するまで管理マスター・ルックアップは更新されません。', '',
    sig, '', '対応: Apps Script の実行ログと、管理用ブックの「処理台帳」「公開状態」タブを確認してください。',
    '同じエラーが続く間は、' + PM_SCHED.REPEAT_HOURS + '時間ごとに再通知します。']);
}

function pmSendMail_(subject, lines) {
  var to = (PropertiesService.getScriptProperties().getProperty(PM_SCHED.NOTIFY_PROP) || '').trim();
  if (!to) { pmLog_('[通知先未設定] ' + subject + '\n' + lines.join('\n')); return; }
  MailApp.sendEmail({ to: to, subject: PM_SCHED.SUBJECT_PREFIX + subject, body: lines.join('\n') + '\n\n（この通知は製品マスター連携GASが自動送信しています）' });
}

/** 通知のテスト送信 */
function pmSendTestMail() { pmSendMail_('テスト送信', ['通知の送信テストです。']); }

/** トリガー設置（既存の同じ関数のトリガーは先に削除して1本だけにする） */
function pmInstallTrigger() {
  pmRemoveTriggers();
  ScriptApp.newTrigger(PM_SCHED.HANDLER).timeBased().everyMinutes(PM_SCHED.EVERY_MINUTES).create();
  pmLog_('時間主導トリガーを設置しました（' + PM_SCHED.EVERY_MINUTES + '分ごとに ' + PM_SCHED.HANDLER + '）');
}
function pmRemoveTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === PM_SCHED.HANDLER) { ScriptApp.deleteTrigger(t); n++; } });
  pmLog_('トリガーを' + n + '件削除しました');
}
