import { createGateway } from '@ai-sdk/gateway';
import { experimental_evaluate as evaluate } from 'ai';

export async function evaluateWithGateway({ apiKey, model, state, questions, signal }) {
  const gateway = createGateway({ apiKey });
  const result = await evaluate({
    model: gateway.evaluationModel(model),
    state,
    questions,
    abortSignal: signal,
    maxRetries: 0
  });
  return gatewayResult(result, model);
}

export function gatewayResult(result, model) {
  return {
    model: result.response.modelId || model,
    answers: Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, {
      ...answer,
      confidence: answer.type === 'choice' ? Math.max(...Object.values(answer.probabilities || {})) : undefined
    }])),
    usage: result.usage
  };
}

export function gatewayErrorStatus(error) {
  return error?.statusCode ?? error?.lastError?.statusCode;
}
