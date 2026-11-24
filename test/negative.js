const load = require('./harness');
const base = () => ({ F2R: JSON.parse(JSON.stringify(require('../fixtures/f2r.json'))), MASTER: JSON.parse(JSON.stringify(require('../fixtures/master.json'))) });
const props = { F2R_SPREADSHEET_ID: 'F2R', MASTER_SPREADSHEET_ID: 'MASTER', PROCESS_START_AT: '2026-11-24T00:00:00+09:00' };
const quiet = { log() {} };
let pass = 0, fail = 0;
function run(name, mutate, check) {
  const b = base(); mutate && mutate(b);
  const g = load(b, props); g.console = quiet;
  let out, err;
  try { out = g.pmRun_(); } catch (e) { err = e; }
  let ok; try { ok = check(out, err, g); } catch (e) { ok = false; console.log('   ', e.message); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (err && !ok ? ' / ' + err.message : '')); ok ? pass++ : fail++;
}
const slot = b => b.F2R.control[1][0];
const tab = (b, n) => b.F2R[n + '_' + slot(b)];
const col = (rows, name) => rows[0].indexOf(name);
const res = (o, no) => o.judged.results.find(r => r.application_number === no);
const setItem = (b, flowNo, itemId, field, value) => {
  const fl = tab(b, 'flows'), it = tab(b, 'items');
  const fid = fl.find(r => r[col(fl, 'application_number')] === flowNo)[col(fl, 'flow_id')];
  const row = it.find(r => r[col(it, 'flow_id')] === fid && r[col(it, 'item_id')] === 'text:' + itemId && r[col(it, 'row_kind')] === 'item');
  row[col(it, field)] = typeof value === 'function' ? value(row[col(it, field)]) : value;
};
const setFlow = (b, flowNo, field, value) => { const fl = tab(b, 'flows'); fl.find(r => r[col(fl, 'application_number')] === flowNo)[col(fl, field)] = value; };

run('同一データを2回読んでも結果が同じ（冪等）', null, (o) => {
  const b = base(), g = load(b, props); g.console = quiet;
  return JSON.stringify(o.judged.results) === JSON.stringify(g.pmRun_().judged.results);
});
run('controlの件数不一致で中断', b => { b.F2R.control[1][col(b.F2R.control, 'items_count')] = '9999'; }, (o, e) => e && /件数不一致/.test(e.message));
run('他世代の行が混在したら中断', b => { const f = tab(b, 'flows'); f[1][col(f, 'generation')] = 'xxxx'; }, (o, e) => e && /異なる世代/.test(e.message));
run('読取中にcontrolが変わったら中断', b => {
  const c = b.F2R.control, gi = col(c, 'generation'); let n = 0;
  const orig = c.map(r => r.slice()); b.F2R.control = () => { n++; const x = orig.map(r => r.slice()); if (n > 1) x[1][gi] = 'changed'; return x; };
}, (o, e) => e && /control が変わった/.test(e.message));
run('処理台帳に登録済みのFlowは対象外', b => { b.MASTER['処理台帳'] = [['flow_id'], ['text:6521132406472704']]; },
  o => !res(o, 'SMSC00002') && o.judged.excluded.some(e => e[0].application_number === 'SMSC00002' && /処理台帳/.test(e[1])));
