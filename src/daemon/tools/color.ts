/**
 * CSS colour parsing and conversion to sRGB, for the diagnostics tools that
 * composite colours and measure contrast.
 *
 * This exists as its own module because getting it wrong is silent. A colour
 * that fails to parse used to be treated as transparent, and the tools said
 * so honestly, but on any Tailwind v4 page that meant most of the ancestor
 * chain was unusable: Tailwind emits oklab() and oklch() everywhere, including
 * for every colour that carries an alpha channel, so the honest warning fired
 * on almost every measurement.
 *
 * What getComputedStyle in Chromium actually hands back, verified against the
 * browser rather than assumed:
 *
 *   - hwb(), modern space-separated rgb()/hsl() with a slash alpha, and
 *     currentColor are already resolved down to rgb()/rgba() before they
 *     reach us. They are parsed here anyway, cheaply, so that a caller
 *     feeding this function a raw stylesheet value is not surprised.
 *   - color-mix() is resolved too, into oklab(), so supporting oklab() covers
 *     it. There is no separate color-mix parser and none is needed.
 *   - oklab(), oklch(), lab(), lch() and color() survive into the computed
 *     value unchanged, which is the gap this module closes.
 *   - color(xyz ...) is serialised as color(xyz-d65 ...).
 *   - A `none` component stays `none` in the computed value and behaves as
 *     zero, including for alpha, where `none` really does mean fully
 *     transparent. That is what Chromium paints.
 *
 * Out-of-gamut handling: CLIPPING, per channel, after conversion to sRGB.
 * A display-p3 or wide-gamut oklch colour can land outside sRGB, and there is
 * then no true sRGB value for it. Clipping is what Chromium itself paints on
 * an sRGB output (color(display-p3 1 0 0) reads back as rgb(255, 0, 0) from a
 * canvas, and oklch(0.9 0.4 140) as rgb(0, 255, 0)), and WCAG's luminance
 * formula is defined on sRGB only, so clipping keeps the reported ratio in
 * step with both the screen and the standard. Gamut mapping by chroma
 * reduction would give a different, prettier colour that nothing on an sRGB
 * screen actually shows. Every clipped conversion is flagged through
 * `outOfGamut` so a caller can tell the difference rather than guess.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * A parsed colour in sRGB, with a flag saying whether reaching sRGB required
 * clipping a channel that fell outside the gamut.
 */
export interface ParsedCssColor extends Rgba {
  outOfGamut: boolean;
}

const fullyTransparent: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/** Channel values this far outside [0, 1] are float noise, not a real gamut excursion. */
const gamutEpsilon = 1e-4;

type Vector3 = [number, number, number];
type Matrix3 = [Vector3, Vector3, Vector3];

function apply(matrix: Matrix3, v: Vector3): Vector3 {
  return [
    matrix[0][0] * v[0] + matrix[0][1] * v[1] + matrix[0][2] * v[2],
    matrix[1][0] * v[0] + matrix[1][1] * v[1] + matrix[1][2] * v[2],
    matrix[2][0] * v[0] + matrix[2][1] * v[1] + matrix[2][2] * v[2]
  ];
}

/** Raises |value| to an exponent and puts the sign back, so negative channels stay negative. */
function signedPow(value: number, exponent: number): number {
  return Math.sign(value) * Math.pow(Math.abs(value), exponent);
}

// Matrices are the ones published in CSS Color Level 4, kept at full precision.

const xyzD65ToLinearSrgb: Matrix3 = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786]
];

const linearP3ToXyzD65: Matrix3 = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0.0, 0.04511338185890264, 1.043944368900976]
];

const linearA98ToXyzD65: Matrix3 = [
  [0.5766690429101305, 0.1855582379065463, 0.1882286462349947],
  [0.29734497525053605, 0.6273635662554661, 0.07529145849399788],
  [0.02703136138641234, 0.07068885253582723, 0.9913375368376388]
];

const linearProPhotoToXyzD50: Matrix3 = [
  [0.7977604896723027, 0.13518583717574031, 0.0313493495815248],
  [0.2880711282292934, 0.7118432178101014, 0.00008565396060525902],
  [0.0, 0.0, 0.8251046025104601]
];

