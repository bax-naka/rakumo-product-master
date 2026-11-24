// GASの最小モック：Sheets拡張サービス（readonly相当）と PropertiesService を JSON データで置き換えて .gs を実行。
// SpreadsheetApp は用意しない（使えば ReferenceError で試験が落ちる）。
const fs = require('fs'), vm = require('vm'), path = require('path');
module.exports = function load(books, props, stats = { batchGet: 0, get: 0 }) {
  const rowsOf = (b, n) => (typeof b[n] === 'function' ? b[n]() : b[n]);
  // APIと同様に、行末の空セルと末尾の空行を省く
  const trim = (rows) => {
    const out = rows.map(r => { const x = r.slice(); while (x.length && (x[x.length - 1] === '' || x[x.length - 1] == null)) x.pop(); return x; });
    while (out.length && !out[out.length - 1].length) out.pop();
    return out;
  };
  const unquote = (r) => r.replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
  const Sheets = {
    Spreadsheets: {
      get: (id, opt) => { stats.get++; const b = books[id]; if (!b) throw new Error('Requested entity was not found.');
        return { sheets: Object.keys(b).map(t => ({ properties: { title: t } })) }; },
      Values: {
        batchGet: (id, opt) => { stats.batchGet++; const b = books[id]; if (!b) throw new Error('Requested entity was not found.');
          if (opt.valueRenderOption !== 'FORMATTED_VALUE') throw new Error('unexpected render option');
          return { valueRanges: opt.ranges.map(r => { const n = unquote(r); if (!(n in b)) throw new Error('Unable to parse range: ' + r);
            const v = trim(rowsOf(b, n)); return v.length ? { range: r, values: v } : { range: r }; }) }; }
      }
    }
  };
  const ctx = {
    console, JSON, Date, Math, Number, String, Object, Array, RegExp, Error, isNaN, Sheets,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null }) },
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..', 'gas');
  fs.readdirSync(dir).filter(f => f.endsWith('.gs')).sort().forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f }));
  ctx.__stats = stats;
  return ctx;
};
