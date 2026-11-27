/**
 * 判定ロジック（スプレッドシートに依存しない純粋な処理）。
 * 候補を決裁日時順に処理し、反映と判定したものは「仮想の管理マスター」に適用してから次を判定する。
 * 実際の管理マスターには書き込まない。
 */
function pmJudgeAll(f2r, master, opts) {
  var startAt = pmTime(opts.startAt);
  var testIds = {};
  master.tests.forEach(function (t) { testIds[pmId(t.flow_id)] = true; });

  // 項目（トップレベルのみ。ルックアップ列の行は item_id が衝突するため除外）
  var itemsByFlow = {}, itemsAll = f2r.data.items.records;
  itemsAll.forEach(function (it) {
    if (it.row_kind !== 'item') return;
    var f = pmId(it.flow_id), id = pmId(it.item_id);
    itemsByFlow[f] = itemsByFlow[f] || {};
    if (itemsByFlow[f][id]) throw new Error('同一Flow内で項目ID重複: ' + f + ' / ' + id);
    itemsByFlow[f][id] = it;
  });

  var warnings = [], excluded = [], candidates = [];
  f2r.data.flows.records.forEach(function (fl) {
    var formKey = master.forms[pmId(fl.form_id)];
    if (!formKey) return;
    var info = { application_number: fl.application_number, flow_id: pmId(fl.flow_id), form_key: formKey, status: String(fl.status).trim(),
                 decided_at: fl.final_decision_date || fl.updated, title: fl.title };
    if (PM.TARGET_STATUSES.indexOf(info.status) < 0) { excluded.push([info, 'status=' + info.status + '（対象外）']); return; }
    if (master.ledgerIds[info.flow_id]) { excluded.push([info, '処理台帳に登録済み']); return; }
    var t = pmTime(info.decided_at);
    if (t === null) { excluded.push([info, '決裁日時が読めない: ' + info.decided_at]); return; }
    if (startAt !== null && t < startAt && !testIds[info.flow_id]) { excluded.push([info, '開始基準より前の決裁']); return; }
    info.time = t; candidates.push(info);
  });
  candidates.sort(function (a, b) { return a.time - b.time || (a.flow_id < b.flow_id ? -1 : 1); });

  var f2rForms = {};
  f2r.data.forms.records.forEach(function (f) { f2rForms[pmId(f.form_id)] = f.form_name; });
  Object.keys(master.forms).forEach(function (id) {
    if (!/^\d+$/.test(id)) warnings.push('対象Formのform_idが数字列ではない: ' + id);
    else if (!f2rForms[id]) warnings.push('対象Formのform_id ' + id + '（' + master.forms[id] + '）がF-2Rのformsにない。桁落ち（数値化）していないか確認');
  });
  warnings = warnings.concat(pmCheckFormOptions_(f2r, master, itemsByFlow));

  var state = pmNewState_(master);
  var results = candidates.map(function (c) {
    var items = itemsByFlow[c.flow_id] || {};
    var map = master.mapping[c.form_key];
    var r = !map ? { reasons: ['項目マッピングがない: ' + c.form_key], warnings: [] }
          : c.form_key === 'new' ? pmJudgeNew_(items, map, state, master)
          : c.form_key === 'change' ? pmJudgeChange_(items, map, state, master)
          : c.form_key === PM.DELETE_FORM_KEY ? pmJudgeDeleteRestore_(items, map, state, master)
          : { reasons: ['未対応の form_key: ' + c.form_key], warnings: [] };
    var res = { application_number: c.application_number, flow_id: c.flow_id, form_key: c.form_key, status: c.status,
                decided_at: c.decided_at, decision: r.reasons.length ? '保留' : '反映',
                management_id: r.managementId || '', before: r.before || null, after: r.after || null,
                diff: r.diff || [], reasons: r.reasons, warnings: r.warnings };
    if (!r.reasons.length) pmApply_(state, res);
    return res;
  });
  return { results: results, excluded: excluded, warnings: warnings, nextManagementId: pmMgmtId_(state.nextNo) };
}

