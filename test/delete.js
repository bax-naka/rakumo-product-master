// 削除・復帰申請（form_key = delete_restore）の判定・書込み・公開・ビューワ履歴の試験。
// 実データ fixtures を複製し、F-2R 公開データに合成の申請（Form・Flow・項目）を足して使う。
const load = require('./harness');
const clone = (x) => JSON.parse(JSON.stringify(x));
const PROPS = { F2R_SPREADSHEET_ID: 'F2R', MASTER_SPREADSHEET_ID: 'MASTER', PROCESS_START_AT: '2026-11-24T00:00:00+09:00', WRITE_ENABLED: 'true' };
const FORM = 'text:6678665431547904', CAT = 'text:6076973740654592';
const IDS = { kind: '3', del: '4', res: '5', copy: '6', reason: '7' };
let pass = 0, fail = 0, seq = 0;
function t(name, fn) { let ok, msg = ''; try { ok = fn(); } catch (e) { ok = false; msg = e.message; } console.log((ok ? 'PASS ' : 'FAIL ') + name + (msg ? ' / ' + msg : '')); ok ? pass++ : fail++; }

function books() {
  const b = { F2R: clone(require('../fixtures/f2r.json')), MASTER: clone(require('../fixtures/master.json')), LK_A: { 'シート1': [] }, LK_I: { 'シート1': [] } };
  b.MASTER['対象Form'].push(['delete_restore', FORM, '製品マスター 削除・復帰申請', CAT, 'validation', 'TRUE', '']);
  [['kind', 'value', IDS.kind], ['target_delete', 'lookup', IDS.del], ['target_restore', 'lookup', IDS.res],
   ['management_id', 'lookup_copy', IDS.copy], ['reason', 'value', IDS.reason]]
    .forEach(([k, role, id]) => b.MASTER['項目マッピング'].push(['delete_restore', k, role, id, '', '', '', '', '']));
  const s = slot(b), fm = b.F2R['forms_' + s], h = fm[0], row = fm[1].slice();
  row[h.indexOf('form_id')] = FORM; row[h.indexOf('form_name')] = '製品マスター 削除・復帰申請'; row[h.indexOf('category_id')] = CAT;
  row[h.indexOf('review_role')] = 'validation'; row[h.indexOf('metadata_json')] = '{}';
  fm.push(row); bump(b, 'forms_count', 1);
  return b;
}
const slot = (b) => b.F2R.control[1][0];
function bump(b, key, n) { const c = b.F2R.control, i = c[0].indexOf(key); c[1][i] = String(Number(c[1][i]) + n); }
function gen(b) { return b.F2R.control[1][b.F2R.control[0].indexOf('generation')]; }

/** 公開ファイルと同じ表示値で、ルックアップのスナップショット（columns）を作る */
function snapshot(b, id) {
  const g = load(b, PROPS); g.console = { log() {} };
  const pub = g.pmBuildPublic_(g.pmReadMaster_('MASTER'));
  const row = pub.active.concat(pub.inactive).find(r => r[7] === id);
  const cols = ['型番', '商品CD', '製品ステータス', '分類コード', '大分類', '提供先', '顧客伺い', '管理コード', 'U番号'];
  return { kind: 'workflow#lookupdataitem', columns: cols.map((c, i) => ({ id: String(i + 1), label: c, value: row[i] })) };
}
/** 合成の申請を1件足す。v: { kind, del, res, copy, reason }（undefined の項目は作らない） */
function addFlow(b, no, v, decided = '2026-11-26T01:00:00Z') {
  const s = slot(b), fl = b.F2R['flows_' + s], fh = fl[0], it = b.F2R['items_' + s], ih = it[0];
  const fid = 'text:99000000000000' + String(++seq).padStart(2, '0');
  const f = fh.map(() => '');
  Object.assign(f, { [fh.indexOf('export_id')]: fl[1][fh.indexOf('export_id')], [fh.indexOf('schema_version')]: 'f2r-1', [fh.indexOf('generation')]: gen(b),
    [fh.indexOf('flow_id')]: fid, [fh.indexOf('application_number')]: no, [fh.indexOf('title')]: no, [fh.indexOf('form_id')]: FORM,
    [fh.indexOf('category_id')]: CAT, [fh.indexOf('status')]: '5', [fh.indexOf('app_date')]: decided, [fh.indexOf('updated')]: decided,
    [fh.indexOf('final_decision_date')]: decided, [fh.indexOf('review_role')]: 'validation' });
  fl.push(f); bump(b, 'flows_count', 1);
  const item = (id, name, type, value) => {
    const r = ih.map(() => '');
    Object.assign(r, { [ih.indexOf('export_id')]: it[1][ih.indexOf('export_id')], [ih.indexOf('schema_version')]: 'f2r-1', [ih.indexOf('generation')]: gen(b),
      [ih.indexOf('flow_id')]: fid, [ih.indexOf('item_id')]: 'text:' + id, [ih.indexOf('row_kind')]: 'item', [ih.indexOf('item_name')]: name,
      [ih.indexOf('item_type')]: type, [ih.indexOf('value_json')]: value, [ih.indexOf('definition_json')]: '{}', [ih.indexOf('form_id')]: FORM });
    it.push(r); bump(b, 'items_count', 1);
  };
  if (v.kind !== undefined) item(IDS.kind, '削除・復帰', 'RadioItem', JSON.stringify(v.kind));
  if (v.del !== undefined) item(IDS.del, '削除型番', 'LookupDataItem', v.del === null ? 'null' : JSON.stringify(v.del));
  if (v.res !== undefined) item(IDS.res, '復帰型番', 'LookupDataItem', v.res === null ? 'null' : JSON.stringify(v.res));
  if (v.copy !== undefined) item(IDS.copy, '管理コード', 'StringItem', JSON.stringify(v.copy));
  if (v.reason !== undefined) item(IDS.reason, '理由', 'TextItem', JSON.stringify(v.reason));
}
function judge(b) { const g = load(b, PROPS); g.console = { log() {} }; return g.pmRun_().judged; }
const result = (j, no) => j.results.find(r => r.application_number === no);
const master = (b) => { const m = b.MASTER['管理マスター'], h = m[0]; return m.slice(1).filter(r => r[7]).map(r => Object.fromEntries(h.map((c, i) => [c, r[i] == null ? '' : r[i]]))); };
const ACTIVE = (b) => master(b).find(p => p['管理状態'] === '有効')['管理コード'];
const INACTIVE = (b) => master(b).find(p => p['管理状態'] === '無効')['管理コード'];

