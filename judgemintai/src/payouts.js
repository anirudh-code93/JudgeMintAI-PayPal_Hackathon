import { cfg } from './config.js';
import { HttpError } from './http.js';
import { paypalConfigured, paypalCall } from './paypal.js';
import { isEmail } from './intake.js';
import { saveCompetition } from './competitionStore.js';
import { log } from './competition.js';
import { computeRanking } from './ranking.js';
import { notifyZapier } from './integrations.js';

// Prize payments use the PayPal PAYOUTS API (POST /v1/payments/payouts). The PayPal AI Toolkit has no payout tool
// (its tools cover orders, invoices, subscriptions, refunds, disputes and reports), so payouts call PayPal directly.
// Sandbox by default: nothing here can move real money unless ALLOW_LIVE_PAYOUTS=true AND live keys are configured.
//
// Safety, in the order it applies:
//   1. only after the judges finalised the ranking, and only for an entry that is ranked and has a valid PayPal email
//   2. the request must repeat exactly what the organiser confirmed on screen (amount, currency, email, entry)
//   3. the prize is marked "sending" BEFORE PayPal is called, so a crash can never leave an unknown payment looking unpaid
//   4. every attempt uses a fixed sender_batch_id; PayPal refuses a second batch with the same id for 30 days, so a double click,
//      a retry or a restart can never pay twice. A new id is only used after PayPal has clearly said no.

const isLive = () => /^https?:\/\/(api-m|api)\.paypal\.com/i.test(cfg().paypal.apiBase);
export const payoutMode = () => ({ ready: paypalConfigured(), live: isLive(), allowed: !isLive() || cfg().competitions.allowLivePayouts });

