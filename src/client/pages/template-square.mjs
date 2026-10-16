function createTemplateSquare({ ui, hostRemote, window = globalThis.window, CustomEvent = globalThis.CustomEvent }) {
  const { React, BRAND, inputStyle, buttonStyle, pagerButtonStyle, Pill, StudioSubnav, AgentCreatePage, AgentWorkspace, McpResourceDialog, EmptyState } = ui;
  const { createElement: h, useState, useEffect, useRef } = React;
  const templateArtworkCache = /* @__PURE__ */ new Map();
  function TemplateArtwork({ item, size = 54, kind = "skill" }) {
    const key = `${item.id}:${item.artwork?.blobId || item.artwork?.sha256 || ""}`;
    const [url, setUrl] = useState(templateArtworkCache.get(key) || ""), node = useRef(null);
    useEffect(() => {
      let active = true;
      setUrl(templateArtworkCache.get(key) || "");
      if (!item.artwork?.available) return;
      const observer = new IntersectionObserver((entries) => {
        if (!entries.some((x) => x.isIntersecting)) return;
        observer.disconnect();
        hostRemote.templateAvatar({ id: item.id, digest: item.digest }).then((value) => {
          if (value) {
            templateArtworkCache.set(key, value);
            if (active) setUrl(value);
          }
        }).catch(() => {
        });
      }, { rootMargin: "100px" });
      if (node.current) observer.observe(node.current);
      return () => {
        active = false;
        observer.disconnect();
      };
    }, [key]);
    const colors = [["#e7e9ff", "#7180db"], ["#ddf3ec", "#4caa8d"], ["#ffecdd", "#e69a62"], ["#f3e6f7", "#bb7fbe"]][[...item.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 4];
    const theme = kind === "team" ? "team" : /data|excel|xlsx|sql|chart|分析|数据/i.test(item.name || "") ? "chart" : /code|python|开发|debug|git|react|typescript/i.test(item.name || "") ? "code" : /search|research|检索|研究|搜索/i.test(item.name || "") ? "search" : /video|audio|视频|音频|music/i.test(item.name || "") ? "media" : "document";
    const paths = { team: '<circle cx="25" cy="25" r="7" fill="#fff"/><circle cx="42" cy="28" r="6" fill="#ffe5a3"/><path d="M13 48c0-16 24-16 24 0" fill="#fff"/><path d="M36 46c0-12 18-12 18 0" fill="#ffe5a3"/>', chart: '<rect x="14" y="33" width="8" height="17" rx="3" fill="#fff"/><rect x="28" y="24" width="8" height="26" rx="3" fill="#fff"/><rect x="42" y="15" width="8" height="35" rx="3" fill="#ffe5a3"/>', code: '<rect x="10" y="15" width="44" height="35" rx="7" fill="#fff"/><path d="m24 26-7 7 7 7m16-14 7 7-7 7m-6-16-5 20" stroke="' + colors[1] + '" stroke-width="3" fill="none" stroke-linecap="round"/>', search: '<circle cx="29" cy="28" r="15" fill="#fff"/><circle cx="29" cy="28" r="9" fill="none" stroke="' + colors[1] + '" stroke-width="3"/><path d="m40 40 11 11" stroke="#ffe5a3" stroke-width="7" stroke-linecap="round"/>', media: '<rect x="10" y="16" width="44" height="32" rx="9" fill="#fff"/><path d="m28 24 12 8-12 8z" fill="' + colors[1] + '"/>', document: '<rect x="17" y="10" width="32" height="44" rx="6" fill="#fff"/><path d="M24 22h17M24 30h17M24 38h10" stroke="' + colors[1] + '" stroke-width="3" stroke-linecap="round"/><circle cx="47" cy="46" r="10" fill="#ffe5a3"/>' };
    const fallback = "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 64 64"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="' + colors[1] + '"/><stop offset="1" stop-color="' + colors[0] + '"/></linearGradient></defs><rect width="64" height="64" rx="17" fill="url(#g)"/><circle cx="55" cy="10" r="22" fill="white" opacity=".15"/>' + paths[theme] + "</svg>");
    return h("span", { ref: node, style: { width: size, height: size, flex: "none", display: "inline-flex", borderRadius: size * 0.28, overflow: "hidden", background: colors[0] } }, h("img", { src: url || fallback, alt: "", width: size, height: size, style: { objectFit: "cover" } }));
  }
  function StudioTemplateSquare() {
    const [kind, setKind] = useState("expert"), [query, setQuery] = useState(""), [mcp, setMcp] = useState(null), [revision, setRevision] = useState(0);
    useEffect(() => {
      const change = (event) => {
        setKind(event.detail.kind);
        setQuery(event.detail.query || "");
      };
      window.addEventListener("agentkit-studio:catalog-kind", change);
      return () => window.removeEventListener("agentkit-studio:catalog-kind", change);
    }, []);
    const labels = [["expert", "\u4E13\u5BB6", "\u25C8"], ["team", "\u4E13\u5BB6\u56E2", "\u25C9"], ["skill", "\u6280\u80FD", "\u2726"], ["mcp", "\u8FDE\u63A5\u5668", "\u2318"]];
    return h(
      "div",
      { className: "sq-page" },
      h("style", null, `
      .sq-page{color:var(--dsw-alias-label-primary,#202124);max-width:1900px;margin:auto}.sq-nav{display:flex;gap:28px;margin:22px 30px 0;border-bottom:1px solid var(--dsw-alias-border-l3,#ececef);padding-bottom:13px}.sq-tab{display:flex;align-items:center;gap:8px;border:0;background:none;font:inherit;font-size:19px;font-weight:550;color:var(--dsw-alias-label-secondary,#777);cursor:pointer;padding:7px 0}.sq-tab[aria-selected=true]{color:var(--dsw-alias-label-primary,#202124)}.sq-tab span{font-size:23px}.sq-page>.rl-page,.sq-team-page{padding:22px 30px 40px}.sq-page .ec-page{padding-top:18px}.sq-page button:focus-visible{outline:2px solid #597896;outline-offset:3px}.sq-toolbar{display:flex;justify-content:space-between;align-items:center;gap:14px;margin:0 0 22px}.sq-btn{border:1px solid var(--dsw-alias-border-l3,#e7e8eb);border-radius:9px;padding:9px 14px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;cursor:pointer;font:inherit;font-size:13px}.sq-btn.primary{background:#22252a;color:white;border-color:#22252a}.sq-muted{color:var(--dsw-alias-label-secondary,#777);font-size:12px;line-height:1.8}.sq-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:16px}.sq-team-card{border:1px solid var(--dsw-alias-border-l3,#e7e8eb);border-radius:18px;padding:21px;background:var(--dsw-alias-bg-layer-1,#fff);position:relative}.sq-team-card:hover{box-shadow:0 8px 24px #2028380b}.sq-team-card h3{font-size:17px;margin:13px 0 8px}.sq-team-card p{min-height:42px;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary,#777)}.sq-team-mark{display:grid;place-items:center;width:50px;height:50px;border-radius:15px;font-size:26px;background:linear-gradient(145deg,#d8e8ff,#eae0fa);color:#5263a0}.sq-team-actions{display:flex;gap:8px;margin-top:18px}.sq-team-actions .primary{opacity:0;transition:opacity .15s}.sq-team-card:hover .primary,.sq-team-card:focus-within .primary{opacity:1}.sq-modal{width:min(800px,calc(100vw - 36px));max-height:calc(100dvh - 60px);border:1px solid var(--dsw-alias-border-l3,#eee);border-radius:23px;padding:28px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;overflow:auto}.sq-modal::backdrop{background:#20243038;backdrop-filter:blur(5px)}.sq-modal h2{margin:0;font-size:22px}.sq-modal label{display:block;font-size:13px;margin:15px 0}.sq-modal input,.sq-modal textarea,.sq-modal select{display:block;width:100%;padding:10px 12px;margin-top:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;border:1px solid var(--dsw-alias-border-l3,#ddd);border-radius:8px;font:inherit;box-sizing:border-box}.sq-modal textarea{resize:vertical;min-height:74px;line-height:1.7}.sq-member{border:1px solid var(--dsw-alias-border-l3,#e8e9ee);border-radius:13px;margin:14px 0;padding:16px;background:color-mix(in srgb,currentColor 2%,transparent)}.sq-member-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.sq-sticky{position:sticky;bottom:-28px;padding:15px 0;background:var(--dsw-alias-bg-layer-1,#fff);display:flex;justify-content:flex-end;gap:10px}.sq-error{color:#ab3b23;background:#fff0e9;border-radius:9px;padding:12px;font-size:13px}.sq-run-member{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--dsw-alias-border-l3,#eee);padding:11px 0;font-size:13px}.sq-result{white-space:pre-wrap;font:inherit;line-height:1.8;font-size:13px;max-height:360px;overflow:auto}.sq-run-task{border-radius:9px;padding:10px;background:color-mix(in srgb,currentColor 4%,transparent);margin:8px 0;font-size:13px}@media(hover:none){.sq-team-actions .primary{opacity:1}}@media(max-width:650px){.sq-nav{gap:18px;margin-inline:16px}.sq-tab{font-size:16px}.sq-page>.rl-page,.sq-team-page{padding:18px 16px}.sq-member-row{grid-template-columns:1fr}}`),
      h("nav", { className: "sq-nav", role: "tablist", "aria-label": "\u6A21\u677F\u7C7B\u578B" }, labels.map(([id, label, icon]) => h("button", { key: id, className: "sq-tab", role: "tab", "aria-selected": kind === id, onClick: () => {
        setKind(id);
        setQuery("");
      } }, h("span", { "aria-hidden": true }, icon), label))),
      kind === "expert" ? h(ui.ExpertCatalogPage, { inline: true }) : kind === "team" ? h(ui.StudioTeamsPage) : h(ui.TemplateResourceLibrary, { key: `${kind}-${query}`, kind, initialQuery: query, onConfigureMcp: setMcp, refreshKey: revision }),
      mcp ? h(McpResourceDialog, { resource: mcp, onClose: () => setMcp(null), onCreated: () => setRevision((x) => x + 1) }) : null
    );
  }
  return { TemplateArtwork, StudioTemplateSquare };
}
export {
  createTemplateSquare
};
