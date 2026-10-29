// The Drive root folder lookup: one query and one pick (marks-drive.js rootQuery/pickRoots) for both pages.
// Bug it exists for: the monitor, the viewer and marks-drive.js each kept their own copy of the oldest-root rule,
// so a fix to one left the pages picking different roots for the same account.
// Runs the real page functions (monitor driveLookUpFolder, viewer driveEnsureFolder) on a fake Drive and holds them to
// the picks pinned from 6554b5b in scripts/fixtures/drive-roots.json (empty, missing and equal createdTime included),
// then proves itself with mutants of marks-drive.js. The Java uploaders keep their own query (K_ROOT caches their pick).
// Usage: node scripts/drive-root.test.cjs [repo root]. Runtime: under 1 s.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'drive-roots.json'), 'utf8'));
const NAME = 'HR Monitor Sessions';
// The request both pages sent at 6554b5b, byte for byte.
const PINNED_PATH = 'files?q=' + encodeURIComponent(`name='${NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`) +
  '&orderBy=createdTime&fields=files(id,name,createdTime)';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK    ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

function block(src, head) {
  const i = src.indexOf(head);
  if (i < 0) return null;
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  return null;
}

function loadModule(src) {
  const mod = { exports: {} };
  vm.runInNewContext(src, { module: mod, encodeURIComponent, Date, String, Infinity, require: () => null });
  return mod.exports;
}

function fakeFetch(files, log) {
  return async (p, init) => {
    log.push({ path: p, method: (init && init.method) || 'GET' });
    if (init && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ id: 'created-root' }) };
    return { ok: true, status: 200, json: async () => (files === null ? {} : { files: JSON.parse(JSON.stringify(files)) }) };
  };
}

// Each page's real lookup on one fixture case: what it requested and what it kept.
async function runMonitor(fn, md, files) {
  const log = [];
  const ctx = { AortiMarksDrive: md, DRIVE_FOLDER_NAME: NAME, driveFetch: fakeFetch(files, log), relayLink: { loginTag: 'email:a@b' },
    driveAccessToken: 'tok', driveFolderId: null, driveUpdateUI() {}, driveSyncConfig: async () => {}, startConfigPoll() {},
    JSON, Date, String, Promise, Infinity, encodeURIComponent, console };
  vm.runInNewContext(fn, ctx);
  await ctx.driveLookUpFolder();
  return { log, id: ctx.driveFolderId };
}
async function runViewer(fn, md, files) {
  const log = [];
  const ctx = { AortiMarksDrive: md, DRIVE_FOLDER_NAME: NAME, driveFetch: fakeFetch(files, log), driveFolderId: 'stale', driveRootIds: ['stale'],
    driveSyncConfig: async () => {}, driveFileIsOlder: () => false, JSON, Date, String, Promise, Infinity, encodeURIComponent, console };
  vm.runInNewContext(fn, ctx);
  await ctx.driveEnsureFolder();
  return { log, id: ctx.driveFolderId, ids: ctx.driveRootIds };
}

async function cases(mdSrc, monFn, viewFn) {
  const bad = [];
  let md;
  try { md = loadModule(mdSrc); } catch (e) { return ['marks-drive.js does not load: ' + e.message]; }
  if (typeof md.rootQuery !== 'function' || typeof md.pickRoots !== 'function') return ['marks-drive.js exports no rootQuery/pickRoots'];
  if (md.rootQuery(NAME) !== PINNED_PATH) bad.push('rootQuery differs from the 6554b5b request: ' + md.rootQuery(NAME));
  for (const c of FIX.cases) {
    const p = md.pickRoots(c.files === null ? undefined : c.files);
    if (p.id !== c.viewer || JSON.stringify(p.ids) !== JSON.stringify(c.viewerOrder)) bad.push(`pickRoots "${c.name}": ${p.id} [${p.ids}]`);
    const m = await runMonitor(monFn, md, c.files);
    const wantM = c.monitor === null ? 'created-root' : c.monitor;
    const created = m.log.some((r) => r.method === 'POST');
    if (m.id !== wantM || created !== (c.monitor === null) || m.log[0].path !== PINNED_PATH) bad.push(`monitor "${c.name}": kept ${m.id}, created ${created}`);
    const v = await runViewer(viewFn, md, c.files);
    if (v.id !== c.viewer || JSON.stringify(v.ids) !== JSON.stringify(c.viewerOrder) || v.log.length !== 1 || v.log[0].path !== PINNED_PATH) {
      bad.push(`viewer "${c.name}": kept ${v.id} [${v.ids}]`);
    }
  }
  return bad;
}

