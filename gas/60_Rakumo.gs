/**
 * rakumo ワークフロー API（Step D 準備：LookupData の読取のみ）
 * 仕様: https://sites.google.com/gigei.jp/rakumoapi （ワークフローAPI実装ガイド / rakumoAPI認証方式）
 *
 * 認証: Authorization: RWS <APIキー>:<署名>
 *   署名 = Base64( HMAC-SHA1( 秘密鍵, "METHOD\nContent-Type\nDate" ) )、Date は RFC822 GMT（±15分以内）
 * APIキー・秘密鍵はユーザープロパティ（実行者本人だけが読める）に保存する。Git・台帳・ログには出さない。
 */
var PM_RAKUMO = {
  BASE: 'https://a-rakumo.appspot.com/api/workflow/v1',
  KEY: 'RAKUMO_API_KEY',
  SECRET: 'RAKUMO_API_SECRET',
  CONTENT_TYPE: 'application/json',
  RETRY_STATUSES: [429, 500, 502, 503, 504],
  MAX_ATTEMPTS: 3,
  BACKOFF_MS: 1000,
  LOOKUP_PROPS: { active: 'LOOKUP_ACTIVE_SPREADSHEET_ID', inactive: 'LOOKUP_INACTIVE_SPREADSHEET_ID' }
};

/** 初回だけ：スクリプトプロパティに一時的に入れたキーを、ユーザープロパティへ移して削除する */
function pmMoveRakumoKeyToUserProperties() {
  var sp = PropertiesService.getScriptProperties(), up = PropertiesService.getUserProperties();
  var key = (sp.getProperty(PM_RAKUMO.KEY) || '').trim(), secret = (sp.getProperty(PM_RAKUMO.SECRET) || '').trim();
  if (key || secret) {
    if (!key || !secret) throw new Error('スクリプトプロパティに ' + PM_RAKUMO.KEY + ' と ' + PM_RAKUMO.SECRET + ' の両方を入れてから実行してください');
    up.setProperty(PM_RAKUMO.KEY, key);
    up.setProperty(PM_RAKUMO.SECRET, secret);
    sp.deleteProperty(PM_RAKUMO.KEY);
    sp.deleteProperty(PM_RAKUMO.SECRET);
    pmLog_('APIキーをユーザープロパティへ移し、スクリプトプロパティから削除しました（キー末尾 …' + key.slice(-4) + '）');
    return;
  }
  var k = up.getProperty(PM_RAKUMO.KEY);
  pmLog_(k ? 'ユーザープロパティにAPIキーが設定済みです（キー末尾 …' + k.slice(-4) + '）' : 'APIキーが未設定です。スクリプトプロパティに一時的に入れてから再実行してください');
}

function pmRakumoCreds_() {
  var up = PropertiesService.getUserProperties();
  var key = (up.getProperty(PM_RAKUMO.KEY) || '').trim(), secret = (up.getProperty(PM_RAKUMO.SECRET) || '').trim();
  if (!key || !secret) throw new Error('rakumo APIキーが未設定（pmMoveRakumoKeyToUserProperties で設定）');
  if (PropertiesService.getScriptProperties().getProperty(PM_RAKUMO.SECRET)) throw new Error('秘密鍵がスクリプトプロパティに残っている。pmMoveRakumoKeyToUserProperties を実行すること');
  return { key: key, secret: secret };
}

function pmHttpDate_() { return new Date().toUTCString(); }

function pmRakumoSign_(secret, method, contentType, date) {
  var msg = method.toUpperCase() + '\n' + contentType.split(';')[0].trim().toLowerCase() + '\n' + date;
  return Utilities.base64Encode(Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, msg, secret));
}

