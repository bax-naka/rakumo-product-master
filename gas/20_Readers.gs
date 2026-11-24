/** シートを {header, records} で読む（表示値＝文字列） */
function pmReadTable_(ss, name, optional) {
  var sh = ss.getSheetByName(name);
  if (!sh) { if (optional) return null; throw new Error('タブがない: ' + name); }
  var v = sh.getDataRange().getDisplayValues();
  if (!v.length || !v[0].some(function (c) { return c !== ''; })) {
    if (optional) return { header: [], records: [] };
    throw new Error('ヘッダーがない: ' + name);
  }
  var header = v[0].map(function (h) { return String(h).trim(); });
  var seen = {};
  header.forEach(function (h) { if (h && seen[h]) throw new Error('ヘッダー重複: ' + name + ' / ' + h); seen[h] = true; });
  var records = v.slice(1).filter(function (r) { return r.some(function (c) { return c !== ''; }); }).map(function (r) {
    var o = {}; header.forEach(function (h, i) { if (h) o[h] = String(r[i]); }); return o;
  });
  return { header: header, records: records };
}

function pmRequireCols_(table, name, cols) {
  var miss = cols.filter(function (c) { return table.header.indexOf(c) < 0; });
  if (miss.length) throw new Error(name + ' に必要な列がない: ' + miss.join(', '));
}

function pmReadControl_(ss) {
  var t = pmReadTable_(ss, 'control');
  if (t.records.length !== 1) throw new Error('control の行数が1ではない: ' + t.records.length);
  return t.records[0];
}

/** F-2R公開Sheetsを、controlが示す有効スロットから整合確認つきで読む */
function pmReadF2r_(ssId) {
  var ss = SpreadsheetApp.openById(ssId);
  var c1 = pmReadControl_(ss);
  var slot = c1.active_slot;
  if (slot !== 'A' && slot !== 'B') throw new Error('active_slot が不正: ' + slot);
  var data = {}, problems = [];
  PM.F2R_DATASETS.forEach(function (ds) {
    var name = ds + '_' + slot, t = pmReadTable_(ss, name);
    if (PM.F2R_REQUIRED[ds]) pmRequireCols_(t, name, PM.F2R_REQUIRED[ds]);
    var expected = Number(c1[ds + '_count']);
    if (!(expected >= 0) || t.records.length !== expected) problems.push(name + ' 件数不一致 control=' + c1[ds + '_count'] + ' 実際=' + t.records.length);
    var bad = t.records.filter(function (r) { return r.generation !== c1.generation || (r.export_id && r.export_id !== c1.export_id); }).length;
    if (bad) problems.push(name + ' に control と異なる世代の行が ' + bad + ' 件');
    data[ds] = t;
  });
  var c2 = pmReadControl_(ss);
  if (c2.active_slot !== slot || c2.generation !== c1.generation) problems.push('読取中に control が変わった（' + c1.generation + ' → ' + c2.generation + '）');
  if (problems.length) throw new Error('F-2R公開データの整合確認に失敗:\n - ' + problems.join('\n - '));
  return { control: c1, slot: slot, data: data };
}

/** 管理用ブック（管理マスターと設定タブ）を読む */
function pmReadMaster_(ssId) {
  var ss = SpreadsheetApp.openById(ssId);
  var m = pmReadTable_(ss, PM.TAB.master);
  pmRequireCols_(m, PM.TAB.master, PM.COLUMNS);
  var products = {};
  m.records.forEach(function (r) {
    var id = String(r['管理コード'] || '').trim();
    if (!id) return;
    if (products[id]) throw new Error('管理コード重複: ' + id);
    var p = {}; PM.COLUMNS.forEach(function (c) { p[c] = String(r[c] == null ? '' : r[c]).trim(); });
    products[id] = p;
  });

  var st = pmReadTable_(ss, PM.TAB.status); pmRequireCols_(st, PM.TAB.status, ['内部コード', '公開表示']);
  var codes = { status: { toLabel: {}, toCode: {} }, category: { toLabel: {}, toCode: {} }, destination: { toLabel: {}, toCode: {} }, customer: { toLabel: {}, toCode: {} } };
  st.records.forEach(function (r) { codes.status.toLabel[r['内部コード'].trim()] = r['公開表示'].trim(); codes.status.toCode[r['公開表示'].trim()] = r['内部コード'].trim(); });
  var ct = pmReadTable_(ss, PM.TAB.category); pmRequireCols_(ct, PM.TAB.category, ['項目', '内部コード', '公開表示']);
  ct.records.forEach(function (r) {
    var k = PM.CATEGORY_KEY[r['項目'].trim()];
    if (!k) throw new Error('区分対応の項目名が不明: ' + r['項目']);
    codes[k].toLabel[r['内部コード'].trim()] = r['公開表示'].trim(); codes[k].toCode[r['公開表示'].trim()] = r['内部コード'].trim();
  });

  var ft = pmReadTable_(ss, PM.TAB.forms); pmRequireCols_(ft, PM.TAB.forms, ['form_key', 'form_id', 'enabled']);
  var forms = {};
  ft.records.forEach(function (r) { if (String(r.enabled).toUpperCase() === 'TRUE') forms[pmId(r.form_id)] = r.form_key.trim(); });

  var mt = pmReadTable_(ss, PM.TAB.mapping); pmRequireCols_(mt, PM.TAB.mapping, ['form_key', 'internal_key', 'item_role', 'item_id']);
  var mapping = {};
  mt.records.forEach(function (r) {
    var fk = r.form_key.trim(), k = r.internal_key.trim(), role = r.item_role.trim();
    mapping[fk] = mapping[fk] || {}; mapping[fk][k] = mapping[fk][k] || {};
    if (mapping[fk][k][role]) throw new Error('項目マッピング重複: ' + [fk, k, role].join('/'));
    mapping[fk][k][role] = pmId(r.item_id);
  });

  var ledgerIds = {};
  var lt = pmReadTable_(ss, PM.TAB.ledger, true);
  if (lt) lt.records.forEach(function (r) { if (r.flow_id) ledgerIds[pmId(r.flow_id)] = r; });
  var tt = pmReadTable_(ss, PM.TAB.testLedger, true);
  var tests = tt ? tt.records.filter(function (r) { return r.flow_id; }) : [];

  return { products: products, codes: codes, forms: forms, mapping: mapping, ledgerIds: ledgerIds, hasLedgerTab: !!lt, tests: tests };
}
