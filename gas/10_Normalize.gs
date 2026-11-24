/** rakumoのルックアップ取込規則：全角英数字記号→半角、半角カタカナ→全角 */
function pmRakumoNorm(s) {
  s = String(s == null ? '' : s);
  s = s.replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  return s.replace(/[｡-ﾟ]+/g, function (m) { return m.normalize('NFKC'); });
}
/** 値の比較用（規則変換＋前後空白除去） */
function pmNorm(s) { return pmRakumoNorm(s).trim(); }
/** 型番の重複判定キー */
function pmModelKey(s) { return pmNorm(s).toUpperCase(); }
/** F-2Rの識別子（"text:123"）を素の文字列へ */
function pmId(v) { return String(v == null ? '' : v).trim().replace(/^text:/, ''); }
function pmTime(v) { var t = Date.parse(String(v || '')); return isNaN(t) ? null : t; }
function pmPad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
