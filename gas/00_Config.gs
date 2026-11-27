/**
 * 製品マスター連携 Step B（読取・判定のみ）
 * このプロジェクトはスプレッドシートを読み取るだけで、書き込みは一切行わない。
 * IDはScript Propertiesで設定する（コードに直書きしない）。
 */
var PM = {
  PROP: {
    F2R_ID: 'F2R_SPREADSHEET_ID',          // F-2R公開Sheets
    MASTER_ID: 'MASTER_SPREADSHEET_ID',    // 管理用ブック（管理マスター・設定タブ）
    START_AT: 'PROCESS_START_AT',          // これより前に決裁されたFlowは対象外（テスト台帳記載分を除く）
    WRITE_ENABLED: 'WRITE_ENABLED'         // "true" のときだけ管理マスター・処理台帳へ書き込む
  },
  F2R_DATASETS: ['categories', 'forms', 'flows', 'items', 'route', 'history'],
  F2R_REQUIRED: {
    flows: ['generation', 'flow_id', 'application_number', 'title', 'form_id', 'status', 'final_decision_date', 'updated'],
    items: ['generation', 'flow_id', 'item_id', 'row_kind', 'item_name', 'item_type', 'value_json', 'definition_json', 'form_id']
  },
  TAB: {
    master: '管理マスター',
    status: 'ステータス対応',
    category: '区分対応',
    forms: '対象Form',
    mapping: '項目マッピング',
    testLedger: 'テスト台帳',
    ledger: '処理台帳'
  },
  // 公開9列 + 管理状態
  COLUMNS: ['型番', '商品CD', '製品ステータス', '分類コード', '大分類', '提供先', '顧客伺い', '管理コード', 'U番号', '管理状態', '無効理由'],
  LOOKUP_COLUMNS: ['型番', '商品CD', '製品ステータス', '分類コード', '大分類', '提供先', '顧客伺い', '管理コード', 'U番号'],
  KEY_COLUMN: {
    model: '型番', product_code: '商品CD', status: '製品ステータス', category: '大分類',
    destination: '提供先', customer: '顧客伺い', unit: 'U番号', management_id: '管理コード', class_code: '分類コード',
    kind: '区分（削除・復帰）', reason: '理由'
  },
  // 削除・復帰申請（form_key = delete_restore）
  DELETE_FORM_KEY: 'delete_restore',
  DELETE_KIND: { '削除': { lookup: 'target_delete', from: '有効', to: '無効' },
                 '復帰': { lookup: 'target_restore', from: '無効', to: '有効' } },
  CATEGORY_KEY: { '大分類': 'category', '提供先': 'destination', '顧客伺い': 'customer' },
  EDITABLE_KEYS: ['model', 'status', 'category', 'destination', 'customer', 'product_code', 'unit'],
  CODE_KEYS: ['status', 'category', 'destination', 'customer'],
  TARGET_STATUSES: ['2', '5'],
  LEDGER_HEADER: ['flow_id', 'application_number', 'form_key', 'status', 'decided_at', 'stage', 'decision', 'management_id',
                  'reasons', 'before_json', 'after_json', 'f2r_generation', 'created_at', 'updated_at', 'lookup_status'],
  STAGE: { PROCESSING: '処理中', APPLIED: 'マスター反映済み', DONE: '完了', HOLD: '保留', ERROR: 'エラー' },
  BACKUP_PREFIX: 'bk_管理マスター_',
  BACKUP_KEEP: 5,
  LOCK_WAIT_MS: 30000,
  MGMT_ID_PREFIX: 'PD',
  MGMT_ID_DIGITS: 5
};

function pmProps_() {
  var p = PropertiesService.getScriptProperties();
  var out = {};
  [PM.PROP.F2R_ID, PM.PROP.MASTER_ID, PM.PROP.START_AT].forEach(function (k) {
    var v = (p.getProperty(k) || '').trim();
    if (!v) throw new Error('Script Property 未設定: ' + k);
    out[k] = v;
  });
  out[PM.PROP.WRITE_ENABLED] = String(p.getProperty(PM.PROP.WRITE_ENABLED) || '').trim().toLowerCase() === 'true';
  if (out[PM.PROP.F2R_ID] === out[PM.PROP.MASTER_ID]) throw new Error('F-2R公開Sheetsと管理用ブックに同じIDが設定されている');
  if (isNaN(Date.parse(out[PM.PROP.START_AT]))) throw new Error(PM.PROP.START_AT + ' が日時として解釈できない: ' + out[PM.PROP.START_AT]);
  return out;
}
