import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCssColor } from '../src/daemon/tools/color.js';

/**
 * Unit coverage for the CSS colour parser.
 *
 * The expected values here are anchors that hold by definition rather than
 * numbers copied out of this implementation: oklab(1 0 0) and lab(100 0 0)
 * are white because both spaces put the reference white at L=1 and L=100,
 * color(srgb ...) is sRGB already so its channels are just scaled by 255, and
 * color(display-p3 1 1 1) is white because the two spaces share a white point.
 * The values that cannot be derived that way are checked against Chromium
 * itself in diagnostics.test.ts, by painting the colour and reading the pixel
 * back out of a screenshot.
 */

function rounded(value: string): [number, number, number, number] {
  const parsed = parseCssColor(value);
  assert.ok(parsed !== null, `expected ${value} to parse`);
  return [Math.round(parsed.r), Math.round(parsed.g), Math.round(parsed.b), parsed.a];
}

test('the achromatic anchors of every supported space land exactly on white and black', () => {
  for (const white of ['oklab(1 0 0)', 'oklch(1 0 0)', 'lab(100 0 0)', 'lch(100 0 0)', 'color(display-p3 1 1 1)', 'color(rec2020 1 1 1)', 'color(a98-rgb 1 1 1)', 'color(prophoto-rgb 1 1 1)', 'color(srgb 1 1 1)', 'color(srgb-linear 1 1 1)', 'hwb(0 100% 0%)', 'hsl(0 0% 100%)']) {
    assert.deepEqual(rounded(white), [255, 255, 255, 1], `${white} is white`);
  }
  for (const black of ['oklab(0 0 0)', 'oklch(0 0 0)', 'lab(0 0 0)', 'lch(0 0 0)', 'color(display-p3 0 0 0)', 'color(xyz 0 0 0)', 'color(xyz-d50 0 0 0)', 'hwb(0 0% 100%)', 'hsl(0 0% 0%)']) {
    assert.deepEqual(rounded(black), [0, 0, 0, 1], `${black} is black`);
  }
});

test('color(srgb ...) is scaled straight onto 0 to 255 without a transfer function in the way', () => {
  const parsed = parseCssColor('color(srgb 0.5 0.25 0.125)');
  assert.ok(parsed !== null);
  assert.equal(parsed.r, 127.5);
  assert.equal(parsed.g, 63.75);
  assert.equal(parsed.b, 31.875);
  assert.equal(parsed.outOfGamut, false);
});

test('percentage components use the per-space reference the CSS spec gives them', () => {
  // 100% is 0.4 for oklch chroma, 150 for lch chroma, 125 for lab a and b,
  // and 1 for oklab lightness. Getting any of them wrong shifts the colour
  // rather than failing, which is why each is pinned.
  assert.deepEqual(rounded('oklch(0.7 50% 200)'), rounded('oklch(0.7 0.2 200)'));
  assert.deepEqual(rounded('oklab(60% 0.1 0)'), rounded('oklab(0.6 0.1 0)'));
  assert.deepEqual(rounded('lab(50% 32% 47.6%)'), rounded('lab(50 40 59.5)'));
  assert.deepEqual(rounded('lch(50% 46.667% 40)'), rounded('lch(50 70.0005 40)'));
  assert.deepEqual(rounded('color(srgb 50% 25% 12.5%)'), rounded('color(srgb 0.5 0.25 0.125)'));
});

test('hue accepts every angle unit, and a bare number means degrees', () => {
  const reference = rounded('oklch(0.5 0.1 180)');
  assert.deepEqual(rounded('oklch(0.5 0.1 180deg)'), reference);
  assert.deepEqual(rounded('oklch(0.5 0.1 0.5turn)'), reference);
  assert.deepEqual(rounded('oklch(0.5 0.1 200grad)'), reference);
  const radians = parseCssColor('oklch(0.5 0.1 3.14159265rad)');
  assert.ok(radians !== null);
  assert.ok(Math.abs(radians.r - (parseCssColor('oklch(0.5 0.1 180)') as { r: number }).r) < 0.01);
});

