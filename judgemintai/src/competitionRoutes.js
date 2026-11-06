import { json, readBody, HttpError } from './http.js';
import { requireOrganizer } from './auth.js';
import {
  mustGet, mustProject, createCompetition, updateCompetition, updateProject, removeProject, addProjects, startEvaluation, cancelEvaluation,
  judgeProject, setOrder, finalise, reopen, competitionView, allCompetitions, exportCsv,
} from './competition.js';
import { deleteCompetition } from './competitionStore.js';
import { payPrize, refreshPrize, payoutMode } from './payouts.js';

// All Judge mode routes. Every one of them needs the organiser key (X-Organizer-Key header): they expose entry emails,
// unreleased rankings and the pay buttons.

const BIG = 1_500_000; // a pasted CSV of 50 entries fits easily
const view = (comp) => {
  const m = payoutMode();
  return competitionView(comp, { ready: m.ready && m.allowed });
};

export async function handleCompetitionApi(req, res, url, ip) {
  const p = url.pathname;
  const method = req.method;
  requireOrganizer(req, ip);

  if (method === 'POST' && p === '/api/organizer/check') return json(res, 200, { ok: true });

  if (p === '/api/competitions') {
    if (method === 'GET') return json(res, 200, { competitions: allCompetitions() });
    if (method === 'POST') {
      const body = await readBody(req, BIG);
      const { comp, imported } = await createCompetition(body, String(body.judge || 'Organiser'));
      if (body.start && comp.projects.length) startEvaluation(comp, {}, String(body.judge || 'Organiser'));
      return json(res, 201, { competition: view(comp), imported });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  let m = p.match(/^\/api\/competitions\/([a-f0-9]{12})(?:\/(.*))?$/);
  if (!m) throw new HttpError(404, 'Unknown API route');
  const comp = mustGet(m[1]);
  const rest = m[2] || '';

  if (rest === '') {
    if (method === 'GET') return json(res, 200, { competition: view(comp) });
    if (method === 'PATCH') {
      const body = await readBody(req, BIG);
      updateCompetition(comp, body, String(body.judge || 'Organiser'));
      return json(res, 200, { competition: view(comp) });
    }
    if (method === 'DELETE') {
      if (comp.prizes.some((z) => z.status !== 'unpaid')) throw new HttpError(409, 'A prize payment has started, so this competition is kept as a record.');
      deleteCompetition(comp.id);
      return json(res, 200, { deleted: true });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (method === 'GET' && rest === 'export.csv') {
    const csv = exportCsv(comp);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="judgemint-${comp.id}.csv"`,
      'Cache-Control': 'no-store',
    });
    return res.end(csv);
  }

  if (method === 'POST' && rest === 'projects') {
    const body = await readBody(req, BIG);
    const imported = await addProjects(comp, body, String(body.judge || 'Organiser'));
    if (body.start && imported.added) startEvaluation(comp, {}, String(body.judge || 'Organiser'));
    return json(res, 200, { competition: view(comp), imported });
  }

  m = rest.match(/^projects\/([a-f0-9]{8})(?:\/(judge))?$/);
  if (m) {
    mustProject(comp, m[1]);
    if (!m[2] && method === 'PATCH') {
      const body = await readBody(req, 20_000);
      updateProject(comp, m[1], body, String(body.judge || 'Organiser'));
      return json(res, 200, { competition: view(comp) });
    }
    if (!m[2] && method === 'DELETE') {
      removeProject(comp, m[1], String(req.headers['x-judge-name'] || 'Organiser'));
      return json(res, 200, { competition: view(comp) });
    }
    if (m[2] && method === 'POST') {
      const body = await readBody(req, 20_000);
      judgeProject(comp, m[1], body);
      return json(res, 200, { competition: view(comp) });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (method === 'POST') {
    const body = await readBody(req, 20_000);
    if (rest === 'evaluate') {
      const n = startEvaluation(comp, { projectIds: body.projectIds, all: body.all === true }, String(body.judge || 'Organiser'));
      return json(res, 202, { started: n, competition: view(comp) });
    }
    if (rest === 'cancel') { cancelEvaluation(comp, String(body.judge || 'Organiser')); return json(res, 200, { competition: view(comp) }); }
    if (rest === 'order') { setOrder(comp, body); return json(res, 200, { competition: view(comp) }); }
    if (rest === 'finalise') { finalise(comp, body); return json(res, 200, { competition: view(comp) }); }
    if (rest === 'reopen') { reopen(comp, body); return json(res, 200, { competition: view(comp) }); }

    m = rest.match(/^prizes\/([a-z0-9]{3,12})\/(pay|refresh)$/);
    if (m) {
      if (!comp.prizes.some((z) => z.id === m[1])) throw new HttpError(404, 'Prize not found');
      const prize = m[2] === 'pay' ? await payPrize(comp, m[1], body) : await refreshPrize(comp, m[1], body);
      return json(res, 200, { prize, competition: view(comp) });
    }
  }

  throw new HttpError(404, 'Unknown API route');
}
