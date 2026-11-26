/**
 * 製品マスター Webビューワ（読取専用）
 *
 * - 管理用ブックの「管理マスター」「ステータス対応」「区分対応」「処理台帳」を読み、表示用に変換して返すだけ。
 * - 書込み系のサービス（SpreadsheetApp・UrlFetchApp・MailApp・ScriptApp など）は使わない。
 *   scope も spreadsheets.readonly と userinfo.email だけ。
 * - Webアプリは「デプロイしたユーザーとして実行」。google.script.run からは末尾が "_" でない関数を
 *   誰でも呼べるため、公開関数は doGet / vmLoad / vmCheckSetup の3つだけにしている（試験で固定）。
 *
 * Script Properties
 *   MASTER_SPREADSHEET_ID  管理用ブックのID（必須）
 *   ALLOWED_DOMAIN         閲覧を許すメールのドメイン（必須。例: example.co.jp）
 *   ALLOWED_EMAILS         ドメイン以外に閲覧を許すメールアドレス（任意。カンマ・空白・改行区切り）
 *   SHOW_INACTIVE_REASON   "false" のとき無効理由を返さない（既定は表示）
 */
var VM = {
  TITLE: '製品マスター',
  PROP: { MASTER_ID: 'MASTER_SPREADSHEET_ID', DOMAIN: 'ALLOWED_DOMAIN', EMAILS: 'ALLOWED_EMAILS', SHOW_REASON: 'SHOW_INACTIVE_REASON' },
  TAB: { master: '管理マスター', status: 'ステータス対応', category: '区分対応', ledger: '処理台帳' },
  // rakumoのルックアップ（公開ファイル）と同じ9列・同じ順
  COLUMNS: ['型番', '商品CD', '製品ステータス', '分類コード', '大分類', '提供先', '顧客伺い', '管理コード', 'U番号'],
  STATE: '管理状態',
  REASON: '無効理由',
  CODE_COLUMNS: { '製品ステータス': 'status', '大分類': 'category', '提供先': 'destination', '顧客伺い': 'customer' },
  CATEGORY_KEY: { '大分類': 'category', '提供先': 'destination', '顧客伺い': 'customer' },
  ACTIVE: '有効',
  INACTIVE: '無効',
  // 変更履歴：処理台帳で管理マスターへ反映済みの行だけ
  HISTORY_STAGES: ['完了', 'マスター反映済み'],
  HISTORY_KIND: { 'new': '新規登録', 'change': '変更', 'delete': '削除' }
};

function doGet() {
  try {
    var cfg = vmSettings_();
    vmAuthorize_(cfg);
    return HtmlService.createTemplateFromFile('Index').evaluate()
      .setTitle(VM.TITLE)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (e) {
    console.error('doGet: ' + (e && e.message));
    return HtmlService.createHtmlOutput('設定または閲覧権限を確認してください。').setTitle(VM.TITLE);
  }
}

/** 画面から呼ぶ唯一のデータ取得関数 */
function vmLoad() {
  try {
    var cfg = vmSettings_();
    vmAuthorize_(cfg);
    return { ok: true, data: vmBuild_(vmRead_(cfg.masterId), cfg) };
  } catch (e) {
    console.error('vmLoad: ' + (e && e.message));
    return { ok: false, error: '製品マスターを読み込めません。時間をおいて再読込してください。' };
  }
}

/** 管理者がエディタから実行する設定確認（初回の権限承認にも使う） */
function vmCheckSetup() {
  var cfg = vmSettings_();
  vmAuthorize_(cfg);
  var d = vmBuild_(vmRead_(cfg.masterId), cfg);
  console.log('設定OK: 有効 ' + d.counts.active + ' 件 / 無効 ' + d.counts.inactive + ' 件 / 全件 ' + d.counts.all + ' 件' +
              ' / 無効理由 ' + (cfg.showReason ? '表示' : '非表示') + ' / 最終反映 ' + (d.lastApplied || '記録なし') +
              (d.warnings.length ? '\n注意:\n - ' + d.warnings.join('\n - ') : ''));
}

function vmInclude_(name) {
  if (['Styles', 'Client'].indexOf(name) < 0) throw new Error('INVALID_TEMPLATE');
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function vmSettings_() {
  var p = PropertiesService.getScriptProperties();
  var masterId = String(p.getProperty(VM.PROP.MASTER_ID) || '').trim();
  var domain = String(p.getProperty(VM.PROP.DOMAIN) || '').trim().toLowerCase();
  if (!masterId) throw new Error('Script Property 未設定: ' + VM.PROP.MASTER_ID);
  if (!domain) throw new Error('Script Property 未設定: ' + VM.PROP.DOMAIN);
  var labels = domain.split('.');
  if (domain.length > 253 || labels.length < 2 ||
      labels.some(function (l) { return !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l); })) throw new Error('ALLOWED_DOMAIN が不正');
  var showReason = String(p.getProperty(VM.PROP.SHOW_REASON) || '').trim().toLowerCase() !== 'false';
  var emails = String(p.getProperty(VM.PROP.EMAILS) || '').split(/[\s,;]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
  emails.forEach(function (x) { if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)) throw new Error('ALLOWED_EMAILS に不正なアドレス: ' + x); });
  return { masterId: masterId, domain: domain, emails: emails, showReason: showReason };
}

