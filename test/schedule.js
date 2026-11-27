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
// 既定の時刻は土曜（F-2R 停止の監視時間外）。監視の試験だけ平日の時刻を与える
const SAT = Date.parse('2026-11-21T12:00:00+09:00');
const g = (w, fetch, now = SAT) => { const x = load(w.books, w.props, { meta: w.meta, stats: w.stats, triggers: w.triggers, userProps: { RAKUMO_API_KEY: 'k', RAKUMO_API_SECRET: 's' }, fetch }); x.console = { log() {} }; x.pmNowMs_ = () => now; return x; };
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

// F-2R 停止の検知：今日動いた後に止まったときだけ（PCを起動していない日は通知しない）
const stale = (w) => mails(w).filter(m => /F-2R 同期停止/.test(m.subject));
const at = (x) => Date.parse(x);
const setLast = (w, iso) => { w.books.F2R.control[1][10] = iso; };
t('F-2R: 最終同期が30分以内なら通知しない', () => { const w = world(); setLast(w, '2026-11-24T01:50:00Z'); g(w, undefined, at('2026-11-24T11:10:00+09:00')).pmScheduledRun(); return !stale(w).length && !w.props.PM_F2R_STALE; });
t('F-2R: 今日まだ一度も同期していない（PC未起動・祝日・出張）は通知しない', () => { const w = world(); setLast(w, '2026-11-20T08:20:00Z'); g(w, undefined, at('2026-11-24T10:00:00+09:00')).pmScheduledRun(); g(w, undefined, at('2026-11-24T15:00:00+09:00')).pmScheduledRun(); return !stale(w).length; });
t('F-2R: 土日・監視時間外は通知しない', () => { const w = world(); setLast(w, '2026-11-22T01:00:00Z'); g(w, undefined, at('2026-11-22T11:00:00+09:00')).pmScheduledRun();
  const v = world(); setLast(v, '2026-11-24T08:00:00Z'); g(v, undefined, at('2026-11-24T18:00:00+09:00')).pmScheduledRun(); return !stale(w).length && !stale(v).length; });
const wS = world(); setLast(wS, '2026-11-24T05:00:00Z');   // 14:00 JST に最後の同期
g(wS, undefined, at('2026-11-24T14:45:00+09:00')).pmScheduledRun();
g(wS, undefined, at('2026-11-24T15:00:00+09:00')).pmScheduledRun();
g(wS, undefined, at('2026-11-25T10:00:00+09:00')).pmScheduledRun();
t('F-2R: 今日動いた後に止まったら1通だけ（翌日も再通知しない）', () => { const m = stale(wS); return m.length === 1 && /2026\/11\/24 14:00/.test(m[0].body) && /schedule_halt\.json/.test(m[0].body) && wS.props.PM_F2R_STALE === '2026-11-24T05:00:00Z'; });
setLast(wS, '2026-11-25T01:05:00Z');
g(wS, undefined, at('2026-11-25T10:10:00+09:00')).pmScheduledRun();
t('F-2R: 再開したら再開の通知を1通送り、記録を解除', () => { const r = mails(wS).filter(m => /F-2R 同期再開/.test(m.subject)); return r.length === 1 && /2026\/11\/25 10:05/.test(r[0].body) && !wS.props.PM_F2R_STALE; });
g(wS, undefined, at('2026-11-25T11:00:00+09:00')).pmScheduledRun();
t('F-2R: 同じ日に再び止まったら新しい停止として通知', () => stale(wS).length === 2);
t('F-2R: 最終同期が読めない値なら停止として通知', () => { const w = world(); setLast(w, ''); g(w, undefined, at('2026-11-24T10:00:00+09:00')).pmScheduledRun(); return stale(w).length === 1 && /読み取れない/.test(stale(w)[0].body); });
t('F-2R: WRITE_ENABLED でなければ確認もしない', () => { const w = world({ WRITE_ENABLED: '' }); setLast(w, '2026-11-24T05:00:00Z'); g(w, undefined, at('2026-11-24T15:00:00+09:00')).pmScheduledRun(); return !mails(w).length; });

t('トリガーは何度設置しても1本、解除で0本', () => { const w = world(); const x = g(w); x.pmInstallTrigger(); x.pmInstallTrigger(); const one = w.triggers.length === 1 && w.triggers[0].h === 'pmScheduledRun' && w.triggers[0].n === 15; x.pmRemoveTriggers(); return one && w.triggers.length === 0; });
t('F-2Rの公開切替と1回重なっても読み直して継続', () => { const w = world(); const c = w.books.F2R.control, gi = c[0].indexOf('generation'); let n = 0; const orig = clone(c);
  w.books.F2R.control = () => { n++; const x = clone(orig); if (n === 2) x[1][gi] = 'changed'; return x; };
  g(w).pmScheduledRun(); return w.stats.slept === 10000 && (w.books.MASTER['処理台帳'] || []).length === 6; });
console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
