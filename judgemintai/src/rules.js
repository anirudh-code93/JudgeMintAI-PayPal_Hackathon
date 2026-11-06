// Rules profile: what ONE event (hackathon, contest, grant round...) requires of its entries.
// The audit agents read these rules instead of hard-coded PayPal rules, so the same engine can judge any event.
//
//   preset "paypal"  = the PayPal hackathon rules JudgeMintAI was first built for (PayPal agent, AI required, 3 minute video...)
//   preset "generic" = a blank sheet: the organiser names the technology/APIs entries must use and switches rules on or off

const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const bool = (v, d) => (v === undefined || v === null || v === '' ? d : v === true || v === 'true' || v === 1 || v === '1' || v === 'on');
const list = (v, max, n) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,;]+/) : [])
  .map((x) => clip(x, n)).filter(Boolean).slice(0, max);
const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) && !Number.isNaN(Date.parse(v)) ? String(v).trim() : '');

// Well-known technologies: typing just the name is enough, the detection details are filled in.
// hosts = API hostnames to look for in code, packages = SDK package names (a trailing "/" means "any package under this scope"),
// sandboxHints = text that shows the test/sandbox mode is used.
export const KNOWN_TECH = {
  paypal: { hosts: ['api-m.sandbox.paypal.com', 'api-m.paypal.com', 'paypal.com/sdk/js'], packages: ['@paypal/', 'paypal-rest-sdk', 'paypalrestsdk', 'paypalhttp'], sandboxHints: ['sandbox.paypal.com', 'PAYPAL_ENV', 'PAYPAL_MODE', "'sandbox'", '"sandbox"'] },
  stripe: { hosts: ['api.stripe.com', 'js.stripe.com'], packages: ['stripe', '@stripe/'], sandboxHints: ['sk_test_', 'pk_test_', 'STRIPE_TEST', 'test mode'] },
  twilio: { hosts: ['api.twilio.com'], packages: ['twilio'], sandboxHints: ['15005550006', 'test credentials', 'TWILIO_TEST'] },
  plaid: { hosts: ['sandbox.plaid.com', 'production.plaid.com', 'development.plaid.com'], packages: ['plaid', 'react-plaid-link'], sandboxHints: ['sandbox.plaid.com', 'PLAID_ENV', 'PlaidEnvironments.sandbox'] },
  openai: { hosts: ['api.openai.com'], packages: ['openai', '@openai/'] },
  anthropic: { hosts: ['api.anthropic.com'], packages: ['@anthropic-ai/sdk', 'anthropic'] },
  gemini: { hosts: ['generativelanguage.googleapis.com'], packages: ['@google/generative-ai', '@google/genai', 'google-generativeai'] },
  'google maps': { hosts: ['maps.googleapis.com', 'maps.google.com/maps/api'], packages: ['@googlemaps/', '@react-google-maps/api', 'googlemaps'] },
  mapbox: { hosts: ['api.mapbox.com'], packages: ['mapbox-gl', '@mapbox/'] },
  firebase: { hosts: ['firebaseio.com', 'firebaseapp.com', 'firestore.googleapis.com'], packages: ['firebase', 'firebase-admin', '@firebase/'] },
  supabase: { hosts: ['supabase.co'], packages: ['@supabase/', 'supabase'] },
  mongodb: { hosts: ['mongodb.net', 'mongodb+srv'], packages: ['mongodb', 'mongoose', 'pymongo'] },
  spotify: { hosts: ['api.spotify.com', 'accounts.spotify.com'], packages: ['spotify-web-api-node', 'spotipy'] },
  github: { hosts: ['api.github.com'], packages: ['@octokit/', 'pygithub'] },
  slack: { hosts: ['slack.com/api', 'hooks.slack.com'], packages: ['@slack/', 'slack-sdk', 'slack_sdk'] },
  discord: { hosts: ['discord.com/api', 'discordapp.com/api'], packages: ['discord.js', 'discord.py'] },
  shopify: { hosts: ['myshopify.com', 'shopify.dev'], packages: ['@shopify/', 'shopifyapi'] },
  solana: { hosts: ['api.mainnet-beta.solana.com', 'api.devnet.solana.com'], packages: ['@solana/'] },
  ethereum: { hosts: ['infura.io', 'alchemyapi.io'], packages: ['ethers', 'web3', 'hardhat', 'viem'] },
};

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normTech(x) {
  const raw = typeof x === 'string' ? { name: x } : (x && typeof x === 'object' ? x : {});
  const name = clip(raw.name, 60);
  if (!name) return null;
  const known = KNOWN_TECH[name.toLowerCase()] || {};
  const keywords = list(raw.keywords, 8, 60);
  return {
    name,
    keywords: [...new Set([name, ...keywords])],
    hosts: list(raw.hosts, 10, 120).length ? list(raw.hosts, 10, 120) : (known.hosts || []),
    packages: list(raw.packages, 10, 80).length ? list(raw.packages, 10, 80) : (known.packages || []),
    sandboxHints: list(raw.sandboxHints, 10, 80).length ? list(raw.sandboxHints, 10, 80) : (known.sandboxHints || []),
  };
}

