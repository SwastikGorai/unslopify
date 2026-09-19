import { performance } from 'node:perf_hooks';
import { validateJevResponse, RUBRIC_VERSION, buildQuestions } from '../src/shared/contracts.js';

const transport = process.env.JEV_TRANSPORT || 'gateway';
const deterministic = transport === 'deterministic';
const key = transport === 'direct' ? process.env.TYPESAFE_API_KEY : process.env.AI_GATEWAY_API_KEY;
const endpoint = transport === 'direct'
  ? 'https://api.typesafe.ai/v1/systemone'
  : 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
const model = transport === 'direct' ? 'jev-latest' : 'typesafe-ai/jev';

if (deterministic) {
  const started = performance.now();
  const body = {
    model: 'deterministic-test-only',
    answers: {
      engagement_bait: {
        type: 'choice',
        choice: 'present',
        probabilities: { present: 0.96, absent: 0.02, uncertain: 0.02 },
        confidence: 0.92
      }
    }
  };
  const validated = validateJevResponse(body, ['engagement_bait']);
  if (!validated.ok) throw new Error(`Invalid deterministic test answer: ${validated.error}`);
  console.log(JSON.stringify({
    transport: 'deterministic-test-only',
    model: body.model,
    rubricVersion: RUBRIC_VERSION,
    latencyMs: Math.round(performance.now() - started),
    network: false,
    answerShape: Object.fromEntries(Object.entries(validated.answers).map(([id, answer]) => [id, {
      choice: answer.choice,
      probabilityKeys: Object.keys(answer.probabilities),
      hasConfidence: typeof answer.confidence === 'number'
    }]))
  }));
  process.exit(0);
}

if (!key) {
  console.log(`not run: provide ${transport === 'direct' ? 'TYPESAFE_API_KEY' : 'AI_GATEWAY_API_KEY'} explicitly`);
  process.exit(0);
}

const state = JSON.stringify({
  site: 'linkedin',
  post_text: 'Comment GROWTH and I will DM you the secret framework.',
  truncated: false
});
const payload = { model, state, questions: buildQuestions(['engagement_bait']) };
const started = performance.now();
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify(payload),
  credentials: 'omit',
  redirect: 'error',
  signal: AbortSignal.timeout(10_000)
});
const body = await response.json().catch(() => null);
if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
const validated = validateJevResponse(body, ['engagement_bait']);
if (!validated.ok) throw new Error(`Invalid Jev response: ${validated.error}`);

console.log(JSON.stringify({
  transport,
  model,
  rubricVersion: RUBRIC_VERSION,
  latencyMs: Math.round(performance.now() - started),
  answerShape: Object.fromEntries(Object.entries(validated.answers).map(([id, answer]) => [id, {
    choice: answer.choice,
    probabilityKeys: Object.keys(answer.probabilities),
    hasConfidence: typeof answer.confidence === 'number'
  }]))
}));
