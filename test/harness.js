// GASの最小モック：SpreadsheetApp / PropertiesService を JSON データで置き換えて .gs を実行
const fs = require('fs'), vm = require('vm'), path = require('path');
module.exports = function load(books, props) {
  const sheet = (rows) => ({ getDataRange: () => ({ getDisplayValues: () => rows.map(r => r.slice()) }) });
  const ctx = {
    console, JSON, Date, Math, Number, String, Object, Array, RegExp, Error, isNaN,
    SpreadsheetApp: { openById: (id) => { const b = books[id]; if (!b) throw new Error('no book ' + id);
      return { getSheetByName: (n) => (b[n] ? sheet(typeof b[n] === 'function' ? b[n]() : b[n]) : null) }; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null }) },
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..', 'gas');
  fs.readdirSync(dir).filter(f => f.endsWith('.gs')).sort().forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f }));
  return ctx;
};
