import { createStudioPrimitives } from "./components/primitives.mjs";
import { BRAND, PANELS, ALLOWED_RUNTIME_TYPES, RUNTIME_LABELS } from "./theme.mjs";
import { createProductClient } from "./remote/product-client.mjs";
import { createConfirmation } from "./components/confirmation.mjs";
import { createCredentialOnboarding } from "./pages/credential-onboarding.mjs";
import { createStartChecks } from "./pages/start-checks.mjs";
import { createOverviewPage } from "./pages/overview.mjs";
import { createAgentSelector } from "./dsh/agent-selector.mjs";
import { createCloudPermissionPresentation } from './dsh/cloud-permission.mjs';
import { createCloudSessionStatus } from "./dsh/cloud-status.mjs";
import { createNavigation } from "./components/navigation.mjs";
import { createRuntimeCatalogPage } from "./pages/runtime-catalog.mjs";
import { createNativeAuthoringButton } from "./dsh/native-authoring.mjs";
import { createAgentPages } from "./pages/agents.mjs";
import { createPlatformResourcePicker } from "./pages/platform-resource-picker.mjs";
import { createAgentEdit } from "./pages/agent-edit.mjs";
import { createAgentForm } from "./pages/agent-form.mjs";
import { createFormStyles } from "./components/form-styles.mjs";
import { createDomainPage } from "./pages/domain.mjs";
import { createResourceDialog } from "./components/resource-dialog.mjs";
import { createResourceDialogs } from "./components/resource-dialogs.mjs";
import { createResourcePages } from "./pages/resources.mjs";
import { createDshPluginPages } from "./pages/dsh-plugins.mjs";
import { createCodexPluginPages } from "./pages/codex-plugins.mjs";
import { createDeliveryPages } from "./pages/delivery.mjs";
import { DEPLOYMENT_LABELS } from "./state/deployment.mjs";
import { createScheduleDelivery } from "./components/schedule-delivery.mjs";
import { createAutomationPage } from "./pages/automation.mjs";
import { createOperationsWorkspace } from "./pages/operations.mjs";
import { createOperationalComponents } from "./components/operational.mjs";
import { createEvaluationPage } from "./pages/evaluation.mjs";
import { createObservabilityPage } from "./pages/observability.mjs";
import { createChannelsPage } from "./pages/channels.mjs";
import { createStudioShell } from "./components/shell.mjs";
import { createProductDocumentEffects } from "./dsh/product-document.mjs";
import { createModelBridge } from "./dsh/model-bridge.mjs";
import { createModelSettingsSection } from "./pages/model-settings.mjs";
import { createStudioSettingsSection } from "./pages/studio-settings.mjs";
import { createSettingsLauncher } from "./components/settings-launcher.mjs";
import { createConnectionOwner } from "./state/connection.mjs";
import { createConversationAgentState } from "./state/conversation-agent.mjs";
import { createNativeAuthoring } from "./state/native-authoring.mjs";
import { readProductVersions } from "./state/product-versions.mjs";
import { createStudioActions } from "./state/actions.mjs";
import { createComputerConnection } from './components/computer-connection.mjs';
import { createAssistantSettings } from './pages/assistant-settings.mjs';
import { createAssistantConversation } from './dsh/assistant-conversation.mjs';
import { createAssistantTranscript } from './components/assistant-transcript.mjs';
import { createAssistantPage } from './pages/assistant.mjs';
import { createAssistantBrowser } from './components/assistant-browser.mjs';

import { createExpertPages } from './pages/expert-catalog.mjs';
import { createTemplateSquare } from './pages/template-square.mjs';
import { createStudioTeamPages } from './pages/studio-teams.mjs';
import { createTemplateResourcePages } from './pages/template-resource-library.mjs';

