// @kingsoftcloud/agentkit-harness-ui/markdown — Markdown rendering layer factory
//
// A host-injected-React factory that renders streaming/complete assistant
// Markdown through a statically bundled Streamdown 2.5.0 + @streamdown/cjk
// 1.0.3 pipeline, with a STABLE, independent code block that highlights via
// @shikijs/core 3.23.0 + the JS regex engine + a registered set of common
// languages and two themes — NOT Streamdown's default code renderer — and a
// STABLE, independent Markdown table component (table-factory.mjs, ported from
// the table renderer) that owns the toolbar (copy Markdown / download
// CSV / fullscreen preview / wide-table expand-collapse), the horizontal
// scroll viewport with edge shadows, the hover virtual scrollbar and the
// fullscreen preview dialog — NOT Streamdown's default table renderer.
//
// React, ReactDOM and the JSX runtime are NOT bundled: the build
// (../build/build-markdown.cjs via esbuild) marks `react`, `react-dom` and
// `react/jsx-runtime` external, so the dist CJS `require()`s them from the
// host at runtime. The factory uses ONLY the React/ReactDOM instances passed
// into createMarkdownComponents(), which the host must keep identical to the
// ones resolved by those `require()` calls (see verifyReactInjection).
//
// Streaming vs. complete (desktop MessageResponse / code-block.tsx React #185
// avoidance): while `streaming` is true, code blocks render raw text with no
// async highlighter, and Streamdown runs in `mode="streaming"` with
// `parseIncompleteMarkdown`. When `streaming` flips false, the stable CodeBlock
// highlights the (now stable) source. No timer fakes text; no setState races
// between the streaming body and the highlighter.
//
// No eval / new Function; no Studio/DSH/Node-only imports at runtime; no wasm;
// no oniguruma; no second React copy.

import { Streamdown, defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import { cjk as cjkPlugin } from "@streamdown/cjk";
import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import githubLight from "@shikijs/themes/github-light";
import githubDark from "@shikijs/themes/github-dark";
import langJavascript from "@shikijs/langs/javascript";
import langTypescript from "@shikijs/langs/typescript";
import langJsx from "@shikijs/langs/jsx";
import langTsx from "@shikijs/langs/tsx";
import langJson from "@shikijs/langs/json";
import langPython from "@shikijs/langs/python";
import langShellscript from "@shikijs/langs/shellscript";
import langCss from "@shikijs/langs/css";
import langHtml from "@shikijs/langs/html";
import langMarkdown from "@shikijs/langs/markdown";
import langYaml from "@shikijs/langs/yaml";
import langSql from "@shikijs/langs/sql";
import langGo from "@shikijs/langs/go";
import langRust from "@shikijs/langs/rust";
import langDiff from "@shikijs/langs/diff";
import langJava from "@shikijs/langs/java";
import langBash from "@shikijs/langs/bash";

import { createMarkdownTableComponents } from "./table-factory.mjs";

const LIGHT_THEME = "github-light";
const DARK_THEME = "github-dark";

// Registered grammars. Unknown languages fall back to plain text (no
// highlighting) so the bundle stays bounded — only these grammars ship.
const REGISTERED_LANGS = {
  javascript: langJavascript,
  typescript: langTypescript,
  jsx: langJsx,
  tsx: langTsx,
  json: langJson,
  python: langPython,
  shellscript: langShellscript,
  css: langCss,
  html: langHtml,
  markdown: langMarkdown,
  yaml: langYaml,
  sql: langSql,
  go: langGo,
  rust: langRust,
  diff: langDiff,
  java: langJava,
  bash: langBash,
};

// Aliases map to a registered id. Anything not here and not a registered id
// resolves to plaintext.
const LANG_ALIASES = {
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  ts: "typescript",
  py: "python",
  sh: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  "sh-session": "shellscript",
  console: "shellscript",
  bash: "bash",
  md: "markdown",
  yml: "yaml",
  rs: "rust",
  htm: "html",
};

const LINK_SAFETY = { enabled: false };
// Streamdown's default `table` component renders its own copy/download/
// fullscreen toolbar (the `vo` wrapper). The table component override below
// replaces that renderer entirely, so the default table controls are turned
// off here as well for clarity (and so they cannot reappear if a future
// Streamdown version invokes the default wrapper from another path).
const STREAMDOWN_CONTROLS = { table: false };

const DEFAULT_LABELS = {
  copyCode: "Copy code",
  copied: "Copied",
  wrapLines: "Wrap",
  languageLabel: "text",
  // Markdown table labels — ported from the Chinese locale
  // (packages/ui/src/i18n/locales/zh-CN.ts, markdownTable.*). Hosts override
  // per locale through the `labels` prop on MarkdownResponse.
  copyMarkdown: "复制 Markdown",
  downloadCsv: "下载 CSV",
  openPreview: "预览表格",
  expandScrollMode: "展开表格滚动区域",
  collapseScrollMode: "收回表格滚动区域",
  previewTitle: "表格预览",
  previewDescription: "在更大的可滚动视图中查看表格。",
  copySucceeded: "已复制 Markdown 表格",
  copyFailed: "复制表格失败：{error}",
  downloadFailed: "下载表格失败",
  closePreview: "关闭",
};

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function extractText(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isObject(node) && isObject(node.props)) return extractText(node.props.children);
  return "";
}

