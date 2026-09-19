import { readFile } from 'node:fs/promises';

const examples = JSON.parse(await readFile(new URL('./examples.json', import.meta.url), 'utf8'));
const predictionPath = process.env.EVAL_PREDICTIONS;
if (!predictionPath) {
  console.log(JSON.stringify({ examples: examples.length, development: examples.filter(example => example.split === 'development').length, heldout: examples.filter(example => example.split === 'heldout').length, status: 'not run: set EVAL_PREDICTIONS to a redacted prediction file' }));
  process.exit(0);
}

const predictions = JSON.parse(await readFile(predictionPath, 'utf8'));
const gate = prediction => prediction?.choice === 'present' && prediction.probability >= 0.9 && prediction.confidence >= 0.7;
const report = {};
for (const split of ['development', 'heldout']) {
  const rows = examples.filter(example => example.split === split);
  const counts = { tp: 0, fp: 0, fn: 0, tn: 0, abstain: 0, predicted: 0 };
  let latency = 0;
  let latencyCount = 0;
  let inputTokens = 0;
  for (const row of rows) {
    const prediction = predictions[row.id];
    if (!prediction || prediction.choice === 'uncertain') counts.abstain += 1;
    if (prediction?.latencyMs != null) { latency += prediction.latencyMs; latencyCount += 1; }
    if (prediction?.inputTokens != null) inputTokens += prediction.inputTokens;
    const predictedFilter = gate(prediction);
    if (predictedFilter) counts.predicted += 1;
    if (predictedFilter && row.desired === 'filter') counts.tp += 1;
    else if (predictedFilter) counts.fp += 1;
    else if (row.desired === 'filter') counts.fn += 1;
    else counts.tn += 1;
  }
  report[split] = {
    ...counts,
    precision: counts.tp + counts.fp ? counts.tp / (counts.tp + counts.fp) : null,
    recall: counts.tp + counts.fn ? counts.tp / (counts.tp + counts.fn) : null,
    falsePositiveRate: counts.fp + counts.tn ? counts.fp / (counts.fp + counts.tn) : null,
    meanLatencyMs: latencyCount ? latency / latencyCount : null,
    inputTokens,
    qualityGate: split === 'heldout' && counts.predicted >= 20 && counts.tp / Math.max(1, counts.tp + counts.fp) >= 0.95 && counts.fp / Math.max(1, counts.fp + counts.tn) <= 0.05
  };
}
console.log(JSON.stringify({ rubric: 'quality-v1', examples: examples.length, report }, null, 2));