// ---- 判定 ----
{
  const b = books(), id = ACTIVE(b);
  addFlow(b, 'SMSD00001', { kind: '削除', del: snapshot(b, id), res: null, copy: id, reason: '  生産終了のため\r\n後継品へ移行  ' });
  const r = result(judge(b), 'SMSD00001');
  t('削除：有効な製品は反映（管理状態→無効、無効理由＝申請理由）', () => r.decision === '反映' && r.management_id === id && r.after['管理状態'] === '無効' && r.after['無効理由'] === '生産終了のため\n後継品へ移行');
  t('削除：変わるのは管理状態と無効理由だけ', () => JSON.stringify(r.diff.map(d => d.column)) === JSON.stringify(['管理状態', '無効理由']));
}
{
  const b = books(), id = INACTIVE(b);
  addFlow(b, 'SMSD00002', { kind: '復帰', del: null, res: snapshot(b, id), copy: id, reason: '再販が決まったため' });
  const r = result(judge(b), 'SMSD00002');
  t('復帰：無効な製品は反映（管理状態→有効、無効理由を空に）', () => r.decision === '反映' && r.after['管理状態'] === '有効' && r.after['無効理由'] === '' && r.diff.some(d => d.column === '管理状態'));
}
const hold = (name, setup, pattern) => {
  const b = books(); setup(b);
  const r = result(judge(b), 'SMSD09999');
  t(name, () => r && r.decision === '保留' && r.reasons.some(x => pattern.test(x)) || (console.log('    ', r && r.reasons), false));
};
hold('保留：削除なのに対象が無効（状態不一致）', b => { const id = INACTIVE(b); addFlow(b, 'SMSD09999', { kind: '削除', del: snapshot(b, id), copy: id, reason: 'x' }); }, /削除できる状態ではない/);
hold('保留：復帰なのに対象が有効（二重申請など）', b => { const id = ACTIVE(b); addFlow(b, 'SMSD09999', { kind: '復帰', res: snapshot(b, id), copy: id, reason: 'x' }); }, /復帰できる状態ではない/);
hold('保留：区分が空', b => { const id = ACTIVE(b); addFlow(b, 'SMSD09999', { kind: '', del: snapshot(b, id), copy: id, reason: 'x' }); }, /区分（削除・復帰） が空/);
hold('保留：区分が想定外の値', b => { const id = ACTIVE(b); addFlow(b, 'SMSD09999', { kind: '抹消', del: snapshot(b, id), copy: id, reason: 'x' }); }, /値が不正/);
hold('保留：区分側のルックアップが未選択', b => { addFlow(b, 'SMSD09999', { kind: '削除', del: null, res: null, reason: 'x' }); }, /選ばれていない/);
hold('保留：反対側のルックアップにも製品がある', b => { const a = ACTIVE(b), i = INACTIVE(b); addFlow(b, 'SMSD09999', { kind: '削除', del: snapshot(b, a), res: snapshot(b, i), copy: a, reason: 'x' }); }, /反対側/);
hold('保留：申請後に管理マスターが変わった（スナップショット不一致）', b => { const id = ACTIVE(b); const s = snapshot(b, id); s.columns[0].value += '-OLD'; addFlow(b, 'SMSD09999', { kind: '削除', del: s, copy: id, reason: 'x' }); }, /申請時の値が管理マスターと不一致: 型番/);
hold('保留：管理コード欄とルックアップが不一致', b => { const id = ACTIVE(b); addFlow(b, 'SMSD09999', { kind: '削除', del: snapshot(b, id), copy: 'PD99999', reason: 'x' }); }, /管理コード項目とルックアップ/);
hold('保留：管理コードが管理マスターにない', b => { const id = ACTIVE(b); const s = snapshot(b, id); s.columns[7].value = 'PD99999'; addFlow(b, 'SMSD09999', { kind: '削除', del: s, reason: 'x' }); }, /管理マスターにない/);
hold('保留：理由が空', b => { const id = ACTIVE(b); addFlow(b, 'SMSD09999', { kind: '削除', del: snapshot(b, id), copy: id, reason: '   ' }); }, /理由 が空/);
hold('保留：ルックアップの列が足りない', b => { const id = ACTIVE(b); const s = snapshot(b, id); s.columns.pop(); addFlow(b, 'SMSD09999', { kind: '削除', del: s, copy: id, reason: 'x' }); }, /ルックアップに列がない: U番号/);
{
  const b = books(), id = INACTIVE(b), p = master(b).find(x => x['管理コード'] === id), other = ACTIVE(b);
  // 有効な別製品の型番を、無効製品と同じにした状態は管理マスター自体が不正（型番重複）として読み込みで止まる
  b.MASTER['管理マスター'].find(r => r[7] === other)[0] = p['型番'];
  addFlow(b, 'SMSD09998', { kind: '復帰', res: snapshot(b, id), copy: id, reason: 'x' });
  let err = null; try { judge(b); } catch (e) { err = e; }
  t('型番が重複した管理マスターは判定前に止まる（復帰による重複は起きない前提を担保）', () => err && /型番重複/.test(err.message));
}
{
  const b = books(), id = ACTIVE(b), snap = snapshot(b, id);
  addFlow(b, 'SMSD00011', { kind: '削除', del: snap, copy: id, reason: '1回目' }, '2026-11-26T01:00:00Z');
  addFlow(b, 'SMSD00012', { kind: '削除', del: snap, copy: id, reason: '2回目' }, '2026-11-26T02:00:00Z');
  const j = judge(b);
  t('同じ製品の削除が2件：先の決裁だけ反映、後は状態不一致で保留', () => result(j, 'SMSD00011').decision === '反映' && result(j, 'SMSD00012').decision === '保留' && result(j, 'SMSD00012').reasons.some(x => /削除できる状態ではない/.test(x)));
}
{
  const b = books(), id = ACTIVE(b), snap = snapshot(b, id);
  addFlow(b, 'SMSD00021', { kind: '削除', del: snap, copy: id, reason: '一旦削除' }, '2026-11-26T01:00:00Z');
  const rsnap = clone(snap);
  addFlow(b, 'SMSD00022', { kind: '復帰', res: rsnap, copy: id, reason: '取り消し' }, '2026-11-26T02:00:00Z');
  const j = judge(b);
  t('削除→復帰の順に決裁：両方反映（仮想の管理マスターで続けて判定）', () => result(j, 'SMSD00021').decision === '反映' && result(j, 'SMSD00022').decision === '反映' && result(j, 'SMSD00022').after['管理状態'] === '有効');
}

