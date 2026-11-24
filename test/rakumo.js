// rakumo API クライアント（LookupData 読取）の試験。署名はF-2R(Python)の実装と同じ値になることを確認する。
const load = require('./harness');
const { execFileSync } = require('child_process');
let pass = 0, fail = 0;
function t(name, fn) { let ok, msg = ''; try { ok = fn(); } catch (e) { ok = false; msg = e.message; } console.log((ok ? 'PASS ' : 'FAIL ') + name + (msg ? ' / ' + msg : '')); ok ? pass++ : fail++; }
const quiet = { log() {} };
const mk = (o = {}) => { const logs = []; const g = load({}, o.props || {}, o); g.console = { log: (s) => logs.push(s) }; g.__logs = logs; return g; };

t('署名がF-2R(auth.py)と一致（GET/POST、Content-Typeのパラメーター除去）', () => {
  const g = mk(); const date = 'Tue, 24 Nov 2026 08:40:00 GMT';
  const py = (m, ct) => execFileSync('python3', ['-c', `import sys;sys.path.insert(0,'/home/claude/rakumo-workflow-sync/src');from rakumo_probe.auth import create_signature;print(create_signature('s3cr3t','${m}','${ct}','${date}'))`]).toString().trim();
  return g.pmRakumoSign_('s3cr3t', 'GET', 'application/json', date) === py('GET', 'application/json') &&
         g.pmRakumoSign_('s3cr3t', 'post', 'Application/JSON; charset=utf-8', date) === py('POST', 'application/json');
});
t('全角スペースもrakumo取込規則で半角になる', () => mk().pmRakumoNorm('Ａ　ｶﾅ') === 'A カナ');

t('キー移行：スクリプトプロパティからユーザープロパティへ移し、元を削除', () => {
  const props = { RAKUMO_API_KEY: 'key-1234', RAKUMO_API_SECRET: 'sec' }, userProps = {};
  const g = mk({ props, userProps }); g.pmMoveRakumoKeyToUserProperties();
  return userProps.RAKUMO_API_KEY === 'key-1234' && userProps.RAKUMO_API_SECRET === 'sec' && !props.RAKUMO_API_KEY && !props.RAKUMO_API_SECRET && !g.__logs.join().includes('sec');
});
t('秘密鍵がスクリプトプロパティに残っていれば通信しない', () => {
  const g = mk({ props: { RAKUMO_API_SECRET: 'x' }, userProps: { RAKUMO_API_KEY: 'k', RAKUMO_API_SECRET: 's' }, fetch: () => ({ code: 200, body: [] }) });
  try { g.pmLookupList_(); return false; } catch (e) { return /残っている/.test(e.message) && !(g.__stats.fetch || []).length; }
});

const LIST = { items: [
  { id: 101, spreadsheetId: 'SS_ACTIVE', displayName: '製品マスター(仮)/シート1' },
  { id: 102, spreadsheetId: 'SS_INACTIVE', displayName: '製品マスター(削除)/シート1' },
  { id: 999, spreadsheetId: 'OTHER' }] };
const cols = ['型番', '商品CD', '製品ステータス', '分類コード', '大分類', '提供先', '顧客伺い', '管理コード', 'U番号'].map((l, i) => ({ id: String(i + 1), label: l }));
const GET = { 101: { id: 101, displayName: '製品マスター(仮)/シート1', worksheetTitle: 'シート1', rowCount: 210, lastRefreshed: '2026-11-20T08:00:00Z', columns: cols },
              102: { id: 102, displayName: '製品マスター(削除)/シート1', worksheetTitle: 'シート1', rowCount: 77, isBuilding: true, lastRefreshed: '2026-11-20T08:00:00Z', columns: cols.slice(0, 8) } };
const okFetch = (url, o) => /lookup-data\?limit=100$/.test(url) ? { code: 200, body: LIST } : { code: 200, body: GET[url.split('/').pop()] };
const base = () => ({ props: { LOOKUP_ACTIVE_SPREADSHEET_ID: 'SS_ACTIVE', LOOKUP_INACTIVE_SPREADSHEET_ID: 'SS_INACTIVE' }, userProps: { RAKUMO_API_KEY: 'k', RAKUMO_API_SECRET: 's' } });

t('pmCheckLookupData：LIST→GETで2件を特定、読取（GET）だけを送る', () => {
  const g = mk(Object.assign(base(), { fetch: okFetch })); g.pmCheckLookupData();
  const f = g.__stats.fetch, L = g.__logs.join('\n');
  return f.length === 3 && f.every(x => x.o.method === 'get' && !('payload' in x.o)) && !f.some(x => /refresh/.test(x.url)) &&
    /\[active\] id=101 .*行数=210 isBuilding=（項目なし/.test(L) && /\[inactive\] id=102 .*isBuilding=true/.test(L) && /公開9列と一致/.test(L) && /公開9列と不一致/.test(L);
});
t('ヘッダー：Authorization=RWS キー:署名、Date・Content-Type付き、秘密鍵は送らない', () => {
  const g = mk(Object.assign(base(), { fetch: okFetch })); g.pmLookupList_();
  const h = g.__stats.fetch[0].o.headers;
  return /^RWS k:[A-Za-z0-9+/=]+$/.test(h.Authorization) && /GMT$/.test(h.Date) && h['Content-Type'] === 'application/json' && !JSON.stringify(g.__stats.fetch).includes('"s"');
});
t('503は指数バックオフで再試行して成功', () => {
  let n = 0; const g = mk(Object.assign(base(), { fetch: (u, o) => (++n < 3 ? { code: 503, body: '' } : okFetch(u, o)) }));
  return g.pmLookupList_().length === 3 && n === 3 && g.__stats.slept === 1000 + 2000;
});
t('429が続けば上限3回で止まる', () => {
  let n = 0; const g = mk(Object.assign(base(), { fetch: () => { n++; return { code: 429, body: '' }; } }));
  try { g.pmLookupList_(); return false; } catch (e) { return n === 3 && /再試行上限/.test(e.message); }
});
t('401/404は再試行せず、理由を表示（秘密は含めない）', () => {
  let n = 0; const g = mk(Object.assign(base(), { fetch: () => { n++; return { code: 401, body: { status: 401, reason: 'Unauthorized', message: 'auth failed' } }; } }));
  try { g.pmLookupList_(); return false; } catch (e) { return n === 1 && e.httpStatus === 401 && /Unauthorized/.test(e.message) && !/RWS|"s"/.test(e.message); }
});
t('LISTの応答形式が想定外なら停止してキー名を表示', () => {
  const g = mk(Object.assign(base(), { fetch: () => ({ code: 200, body: { foo: [] } }) }));
  try { g.pmLookupList_(); return false; } catch (e) { return /想定外.*foo/.test(e.message); }
});
console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
