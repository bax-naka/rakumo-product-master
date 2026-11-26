// Webビューワ（viewer/）の試験。公開ファイル生成（gas/ の pmBuildPublic_）との一致、権限、読取専用であることを確認する。
const fs = require('fs'), path = require('path'), vm = require('vm');
const load = require('./harness');
const clone = (x) => JSON.parse(JSON.stringify(x));
let pass = 0, fail = 0;
function t(name, fn) { let ok, msg = ''; try { ok = fn(); } catch (e) { ok = false; msg = e.message; } console.log((ok ? 'PASS ' : 'FAIL ') + name + (msg ? ' / ' + msg : '')); ok ? pass++ : fail++; }
const VIEWER = path.join(__dirname, '..', 'viewer');
const src = (f) => fs.readFileSync(path.join(VIEWER, f), 'utf8');
const LEDGER = [
  ['flow_id', 'application_number', 'stage', 'updated_at'],
  ['text:1', 'SMSA00001', '保留', '2026-11-25T09:00:00+09:00'],
  ['text:2', 'SMSA00002', '完了', '2026-11-25T17:53:10+09:00'],
  ['text:3', 'SMSC00002', '完了', '2026-11-24T11:42:00+09:00'],
];
function books(withLedger = true) {
  const m = clone(require('../fixtures/master.json'));
  if (withLedger) m['処理台帳'] = clone(LEDGER);
  return { MASTER: m };
}
const PROPS = () => ({ MASTER_SPREADSHEET_ID: 'MASTER', ALLOWED_DOMAIN: 'example.co.jp' });
function viewer(b, props, email = 'user@example.co.jp') {
  const html = { evaluated: 0 };
  const extra = {
    Session: { getActiveUser: () => ({ getEmail: () => email }) },
    HtmlService: {
      createTemplateFromFile: (n) => ({ evaluate: () => { html.evaluated++; const o = { page: n, setTitle: () => o, addMetaTag: () => o }; return o; } }),
      createHtmlOutput: (s) => { const o = { text: s, setTitle: () => o }; return o; },
      createHtmlOutputFromFile: (n) => ({ getContent: () => src(n + '.html') }),
    },
    console: { log() {}, error() {} },
  };
  const g = load(b, props, { dir: 'viewer', extra });
  g.__html = html;
  return g;
}

// 公開ファイル生成（連携GAS）の結果
const gas = load(books(), { MASTER_SPREADSHEET_ID: 'MASTER' });
const pub = gas.pmBuildPublic_(gas.pmReadMaster_('MASTER'));

const g1 = viewer(books(), PROPS());
const r1 = g1.vmLoad();
const d1 = r1.data;
const rowsOf = (d, s) => d.rows.filter(r => r.s === s).map(r => r.v);

t('vmLoad が成功する', () => r1.ok === true);
t('有効一覧が公開ファイル（仮）と完全一致（値・行順）', () => JSON.stringify(rowsOf(d1, '有効')) === JSON.stringify(pub.active));
t('削除一覧が公開ファイル（削除）と完全一致（値・行順）', () => JSON.stringify(rowsOf(d1, '無効')) === JSON.stringify(pub.inactive));
t('件数（有効・無効・全件）', () => d1.counts.active === pub.active.length && d1.counts.inactive === pub.inactive.length &&
  d1.counts.all === d1.rows.length && d1.counts.all === pub.active.length + pub.inactive.length);
t('列は公開ファイルと同じ9列', () => d1.columns.join() === '型番,商品CD,製品ステータス,分類コード,大分類,提供先,顧客伺い,管理コード,U番号');
t('無効理由は既定で返す', () => d1.showReason === true && d1.rows.some(r => r.reason === 'もう使われることがない'));
t('最終反映＝処理台帳「完了」の最新（JST）', () => d1.lastApplied === '2026/11/25 17:53');
t('警告なし（正常データ）', () => d1.warnings.length === 0);
t('Sheets API 呼び出しは get 1回＋batchGet 1回', () => g1.__stats.get === 1 && g1.__stats.batchGet === 1);

t('SHOW_INACTIVE_REASON=false で無効理由を返さない', () => {
  const d = viewer(books(), Object.assign(PROPS(), { SHOW_INACTIVE_REASON: 'false' })).vmLoad().data;
  return d.showReason === false && d.rows.every(r => r.reason === '');
});
t('処理台帳タブが無くても表示できる（最終反映は空）', () => {
  const g = viewer(books(false), PROPS()); const r = g.vmLoad(); return r.ok && r.data.lastApplied === '' && g.__stats.batchGet === 1;
});
t('対応表にないコードは止めずに警告として返す', () => {
  const b = books(); const m = b.MASTER['管理マスター']; const i = m.findIndex((r, k) => k > 0 && r[9] === '有効'); m[i][2] = '99';
  const d = viewer(b, PROPS()).vmLoad().data;
  return d.rows.some(r => r.v[2] === '（未定義コード 99）') && d.warnings.some(w => /製品ステータスが対応表にない: 99/.test(w));
});
t('管理状態が不正な行は全件にだけ出て警告になる', () => {
  const b = books(); const m = b.MASTER['管理マスター']; m[1][9] = '保留中';
  const d = viewer(b, PROPS()).vmLoad().data;
  return d.counts.all === d.counts.active + d.counts.inactive + 1 && d.warnings.some(w => /管理状態が不正/.test(w));
});
t('必須列が無いと読み込みエラー（中身は利用者に見せない）', () => {
  const b = books(); b.MASTER['管理マスター'][0][0] = '型番X';
  const r = viewer(b, PROPS()).vmLoad(); return r.ok === false && !/型番/.test(r.error);
});