// ---- 書込みと公開 ----
{
  const b = books(), id = ACTIVE(b);
  addFlow(b, 'SMSD00031', { kind: '削除', del: snapshot(b, id), copy: id, reason: '生産終了' });
  const props = Object.assign({}, PROPS, { LOOKUP_ACTIVE_SPREADSHEET_ID: 'LK_A', LOOKUP_INACTIVE_SPREADSHEET_ID: 'LK_I' });
  const g = load(b, props, { meta: { MASTER: { formats: {}, formulas: {}, hidden: {} } } }); g.console = { log() {} };
  g.pmApplyRun_(g.pmProps_());
  const p = master(b).find(x => x['管理コード'] === id);
  const L = b.MASTER['処理台帳'], h = L[0], row = L.find(r => r[h.indexOf('application_number')] === 'SMSD00031');
  const inAct = b.LK_A['シート1'].some(r => r[7] === id), inIna = b.LK_I['シート1'].some(r => r[7] === id);
  t('書込み：管理マスターの管理状態・無効理由が変わる', () => p['管理状態'] === '無効' && p['無効理由'] === '生産終了');
  t('書込み：処理台帳に記録（form_key=delete_restore、before/afterに無効理由）', () => row && row[h.indexOf('form_key')] === 'delete_restore' && JSON.parse(row[h.indexOf('after_json')])['無効理由'] === '生産終了' && JSON.parse(row[h.indexOf('before_json')])['管理状態'] === '有効');
  t('公開：有効一覧から消え、削除一覧に移る', () => !inAct && inIna);
  const g2 = load(b, props, { meta: { MASTER: { formats: {}, formulas: {}, hidden: {} } } }); g2.console = { log() {} };
  const before = JSON.stringify(b.MASTER['管理マスター']); g2.pmApplyRun_(g2.pmProps_());
  t('再実行しても二重に処理しない', () => JSON.stringify(b.MASTER['管理マスター']) === before);
}

console.log(`\ndelete: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
