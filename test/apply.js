// Step C（書込み）の試験。実データfixturesを複製して使い、管理マスター・処理台帳の変化を確認する。
const load = require('./harness');
const clone = (x) => JSON.parse(JSON.stringify(x));
const baseBooks = () => ({ F2R: clone(require('../fixtures/f2r.json')), MASTER: clone(require('../fixtures/master.json')) });
const PROPS = { F2R_SPREADSHEET_ID: 'F2R', MASTER_SPREADSHEET_ID: 'MASTER', PROCESS_START_AT: '2026-11-24T00:00:00+09:00', WRITE_ENABLED: 'true' };
const quiet = { log() {} };
let pass = 0, fail = 0;
function env(books, opts = {}, props = PROPS) {
  const meta = opts.meta || { MASTER: { formats: {}, formulas: { '管理マスター': { '287,12': "=IF(C287=\"\",\"\",IFERROR(VLOOKUP(C287,'ステータス対応'!$A$2:$B$9,2,FALSE),\"未定義コード\"))" } }, hidden: {} } };
  const g = load(books, props, Object.assign({}, opts, { meta })); g.console = quiet; return g;
}
function t(name, fn) { let ok, msg = ''; try { ok = fn(); } catch (e) { ok = false; msg = e.message; } console.log((ok ? 'PASS ' : 'FAIL ') + name + (msg ? ' / ' + msg : '')); ok ? pass++ : fail++; }
const M = (b) => b.MASTER['管理マスター'];
const prod = (b, id) => { const h = M(b)[0]; const r = M(b).find(x => x[7] === id); if (!r) return null; const o = {}; h.forEach((c, i) => o[c] = r[i] == null ? '' : r[i]); return o; };
const ledger = (b) => { const L = b.MASTER['処理台帳']; if (!L) return []; const h = L[0]; return L.slice(1).filter(r => r.some(v => v)).map(r => { const o = {}; h.forEach((c, i) => o[c] = r[i] || ''); return o; }); };
const stage = (b, no) => (ledger(b).find(r => r.application_number === no) || {}).stage;
const setFlow = (b, no, field, value) => { const s = b.F2R.control[1][0], fl = b.F2R['flows_' + s], h = fl[0]; fl.find(r => r[h.indexOf('application_number')] === no)[h.indexOf(field)] = value; };
const setItem = (b, no, itemId, value) => { const s = b.F2R.control[1][0], fl = b.F2R['flows_' + s], it = b.F2R['items_' + s], fh = fl[0], ih = it[0];
  const fid = fl.find(r => r[fh.indexOf('application_number')] === no)[fh.indexOf('flow_id')];
  it.find(r => r[ih.indexOf('flow_id')] === fid && r[ih.indexOf('item_id')] === 'text:' + itemId && r[ih.indexOf('row_kind')] === 'item')[ih.indexOf('value_json')] = value; };

t('WRITE_ENABLED未設定なら何も書かない', () => {
  const b = baseBooks(), before = JSON.stringify(b.MASTER); const g = env(b, {}, Object.assign({}, PROPS, { WRITE_ENABLED: '' }));
  g.pmApplyUpdates(); return JSON.stringify(b.MASTER) === before && g.__stats.writes === 0;
});
t('ロックが取れなければ何も書かない', () => {
  const b = baseBooks(), before = JSON.stringify(b.MASTER); const g = env(b, { lockFails: true });
  try { g.pmApplyUpdates(); return false; } catch (e) { return /ロック/.test(e.message) && JSON.stringify(b.MASTER) === before; }
});

const b1 = baseBooks(); const g1 = env(b1);
const masterBefore = clone(M(b1));
g1.pmApplyUpdates();
t('台帳：保留2件・反映済み3件', () => stage(b1, 'SMSA00001') === '保留' && stage(b1, 'SMSC00001') === '保留' &&
  ['SMSC00002', 'SMSA00002', 'SMSC00003'].every(n => stage(b1, n) === 'マスター反映済み') && ledger(b1).length === 5);
