import { cfg } from './config.js';

export function llmEnabled() {
  return Boolean(cfg().llm.apiKey);
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

/**
 * Ask any OpenAI-compatible chat endpoint (Gemini, OpenAI, Groq, OpenRouter, Ollama...) for JSON.
 * Returns { ok:true, data } or { ok:false, error }. Never throws, so a flaky model can't crash an audit.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Free model tiers allow only a few calls per minute. Calls are spaced out so a whole competition does not trip the limit.
let nextSlot = 0;
async function throttle() {
  const { rpm } = cfg().llm;
  if (!rpm) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 60000 / rpm;
  if (at > now) await sleep(at - now);
}

export async function askJson(system, user, { maxTokens = 1200 } = {}) {
  const { llm } = cfg();
  if (!llm.apiKey) return { ok: false, error: 'LLM_API_KEY not set' };
  try {
    let res;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await throttle();
      res = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          temperature: 0.2,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(45000),
      });
      // "Too many requests": wait as the provider asks (or a few seconds) and try again, at most twice.
      if (res.status !== 429 || attempt === 3) break;
      const asked = Number(res.headers.get('retry-after'));
      await sleep(Math.min(30000, Number.isFinite(asked) && asked > 0 ? asked * 1000 : (cfg().llm.retryMs ?? 6000) * attempt));
    }
    if (!res.ok) return { ok: false, error: `LLM HTTP ${res.status}` };
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content || '';
    const data = extractJson(text);
    return data ? { ok: true, data } : { ok: false, error: 'LLM returned non-JSON output' };
  } catch (err) {
    return { ok: false, error: `LLM call failed: ${err.message}` };
  }
}
