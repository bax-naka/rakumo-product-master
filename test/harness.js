// GASの最小モック。
//  - Sheets拡張サービス（読取）：books の配列をそのまま返す（行末の空セル・末尾空行はAPI同様に省く）
//  - SpreadsheetApp（書込み）：管理用ブックだけ開ける。F-2R（id 'F2R'）を開こうとすると例外
//    書式が '@'（書式なしテキスト）でないセルに数字だけの文字列を書くと数値化される（"021"→"21"）実機の挙動を再現
//  - LockService / Utilities.formatDate / PropertiesService
const fs = require('fs'), vm = require('vm'), path = require('path');
module.exports = function load(books, props, opts = {}) {
  const stats = opts.stats || { batchGet: 0, get: 0, writes: 0 };
  const hooks = opts.hooks || {};
  const meta = opts.meta || {};          // { [bookId]: { formats: {sheet: {"r,c": fmt}}, formulas: {...}, hidden: {...} } }
  const M = (id) => (meta[id] = meta[id] || { formats: {}, formulas: {}, hidden: {} });
  const rowsOf = (b, n) => (typeof b[n] === 'function' ? b[n]() : b[n]);
  const trim = (rows) => {
    const out = rows.map(r => { const x = r.slice(); while (x.length && (x[x.length - 1] === '' || x[x.length - 1] == null)) x.pop(); return x; });
    while (out.length && !out[out.length - 1].length) out.pop();
    return out;
  };
  const unquote = (r) => r.replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
  const Sheets = { Spreadsheets: {
    get: (id) => { stats.get++; const b = books[id]; if (!b) throw new Error('Requested entity was not found.');
      return { sheets: Object.keys(b).map(t => ({ properties: { title: t } })) }; },
    Values: { batchGet: (id, o) => { stats.batchGet++; const b = books[id]; if (!b) throw new Error('Requested entity was not found.');
      if (o.valueRenderOption !== 'FORMATTED_VALUE') throw new Error('unexpected render option');
      return { valueRanges: o.ranges.map(r => { const n = unquote(r); if (!(n in b)) throw new Error('Unable to parse range: ' + r);
        const v = trim(rowsOf(b, n)); return v.length ? { range: r, values: v } : { range: r }; }) }; } } } };

  function makeBook(id) {
    const b = books[id], m = M(id);
    const sheet = (name) => {
      const st = { name };
      const data = () => b[st.name];
      const fm = () => (m.formats[st.name] = m.formats[st.name] || {});
      const fx = () => (m.formulas[st.name] = m.formulas[st.name] || {});
      const cell = (r, c) => { const d = data(); return (d[r - 1] && d[r - 1][c - 1] != null) ? String(d[r - 1][c - 1]) : ''; };
      const put = (r, c, v) => {
        if (hooks.beforeSet) hooks.beforeSet(st.name, r, c, v);
        const d = data(); while (d.length < r) d.push([]); const row = d[r - 1]; while (row.length < c) row.push('');
        let s = String(v == null ? '' : v);
        if (fm()[r + ',' + c] !== '@' && /^\d+$/.test(s)) s = String(Number(s));
        row[c - 1] = s; delete fx()[r + ',' + c]; stats.writes++;
      };
      const range = (r, c, nr = 1, nc = 1) => {
        const R = {
          getDisplayValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
          getValues: () => R.getDisplayValues(),
          setValues: (vals) => { if (vals.length !== nr || vals.some(x => x.length !== nc)) throw new Error('size mismatch'); vals.forEach((x, i) => x.forEach((v, j) => put(r + i, c + j, v))); return R; },
          setValue: (v) => { put(r, c, v); return R; },
          setNumberFormat: (f) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) fm()[(r + i) + ',' + (c + j)] = f; return R; },
          getFormula: () => fx()[r + ',' + c] || '',
          copyTo: (dest) => { const f = fx()[r + ',' + c]; if (f) dest.__setFormula(f.replace(/([A-Z])(\d+)/g, (a, col, n) => col + (Number(n) + (dest.__row - r)))); return R; },
          __row: r,
          __setFormula: (f) => { put(r, c, ''); fx()[r + ',' + c] = f; },
        };
        return R;
      };
      return {
        getName: () => st.name,
        setName: (n) => { if (b[n]) throw new Error('name exists'); b[n] = b[st.name]; delete b[st.name]; st.name = n; },
        getLastRow: () => { const d = data(); let n = d.length; while (n && !d[n - 1].some(v => v !== '' && v != null)) n--; return n; },
        getLastColumn: () => Math.max(0, ...data().map(r => { let n = r.length; while (n && (r[n - 1] === '' || r[n - 1] == null)) n--; return n; })),
        getRange: range,
        setFrozenRows: () => {},
        hideSheet: () => { m.hidden[st.name] = true; },
        copyTo: (bk) => { let n = 'Copy of ' + st.name; b[n] = data().map(r => r.slice()); return sheet(n); },
      };
    };
    return {
      getSheetByName: (n) => (b[n] && typeof b[n] !== 'function' ? sheet(n) : null),
      insertSheet: (n) => { if (b[n]) throw new Error('exists'); b[n] = []; return sheet(n); },
      getSheets: () => Object.keys(b).map(sheet),
      deleteSheet: (sh) => { delete b[sh.getName()]; },
    };
  }
  let clock = Date.parse('2026-11-24T03:00:00Z');
  const ctx = {
    console, JSON, Date, Math, Number, String, Object, Array, RegExp, Error, isNaN, Sheets,
    SpreadsheetApp: {
      openById: (id) => { if (id === 'F2R') throw new Error('TEST: F-2R公開SheetsをSpreadsheetAppで開いた'); if (!books[id]) throw new Error('no book'); return makeBook(id); },
      flush: () => {},
    },
    LockService: { getScriptLock: () => ({ tryLock: () => (opts.lockFails ? false : true), releaseLock: () => {} }) },
    Utilities: { formatDate: (d, tz, f) => { clock += 1000; const t = new Date(clock + 9 * 3600e3).toISOString();
      return f.indexOf('yyyyMMdd_HHmmss') >= 0 ? t.slice(0, 19).replace(/[-:]/g, '').replace('T', '_') : t.slice(0, 19) + '+09:00'; },
      MacAlgorithm: { HMAC_SHA_1: 'sha1' },
      computeHmacSignature: (alg, msg, key) => Array.from(require('crypto').createHmac(alg, Buffer.from(key, 'utf8')).update(Buffer.from(msg, 'utf8')).digest()),
      base64Encode: (bytes) => Buffer.from(bytes.map(b => b & 255)).toString('base64'),
      sleep: (ms) => { stats.slept = (stats.slept || 0) + ms; } },
    UrlFetchApp: { fetch: (url, o) => { stats.fetch = (stats.fetch || []); stats.fetch.push({ url, o });
      if (!opts.fetch) throw new Error('TEST: 外部通信は未許可'); const r = opts.fetch(url, o);
      return { getResponseCode: () => r.code, getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) }; } },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }),
      getUserProperties: () => { const u = opts.userProps || (opts.userProps = {}); return { getProperty: (k) => u[k] || null, setProperty: (k, v) => { u[k] = v; }, deleteProperty: (k) => { delete u[k]; } }; } },
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..', 'gas');
  fs.readdirSync(dir).filter(f => f.endsWith('.gs')).sort().forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f }));
  ctx.__stats = stats; ctx.__meta = meta;
  return ctx;
};
