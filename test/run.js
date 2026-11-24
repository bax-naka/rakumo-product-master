const load = require('./harness');
const f2r = require('../fixtures/f2r.json'), master = require('../fixtures/master.json');
const props = { F2R_SPREADSHEET_ID: 'F2R', MASTER_SPREADSHEET_ID: 'MASTER', PROCESS_START_AT: '2026-11-24T00:00:00+09:00' };
const g = load({ F2R: f2r, MASTER: master }, props);
const mode = process.argv[2] || 'all';
if (mode === 'all' || mode === 'setup') g.pmCheckSetup();
if (mode === 'all' || mode === 'preview') g.pmPreviewUpdates();
if (mode === 'all' || mode === 'verify') g.pmVerifyAgainstTestLedger();