/**
 * 許可ドメインのアカウントと、個別に許可したアドレスだけ通す。
 * Webアプリのアクセス設定（組織内）だけでは同じGWS組織の別会社も入れるため、ここで絞る。
 */
function vmAuthorize_(cfg) {
  var email = Session.getActiveUser().getEmail();
  if (typeof email !== 'string' || !email || email.length > 254 || /\s/.test(email)) throw new Error('ACCESS_DENIED');
  var parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64) throw new Error('ACCESS_DENIED');
  var lower = email.toLowerCase();
  if (parts[1].toLowerCase() === cfg.domain) return;
  if ((cfg.emails || []).indexOf(lower) >= 0) return;
  throw new Error('ACCESS_DENIED');
}

function vmQuote_(name) { return "'" + String(name).replace(/'/g, "''") + "'"; }

/** 必要なタブを1回のAPI呼び出しでまとめて読む（表示値＝文字列） */
function vmRead_(id) {
  var meta = Sheets.Spreadsheets.get(id, { fields: 'sheets.properties.title' });
  var titles = (meta.sheets || []).map(function (s) { return s.properties.title; });
  [VM.TAB.master, VM.TAB.status, VM.TAB.category].forEach(function (t) {
    if (titles.indexOf(t) < 0) throw new Error('タブがない: ' + t);
  });
  var want = [VM.TAB.master, VM.TAB.status, VM.TAB.category];
  if (titles.indexOf(VM.TAB.ledger) >= 0) want.push(VM.TAB.ledger);
  var res = Sheets.Spreadsheets.Values.batchGet(id, { ranges: want.map(vmQuote_), valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS' });
  var vr = res.valueRanges || [];
  if (vr.length !== want.length) throw new Error('読取結果の件数が要求と一致しない');
  var out = {};
  want.forEach(function (n, i) {
    out[n] = (vr[i].values || []).map(function (r) { return r.map(function (c) { return c == null ? '' : String(c); }); });
  });
  return out;
}

/** 行配列 → {header, records}。見出しの重複は止める */
function vmTable_(rows, name, required) {
  if (!rows || !rows.length) throw new Error('ヘッダーがない: ' + name);
  var header = rows[0].map(function (h) { return String(h).trim(); });
  var seen = {};
  header.forEach(function (h) { if (h && seen[h]) throw new Error('ヘッダー重複: ' + name + ' / ' + h); seen[h] = true; });
  (required || []).forEach(function (c) { if (!seen[c]) throw new Error(name + ' に列がない: ' + c); });
  var records = rows.slice(1).filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); }).map(function (r) {
    var o = {}; header.forEach(function (h, i) { if (h) o[h] = i < r.length ? String(r[i]) : ''; }); return o;
  });
  return { header: header, records: records };
}

/** rakumoのルックアップ取込規則（連携GASの pmRakumoNorm と同じ）＋前後空白除去 */
function vmNorm_(s) {
  s = String(s == null ? '' : s).replace(/　/g, ' ');
  s = s.replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  return s.replace(/[｡-ﾟ]+/g, function (m) { return m.normalize('NFKC'); }).trim();
}

function vmCodes_(books) {
  var codes = { status: {}, category: {}, destination: {}, customer: {} };
  vmTable_(books[VM.TAB.status], VM.TAB.status, ['内部コード', '公開表示']).records.forEach(function (r) {
    codes.status[r['内部コード'].trim()] = r['公開表示'].trim();
  });
  vmTable_(books[VM.TAB.category], VM.TAB.category, ['項目', '内部コード', '公開表示']).records.forEach(function (r) {
    var k = VM.CATEGORY_KEY[r['項目'].trim()];
    if (k) codes[k][r['内部コード'].trim()] = r['公開表示'].trim();
  });
  return codes;
}

/** JSTの "yyyy/MM/dd HH:mm" */
function vmJst_(t) {
  var s = new Date(t + 9 * 3600e3).toISOString();
  return s.slice(0, 4) + '/' + s.slice(5, 7) + '/' + s.slice(8, 10) + ' ' + s.slice(11, 16);
}

/** 処理台帳で「完了」になった最新の更新時刻（自動反映の最終時刻） */
function vmLastApplied_(rows) {
  if (!rows || !rows.length) return '';
  var t = vmTable_(rows, VM.TAB.ledger), best = null;
  t.records.forEach(function (r) {
    if (String(r.stage || '').trim() !== '完了') return;
    var x = Date.parse(String(r.updated_at || ''));
    if (!isNaN(x) && (best === null || x > best)) best = x;
  });
  return best === null ? '' : vmJst_(best);
}

/** 管理マスターの値（内部コード）→ 表示値 */
function vmDisplay_(codes, col, v) {
  v = String(v == null ? '' : v).trim();
  var key = VM.CODE_COLUMNS[col];
  if (key && v !== '') return codes[key][v] === undefined ? '（未定義コード ' + v + '）' : codes[key][v];
  return vmNorm_(v);
}

/**
 * 処理台帳 → 管理コードごとの変更履歴（新しい順）。
 * 反映済みの行だけを使い、before/after の差分を表示値で返す。壊れた行は飛ばして警告にする。
 */
function vmHistory_(rows, codes, showReason, warnings) {
  var out = {};
  if (!rows || !rows.length) return out;
  var cols = VM.COLUMNS.concat([VM.STATE]).concat(showReason ? [VM.REASON] : []);
  vmTable_(rows, VM.TAB.ledger).records.forEach(function (r) {
    if (VM.HISTORY_STAGES.indexOf(String(r.stage || '').trim()) < 0) return;
    var id = String(r.management_id || '').trim(), no = String(r.application_number || '').trim();
    var before, after;
    try { after = JSON.parse(r.after_json || 'null'); before = r.before_json ? JSON.parse(r.before_json) : null; }
    catch (e) { warnings.push('処理台帳の変更内容を読めない: ' + no); return; }
    if (!id || !after || typeof after !== 'object') { warnings.push('処理台帳の行が不完全: ' + no); return; }
    var changes = [];
    cols.forEach(function (c) {
      if (!(c in after) && !(before && c in before)) return;
      var b = before ? vmDisplay_(codes, c, before[c]) : '', a = vmDisplay_(codes, c, after[c]);
      if (c === VM.REASON) { b = before ? vmNorm_(before[c]) : ''; a = vmNorm_(after[c]); }
      if (a !== b) changes.push([c, b, a]);
    });
    var fk = String(r.form_key || '').trim(), t = Date.parse(String(r.decided_at || ''));
    (out[id] = out[id] || []).push({
      no: no,
      at: isNaN(t) ? '' : vmJst_(t),
      t: isNaN(t) ? 0 : t,
      kind: VM.HISTORY_KIND[fk] || (before ? '変更' : '新規登録'),
      changes: changes
    });
  });
  Object.keys(out).forEach(function (id) {
    out[id].sort(function (x, y) { return y.t - x.t; });
    out[id].forEach(function (h) { delete h.t; });
  });
  return out;
}

/** 画面用データ。値は公開ファイルと同じ変換（コード→公開表示、取込規則で正規化） */
function vmBuild_(books, cfg) {
  var codes = vmCodes_(books);
  var m = vmTable_(books[VM.TAB.master], VM.TAB.master, VM.COLUMNS.concat([VM.STATE]));
  var hasReason = m.header.indexOf(VM.REASON) >= 0;
  var showReason = cfg.showReason && hasReason;
  var rows = [], warnings = [], seen = {}, counts = { active: 0, inactive: 0, all: 0 };
  var history = vmHistory_(books[VM.TAB.ledger], codes, showReason, warnings);
  m.records.forEach(function (r) {
    var id = String(r['管理コード'] || '').trim();
    if (!id) return;
    if (seen[id]) warnings.push('管理コード重複: ' + id);
    seen[id] = true;
    var state = String(r[VM.STATE] || '').trim();
    if (state !== VM.ACTIVE && state !== VM.INACTIVE) warnings.push(id + ' の管理状態が不正: "' + state + '"');
    var values = VM.COLUMNS.map(function (c) {
      var v = String(r[c] == null ? '' : r[c]).trim(), key = VM.CODE_COLUMNS[c];
      if (key && v !== '') {
        if (codes[key][v] === undefined) { warnings.push(id + ' の' + c + 'が対応表にない: ' + v); return '（未定義コード ' + v + '）'; }
        return codes[key][v];
      }
      return vmNorm_(v);
    });
    rows.push({
      v: values,
      s: state,
      code: String(r['製品ステータス'] || '').trim(),
      reason: showReason ? vmNorm_(r[VM.REASON]) : '',
      h: history[id] || []
    });
    counts.all++;
    if (state === VM.ACTIVE) counts.active++; else if (state === VM.INACTIVE) counts.inactive++;
  });
  return {
    columns: VM.COLUMNS.slice(),
    rows: rows,
    counts: counts,
    showReason: showReason,
    lastApplied: vmLastApplied_(books[VM.TAB.ledger]),
    readAt: vmJst_(Date.now()),
    warnings: warnings
  };
}
