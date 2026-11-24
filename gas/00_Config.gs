/**
 * 製品マスター連携 Step B（読取・判定のみ）
 * このプロジェクトはスプレッドシートを読み取るだけで、書き込みは一切行わない。
 * IDはScript Propertiesで設定する（コードに直書きしない）。
 */
var PM = {
  PROP: {
    F2R_ID: 'F2R_SPREADSHEET_ID',          // F-2R公開Sheets
    MASTER_ID: 'MASTER_SPREADSHEET_ID',    // 管理用ブック（管理マスター・設定タブ）
    START_AT: 'PROCESS_START_AT'           // これより前に決裁されたFlowは対象外（テスト台帳記載分を除く）
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
  COLUMNS: ['型番', '商品CD', '製品ステータス', '分類コード', '大分類', '提供先', '顧客伺い', '管理コード', 'U番号', '管理状態'],
  LOOKUP_COLUMNS: ['型番', '商品CD', '製品ステータス', '分類コード', '大分類', '提供先', '顧客伺い', '管理コード', 'U番号'],
  KEY_COLUMN: {
    model: '型番', product_code: '商品CD', status: '製品ステータス', category: '大分類',
    destination: '提供先', customer: '顧客伺い', unit: 'U番号', management_id: '管理コード', class_code: '分類コード'
  },
  CATEGORY_KEY: { '大分類': 'category', '提供先': 'destination', '顧客伺い': 'customer' },
  EDITABLE_KEYS: ['model', 'status', 'category', 'destination', 'customer', 'product_code', 'unit'],
  CODE_KEYS: ['status', 'category', 'destination', 'customer'],
  TARGET_STATUSES: ['2', '5'],
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
  if (isNaN(Date.parse(out[PM.PROP.START_AT]))) throw new Error(PM.PROP.START_AT + ' が日時として解釈できない: ' + out[PM.PROP.START_AT]);
  return out;
}
