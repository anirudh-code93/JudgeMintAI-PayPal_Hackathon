import { el, api, fmtDate, safeHttpUrl, verdictInfo } from './util.js';
import { sealSVG, rosetteSVG } from './seal.js';

// PayPal checkout. The browser only shows PayPal's buttons; the order is created and captured by OUR server
// (POST /api/audits/:id/pay/create and /capture) so the amount can never be changed from the page.

let sdkPromise = null;

function loadPayPalSdk({ clientId, currency }) {
  if (window.paypal?.Buttons) return Promise.resolve(window.paypal);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture&components=buttons`;
      s.async = true;
      s.onload = () => (window.paypal?.Buttons ? resolve(window.paypal) : reject(new Error('PayPal loaded but its buttons are unavailable.')));
      s.onerror = () => {
        sdkPromise = null;
        reject(new Error('PayPal’s checkout script did not load. Check your connection and reload the page.'));
      };
      document.head.append(s);
    });
  }
  return sdkPromise;
}

export async function mountCheckout(host, { audit, config, onIssued }) {
  const buttons = el('div', { class: 'pay__buttons' });
  const status = el('p', { class: 'pay__status', role: 'status' });
  host.replaceChildren(buttons, status);

  const say = (text, isError = false) => {
    status.textContent = text;
    status.classList.toggle('is-error', isError);
  };

  try {
    const paypal = await loadPayPalSdk({ clientId: config.paypal.clientId, currency: config.paypal.currency });
    await paypal
      .Buttons({
        style: { layout: 'vertical', shape: 'rect', label: 'pay', height: 44, tagline: false },
        createOrder: async () => {
          say('');
          const order = await api(`/api/audits/${audit.id}/pay/create`, { method: 'POST' });
          return order.orderId;
        },
        onApprove: async (data) => {
          say('Confirming your payment with PayPal…');
          const result = await api(`/api/audits/${audit.id}/pay/capture`, { method: 'POST', body: { orderId: data.orderID } });
          say('');
          onIssued(result.certificate, result.via);
        },
        onCancel: () => say('Payment cancelled. Nothing was charged.'),
        onError: (err) => say(err?.message || 'PayPal could not complete the payment. Try again.', true),
      })
      .render(buttons);
  } catch (err) {
    say(err.message, true);
  }
}

function fact(label, value) {
  return [el('dt', {}, label), el('dd', {}, value)];
}

// Which route moved the money: PayPal's AI Toolkit (its MCP server) or the Orders API called directly.
function routeLabel(via) {
  const toolkit = [via?.create, via?.capture].filter((v) => v === 'toolkit').length;
  if (toolkit === 2) return 'PayPal AI Toolkit (MCP server)';
  if (toolkit === 1) return 'PayPal AI Toolkit and the Orders API';
  return via?.create || via?.capture ? 'PayPal Orders API' : '';
}

export function certificateEl(cert, projectName, via) {
  const info = verdictInfo(cert.verdict);
  const repo = safeHttpUrl(cert.repo);
  const verifyUrl = `${location.origin}/verify/${cert.serial}`;
  const route = routeLabel(via);

  return el('article', { class: 'cert', id: 'certificate', 'aria-label': `Audit certificate ${cert.serial}` },
    rosetteSVG({ size: 600, stroke: '#BFDCCB', className: 'cert__rosette' }),
    el('div', { class: 'cert__inner' },
      el('h2', { class: 'cert__title' }, 'Certificate of audit'),
      el('p', { class: 'cert__lead' }, 'JudgeMintAI audited the project'),
      el('p', { class: 'cert__project' }, projectName || 'Untitled project'),
      el('p', { class: 'cert__repo' }, repo ? el('a', { href: repo, target: '_blank', rel: 'noopener noreferrer' }, cert.repo) : cert.repo),
      el('div', { class: 'cert__result' },
        sealSVG({ score: cert.score, verdictKey: info.key, word: info.word, size: 150 }),
        el('p', { class: 'cert__verdict' }, `${info.label}, scoring ${cert.score} out of 100`)),
      el('dl', { class: 'cert__facts' },
        fact('Issued', fmtDate(cert.issuedAt)),
        fact('Serial', cert.serial),
        fact('PayPal order (sandbox)', cert.paypalOrderId),
        route ? fact('Paid through', route) : null,
        fact('Signature', `${cert.signature.slice(0, 24)}…`),
        fact('Verify at', verifyUrl)),
      el('p', { class: 'cert__note' }, 'Paid in PayPal’s sandbox, so no real money moved. This certificate records an automated audit. It does not mean PayPal or any hackathon organiser endorses the project.')));
}