test('a none component behaves as zero, including a none alpha meaning fully transparent', () => {
  assert.deepEqual(rounded('oklab(0.5 0.1 none)'), rounded('oklab(0.5 0.1 0)'));
  assert.deepEqual(rounded('lab(50 none 20)'), rounded('lab(50 0 20)'));
  const noAlpha = parseCssColor('oklab(0.5 0.1 0.05 / none)');
  assert.ok(noAlpha !== null);
  assert.equal(noAlpha.a, 0, 'a none alpha is zero, which is what Chromium paints');
});

test('alpha is read from both the slash form and the legacy fourth component', () => {
  assert.equal(parseCssColor('oklab(0.5 0.1 0.05 / 0.4)')?.a, 0.4);
  assert.equal(parseCssColor('oklab(0.5 0.1 0.05 / 40%)')?.a, 0.4);
  assert.equal(parseCssColor('rgba(1, 2, 3, 0.25)')?.a, 0.25);
  assert.equal(parseCssColor('rgb(1 2 3 / 25%)')?.a, 0.25);
  assert.equal(parseCssColor('color(srgb 0 0 0 / 0.75)')?.a, 0.75);
  assert.equal(parseCssColor('rgb(1, 2, 3)')?.a, 1);
});

test('the values that used to be the whole problem now parse, and rgba still does', () => {
  // The two colours from the report that made every measurement on a
  // Tailwind v4 page report itself unreliable.
  assert.deepEqual(rounded('oklab(0.21783 -0.000773765 -0.0144868 / 0.4)'), [23, 26, 33, 0.4]);
  assert.deepEqual(rounded('oklab(0.374973 -0.00218269 -0.0273316 / 0.3)'), [58, 65, 80, 0.3]);
  assert.deepEqual(rounded('rgba(0, 0, 0, 0)'), [0, 0, 0, 0]);
  assert.deepEqual(rounded('rgb(18, 18, 18)'), [18, 18, 18, 1]);
  // extended carries the same colour before gamut clipping, which anything
  // compositing this has to use; for transparent it is trivially the same.
  assert.deepEqual(parseCssColor('transparent'), {
    r: 0,
    g: 0,
    b: 0,
    a: 0,
    outOfGamut: false,
    extended: { r: 0, g: 0, b: 0 }
  });
});

test('a colour outside sRGB is clipped per channel and says so', () => {
  const p3Red = parseCssColor('color(display-p3 1 0 0)');
  assert.ok(p3Red !== null);
  assert.deepEqual([p3Red.r, p3Red.g, p3Red.b], [255, 0, 0], 'clipped to the sRGB corner Chromium paints');
  assert.equal(p3Red.outOfGamut, true);

  const vividGreen = parseCssColor('oklch(0.9 0.4 140)');
  assert.ok(vividGreen !== null);
  assert.deepEqual([vividGreen.r, vividGreen.g, vividGreen.b], [0, 255, 0]);
  assert.equal(vividGreen.outOfGamut, true);

  // And a colour comfortably inside sRGB must not be flagged, or the flag
  // stops carrying information.
  assert.equal(parseCssColor('oklch(0.62796 0.25768 29.234)')?.outOfGamut, false);
  assert.equal(parseCssColor('rgb(128, 128, 128)')?.outOfGamut, false);
});

test('what it still cannot parse returns null rather than a plausible-looking colour', () => {
  for (const value of [
    'color(--custom-profile 1 0 0)',
    'color(hsl 1 0 0)',
    'oklab(0.5 0.1)',
    'oklab(0.5 0.1 0.2 0.3 0.4)',
    'oklab(0.5 0.1 / 0.5 / 0.2)',
    'oklch(0.5 0.1 20deg 30)',
    'oklab(0.5 nope 0.2)',
    'oklch(0.5 20% 30%)',
    'rebeccapurple',
    '#ff0000',
    'currentcolor',
    'color-mix(in oklab, red, blue)',
    'linear-gradient(red, blue)',
    'inherit',
    '',
    'oklab 0.5 0.1 0.2'
  ]) {
    assert.equal(parseCssColor(value), null, `${JSON.stringify(value)} must not parse into a guess`);
  }
});

test('whitespace and case do not change the answer', () => {
  assert.deepEqual(rounded('  OKLAB( 0.5 0.1 0.05 / 0.4 )  '), rounded('oklab(0.5 0.1 0.05 / 0.4)'));
  assert.deepEqual(rounded('COLOR(DISPLAY-P3 1 1 1)'), [255, 255, 255, 1]);
});
