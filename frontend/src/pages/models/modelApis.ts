/**
 * The OpenAI API MaaS calls on a model, which the backend keeps in annotation `ai-grid/api` and
 * turns into the ExternalModel's path. Chat completions need a chat template in the model's
 * tokenizer; base models such as facebook/opt-125m have none and answer only completions. The
 * backend treats a model without the annotation as chat.
 */
export const MODEL_API_ANNOTATION = 'ai-grid/api';

export type ModelApi = {
  id: 'chat' | 'completions';
  label: string;
  description: string;
};

export const modelApis: readonly ModelApi[] = [
  {
    id: 'chat',
    label: 'Chat completions',
    description: 'Tenants call /v1/chat/completions. For instruction-tuned models with a chat template.',
  },
  {
    id: 'completions',
    label: 'Completions',
    description: 'Tenants call /v1/completions. For base models without a chat template, such as facebook/opt-125m.',
  },
];

/** The API a model's annotations record, chat when they record none. */
export const modelApiOf = (annotations: Record<string, string> | undefined): ModelApi =>
  modelApis.find((api) => api.id === annotations?.[MODEL_API_ANNOTATION]) ?? modelApis[0];
