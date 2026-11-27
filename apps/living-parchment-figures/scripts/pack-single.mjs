// Packs the Vite build into single self-contained HTML files that need no server or network:
//   dist-single/figures.html           a normal page: double-click it and it runs offline
//   dist-single/figures-artifact.html  the same app as a page body, for publishing as an Artifact
// Run `npm run build:single`.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const out = new URL('../dist-single/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const asset = (re) => {
  const m = html.match(re);
  if (!m) throw new Error(`Not in dist/index.html: ${re}`);
  return { tag: m[0], text: readFileSync(join(dist, m[1]), 'utf8') };
};
const js = asset(/<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/);
const css = asset(/<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/);

// Inline scripts end at the first "</script", so break any inside the bundle's strings.
const script = `<script type="module">\n${js.text.replace(/<\/(script)/gi, '<\\/$1')}\n</script>`;
const style = `<style>\n${css.text.replace(/<\/(style)/gi, '<\\/$1')}\n</style>`;

// Function replacers, because the bundle contains $& and $' sequences that a string replacement would expand.
const standalone = html
  .replace(js.tag, () => '')
  .replace(css.tag, () => style)
  .replace('</body>', () => `${script}\n</body>`);
writeFileSync(join(out, 'figures.html'), standalone);

// Artifact pages are published without doctype, html, head or body: title and styles first.
const title = html.match(/<title>[^<]*<\/title>/)[0];
const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
writeFileSync(join(out, 'figures-artifact.html'), `${title}\n${style}\n${body.trim()}\n${script}\n`);

for (const f of ['figures.html', 'figures-artifact.html']) {
  const size = readFileSync(join(out, f)).length;
  console.log(`${f}  ${(size / 1024).toFixed(0)} KB`);
}
