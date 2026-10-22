import { createStudioApp } from './app.mjs';
import { mountStudio } from './dsh/mount.mjs';

window.__ModuleLoader__.load({
  id: '@kingsoftcloud/agentkit-studio',
  factory: require => {
    const runtime = { React: require('react'), primitives: require('@deepseek-ai/dsh-client-ui-primitives'), ConversationNodeAssembler: require('@deepseek-ai/dsh-client-ui-conversation').ConversationNodeAssembler, nativeModules: () => ({
      React: require('react'), Context: require('@deepseek-ai/cordis').Context, Service: require('@deepseek-ai/cordis').Service, createSnapshotStore: require('@deepseek-ai/dsh-client-store').createSnapshotStore,
      connection: require('@deepseek-ai/dsh-client-connection'), typert: require('@deepseek-ai/dsh-typert-registry'), gateway: require('@deepseek-ai/dsh-api-gateway'),
      remotes: require('@deepseek-ai/dsh-api-remotes'), renderer: require('@deepseek-ai/dsh-client-ui-renderer'), sessions: require('@deepseek-ai/dsh-api-session-controller'),
      uiSession: require('@deepseek-ai/dsh-client-ui-session'), settings: require('@deepseek-ai/dsh-client-ui-settings'), locale: require('@deepseek-ai/dsh-client-locale'),
      // The cloud graph mounts the root-scoped schedule.manager factory and
      // renders schedule surfaces from this package. Its boot row stays
      // enabled (cordis.patch.yml) and dsh.client.inject declares the
      // dependency, so the module table materializes it before this bundle.
      schedule: require('@deepseek-ai/dsh-client-ui-schedule'), conversation: require('@deepseek-ai/dsh-client-ui-conversation'), attachment: require('@deepseek-ai/dsh-client-ui-attachment'),
      browser: require('@deepseek-ai/dsh-client-ui-sidebar-browser'),
    }) };
    return {
      name: 'agentkit-studio',
      inject: ['slots', 'layout', 'connection', 'remote', 'remote.session', 'remote.settings', 'remote.credentials', 'remote.llm', 'remote.agentPresets', 'remote.commands', 'sessions', 'modelDirectories', 'uiConversation'],
      apply(ctx) { mountStudio(ctx, createStudioApp(runtime)); },
    };
  },
});