(async () => {
  const mdSrc = read('marks-drive.js');
  const monitor = read('hr_monitor.html'), viewer = read('hrv_viewer.html');
  const monFn = block(monitor, 'async function driveLookUpFolder()');
  const viewFn = block(viewer, 'async function driveEnsureFolder()');
  check('found monitor driveLookUpFolder and viewer driveEnsureFolder', !!monFn && !!viewFn);
  if (!monFn || !viewFn) process.exit(1);

  const kinds = new Set(FIX.cases.map((c) => c.name));
  check('fixture pins empty, missing and equal createdTime', ['empty listing', 'missing createdTime loses to a dated root', 'equal createdTime: lower id wins'].every((n) => kinds.has(n)), FIX.cases.length + ' cases');

  // The query is built in one web file: marks-drive.js. Any other `name='${...}' and mimeType=` is a second copy.
  const builder = /name='\$\{[^}]+\}' and mimeType=/g;
  const web = fs.readdirSync(ROOT).filter((f) => /\.(html|js)$/.test(f));
  const hits = web.filter((f) => (read(f).match(builder) || []).length);
  check('the root query is built only in marks-drive.js', hits.length === 1 && hits[0] === 'marks-drive.js', hits.join(', '));
  check('both pages ask marks-drive.js for the query and the pick',
    /AortiMarksDrive\.rootQuery\(DRIVE_FOLDER_NAME\)/.test(monFn) && /AortiMarksDrive\.pickRoots\(/.test(monFn) &&
    /AortiMarksDrive\.rootQuery\(DRIVE_FOLDER_NAME\)/.test(viewFn) && /AortiMarksDrive\.pickRoots\(/.test(viewFn));

  const real = await cases(mdSrc, monFn, viewFn);
  check(`both pages keep the 6554b5b pick on every fixture case (${FIX.cases.length})`, real.length === 0, real.slice(0, 6).join('; '));

  // Negative controls: each mutant of marks-drive.js must break a fixture case.
  const MUTANTS = [
    ['missing createdTime sorts first', "Date.parse(a.createdTime) || Infinity, tb = Date.parse(b.createdTime) || Infinity;", "Date.parse(a.createdTime) || 0, tb = Date.parse(b.createdTime) || 0;"],
    ['higher id wins a tie', "return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;", "return String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0;"],
    ['newest root wins', 'if (ta !== tb) return ta - tb;', 'if (ta !== tb) return tb - ta;'],
    ['query drops the createdTime order', "'&orderBy=createdTime&fields=files(id,name,createdTime)'", "'&fields=files(id,name,createdTime)'"],
    ['query lists trashed roots', "mimeType='${FOLDER_MIME}' and trashed=false`) + '&orderBy", "mimeType='${FOLDER_MIME}'`) + '&orderBy"],
  ];
  let caught = 0;
  for (const [name, a, b] of MUTANTS) {
    if (!mdSrc.includes(a)) { check(`mutant "${name}" applies`, false, 'anchor moved; update the mutant'); continue; }
    const bad = await cases(mdSrc.replace(a, b), monFn, viewFn);
    check(`mutant "${name}" caught`, bad.length > 0);
    if (bad.length) caught++;
  }
  if (caught === MUTANTS.length) console.log(`all ${caught} mutants caught`);

  if (failures) { console.log(failures + ' drive root check(s) FAILED.'); process.exit(1); }
  console.log('All drive root checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
