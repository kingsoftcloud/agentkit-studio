import { createExpertCatalogPage } from "../../../packages/expert-catalog/src/client.mjs";
import { createCatalogArtwork } from "../../../packages/expert-catalog/src/artwork.mjs";
import { seed } from "../../../packages/expert-catalog/src/seed.mjs";
function createExpertPages({ ui, hostRemote, actions, window = globalThis.window, CustomEvent = globalThis.CustomEvent }) {
  const { React, BRAND, inputStyle, buttonStyle, pagerButtonStyle, Pill, StudioSubnav, AgentCreatePage, AgentWorkspace, McpResourceDialog, EmptyState } = ui;
  const { createElement: h, useState, useEffect, useRef } = React;
  const ExpertCatalogPage = createExpertCatalogPage(React, {
    artwork: createCatalogArtwork(React),
    remote: hostRemote,
    initialCatalog: seed,
    CreatePage: AgentCreatePage,
    onSummoned: (agent) => actions.bindAgent({ agentId: agent.metadata.id, throwOnError: true }),
    onResources: (kind, query = "") => window.dispatchEvent(new CustomEvent("agentkit-studio:catalog-kind", { detail: { kind, query } })),
    onAgents: () => {
      window.dispatchEvent(new CustomEvent("agentkit-studio:navigate", { detail: "agents" }));
      window.dispatchEvent(new CustomEvent("agentkit-studio:agent-view", { detail: "mine" }));
    }
  });
  function StudioAgentHub({ onNavigate }) {
    const [view, setView] = useState(() => {
      try {
        return window.localStorage.getItem("agentkit-studio:agents-view") === "mine" ? "mine" : "catalog";
      } catch {
        return "catalog";
      }
    });
    const choose = (next) => {
      setView(next);
      try {
        window.localStorage.setItem("agentkit-studio:agents-view", next);
      } catch {
      }
    };
    useEffect(() => {
      const change = (event) => {
        if (["mine", "catalog"].includes(event.detail)) choose(event.detail);
      };
      window.addEventListener("agentkit-studio:agent-view", change);
      return () => window.removeEventListener("agentkit-studio:agent-view", change);
    }, []);
    return h(
      "div",
      { style: { height: "100%", overflow: "auto", background: BRAND.surface } },
      h(
        "div",
        { style: { padding: "20px 30px 0" } },
        h(StudioSubnav, { value: view, onChange: choose, items: [{ id: "mine", label: "\u6211\u7684\u667A\u80FD\u4F53" }, { id: "catalog", label: "\u6A21\u677F\u5E7F\u573A" }] })
      ),
      view === "catalog" ? h(ui.StudioTemplateSquare) : h("div", { "data-agentkit-studio": "product-application", style: { padding: "18px 28px 32px" } }, h(AgentWorkspace, { onNavigate }))
    );
  }
  return { ExpertCatalogPage, StudioAgentHub };
}
export {
  createExpertPages
};