function pmNewState_(master) {
  var products = {}, models = {}, maxNo = 0;
  Object.keys(master.products).forEach(function (id) {
    var p = {}; PM.COLUMNS.forEach(function (c) { p[c] = master.products[id][c]; });
    products[id] = p;
    var k = pmModelKey(p['型番']);
    if (k) { if (models[k]) throw new Error('管理マスター内で型番重複: ' + p['型番']); models[k] = id; }
    var m = new RegExp('^' + PM.MGMT_ID_PREFIX + '(\\d+)$').exec(id);
    if (!m) throw new Error('管理コードの形式が不正: ' + id);
    maxNo = Math.max(maxNo, Number(m[1]));
  });
  // 処理台帳に記録済みの管理コード（保留・エラー・途中停止を含む）も再利用しない
  Object.keys(master.ledgerIds || {}).forEach(function (f) {
    var m = new RegExp('^' + PM.MGMT_ID_PREFIX + '(\\d+)$').exec(String(master.ledgerIds[f].management_id || '').trim());
    if (m) maxNo = Math.max(maxNo, Number(m[1]));
  });
  return { products: products, models: models, nextNo: maxNo + 1 };
}
function pmMgmtId_(n) { return PM.MGMT_ID_PREFIX + pmPad(n, PM.MGMT_ID_DIGITS); }

function pmApply_(state, res) {
  var id = res.management_id;
  if (res.before) delete state.models[pmModelKey(res.before['型番'])];
  state.products[id] = res.after;
  state.models[pmModelKey(res.after['型番'])] = id;
  if (!res.before) state.nextNo += 1;
}

/** 項目値（value_json）を文字列で取り出す */
function pmItemText_(it, reasons, label) {
  var v;
  try { v = JSON.parse(it.value_json); } catch (e) { v = it.value_json; }
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') { reasons.push(label + ' の値が文字列ではない'); return ''; }
  return String(v);
}
function pmGet_(items, map, key, role, reasons, required) {
  var id = map[key] && map[key][role];
  if (!id) { reasons.push('項目マッピング未定義: ' + key + '/' + role); return null; }
  var it = items[id];
  if (!it) { reasons.push('項目ID ' + id + '（' + key + '/' + role + '）が申請にない'); return null; }
  var v = pmItemText_(it, reasons, it.item_name);
  if (required && pmNorm(v) === '') reasons.push(PM.KEY_COLUMN[key] + ' が空');
  return v;
}
/** 表示文字列 → 内部コード */
function pmToCode_(master, key, label, reasons) {
  var code = master.codes[key].toCode[pmNorm(label)];
  if (code === undefined) { reasons.push(PM.KEY_COLUMN[key] + ' の表記が対応表にない: "' + label + '"'); return null; }
  return code;
}
/** 管理マスターの値 → ルックアップ上の表示 */
function pmToDisplay_(master, col, p) {
  var key = { '製品ステータス': 'status', '大分類': 'category', '提供先': 'destination', '顧客伺い': 'customer' }[col];
  var v = p[col];
  if (key && v !== '') return master.codes[key].toLabel[v] === undefined ? '（未定義コード ' + v + '）' : master.codes[key].toLabel[v];
  return pmNorm(v);
}
function pmClassCode_(p) { return p['大分類'] + p['提供先'] + p['顧客伺い']; }

function pmJudgeNew_(items, map, state, master) {
  var reasons = [], warnings = [];
  var model = pmGet_(items, map, 'model', 'value', reasons, true);
  var vals = {};
  ['status', 'category', 'destination', 'customer'].forEach(function (k) {
    var v = pmGet_(items, map, k, 'value', reasons, true);
    if (v !== null && pmNorm(v) !== '') vals[k] = pmToCode_(master, k, v, reasons);
  });
  var pc = pmGet_(items, map, 'product_code', 'value', reasons, false);
  var unit = pmGet_(items, map, 'unit', 'value', reasons, false);
  if (model !== null && pmNorm(model) !== '' && state.models[pmModelKey(model)]) {
    reasons.push('型番が既存と重複: "' + pmNorm(model) + '"（' + state.models[pmModelKey(model)] + '）');
  }
  if (reasons.length) return { reasons: reasons, warnings: warnings };
  var id = pmMgmtId_(state.nextNo);
  var after = { '型番': pmNorm(model), '商品CD': pmNorm(pc), '製品ステータス': vals.status, '分類コード': '',
                '大分類': vals.category, '提供先': vals.destination, '顧客伺い': vals.customer,
                '管理コード': id, 'U番号': pmNorm(unit), '管理状態': '有効', '無効理由': '' };
  after['分類コード'] = pmClassCode_(after);
  var diff = PM.COLUMNS.map(function (c) { return { column: c, before: '', after: after[c] }; });
  return { reasons: reasons, warnings: warnings, managementId: id, before: null, after: after, diff: diff };
}

