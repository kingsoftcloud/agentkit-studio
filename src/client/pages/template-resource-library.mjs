function createTemplateResourcePages({ ui, hostRemote, window = globalThis.window, CustomEvent = globalThis.CustomEvent }) {
  const { React, BRAND, inputStyle, buttonStyle, pagerButtonStyle, Pill, StudioSubnav, AgentCreatePage, AgentWorkspace, McpResourceDialog, EmptyState } = ui;
  const { createElement: h, useState, useEffect, useRef } = React;
  function TemplateResourceLibrary({ kind, onConfigureMcp, refreshKey, initialQuery = "" }) {
    const [query, setQuery] = useState(() => {
      try {
        const value = localStorage.getItem("agentkit-studio:resource-query") || "";
        localStorage.removeItem("agentkit-studio:resource-query");
        return initialQuery || value;
      } catch {
        return initialQuery;
      }
    });
    const [result, setResult] = useState({ items: [], total: 0 }), [cursor, setCursor] = useState(null), [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(true), [busy, setBusy] = useState(""), [error, setError] = useState(""), [message, setMessage] = useState(""), [revision, setRevision] = useState(0);
    const [transfer, setTransfer] = useState(null), [cache, setCache] = useState(null);
    const [detail, setDetail] = useState(null), detailRef = useRef(null);
    useEffect(() => {
      if (detail && detailRef.current && !detailRef.current.open) detailRef.current.showModal();
    }, [detail]);
    useEffect(() => {
      hostRemote.templateCache().then(setCache).catch(() => {
      });
    }, [revision, refreshKey]);
    useEffect(() => {
      let current = true;
      setLoading(true);
      setError("");
      const timer = setTimeout(() => hostRemote.templateResources({ kind, query, cursor, limit: 60 }).then((value) => {
        if (current) setResult(value);
      }).catch((reason) => {
        if (current) setError(reason.message);
      }).finally(() => {
        if (current) setLoading(false);
      }), 200);
      return () => {
        current = false;
        clearTimeout(timer);
      };
    }, [kind, query, cursor, revision, refreshKey]);
    async function install(item) {
      if (busy) return;
      setBusy(item.id);
      setError("");
      setMessage("");
      try {
        const ref = { id: item.id, digest: item.digest };
        if (kind === "mcp") onConfigureMcp(await hostRemote.prepareTemplateResource(ref));
        else {
          const value = await hostRemote.runTemplateWorkflow({ kind: "install-skill", ref, requestId: crypto.randomUUID() }, setTransfer);
          setMessage(`\u5DF2\u5B89\u88C5\u300C${item.name}\u300D\u7684\u5B8C\u6574 ${value.fileCount || item.fileCount || 0} \u4E2A\u6587\u4EF6\uFF0C\u53EF\u5728\u539F Agent \u7F16\u8F91\u5668\u4E2D\u7ED1\u5B9A\u3002`);
          setRevision((value2) => value2 + 1);
        }
      } catch (reason) {
        setError(reason.message);
      } finally {
        setBusy("");
        setTransfer(null);
      }
    }
    const label = kind === "mcp" ? "\u8FDE\u63A5\u5668" : "\u6280\u80FD";
    return h(
      "section",
      { className: "rl-page", "aria-label": `${label}\u6A21\u677F\u76EE\u5F55` },
      h("style", null, ".rl-detail{width:min(720px,calc(100vw - 36px));max-height:calc(100dvh - 60px);overflow:auto;border:1px solid var(--dsw-alias-border-l3,#eee);border-radius:23px;padding:28px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222)}.rl-detail::backdrop{background:#20243038;backdrop-filter:blur(5px)}.rl-detail button{border:1px solid #ddd;border-radius:8px;padding:9px 14px;background:transparent;color:inherit;cursor:pointer}.rl-detail .sq-toolbar{display:flex;align-items:center;justify-content:space-between}.rl-detail .sq-muted{font-size:12px;color:var(--dsw-alias-label-secondary,#777);line-height:1.8}.rl-tools{display:flex;justify-content:space-between;align-items:center;gap:14px;margin:18px 0}.rl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}.rl-card{cursor:pointer;position:relative;transition:box-shadow .18s;}.rl-card:hover{box-shadow:0 7px 22px #2533480b}.rl-card:focus-within{outline:2px solid #8aa1bc}.rl-footer button{opacity:0}.rl-card:hover .rl-footer button,.rl-card:focus-within .rl-footer button{opacity:1}@media(hover:none){.rl-footer button{opacity:1}}.rl-card{border:1px solid var(--dsw-alias-border-l3,#e8e9ed);border-radius:16px;background:var(--dsw-alias-bg-layer-1,#fff);padding:19px;min-width:0;display:flex;flex-direction:column;gap:13px}.rl-heading{display:flex;gap:12px;align-items:center;min-width:0}.rl-symbol{width:43px;height:43px;border-radius:12px;display:grid;place-items:center;flex:none;font-size:22px;font-weight:650}.rl-heading strong{font-size:14px;line-height:1.5;overflow-wrap:anywhere}.rl-description{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#74787e);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin:0}.rl-footer{margin-top:auto;display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:11px;color:var(--dsw-alias-label-secondary,#74787e)}"),
      h("div", { className: "rl-tools" }, h("input", { type: "search", value: query, "aria-label": `\u641C\u7D22\u53EF\u7528${label}`, placeholder: `\u641C\u7D22${label}`, onChange: (event) => {
        setQuery(event.target.value);
        setCursor(null);
        setHistory([]);
      }, style: { ...inputStyle(), maxWidth: 370, marginTop: 0 } }), h("span", { style: { color: BRAND.inkMuted, fontSize: 12 } }, `${result.total} \u9879 \xB7 \u6309\u9700\u5B89\u88C5`)),
      h("p", { style: { fontSize: 12, color: BRAND.inkMuted, lineHeight: 1.7 } }, kind === "mcp" ? "\u8FDE\u63A5\u5668\u914D\u7F6E\u6309\u539F\u58F0\u660E\u8FC1\u79FB\u3002\u9700\u8981\u767B\u5F55\u7684\u670D\u52A1\u4F7F\u7528\u4F60\u7684\u65B0\u6388\u6743\uFF1B\u672C\u5730\u5E94\u7528\u9700\u8981\u5148\u542F\u52A8\u3002\u63A2\u6D4B\u901A\u8FC7\u540E\uFF0C\u624D\u4F1A\u8FDB\u5165 Agent \u53EF\u7ED1\u5B9A\u8D44\u6E90\u5217\u8868\u3002" : "\u5B89\u88C5\u4F1A\u4FDD\u7559\u5B8C\u6574\u811A\u672C\u3001\u8D44\u6599\u53CA\u76F8\u5BF9\u8DEF\u5F84\uFF0C\u4E0D\u4F1A\u8986\u76D6\u5DF2\u6709\u540C\u540D\u6280\u80FD\u3002\u6587\u4EF6\u5B89\u88C5\u5B8C\u6210\u540E\uFF0C\u53EF\u7EE7\u7EED\u5728\u539F Agent \u521B\u5EFA\u548C\u7F16\u8F91\u6D41\u7A0B\u4E2D\u7ED1\u5B9A\u3002"),
      error ? h("p", { role: "alert", style: { color: BRAND.danger } }, error) : null,
      message ? h("p", { role: "status", style: { color: BRAND.accentStrong } }, message) : null,
      cache ? h("div", { style: { display: "flex", gap: 12, alignItems: "center", fontSize: 12, color: BRAND.inkMuted } }, h("span", null, `\u4E0B\u8F7D\u7F13\u5B58 ${(cache.bytes / 1024 / 1024).toFixed(1)} MB`), h("button", { style: buttonStyle(), disabled: !!busy || !cache.bytes, onClick: async () => {
        try {
          await hostRemote.clearTemplateCache();
          setCache(await hostRemote.templateCache());
          setMessage("\u4E0B\u8F7D\u7F13\u5B58\u5DF2\u6E05\u7406\uFF0C\u5DF2\u5B89\u88C5\u7684 Skill \u6587\u4EF6\u4FDD\u7559\u3002");
        } catch (reason) {
          setError(reason.message);
        }
      } }, "\u6E05\u7406\u4E0B\u8F7D\u7F13\u5B58")) : null,
      transfer ? h("div", { role: "status", style: { display: "flex", alignItems: "center", gap: 12, fontSize: 12 } }, h("span", null, transfer.label || { "downloading": "\u6B63\u5728\u4E0B\u8F7D\u5B8C\u6574\u6280\u80FD\u8D44\u6E90", "cache-hit": "\u4F7F\u7528\u672C\u673A\u7F13\u5B58", "verifying": "\u6B63\u5728\u6821\u9A8C\u8D44\u6E90", "installing": "\u6B63\u5728\u5B89\u88C5\u6280\u80FD\u6587\u4EF6" }[transfer.phase] || "\u6B63\u5728\u51C6\u5907\u6280\u80FD"), transfer.phase === "downloading" && transfer.total ? h("progress", { "aria-label": "\u6280\u80FD\u4E0B\u8F7D\u8FDB\u5EA6", max: transfer.total, value: transfer.received }) : null, transfer.phase === "downloading" && transfer.total ? h("span", null, `${(transfer.received / 1024 / 1024).toFixed(1)} / ${(transfer.total / 1024 / 1024).toFixed(1)} MB`) : null, transfer.cancellable ? h("button", { style: buttonStyle(), onClick: () => hostRemote.cancelTemplateWorkflow(transfer.requestId) }, "\u53D6\u6D88\u5B89\u88C5") : null) : null,
      loading ? h("p", { role: "status" }, "\u6B63\u5728\u8BFB\u53D6\u76EE\u5F55\u2026") : null,
      h("div", { className: "rl-grid" }, result.items.map((item) => {
        const palette = [["#e7f0ff", "#3265b5"], ["#e6f4ed", "#2c7a5a"], ["#fff0df", "#b06825"], ["#f1eafa", "#7b529a"]][[...item.id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 4];
        const unsupported = kind === "mcp" && item.installable === false;
        return h(
          "article",
          { className: "rl-card", key: item.id, tabIndex: 0, role: "button", "aria-label": `\u67E5\u770B${item.name}`, onClick: () => setDetail(item), onKeyDown: (event) => {
            if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) {
              event.preventDefault();
              setDetail(item);
            }
          } },
          h("div", { className: "rl-heading" }, h(ui.TemplateArtwork, { item, kind, size: 52 }), h("strong", null, item.name)),
          h("p", { className: "rl-description" }, item.description),
          item.setupReasons?.length ? h("p", { className: "rl-description" }, item.setupReasons.join("\uFF1B")) : null,
          h(
            "div",
            { className: "rl-footer" },
            h("span", null, item.installed ? kind === "skill" ? "\u6587\u4EF6\u5DF2\u5B89\u88C5" : item.installedStatus === "ready" ? "\u5DF2\u8FDE\u63A5" : "\u5F85\u63A2\u6D4B" : unsupported ? "\u9700\u8981\u9002\u914D" : item.requiresConfiguration ? "\u9700\u8981\u914D\u7F6E / \u6388\u6743" : kind === "skill" ? `${item.fileCount || 0} \u4E2A\u6587\u4EF6` : "\u5C1A\u672A\u8FDE\u63A5"),
            h("button", { type: "button", disabled: Boolean(busy) || unsupported || kind === "skill" && item.installed, onClick: (event) => {
              event.stopPropagation();
              void install(item);
            }, style: { ...buttonStyle(), fontSize: 12, padding: "7px 11px" } }, busy === item.id ? "\u51C6\u5907\u4E2D\u2026" : kind === "mcp" ? item.installed ? "\u7BA1\u7406\u8FDE\u63A5" : "\u914D\u7F6E\u8FDE\u63A5" : item.installed ? "\u5DF2\u5B89\u88C5" : "\u5B89\u88C5")
          )
        );
      })),
      detail ? h("dialog", { ref: detailRef, className: "sq-modal rl-detail", "aria-label": `${label}\u8BE6\u60C5`, onCancel: () => setDetail(null) }, h("div", { className: "sq-toolbar" }, h("div", { style: { display: "flex", gap: 16, alignItems: "center" } }, h(ui.TemplateArtwork, { item: detail, kind, size: 68 }), h("h2", null, detail.name)), h("button", { className: "sq-btn", onClick: () => setDetail(null), "aria-label": `\u5173\u95ED${label}\u8BE6\u60C5` }, "\u2715")), h("p", { style: { fontSize: 14, lineHeight: 1.9 } }, detail.description), h("p", { className: "sq-muted" }, kind === "skill" ? `v${detail.version || "1.0.0"} \xB7 ${detail.fileCount || 0} \u4E2A\u5B8C\u6574\u6587\u4EF6` : `\u8FDE\u63A5\u65B9\u5F0F \xB7 ${detail.endpointUrl || "\u672C\u673A\u547D\u4EE4"}`), detail.setupReasons?.length ? h("p", { className: "sq-muted" }, detail.setupReasons.join("\uFF1B")) : null, h("p", { className: "sq-muted" }, kind === "skill" ? "\u5B89\u88C5\u540E\u4FDD\u7559\u5B8C\u6574\u811A\u672C\u548C\u8D44\u6599\uFF0C\u53EF\u5728\u539F Agent \u7F16\u8F91\u5668\u4E2D\u7ED1\u5B9A\u3002" : "\u4F7F\u7528\u4F60\u81EA\u5DF1\u7684\u6388\u6743\u5B8C\u6210\u8FDE\u63A5\uFF0C\u4FDD\u5B58\u540E\u63A2\u6D4B\u5DE5\u5177\u5217\u8868\u3002"), h("button", { className: "sq-btn primary", disabled: !!busy || kind === "skill" && detail.installed || kind === "mcp" && detail.installable === false, onClick: () => {
        const item = detail;
        setDetail(null);
        void install(item);
      } }, kind === "skill" ? detail.installed ? "\u5DF2\u5B89\u88C5" : "\u5B89\u88C5\u5B8C\u6574\u6280\u80FD" : "\u914D\u7F6E\u8FDE\u63A5\u5668")) : null,
      h("div", { className: "rl-tools" }, h("button", { disabled: !history.length || loading, style: buttonStyle(), onClick: () => {
        setCursor(history.at(-1));
        setHistory(history.slice(0, -1));
      } }, "\u4E0A\u4E00\u9875"), h("button", { disabled: !result.nextCursor || loading, style: buttonStyle(), onClick: () => {
        setHistory([...history, cursor]);
        setCursor(result.nextCursor);
      } }, "\u4E0B\u4E00\u9875"))
    );
  }
  return { TemplateResourceLibrary };
}
export {
  createTemplateResourcePages
};