run('status 2→5 でも台帳未登録なら1回だけ候補', b => setFlow(b, 'SMSC00002', 'status', '5'), o => res(o, 'SMSC00002').decision === '反映');
run('status 5 かつ台帳登録済みなら対象外（2→5の再処理なし）', b => { setFlow(b, 'SMSC00002', 'status', '5'); b.MASTER['処理台帳'] = [['flow_id'], ['6521132406472704']]; }, o => !res(o, 'SMSC00002'));
run('status 1/3/4/6 は対象外', b => { ['SMSC00002'].forEach(n => setFlow(b, n, 'status', '6')); }, o => o.judged.excluded.some(e => e[0].application_number === 'SMSC00002' && /status=6/.test(e[1])));
run('開始基準より前の決裁はテスト台帳になければ対象外', b => { b.MASTER['テスト台帳'] = [b.MASTER['テスト台帳'][0]]; }, o => o.judged.results.length === 0 && o.judged.excluded.length === 5);
run('[現状]欄を申請者が書き換えたら保留', b => setItem(b, 'SMSC00003', 10, 'value_json', '"999999"'), o => res(o, 'SMSC00003').decision === '保留' && res(o, 'SMSC00003').reasons.some(x => /\[現状\]商品CD/.test(x)));
run('チェックONで変更後の値が空なら保留', b => setItem(b, 'SMSC00003', 17, 'value_json', '""'), o => res(o, 'SMSC00003').decision === '保留');
run('チェック値が0/1以外なら保留', b => setItem(b, 'SMSC00003', 21, 'value_json', '"true"'), o => res(o, 'SMSC00003').decision === '保留');
run('チェックが全部OFFなら保留', b => setItem(b, 'SMSC00003', 21, 'value_json', '"0"'), o => res(o, 'SMSC00003').reasons.some(x => /1つもON/.test(x)));
run('チェックOFFの項目に値が残っていても無視', b => setItem(b, 'SMSC00003', 13, 'value_json', '"777777"'), o => res(o, 'SMSC00003').decision === '反映' && res(o, 'SMSC00003').after['商品CD'] === '184765');
run('新規：既存型番と重複（全角入力も検出）なら保留', b => setItem(b, 'SMSA00002', 1, 'value_json', '"ｍｋｙ４３"'), o => res(o, 'SMSA00002').reasons.some(x => /重複/.test(x)));
run('新規：半角カナの型番は全角化して登録', b => setItem(b, 'SMSA00002', 1, 'value_json', '"ﾃｽﾄ品"'), o => res(o, 'SMSA00002').after['型番'] === 'テスト品');
run('新規：同一型番の2件目は先行反映分と重複で保留', b => { setItem(b, 'SMSA00001', 5, 'value_json', '"1:IC製品"'); setItem(b, 'SMSA00001', 6, 'value_json', '"1:一般販売"'); setItem(b, 'SMSA00001', 7, 'value_json', '"1:変更後の通知"'); setItem(b, 'SMSA00001', 3, 'item_id', 'text:11'); },
  o => res(o, 'SMSA00001').decision === '反映' && res(o, 'SMSA00002').reasons.some(x => /重複.*PD00287/.test(x)));
run('同一製品への連続変更は先行反映後の値と照合', b => { setFlow(b, 'SMSC00001', 'final_decision_date', '2026-11-20T09:30:00Z'); setItem(b, 'SMSC00001', 2, 'value_json', v => v.replace('コード待ち', '')); setItem(b, 'SMSC00001', 10, 'value_json', '""'); },
  o => res(o, 'SMSC00001').decision === '保留' && res(o, 'SMSC00001').reasons.some(x => /提供先 申請="1:一般販売" マスター="2:販売先限定"/.test(x)));
run('Formの選択肢と対応表の不一致を警告', b => setItem(b, 'SMSA00002', 5, 'definition_json', v => v.replace('"1:IC製品"', '"1.IC製品"')), o => o.judged.warnings.some(w => /大分類/.test(w)));
run('管理状態が無効の製品への変更は保留', b => { const m = b.MASTER['管理マスター']; m.find(r => r[7] === 'PD00029')[9] = '無効'; }, o => res(o, 'SMSC00003').reasons.some(x => /管理状態/.test(x)));
run('Script Property未設定ならエラー', null, () => { const g = load(base(), { F2R_SPREADSHEET_ID: 'F2R' }); try { g.pmRun_(); return false; } catch (e) { return /未設定/.test(e.message); } });
console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
