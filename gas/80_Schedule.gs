/**
 * 定期実行と通知（Step D）
 *
 * pmScheduledRun：時間主導トリガーから呼ぶ本番入口。WRITE_ENABLED=true のときだけ処理する。
 * 通知はマスター管理者（Script Property NOTIFY_EMAIL）だけに送る。成功時は送らない。
 *   - 今回の実行で新たに「保留」と記録した申請（申請番号・理由）
 *   - 今回の実行で新たに「エラー」になった公開先（ルックアップ）
 *   - 実行が例外で止まったとき（同じ内容は24時間に1回まで。正常に戻ったら解除）
 * トリガーの設置・解除は pmInstallTrigger / pmRemoveTriggers を手動で実行する。
 */
var PM_SCHED = {
  HANDLER: 'pmScheduledRun',
  EVERY_MINUTES: 15,
  NOTIFY_PROP: 'NOTIFY_EMAIL',
  LAST_ERROR_PROP: 'PM_LAST_ERROR',
  REPEAT_HOURS: 24,
  SUBJECT_PREFIX: '[製品マスター連携] '
};

function pmScheduledRun() {
  var props = pmProps_();
  if (!props[PM.PROP.WRITE_ENABLED]) { pmLog_('WRITE_ENABLED が true ではないため何もしません'); return; }
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
