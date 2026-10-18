// The app's styles keep to the design system (site/design.html): colours
// only as tokens; sizes, radii, weights, spacing and control heights only
// from its scales; and no all-caps text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FONT_SIZES = ['11px', '12px', '13px', '14px', '16px', '20px', '24px'];
const RADII = ['0', '4px', '6px', '10px', '14px', '50%', '999px'];
const WEIGHTS = ['400', '500', '600'];
const SPACING = [0, 2, 4, 6, 8, 12, 16, 24, 32, 48]; // larger values are layout
const HEIGHTS = [24, 28, 32, 36, 40]; // controls; smaller ones are icons and lines

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sheets = Object.fromEntries(['web/app.css', 'site/site.css'].map((path) => [path, read(path)]));

// Styles live in those two files, so they are all checked here.
test('pages have no <style> blocks', () => {
  const pages = ['web/index.html', 'desktop/start.html', 'site/index.html', 'site/design.html', 'site/avatars.html'];
  assert.deepEqual(pages.filter((path) => /<style[\s>]/.test(read(path))), []);
});

// Every declaration outside the token blocks (`:root…{}` with no descendant)
// and the font faces.
function declarations(css) {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(:root[^{\s,]*|@font-face)\s*\{[^}]*\}/g, '');
  return [...rules.matchAll(/\{([^{}]*)\}/g)].flatMap(([, body]) => body.split(';'))
    .map((d) => d.match(/^\s*([a-z-]+)\s*:\s*([\s\S]+?)\s*$/)).filter(Boolean)
    .map(([, prop, value]) => ({ prop, value }));
}

for (const [file, css] of Object.entries(sheets)) {
  const decls = declarations(css);

  test(`${file}: colours are tokens`, () => {
    const literal = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch)\(|\b(black|white)\b/i;
    const bad = decls.filter(({ value }) => literal.test(value.replace(/url\([^)]*\)/g, '')));
    assert.deepEqual(bad, []);
  });

  test(`${file}: font sizes and weights are on the scale`, () => {
    const bad = decls.filter(({ prop, value }) => {
      if (prop === 'font-size') return /px$/.test(value) && !FONT_SIZES.includes(value);
      if (prop === 'font-weight') return !WEIGHTS.includes(value);
      if (prop === 'font') {
        const [, weight, size] = value.match(/^(?:(\d+)\s+)?(?:italic\s+)?([\d.]+px)?/) ?? [];
        return (weight && !WEIGHTS.includes(weight)) || (size && !FONT_SIZES.includes(size));
      }
      return false;
    });
    assert.deepEqual(bad, []);
  });

  test(`${file}: radii are on the scale`, () => {
    const bad = decls.filter(({ prop, value }) => prop.startsWith('border') && prop.endsWith('radius')
      && value.split(/\s+/).some((v) => !RADII.includes(v) && v !== 'inherit'));
    assert.deepEqual(bad, []);
  });

  test(`${file}: spacing and control heights are on the scale`, () => {
    const px = (value) => (/calc|var\(/.test(value) ? [] : [...value.matchAll(/-?([\d.]+)px/g)].map(([, n]) => Number(n)));
    const bad = decls.filter(({ prop, value }) => {
      if (/^(padding|margin|gap|row-gap|column-gap)(-|$)/.test(prop)) return px(value).some((n) => n <= 48 && !SPACING.includes(n));
      if (prop === 'height' || prop === 'min-height') return px(value).some((n) => n > 20 && n <= 40 && !HEIGHTS.includes(n));
      return false;
    });
    assert.deepEqual(bad, []);
  });

  test(`${file}: no all-caps text`, () => {
    assert.deepEqual(decls.filter(({ prop, value }) => prop === 'text-transform' && value !== 'none'), []);
  });
}