const linearRec2020ToXyzD65: Matrix3 = [
  [0.6369580483012914, 0.14461690358620832, 0.1688809751641721],
  [0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
  [0.0, 0.028072693049087428, 1.0609850577107909]
];

/** Bradford-adapted D50 to D65, the transform CSS Color 4 specifies for lab() and xyz-d50. */
const xyzD50ToD65: Matrix3 = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753]
];

/** The sRGB transfer function, inverted: gamma-encoded channel to linear light. */
function srgbToLinear(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= 0.04045) return value / 12.92;
  return Math.sign(value) * Math.pow((magnitude + 0.055) / 1.055, 2.4);
}

/** Linear light back to a gamma-encoded sRGB channel. */
function linearToSrgb(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= 0.0031308) return value * 12.92;
  return Math.sign(value) * (1.055 * Math.pow(magnitude, 1 / 2.4) - 0.055);
}

function a98ToLinear(value: number): number {
  return signedPow(value, 563 / 256);
}

function proPhotoToLinear(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= 16 / 512) return value / 16;
  return signedPow(value, 1.8);
}

function rec2020ToLinear(value: number): number {
  const alpha = 1.09929682680944;
  const beta = 0.018053968510807;
  const magnitude = Math.abs(value);
  if (magnitude < beta * 4.5) return value / 4.5;
  return Math.sign(value) * Math.pow((magnitude + alpha - 1) / alpha, 1 / 0.45);
}

/** CIE Lab uses a D50 reference white in CSS, not D65. */
const labWhiteD50: Vector3 = [0.3457 / 0.3585, 1.0, (1.0 - 0.3457 - 0.3585) / 0.3585];