t('台帳：flow_idは text: 付き、反映分は lookup_status=未反映', () => ledger(b1).every(r => /^text:\d+$/.test(r.flow_id)) && ledger(b1).filter(r => r.stage === 'マスター反映済み').every(r => r.lookup_status === '未反映'));
t('PD00282：提供先・顧客伺い・商品CD・分類コードのみ変更', () => { const p = prod(b1, 'PD00282'), o = masterBefore.find(r => r[7] === 'PD00282');
  return p['提供先'] === '2' && p['顧客伺い'] === '2' && p['商品CD'] === '112233' && p['分類コード'] === '122' && p['型番'] === o[0] && p['製品ステータス'] === o[2] && p['U番号'] === (o[8] || '') && p['管理状態'] === '有効'; });
t('PD00029：製品ステータスのみ 9→10', () => { const p = prod(b1, 'PD00029'), o = masterBefore.find(r => r[7] === 'PD00029');
  return p['製品ステータス'] === '10' && ['型番', '商品CD', '分類コード', '大分類', '提供先', '顧客伺い', 'U番号'].every((c, i) => p[c] === (o[[0, 1, 3, 4, 5, 6, 8][i]] || '')); });
t('PD00287：288行目に追加、値が期待どおり', () => { const r = M(b1)[287]; const p = prod(b1, 'PD00287');
  return r && r[7] === 'PD00287' && p['型番'] === 'MKY4A' && p['製品ステータス'] === '3' && p['分類コード'] === '111' && p['大分類'] === '1' && p['提供先'] === '1' && p['顧客伺い'] === '1' && p['商品CD'] === '' && p['U番号'] === '' && p['管理状態'] === '有効'; });
t('新規行の製品ステータス表示はL列の数式を1行ずらして引継ぎ', () => /C288/.test(g1.__meta.MASTER.formulas['管理マスター']['288,12'] || ''));
t('変更していない行は同一（286行のうち2行だけ変化）', () => masterBefore.filter((r, i) => i > 0 && r.some(v => v) && JSON.stringify(r.slice(0, 10)) !== JSON.stringify(M(b1)[i].slice(0, 10))).length === 2);
t('バックアップタブを1つ作成し非表示', () => { const n = Object.keys(b1.MASTER).filter(k => k.startsWith('bk_管理マスター_')); return n.length === 1 && g1.__meta.MASTER.hidden[n[0]] && JSON.stringify(b1.MASTER[n[0]]) === JSON.stringify(masterBefore); });
t('F-2R公開Sheetsは無変更', () => JSON.stringify(b1.F2R) === JSON.stringify(baseBooks().F2R));
t('反映後の pmVerifyAgainstTestLedger は処理台帳と管理マスターで5/5', () => g1.pmVerifyAgainstTestLedger().every(x => x.ok));

const snap = JSON.stringify(b1.MASTER);
g1.pmApplyUpdates();
t('再実行しても何も変わらない（バックアップも増えない）', () => JSON.stringify(b1.MASTER) === snap);
setFlow(b1, 'SMSC00002', 'status', '5'); setFlow(b1, 'SMSA00002', 'status', '5');
g1.pmApplyUpdates();
t('status 2→5 になっても再処理しない', () => JSON.stringify(b1.MASTER) === snap);

t('先頭0の分類コードは文字列のまま（大分類0 → "011"）', () => { const b = baseBooks(); setItem(b, 'SMSA00002', 5, '"0:その他"'); env(b).pmApplyUpdates(); return prod(b, 'PD00287')['分類コード'] === '011' && prod(b, 'PD00287')['大分類'] === '0'; });
t('（モック確認）書式なしテキストにしないと先頭0が消える', () => { const b = baseBooks(); const g = env(b); g.SpreadsheetApp.openById('MASTER').getSheetByName('管理マスター').getRange(300, 4).setValue('011'); return M(b)[299][3] === '11'; });
t('管理コードは処理台帳の最大値も考慮して再利用しない', () => { const b = baseBooks();
  b.MASTER['処理台帳'] = [env(b).PM.LEDGER_HEADER, ['text:1', 'X', 'new', '2', '', '保留', '保留', 'PD00295', '', '', '', '', '', '', '']];
  env(b).pmApplyUpdates(); return !!prod(b, 'PD00296') && !prod(b, 'PD00287'); });