/** Build one presentation graph and one set of owners for each apply(ctx). */
export function createStudioApp({ React, primitives, ConversationNodeAssembler, nativeModules }, { window = globalThis.window, document = globalThis.document, CustomEvent = globalThis.CustomEvent, MutationObserver = globalThis.MutationObserver } = {}) {
  let closed = false;

  /** Show only the value just typed; stored credentials are never read back. */
  const { SecretInput, StudioMark, StudioWordmark, Pill, SectionHeading, OperationalPageHeading, OperationalPanel, ContentIntro, Metric, EmptyState, DisabledAction } = createStudioPrimitives({ React });
  const { inputStyle, buttonStyle, pagerButtonStyle } = createFormStyles(BRAND);
  const ResourceDialog = createResourceDialog({ React, buttonStyle });
  const { IconSettingsOutlineMedium, IconChevronDownOutlineRegular, Menu, MenuItemButton, Input, Tooltip, Modal, MarkdownText, MarkdownDelegateProvider, DisclosureRow, StateDot, ImageLightbox, FileTypeIcon, Button, RiskConfirmation } = primitives;
  const ui = { React, BRAND, PANELS, ALLOWED_RUNTIME_TYPES, RUNTIME_LABELS, DEPLOYMENT_LABELS, SecretInput, StudioMark, StudioWordmark, Pill, SectionHeading, OperationalPageHeading, OperationalPanel, ContentIntro, Metric, EmptyState, DisabledAction, inputStyle, buttonStyle, pagerButtonStyle, ResourceDialog, IconSettingsOutlineMedium, IconChevronDownOutlineRegular, Menu, MenuItemButton, Input, Tooltip, Modal, MarkdownText, MarkdownDelegateProvider, DisclosureRow, StateDot, ImageLightbox, FileTypeIcon, Button, RiskConfirmation };
  const { STUDIO_VERSION, STUDIO_PLUGIN_VERSION, DSH_VERSION } = readProductVersions(window.__AGENTKIT_STUDIO__);
  const connectionOwner = createConnectionOwner();
  const hostRemote = createProductClient(connectionOwner.connection, { window });
  const { readConversationAgent, writeConversationAgent } = createConversationAgentState({ events: window, storage: () => window.localStorage, createEvent: (type, detail) => new CustomEvent(type, { detail }) });

  const confirmation = createConfirmation({ document });
  const actions = createStudioActions({ confirm: confirmation.confirm });
  const authoring = createNativeAuthoring({ writeConversationAgent, events: window, createEvent: type => new CustomEvent(type) });
  const NativeAuthoringButton = createNativeAuthoringButton({ React, authoring, buttonStyle });
  ui.NativeAuthoringButton = NativeAuthoringButton;
  const PlatformResourcePicker = createPlatformResourcePicker({ ui, hostRemote, window });
  ui.PlatformResourcePicker = PlatformResourcePicker;
  const AgentCreatePage = createAgentForm({ ui, hostRemote });
  ui.AgentCreatePage = AgentCreatePage;
  const AgentEditPage = createAgentEdit({ ui, hostRemote });
  ui.AgentEditPage = AgentEditPage;
  Object.assign(ui, createNavigation({ ui }));
  Object.assign(ui, createOperationalComponents({ ui }));
  ui.StartChecks = createStartChecks({ ui, hostRemote, window, CustomEvent });
  ui.OverviewPage = createOverviewPage({ ui, hostRemote, window, CustomEvent });
  ui.AgentContextSelector = createAgentSelector({ ui, hostRemote, readConversationAgent, writeConversationAgent });
  ui.CloudPermissionPresentation = createCloudPermissionPresentation({ ui, hostRemote, window });
  ui.CloudSessionStatus = createCloudSessionStatus({ ui, hostRemote });
  ui.RuntimeCatalogPage = createRuntimeCatalogPage({ ui, hostRemote, window, CustomEvent });
  ui.DomainPage = createDomainPage({ ui });
  Object.assign(ui, createResourceDialogs({ ui, hostRemote, window, CustomEvent }));
  Object.assign(ui, createResourcePages({ ui, hostRemote, actions, window }));
  Object.assign(ui, createDshPluginPages({ ui, hostRemote }));
  Object.assign(ui, createCodexPluginPages({ ui, hostRemote }));
  Object.assign(ui, createDeliveryPages({ ui, hostRemote, actions, window, document }));
  Object.assign(ui, createScheduleDelivery({ ui, hostRemote }));
  Object.assign(ui, createAutomationPage({ ui, hostRemote, actions, window, document }));
  ui.EvaluationPage = createEvaluationPage({ ui, hostRemote, window, document });
  ui.ObservabilityPage = createObservabilityPage({ ui, hostRemote, window, document });
  ui.ChannelsPage = createChannelsPage({ ui, hostRemote, actions, window });
  Object.assign(ui, createOperationsWorkspace({ ui }));
  const documentEffects = createProductDocumentEffects({ window, document, MutationObserver });
  const { createDshModelBridge: makeModelBridge } = createModelBridge({ hostRemote });
  const createDshModelBridge = ctx => makeModelBridge(ctx, { isActive: () => !closed });
  ui.ModelSettingsSection = createModelSettingsSection({ ui, hostRemote, window, CustomEvent });
  Object.assign(ui, createCredentialOnboarding({ ui, hostRemote, window, document }));
  Object.assign(ui, createAgentPages({ ui, hostRemote, actions, window }));
  ui.ComputerConnection = createComputerConnection({ ui, hostRemote, actions, window, document });
  ui.AssistantSettingsSection = createAssistantSettings({ ui, hostRemote, actions, window, nativeModules });
  const assistantConversation = createAssistantConversation({ ConversationNodeAssembler });
  ui.AssistantTranscript = createAssistantTranscript({ ui, hostRemote, assistantConversation, window });
  ui.AssistantBrowser = createAssistantBrowser({ ui, nativeModules, window });
  ui.AssistantPage = createAssistantPage({ ui, hostRemote, actions, window, nativeModules });
  Object.assign(ui, createExpertPages({ ui, hostRemote, actions, window, CustomEvent }));
  Object.assign(ui, createTemplateSquare({ ui, hostRemote, window, CustomEvent }));
  Object.assign(ui, createStudioTeamPages({ ui, hostRemote, actions, window, CustomEvent }));
  Object.assign(ui, createTemplateResourcePages({ ui, hostRemote, window, CustomEvent }));
  Object.assign(ui, createStudioShell({ ui, hostRemote }));
  ui.StudioSettingsLauncher = createSettingsLauncher({ ui, window });
  ui.StudioSettingsSection = createStudioSettingsSection({ ui, hostRemote, window, versions: { STUDIO_VERSION, STUDIO_PLUGIN_VERSION, DSH_VERSION } });


  return {
    ui: Object.freeze(ui), assistantConversation, window, CustomEvent, authoring, connectionOwner, hostRemote, actions, documentEffects, createDshModelBridge, writeConversationAgent,
    closed: () => closed,
    dispose() { if (closed) return; closed = true; actions.dispose(); confirmation.dispose(); authoring.dispose(); connectionOwner.dispose(); },
  };
}
