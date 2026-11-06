import { makeAgent } from './util.js';
import { defaultRules, anyOf } from '../rules.js';

const AI_WORDS = /\b(ai|llm|agent|model|gpt|gemini|claude|machine learning)\b/i;

export async function runSubmissionAgent(ctx) {
  const a = makeAgent('submission', 'Submission Completeness Agent', 'Does the entry contain everything the "What to Submit" rules ask for?');
  const { repo, input, evidence } = ctx;
  const rules = ctx.rules || defaultRules();
  const desc = (input.description || '').trim();
  const paypal = rules.preset === 'paypal';
  const techNames = rules.requiredTech.map((t) => t.name);

  a.add({
    id: 'description', title: 'Text description of features & functionality', weight: 20,
    status: desc.length >= 200 ? 'pass' : desc.length >= 80 ? 'warn' : 'fail', severity: 'high',
    detail: `${desc.length} characters. ${desc.length < 200 ? 'Aim for 200+ characters covering problem, solution, features and how it works.' : ''}`.trim(),
    fix: paypal
      ? 'Write a description with: the problem, what the product does, key features, and how PayPal + AI are used.'
      : `Write a description with: the problem, what the product does, key features${techNames.length ? `, and how ${techNames.join(' and ')}${rules.requireAi ? ' and AI are' : ' is'} used` : ''}.`,
  });

  if (paypal) {
    a.add({
      id: 'mentions', title: 'Description explains BOTH PayPal and AI usage', weight: 10,
      status: /paypal/i.test(desc) && AI_WORDS.test(desc) ? 'pass' : (/paypal/i.test(desc) || /\b(ai|llm|agent)\b/i.test(desc)) ? 'warn' : 'fail',
      severity: 'medium',
      detail: 'The only hard requirement of the hackathon is meaningful use of both PayPal and AI.',
      fix: 'Add one sentence each: how PayPal is used, and what the AI does.',
    });
  } else if (techNames.length || rules.requireAi) {
    const techRe = anyOf(rules.requiredTech.flatMap((t) => t.keywords));
    const saysTech = techRe ? techRe.test(desc) : true;
    const saysAi = rules.requireAi ? AI_WORDS.test(desc) : true;
    const what = [...techNames, rules.requireAi ? 'AI' : null].filter(Boolean);
    a.add({
      id: 'mentions', title: `Description explains how ${what.join(' and ')} ${what.length > 1 ? 'are' : 'is'} used`, weight: 10,
      status: saysTech && saysAi ? 'pass' : saysTech || saysAi ? 'warn' : 'fail', severity: 'medium',
      detail: `This event requires ${what.join(' and ')}. The description should say how each is used.`,
      fix: `Add one sentence for each of: ${what.join(', ')}.`,
    });
  }

  const tools = (input.toolsUsed || '').trim();
  a.add({
    id: 'tools', title: 'Tools / models used are identified and explained', weight: 15,
    status: tools.length >= 40 ? 'pass' : tools.length > 0 ? 'warn' : 'fail', severity: 'high',
    detail: tools ? `${tools.length} characters describing tools.` : 'The rules require naming each model/AI service AND how it was used.',
    fix: 'List every tool with its role, e.g. "Gemini 2.5 Flash — powers the judge agents; AG Grid — findings table; Render — hosting".',
  });

  const host = (() => { try { return new URL(input.repoUrl).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  a.add({
    id: 'repo', title: 'Public code repository link (GitHub / GitLab / Bitbucket)', weight: 10,
    status: ['github.com', 'gitlab.com', 'bitbucket.org'].includes(host) ? 'pass' : 'fail', severity: 'critical',
    detail: host ? `Repository host: ${host}.` : 'No valid repository URL.',
    fix: 'Provide the full https URL of the public repository.',
  });

  const readmePath = repo.found ? repo.treePaths.find((p) => /^readme(\.md)?$/i.test(p)) : null;
  const readme = readmePath ? repo.files[readmePath] || '' : '';
  const runnable = /(npm (install|i|run|start)|pip install|docker|yarn|pnpm|python3? |go run|mvn )/i.test(readme);
  const demoOk = input.demoUrl && evidence.demo?.ok;
  a.add({
    id: 'functional', title: 'Judges can run it: hosted demo URL or full run instructions', weight: 20,
    status: !rules.requireDemoOrRunSteps ? 'na' : demoOk || runnable ? 'pass' : input.demoUrl ? 'warn' : 'fail', severity: 'high',
    detail: !rules.requireDemoOrRunSteps ? 'This event does not require a runnable demo.' : demoOk ? 'Hosted demo is live.' : runnable ? 'README contains run instructions.' : input.demoUrl ? 'Demo URL given but did not respond.' : 'Neither a demo URL nor README run instructions found. A mockup or non-functional demo does not count.',
    fix: 'Deploy to Render (free) and/or document `npm install` + `npm start` in the README.',
  });

  a.add({
    id: 'video', title: 'Demo video link (YouTube)', weight: 20,
    status: !rules.requireVideo ? 'na' : evidence.video?.valid ? 'pass' : 'fail', severity: 'high',
    detail: !rules.requireVideo ? 'This event does not require a demo video.' : evidence.video?.valid ? 'Valid YouTube link.' : input.videoUrl ? 'Not a recognisable YouTube URL.' : 'Missing. The demo video must be uploaded to YouTube and linked.',
    fix: 'Record a short walkthrough on the device the project was built for, upload to YouTube (Public) and paste the link.',
  });

  const headings = (readme.match(/^#{1,3} /gm) || []).length;
  a.add({
    id: 'docs', title: 'Documentation is sufficient for judges', weight: 15,
    status: !repo.found ? 'na' : readme.length >= 1200 && headings >= 3 ? 'pass' : readme.length >= 400 ? 'warn' : 'fail', severity: 'medium',
    detail: repo.found ? `README: ${readme.length} characters, ${headings} headings.` : 'Repository not available.',
    fix: 'Structure the README: Overview, Architecture, Features, Tech & AI tools, Setup, Demo, Limitations.',
  });

  return a.result();
}