export const PRESETS = {
  paypal: {
    preset: 'paypal',
    eventName: 'Build What’s Next with PayPal and AI',
    theme: '',
    requireAi: true,
    requiredTech: ['PayPal'],
    techMode: 'all',
    requireSandbox: true,
    requireLicense: true,
    requireVideo: true,
    videoMaxSeconds: 180,
    requireDemoOrRunSteps: true,
    windowStart: '',
    windowEnd: '',
    sponsors: null, // null = the ten sponsor tools of the PayPal hackathon
    customRules: [],
    complianceWeight: 0.2,
  },
  generic: {
    preset: 'generic',
    eventName: '',
    theme: '',
    requireAi: false,
    requiredTech: [],
    techMode: 'any',
    requireSandbox: false,
    requireLicense: true,
    requireVideo: false,
    videoMaxSeconds: 180,
    requireDemoOrRunSteps: true,
    windowStart: '',
    windowEnd: '',
    sponsors: [],
    customRules: [],
    complianceWeight: 0.2,
  },
};

/** Turn whatever the organiser sent into a complete, safe rules object. Unknown keys are dropped. */
export function normalizeRules(input = {}, presetName) {
  const src = input && typeof input === 'object' ? input : {};
  const name = presetName || src.preset;
  const base = PRESETS[name] || PRESETS.paypal;
  const pick = (k) => (src[k] === undefined ? base[k] : src[k]);

  const techRaw = src.requiredTech === undefined ? base.requiredTech : src.requiredTech;
  const techList = (Array.isArray(techRaw) ? techRaw : typeof techRaw === 'string' ? techRaw.split(/[\n,;]+/) : []).slice(0, 8);

  let sponsors = src.sponsors === undefined ? base.sponsors : src.sponsors;
  if (Array.isArray(sponsors)) {
    sponsors = sponsors.map((s) => {
      const o = typeof s === 'string' ? { name: s } : s;
      const n = clip(o?.name, 60);
      return n ? { name: n, keywords: [...new Set([n, ...list(o.keywords, 6, 60)])] } : null;
    }).filter(Boolean).slice(0, 15);
  } else if (typeof sponsors === 'string') {
    sponsors = sponsors.split(/[\n,;]+/).map((x) => clip(x, 60)).filter(Boolean).slice(0, 15).map((n) => ({ name: n, keywords: [n] }));
  } else sponsors = base.sponsors === null ? null : [];

  const cw = Number(pick('complianceWeight'));
  const maxSec = Number(pick('videoMaxSeconds'));
  return {
    preset: PRESETS[name] ? name : 'paypal',
    eventName: clip(pick('eventName'), 80),
    theme: clip(pick('theme'), 300),
    requireAi: bool(pick('requireAi'), base.requireAi),
    requiredTech: techList.map(normTech).filter(Boolean),
    techMode: pick('techMode') === 'all' ? 'all' : 'any',
    requireSandbox: bool(pick('requireSandbox'), base.requireSandbox),
    requireLicense: bool(pick('requireLicense'), base.requireLicense),
    requireVideo: bool(pick('requireVideo'), base.requireVideo),
    videoMaxSeconds: Number.isFinite(maxSec) ? Math.max(30, Math.min(3600, Math.round(maxSec))) : 180,
    requireDemoOrRunSteps: bool(pick('requireDemoOrRunSteps'), base.requireDemoOrRunSteps),
    windowStart: isoDay(pick('windowStart')),
    windowEnd: isoDay(pick('windowEnd')),
    sponsors,
    customRules: list(pick('customRules'), 10, 240),
    complianceWeight: Number.isFinite(cw) ? Math.max(0, Math.min(0.5, cw)) : 0.2,
  };
}

/** The single-audit page has no rules form: it always uses the PayPal hackathon rules. */
export const defaultRules = () => normalizeRules({}, 'paypal');

/** Which agents run for these rules, in display order. */
export function agentIds(rules) {
  const ids = ['technical'];
  if (rules.preset === 'paypal') ids.push('paypal');
  else if (rules.requiredTech.length) ids.push('apis');
  if (rules.preset === 'paypal' || rules.requireAi) ids.push('ai');
  ids.push('legal', 'submission');
  if (rules.sponsors === null || (Array.isArray(rules.sponsors) && rules.sponsors.length)) ids.push('sponsors');
  return ids;
}

/** Plain-words list of the rules, shown to organisers and judges so everyone sees what entries were held to. */
export function describeRules(rules) {
  const out = [];
  if (rules.requiredTech.length) {
    out.push(`${rules.techMode === 'all' ? 'Must use all of' : 'Must use at least one of'}: ${rules.requiredTech.map((t) => t.name).join(', ')}${rules.requireSandbox ? ' (test/sandbox mode)' : ''}`);
  }
  if (rules.preset === 'paypal' || rules.requireAi) out.push('Must meaningfully use AI');
  if (rules.requireLicense) out.push('Public repository with a visible open-source licence');
  if (rules.requireVideo) out.push(`Public YouTube demo video, at most ${Math.round(rules.videoMaxSeconds / 60 * 10) / 10} minutes`);
  if (rules.requireDemoOrRunSteps) out.push('Hosted demo or complete run instructions');
  if (rules.windowStart || rules.windowEnd) out.push(`Work during ${rules.windowStart || 'the start'} to ${rules.windowEnd || 'the deadline'}`);
  if (rules.theme) out.push(`Theme: ${rules.theme}`);
  for (const r of rules.customRules) out.push(r);
  return out;
}

/** Build a case-insensitive regex that matches any of the given literal words. */
export function anyOf(words, { word = true } = {}) {
  const parts = [...new Set(words.filter(Boolean))].map(escRe);
  if (!parts.length) return null;
  return new RegExp(word ? `\\b(?:${parts.join('|')})\\b` : `(?:${parts.join('|')})`, 'i');
}
