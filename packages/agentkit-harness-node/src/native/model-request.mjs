import { buildOpenAIRequest } from './model-openai-chat.mjs';
import { buildAnthropicRequest } from './model-anthropic.mjs';
import { buildResponsesRequest } from './model-responses.mjs';
import { ProtocolError } from './model-normalize.mjs';
import { projectRequestMedia } from './model-media.mjs';

/** One pure dispatch projection shared by request admission and actual HTTP. */
export function buildNativeModelRequest(binding, request) {
  if (!binding || typeof binding !== 'object') throw new ProtocolError('binding missing');
  const view = projectRequestMedia(request);
  if (binding.protocol === 'anthropic-messages') return buildAnthropicRequest(binding, view);
  if (binding.protocol === 'openai-chat') return buildOpenAIRequest(binding, view);
  if (binding.protocol === 'openai-responses') return buildResponsesRequest(binding, view);
  throw new ProtocolError('unsupported binding protocol');
}
