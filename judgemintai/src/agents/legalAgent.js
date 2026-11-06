import { makeAgent, docEntries, sourceEntries, isTest } from './util.js';
import { defaultRules } from '../rules.js';

const OSI = new Set([
  'MIT', 'Apache-2.0', 'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'AGPL-3.0', 'BSD-2-Clause', 'BSD-3-Clause',
  'MPL-2.0', 'ISC', 'Unlicense', '0BSD', 'BSL-1.0', 'Zlib', 'EPL-2.0', 'GPL-2.0-only', 'GPL-3.0-only', 'AGPL-3.0-only',
]);

// Attempts to steer an automated judge (prompt injection) are a rules violation in themselves.
export const INJECTION = /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|prompts?|rules)|disregard (the |all )?(above|previous|prior)|(give|award|assign|rate) (this|the) (project|submission|repo(sitory)?) (a |the )?(full|perfect|maximum|highest|top)|(score|rate) (this )?(project )?(10\/10|100\/100|100%|perfect)|as an ai (judge|evaluator|grader)|system prompt\s*:|<\|im_start\|>|\[INST\]|you must (approve|pass) this/i;

const BRANDS = ['PayPal', 'Google', 'OpenAI', 'Anthropic', 'Microsoft', 'Amazon', 'Stripe', 'Visa', 'Mastercard'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "official / certified / endorsed by <brand>" claims. The event's own required technologies count as brands too.
function endorsementRe(extra) {
  const brands = [...new Set([...BRANDS, ...extra])].map(esc).join('|');
  return new RegExp(`\\b(official(ly)?|certified|endorsed|approved|authori[sz]ed|sponsored)\\b[^.\\n]{0,25}\\b(by\\s+)?(${brands})\\b|\\b(${brands})[- ](official|certified|endorsed|approved|authori[sz]ed|partner)\\b`, 'i');
}

export async function runLegalAgent(ctx) {
  const a = makeAgent('legal', 'Legal & Compliance Agent', 'Does the submission follow the rules: public repo, open-source licence, honest claims, compliant video?');
  const { repo, input, evidence } = ctx;
  const rules = ctx.rules || defaultRules();
  // Licence checks are switched off for events that do not ask for an open-source licence.
  const lic = (spec) => a.add(rules.requireLicense ? spec : { ...spec, status: 'na', detail: 'This event does not require an open-source licence.' });

  // ---- Repository: public + licence ----
  if (!repo.found) {
    a.add({ id: 'public', title: 'Public, open-source repository', weight: 30, status: 'fail', severity: 'critical', detail: repo.reason, fix: 'Publish the repo and add an OSI-approved LICENSE file.' });
  } else {
    const m = repo.meta;
    a.add({ id: 'public', title: 'Repository is public', weight: 15, status: m.isPrivate ? 'fail' : 'pass', severity: 'critical', detail: m.isPrivate ? 'Repository is private.' : 'Public on GitHub.', fix: 'Change repository visibility to Public.' });

    const licensed = m.licenseSpdx && m.licenseSpdx !== 'NOASSERTION';
    lic({
      id: 'license-visible', title: 'License is visible in the repo "About" section', weight: 25,
      status: licensed ? 'pass' : m.licenseSpdx === 'NOASSERTION' ? 'warn' : 'fail', severity: 'high',
      detail: licensed ? `GitHub detects: ${m.licenseName || m.licenseSpdx} (${m.licenseSpdx}).` : m.licenseSpdx === 'NOASSERTION' ? 'A license file exists but GitHub cannot identify it, so it will not show in About.' : 'No license detected. The rules require a visible open-source license.',
      fix: 'Add a standard LICENSE file (MIT or Apache-2.0 recommended): GitHub → Add file → Create new file → LICENSE → "Choose a license template".',
    });

    const osi = licensed && OSI.has(m.licenseSpdx);
    lic({
      id: 'license-osi', title: 'License is an OSI-approved open-source license', weight: 10,
      status: !licensed ? 'na' : osi ? 'pass' : 'warn', severity: 'medium',
      detail: !licensed ? 'No license to evaluate.' : osi ? `${m.licenseSpdx} is OSI-approved.` : `${m.licenseSpdx} may not be OSI-approved — check the Official Rules.`,
      fix: 'Switch to MIT, Apache-2.0, BSD-3-Clause or GPL-3.0.',
    });

    const licFile = repo.treePaths.find((p) => /^(license|licence|copying)(\.(md|txt))?$/i.test(p));
    lic({
      id: 'license-file', title: 'LICENSE file sits at the repo root', weight: 5,
      status: licFile ? 'pass' : 'fail', severity: 'medium',
      detail: licFile ? `Found ${licFile}.` : 'No LICENSE file at the top level.',
      fix: 'Place LICENSE at the repository root so judges see it immediately.',
    });
  }

  // ---- Demo video ----
  const v = evidence.video;
  const maxSec = rules.videoMaxSeconds;
  const limitWords = maxSec % 60 === 0 ? `${maxSec / 60} minutes` : `${maxSec} seconds`;
  const limitClock = `${Math.floor(maxSec / 60)}m ${String(maxSec % 60).padStart(2, '0')}s`;
  if (!rules.requireVideo) {
    a.add({ id: 'video-public', title: 'Demo video is on YouTube and public', weight: 15, status: 'na', detail: 'This event does not require a demo video.' });
    a.add({ id: 'video-length', title: `Demo video is under ${limitWords}`, weight: 10, status: 'na', detail: 'This event does not require a demo video.' });
  } else if (!input.videoUrl || !v?.valid) {
    a.add({ id: 'video-public', title: 'Demo video is on YouTube and public', weight: 15, status: 'fail', severity: 'high', detail: input.videoUrl ? 'The video link is not a valid YouTube URL.' : 'No demo video link supplied (required, must be YouTube).', fix: 'Upload the demo to YouTube as Public and paste the watch URL.' });
    a.add({ id: 'video-length', title: `Demo video is under ${limitWords}`, weight: 10, status: 'na', detail: 'No valid video to measure.' });
  } else {
    const api = v.api;
    if (api?.found === false) {
      a.add({ id: 'video-public', title: 'Demo video is on YouTube and public', weight: 15, status: 'fail', severity: 'high', detail: 'YouTube reports no such video (deleted or private).', fix: 'Make the video Public (not Unlisted/Private).' });
    } else if (api?.privacy) {
      a.add({ id: 'video-public', title: 'Demo video is on YouTube and public', weight: 15, status: api.privacy === 'public' ? 'pass' : 'fail', severity: 'high', detail: `YouTube privacy status: ${api.privacy}.`, fix: 'Set visibility to Public — judges may not see Unlisted videos.' });
    } else if (v.oembed?.ok) {
      a.add({ id: 'video-public', title: 'Demo video is on YouTube and public', weight: 15, status: 'pass', detail: `Video found: "${v.title}" by ${v.author}. (Unlisted videos also resolve — confirm it is set to Public.)` });
    } else if (v.oembed?.status === 404) {
      a.add({ id: 'video-public', title: 'Demo video is on YouTube and public', weight: 15, status: 'fail', severity: 'high', detail: 'YouTube returned 404 — the video does not exist or was removed.', fix: 'Check the link and upload the video as Public.' });
    } else {
      a.add({ id: 'video-public', title: 'Demo video is on YouTube and public', weight: 15, status: 'warn', severity: 'medium', detail: 'Could not confirm the video is public (private video, embedding disabled, or YouTube unreachable). Verify manually.', fix: 'Open the link in a private/incognito window to confirm it plays.' });
    }

    if (api?.durationSec != null) {
      const s = api.durationSec;
      a.add({ id: 'video-length', title: `Demo video is under ${limitWords}`, weight: 10, status: s <= maxSec ? 'pass' : 'fail', severity: 'high', detail: `Duration ${Math.floor(s / 60)}m ${s % 60}s (limit ${limitClock}; judges are not required to watch longer).`, fix: `Trim the video to under ${limitWords} and re-upload.` });
    } else {
      a.add({ id: 'video-length', title: `Demo video is under ${limitWords}`, weight: 10, status: 'na', detail: `Duration cannot be read without a YOUTUBE_API_KEY. Verify manually: must be under ${limitWords}.` });
    }

    const risky = /(official (music )?video|lyrics?|ft\.|feat\.|\(audio\)|full movie|trailer)/i.test(v.title || '');
    a.add({
      id: 'video-copyright', title: 'Video avoids third-party trademarks / copyrighted material', weight: 5,
      status: risky ? 'warn' : 'na', severity: 'medium',
      detail: risky ? `The video title ("${v.title}") hints at third-party media. The rules forbid copyrighted music/material without permission.` : 'Cannot be machine-verified. Manually confirm: no copyrighted music, no third-party logos beyond fair use.',
      fix: 'Use royalty-free music (or none) and avoid showing unrelated brand assets.',
    });
  }

  // ---- Honest claims & fair play ----
  const textBlob = `${input.description}\n${input.toolsUsed}\n${input.projectName}`;
  const readme = repo.found ? Object.entries(repo.files).filter(([p]) => /^readme/i.test(p)).map(([, t]) => t).join('\n') : '';
  const endorse = (textBlob + '\n' + readme).match(endorsementRe(rules.requiredTech.map((t) => t.name)));
  a.add({
    id: 'endorsement', title: 'No false endorsement / affiliation claims', weight: 10,
    status: endorse ? 'warn' : 'pass', severity: 'medium',
    detail: endorse ? `The text implies an official relationship: "${endorse[0].trim().slice(0, 80)}". Third-party trademarks must not suggest endorsement.` : 'No claims of official partnership or endorsement.',
    fix: 'Say "built with <brand>\'s APIs" rather than "official/certified/endorsed by <brand>".',
  });

  const injectionHits = [];
  const testOnlyHits = [];
  if (INJECTION.test(textBlob)) injectionHits.push('submission description/tools text');
  if (repo.found) {
    for (const [p, t] of [...docEntries(repo), ...sourceEntries(repo)]) {
      if (!INJECTION.test(t)) continue;
      // Security tools legitimately keep such phrases as test fixtures: downgrade, don't ignore.
      (isTest(p) ? testOnlyHits : injectionHits).push(p);
    }
  }
  const real = injectionHits.length > 0;
  a.add({
    id: 'integrity', title: 'No attempt to manipulate automated judging', weight: 10,
    status: real ? 'fail' : testOnlyHits.length ? 'warn' : 'pass', severity: real ? 'high' : 'low',
    detail: real
      ? `Text that tries to instruct an AI judge (prompt injection) was found in: ${injectionHits.slice(0, 3).join(', ')}.`
      : testOnlyHits.length
        ? `Judge-manipulation phrases appear only inside test files (${testOnlyHits.slice(0, 2).join(', ')}) — fine if they are detector fixtures.`
        : 'No hidden instructions aimed at AI evaluators were found.',
    fix: 'Remove any text addressed to AI judges. Attempting to game judging can lead to disqualification.',
    evidence: [...injectionHits, ...testOnlyHits].slice(0, 3),
  });

  return a.result({ injectionAttempt: real });
}
