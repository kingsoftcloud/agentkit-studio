function createStudioTeamPages({ ui, hostRemote, actions, window = globalThis.window, CustomEvent = globalThis.CustomEvent }) {
  const { React, BRAND, inputStyle, buttonStyle, pagerButtonStyle, Pill, StudioSubnav, AgentCreatePage, AgentWorkspace, McpResourceDialog, EmptyState } = ui;
  const { createElement: h, useState, useEffect, useRef } = React;
  function StudioTeamTemplateGallery({ onCreated, onCatalog }) {
    const [result, setResult] = useState({ items: [], total: 0 }), [query, setQuery] = useState(""), [cursor, setCursor] = useState(null), [pages, setPages] = useState([]), [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState(null), [busy, setBusy] = useState(false), [progress, setProgress] = useState(null), [error, setError] = useState(""), [plan, setPlan] = useState(null), [bindings, setBindings] = useState({});
    const dialog = useRef(null), request = useRef(null);
    useEffect(() => {
      let active = true;
      setLoading(true);
      const timer = setTimeout(() => hostRemote.teamTemplates("list", { query, cursor, limit: 60 }).then((value) => {
        if (active) {
          setResult(value);
          onCatalog?.(value.items);
        }
      }).catch((e) => {
        if (active) setError(e.message);
      }).finally(() => {
        if (active) setLoading(false);
      }), 180);
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }, [query, cursor]);
    useEffect(() => {
      const node = dialog.current;
      if (selected && node && !node.open) node.showModal();
      return () => {
        if (node?.open) node.close();
      };
    }, [!!selected]);
    const open = (item) => {
      request.current = crypto.randomUUID();
      setSelected(item);
      setBindings({});
      setPlan(null);
      setProgress(null);
      setError("");
    };
    async function summon(item = selected, selectedBindings = bindings) {
      if (busy) return;
      setBusy(true);
      setError("");
      setSelected(item);
      request.current ||= crypto.randomUUID();
      try {
        const value = await hostRemote.runTemplateWorkflow({ kind: "summon-team", ref: { id: item.id, digest: item.digest, catalogId: result.catalogId }, bindings: selectedBindings, requestId: request.current }, setProgress);
        if (value.status === "needs-input") {
          setPlan(value.plan);
          setError(`${value.role}\u8FD8\u9700\u8981\u5B8C\u6210\u4EE5\u4E0B\u914D\u7F6E`);
          request.current = crypto.randomUUID();
          return;
        }
        setSelected(null);
        onCreated(value.team);
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
        setProgress(null);
      }
    }
    return h(
      "section",
      { "aria-label": "\u4E13\u5BB6\u56E2\u6A21\u677F" },
      h("div", { className: "sq-toolbar" }, h("div", null, h("h2", { style: { fontSize: 19, margin: "0 0 7px" } }, "\u4E13\u5BB6\u56E2\u6A21\u677F"), h("p", { className: "sq-muted", style: { margin: 0 } }, "\u89D2\u8272\u3001\u63D0\u793A\u8BCD\u548C\u914D\u5957\u6280\u80FD\u5DF2\u914D\u597D\u3002\u53EC\u5524\u6574\u961F\u540E\uFF0C\u5373\u53EF\u5F00\u59CB\u534F\u4F5C\uFF0C\u4E5F\u80FD\u7EE7\u7EED\u7F16\u8F91\u3002")), h("span", { className: "sq-muted" }, `${result.total} \u4E2A\u56E2\u961F\u6A21\u677F`)),
      h("input", { type: "search", "aria-label": "\u641C\u7D22\u4E13\u5BB6\u56E2\u6A21\u677F", placeholder: "\u641C\u7D22\u4E13\u5BB6\u56E2\u6A21\u677F", value: query, onChange: (e) => {
        setQuery(e.target.value);
        setCursor(null);
        setPages([]);
      }, style: { ...inputStyle(), maxWidth: 350, margin: "0 0 22px" } }),
      !selected && error ? h("p", { role: "alert", className: "sq-error" }, error) : null,
      loading ? h("p", { role: "status", className: "sq-muted" }, "\u6B63\u5728\u8BFB\u53D6\u4E13\u5BB6\u56E2\u6A21\u677F\u2026") : null,
      h("div", { className: "sq-card-grid" }, result.items.map((item) => h(
        "article",
        { key: item.id, className: "sq-team-card", tabIndex: 0, role: "button", "aria-label": `\u67E5\u770B${item.name}\u6A21\u677F`, onClick: () => open(item), onKeyDown: (e) => {
          if (e.target === e.currentTarget && ["Enter", " "].includes(e.key)) {
            e.preventDefault();
            open(item);
          }
        } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 14 } }, h(ui.TemplateArtwork, { item, kind: "team", size: 58 }), h("h3", { style: { margin: 0 } }, item.name)),
        h("p", { className: "rl-description" }, item.description),
        h("div", { className: "sq-muted", style: { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } }, item.roles?.slice(0, 4).map((x) => x.label).join(" \xB7 ")),
        h("div", { className: "sq-team-actions", style: { justifyContent: "space-between", alignItems: "center" } }, h("span", { className: "sq-muted" }, `${item.roles?.length || 0} \u4F4D\u9884\u914D\u4E13\u5BB6 \xB7 v${item.version}`), h("button", { className: "sq-btn primary", disabled: busy, onClick: (e) => {
          e.stopPropagation();
          open(item);
          void summon(item, {});
        } }, "\u53EC\u5524\u56E2\u961F"))
      ))),
      h("div", { className: "sq-toolbar", style: { marginTop: 18 } }, h("button", { className: "sq-btn", disabled: !pages.length || loading, onClick: () => {
        setCursor(pages.at(-1));
        setPages(pages.slice(0, -1));
      } }, "\u4E0A\u4E00\u9875"), h("button", { className: "sq-btn", disabled: !result.nextCursor || loading, onClick: () => {
        setPages([...pages, cursor]);
        setCursor(result.nextCursor);
      } }, "\u4E0B\u4E00\u9875")),
      selected ? h(
        "dialog",
        { ref: dialog, className: "sq-modal", "aria-label": "\u4E13\u5BB6\u56E2\u6A21\u677F\u8BE6\u60C5", onCancel: (e) => {
          e.preventDefault();
          if (!busy) setSelected(null);
        } },
        h("div", { className: "sq-toolbar" }, h("div", { style: { display: "flex", alignItems: "center", gap: 18 } }, h(ui.TemplateArtwork, { item: selected, kind: "team", size: 76 }), h("h2", null, selected.name)), h("button", { className: "sq-btn", disabled: busy, onClick: () => setSelected(null), "aria-label": "\u5173\u95ED\u56E2\u961F\u6A21\u677F\u8BE6\u60C5" }, "\u2715")),
        h("p", { style: { fontSize: 14, lineHeight: 1.9 } }, selected.description),
        h("h3", { style: { fontSize: 15 } }, "\u5DF2\u914D\u597D\u7684\u56E2\u961F\u6210\u5458"),
        selected.roles?.map((role) => h("div", { className: "sq-run-member", key: role.name }, h("strong", null, role.label), h("span", { className: "sq-muted" }, role.name === "lead" ? "\u4E3B\u7406\u4EBA \xB7 \u7EC4\u7EC7\u4E0E\u6C47\u603B" : "\u6210\u5458 \xB7 \u72EC\u7ACB\u6267\u884C\u4E0E\u6C47\u62A5"))),
        selected.examples?.length ? h("div", null, h("h3", { style: { fontSize: 15, marginTop: 24 } }, "\u53EF\u4EE5\u4EA4\u7ED9\u56E2\u961F\u7684\u4EFB\u52A1"), selected.examples.slice(0, 3).map((text, index) => h("p", { className: "sq-run-task", key: index }, text))) : null,
        h("p", { className: "sq-muted" }, "\u5C06\u81EA\u52A8\u51C6\u5907\u6A21\u677F\u4E2D\u7684\u5B8C\u6574 Agent\u3001Skill \u548C\u8FDE\u63A5\u5668\u4F9D\u8D56\u3002\u53EC\u5524\u540E\u53EF\u66F4\u6362\u4E13\u5BB6\u3001\u589E\u5220\u6210\u5458\u548C\u7F16\u8F91\u804C\u8D23\u3002"),
        error ? h("p", { role: "alert", className: "sq-error" }, error) : null,
        plan ? h(
          "div",
          null,
          plan.missing.some((x) => x.kind === "model") ? h("label", null, "\u56E2\u961F\u4F7F\u7528\u7684\u6A21\u578B", h("select", { "aria-label": "\u56E2\u961F\u4F7F\u7528\u7684\u6A21\u578B", value: bindings.modelId || "", onChange: (e) => setBindings({ ...bindings, modelId: e.target.value }) }, h("option", { value: "" }, "\u9009\u62E9\u6A21\u578B"), plan.models.map((model) => h("option", { key: model.id, value: model.id, disabled: model.disabled }, model.name)))) : null,
          plan.missing.filter((x) => x.kind === "mcp").map((x) => h("p", { className: "sq-muted", key: x.key }, `\u9700\u8981\u8FDE\u63A5\u5E76\u63A2\u6D4B\uFF1A${x.label}`, h("button", { className: "sq-btn", onClick: () => window.dispatchEvent(new CustomEvent("agentkit-studio:catalog-kind", { detail: { kind: "mcp", query: x.key } })) }, "\u914D\u7F6E\u8FDE\u63A5\u5668"))),
          ["knowledge-base", "memory-instance"].filter((kind) => plan.catalogs?.[kind]).map((kind) => h("label", { key: kind }, kind === "knowledge-base" ? "\u77E5\u8BC6\u5E93" : "\u8BB0\u5FC6\u5E93", h("select", { value: bindings[kind] || "", onChange: (e) => setBindings({ ...bindings, [kind]: e.target.value }) }, h("option", { value: "" }, "\u8BF7\u9009\u62E9"), plan.catalogs[kind].items.map((x) => h("option", { key: x.id, value: x.id, disabled: x.disabled }, x.name)))))
        ) : null,
        progress ? h("div", { role: "status", className: "sq-run-task" }, h("span", null, progress.label || "\u6B63\u5728\u51C6\u5907\u4E13\u5BB6\u56E2\u2026"), progress.total ? h("progress", { "aria-label": "\u56E2\u961F\u8D44\u6E90\u4E0B\u8F7D\u8FDB\u5EA6", max: progress.total, value: progress.received || 0, style: { display: "block", width: "100%", marginTop: 12 } }) : null) : null,
        h("div", { className: "sq-sticky" }, h("button", { className: "sq-btn primary", disabled: busy, onClick: () => summon() }, busy ? "\u6B63\u5728\u53EC\u5524\u4E13\u5BB6\u56E2\u2026" : "\u53EC\u5524\u6574\u4E2A\u56E2\u961F"))
      ) : null
    );
  }
  function StudioTeamsPage() {
    const [artwork, setArtwork] = useState({});
    const [data, setData] = useState({ items: [], presets: [], agents: [] }), [query, setQuery] = useState(""), [edit, setEdit] = useState(null), [target, setTarget] = useState(null), [task, setTask] = useState(""), [run, setRun] = useState(null), [history, setHistory] = useState([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
    const dialog = useRef(null), requestKey = useRef(null), active = useRef(true), runRef = useRef(null);
    runRef.current = run;
    const load = () => hostRemote.teams("list").then((value) => {
      if (active.current) setData(value);
    });
    useEffect(() => {
      active.current = true;
      load().catch((e) => setError(e.message));
      return () => {
        active.current = false;
      };
    }, []);
    useEffect(() => {
      const node = dialog.current;
      if ((edit || target || run) && node && !node.open) node.showModal();
      return () => {
        if (node?.open) node.close();
      };
    }, [!!edit, !!target, !!run]);
    useEffect(() => {
      if (!run) return;
      let current = true, pending = false;
      const poll = async () => {
        if (pending) return;
        pending = true;
        try {
          const value = await hostRemote.teams("status", { runId: run.id });
          if (current) setRun(value);
        } catch (e) {
          if (current) setError(e.message);
        } finally {
          pending = false;
        }
      };
      const timer = setInterval(poll, 2e3);
      return () => {
        current = false;
        clearInterval(timer);
      };
    }, [run?.id]);
    const close = () => {
      if (busy) return;
      setEdit(null);
      setTarget(null);
      setRun(null);
      setError("");
    };
    function create(preset) {
      setError("");
      const first = data.agents.find((x) => x.selectable)?.metadata.id || "";
      setEdit({ name: preset?.name || "\u6211\u7684\u4E13\u5BB6\u56E2", description: preset?.description || "", instructions: "\u5206\u89E3\u4EFB\u52A1\u3001\u5206\u914D\u6210\u5458\u804C\u8D23\uFF0C\u7B49\u5F85\u5168\u90E8\u62A5\u544A\u540E\u5BA1\u67E5\u5E76\u6C47\u603B\u3002", leadAgentId: first, members: (preset?.roles || [["specialist", "\u4E13\u5BB6\u6210\u5458", "\u72EC\u7ACB\u5B8C\u6210\u5206\u914D\u7684\u4EFB\u52A1\uFF0C\u5411\u4E3B\u7406\u4EBA\u6C47\u62A5\u5B8C\u6574\u7ED3\u679C\u3002"]]).map(([name, label, instructions]) => ({ name, label, instructions, agentId: first })) });
    }
    const change = (key, value) => setEdit({ ...edit, [key]: value });
    const changeMember = (index, key, value) => change("members", edit.members.map((x, i) => i === index ? { ...x, [key]: value } : x));
    const options = data.agents.map((agent) => h("option", { key: agent.metadata.id, value: agent.metadata.id, disabled: !agent.selectable }, agent.metadata.name, agent.selectable ? "" : `\uFF08${agent.metadata.local === false ? "\u4E91\u7AEF" : agent.spec?.runtime?.type || "\u672A\u77E5\u8FD0\u884C\u65F6"}\u6682\u4E0D\u652F\u6301\uFF09`));
    async function save() {
      setBusy(true);
      setError("");
      try {
        await hostRemote.teams("save", edit);
        await load();
        setEdit(null);
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    }
    async function start() {
      if (busy) return;
      setBusy(true);
      setError("");
      requestKey.current ||= crypto.randomUUID();
      try {
        const value = await hostRemote.teams("start", { id: target.id, revision: target.revision, task, requestId: requestKey.current });
        setTarget(null);
        setRun(value);
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    }
    async function openTask(item) {
      setError("");
      setTarget(item);
      setTask("");
      requestKey.current = null;
      setHistory([]);
      try {
        const value = await hostRemote.teams("history", { id: item.id });
        setHistory(value.items);
      } catch (e) {
        setError(e.message);
      }
    }
    const status = (value) => typeof value === "object" ? value.kind || JSON.stringify(value) : value;
    return h(
      "section",
      { className: "sq-team-page", "aria-label": "\u672C\u5730\u4E13\u5BB6\u56E2" },
      h(StudioTeamTemplateGallery, { onCatalog: (items) => setArtwork(Object.fromEntries(items.map((item) => [item.id, item]))), onCreated: (item) => {
        load().catch((e) => setError(e.message));
        void openTask(item);
      } }),
      h("div", { className: "sq-toolbar" }, h("div", null, h("h2", { style: { fontSize: 17, margin: "0 0 7px" } }, "\u6211\u7684\u4E13\u5BB6\u56E2"), h("span", { className: "sq-muted" }, "\u53EC\u5524\u7684\u56E2\u961F\u4FDD\u5B58\u5728\u8FD9\u91CC\uFF0C\u53EF\u7F16\u8F91\u6210\u5458\u3001\u9009\u62E9\u5DF2\u6709\u4E13\u5BB6\u6216\u518D\u6B21\u8FD0\u884C\u3002")), h("button", { className: "sq-btn primary", onClick: () => create() }, "\uFF0B \u81EA\u5B9A\u4E49\u4E13\u5BB6\u56E2")),
      !edit && !target && !run && error ? h("p", { role: "alert", className: "sq-error" }, error) : null,
      h("input", { type: "search", "aria-label": "\u641C\u7D22\u4E13\u5BB6\u56E2", placeholder: "\u641C\u7D22\u4E13\u5BB6\u56E2", value: query, onChange: (e) => setQuery(e.target.value), style: { ...inputStyle(), maxWidth: 350, margin: "0 0 22px" } }),
      h("div", { className: "sq-card-grid" }, data.items.filter((x) => `${x.name} ${x.description}`.includes(query)).map((item) => h("article", { className: "sq-team-card", key: item.id }, h(ui.TemplateArtwork, { item: artwork[item.templateSource?.id] || { id: item.templateSource?.id || item.id, artwork: item.templateSource?.artwork }, kind: "team" }), h("h3", null, item.name), h("p", null, item.description || item.instructions), h("div", { className: "sq-muted" }, `${item.members.length} \u4F4D\u6210\u5458 \xB7 v${item.revision} \xB7 \u672C\u673A\u56E2\u961F`), h("div", { className: "sq-team-actions" }, h("button", { className: "sq-btn", onClick: () => {
        setError("");
        setEdit(structuredClone(item));
      } }, "\u7F16\u8F91\u56E2\u961F"), h("button", { className: "sq-btn primary", onClick: () => openTask(item) }, "\u53EC\u5524\u56E2\u961F"))))),
      !data.items.length ? h("p", { className: "sq-muted" }, "\u5728\u4E0A\u65B9\u9009\u62E9\u6A21\u677F\u5373\u53EF\u53EC\u5524\u6574\u961F\uFF1B\u4E5F\u53EF\u4EE5\u81EA\u5B9A\u4E49\u56E2\u961F\u3002") : null,
      edit || target || run ? h(
        "dialog",
        { ref: dialog, className: "sq-modal", "aria-label": edit ? "\u7F16\u8F91\u4E13\u5BB6\u56E2" : run ? "\u4E13\u5BB6\u56E2\u8FD0\u884C" : "\u53EC\u5524\u4E13\u5BB6\u56E2", onCancel: (e) => {
          e.preventDefault();
          close();
        } },
        h("div", { className: "sq-toolbar" }, h("h2", null, edit ? edit.id ? "\u7F16\u8F91\u4E13\u5BB6\u56E2" : "\u521B\u5EFA\u4E13\u5BB6\u56E2" : run ? run.name : target.name), h("button", { className: "sq-btn", "aria-label": "\u5173\u95ED\u4E13\u5BB6\u56E2\u9762\u677F", disabled: busy, onClick: close }, "\u2715")),
        error ? h("p", { role: "alert", className: "sq-error" }, error) : null,
        edit ? h(
          React.Fragment,
          null,
          h("label", null, "\u56E2\u961F\u540D\u79F0", h("input", { value: edit.name, onChange: (e) => change("name", e.target.value) })),
          h("label", null, "\u56E2\u961F\u7B80\u4ECB", h("input", { value: edit.description, onChange: (e) => change("description", e.target.value) })),
          h("label", null, "\u4E3B\u7406\u4E13\u5BB6", h("select", { "aria-label": "\u4E3B\u7406\u4E13\u5BB6", value: edit.leadAgentId, onChange: (e) => change("leadAgentId", e.target.value) }, h("option", { value: "" }, "\u9009\u62E9\u5DF2\u6709\u4E13\u5BB6"), options)),
          h("label", null, "\u534F\u4F5C\u6307\u4EE4", h("textarea", { value: edit.instructions, onChange: (e) => change("instructions", e.target.value) })),
          h("p", { className: "sq-muted" }, "\u6BCF\u4F4D\u6210\u5458\u4FDD\u7559\u6240\u9009\u4E13\u5BB6\u7684\u5B8C\u6574\u63D0\u793A\u8BCD\u3001Skill\u3001MCP\u3001\u77E5\u8BC6\u5E93\u4E0E\u8BB0\u5FC6\u5E93\u7ED1\u5B9A\u3002\u4E13\u5BB6\u80FD\u529B\u53EF\u5728\u201C\u6211\u7684\u667A\u80FD\u4F53\u201D\u7684\u539F\u7F16\u8F91\u5668\u4E2D\u4FEE\u6539\uFF1B\u8FD0\u884C\u5F00\u59CB\u65F6\u51BB\u7ED3\u7248\u672C\u3002"),
          edit.members.map((member, index) => h("fieldset", { className: "sq-member", key: index, disabled: busy }, h("legend", null, `\u6210\u5458 ${index + 1}`), h("div", { className: "sq-member-row" }, h("label", null, "\u6210\u5458\u540D\u79F0", h("input", { value: member.label, onChange: (e) => changeMember(index, "label", e.target.value) })), h("label", null, "\u82F1\u6587\u6807\u8BC6", h("input", { value: member.name, placeholder: "\u4F8B\u5982 researcher", onChange: (e) => changeMember(index, "name", e.target.value) }))), h("label", null, "\u9009\u62E9\u5DF2\u6709\u4E13\u5BB6", h("select", { "aria-label": "\u9009\u62E9\u5DF2\u6709\u4E13\u5BB6", value: member.agentId, onChange: (e) => changeMember(index, "agentId", e.target.value) }, h("option", { value: "" }, "\u9009\u62E9\u4E13\u5BB6"), options)), h("label", null, "\u56E2\u961F\u4E2D\u7684\u804C\u8D23", h("textarea", { value: member.instructions, onChange: (e) => changeMember(index, "instructions", e.target.value) })), h("button", { className: "sq-btn", disabled: edit.members.length === 1, onClick: () => change("members", edit.members.filter((_, i) => i !== index)) }, "\u79FB\u9664\u6B64\u6210\u5458"))),
          h("button", { className: "sq-btn", disabled: edit.members.length >= 8, onClick: () => change("members", [...edit.members, { name: `member-${edit.members.length + 1}`, label: "\u65B0\u6210\u5458", agentId: "", instructions: "" }]) }, "\uFF0B \u6DFB\u52A0\u6210\u5458"),
          h("div", { className: "sq-sticky" }, h("button", { className: "sq-btn", disabled: busy, onClick: close }, "\u53D6\u6D88"), h("button", { className: "sq-btn primary", disabled: busy, onClick: save }, busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u4E13\u5BB6\u56E2"))
        ) : null,
        target ? h(React.Fragment, null, h("p", { className: "sq-muted" }, `${target.members.length} \u4F4D\u6210\u5458\u5C06\u901A\u8FC7\u5B98\u65B9 Agent Teams \u5404\u81EA\u6267\u884C\u3001\u4E92\u53D1\u6D88\u606F\u5E76\u6C47\u603B\u3002`), h("label", null, "\u8FD9\u6B21\u9700\u8981\u56E2\u961F\u5B8C\u6210\u4EC0\u4E48\uFF1F", h("textarea", { value: task, onChange: (e) => {
          setTask(e.target.value);
          requestKey.current = null;
        }, placeholder: "\u63CF\u8FF0\u4EFB\u52A1\u3001\u4EA4\u4ED8\u7269\u548C\u9A8C\u6536\u8981\u6C42", style: { minHeight: 140 } })), h("div", { className: "sq-sticky" }, h("button", { className: "sq-btn primary", disabled: busy || !task.trim(), onClick: start }, busy ? "\u6B63\u5728\u51C6\u5907\u4E13\u5BB6\u4E0E\u8D44\u6E90\u2026" : "\u5F00\u59CB\u56E2\u961F\u534F\u4F5C")), history.length ? h("div", null, h("h3", null, "\u6700\u8FD1\u8FD0\u884C"), history.slice(0, 8).map((item) => h("button", { key: item.id, className: "sq-btn", style: { display: "block", width: "100%", textAlign: "left", marginBottom: 8 }, onClick: async () => {
          setBusy(true);
          try {
            const value = await hostRemote.teams("resume", { runId: item.id });
            setTarget(null);
            setRun(value);
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        } }, `${new Date(item.createdAt).toLocaleString()} \xB7 v${item.teamRevision} \xB7 ${item.task.slice(0, 60)}`))) : null) : null,
        run ? h(React.Fragment, null, h("p", { className: "sq-muted" }, `\u56E2\u961F v${run.teamRevision} \xB7 ${status(run.status)} \xB7 \u8FD0\u884C\u5728\u672C\u673A`), h("p", null, run.task), run.error ? h("p", { className: "sq-error", role: "alert" }, run.error.message) : null, run.members.map((member) => h("div", { className: "sq-run-member", key: member.id }, h("button", { className: "sq-btn", onClick: () => actions.openSession(member.id) }, run.roles.find((x) => x.name === member.name)?.label || member.name), h("span", { className: "sq-muted" }, member.lastError ? `\u6267\u884C\u5931\u8D25 \xB7 ${member.lastError.code}` : { running: "\u6267\u884C\u4E2D", inactive: "\u7A7A\u95F2", provisioning: "\u51C6\u5907\u4E2D", failed: "\u542F\u52A8\u5931\u8D25" }[member.status] || member.status))), h("h3", { style: { fontSize: 15 } }, "\u5171\u4EAB\u4EFB\u52A1"), !run.tasks.length ? h("p", { className: "sq-muted" }, "\u4E3B\u7406\u4EBA\u6B63\u5728\u7EC4\u7EC7\u4EFB\u52A1\u2026") : null, run.tasks.map((item) => h("div", { className: "sq-run-task", key: item.id }, item.subject, " \xB7 ", { pending: "\u5F85\u5904\u7406", in_progress: "\u8FDB\u884C\u4E2D", completed: "\u5DF2\u5B8C\u6210", deleted: "\u5DF2\u5220\u9664" }[item.status], item.ownerName ? ` \xB7 ${item.ownerName}` : "")), run.output ? h("section", null, h("h3", { style: { fontSize: 15 } }, "\u4E3B\u7406\u4EBA\u7684\u6700\u65B0\u56DE\u590D"), h("div", { className: "sq-result" }, run.output)) : null, h("div", { className: "sq-sticky" }, h("button", { className: "sq-btn", onClick: async () => {
          try {
            setRun(await hostRemote.teams("stop", { runId: run.id }));
          } catch (e) {
            setError(e.message);
          }
        } }, "\u505C\u6B62\u8FD0\u884C"), h("button", { className: "sq-btn primary", onClick: () => actions.openSession(run.sessionId) }, "\u8FDB\u5165\u56E2\u961F\u4F1A\u8BDD"))) : null
      ) : null
    );
  }
  return { StudioTeamTemplateGallery, StudioTeamsPage };
}
export {
  createStudioTeamPages
};
