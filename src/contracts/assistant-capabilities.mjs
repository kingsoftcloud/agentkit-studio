/** Explicit image-catalog vocabulary; unknown capabilities require a client update. */
import { ASSISTANT_ATTACHMENT_CAPABILITIES } from './assistant-attachments.mjs';
import { ASSISTANT_NATIVE_CAPABILITY } from './assistant-native.mjs';
export const ASSISTANT_MANAGED_PERMISSION_CAPABILITY = 'personal-assistant-workspace-managed/v1';
export const ASSISTANT_IMAGE_CAPABILITIES = Object.freeze([
  'personal-assistant/v1', 'personal-assistant-identity/v1', 'personal-assistant-delete/v1',
  'personal-assistant-cancel-turn/v1', 'personal-assistant-images/v1', 'personal-assistant-approval-bridge/v1',
  ...Object.values(ASSISTANT_ATTACHMENT_CAPABILITIES), ASSISTANT_NATIVE_CAPABILITY, ASSISTANT_MANAGED_PERMISSION_CAPABILITY,
]);