function pmJudgeChange_(items, map, state, master) {
  var reasons = [], warnings = [];
  // 1) ルックアップのスナップショット（申請時点の現状。申請者は編集できない）
  var lkId = map.target && map.target.lookup, lk = lkId && items[lkId], snap = null;
  if (!lk) reasons.push('対象製品（ルックアップ）項目がない');
  else {
    try {
      var obj = JSON.parse(lk.value_json); snap = {};
      (obj.columns || []).forEach(function (c) { snap[String(c.label)] = String(c.value == null ? '' : c.value); });
      PM.LOOKUP_COLUMNS.forEach(function (c) { if (!(c in snap)) reasons.push('ルックアップに列がない: ' + c); });
    } catch (e) { reasons.push('ルックアップ値を解釈できない'); snap = null; }
  }
  if (!snap) return { reasons: reasons, warnings: warnings };
  var id = pmNorm(snap['管理コード']);
  var copy = pmGet_(items, map, 'management_id', 'lookup_copy', reasons, true);
  if (copy !== null && pmNorm(copy) !== id) reasons.push('管理コード項目とルックアップの管理コードが不一致: ' + copy + ' / ' + id);
  var p = state.products[id];
  if (!p) { reasons.push('管理コードが管理マスターにない: ' + id); return { reasons: reasons, warnings: warnings }; }
  if (p['管理状態'] !== '有効') reasons.push('対象製品の管理状態が有効ではない: ' + p['管理状態']);

  // 2) スナップショット ↔ 現在の管理マスター（承認までに別の変更が入っていないか）
  PM.LOOKUP_COLUMNS.forEach(function (c) {
    var a = pmNorm(snap[c]), b = pmToDisplay_(master, c, p);
    if (a !== b) reasons.push('申請時の現状値が管理マスターと不一致: ' + c + ' 申請="' + a + '" マスター="' + b + '"');
  });

  // 3) [現状]欄 ↔ スナップショット、変更チェック、変更後の値
  var after = {}; PM.COLUMNS.forEach(function (c) { after[c] = p[c]; });
  var on = [];
  PM.EDITABLE_KEYS.forEach(function (k) {
    var col = PM.KEY_COLUMN[k];
    var cur = pmGet_(items, map, k, 'current', reasons, false);
    if (cur !== null && pmNorm(cur) !== pmNorm(snap[col])) reasons.push('[現状]' + col + ' がルックアップ値と不一致: "' + pmNorm(cur) + '" / "' + pmNorm(snap[col]) + '"');
    var flag = pmGet_(items, map, k, 'flag', reasons, false);
    if (flag === null) return;
    flag = pmNorm(flag);
    if (flag !== '0' && flag !== '1') { reasons.push(col + ' の変更チェック値が不正: "' + flag + '"'); return; }
    if (flag === '0') return;                       // OFFの変更後値は読まない
    on.push(col);
    var nv = pmGet_(items, map, k, 'new', reasons, false);
    if (nv === null) return;
    nv = pmNorm(nv);
    if (nv === '') { reasons.push(col + ' の変更チェックがONだが変更後の値が空（空欄化は未対応）'); return; }
    if (PM.CODE_KEYS.indexOf(k) >= 0) { nv = pmToCode_(master, k, nv, reasons); if (nv === null) return; }
    if (k === 'model') {
      var dup = state.models[pmModelKey(nv)];
      if (dup && dup !== id) reasons.push('変更後の型番が既存と重複: "' + nv + '"（' + dup + '）');
    }
    if (nv === p[col]) warnings.push(col + ' は変更前後が同じ');
    after[col] = nv;
  });
  if (!on.length) reasons.push('変更チェックが1つもONになっていない');
  after['分類コード'] = pmClassCode_(after);
  var diff = PM.COLUMNS.filter(function (c) { return after[c] !== p[c]; }).map(function (c) { return { column: c, before: p[c], after: after[c] }; });
  if (on.length && !diff.length) reasons.push('実質的な変更がない');
  if (reasons.length) return { reasons: reasons, warnings: warnings, managementId: id };
  return { reasons: reasons, warnings: warnings, managementId: id, before: p, after: after, diff: diff };
}

