/*
 * Tests for the two apps being genuinely separate PWAs.
 *
 * Almost everything here fails silently in a browser. A manifest with a typo
 * is ignored, a missing icon falls back to a screenshot of the page, and two
 * apps that share an identity install as one - all of which look fine until
 * you try to add the second one to a home screen and the first one moves.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');

const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8');
const manifest = (f) => JSON.parse(read(f));

const APPS = [
  { manifest: 'manifest.webmanifest', page: 'index.html', title: 'Dividends' },
  { manifest: 'balances.webmanifest', page: 'balances.html', title: 'Balances' },
];

/* ------------------------------------------------------------- validity */

test('both manifests are valid JSON with the members an install needs', () => {
  for (const app of APPS) {
    const m = manifest(app.manifest);
    for (const key of ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'icons']) {
      assert.ok(m[key], `${app.manifest} has no ${key}`);
    }
    assert.strictEqual(m.display, 'standalone',
      `${app.manifest} would open in a browser tab, not as an app`);
    assert.ok(m.short_name.length <= 12,
      `${app.manifest} short_name "${m.short_name}" will be truncated under a home screen icon`);
  }
});

test('each app points at its own start_url', () => {
  assert.match(manifest('manifest.webmanifest').start_url, /index\.html$/);
  assert.match(manifest('balances.webmanifest').start_url, /balances\.html$/);
});

/* ------------------------------------------------------------- identity */

test('the two apps have distinct identities, so both can be installed', () => {
  const a = manifest('manifest.webmanifest');
  const b = manifest('balances.webmanifest');
  for (const key of ['id', 'name', 'short_name', 'start_url']) {
    assert.notStrictEqual(a[key], b[key],
      `both manifests share the same ${key}; the browser would treat them as one app`);
  }
});

test('the dividend app keeps the identity it was installed under', () => {
  // With no explicit id a browser derives one from start_url. Adding an id that
  // resolves anywhere else would orphan the copy already on the home screen -
  // it would not update, and a second icon would appear beside it.
  assert.strictEqual(manifest('manifest.webmanifest').id, '/dividend-tracker/index.html');
});

test('each scope actually contains its own start_url', () => {
  // A start_url outside its scope makes the app non-installable, and the only
  // symptom is the install prompt never appearing.
  for (const app of APPS) {
    const m = manifest(app.manifest);
    const base = 'https://example.test/dividend-tracker/';
    const start = new URL(m.start_url, base).href;
    const scope = new URL(m.scope, base).href;
    assert.ok(start.startsWith(scope),
      `${app.manifest}: start_url ${start} is outside scope ${scope}`);
  }
});

test('the balances scope is narrow enough not to swallow the dividend app', () => {
  const base = 'https://example.test/dividend-tracker/';
  const balancesScope = new URL(manifest('balances.webmanifest').scope, base).href;
  const dividendStart = new URL(manifest('manifest.webmanifest').start_url, base).href;
  assert.ok(!dividendStart.startsWith(balancesScope),
    'the Balances app claims the dividend page, so its links would open in the wrong app');
});

/* ---------------------------------------------------------------- icons */

test('every icon a manifest references exists', () => {
  for (const app of APPS) {
    for (const icon of manifest(app.manifest).icons) {
      const file = path.join(DOCS, icon.src);
      assert.ok(fs.existsSync(file), `${app.manifest} references a missing icon: ${icon.src}`);
      assert.ok(fs.statSync(file).size > 0, `${icon.src} is empty`);
    }
  }
});

test('the two apps do not share an icon', () => {
  // Two identical icons on a home screen defeats the entire point of shipping
  // them as separate apps.
  const srcs = APPS.map((a) => manifest(a.manifest).icons.map((i) => i.src));
  for (const src of srcs[0]) {
    assert.ok(!srcs[1].includes(src), `both apps use ${src} as their icon`);
  }
  const bytes = srcs.map((list) => list.map((s) => fs.readFileSync(path.join(DOCS, s)).toString('base64')));
  for (const b of bytes[0]) {
    assert.ok(!bytes[1].includes(b), 'the two icons have different names but identical contents');
  }
});

test('each page offers iOS a PNG touch icon', () => {
  // iOS ignores the manifest for Add to Home Screen and will not accept an SVG
  // here. Without a PNG it screenshots the page and uses that as the icon.
  for (const app of APPS) {
    const html = read(app.page);
    const m = html.match(/<link[^>]+rel="apple-touch-icon"[^>]+href="([^"]+)"/);
    assert.ok(m, `${app.page} has no apple-touch-icon`);
    assert.match(m[1], /\.png$/, `${app.page} offers iOS a ${path.extname(m[1])} icon`);
    assert.ok(fs.existsSync(path.join(DOCS, m[1])), `${app.page} touch icon is missing: ${m[1]}`);
  }
});

