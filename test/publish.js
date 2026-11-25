// Step D（公開ファイル再生成・rakumo再取込）の試験。rakumo API は模擬サーバーで再現する。
const load = require('./harness');
const clone = (x) => JSON.parse(JSON.stringify(x));
let pass = 0, fail = 0;
function t(name, fn) { let ok, msg = ''; try { ok = fn(); } catch (e) { ok = false; msg = e.message; } console.log((ok ? 'PASS ' : 'FAIL ') + name + (msg ? ' / ' + msg : '')); ok ? pass++ : fail++; }
const PROPS = () => ({ F2R_SPREADSHEET_ID: 'F2R', MASTER_SPREADSHEET_ID: 'MASTER', PROCESS_START_AT: '2026-11-24T00:00:00+09:00', WRITE_ENABLED: 'true',
  LOOKUP_ACTIVE_SPREADSHEET_ID: 'LK_A', LOOKUP_INACTIVE_SPREADSHEET_ID: 'LK_I' });
const META = () => ({ MASTER: { formats: {}, formulas: { '管理マスター': { '287,12': '=X287' } }, hidden: {} } });
function world() {
  return { books: { F2R: clone(require('../fixtures/f2r.json')), MASTER: clone(require('../fixtures/master.json')), LK_A: { 'シート1': [] }, LK_I: { 'シート1': [] } },
           props: PROPS(), meta: META(), userProps: { RAKUMO_API_KEY: 'k', RAKUMO_API_SECRET: 's' },
           srv: { lk: { LK_A: { id: 'aaa111', rowCount: 209, lastRefreshed: '2026-11-20T08:57:25.611898Z', build: 0 },
                        LK_I: { id: 'bbb222', rowCount: 77, lastRefreshed: '2026-11-20T08:02:38.394401Z', build: 0 } },
                  posts: 0, gets: 0, buildPolls: 1, post400: 0, clock: Date.parse('2026-11-25T02:00:00Z') } };
}
function server(w) {
  const cols = ['型番', '商品CD', '製品ステータス', '分類コード', '大分類', '提供先', '顧客伺い', '管理コード', 'U番号'].map((l, i) => ({ id: String(i + 1), label: l }));
  const view = (ss) => { const x = w.srv.lk[ss]; const o = { id: x.id, spreadsheetId: ss, rowCount: x.rowCount, lastRefreshed: x.lastRefreshed, columns: w.srv.cols || cols };
    if (x.build > 0) o.isBuilding = true; return o; };
  return (url, o) => {
    const m = url.match(/lookup-data(?:\/([^/?]+))?(\/refresh)?/);
    if (!m[1]) return { code: 200, body: { items: Object.keys(w.srv.lk).filter(k => !w.srv.hide || w.srv.hide !== k).map(view) } };
    const ss = Object.keys(w.srv.lk).find(k => w.srv.lk[k].id === m[1]); if (!ss) return { code: 404, body: { status: 404, reason: 'NotFound' } };
    const x = w.srv.lk[ss];
    if (m[2]) { w.srv.posts++; if (w.srv.post400 > 0) { w.srv.post400--; return { code: 400, body: { reason: 'Building' } }; }
      if (x.build > 0) return { code: 400, body: { reason: 'Building' } };
      x.build = w.srv.buildPolls; x.pending = true; const v = view(ss); v.isBuilding = true; return { code: 200, body: v }; }
    w.srv.gets++;
    if (x.build > 0) { x.build--; if (x.build === 0 && x.pending) { x.pending = false; w.srv.clock += 60000;
      x.rowCount = w.srv.forceRows != null ? w.srv.forceRows : w.books[ss]['シート1'].filter(r => r.some(v => v)).length - 1; x.lastRefreshed = new Date(w.srv.clock).toISOString(); } }
    return { code: 200, body: view(ss) };
  };
}
function run(w, fn) { const g = load(w.books, w.props, { meta: w.meta, userProps: w.userProps, fetch: server(w) }); g.console = { log() {} }; return g[fn](); }
const ledger = (w) => { const L = w.books.MASTER['処理台帳'] || []; const h = L[0] || []; return L.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] || '']))); };
const pub = (w) => { const L = w.books.MASTER['公開状態'] || []; const h = L[0] || []; return Object.fromEntries(L.slice(1).map(r => [r[0], Object.fromEntries(h.map((k, i) => [k, r[i] || '']))])); };
const rows = (w, b) => w.books[b]['シート1'].filter(r => r.some(v => v));

// 1) 再取込OFF：書込み＋公開ファイル更新のみ
const w1 = world();
run(w1, 'pmApplyUpdates');
t('公開ファイル：有効210行・無効77行、見出しは公開9列', () => rows(w1, 'LK_A').length === 211 && rows(w1, 'LK_I').length === 78 && rows(w1, 'LK_A')[0].join('|') === '型番|商品CD|製品ステータス|分類コード|大分類|提供先|顧客伺い|管理コード|U番号');
t('公開ファイル：新規MKY4Aが末尾、名称付き表示', () => { const r = rows(w1, 'LK_A').slice(-1)[0]; return r.join('|') === 'MKY4A||3:開発中|111|1:IC製品|1:一般販売|1:変更後の通知|PD00287|'; });
t('公開ファイル：変更が反映（PD00282, PD00029）', () => { const f = (id) => rows(w1, 'LK_A').find(r => r[7] === id);
  return f('PD00282').slice(1, 7).join('|') === '112233|4:量産中|122|1:IC製品|2:販売先限定|2:変更前の顧客確認必須' && f('PD00029')[2] === '10:終了'; });