/** ルックアップ項目の値 → { 列名: 値 }。未選択（項目なし・値なし）は null、解釈できなければ理由を積む */
function pmLookupSnap_(it, reasons, label) {
  if (!it) return null;
  var raw = it.value_json, obj;
  if (raw === undefined || raw === null || String(raw).trim() === '' || String(raw).trim() === 'null') return null;
  try { obj = JSON.parse(raw); } catch (e) { reasons.push(label + ' の値を解釈できない'); return null; }
  if (obj === null || typeof obj !== 'object' || !Array.isArray(obj.columns) || !obj.columns.length) return null;
  var snap = {};
  obj.columns.forEach(function (c) { snap[String(c.label)] = String(c.value == null ? '' : c.value); });
  return snap;
}

/**
 * 削除・復帰申請。区分（ラジオ）で使うルックアップを決め、申請時点のスナップショットと
 * 現在の管理マスターを照合してから、管理状態と無効理由だけを変える。
 *   削除: 有効 → 無効、無効理由 = 申請の理由
 *   復帰: 無効 → 有効、無効理由 = 空（以前の理由は処理台帳と変更履歴に残る）
 */
function pmJudgeDeleteRestore_(items, map, state, master) {
  var reasons = [], warnings = [];
  var kind = pmGet_(items, map, 'kind', 'value', reasons, true);
  if (kind === null) return { reasons: reasons, warnings: warnings };
  kind = pmNorm(kind);
  var rule = PM.DELETE_KIND[kind];
  if (!rule) { reasons.push(PM.KEY_COLUMN.kind + ' の値が不正: "' + kind + '"'); return { reasons: reasons, warnings: warnings }; }
  var other = kind === '削除' ? PM.DELETE_KIND['復帰'] : PM.DELETE_KIND['削除'];

  var lkId = map[rule.lookup] && map[rule.lookup].lookup;
  if (!lkId) { reasons.push('項目マッピング未定義: ' + rule.lookup + '/lookup'); return { reasons: reasons, warnings: warnings }; }
  var snap = pmLookupSnap_(items[lkId], reasons, kind + '型番');
  var otherId = map[other.lookup] && map[other.lookup].lookup;
  if (otherId && pmLookupSnap_(items[otherId], [], '') !== null) reasons.push('区分「' + kind + '」と反対側のルックアップにも製品が選ばれている');
  if (!snap) { if (!reasons.length) reasons.push(kind + '型番（ルックアップ）が選ばれていない'); return { reasons: reasons, warnings: warnings }; }
  PM.LOOKUP_COLUMNS.forEach(function (c) { if (!(c in snap)) reasons.push('ルックアップに列がない: ' + c); });
  if (reasons.length) return { reasons: reasons, warnings: warnings };

  var id = pmNorm(snap['管理コード']);
  // 管理コードの表示欄（ルックアップからの転記）。区分ごとの欄か共通の欄のどちらかがあれば照合する
  ['lookup_copy_' + (kind === '削除' ? 'delete' : 'restore'), 'lookup_copy'].forEach(function (role) {
    var cid = map.management_id && map.management_id[role], cit = cid && items[cid];
    if (!cit) return;
    var v = pmNorm(pmItemText_(cit, reasons, cit.item_name));
    if (v !== '' && v !== id) reasons.push('管理コード項目とルックアップの管理コードが不一致: ' + v + ' / ' + id);
  });
  var p = state.products[id];
  if (!p) { reasons.push('管理コードが管理マスターにない: ' + id); return { reasons: reasons, warnings: warnings }; }
  if (p['管理状態'] !== rule.from) reasons.push(kind + 'できる状態ではない: 現在の管理状態=' + p['管理状態'] + '（' + kind + 'は' + rule.from + 'のときだけ）');
  PM.LOOKUP_COLUMNS.forEach(function (c) {
    var a = pmNorm(snap[c]), b = pmToDisplay_(master, c, p);
    if (a !== b) reasons.push('申請時の値が管理マスターと不一致: ' + c + ' 申請="' + a + '" マスター="' + b + '"');
  });
  if (kind === '復帰') {
    var dup = state.models[pmModelKey(p['型番'])];
    if (dup && dup !== id) reasons.push('復帰すると型番が重複する: "' + p['型番'] + '"（' + dup + '）');
  }
  var reasonText = pmGet_(items, map, 'reason', 'value', reasons, true);
  if (reasons.length) return { reasons: reasons, warnings: warnings, managementId: id };

  var after = {}; PM.COLUMNS.forEach(function (c) { after[c] = p[c]; });
  after['管理状態'] = rule.to;
  after['無効理由'] = kind === '削除' ? String(reasonText).replace(/\r\n?/g, '\n').trim() : '';
  var diff = PM.COLUMNS.filter(function (c) { return after[c] !== p[c]; }).map(function (c) { return { column: c, before: p[c], after: after[c] }; });
  return { reasons: reasons, warnings: warnings, managementId: id, before: p, after: after, diff: diff };
}

