// 定期実行・通知・トリガーの試験
const load = require('./harness');
const clone = (x) => JSON.parse(JSON.stringify(x));
let pass = 0, fail = 0;
function t(name, fn) { let ok, msg = ''; try { ok = fn(); } catch (e) { ok = false; msg = e.message; } console.log((ok ? 'PASS ' : 'FAIL ') + name + (msg ? ' / ' + msg : '')); ok ? pass++ : fail++; }
function world(extra = {}) {
  return { books: { F2R: clone(require('../fixtures/f2r.json')), MASTER: clone(require('../fixtures/master.json')), LK_A: { 'シート1': [] }, LK_I: { 'シート1': [] } },
    props: Object.assign({ F2R_SPREADSHEET_ID: 'F2R', MASTER_SPREADSHEET_ID: 'MASTER', PROCESS_START_AT: '2026-11-24T00:00:00+09:00', WRITE_ENABLED: 'true',
      LOOKUP_ACTIVE_SPREADSHEET_ID: 'LK_A', LOOKUP_INACTIVE_SPREADSHEET_ID: 'LK_I', NOTIFY_EMAIL: 'admin@example.com' }, extra),
    meta: { MASTER: { formats: {}, formulas: {}, hidden: {} } }, stats: { batchGet: 0, get: 0, writes: 0 }, triggers: [] };
}
const g = (w, fetch) => { const x = load(w.books, w.props, { meta: w.meta, stats: w.stats, triggers: w.triggers, userProps: { RAKUMO_API_KEY: 'k', RAKUMO_API_SECRET: 's' }, fetch }); x.console = { log() {} }; return x; };
const mails = (w) => w.stats.mails || [];

t('WRITE_ENABLED未設定なら何もしない・通知しない', () => { const w = world({ WRITE_ENABLED: '' }); const before = JSON.stringify(w.books.MASTER); g(w).pmScheduledRun(); return JSON.stringify(w.books.MASTER) === before && !mails(w).length; });

const w1 = world(); g(w1).pmScheduledRun();
t('初回：保留2件をマスター管理者へ1通だけ通知（理由つき）', () => { const m = mails(w1); return m.length === 1 && m[0].to === 'admin@example.com' && /保留 2件/.test(m[0].subject) && /SMSA00001/.test(m[0].body) && /SMSC00001/.test(m[0].body) && /コード待ち/.test(m[0].body) && !/SMSC00002/.test(m[0].body); });
g(w1).pmScheduledRun();
t('2回目：新しい保留が無ければ通知しない（成功時も送らない）', () => mails(w1).length === 1);

t('NOTIFY_EMAIL未設定ならメールを送らない', () => { const w = world({ NOTIFY_EMAIL: '' }); g(w).pmScheduledRun(); return !mails(w).length; });

const w5 = world(); g(w5).pmScheduledRun(); const base5 = mails(w5).length;
const L = w5.books.MASTER['処理台帳']; L[1][5] = 'エラー';
let threw = 0; try { g(w5).pmScheduledRun(); } catch (e) { threw++; } try { g(w5).pmScheduledRun(); } catch (e) { threw++; }
t('例外で止まったら通知し、同じ内容は24時間以内に繰り返さない（例外は呼び出し元へ）', () => threw === 2 && mails(w5).length === base5 + 1 && /実行エラー/.test(mails(w5).slice(-1)[0].subject));
const le = JSON.parse(w5.props.PM_LAST_ERROR); le.at -= 25 * 3600e3; w5.props.PM_LAST_ERROR = JSON.stringify(le);
try { g(w5).pmScheduledRun(); } catch (e) {}
t('24時間を過ぎたら再通知', () => mails(w5).length === base5 + 2);
L[1][5] = '保留'; g(w5).pmScheduledRun();
t('正常に戻ったらエラー記録を解除', () => !w5.props.PM_LAST_ERROR);

// 公開エラー（rakumoのLISTに該当なし）
const w6 = world({ LOOKUP_REFRESH_ENABLED: 'true' });
const fetch6 = (url) => /lookup-data\?/.test(url) ? { code: 200, body: { items: [] } } : { code: 404, body: {} };
g(w6, fetch6).pmScheduledRun(); g(w6, fetch6).pmScheduledRun();
t('公開エラーは新たに発生した回だけ通知', () => { const m = mails(w6); return m.length === 1 && /公開エラー/.test(m[0].subject) && /active: spreadsheetIdに一致するルックアップが0件/.test(m[0].body); });

t('トリガーは何度設置しても1本、解除で0本', () => { const w = world(); const x = g(w); x.pmInstallTrigger(); x.pmInstallTrigger(); const one = w.triggers.length === 1 && w.triggers[0].h === 'pmScheduledRun' && w.triggers[0].n === 15; x.pmRemoveTriggers(); return one && w.triggers.length === 0; });
t('F-2Rの公開切替と1回重なっても読み直して継続', () => { const w = world(); const c = w.books.F2R.control, gi = c[0].indexOf('generation'); let n = 0; const orig = clone(c);
  w.books.F2R.control = () => { n++; const x = clone(orig); if (n === 2) x[1][gi] = 'changed'; return x; };
  g(w).pmScheduledRun(); return w.stats.slept === 10000 && (w.books.MASTER['処理台帳'] || []).length === 6; });
console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