t('書込み前に停止 → 次回、台帳「処理中」から再反映（重複なし）', () => {
  const b = baseBooks(); let armed = true;
  const g = env(b, { hooks: { beforeSet: (s, r) => { if (armed && s === '管理マスター' && r === 288) { armed = false; throw new Error('simulated crash'); } } } });
  try { g.pmApplyUpdates(); return false; } catch (e) { if (!/simulated/.test(e.message)) throw e; }
  if (stage(b, 'SMSA00002') !== '処理中' || stage(b, 'SMSC00003')) return false;
  env(b).pmApplyUpdates();
  return stage(b, 'SMSA00002') === 'マスター反映済み' && stage(b, 'SMSC00003') === 'マスター反映済み' && M(b).filter(r => r[7] === 'PD00287').length === 1 && prod(b, 'PD00287')['型番'] === 'MKY4A';
});
t('書込み後・台帳更新前に停止 → 次回、反映済みと判断して台帳だけ更新', () => {
  const b = baseBooks(); let armed = true; const stageCol = 6; // F列 stage
  const g = env(b, { hooks: { beforeSet: (s, r, c, v) => { if (armed && s === '処理台帳' && c === stageCol && v === 'マスター反映済み' && r === 5) { armed = false; throw new Error('simulated crash'); } } } });
  try { g.pmApplyUpdates(); return false; } catch (e) { if (!/simulated/.test(e.message)) throw e; }
  const rows = M(b).filter(r => r[7] === 'PD00287').length;
  env(b).pmApplyUpdates();
  return rows === 1 && M(b).filter(r => r[7] === 'PD00287').length === 1 && stage(b, 'SMSA00002') === 'マスター反映済み' && stage(b, 'SMSC00003') === 'マスター反映済み';
});
t('途中停止後に管理マスターが別の値へ変わっていたら「エラー」で停止し、以後も止まる', () => {
  const b = baseBooks(); let armed = true;
  const g = env(b, { hooks: { beforeSet: (s, r) => { if (armed && s === '管理マスター' && r === 288) { armed = false; throw new Error('simulated crash'); } } } });
  try { g.pmApplyUpdates(); } catch (e) {}
  M(b).push(['手入力', '', '3', '111', '1', '1', '1', 'PD00287', '', '有効', '', '']);
  let e1 = null, e2 = null;
  try { env(b).pmApplyUpdates(); } catch (e) { e1 = e.message; }
  try { env(b).pmApplyUpdates(); } catch (e) { e2 = e.message; }
  return /復旧不可/.test(e1 || '') && /エラー/.test(e2 || '') && stage(b, 'SMSA00002') === 'エラー' && !stage(b, 'SMSC00003');
});
t('判定後に管理マスターが変わっていたら書かずに停止', () => {
  const b = baseBooks(); const g = env(b);
  const orig = g.pmReadMaster_; let done = false;
  g.pmReadMaster_ = function (id) { const r = orig(id); if (!done) { done = true; M(b).find(x => x[7] === 'PD00029')[1] = '999999'; } return r; };
  try { g.pmApplyUpdates(); return false; } catch (e) { return /判定時と違う/.test(e.message) && prod(b, 'PD00029')['製品ステータス'] === '9'; }
});
t('バックアップは最新5つだけ残す', () => {
  const b = baseBooks(); const g = env(b);
  for (let i = 0; i < 7; i++) { b.MASTER['処理台帳'] && delete b.MASTER['処理台帳']; b.MASTER['管理マスター'] = clone(require('../fixtures/master.json')['管理マスター']); g.pmApplyUpdates(); }
  return Object.keys(b.MASTER).filter(k => k.startsWith('bk_管理マスター_')).length === 5;
});
console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