function labToXyzD50(l: number, a: number, b: number): Vector3 {
  const kappa = 24389 / 27;
  const epsilon = 216 / 24389;
  const fy = (l + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const x = Math.pow(fx, 3) > epsilon ? Math.pow(fx, 3) : (116 * fx - 16) / kappa;
  const y = l > kappa * epsilon ? Math.pow((l + 16) / 116, 3) : l / kappa;
  const z = Math.pow(fz, 3) > epsilon ? Math.pow(fz, 3) : (116 * fz - 16) / kappa;
  return [x * labWhiteD50[0], y * labWhiteD50[1], z * labWhiteD50[2]];
}

function oklabToLinearSrgb(l: number, a: number, b: number): Vector3 {
  const lCone = l + 0.3963377773761749 * a + 0.2158037573099136 * b;
  const mCone = l - 0.1055613458156586 * a - 0.0638541728258133 * b;
  const sCone = l - 0.0894841775298119 * a - 1.2914855480194092 * b;
  const lCubed = lCone * lCone * lCone;
  const mCubed = mCone * mCone * mCone;
  const sCubed = sCone * sCone * sCone;
  return [
    4.076741661347994 * lCubed - 3.307711590408193 * mCubed + 0.230969928729428 * sCubed,
    -1.2684380040921763 * lCubed + 2.6097574006633715 * mCubed - 0.3413193963102197 * sCubed,
    -0.004196086541837188 * lCubed - 0.7034186144594493 * mCubed + 1.7076147009309444 * sCubed
  ];
}

/** Polar to rectangular for the lch()/oklch() families. Hue arrives already in degrees. */
function polarToRectangular(chroma: number, hueDegrees: number): [number, number] {
  const radians = (hueDegrees * Math.PI) / 180;
  return [chroma * Math.cos(radians), chroma * Math.sin(radians)];
}

interface Token {
  /** The numeric value, with `none` already collapsed to zero. */
  value: number;
  /** Whether the token was written as a percentage, which scales differently per component. */
  percent: boolean;
  /** The angle unit, if the token carried one. */
  angleUnit: 'deg' | 'rad' | 'grad' | 'turn' | null;
}

/**
 * Splits the inside of a colour function into components and an optional
 * alpha. Legacy comma syntax and modern space syntax both land here, because
 * commas, whitespace and the alpha slash are all just separators once the
 * alpha has been peeled off.
 */
function splitComponents(body: string): { components: string[]; alpha: string | null } | null {
  const slashIndex = body.indexOf('/');
  const head = slashIndex === -1 ? body : body.slice(0, slashIndex);
  const tail = slashIndex === -1 ? null : body.slice(slashIndex + 1);
  if (tail !== null && tail.includes('/')) return null;
  const components = head.split(/[\s,]+/).filter(part => part.length > 0);
  if (tail === null) return { components, alpha: null };
  const alphaParts = tail.split(/[\s,]+/).filter(part => part.length > 0);
  if (alphaParts.length !== 1) return null;
  return { components, alpha: alphaParts[0] };
}

const anglePattern = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(deg|rad|grad|turn)$/;

function tokenize(part: string): Token | null {
  if (part === 'none') return { value: 0, percent: false, angleUnit: null };
  if (part.endsWith('%')) {
    const value = Number(part.slice(0, -1));
    return Number.isFinite(value) ? { value, percent: true, angleUnit: null } : null;
  }
  const angle = anglePattern.exec(part);
  if (angle !== null) {
    const value = Number(angle[1]);
    if (!Number.isFinite(value)) return null;
    return { value, percent: false, angleUnit: angle[2] as Token['angleUnit'] };
  }
  const value = Number(part);
  return Number.isFinite(value) ? { value, percent: false, angleUnit: null } : null;
}

function toDegrees(token: Token): number | null {
  if (token.percent) return null;
  switch (token.angleUnit) {
    case null:
    case 'deg':
      return token.value;
    case 'rad':
      return (token.value * 180) / Math.PI;
    case 'grad':
      return token.value * 0.9;
    case 'turn':
      return token.value * 360;
  }
}

/**
 * A component that may be written as a number or a percentage, where the
 * percentage maps 100% onto `percentReference`.
 */
function scalar(token: Token, percentReference: number): number | null {
  if (token.angleUnit !== null) return null;
  return token.percent ? (token.value * percentReference) / 100 : token.value;
}

/**
 * A component written as a percentage, or as a bare number that means the
 * same percentage. That is how modern hsl() and hwb() define saturation,
 * lightness, whiteness and blackness: hsl(120 50 25) is hsl(120 50% 25%).
 */
function percentageComponent(token: Token): number | null {
  if (token.angleUnit !== null) return null;
  return token.value / 100;
}

function parseAlpha(part: string | null): number | null {
  if (part === null) return 1;
  const token = tokenize(part);
  if (token === null || token.angleUnit !== null) return null;
  return token.percent ? token.value / 100 : token.value;
}

/** Clamps to [0, 1] and reports whether anything actually had to be clamped. */
function clipToGamut(rgb: Vector3): { rgb: Vector3; outOfGamut: boolean } {
  let outOfGamut = false;
  const clipped = rgb.map(channel => {
    if (channel < -gamutEpsilon || channel > 1 + gamutEpsilon) outOfGamut = true;
    return Math.min(1, Math.max(0, channel));
  }) as Vector3;
  return { rgb: clipped, outOfGamut };
}

function finish(linear: Vector3, alpha: number): ParsedCssColor {
  const encoded: Vector3 = [linearToSrgb(linear[0]), linearToSrgb(linear[1]), linearToSrgb(linear[2])];
  const { rgb, outOfGamut } = clipToGamut(encoded);
  return {
    r: rgb[0] * 255,
    g: rgb[1] * 255,
    b: rgb[2] * 255,
    a: Math.min(1, Math.max(0, alpha)),
    outOfGamut
  };
}

/** Already gamma-encoded sRGB in 0 to 1, so only clipping and scaling are left. */
function finishEncoded(encoded: Vector3, alpha: number): ParsedCssColor {
  const { rgb, outOfGamut } = clipToGamut(encoded);
  return {
    r: rgb[0] * 255,
    g: rgb[1] * 255,
    b: rgb[2] * 255,
    a: Math.min(1, Math.max(0, alpha)),
    outOfGamut
  };
}

const predefinedSpaces = [
  'srgb',
  'srgb-linear',
  'display-p3',
  'a98-rgb',
  'prophoto-rgb',
  'rec2020',
  'xyz',
  'xyz-d50',
  'xyz-d65'
] as const;

type PredefinedSpace = (typeof predefinedSpaces)[number];

function isPredefinedSpace(name: string): name is PredefinedSpace {
  return (predefinedSpaces as readonly string[]).includes(name);
}

/** Converts one `color()` space's three components into linear sRGB. */
function predefinedToLinearSrgb(space: PredefinedSpace, channels: Vector3): Vector3 {
  switch (space) {
    case 'srgb':
      return [srgbToLinear(channels[0]), srgbToLinear(channels[1]), srgbToLinear(channels[2])];
    case 'srgb-linear':
      return channels;
    case 'display-p3': {
      const linear: Vector3 = [srgbToLinear(channels[0]), srgbToLinear(channels[1]), srgbToLinear(channels[2])];
      return apply(xyzD65ToLinearSrgb, apply(linearP3ToXyzD65, linear));
    }
    case 'a98-rgb': {
      const linear: Vector3 = [a98ToLinear(channels[0]), a98ToLinear(channels[1]), a98ToLinear(channels[2])];
      return apply(xyzD65ToLinearSrgb, apply(linearA98ToXyzD65, linear));
    }
    case 'prophoto-rgb': {
      const linear: Vector3 = [
        proPhotoToLinear(channels[0]),
        proPhotoToLinear(channels[1]),
        proPhotoToLinear(channels[2])
      ];
      return apply(xyzD65ToLinearSrgb, apply(xyzD50ToD65, apply(linearProPhotoToXyzD50, linear)));
    }
    case 'rec2020': {
      const linear: Vector3 = [
        rec2020ToLinear(channels[0]),
        rec2020ToLinear(channels[1]),
        rec2020ToLinear(channels[2])
      ];
      return apply(xyzD65ToLinearSrgb, apply(linearRec2020ToXyzD65, linear));
    }
    case 'xyz':
    case 'xyz-d65':
      return apply(xyzD65ToLinearSrgb, channels);
    case 'xyz-d50':
      return apply(xyzD65ToLinearSrgb, apply(xyzD50ToD65, channels));
  }
}

function hueToChannel(p: number, q: number, tRaw: number): number {
  let t = tRaw;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToEncodedSrgb(hueDegrees: number, saturation: number, lightness: number): Vector3 {
  const hue = (((hueDegrees % 360) + 360) % 360) / 360;
  const s = Math.min(1, Math.max(0, saturation));
  const l = Math.min(1, Math.max(0, lightness));
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToChannel(p, q, hue + 1 / 3), hueToChannel(p, q, hue), hueToChannel(p, q, hue - 1 / 3)];
}

/**
 * Parses the CSS colour syntaxes that can reach a computed value, and returns
 * sRGB in 0 to 255 with straight alpha.
 *
 * Covered: rgb()/rgba() and hsl()/hsla() in both legacy comma form and modern
 * space form with a slash alpha, hwb(), lab(), lch(), oklab(), oklch(),
 * color() in the predefined spaces srgb, srgb-linear, display-p3, a98-rgb,
 * prophoto-rgb, rec2020, xyz, xyz-d50 and xyz-d65, plus the keyword
 * `transparent`. color-mix() and currentColor need no special handling because
 * getComputedStyle has already resolved them, into oklab() and into an rgb()
 * respectively.
 *
 * NOT covered, and these still return null so the caller can report an honest
 * failure rather than invent a colour: named colours and hex, which never
 * appear in a computed value; system colours other than through the browser's
 * own resolution; `color(from ...)` and other relative colour syntax;
 * light-dark() if a future Chromium stops resolving it; and any custom
 * `@color-profile` space.
 */
export function parseCssColor(value: string): ParsedCssColor | null {
  const raw = value.trim().toLowerCase();
  if (raw === 'transparent') return { ...fullyTransparent, outOfGamut: false };

  const match = /^([a-z-]+)\(([^()]*)\)$/.exec(raw);
  if (match === null) return null;
  const fn = match[1];
  const split = splitComponents(match[2]);
  if (split === null) return null;
  const { components, alpha: alphaPart } = split;

  // color() carries its space as the first component, so it is peeled off
  // before the numeric tokens are read.
  if (fn === 'color') {
    if (components.length !== 4) return null;
    const space = components[0];
    if (!isPredefinedSpace(space)) return null;
    const tokens = components.slice(1).map(tokenize);
    if (tokens.some(token => token === null)) return null;
    const channels = (tokens as Token[]).map(token => scalar(token, 1));
    if (channels.some(channel => channel === null)) return null;
    const alpha = parseAlpha(alphaPart);
    if (alpha === null) return null;
    const linear = predefinedToLinearSrgb(space, channels as Vector3);
    return finish(linear, alpha);
  }

  // Legacy comma syntax puts alpha in a fourth component rather than after a
  // slash, which is exactly what Chromium serialises rgba() as. Only the four
  // functions that have a legacy form get this: a fourth component anywhere
  // else is a malformed colour, not an alpha channel.
  const hasLegacyForm = fn === 'rgb' || fn === 'rgba' || fn === 'hsl' || fn === 'hsla';
  const takesFourth = hasLegacyForm && alphaPart === null && components.length === 4;
  const legacyAlpha = takesFourth ? components[3] : alphaPart;
  const channels = takesFourth ? components.slice(0, 3) : components;
  if (channels.length !== 3) return null;
  const tokens = channels.map(tokenize);
  if (tokens.some(token => token === null)) return null;
  const [first, second, third] = tokens as [Token, Token, Token];
  const alpha = parseAlpha(legacyAlpha);
  if (alpha === null) return null;

  switch (fn) {
    case 'rgb':
    case 'rgba': {
      // 100% is 255 here, and the channels are already gamma-encoded sRGB.
      const r = scalar(first, 255);
      const g = scalar(second, 255);
      const b = scalar(third, 255);
      if (r === null || g === null || b === null) return null;
      return finishEncoded([r / 255, g / 255, b / 255], alpha);
    }
    case 'hsl':
    case 'hsla': {
      const hue = toDegrees(first);
      const saturation = percentageComponent(second);
      const lightness = percentageComponent(third);
      if (hue === null || saturation === null || lightness === null) return null;
      return finishEncoded(hslToEncodedSrgb(hue, saturation, lightness), alpha);
    }
    case 'hwb': {
      const hue = toDegrees(first);
      const whiteness = percentageComponent(second);
      const blackness = percentageComponent(third);
      if (hue === null || whiteness === null || blackness === null) return null;
      let w = whiteness;
      let bl = blackness;
      if (w + bl >= 1) {
        const grey = w / (w + bl);
        return finishEncoded([grey, grey, grey], alpha);
      }
      const base = hslToEncodedSrgb(hue, 1, 0.5);
      return finishEncoded(base.map(channel => channel * (1 - w - bl) + w) as Vector3, alpha);
    }
    case 'lab': {
      const l = scalar(first, 100);
      const a = scalar(second, 125);
      const b = scalar(third, 125);
      if (l === null || a === null || b === null) return null;
      const xyzD65 = apply(xyzD50ToD65, labToXyzD50(l, a, b));
      return finish(apply(xyzD65ToLinearSrgb, xyzD65), alpha);
    }
    case 'lch': {
      const l = scalar(first, 100);
      const chroma = scalar(second, 150);
      const hue = toDegrees(third);
      if (l === null || chroma === null || hue === null) return null;
      const [a, b] = polarToRectangular(chroma, hue);
      const xyzD65 = apply(xyzD50ToD65, labToXyzD50(l, a, b));
      return finish(apply(xyzD65ToLinearSrgb, xyzD65), alpha);
    }
    case 'oklab': {
      const l = scalar(first, 1);
      const a = scalar(second, 0.4);
      const b = scalar(third, 0.4);
      if (l === null || a === null || b === null) return null;
      return finish(oklabToLinearSrgb(l, a, b), alpha);
    }
    case 'oklch': {
      const l = scalar(first, 1);
      const chroma = scalar(second, 0.4);
      const hue = toDegrees(third);
      if (l === null || chroma === null || hue === null) return null;
      const [a, b] = polarToRectangular(chroma, hue);
      return finish(oklabToLinearSrgb(l, a, b), alpha);
    }
    default:
      return null;
  }
}