t('公開ファイル：分類コードの先頭0を保持（無効側 021）', () => rows(w1, 'LK_I').filter(r => /^0\d\d$/.test(r[3])).length === 25);
t('再取込OFFならPOSTしない／公開状態は取込待ち／台帳はファイル更新済み', () => w1.srv.posts === 0 && pub(w1).active.status === '取込待ち' && pub(w1).inactive.status === '取込待ち' &&
  ledger(w1).filter(r => r.stage === 'マスター反映済み').every(r => r.lookup_status === 'ファイル更新済み'));

// 2) 再取込ON
w1.props.LOOKUP_REFRESH_ENABLED = 'true';
run(w1, 'pmPublishLookups');
t('REFRESHを2件要求し、完了を確認して最新に', () => w1.srv.posts === 2 && pub(w1).active.status === '最新' && pub(w1).inactive.status === '最新' && pub(w1).active.lookup_id === 'aaa111');
t('処理台帳：反映3件が完了・反映済み、保留2件はそのまま', () => { const L = ledger(w1); return L.filter(r => r.stage === '完了' && r.lookup_status === '反映済み').length === 3 && L.filter(r => r.stage === '保留').length === 2; });
t('完了後も pmVerifyAgainstTestLedger は5/5', () => { const g = load(w1.books, w1.props, { meta: w1.meta, userProps: w1.userProps, fetch: server(w1) }); g.console = { log() {} }; return g.pmVerifyAgainstTestLedger().every(x => x.ok); });
const snapA = JSON.stringify(w1.books.LK_A), snapM = JSON.stringify(w1.books.MASTER), posts = w1.srv.posts;
run(w1, 'pmApplyUpdates');
t('再実行：変化なしなら公開ファイル・管理用ブックを書かず、POSTもしない', () => JSON.stringify(w1.books.LK_A) === snapA && JSON.stringify(w1.books.MASTER) === snapM && w1.srv.posts === posts);

// 3) 取込が遅い → 次回に完了確認（再POSTなし）
const w3 = world(); w3.props.LOOKUP_REFRESH_ENABLED = 'true'; w3.srv.buildPolls = 30;
run(w3, 'pmApplyUpdates');
t('取込が長引けば取込中のまま、台帳は完了にしない', () => pub(w3).active.status === '取込中' && w3.srv.posts === 2 && !ledger(w3).some(r => r.stage === '完了'));
w3.srv.lk.LK_A.build = 1; w3.srv.lk.LK_I.build = 1;
run(w3, 'pmPublishLookups');
t('次回：再POSTせずに完了を確認', () => w3.srv.posts === 2 && pub(w3).active.status === '最新' && ledger(w3).filter(r => r.stage === '完了').length === 3);

// 4) REFRESHが400（他で更新中）
const w4 = world(); w4.props.LOOKUP_REFRESH_ENABLED = 'true'; w4.srv.post400 = 2;
run(w4, 'pmApplyUpdates');
t('400なら例外にせず取込待ちのまま、次回に再要求して完了', () => { const s1 = pub(w4).active.status === '取込待ち'; run(w4, 'pmPublishLookups'); return s1 && pub(w4).active.status === '最新' && pub(w4).inactive.status === '最新'; });

// 5) 再取込後の行数不一致
const w5 = world(); w5.props.LOOKUP_REFRESH_ENABLED = 'true'; w5.srv.forceRows = 5;
run(w5, 'pmApplyUpdates');
t('rowCount不一致はエラー、台帳は完了にせず、以後はPOSTしない', () => { const p = w5.srv.posts; run(w5, 'pmPublishLookups');
  return pub(w5).active.status === 'エラー' && !ledger(w5).some(r => r.stage === '完了') && w5.srv.posts === p; });

// 6) ルックアップがLISTに無い
const w6 = world(); w6.props.LOOKUP_REFRESH_ENABLED = 'true'; w6.srv.hide = 'LK_I';
run(w6, 'pmApplyUpdates');
t('spreadsheetIdに一致するルックアップが無ければエラー', () => pub(w6).inactive.status === 'エラー' && /0件/.test(pub(w6).inactive.note));

// 7) 取込が30分以上終わらない
const w7 = world(); w7.props.LOOKUP_REFRESH_ENABLED = 'true'; w7.srv.buildPolls = 1e9;
run(w7, 'pmApplyUpdates');
const p7 = w7.books.MASTER['公開状態']; const ci = p7[0].indexOf('refresh_requested_at'); p7.slice(1).forEach(r => { r[ci] = '2026-11-24T00:00:00+09:00'; });
run(w7, 'pmPublishLookups');
t('取込が30分を超えても終わらなければエラー', () => pub(w7).active.status === 'エラー' && /分経っても/.test(pub(w7).active.note));

// 8) 安全装置
t('公開ファイルのIDが管理用ブックと同じなら停止', () => { const w = world(); w.props.LOOKUP_ACTIVE_SPREADSHEET_ID = 'MASTER';
  try { run(w, 'pmPublishLookups'); return false; } catch (e) { return /同じ/.test(e.message); } });
t('管理マスターに未定義コードがあれば公開ファイルを書かない', () => { const w = world(); w.books.MASTER['管理マスター'][5][2] = '99';
  try { run(w, 'pmPublishLookups'); return false; } catch (e) { return /対応表にない/.test(e.message) && !rows(w, 'LK_A').length; } });
t('WRITE_ENABLED未設定なら公開もしない', () => { const w = world(); delete w.props.WRITE_ENABLED; run(w, 'pmPublishLookups'); return !rows(w, 'LK_A').length && !w.books.MASTER['公開状態']; });
console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