// 権限
t('他ドメインは拒否', () => viewer(books(), PROPS(), 'user@evil.example').vmLoad().ok === false);
t('似たドメイン（サブドメイン）も拒否', () => viewer(books(), PROPS(), 'user@x.example.co.jp').vmLoad().ok === false);
t('メールが取れない（空）なら拒否', () => viewer(books(), PROPS(), '').vmLoad().ok === false);
t('大文字のドメインは許可', () => viewer(books(), PROPS(), 'User@EXAMPLE.co.jp').vmLoad().ok === true);
t('ALLOWED_DOMAIN 未設定なら拒否', () => { const p = PROPS(); delete p.ALLOWED_DOMAIN; return viewer(books(), p).vmLoad().ok === false; });
t('拒否時は読取りもしない', () => { const g = viewer(books(), PROPS(), 'user@evil.example'); g.vmLoad(); return g.__stats.get === 0 && g.__stats.batchGet === 0; });
t('doGet: 許可ユーザーは画面、拒否ユーザーは定型文のみ', () => {
  const ok = viewer(books(), PROPS()).doGet(); const ng = viewer(books(), PROPS(), 'a@evil.example').doGet();
  return ok.page === 'Index' && ng.text === '設定または閲覧権限を確認してください。';
});

// 構造（読取専用・公開関数の固定）
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = strip(fs.readdirSync(VIEWER).filter(f => f.endsWith('.gs')).map(src).join('\n'));
t('公開関数は doGet / vmLoad / vmCheckSetup だけ', () => {
  const names = [...code.matchAll(/^function\s+([A-Za-z0-9_$]+)/gm)].map(m => m[1]).filter(n => !n.endsWith('_'));
  return names.sort().join() === 'doGet,vmCheckSetup,vmLoad';
});
t('書込み・外部通信系のサービスを使わない', () => !/\b(SpreadsheetApp|UrlFetchApp|MailApp|GmailApp|ScriptApp|DriveApp|DocumentApp|LockService)\b|\.(setProperty|deleteProperty|update|append|batchUpdate|clear)\s*\(/.test(code));
const man = JSON.parse(src('appsscript.json'));
t('scope は spreadsheets.readonly と userinfo.email だけ', () => man.oauthScopes.slice().sort().join() ===
  'https://www.googleapis.com/auth/spreadsheets.readonly,https://www.googleapis.com/auth/userinfo.email');
t('Webアプリは デプロイユーザー実行・ドメイン内のみ', () => man.webapp.executeAs === 'USER_DEPLOYING' && man.webapp.access === 'DOMAIN');
t('画面側は innerHTML / eval / document.write を使わない', () => !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/.test(strip(src('Client.html') + src('Index.html'))));
t('画面から呼ぶサーバー関数は vmLoad だけ', () => [...src('Client.html').matchAll(/\.(vm[A-Za-z]+)\(\)/g)].every(m => m[1] === 'vmLoad'));

// 画面側の純粋関数（検索・絞り込み・並べ替え）
const script = src('Client.html').replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
const cx = {}; vm.createContext(cx); vm.runInContext(script + '\nthis.PMV = PMV;', cx);
const P = cx.PMV;
t('検索は全角・半角・大小文字を区別しない', () => P.norm('ｍｋｙ４ａ') === 'MKY4A' && P.norm('ﾃｽﾄ') === 'テスト' && P.norm('　a　') === 'A');
t('検索: 型番の部分一致（全角入力）', () => {
  const hit = P.filter(d1.rows, 'all', 'ＰＤ０００１', {}); return hit.length > 0 && hit.every(r => r.v[7].indexOf('PD0001') >= 0);
});
t('検索: 空白区切りは AND', () => {
  const a = d1.rows.find(r => r.s === '有効' && r.v[1]);
  const hit = P.filter(d1.rows, 'active', a.v[0] + ' ' + a.v[7], {}); const none = P.filter(d1.rows, 'active', a.v[0] + ' ZZZZZZ', {});
  return hit.includes(a) && none.length === 0;
});
t('タブ: 有効/削除/全件の件数', () => P.filter(d1.rows, 'active', '', {}).length === d1.counts.active &&
  P.filter(d1.rows, 'inactive', '', {}).length === d1.counts.inactive && P.filter(d1.rows, 'all', '', {}).length === d1.counts.all);
t('絞り込み: 製品ステータス', () => { const v = '4:量産中'; const hit = P.filter(d1.rows, 'all', '', { status: v });
  return hit.length > 0 && hit.every(r => r.v[2] === v) && hit.length === d1.rows.filter(r => r.v[2] === v).length; });
t('絞り込み候補は数字順（10が9の後）', () => { const o = P.options(d1.rows, 'status'); const i9 = o.findIndex(x => /^9:/.test(x)), i10 = o.findIndex(x => /^10:/.test(x));
  return i10 < 0 || i9 < 0 || i10 > i9; });
t('並べ替え: 自然順・空欄は末尾・同値は元順', () => {
  const rows = [{ v: ['B10'], s: '有効' }, { v: [''], s: '有効' }, { v: ['B9'], s: '有効' }, { v: ['b9'], s: '有効' }];
  const a = P.sort(rows, 0, 'asc').map(r => r.v[0]).join(), d = P.sort(rows, 0, 'desc').map(r => r.v[0]).join();
  return a === 'B9,b9,B10,' && d === 'B10,B9,b9,';
});
t('列構成: 有効=9列 / 削除=+無効理由 / 全件=+管理状態+無効理由', () => {
  const k = (tab, show) => P.columnsFor(tab, { columns: d1.columns, showReason: show }).map(c => c.name).length;
  return k('active', true) === 9 && k('inactive', true) === 10 && k('all', true) === 11 && k('inactive', false) === 9 && k('all', false) === 10;
});

console.log(`\nviewer: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