test('the touch icons are the size iOS actually asks for', () => {
  for (const name of ['icon-180.png', 'icon-balances-180.png']) {
    const buf = fs.readFileSync(path.join(DOCS, name));
    assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG', `${name} is not a PNG`);
    // Dimensions live in the IHDR chunk, which is always first.
    assert.strictEqual(buf.readUInt32BE(16), 180, `${name} is not 180 wide`);
    assert.strictEqual(buf.readUInt32BE(20), 180, `${name} is not 180 tall`);
  }
});

/* ----------------------------------------------------------------- html */

test('each page links its own manifest, not the other one', () => {
  for (const app of APPS) {
    const html = read(app.page);
    const m = html.match(/<link[^>]+rel="manifest"[^>]+href="([^"]+)"/);
    assert.ok(m, `${app.page} links no manifest and cannot be installed`);
    assert.strictEqual(m[1], app.manifest,
      `${app.page} links ${m[1]}, so installing it would install the other app`);
  }
});

test('each page tells iOS what to call it, distinctly', () => {
  const titles = APPS.map((app) => {
    const m = read(app.page).match(/<meta[^>]+name="apple-mobile-web-app-title"[^>]+content="([^"]+)"/);
    assert.ok(m, `${app.page} has no apple-mobile-web-app-title`);
    return m[1];
  });
  assert.notStrictEqual(titles[0], titles[1], 'both home screen icons would have the same label');
});

test('each page asks to run without browser chrome on iOS', () => {
  for (const app of APPS) {
    assert.match(read(app.page), /name="apple-mobile-web-app-capable"\s+content="yes"/,
      `${app.page} would open in Safari with a URL bar instead of as an app`);
  }
});

test('the theme colour in the page matches its manifest', () => {
  // They are read by different things - the manifest on install, the meta tag
  // at runtime - and a mismatch shows as the status bar changing colour the
  // moment the app opens.
  for (const app of APPS) {
    const m = read(app.page).match(/<meta\s+name="theme-color"\s+content="([^"]+)"/);
    assert.ok(m, `${app.page} has no theme-color`);
    assert.strictEqual(m[1].toLowerCase(), manifest(app.manifest).theme_color.toLowerCase(),
      `${app.page} theme-color disagrees with ${app.manifest}`);
  }
});

test('neither page carries the other in its header any more', () => {
  for (const app of APPS) {
    const html = read(app.page);
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.ok(header.length > 0, `${app.page} has no header`);
    assert.ok(!/<a\s/.test(header),
      `${app.page} still has a cross-link in its header; these are separate apps now`);
  }
});

test('each page still says where the other one lives', () => {
  // Removing the header links must not strand the second app: before it is
  // installed, a link is the only way to discover it.
  const pairs = [['index.html', 'balances.html'], ['balances.html', 'index.html']];
  for (const [page, other] of pairs) {
    const html = read(page);
    const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
    assert.ok(footer.includes(other), `${page} has no footer link to ${other}`);
  }
});

/* ------------------------------------------------------------------ sw */

test('everything both apps need to install is precached', () => {
  // An icon that 404s offline turns an installed app into a blank square, and
  // a manifest that 404s makes it uninstallable on a flaky connection.
  const sw = read('sw.js');
  const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  const wanted = new Set();
  for (const app of APPS) {
    wanted.add(app.manifest);
    wanted.add(app.page);
    for (const icon of manifest(app.manifest).icons) wanted.add(icon.src);
    const touch = read(app.page).match(/rel="apple-touch-icon"[^>]+href="([^"]+)"/);
    if (touch) wanted.add(touch[1]);
  }
  const missing = [...wanted].filter((f) => !shell.includes(`'./${f}'`));
  assert.deepStrictEqual(missing, [], `not precached by sw.js: ${missing.join(', ')}`);
});

test('the cache version was bumped, or nobody receives any of this', () => {
  // An installed app keeps serving the old cache until the version changes.
  const version = read('sw.js').match(/const CACHE = '([^']+)'/)[1];
  const n = Number(version.match(/v(\d+)$/)[1]);
  assert.ok(n >= 16, `CACHE is still ${version}; installed apps will not pick up the new files`);
});