const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][(n % 100 >> 3) ^ 1 && n % 10] || 'th'}`;
const batchIdOf = (comp, z) => `jm-${comp.id}-${z.id}-a${z.attempt}`;
const clip = (v, n) => String(v ?? '').slice(0, n);

const FAILED_ITEM = new Set(['FAILED', 'BLOCKED', 'RETURNED', 'REFUNDED', 'REVERSED', 'DENIED']);

function paypalWords(err) {
  const d = err.paypal || {};
  const detail = d.details?.[0];
  return clip([d.name, d.message, detail?.issue || detail?.description].filter(Boolean).join(' - ') || err.message, 300);
}

/** The id of an existing payout, taken from the links PayPal puts in a "duplicate" error. */
function idFromLinks(err) {
  for (const l of err.paypal?.links || []) {
    const m = String(l.href || '').match(/\/v1\/payments\/payouts\/([A-Za-z0-9-]{6,40})/);
    if (m) return m[1];
  }
  return '';
}

/** Move the prize's state forward from what PayPal reports about its batch. */
function applyBatch(comp, z, data, by) {
  const header = data.batch_header || {};
  const item = (data.items || [])[0];
  z.batchStatus = header.batch_status || z.batchStatus;
  z.itemStatus = item?.transaction_status || z.itemStatus || '';
  const was = z.status;
  if (['DENIED', 'CANCELED'].includes(z.batchStatus) || FAILED_ITEM.has(z.itemStatus)) {
    z.status = 'failed';
    z.error = clip(item?.errors?.message || item?.errors?.name || `PayPal reports the payout as ${z.itemStatus || z.batchStatus}.`, 300);
    z.attempt += 1; // PayPal clearly refused it, so the next try uses a fresh reference
  } else if (z.itemStatus === 'SUCCESS') {
    z.status = 'paid';
    z.paidAt = z.paidAt || new Date().toISOString();
    z.error = '';
  } else if (z.itemStatus === 'UNCLAIMED') {
    z.status = 'unclaimed';
    z.error = 'Sent, but the email has no PayPal account yet. PayPal holds the money until the winner signs up with that email (it returns after 30 days).';
  } else {
    z.status = 'sent';
    z.error = z.itemStatus === 'ONHOLD' ? 'PayPal has put this payment on hold.' : '';
  }
  if (z.status !== was) {
    log(comp, by, 'payout', `${z.label}: ${z.status}${z.error ? ` (${z.error})` : ''}.`);
    if (z.status === 'paid') {
      const p = comp.projects.find((x) => x.id === z.projectId);
      notifyZapier('prize.paid', { competitionId: comp.id, name: comp.name, prize: z.label, amount: z.amount, currency: z.currency, project: p?.name, batchId: z.batchId }).catch(() => {});
    }
  }
}

export async function payPrize(comp, prizeId, body = {}) {
  const by = clip(body.judge, 60) || 'Organiser';
  if (!comp.finalisedAt) throw new HttpError(409, 'Finalise the judgement before paying prizes.');
  const z = comp.prizes.find((x) => x.id === prizeId);
  if (!z) throw new HttpError(404, 'Prize not found');
  const mode = payoutMode();
  if (!mode.ready) throw new HttpError(503, 'PayPal sandbox keys are not set on the server (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET).');
  if (!mode.allowed) throw new HttpError(403, 'The server points at LIVE PayPal. Real-money payouts are off unless ALLOW_LIVE_PAYOUTS=true is set on purpose.');
  if (!['unpaid', 'failed', 'unknown'].includes(z.status)) throw new HttpError(409, z.status === 'paid' ? 'This prize is already paid.' : 'A payment for this prize is already under way. Use "Check with PayPal" to see where it stands.');

  const p = comp.projects.find((x) => x.id === z.projectId);
  if (!p) throw new HttpError(409, 'No entry holds this place.');
  const row = computeRanking(comp).rows.find((r) => r.id === p.id);
  if (!row?.eligible) throw new HttpError(409, 'This entry is not ranked, so it cannot receive a prize.');
  if (!isEmail(p.payoutEmail)) throw new HttpError(409, 'Add a valid PayPal email for this entry first.');

  const exp = body.expected || {};
  if (body.confirm !== true || String(exp.amount) !== z.amount || String(exp.currency) !== z.currency
    || String(exp.email || '').toLowerCase() !== p.payoutEmail.toLowerCase() || exp.projectId !== p.id) {
    throw new HttpError(409, 'The confirmation does not match this prize any more. Reload the page and check the amount and email again.');
  }

  const senderBatchId = batchIdOf(comp, z);
  z.status = 'sending';
  z.error = '';
  z.startedAt = new Date().toISOString();
  log(comp, by, 'payout', `Sending ${z.label} (${z.amount} ${z.currency}) to the winner of "${p.name}".`, p.id);
  saveCompetition(comp);

  const payload = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      recipient_type: 'EMAIL',
      email_subject: clip(`You won ${z.label} in ${comp.name}`, 250),
      email_message: clip(`Congratulations! "${p.name}" placed ${ordinal(z.assignedRank || row.rank)} in ${comp.name}. This prize is sent through PayPal.`, 900),
    },
    items: [{
      recipient_type: 'EMAIL', receiver: p.payoutEmail, amount: { value: z.amount, currency: z.currency },
      note: clip(`${z.label}: ${p.name}`, 200), sender_item_id: clip(`${z.id}-a${z.attempt}`, 60),
    }],
  };

  try {
    const data = await paypalCall('POST', '/v1/payments/payouts', payload, `jm-pay-${comp.id}-${z.id}-a${z.attempt}`);
    z.batchId = data.batch_header?.payout_batch_id || '';
    z.status = 'sent';
    applyBatch(comp, z, data, by);
  } catch (err) {
    const raw = JSON.stringify(err.paypal || {});
    const duplicate = err.status && err.status < 500 && /duplicate|already (exist|been)|BATCH_ALREADY|sender_batch_id/i.test(raw);
    if (duplicate) {
      // PayPal already has this exact payout: find it and show its real state instead of paying again
      const id = idFromLinks(err);
      if (id) {
        z.batchId = id;
        z.status = 'sent';
        await refreshPrize(comp, z.id, { judge: by }, true).catch(() => {});
      } else {
        z.status = 'unknown';
        z.error = 'PayPal says a payout with this reference already exists but did not give its id. Check the sandbox account activity before paying again.';
      }
    } else if (!err.status || err.status >= 500) {
      z.status = 'unknown';
      z.error = 'PayPal did not answer in time. It is safe to try again: PayPal ignores a repeated request with the same reference.';
    } else {
      z.status = 'failed';
      z.error = `PayPal said no: ${paypalWords(err)}`;
      z.attempt += 1;
    }
    log(comp, by, 'payout', `${z.label}: ${z.status}${z.error ? ` (${z.error})` : ''}.`, p.id);
  }
  saveCompetition(comp);
  return z;
}

/** Ask PayPal where a sent payout stands (it moves from PENDING to SUCCESS a little later). */
export async function refreshPrize(comp, prizeId, body = {}, quiet = false) {
  const by = clip(body.judge, 60) || 'Organiser';
  const z = comp.prizes.find((x) => x.id === prizeId);
  if (!z) throw new HttpError(404, 'Prize not found');
  if (!z.batchId) throw new HttpError(409, 'No payment has been sent for this prize yet.');
  if (!/^[A-Za-z0-9-]{6,40}$/.test(z.batchId)) throw new HttpError(409, 'The stored payout id looks wrong.');
  if (!paypalConfigured()) throw new HttpError(503, 'PayPal sandbox keys are not set on the server.');
  try {
    const data = await paypalCall('GET', `/v1/payments/payouts/${z.batchId}`);
    applyBatch(comp, z, data, by);
  } catch (err) {
    if (!quiet) throw new HttpError(502, `PayPal could not be asked: ${paypalWords(err)}`);
  }
  saveCompetition(comp);
  return z;
}