function resolveCodeLanguage(className) {
  if (typeof className !== "string") return "";
  const match = className.match(/(?:^|\s)language-([^\s]+)/);
  return match ? match[1] : "";
}

function resolveLangId(language) {
  const norm = String(language || "").trim().toLowerCase();
  if (!norm) return "";
  if (REGISTERED_LANGS[norm]) return norm;
  const alias = LANG_ALIASES[norm];
  if (alias && REGISTERED_LANGS[alias]) return alias;
  return "";
}

function resolveEffectiveTheme(theme, prefersDark) {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return prefersDark ? "dark" : "light";
}

function readPrefersDark() {
  if (typeof window !== "object" || typeof window.matchMedia !== "function") return false;
  try {
    return Boolean(window.matchMedia("(prefers-color-scheme: dark)").matches);
  } catch {
    return false;
  }
}

function isExternalHref(href) {
  if (typeof href !== "string") return false;
  return /^https?:\/\//i.test(href);
}

// Bare relative file paths like `src/a.ts` or `README.md` are not known URL
// schemes, so rehype-harden (in Streamdown's default rehype plugins) replaces
// them with `[blocked]` before the custom `a` renderer runs. The desktop
// MessageResponse fixes this with a rehype plugin that normalizes such hrefs
// to `./…` before harden; this is the minimal equivalent. `./`, `/`, `../`,
// `#…` and scheme-prefixed hrefs are left alone.
function shouldRewriteBareFileHref(href) {
  if (typeof href !== "string" || !href) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  if (href.startsWith("#") || href.startsWith("/") || href.startsWith("./") || href.startsWith("../")) return false;
  return /\.[^./\\]+$/.test(href) || href.includes("/") || href.includes("\\");
}

function rewriteBareFileLinkRehypePlugin() {
  return (tree) => {
    const visit = (node) => {
      if (node && node.type === "element") {
        const tag = node.tagName;
        const prop = tag === "a" ? "href" : tag === "img" ? "src" : null;
        if (prop && node.properties && typeof node.properties[prop] === "string") {
          const href = node.properties[prop];
          if (tag === "a" && routeLink(href) === "file") node.properties["data-native-file-href"] = href;
          if (shouldRewriteBareFileHref(href)) node.properties[prop] = "./" + href;
        }
      }
      if (node && Array.isArray(node.children)) node.children.forEach(visit);
    };
    visit(tree);
  };
}

// Classify a link target for the `a` override. External http/https → "external";
// anything with a scheme (mailto:, tel:, javascript:, data:, …) or an anchor →
// "muted"; a bare/relative path or filename → "file". Hosts that supply
// onOpenFileLink get clickable file links; nothing untrusted gets a native <a>.
function routeLink(href) {
  if (typeof href !== "string" || href === "") return "muted";
  if (isExternalHref(href)) return "external";
  if (href.startsWith("#")) return "muted";
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return "muted";
  return "file";
}

// shiki dual-theme tokens carry light color in `htmlStyle.color` and the dark
// color in `htmlStyle["--shiki-dark"]`; the bg/fg strings are
// `"#light;--shiki-dark-bg:#dark"`. We remap color→--sdm-c and
// background-color→--sdm-tbg so CSS can switch with the wrapper theme without
// fighting inline `color` (which would otherwise win in both themes).
function tokenStyle(token) {
  const hs = token && token.htmlStyle ? token.htmlStyle : {};
  const style = {};
  for (const key of Object.keys(hs)) {
    const value = hs[key];
    if (key === "color") style["--sdm-c"] = value;
    else if (key === "background-color") style["--sdm-tbg"] = value;
    else style[key] = value;
  }
  return style;
}

function applyDual(style, prefix, combined) {
  if (!combined) return;
  const parts = String(combined).split(";");
  if (parts[0]) style[prefix] = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const idx = parts[i].indexOf(":");
    if (idx > 0) style[parts[i].slice(0, idx).trim()] = parts[i].slice(idx + 1).trim();
  }
}

