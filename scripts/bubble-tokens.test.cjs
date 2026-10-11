// The native floating bubble mirrors tokens.css. Every TOKEN_<NAME> constant in
// FloatingOverlayService.java must equal --<name> in tokens.css, and the file may
// hold no other colour literal. Usage: node scripts/bubble-tokens.test.cjs

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JAVA = path.join(ROOT, 'mobile/android-overlay/app/src/main/java/com/nakauri/hrmonitor/FloatingOverlayService.java');
const TOKENS = path.join(ROOT, 'tokens.css');

let fails = 0;
const fail = (m) => { fails++; console.log('FAIL ' + m); };

const css = fs.readFileSync(TOKENS, 'utf8');
const rootBlock = css.slice(css.indexOf('{', css.indexOf(':root')) + 1, css.indexOf('}', css.indexOf(':root')));
const tokens = {};
for (const m of rootBlock.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) tokens[m[1]] = m[2].trim();

const src = fs.readFileSync(JAVA, 'utf8');
const consts = [...src.matchAll(/static final String TOKEN_([A-Z0-9_]+)\s*=\s*"([^"]+)"/g)];
if (consts.length < 5) fail(`expected at least 5 TOKEN_ constants, found ${consts.length}`);
for (const [, name, value] of consts) {
  const tok = name.toLowerCase().replace(/_/g, '-');
  const want = tokens[tok];
  if (!want) { fail(`TOKEN_${name}: no --${tok} in tokens.css`); continue; }
  if (want.toLowerCase() !== value.toLowerCase()) fail(`TOKEN_${name} is ${value}, tokens.css --${tok} is ${want}`);
  else console.log(`ok   TOKEN_${name} = --${tok} ${want}`);
  const uses = src.split('TOKEN_' + name).length - 2;
  if (uses < 1) fail(`TOKEN_${name} is declared but never used`);
}

const strays = [];
const scan = src.replace(/static final String TOKEN_[A-Z0-9_]+\s*=\s*"[^"]+";/g, '');
for (const re of [/parseColor\(\s*"#/g, /Color\.(?:rgb|argb)\(\s*(?:\d|0x)/g, /Color\.(?:WHITE|BLACK|GRAY|DKGRAY|LTGRAY|RED|GREEN|BLUE|YELLOW|CYAN|MAGENTA)\b/g, /0x[fF]{2}[0-9a-fA-F]{6}\b/g, /"#[0-9a-fA-F]{6,8}"/g]) {
  for (const m of scan.matchAll(re)) strays.push(scan.slice(0, m.index).split('\n').length + ': ' + m[0]);
}
if (strays.length) fail('colour literals outside the TOKEN_ constants: ' + strays.join('; '));

console.log(fails ? `${fails} FAILED` : 'bubble tokens match');
process.exit(fails ? 1 : 0);