/** Formの選択肢（definition_json.options）と対応表の一致を、Formごとに最新Flowで確認 */
function pmCheckFormOptions_(f2r, master, itemsByFlow) {
  var latest = {}, out = [];
  f2r.data.flows.records.forEach(function (fl) {
    var fk = master.forms[pmId(fl.form_id)]; if (!fk) return;
    var t = pmTime(fl.app_date) || 0;
    if (!latest[fk] || t > latest[fk].t) latest[fk] = { t: t, flow: pmId(fl.flow_id), no: fl.application_number };
  });
  Object.keys(latest).forEach(function (fk) {
    var items = itemsByFlow[latest[fk].flow] || {}, map = master.mapping[fk] || {};
    PM.CODE_KEYS.forEach(function (k) {
      var role = fk === 'new' ? 'value' : 'new', id = map[k] && map[k][role], it = id && items[id];
      if (!it) return;
      var opts; try { opts = JSON.parse(it.definition_json).options || []; } catch (e) { opts = []; }
      var labels = Object.keys(master.codes[k].toCode);
      var miss = opts.filter(function (o) { return labels.indexOf(pmNorm(o)) < 0; });
      var extra = labels.filter(function (l) { return opts.map(pmNorm).indexOf(l) < 0; });
      if (miss.length || extra.length) out.push('選択肢と対応表の不一致 ' + fk + '/' + PM.KEY_COLUMN[k] + '（' + latest[fk].no + '）: Formのみ=' + JSON.stringify(miss) + ' 対応表のみ=' + JSON.stringify(extra));
    });
  });
  return out;
}

/** テスト台帳の期待結果と突き合わせ */
function pmVerify(judged, master) {
  var byFlow = {}; judged.results.forEach(function (r) { byFlow[r.flow_id] = r; });
  var exByFlow = {}; judged.excluded.forEach(function (e) { exByFlow[e[0].flow_id] = e[1]; });
  return master.tests.map(function (t) {
    var fid = pmId(t.flow_id), r = byFlow[fid], fails = [];
    var expect = String(t['期待結果'] || '').trim();
    var L = master.ledgerIds[fid];
    if (!r && L) {
      // 反映後：処理台帳の段階と、現在の管理マスターの値で確認する
      var wantStages = expect === '反映' ? [PM.STAGE.APPLIED, PM.STAGE.DONE] : expect === '保留' ? [PM.STAGE.HOLD] : [];
      if (wantStages.indexOf(L.stage) < 0) fails.push('処理台帳の段階 ' + L.stage + '（期待 ' + wantStages.join('または') + '）');
      if (expect === '反映') {
        var p = master.products[String(L.management_id).trim()];
        if (!p) fails.push('管理マスターに ' + L.management_id + ' がない');
        else String(t['期待差分'] || '').split(';').forEach(function (kv) {
          if (!kv.trim()) return;
          var i = kv.indexOf('='), col = kv.slice(0, i).trim(), val = kv.slice(i + 1).trim();
          if (p[col] !== val) fails.push('管理マスター ' + col + '="' + p[col] + '"（期待 "' + val + '"）');
        });
      }
      return { application_number: t.application_number, flow_id: fid, ok: !fails.length, fails: fails, result: { decision: '処理台帳: ' + L.stage } };
    }
    if (!r) fails.push('判定対象になっていない（' + (exByFlow[fid] || '公開データにない') + '）');
    else {
      if (r.decision !== expect) fails.push('判定 ' + r.decision + '（期待 ' + expect + '）');
      if (expect === '反映' && r.after) {
        String(t['期待差分'] || '').split(';').forEach(function (kv) {
          if (!kv.trim()) return;
          var i = kv.indexOf('='), col = kv.slice(0, i).trim(), val = kv.slice(i + 1).trim();
          if (r.after[col] !== val) fails.push(col + '="' + r.after[col] + '"（期待 "' + val + '"）');
        });
        var listed = String(t['期待差分'] || '').split(';').map(function (kv) { return kv.split('=')[0].trim(); });
        if (r.before) r.diff.forEach(function (d) { if (listed.indexOf(d.column) < 0) fails.push('想定外の変更: ' + d.column + ' "' + d.before + '"→"' + d.after + '"'); });
      }
    }
    return { application_number: t.application_number, flow_id: fid, ok: !fails.length, fails: fails, result: r || null };
  });
}