// Singleton highlighter promise. createHighlighterCore is async even with
// statically-imported grammars/themes, so we init once and await in the
// CodeBlock effect. The JS regex engine is synchronous once loaded, so
// codeToTokens never races the render.
let highlighterPromise = null;
function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      langs: Object.values(REGISTERED_LANGS),
      themes: [githubLight, githubDark],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

/**
 * Build the Markdown React components from host-injected React/ReactDOM.
 *
 *   const { MarkdownResponse } = createMarkdownComponents(React, ReactDOM);
 *   renderText={(text, { streaming }) =>
 *     React.createElement(MarkdownResponse, { streaming }, text)}
 *
 * The bundle's only external `require()`s are `react`, `react-dom` and
 * `react/jsx-runtime` (see ../build/build-markdown.cjs). The host must keep
 * those resolved instances identical to the React/ReactDOM passed here.
 *
 * @param {object} React  Host React (createElement + hooks).
 * @param {object} [ReactDOM] Host ReactDOM (Streamdown's bundled code
 *   requires react-dom for portal-based controls; the host injects it via the
 *   external require).
 * @returns {{ MarkdownResponse: object, Markdown: object, cjkPlugin: unknown, registeredLanguages: string[] }}
 */
export function createMarkdownComponents(React, ReactDOM) {
  if (!isObject(React) || typeof React.createElement !== "function") {
    throw new TypeError("createMarkdownComponents: React.createElement is required");
  }
  const { createElement, useState, useCallback, useEffect, useMemo, useRef, createContext, useContext } = React;

  // Context carries the per-message values the stable CodeBlock needs but that
  // Streamdown's `pre` wrapper (which only adds `data-block`) cannot forward.
  const CodeBlockContext = createContext(null);
  const useCodeBlockContext = () => useContext(CodeBlockContext);

  function MarkdownLink(props) {
    const { href, children, className, node: _node, onOpenExternalUrl, onOpenFileLink, "data-native-file-href": originalHref, ...rest } = props;
    const target = typeof originalHref === "string" ? originalHref : typeof href === "string" ? href : "";
    const kind = routeLink(target);
    const handleClick = useCallback(
      (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        if (kind === "external" && typeof onOpenExternalUrl === "function") onOpenExternalUrl(target);
        else if (kind === "file" && typeof onOpenFileLink === "function") {
          onOpenFileLink({ href: target, label: extractText(children) });
        }
      },
      [kind, target, onOpenExternalUrl, onOpenFileLink, children],
    );
    if (kind === "external" && typeof onOpenExternalUrl === "function") {
      return createElement(
        "button",
        { type: "button", className: `ks-md-link ${className || ""}`.trim(), title: target, onClick: handleClick },
        children,
      );
    }
    if (kind === "file" && typeof onOpenFileLink === "function") {
      return createElement(
        "button",
        { type: "button", className: `ks-md-link ks-md-file-link ${className || ""}`.trim(), title: target, onClick: handleClick },
        children,
      );
    }
    return createElement(
      "span",
      { className: `ks-md-link-muted ${className || ""}`.trim(), title: target || undefined },
      children,
    );
  }

  function MarkdownCopyButton(props) {
    const { code, labels, onCopyCode } = props;
    const [copied, setCopied] = useState(false);
    const timerRef = useRef(null);
    useEffect(
      () => () => {
        if (timerRef.current && typeof clearTimeout === "function") clearTimeout(timerRef.current);
      },
      [],
    );
    const handleClick = useCallback(async () => {
      let handled = false;
      if (typeof onCopyCode === "function") {
        try { await onCopyCode(code); handled = true; } catch { handled = false; }
      } else if (typeof navigator === "object" && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        try { await navigator.clipboard.writeText(code); handled = true; } catch { handled = false; }
      }
      if (handled) {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 2000);
      }
    }, [code, onCopyCode]);
    return createElement(
      "button",
      {
        type: "button",
        className: "ks-md-copy",
        "aria-label": copied ? labels.copied : labels.copyCode,
        "data-copied": copied ? "true" : "false",
        onClick: handleClick,
      },
      copied ? labels.copied : labels.copyCode,
    );
  }

  // Stable, independent code block (desktop code-block.tsx / code-viewer.tsx
  // semantics). Raw text while streaming or before the highlighter resolves;
  // shiki tokens when complete. The wrap toggle is local presentation state;
  // copy goes through the host callback or navigator.clipboard.
  function MarkdownCodeBlock(props) {
    const { code, language, streaming, theme, wrapLongLines, labels, onCopyCode } = props;
    const [highlight, setHighlight] = useState(null);
    const tokens = !streaming && highlight?.code === code && highlight?.language === language ? highlight.tokens : null;
    const [wrapped, setWrapped] = useState(Boolean(wrapLongLines));
    useEffect(() => { setWrapped(Boolean(wrapLongLines)); }, [wrapLongLines]);
    useEffect(() => {
      if (streaming) { setHighlight(null); return; }
      const langId = resolveLangId(language);
      if (!langId) { setHighlight(null); return; }
      let cancelled = false;
      getHighlighter().then((h) => {
        if (cancelled) return;
        try {
          const result = h.codeToTokens(code, {
            lang: langId,
            themes: { light: LIGHT_THEME, dark: DARK_THEME },
          });
          if (!cancelled) setHighlight({ code, language, tokens: result });
        } catch {
          if (!cancelled) setHighlight(null);
        }
      }).catch(() => { if (!cancelled) setHighlight(null); });
      return () => { cancelled = true; };
    }, [code, language, streaming]);

    const toggleWrap = useCallback(() => setWrapped((v) => !v), []);
    const langId = resolveLangId(language);
    const displayLang = language || labels.languageLabel;

    const bodyChildren = [];
    if (tokens && tokens.tokens) {
      tokens.tokens.forEach((line, lineIdx) => {
        if (lineIdx > 0) bodyChildren.push("\n");
        if (line.length === 0) return;
        line.forEach((tok, tokIdx) => {
          bodyChildren.push(
            createElement("span", { key: `${lineIdx}-${tokIdx}`, className: "ks-md-token", style: tokenStyle(tok) }, tok.content),
          );
        });
      });
    } else {
      bodyChildren.push(code);
    }
    const bodyStyle = {};
    if (tokens && tokens.bg) applyDual(bodyStyle, "--sdm-bg", tokens.bg);
    if (tokens && tokens.fg) applyDual(bodyStyle, "--sdm-fg", tokens.fg);

    return createElement(
      "div",
      {
        className: "ks-md-code",
        "data-language": displayLang,
        "data-streaming": streaming ? "true" : "false",
        "data-highlighted": tokens ? "true" : "false",
      },
      createElement(
        "div",
        { className: "ks-md-code-header" },
        createElement("span", { className: "ks-md-code-lang" }, displayLang),
        createElement(
          "span",
          { className: "ks-md-code-actions" },
          createElement(
            "button",
            {
              type: "button",
              className: "ks-md-wrap",
              "aria-label": labels.wrapLines,
              "aria-pressed": wrapped ? "true" : "false",
              "data-wrapped": wrapped ? "true" : "false",
              onClick: toggleWrap,
            },
            labels.wrapLines,
          ),
          createElement(MarkdownCopyButton, { code, labels, onCopyCode }),
        ),
      ),
      createElement(
        "pre",
        { className: `ks-md-pre ${wrapped ? "ks-md-pre-wrap" : ""}`.trim(), style: bodyStyle },
        createElement("code", null, bodyChildren),
      ),
    );
  }

  // `code` override (desktop message.tsx ~1535-1582): inline code renders a
  // bare <code>; block code (detected via the `data-block` flag Streamdown's
  // `pre` renderer adds) routes to the stable CodeBlock using the per-message
  // context. This disables Streamdown's default code renderer (and its async
  // highlighter), which is what avoids React #185.
  function codeComponent(props) {
    const { children, className, node: _node, ...rest } = props;
    const ctx = useCodeBlockContext() || {};
    const isBlock = "data-block" in rest;
    if (!isBlock) {
      return createElement(
        "code",
        { className: `ks-md-inline-code ${className || ""}`.trim() },
        children,
      );
    }
    const codeText = extractText(children).replace(/\n+$/, "");
    const language = resolveCodeLanguage(className);
    return createElement(MarkdownCodeBlock, {
      code: codeText,
      language,
      streaming: ctx.streaming === true,
      wrapLongLines: ctx.wrapLongLines === true,
      theme: ctx.theme,
      labels: ctx.labels || DEFAULT_LABELS,
      onCopyCode: ctx.onCopyCode,
    });
  }

  function buildComponents(opts) {
    const { onOpenExternalUrl, onOpenFileLink, renderImage, tableSlots } = opts;
    return {
      img: ({ src, alt, title }) => typeof renderImage === "function"
        ? renderImage({ src, alt, title })
        : createElement("span", { role: "img", "aria-label": alt || "Image", title: src }, alt || "Image"),
      code: codeComponent,
      a: (props) =>
        createElement(MarkdownLink, { ...props, onOpenExternalUrl, onOpenFileLink }),
      // Custom table renderer + parts (table-factory.mjs). Replaces Streamdown's
      // default `table` wrapper and its built-in copy/download/fullscreen toolbar.
      table: tableSlots.table,
      thead: tableSlots.thead,
      tbody: tableSlots.tbody,
      tr: tableSlots.tr,
      th: tableSlots.th,
      td: tableSlots.td,
    };
  }

  function MarkdownResponse(props) {
    const {
      children,
      streaming = false,
      theme = "system",
      scopeKey = "",
      wrapLongLines = false,
      showLineNumbers = false,
      className,
      labels,
      onCopyCode,
      onNotify,
      onOpenExternalUrl,
      onOpenFileLink,
      renderImage,
    } = props || {};
    // Memoize so the table slots and code-block context stay referentially
    // stable across renders when the host keeps `labels` stable.
    const mergedLabels = useMemo(() => ({ ...DEFAULT_LABELS, ...(labels || {}) }), [labels]);
    const markdown = typeof children === "string" ? children : extractText(children);
    const [prefersDark, setPrefersDark] = useState(readPrefersDark);
    useEffect(() => {
      if (typeof window !== "object" || typeof window.matchMedia !== "function") return;
      const query = window.matchMedia("(prefers-color-scheme: dark)");
      const update = () => setPrefersDark(Boolean(query.matches));
      update();
      if (typeof query.addEventListener === "function") {
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
      }
      query.addListener(update);
      return () => query.removeListener(update);
    }, []);
    const effective = resolveEffectiveTheme(theme, prefersDark);
    const tableSlots = useMemo(
      () => createMarkdownTableComponents(React, ReactDOM, { labels: mergedLabels, onNotify, theme: effective }),
      [mergedLabels, onNotify, effective],
    );
    const components = useMemo(
      () => buildComponents({ onOpenExternalUrl, onOpenFileLink, renderImage, tableSlots }),
      [onOpenExternalUrl, onOpenFileLink, renderImage, tableSlots],
    );
    const codeBlockCtx = useMemo(
      () => ({ streaming, wrapLongLines, theme: effective, labels: mergedLabels, onCopyCode }),
      [streaming, wrapLongLines, effective, mergedLabels, onCopyCode],
    );
    const wrapperClass = ["ks-markdown", `ks-theme-${effective}`, className || ""]
      .filter(Boolean)
      .join(" ");
    return createElement(
      CodeBlockContext.Provider,
      { value: codeBlockCtx },
      createElement(
        "div",
        {
          className: wrapperClass,
          "data-streaming": streaming ? "true" : "false",
          "data-theme": effective,
        },
        createElement(
          Streamdown,
          {
            key: `${effective}:${scopeKey}`,
            mode: streaming ? "streaming" : "static",
            parseIncompleteMarkdown: streaming,
            components,
            plugins: { cjk: cjkPlugin },
            controls: STREAMDOWN_CONTROLS,
            linkSafety: LINK_SAFETY,
            animated: false,
            isAnimating: false,
            lineNumbers: showLineNumbers,
            rehypePlugins: [defaultRehypePlugins.raw, defaultRehypePlugins.sanitize, rewriteBareFileLinkRehypePlugin, defaultRehypePlugins.harden],
            remarkPlugins: Object.values(defaultRemarkPlugins),
          },
          markdown,
        ),
      ),
    );
  }

  return {
    MarkdownResponse,
    Markdown: MarkdownResponse,
    cjkPlugin,
    registeredLanguages: Object.keys(REGISTERED_LANGS),
  };
}

/**
 * Dev-time guard: confirms the host's resolved `react` matches the React the
 * caller passed in, so Streamdown's internal `require("react")` and the
 * factory's injected React are the same instance (no second React copy).
 * Throws on mismatch. Pass the host's `require` (or `createRequire`).
 *
 * @param {object} React  The React instance passed to createMarkdownComponents.
 * @param {(id: string) => any} [requireFn]  Host require; omit to skip.
 */
export function verifyReactInjection(React, requireFn) {
  if (typeof requireFn !== "function") return;
  let resolved;
  try { resolved = requireFn("react"); } catch { return; }
  if (!resolved) return;
  const sameCreateElement = React.createElement === resolved.createElement;
  const sameHook = React.useState === resolved.useState;
  if (!sameCreateElement || !sameHook) {
    throw new Error(
      "createMarkdownComponents: the injected React does not match the host's require('react'). " +
        "A second React copy would break Streamdown's JSX runtime. Ensure the host resolves a single react instance.",
    );
  }
}
