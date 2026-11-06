import { makeAgent, sourceEntries, grep, fmtHit, isTest } from './util.js';

export const AI_PROVIDERS = {
  'OpenAI': /\bopenai\b|api\.openai\.com/i,
  'Anthropic / Claude': /@anthropic-ai\/sdk|\banthropic\b|api\.anthropic\.com/i,
  'Google Gemini': /@google\/generative-ai|@google\/genai|google-generativeai|google\.genai|generativelanguage\.googleapis\.com|gemini-\d/i,
  'Groq': /groq-sdk|api\.groq\.com/i,
  'Mistral': /@mistralai|api\.mistral\.ai/i,
  'Cohere': /cohere-ai|api\.cohere/i,
  'Hugging Face': /@huggingface\/inference|huggingface_hub|api-inference\.huggingface\.co/i,
  'Ollama / local LLM': /\bollama\b|localhost:11434/i,
  'OpenRouter': /openrouter\.ai/i,
  'Together AI': /together-ai|api\.together\.xyz/i,
  'Vercel AI SDK': /from\s+['"]ai['"]|require\(['"]ai['"]\)|@ai-sdk\//i,
  'LangChain / LangGraph': /langchain|langgraph/i,
  'LlamaIndex': /llama[-_]?index/i,
  'CrewAI / AutoGen': /crewai|autogen/i,
  'OpenAI Agents SDK': /@openai\/agents|openai-agents/i,
  'MCP (Model Context Protocol)': /@modelcontextprotocol\/sdk|@paypal\/mcp/i,
  'OpenAI-compatible endpoint': /chat\/completions/i,
};

const AI_CALL = /chat\.completions\.create|completions\.create|responses\.create|messages\.create|generateContent|generate_content|generateText|streamText|generateObject|chat\/completions|\/v1\/messages|\/v1\/responses|ChatOpenAI|ChatAnthropic|ollama\.(chat|generate)|askJson|callLLM|callModel|\.invoke\(/i;
const PROMPT = /role\s*[:=]\s*['"](system|developer)['"]|systemInstruction|system_prompt|SYSTEM_PROMPT|['"`]You are (a|an|the) [A-Za-z]|\bsystem\s*[:,]\s*[`'"]/i;
const TOOL_CALLING = /tool_calls?|tools\s*:\s*\[|function_call|functionDeclarations|tool_choice|bindTools|@tool\b|StructuredTool|inputSchema/i;
const AGENT_LOOP = /maxSteps|max_steps|maxTurns|AgentExecutor|createReactAgent|Runner\.run|Promise\.allSettled|for\s*\([^)]*(step|turn|iteration)|while\s*\([^)]*(tool|agent)/i;
const RESILIENCE = /fallback|heuristic|AbortSignal\.timeout|timeout\s*[:=]|signal\s*:|retry|retries|try\s*\{[\s\S]{0,400}catch/i;

// Maps free-text tool names from the submission to detection keys
const CLAIM_MAP = [
  [/openai|gpt|chatgpt/i, 'OpenAI'],
  [/claude|anthropic/i, 'Anthropic / Claude'],
  [/gemini|google ai|vertex/i, 'Google Gemini'],
  [/groq/i, 'Groq'],
  [/mistral/i, 'Mistral'],
  [/ollama|llama/i, 'Ollama / local LLM'],
  [/langchain|langgraph/i, 'LangChain / LangGraph'],
  [/vercel ai|ai sdk/i, 'Vercel AI SDK'],
  [/\bmcp\b|model context protocol/i, 'MCP (Model Context Protocol)'],
];

export async function runAiAgent(ctx) {
  const a = makeAgent('ai', 'AI Usage Agent', 'Is AI genuinely powering the product, or just name-dropped?');
  const { repo, input } = ctx;

  if (!repo.found) {
    a.add({ id: 'source', title: 'Source code available to inspect', weight: 100, status: 'fail', severity: 'critical', detail: repo.reason, fix: 'Make the repository public so AI usage can be verified.' });
    return a.result();
  }

  const src = sourceEntries(repo);
  const prod = src.filter(([p]) => !isTest(p));

  const detected = {};
  for (const [name, re] of Object.entries(AI_PROVIDERS)) {
    const hits = grep(src, re, { limit: 1 });
    if (hits.length) detected[name] = hits[0];
  }
  // "OpenAI-compatible endpoint" alone is weak evidence of a *named* provider; keep it, but list real names first.
  const names = Object.keys(detected);
  a.add({
    id: 'provider', title: 'An AI model, API or framework is integrated', weight: 25,
    status: names.length ? 'pass' : 'fail', severity: 'critical',
    detail: names.length ? `Detected: ${names.join(', ')}.` : 'No AI provider SDK, API endpoint or framework was found in the code.',
    fix: 'Integrate an LLM/ML model (any provider; free tiers such as Gemini or Groq are fine) into the app logic.',
    evidence: Object.values(detected).slice(0, 3).map(fmtHit),
  });

  const callHits = grep(prod, AI_CALL, { limit: 5 });
  a.add({
    id: 'calls', title: 'Model is actually called at runtime', weight: 25,
    status: callHits.length ? 'pass' : names.length ? 'fail' : 'na', severity: 'high',
    detail: callHits.length ? `${callHits.length}+ call site(s) found.` : 'An AI library is referenced but no request to a model was found.',
    fix: 'Make sure the shipped application path really sends prompts to a model and uses the response.',
    evidence: callHits.slice(0, 3).map(fmtHit),
  });

  const promptHits = grep(prod, PROMPT, { limit: 3 });
  a.add({
    id: 'prompts', title: 'Purposeful prompts / instructions are defined', weight: 10,
    status: promptHits.length ? 'pass' : names.length ? 'warn' : 'na', severity: 'medium',
    detail: promptHits.length ? 'System prompts / instructions found in code.' : 'No system prompt or structured instructions detected.',
    fix: 'Keep prompts in code (or a prompts file) so judges can see what the AI is asked to do.',
    evidence: promptHits.map(fmtHit),
  });

  const coreFiles = prod.filter(([, t]) => AI_CALL.test(t)).map(([p]) => p);
  a.add({
    id: 'core', title: 'AI is core to the product, not a side script', weight: 15,
    status: coreFiles.length >= 2 ? 'pass' : coreFiles.length === 1 ? 'warn' : names.length ? 'fail' : 'na', severity: 'high',
    detail: `${coreFiles.length} production file(s) call a model${coreFiles.length ? `: ${coreFiles.slice(0, 3).join(', ')}` : ''}.`,
    fix: 'Move AI into the main request path so removing it would break the product\'s value.',
  });

  const tool = grep(prod, TOOL_CALLING, { limit: 1 });
  const loop = grep(prod, AGENT_LOOP, { limit: 1 });
  const agentFiles = prod.map(([p]) => p).filter((p) => /agent/i.test(p));
  const agentic = tool.length + loop.length + (agentFiles.length >= 2 ? 1 : 0);
  a.add({
    id: 'agentic', title: 'Agentic design (tools, multiple agents or orchestration)', weight: 10,
    status: agentic ? 'pass' : names.length ? 'warn' : 'na', severity: 'low',
    detail: agentic
      ? `Signals: ${[tool.length && 'tool/function calling', loop.length && 'orchestration loop / parallel agents', agentFiles.length >= 2 && `${agentFiles.length} agent modules`].filter(Boolean).join(', ')}.`
      : 'Single-prompt usage. Agentic designs tend to score higher with judges.',
    fix: 'Consider splitting work across specialised agents or letting the model call tools.',
    evidence: [...tool, ...loop].map(fmtHit),
  });

  const resilient = grep(prod.filter(([p]) => coreFiles.includes(p)), RESILIENCE, { limit: 1 });
  a.add({
    id: 'resilience', title: 'Handles model failure (timeouts, fallbacks, validation)', weight: 5,
    status: !coreFiles.length ? 'na' : resilient.length ? 'pass' : 'warn', severity: 'low',
    detail: resilient.length ? 'Timeouts / fallback / error handling found around model calls.' : 'No timeout or fallback around model calls — a flaky model would break the demo.',
    fix: 'Wrap model calls in try/catch with a timeout and a deterministic fallback.',
    evidence: resilient.map(fmtHit),
  });

  // Declared vs detected
  const declared = (input.toolsUsed || '');
  const claims = CLAIM_MAP.filter(([re]) => re.test(declared)).map(([, key]) => key);
  if (claims.length) {
    const missing = claims.filter((k) => !detected[k]);
    a.add({
      id: 'declared', title: 'Declared AI tools match the code', weight: 10,
      status: missing.length === 0 ? 'pass' : missing.length < claims.length ? 'warn' : 'fail', severity: 'low',
      detail: missing.length
        ? `Declared but not found in code: ${missing.join(', ')}. (Fine if used only as a development assistant — say so in the submission.)`
        : 'Every declared runtime AI tool was found in the code.',
      fix: 'Separate "AI used to build the project" from "AI used inside the product" in your tools list.',
    });
  } else {
    a.add({ id: 'declared', title: 'Declared AI tools match the code', weight: 10, status: 'na', detail: 'No recognisable AI tool names in the declared tools list.' });
  }

  return a.result({ providers: names });
}
