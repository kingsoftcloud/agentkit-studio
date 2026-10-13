/** AgentKit runtime facade over DSH services; DSH owns all session state. */
import { assertDshHarnessContext, runtimeContract } from './contract.mjs';

export class AgentKitHarnessService {
  constructor(ctx, { defaultAgentOptions = {}, defaultMeta = {} } = {}) {
    this.ctx = assertDshHarnessContext(ctx);
    this.defaultAgentOptions = Object.freeze({ ...defaultAgentOptions });
    this.defaultMeta = Object.freeze({ ...defaultMeta });
  }
  get contract() { return runtimeContract(); }

  /** DSH scopes the returned handle to the plugin context that creates it. */
  create(options = {}) {
    return this.ctx.agents.create({
      ...options,
      agentOptions: { ...this.defaultAgentOptions, ...options.agentOptions },
      meta: { ...this.defaultMeta, ...options.meta },
    });
  }

  /** DSH restores, repairs and leases the persisted log. */
  resume(options = {}) {
    return this.ctx.agents.resume({
      ...options,
      agentOptions: { ...this.defaultAgentOptions, ...options.agentOptions },
    });
  }

  get(sessionId) { return this.ctx.agents.get(sessionId); }
  list() { return this.ctx.agents.list(); }
  followup(sessionId, message) { return this.requireAgent(sessionId).followup(message); }
  cancel(sessionId, cause = { kind: 'user' }, options) { return this.requireAgent(sessionId).cancel(cause, options); }
  whenIdle(sessionId) { return this.requireAgent(sessionId).whenIdle(); }

  /** Observe the whole agent, including every tool step and queued followup.
   * Frames retain DSH's attempt identity; an end frame ends one attempt,
   * never a Harness run. The caller owns its observation subscription.
   */
  observe(sessionId, { onEvent, onAssistantStream } = {}) {
    const agent = this.requireAgent(sessionId);
    const disposers = [];
    if (onEvent) disposers.push(this.ctx.on('session/event', (session, event) => {
      if (session === agent.session) onEvent(event);
    }));
    if (onAssistantStream) disposers.push(this.ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject === agent) onAssistantStream(frame);
    }));
    return () => { for (const dispose of disposers.splice(0)) dispose?.(); };
  }

  requireAgent(sessionId) {
    const agent = this.get(sessionId);
    if (!agent) throw Object.assign(new Error(`DSH agent ${sessionId} is not live`), { code: 'SESSION_NOT_LIVE' });
    return agent;
  }
}

export const AgentKitHarness = AgentKitHarnessService;
