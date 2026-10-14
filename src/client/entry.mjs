import { createStudioApp } from './app.mjs';
import { mountStudio } from './dsh/mount.mjs';

window.__ModuleLoader__.load({
  id: '@kingsoftcloud/agentkit-studio',
  factory: require => {
    const runtime = { React: require('react'), primitives: require('@deepseek-ai/dsh-client-ui-primitives') };
    return {
      name: 'agentkit-studio',
      inject: ['slots', 'layout', 'connection', 'remote', 'remote.session', 'remote.settings', 'remote.credentials', 'remote.llm', 'remote.agentPresets', 'remote.commands', 'sessions', 'modelDirectories', 'uiConversation'],
      apply(ctx) { mountStudio(ctx, createStudioApp(runtime)); },
    };
  },
});
