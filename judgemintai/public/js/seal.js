import { svg } from './util.js';

// The verdict seal is the one memorable object in the interface: an assay-office hallmark
// stamped on every scorecard. It is drawn in SVG so it stays crisp and prints cleanly.

const INK = { pass: '#1B6B45', review: '#835500', fail: '#A4262C', neutral: '#0F3A30' };
let uid = 0;

function serratedRing(cx, cy, r, teeth, depth) {
  const pts = [];
  for (let i = 0; i <= 360; i++) {
    const a = (i * Math.PI) / 180;
    const rr = r + depth * Math.sin(a * teeth);
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

/** Hypotrochoid "spirograph" curve: the engraving pattern found on banknotes and certificates. */
export function rosettePath({ R = 96, r = 36, d = 40, steps = 700, cx = 0, cy = 0, scale = 1 }) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const turns = r / gcd(R, r);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 * turns;
    const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
    pts.push(`${(cx + x * scale).toFixed(1)},${(cy + y * scale).toFixed(1)}`);
  }
  return `M${pts.join('L')}`;
}

export function rosetteSVG({ size = 520, stroke = '#B9D7C6', opacity = 1, className = '' }) {
  const half = size / 2;
  const scale = (half * 0.96) / 96;
  const curves = [
    { R: 96, r: 36, d: 34 },
    { R: 96, r: 36, d: 46 },
    { R: 96, r: 36, d: 58 },
    { R: 96, r: 40, d: 30 },
  ];
  return svg('svg', { class: className, viewBox: `0 0 ${size} ${size}`, width: size, height: size, 'aria-hidden': 'true', focusable: 'false', style: `opacity:${opacity}` },
    curves.map((c) => svg('path', { d: rosettePath({ ...c, cx: half, cy: half, scale }), fill: 'none', stroke, 'stroke-width': 0.6 })));
}

/**
 * @param {{score:number|null, verdictKey:'pass'|'review'|'fail'|'neutral', word:string, size?:number, ringText?:string}} o
 */
// Non-breaking spaces keep the gaps from collapsing inside SVG text.
const NB = ' ';
const RING_TEXT = ['JUDGEMINT ASSAY OFFICE', 'FIVE AGENTS', 'SANDBOX TESTED'].map((t) => `${t}${NB}${NB}•${NB}${NB}`).join('');

export function sealSVG({ score, verdictKey = 'neutral', word = '', size = 220, ringText = RING_TEXT }) {
  const ink = INK[verdictKey] || INK.neutral;
  const id = `seal${++uid}`;
  const label = score == null ? 'Audit seal' : `Score ${score} out of 100, verdict ${word.toLowerCase()}`;

  const root = svg('svg', { class: 'seal', viewBox: '0 0 200 200', width: size, height: size, role: 'img', 'aria-label': label });

  const defs = svg('defs', {},
    // slightly ragged edges and ink dropout, like a rubber stamp pressed on paper
    svg('filter', { id: `${id}-rough`, x: '-5%', y: '-5%', width: '110%', height: '110%' },
      svg('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.9', numOctaves: '2', seed: '4', result: 'noise' }),
      svg('feDisplacementMap', { in: 'SourceGraphic', in2: 'noise', scale: '1.4', result: 'wobble' }),
      // sparse specks of missing ink: only the highest noise values punch through
      svg('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.45', numOctaves: '1', seed: '9', result: 'grain' }),
      svg('feColorMatrix', { in: 'grain', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -7 5.6', result: 'mask' }),
      svg('feComposite', { in: 'wobble', in2: 'mask', operator: 'in' })),
    svg('path', { id: `${id}-ring`, d: 'M100,100 m-71,0 a71,71 0 1,1 142,0 a71,71 0 1,1 -142,0' }));
  root.append(defs);

  const g = svg('g', { filter: `url(#${id}-rough)`, color: ink });
  g.append(
    svg('path', { d: serratedRing(100, 100, 94, 64, 2.1), fill: 'none', stroke: ink, 'stroke-width': 2.4 }),
    svg('circle', { cx: 100, cy: 100, r: 86, fill: 'none', stroke: ink, 'stroke-width': 1 }),
    svg('circle', { cx: 100, cy: 100, r: 57, fill: 'none', stroke: ink, 'stroke-width': 1.4 }),
    svg('text', { 'font-family': 'var(--f-body)', 'font-size': 9.4, 'font-weight': 600, fill: ink },
      svg('textPath', { href: `#${id}-ring`, startOffset: '0', textLength: 446, lengthAdjust: 'spacing' }, ringText)),
    svg('text', { x: 100, y: 105, 'text-anchor': 'middle', 'font-family': 'var(--f-display)', 'font-size': score != null && score >= 100 ? 50 : 58, 'font-weight': 800, fill: ink }, score == null ? '–' : String(score)),
    svg('path', { d: 'M62 113.5h76', stroke: ink, 'stroke-width': 1.2 }),
    svg('text', { x: 100, y: 133, 'text-anchor': 'middle', 'font-family': 'var(--f-display)', 'font-size': 20, 'font-weight': 800, 'letter-spacing': 2.5, fill: ink }, word));
  root.append(g);
  return root;
}