/** 1リクエスト。429/50x は指数バックオフで有限回再試行、40x は再試行しない。秘密情報はエラーに含めない */
function pmRakumoRequest_(method, path, payload) {
  var cred = pmRakumoCreds_(), url = PM_RAKUMO.BASE + path, last = null;
  for (var attempt = 0; attempt < PM_RAKUMO.MAX_ATTEMPTS; attempt++) {
    if (attempt) Utilities.sleep(PM_RAKUMO.BACKOFF_MS * Math.pow(2, attempt - 1));
    var date = pmHttpDate_();
    var opt = {
      method: method.toLowerCase(), muteHttpExceptions: true, escaping: false, contentType: PM_RAKUMO.CONTENT_TYPE,
      headers: { 'Content-Type': PM_RAKUMO.CONTENT_TYPE, 'Date': date,
                 'Authorization': 'RWS ' + cred.key + ':' + pmRakumoSign_(cred.secret, method, PM_RAKUMO.CONTENT_TYPE, date) }
    };
    if (payload !== undefined) opt.payload = JSON.stringify(payload);
    var res;
    try { res = UrlFetchApp.fetch(url, opt); }
    catch (e) { last = '通信エラー'; continue; }
    var code = res.getResponseCode(), body = res.getContentText();
    if (code >= 200 && code < 300) {
      try { return { status: code, json: body ? JSON.parse(body) : null }; }
      catch (e) { throw new Error('rakumo API 応答がJSONではない: ' + method + ' ' + path + ' HTTP ' + code); }
    }
    var reason = '';
    try { var j = JSON.parse(body); reason = [j.reason, j.message].filter(function (x) { return x; }).join(' / '); } catch (e) {}
    last = 'HTTP ' + code + (reason ? '（' + reason + '）' : '');
    if (PM_RAKUMO.RETRY_STATUSES.indexOf(code) < 0) {
      var err = new Error('rakumo API エラー: ' + method + ' ' + path + ' ' + last); err.httpStatus = code; throw err;
    }
  }
  var e2 = new Error('rakumo API 再試行上限: ' + method + ' ' + path + ' ' + last); e2.httpStatus = 0; throw e2;
}

function pmLookupList_() {
  var r = pmRakumoRequest_('GET', '/lookup-data?limit=100');
  var items = Array.isArray(r.json) ? r.json : (r.json && (r.json.items || r.json.lookupData || r.json.data)) || null;
  if (!items) throw new Error('LookupData LIST の応答形式が想定外。キー: ' + Object.keys(r.json || {}).join(', '));
  return items;
}
function pmLookupGet_(id) { return pmRakumoRequest_('GET', '/lookup-data/' + encodeURIComponent(id)).json; }

/** 読取のみ：テスト用ルックアップ2件のIDと状態を確認する（REFRESHは呼ばない） */
function pmCheckLookupData() {
  var sp = PropertiesService.getScriptProperties();
  var targets = Object.keys(PM_RAKUMO.LOOKUP_PROPS).map(function (k) {
    var id = (sp.getProperty(PM_RAKUMO.LOOKUP_PROPS[k]) || '').trim();
    if (!id) throw new Error('Script Property 未設定: ' + PM_RAKUMO.LOOKUP_PROPS[k]);
    return { role: k, spreadsheetId: id };
  });
  var list = pmLookupList_();
  pmLog_('LookupData LIST: ' + list.length + '件' + (list.length >= 100 ? '（上限100件に達した。取りこぼしの可能性あり）' : ''));
  var expectLabels = PM.LOOKUP_COLUMNS;
  targets.forEach(function (t) {
    var hits = list.filter(function (x) { return String(x.spreadsheetId) === t.spreadsheetId; });
    if (hits.length !== 1) { pmLog_('[' + t.role + '] spreadsheetId ' + t.spreadsheetId + ' に一致するルックアップが ' + hits.length + ' 件'); return; }
    var g = pmLookupGet_(hits[0].id);
    var labels = (g.columns || []).map(function (c) { return String(c.label); });
    pmLog_('[' + t.role + '] id=' + g.id + ' 名前=' + g.displayName + ' シート=' + g.worksheetTitle + ' 行数=' + g.rowCount +
           ' isBuilding=' + ('isBuilding' in g ? g.isBuilding : '（項目なし＝更新中ではない）') + ' lastRefreshed=' + g.lastRefreshed + ' updated=' + g.updated);
    pmLog_('    列: ' + labels.join(' / ') + (labels.join('|') === expectLabels.join('|') ? '  → 公開9列と一致' : '  → 公開9列と不一致（期待: ' + expectLabels.join(' / ') + '）'));
    pmLog_('    応答項目: ' + Object.keys(g).sort().join(', '));
  });
}
