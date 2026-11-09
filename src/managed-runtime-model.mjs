/**
 * The one model a ManagedRuntime Agent is declared with.
 *
 * The platform persists an Agent's model twice: the `model:` line of the inline
 * manifest it is created with, and `Agent.model_config["name"]`, which the
 * platform materializes from the create request's `ModelConfig.Model`. When the
 * request omits `ModelConfig`, that second copy comes from the platform's own
 * `MANAGED_RUNTIME_DEFAULT_MODEL` instead, and the lifecycle then refuses to
 * start the runtime because the two disagree:
 *
 *   `DSH model configuration must match the declared model`
 *   (agentengine-server `app/services/dsh_runtime_host.py`,
 *    `build_dsh_host_configuration`)
 *
 * A caller therefore cannot rely on the platform default: it has to name the
 * model it wants in both places. Everything here is derived from the single
 * value returned by `managedRuntimeModelConfig`, so the two copies cannot
 * drift apart. `deepseek-v4.1-flash` and `deepseek-v4.1-flash-1017` are two
 * different models and stay distinct — this module never maps one onto the
 * other.
 */

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,100}$/u;

/** Studio's default cloud model for a managed runtime. The desktop model route
 * keeps its own default (`client/dsh/model-bridge.mjs`): that one is a per-user
 * local setting, this one is what the account's cloud Agent runs on. */
export const DEFAULT_CLOUD_MODEL = 'deepseek-v4.1-flash-1017';

/**
 * The `ModelConfig` fragment that has to accompany a managed-runtime create.
 * `Mode: 'aicp'` keeps the platform-provisioned key behaviour the create
 * already relied on when it sent no `ModelConfig` at all: the caller states the
 * model, the platform owns the credential.
 */
export function managedRuntimeModelConfig(model = DEFAULT_CLOUD_MODEL) {
  const name = String(model ?? '').trim();
  if (!MODEL_NAME.test(name)) {
    throw Object.assign(new Error('托管运行时的模型名称无效'), { code: 'MANAGED_RUNTIME_MODEL_INVALID' });
  }
  return { Model: name, Mode: 'aicp' };
}
