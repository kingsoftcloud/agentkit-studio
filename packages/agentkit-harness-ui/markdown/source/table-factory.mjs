// Independent Markdown table controls. React and portals are supplied by the host.
// Third-party attribution is retained in NOTICE.

const MARKDOWN_TABLE_ROOT_SELECTOR =
  '[data-markdown-table-layout-root="true"], [data-testid="chat-view"]';
const MARKDOWN_TABLE_STICKY_DISABLED_SELECTOR = '[data-markdown-table-sticky-scrollbar="disabled"]';
const MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR = '[data-v4-composer-dock="true"]';
const MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_SELECTOR =
  '[data-v4-back-to-bottom-anchor="composer-dock"] button';
const MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_GAP_PX = 8;
const MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX = 32;
const MARKDOWN_TABLE_CONTENT_PADDING_LG_PX = 16;
const MARKDOWN_TABLE_CONTENT_PADDING_MD_PX = 8;
const MARKDOWN_TABLE_STICKY_SCROLLBAR_HEIGHT_RATIO = 0.8;
const MARKDOWN_TABLE_LAYOUT_LEFT_INSET_PROPERTY = "--markdown-table-layout-left-inset";
const MARKDOWN_TABLE_LAYOUT_RIGHT_INSET_PROPERTY = "--markdown-table-layout-right-inset";

function normalizeTableCellText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeMarkdownTableCell(value) {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function escapeCsvCell(value) {
  // assistant markdown is untrusted input; CSV opened in Excel/Numbers/LibreOffice
  // interprets formula prefixes. Downgrade formula-shaped cells to plain text
  // before download (mirrors upstream mitigation).
  const safeValue = /^[\t\r\n]/u.test(value) || /^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value;

  if (!/[",\r\n]/u.test(safeValue)) {
    return safeValue;
  }

  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function buildMarkdownTableText(rows) {
  if (rows.length === 0) {
    return "";
  }

  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => escapeMarkdownTableCell(row[index] ?? "")),
  );
  const header = normalizedRows[0] ?? [];
  const separator = Array.from({ length: columnCount }, () => "---");
  const body = normalizedRows.slice(1);

  return [header, separator, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

export function buildCsvTableText(rows) {
  const csv = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\r\n");
  // Blob's charset is not written into the file bytes; Excel parses BOM-less
  // UTF-8 CSV by the local code page, mangling CJK. Prefix a UTF-8 BOM so
  // spreadsheet apps reliably detect the encoding.
  return `﻿${csv}`;
}

function readRowsFromTable(table) {
  if (!table) {
    return [];
  }

  return Array.from(table.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th,td")).map((cell) =>
        normalizeTableCellText(cell.textContent ?? ""),
      ),
    )
    .filter((row) => row.length > 0);
}

function resolveMarkdownTableRoot(frame, fallbackRoot) {
  // The layout root is the explicit boundary (V4) or the legacy chat-view; the
  // table falls back to its own width when neither is present, so enhanced
  // horizontal scroll never over-promises available space.
  return frame?.closest?.(MARKDOWN_TABLE_ROOT_SELECTOR) ?? fallbackRoot;
}

function getMarkdownTableContentInlineInsetPx() {
  if (typeof window === "undefined") {
    return MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX;
  }

  // Borrowing the chat root's right space must subtract the message column's
  // responsive right padding (ChatConversationContent px-8 max-lg:px-4 max-md:px-2).
  if (window.innerWidth < 768) {
    return MARKDOWN_TABLE_CONTENT_PADDING_MD_PX;
  }

  if (window.innerWidth < 1024) {
    return MARKDOWN_TABLE_CONTENT_PADDING_LG_PX;
  }

  return MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX;
}

function getMarkdownTableRootInlineInsets(root) {
  if (typeof window !== "undefined" && root.matches?.('[data-markdown-table-layout-root="true"]')) {
    return {
      leftInset: readCssPixelValue(root, MARKDOWN_TABLE_LAYOUT_LEFT_INSET_PROPERTY),
      rightInset: readCssPixelValue(root, MARKDOWN_TABLE_LAYOUT_RIGHT_INSET_PROPERTY),
    };
  }

  const legacyInset = getMarkdownTableContentInlineInsetPx();
  return { leftInset: legacyInset, rightInset: legacyInset };
}

function readMarkdownTableObservedRect(element) {
  if (!element) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    width: Math.round(rect.width),
  };
}

function isMarkdownTableObservedRectEqual(leftRect, rightRect) {
  return (
    leftRect?.left === rightRect?.left &&
    leftRect?.right === rightRect?.right &&
    leftRect?.width === rightRect?.width
  );
}

function readCssPixelValue(element, propertyName) {
  if (!element || typeof window === "undefined") {
    return 0;
  }

  const value = window.getComputedStyle(element).getPropertyValue(propertyName);
  const parsedValue = Number.parseFloat(value);
  return Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0;
}

function readMarkdownTableDockHeight(root) {
  const legacyDockHeight = readCssPixelValue(root, "--chat-bottom-dock-height");
  if (legacyDockHeight > 0) return legacyDockHeight;

  // V4 composer dock lives inside the timeline scroll viewport but no longer
  // sets the legacy ChatView CSS variable; read the real dock height so the
  // sticky scrollbar is not covered by the input area.
  return (
    root?.querySelector?.(MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR)?.getBoundingClientRect().height ?? 0
  );
}

function readMarkdownTableBackToBottomClearance(root) {
  const button = root?.querySelector?.(MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_SELECTOR);
  if (!button) return 0;

  return button.getBoundingClientRect().height + MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_GAP_PX;
}

function resolveMarkdownTableVerticalViewport(element, fallbackRoot) {
  if (typeof window === "undefined") {
    return fallbackRoot;
  }

  let currentElement = element?.parentElement ?? null;
  while (currentElement) {
    const style = window.getComputedStyle(currentElement);
    const canScrollY = /auto|scroll|overlay/u.test(style.overflowY);
    // A horizontal overflow-x-auto viewport may make the browser compute
    // overflow-y as auto; without confirming real vertical scroll range a short
    // table would mistake its own height for the viewport and the 80% rule
    // would always be true.
    const hasVerticalScrollRange = currentElement.scrollHeight > currentElement.clientHeight + 1;
    if (canScrollY && currentElement.clientHeight > 0 && hasVerticalScrollRange) {
      return currentElement;
    }
    currentElement = currentElement.parentElement;
  }

  return fallbackRoot;
}

export function resolveMarkdownTableStickyScrollbarMode({
  stickyScrollbarDisabled,
  viewportHeight,
  dockHeight,
  tableHeight,
}) {
  if (stickyScrollbarDisabled) {
    return false;
  }

  const visibleHeight = Math.max(0, viewportHeight - dockHeight);
  return (
    visibleHeight > 0 && tableHeight > visibleHeight * MARKDOWN_TABLE_STICKY_SCROLLBAR_HEIGHT_RATIO
  );
}

export function resolveMarkdownTableStickyScrollbarOffset({
  frameTop,
  frameBottom,
  scrollbarHeight,
  viewportBottom,
}) {
  const minimumBottom = Math.min(frameBottom, frameTop + Math.max(0, scrollbarHeight));
  const pinnedBottom = Math.min(frameBottom, Math.max(minimumBottom, viewportBottom));
  return Math.min(0, pinnedBottom - frameBottom);
}

function shouldUseMarkdownTableStickyScrollbar({ root, table }) {
  if (!table) {
    return false;
  }

  const viewport = resolveMarkdownTableVerticalViewport(table, root);
  const viewportHeight =
    viewport?.clientHeight ||
    viewport?.getBoundingClientRect().height ||
    (typeof window === "undefined" ? 0 : window.innerHeight);
  const dockHeight = readMarkdownTableDockHeight(root);
  const tableHeight = table.getBoundingClientRect().height;

  // Sub-agent prompt/output inherits the conversation dock height; if sticky
  // were enabled there too the virtual scrollbar would float up into the
  // middle of the table inside a nested container. Explicit opt-out does not
  // depend on whether the container currently has vertical overflow.
  return resolveMarkdownTableStickyScrollbarMode({
    stickyScrollbarDisabled: table.closest?.(MARKDOWN_TABLE_STICKY_DISABLED_SELECTOR) !== null,
    viewportHeight,
    dockHeight,
    tableHeight,
  });
}

export function resolveMarkdownTableFrameDistances({
  frameWidth,
  frameLeft,
  frameRight,
  rootLeft,
  rootRight,
  leftInset = 0,
  rightInset = 0,
}) {
  const leftDistance = Math.max(0, frameLeft - rootLeft);
  const rightDistance = Math.max(0, rootRight - frameRight);
  const maxLeftOffset = Math.max(0, leftDistance - leftInset);
  const scrollbarWidth = Math.max(0, frameWidth + rightDistance - rightInset);

  return {
    leftDistance,
    maxLeftOffset,
    scrollbarWidth,
    rightDistance,
    maxViewportWidth: scrollbarWidth,
  };
}

export function resolveMarkdownTableVirtualScrollbarMetrics({
  scrollLeft,
  scrollMax,
  tableWidth,
  trackWidth,
}) {
  const safeTableWidth = Math.max(0, tableWidth);
  const safeTrackWidth = Math.max(0, trackWidth);
  const safeScrollMax = Math.max(0, scrollMax);
  const contentWidth = Math.max(safeTrackWidth, safeTableWidth);

  if (safeTrackWidth <= 0 || safeScrollMax <= 1 || safeTableWidth <= safeTrackWidth) {
    return {
      contentWidth: safeTrackWidth,
      thumbLeft: 0,
      thumbWidth: safeTrackWidth,
    };
  }

  const thumbWidth = Math.min(
    safeTrackWidth,
    Math.max(0, safeTrackWidth * (safeTrackWidth / safeTableWidth)),
  );
  const maxThumbLeft = Math.max(0, safeTrackWidth - thumbWidth);
  const thumbLeft = Math.min(
    maxThumbLeft,
    Math.max(0, Math.max(0, scrollLeft) * (safeTrackWidth / safeTableWidth)),
  );

  return {
    contentWidth,
    thumbLeft,
    thumbWidth,
  };
}

export function resolveMarkdownTableVirtualScrollMax({ tableWidth, trackWidth }) {
  return Math.max(0, tableWidth - trackWidth);
}

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function formatTemplate(template, error) {
  return String(template || "").replace("{error}", error == null ? "" : String(error));
}

/**
 * Build the Markdown table React components from host-injected React/ReactDOM.
 * The returned `table`/`thead`/`tbody`/`tr`/`th`/`td` components replace
 * Streamdown's default table renderer (and its copy/download/fullscreen
 * toolbar) so the layer owns the full table interaction surface.
 *
 * @param {object} React     Host React (createElement + hooks).
 * @param {object} ReactDOM  Host ReactDOM (createPortal for the fullscreen dialog).
 * @param {object} options
 * @param {object} options.labels  Resolved label strings (copyMarkdown, …).
 * @param {(msg: {message: string, kind: "success"|"error"}) => void} [options.onNotify]
 *   Optional host toast hook; when absent an inline aria-live status region
 *   is rendered instead (copy/download never report success on failure).
 * @returns {{ table: Function, thead: Function, tbody: Function, tr: Function, th: Function, td: Function }}
 */
export function createMarkdownTableComponents(React, ReactDOM, options) {
  const {
    createElement,
    useState,
    useCallback,
    useEffect,
    useRef,
    useLayoutEffect,
    useId,
  } = React;
  const opts = options || {};
  const labels = opts.labels || {};
  const onNotify = typeof opts.onNotify === "function" ? opts.onNotify : null;
  // Effective theme ("light" | "dark"); applied to the portaled dialog overlay
  // so its tokens resolve outside the .ks-markdown scope.
  const theme = opts.theme === "dark" || opts.theme === "light" ? opts.theme : null;
  const createPortal =
    ReactDOM && typeof ReactDOM.createPortal === "function" ? ReactDOM.createPortal : null;
  // React 18 useId generates stable unique ids for the dialog's aria-labelledby
  // / aria-describedby pair; fall back to static ids if the host React predates
  // useId (the dialog is rare to open twice simultaneously, but unique ids keep
  // the a11y tree valid when it does).
  const useDialogId = typeof useId === "function" ? useId : null;

  // useLayoutEffect is a no-op on the server; fall back to useEffect during SSR
  // (renderToStaticMarkup) so no warning fires and measurements simply defer to
  // the client, where they belong.
  const useIsoLayoutEffect =
    typeof window !== "undefined" && typeof useLayoutEffect === "function"
      ? useLayoutEffect
      : useEffect;

  // ── inline SVG icons (lucide not resolvable from the factory bundle) ───────

  function svgBase(children) {
    return createElement(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: 14,
        height: 14,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
      },
      children,
    );
  }

  function CopyIcon() {
    return svgBase([
      createElement("rect", { key: "r", width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }),
      createElement("path", {
        key: "p",
        d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
      }),
    ]);
  }

  function DownloadIcon() {
    return svgBase([
      createElement("path", { key: "p", d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }),
      createElement("polyline", { key: "l1", points: "7 10 12 15 17 10" }),
      createElement("line", { key: "l2", x1: 12, y1: 15, x2: 12, y2: 3 }),
    ]);
  }

  function MaximizeIcon() {
    return svgBase([
      createElement("polyline", { key: "p1", points: "15 3 21 3 21 9" }),
      createElement("polyline", { key: "p2", points: "9 21 3 21 3 15" }),
      createElement("line", { key: "l1", x1: 21, y1: 3, x2: 14, y2: 10 }),
      createElement("line", { key: "l2", x1: 3, y1: 21, x2: 10, y2: 14 }),
    ]);
  }

  // Expand (collapsed state): arrow pointing right toward a vertical line on
  // the right → "extend scroll area toward the boundary".
  function ExpandScrollIcon() {
    return svgBase([
      createElement("line", { key: "v", x1: 19, y1: 6, x2: 19, y2: 18 }),
      createElement("line", { key: "h", x1: 5, y1: 12, x2: 15, y2: 12 }),
      createElement("polyline", { key: "ah", points: "11 8 15 12 11 16" }),
    ]);
  }

  // Collapse (expanded state): arrow pointing left away from the vertical line
  // on the right → "pull back to the normal scroll range".
  function CollapseScrollIcon() {
    return svgBase([
      createElement("line", { key: "v", x1: 19, y1: 6, x2: 19, y2: 18 }),
      createElement("line", { key: "h", x1: 5, y1: 12, x2: 15, y2: 12 }),
      createElement("polyline", { key: "ah", points: "9 8 5 12 9 16" }),
    ]);
  }

  function CloseIcon() {
    return svgBase([
      createElement("line", { key: "l1", x1: 18, y1: 6, x2: 6, y2: 18 }),
      createElement("line", { key: "l2", x1: 6, y1: 6, x2: 18, y2: 18 }),
    ]);
  }

  // ── toolbar action button (ghost icon button + CSS tooltip via data-tip) ──

  function MarkdownTableActionButton({ label, onClick, children, pressed }) {
    return createElement(
      "button",
      {
        type: "button",
        className: "ks-md-table-btn",
        "aria-label": label,
        "aria-pressed": pressed == null ? undefined : pressed ? "true" : "false",
        "data-tip": label,
        onClick,
      },
      children,
    );
  }

  // ── edge shadow (left/right inset shadow when content overflows) ───────────

  function MarkdownTableEdgeShadow({ side, state }) {
    const visible = state === side || state === "both";
    if (!visible) {
      return null;
    }
    return createElement("div", {
      "aria-hidden": "true",
      className: "ks-md-table-edge-shadow",
      "data-side": side,
      "data-markdown-table-edge-shadow": side,
    });
  }

  // ── fullscreen preview dialog (portal; replaces Radix Dialog) ─────────────

  function MarkdownTablePreviewDialog({ open, onClose, title, description, tableClassName, children, tableProps, dialogTheme }) {
    const titleId = useDialogId ? useDialogId() : "ks-md-table-preview-title";
    const descId = useDialogId ? useDialogId() : "ks-md-table-preview-desc";
    const dialogRef = useRef(null), closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
      if (!open) return undefined;
      if (typeof window === "undefined") return undefined;
      const previousFocus = document.activeElement;
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      const focusables = () => Array.from(dialogRef.current?.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])') ?? [])
        .filter(element => element.getClientRects().length > 0);
      const focusFirst = () => (focusables()[0] ?? dialogRef.current)?.focus();
      focusFirst();
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeRef.current();
        } else if (event.key === "Tab") {
          const nodes = focusables(), first = nodes[0], last = nodes.at(-1);
          if (!nodes.length) { event.preventDefault(); dialogRef.current?.focus(); }
          else if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
            event.preventDefault(); last.focus();
          } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
            event.preventDefault(); first.focus();
          }
        }
      };
      const containFocus = event => { if (!dialogRef.current?.contains(event.target)) focusFirst(); };
      window.addEventListener("keydown", onKey);
      document.addEventListener("focusin", containFocus);
      return () => {
        window.removeEventListener("keydown", onKey);
        document.removeEventListener("focusin", containFocus);
        document.body.style.overflow = previousOverflow;
        if (previousFocus?.isConnected) previousFocus.focus();
      };
    }, [open]);

    if (!open || typeof document === "undefined" || !createPortal) {
      return null;
    }

    const overlayClass = cx(
      "ks-md-table-dialog-overlay",
      dialogTheme === "dark" && "ks-theme-dark",
      dialogTheme === "light" && "ks-theme-light",
    );

    return createPortal(
      createElement(
        "div",
        {
          className: overlayClass,
          "data-markdown-table-preview": "overlay",
          onMouseDown: (event) => {
            // Close when the backdrop (not the content) is clicked.
            if (event.target === event.currentTarget) onClose();
          },
        },
        createElement(
          "div",
          {
            className: "ks-md-table-dialog",
            ref: dialogRef,
            tabIndex: -1,
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": titleId,
            "aria-describedby": descId,
            "data-markdown-table-preview": "content",
          },
          createElement(
            "div",
            { className: "ks-md-table-dialog-header" },
            createElement("h2", { id: titleId, className: "ks-md-table-dialog-title" }, title),
            createElement("p", { id: descId, className: "ks-md-table-dialog-desc" }, description),
            createElement(
              "button",
              {
                type: "button",
                className: "ks-md-table-btn ks-md-table-dialog-close",
                "aria-label": labels.closePreview || "Close",
                "data-tip": labels.closePreview || "Close",
                onClick: onClose,
              },
              createElement(CloseIcon, null),
            ),
          ),
          createElement(
            "div",
            { className: "ks-md-table-dialog-scroll" },
            createElement(
              "table",
              {
                ...tableProps,
                className: cx("ks-md-table ks-md-table-preview", tableClassName),
                "data-streamdown": "table-preview",
              },
              children,
            ),
          ),
        ),
      ),
      document.body,
    );
  }

  // ── the table (ported state machine + DOM structure) ──────────────────────

  function MarkdownTable({ className, children, node: _node, ...props }) {
    const [previewOpen, setPreviewOpen] = useState(false);
    const [expandedScrollEnabled, setExpandedScrollEnabled] = useState(false);
    const [canToggleExpandedScroll, setCanToggleExpandedScroll] = useState(false);
    const [edgeShadowState, setEdgeShadowState] = useState("none");
    const [viewportMaxWidth, setViewportMaxWidth] = useState("100%");
    const [scrollbarWidth, setScrollbarWidth] = useState("100%");
    const [viewportLeftOffset, setViewportLeftOffset] = useState(0);
    const [virtualScrollbarSticky, setVirtualScrollbarSticky] = useState(false);
    const [virtualScrollbarVisible, setVirtualScrollbarVisible] = useState(false);
    const [virtualScrollThumbStyle, setVirtualScrollThumbStyle] = useState({
      transform: "translateX(0px)",
      width: "100%",
    });
    // Inline status region (replaces toast). statusTokenRef guards against an
    // older timer clearing a newer message.
    const [status, setStatus] = useState(null);
    const statusTokenRef = useRef(0);
    const statusTimerRef = useRef(null);

    const edgeShadowStateRef = useRef(edgeShadowState);
    const expandedScrollEnabledRef = useRef(expandedScrollEnabled);
    const canToggleExpandedScrollRef = useRef(canToggleExpandedScroll);
    const viewportMaxWidthRef = useRef(viewportMaxWidth);
    const scrollbarWidthRef = useRef(scrollbarWidth);
    const viewportLeftOffsetRef = useRef(viewportLeftOffset);
    const virtualScrollbarStickyRef = useRef(virtualScrollbarSticky);
    const virtualScrollbarVisibleRef = useRef(virtualScrollbarVisible);
    const maxViewportLeftOffsetRef = useRef(0);
    const virtualScrollTrackWidthRef = useRef(0);
    const virtualScrollLeftRef = useRef(0);
    const virtualScrollThumbLeftRef = useRef(0);
    const virtualScrollThumbStyleRef = useRef(virtualScrollThumbStyle);
    const isVirtualScrollbarDraggingRef = useRef(false);
    const virtualScrollbarDragOffsetRef = useRef(null);
    const rootRef = useRef(null);
    const frameRef = useRef(null);
    const virtualScrollTrackRef = useRef(null);
    const virtualScrollbarWrapperRef = useRef(null);
    const scrollViewportRef = useRef(null);
    const tableRef = useRef(null);

    // Clear the status timer on unmount.
    useEffect(
      () => () => {
        if (statusTimerRef.current && typeof clearTimeout === "function") {
          clearTimeout(statusTimerRef.current);
        }
      },
      [],
    );

    const notify = useCallback(
      (message, kind) => {
        if (onNotify) {
          try {
            onNotify({ message: String(message), kind });
          } catch {
            /* host notification must never break the action */
          }
          return;
        }
        const token = ++statusTokenRef.current;
        setStatus({ kind, message: String(message) });
        if (statusTimerRef.current && typeof clearTimeout === "function") {
          clearTimeout(statusTimerRef.current);
        }
        statusTimerRef.current = setTimeout(() => {
          if (statusTokenRef.current === token) setStatus(null);
        }, 2500);
      },
      [],
    );

    const setNextEdgeShadowState = useCallback(
      (nextEdgeShadowState) => {
        if (edgeShadowStateRef.current === nextEdgeShadowState) {
          return;
        }
        edgeShadowStateRef.current = nextEdgeShadowState;
        setEdgeShadowState(nextEdgeShadowState);
      },
      [],
    );
    const commitExpandedScrollEnabled = useCallback((nextExpandedScrollEnabled) => {
      if (expandedScrollEnabledRef.current === nextExpandedScrollEnabled) {
        return;
      }
      expandedScrollEnabledRef.current = nextExpandedScrollEnabled;
      setExpandedScrollEnabled(nextExpandedScrollEnabled);
    }, []);
    const commitCanToggleExpandedScroll = useCallback((nextCanToggleExpandedScroll) => {
      if (canToggleExpandedScrollRef.current === nextCanToggleExpandedScroll) {
        return;
      }
      canToggleExpandedScrollRef.current = nextCanToggleExpandedScroll;
      setCanToggleExpandedScroll(nextCanToggleExpandedScroll);
    }, []);
    const commitViewportMaxWidth = useCallback((nextViewportMaxWidth) => {
      if (viewportMaxWidthRef.current === nextViewportMaxWidth) {
        return;
      }
      viewportMaxWidthRef.current = nextViewportMaxWidth;
      setViewportMaxWidth(nextViewportMaxWidth);
    }, []);
    const commitScrollbarWidth = useCallback((nextScrollbarWidth) => {
      if (scrollbarWidthRef.current === nextScrollbarWidth) {
        return;
      }
      scrollbarWidthRef.current = nextScrollbarWidth;
      setScrollbarWidth(nextScrollbarWidth);
    }, []);
    const commitViewportLeftOffset = useCallback((nextViewportLeftOffset) => {
      if (viewportLeftOffsetRef.current === nextViewportLeftOffset) {
        return;
      }
      viewportLeftOffsetRef.current = nextViewportLeftOffset;
      setViewportLeftOffset(nextViewportLeftOffset);
    }, []);
    const commitVirtualScrollbarSticky = useCallback((nextVirtualScrollbarSticky) => {
      if (virtualScrollbarStickyRef.current === nextVirtualScrollbarSticky) {
        return;
      }
      virtualScrollbarStickyRef.current = nextVirtualScrollbarSticky;
      setVirtualScrollbarSticky(nextVirtualScrollbarSticky);
    }, []);
    const commitVirtualScrollbarVisible = useCallback((nextVirtualScrollbarVisible) => {
      if (virtualScrollbarVisibleRef.current === nextVirtualScrollbarVisible) {
        return;
      }
      virtualScrollbarVisibleRef.current = nextVirtualScrollbarVisible;
      setVirtualScrollbarVisible(nextVirtualScrollbarVisible);
    }, []);
    const commitVirtualScrollThumbStyle = useCallback((nextVirtualScrollThumbStyle) => {
      const currentStyle = virtualScrollThumbStyleRef.current;
      if (
        currentStyle.width === nextVirtualScrollThumbStyle.width &&
        currentStyle.transform === nextVirtualScrollThumbStyle.transform
      ) {
        return;
      }
      virtualScrollThumbStyleRef.current = nextVirtualScrollThumbStyle;
      setVirtualScrollThumbStyle(nextVirtualScrollThumbStyle);
    }, []);
    const resolveTableWidth = useCallback(
      (viewport) => {
        return tableRef.current?.getBoundingClientRect().width ?? viewport.scrollWidth;
      },
      [],
    );
    const resolveVirtualScrollLayoutWidth = useCallback((viewport) => {
      return virtualScrollTrackWidthRef.current || viewport.clientWidth;
    }, []);
    const resolveRenderedVirtualScrollTrackWidth = useCallback(
      (viewport) => {
        const trackWidth = virtualScrollTrackRef.current?.getBoundingClientRect().width ?? 0;
        if (trackWidth > 0) {
          return trackWidth;
        }
        return resolveVirtualScrollLayoutWidth(viewport);
      },
      [resolveVirtualScrollLayoutWidth],
    );
    const resolveVirtualScrollMax = useCallback(
      (viewport) => {
        // Virtual scroll distance is only the <table> width minus the track
        // slot width; mixing viewportLeftOffset in previously changed the max
        // when borrowing left space, desyncing the thumb from content progress.
        // The conditionally-mounted DOM track uses a CSS width; if that differs
        // from the saved floating-point layout width, visibility would toggle
        // around the threshold. Overflow must always read the same stable slot.
        return resolveMarkdownTableVirtualScrollMax({
          tableWidth: resolveTableWidth(viewport),
          trackWidth: resolveVirtualScrollLayoutWidth(viewport),
        });
      },
      [resolveTableWidth, resolveVirtualScrollLayoutWidth],
    );
    const commitVirtualScrollLeft = useCallback(
      (nextVirtualScrollLeft) => {
        const viewport = scrollViewportRef.current;
        if (!viewport) {
          virtualScrollLeftRef.current = 0;
          return;
        }

        const virtualScrollMax = resolveVirtualScrollMax(viewport);
        const clampedVirtualScrollLeft = Math.min(
          Math.max(0, nextVirtualScrollLeft),
          virtualScrollMax,
        );
        const nextViewportLeftOffset = Math.min(
          clampedVirtualScrollLeft,
          maxViewportLeftOffsetRef.current,
        );
        const nextViewportScrollLeft = clampedVirtualScrollLeft - nextViewportLeftOffset;

        virtualScrollLeftRef.current = clampedVirtualScrollLeft;
        commitViewportLeftOffset(nextViewportLeftOffset);
        viewport.scrollLeft = nextViewportScrollLeft;
      },
      [commitViewportLeftOffset, resolveVirtualScrollMax],
    );
    const syncVirtualScrollMetrics = useCallback(() => {
      const viewport = scrollViewportRef.current;
      if (!viewport) {
        commitVirtualScrollbarVisible(false);
        commitVirtualScrollThumbStyle({
          transform: "translateX(0px)",
          width: "100%",
        });
        virtualScrollLeftRef.current = 0;
        virtualScrollThumbLeftRef.current = 0;
        return;
      }

      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      // The virtual scrollbar only matters when the table exceeds the slot;
      // rendering the pill for a small table would mislead users into thinking
      // there is more horizontal content to scroll.
      commitVirtualScrollbarVisible(virtualScrollMax > 1);
      const nextVirtualScrollLeft = viewportLeftOffsetRef.current + viewport.scrollLeft;
      const clampedVirtualScrollLeft = Math.min(Math.max(0, nextVirtualScrollLeft), virtualScrollMax);
      if (clampedVirtualScrollLeft !== nextVirtualScrollLeft) {
        // Collapsing/expanding the side panel or a resize changes the slot; the
        // old virtual scroll position may now exceed the new boundary. Write
        // back through the single entry point so the thumb and DOM scrollLeft
        // never drift apart at the edge.
        commitVirtualScrollLeft(clampedVirtualScrollLeft);
        return;
      }

      virtualScrollLeftRef.current = clampedVirtualScrollLeft;
      // The rendered track width only feeds thumb ratio/position; it must not
      // decide whether the track is mounted.
      const virtualScrollViewportWidth = resolveRenderedVirtualScrollTrackWidth(viewport);
      const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
        scrollLeft: clampedVirtualScrollLeft,
        scrollMax: virtualScrollMax,
        tableWidth: resolveTableWidth(viewport),
        trackWidth: virtualScrollViewportWidth,
      });
      commitVirtualScrollThumbStyle({
        transform: `translateX(${Math.round(metrics.thumbLeft)}px)`,
        width: `${Math.ceil(metrics.thumbWidth)}px`,
      });
      virtualScrollThumbLeftRef.current = metrics.thumbLeft;
    }, [
      commitVirtualScrollLeft,
      commitVirtualScrollbarVisible,
      commitVirtualScrollThumbStyle,
      resolveTableWidth,
      resolveVirtualScrollMax,
      resolveRenderedVirtualScrollTrackWidth,
    ]);
    const measureViewportMaxWidth = useCallback(() => {
      const frame = frameRef.current;
      const root = resolveMarkdownTableRoot(frame, rootRef.current);
      if (!frame) {
        commitViewportMaxWidth("100%");
        commitScrollbarWidth("100%");
        commitCanToggleExpandedScroll(false);
        commitVirtualScrollbarVisible(false);
        commitVirtualScrollbarSticky(false);
        maxViewportLeftOffsetRef.current = 0;
        virtualScrollTrackWidthRef.current = 0;
        commitViewportLeftOffset(0);
        return;
      }

      const frameRect = frame.getBoundingClientRect();
      let maxLeftOffset = 0;
      let maxViewportWidth = frameRect.width;
      let measuredScrollbarWidth = frameRect.width;
      let expandedMaxLeftOffset = 0;
      let expandedScrollbarWidth = frameRect.width;

      if (root) {
        const rootRect = root.getBoundingClientRect();
        // V4's expanded boundary is the full timeline viewport, not the
        // centered message column; the explicit root supplies responsive safe
        // margins via CSS variables, the legacy root keeps the old rule.
        const { leftInset, rightInset } = getMarkdownTableRootInlineInsets(root);
        const measuredDistances = resolveMarkdownTableFrameDistances({
          frameWidth: frameRect.width,
          frameLeft: frameRect.left,
          frameRight: frameRect.right,
          rootLeft: rootRect.left,
          rootRight: rootRect.right,
          leftInset,
          rightInset,
        });
        expandedMaxLeftOffset = measuredDistances.maxLeftOffset;
        expandedScrollbarWidth = measuredDistances.scrollbarWidth;

        if (expandedScrollEnabledRef.current) {
          maxLeftOffset = measuredDistances.maxLeftOffset;
          maxViewportWidth = measuredDistances.maxViewportWidth;
          measuredScrollbarWidth = measuredDistances.scrollbarWidth;
        }
      }

      const tableWidth = tableRef.current?.getBoundingClientRect().width ?? 0;
      const hasFrameHorizontalOverflow = tableWidth > frameRect.width + 1;
      const hasExpandedScrollBenefit =
        expandedScrollbarWidth > frameRect.width + 1 || expandedMaxLeftOffset > 1;
      // The toggle only matters when the normal frame width actually overflows
      // AND expanded mode adds visible width or a left borrow; once enabled it
      // stays so the user can collapse back to the normal scroll range.
      commitCanToggleExpandedScroll(
        expandedScrollEnabledRef.current || (hasFrameHorizontalOverflow && hasExpandedScrollBenefit),
      );

      maxViewportLeftOffsetRef.current = maxLeftOffset;
      virtualScrollTrackWidthRef.current = measuredScrollbarWidth;
      commitViewportMaxWidth(`${Math.ceil(maxViewportWidth)}px`);
      // Ceil may make the mounted track up to 1px wider than the slot used for
      // overflow judgement; sub-pixel overflow near the 1px threshold would
      // mount/unmount the track each frame and perturb the timeline height.
      commitScrollbarWidth(`${measuredScrollbarWidth}px`);
      commitVirtualScrollbarSticky(
        shouldUseMarkdownTableStickyScrollbar({
          root,
          table: tableRef.current,
        }),
      );
      if (scrollViewportRef.current) {
        commitVirtualScrollLeft(virtualScrollLeftRef.current);
      } else {
        commitViewportLeftOffset(Math.min(viewportLeftOffsetRef.current, maxLeftOffset));
      }
      syncVirtualScrollMetrics();
    }, [
      commitScrollbarWidth,
      commitCanToggleExpandedScroll,
      commitVirtualScrollLeft,
      commitVirtualScrollbarSticky,
      commitVirtualScrollbarVisible,
      commitViewportLeftOffset,
      commitViewportMaxWidth,
      syncVirtualScrollMetrics,
    ]);

    const measureEdgeShadowState = useCallback(() => {
      const viewport = scrollViewportRef.current;
      const table = tableRef.current;
      if (!viewport || !table) {
        setNextEdgeShadowState("none");
        return;
      }

      const maxScrollLeft = resolveVirtualScrollMax(viewport);
      if (maxScrollLeft <= 1) {
        setNextEdgeShadowState("none");
        return;
      }

      const currentVirtualScrollLeft = viewportLeftOffsetRef.current + viewport.scrollLeft;
      // Borrowing left only widens the table area to the left; it does not mean
      // table content is already hidden at the scroll container's left edge.
      // The left shadow appears only after a real internal scrollLeft; the
      // right shadow follows the virtual progress.
      const hasHiddenLeft = viewport.scrollLeft > 1;
      const hasHiddenRight = currentVirtualScrollLeft < maxScrollLeft - 1;
      setNextEdgeShadowState(
        hasHiddenLeft && hasHiddenRight
          ? "both"
          : hasHiddenLeft
            ? "left"
            : hasHiddenRight
              ? "right"
              : "none",
      );
    }, [resolveVirtualScrollMax, setNextEdgeShadowState]);
    const latestMeasureEdgeShadowStateRef = useRef(measureEdgeShadowState);

    useEffect(() => {
      latestMeasureEdgeShadowStateRef.current = measureEdgeShadowState;
    });

    useIsoLayoutEffect(() => {
      const frame = frameRef.current;
      const root = resolveMarkdownTableRoot(frame, rootRef.current);
      const viewport = scrollViewportRef.current;
      const table = tableRef.current;
      if (!root || !frame || !viewport || !table) {
        commitViewportMaxWidth("100%");
        commitScrollbarWidth("100%");
        return;
      }

      // The table viewport lays out at natural content width first, then can
      // grow up to the current frame width plus the borrowable right space; a
      // direct w-full would lose the small-table shrink-to-fit semantics.
      let rafId = null;
      let rectWatchRafId = null;
      let rectWatchUntil = 0;
      let latestRootRect = readMarkdownTableObservedRect(root);
      let latestFrameRect = readMarkdownTableObservedRect(frame);
      const scheduleMeasure = () => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          latestRootRect = readMarkdownTableObservedRect(root);
          latestFrameRect = readMarkdownTableObservedRect(frame);
          measureViewportMaxWidth();
          latestMeasureEdgeShadowStateRef.current();
        });
      };
      const watchRectChanges = () => {
        rectWatchRafId = null;
        const nextRootRect = readMarkdownTableObservedRect(root);
        const nextFrameRect = readMarkdownTableObservedRect(frame);
        const rectChanged =
          !isMarkdownTableObservedRectEqual(latestRootRect, nextRootRect) ||
          !isMarkdownTableObservedRectEqual(latestFrameRect, nextFrameRect);

        if (rectChanged) {
          // Collapsing/expanding the status panel may only change chat root
          // left/right; ResizeObserver may not fire. Polling the rect
          // signature lets the left borrow and scroll slot follow the layout
          // animation.
          latestRootRect = nextRootRect;
          latestFrameRect = nextFrameRect;
          scheduleMeasure();
        }

        if (performance.now() < rectWatchUntil) {
          rectWatchRafId = requestAnimationFrame(watchRectChanges);
        }
      };
      const scheduleMeasureAndWatchRect = () => {
        scheduleMeasure();
        rectWatchUntil = performance.now() + 800;
        if (rectWatchRafId === null) {
          rectWatchRafId = requestAnimationFrame(watchRectChanges);
        }
      };
      const mutationObserver =
        typeof MutationObserver === "undefined" ? null : new MutationObserver(scheduleMeasureAndWatchRect);
      mutationObserver?.observe(root, {
        attributeFilter: ["style"],
        attributes: true,
      });

      measureViewportMaxWidth();
      scheduleMeasureAndWatchRect();

      if (typeof ResizeObserver === "undefined") {
        window.addEventListener("resize", scheduleMeasureAndWatchRect);
        return () => {
          window.removeEventListener("resize", scheduleMeasureAndWatchRect);
          mutationObserver?.disconnect();
          if (rafId !== null) cancelAnimationFrame(rafId);
          if (rectWatchRafId !== null) cancelAnimationFrame(rectWatchRafId);
        };
      }

      const resizeObserver = new ResizeObserver(scheduleMeasureAndWatchRect);
      resizeObserver.observe(root);
      resizeObserver.observe(frame);
      resizeObserver.observe(viewport);
      resizeObserver.observe(table);
      window.addEventListener("resize", scheduleMeasureAndWatchRect);

      return () => {
        resizeObserver.disconnect();
        window.removeEventListener("resize", scheduleMeasureAndWatchRect);
        mutationObserver?.disconnect();
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (rectWatchRafId !== null) cancelAnimationFrame(rectWatchRafId);
      };
    }, [commitScrollbarWidth, commitViewportMaxWidth, measureViewportMaxWidth]);

    useEffect(() => {
      const viewport = scrollViewportRef.current;
      const table = tableRef.current;
      if (!viewport || !table) {
        setNextEdgeShadowState("none");
        return;
      }

      const updateViewportLayout = () => {
        measureViewportMaxWidth();
        latestMeasureEdgeShadowStateRef.current();
      };
      const updateEdgeShadowState = () => {
        syncVirtualScrollMetrics();
        latestMeasureEdgeShadowStateRef.current();
      };
      const handleWheel = (event) => {
        const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
        if (horizontalDelta === 0) {
          return;
        }

        const virtualScrollMax = resolveVirtualScrollMax(viewport);
        if (virtualScrollMax <= 1) {
          return;
        }

        event.preventDefault();
        // Left-borrow and content scroll used to keep separate positions and
        // overwrite each other at the boundary so rollback was impossible; now a
        // single virtual scrollLeft maps: consume leftOffset first, then hand
        // the remainder to the real viewport.scrollLeft.
        commitVirtualScrollLeft(virtualScrollLeftRef.current + horizontalDelta);
        updateViewportLayout();
      };

      // Performance: p12 trace showed streaming table children changes
      // rebuilding the observer and synchronously reading layout. The observer
      // lifecycle is bound to the DOM nodes; content changes are merged into the
      // next frame by ResizeObserver.
      let rafId = null;
      const debouncedUpdate = () => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          updateEdgeShadowState();
        });
      };

      updateEdgeShadowState();
      viewport.addEventListener("scroll", updateEdgeShadowState, {
        passive: true,
      });
      viewport.addEventListener("wheel", handleWheel, { passive: false });

      if (typeof ResizeObserver === "undefined") {
        window.addEventListener("resize", debouncedUpdate);
        return () => {
          viewport.removeEventListener("scroll", updateEdgeShadowState);
          viewport.removeEventListener("wheel", handleWheel);
          window.removeEventListener("resize", debouncedUpdate);
          if (rafId !== null) cancelAnimationFrame(rafId);
        };
      }

      const resizeObserver = new ResizeObserver(() => {
        debouncedUpdate();
      });
      resizeObserver.observe(viewport);
      resizeObserver.observe(table);
      window.addEventListener("resize", debouncedUpdate);

      return () => {
        viewport.removeEventListener("scroll", updateEdgeShadowState);
        viewport.removeEventListener("wheel", handleWheel);
        resizeObserver.disconnect();
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }, [
      commitVirtualScrollLeft,
      measureViewportMaxWidth,
      resolveVirtualScrollMax,
      setNextEdgeShadowState,
      syncVirtualScrollMetrics,
    ]);

    useIsoLayoutEffect(() => {
      const frame = frameRef.current;
      const table = tableRef.current;
      const wrapper = virtualScrollbarWrapperRef.current;
      const root = resolveMarkdownTableRoot(frame, rootRef.current);
      if (!frame || !table || !wrapper || !virtualScrollbarSticky) {
        if (wrapper) wrapper.style.transform = "";
        return;
      }

      const verticalViewport = resolveMarkdownTableVerticalViewport(table, root);
      if (!verticalViewport) return;

      let rafId = null;
      let observedDock = null;
      const updateStickyOffset = () => {
        rafId = null;
        const frameRect = frame.getBoundingClientRect();
        const viewportRect = verticalViewport.getBoundingClientRect();
        const dockHeight = readMarkdownTableDockHeight(root);
        // Off the bottom, the "back to bottom" button sits above the composer
        // dock; subtracting only the dock would let the long-table sticky
        // scrollbar share the horizontal band with the button, hiding it under
        // the wide slot.
        const backToBottomClearance = readMarkdownTableBackToBottomClearance(root);
        const offset = resolveMarkdownTableStickyScrollbarOffset({
          frameTop: frameRect.top,
          frameBottom: frameRect.bottom,
          scrollbarHeight: wrapper.getBoundingClientRect().height,
          viewportBottom: viewportRect.bottom - dockHeight - backToBottomClearance,
        });
        wrapper.style.transform = offset === 0 ? "" : `translateY(${Math.round(offset)}px)`;
      };
      const scheduleStickyOffset = () => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(updateStickyOffset);
      };

      const resizeObserver =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleStickyOffset);
      const syncDockObservation = () => {
        const nextDock = root?.querySelector?.(MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR) ?? null;
        // The MutationObserver also senses the back-to-bottom button mounting
        // inside the dock; even when the dock node itself is unchanged a
        // geometry update must be scheduled.
        if (nextDock === observedDock) {
          scheduleStickyOffset();
          return;
        }
        if (observedDock) resizeObserver?.unobserve(observedDock);
        observedDock = nextDock;
        if (observedDock) resizeObserver?.observe(observedDock);
        scheduleStickyOffset();
      };

      // V4 virtual rows use transform for positioning; native sticky would be
      // clamped by the transformed ancestor to its natural position. Instead we
      // follow the timeline scroll to compute a vertical offset, still bounded
      // by the table's top/bottom edges.
      updateStickyOffset();
      verticalViewport.addEventListener("scroll", scheduleStickyOffset, { passive: true });
      window.addEventListener("resize", scheduleStickyOffset);
      resizeObserver?.observe(frame);
      resizeObserver?.observe(verticalViewport);
      syncDockObservation();
      // Draft/empty-state switching conditionally mounts or replaces the V4
      // composer dock; observing only the initial node would miss a new dock's
      // taller input, so track root subtree changes and rebind.
      const dockMutationObserver =
        typeof MutationObserver === "undefined" || !root
          ? null
          : new MutationObserver(syncDockObservation);
      if (dockMutationObserver && root) {
        dockMutationObserver.observe(root, { childList: true, subtree: true });
      }

      return () => {
        verticalViewport.removeEventListener("scroll", scheduleStickyOffset);
        window.removeEventListener("resize", scheduleStickyOffset);
        resizeObserver?.disconnect();
        dockMutationObserver?.disconnect();
        if (rafId !== null) cancelAnimationFrame(rafId);
        wrapper.style.transform = "";
      };
    }, [virtualScrollbarSticky, virtualScrollbarVisible]);

    const getRows = useCallback(() => readRowsFromTable(tableRef.current), []);

    const commitVirtualScrollLeftFromClientX = useCallback(
      (clientX, thumbDragOffset = null) => {
        const track = virtualScrollTrackRef.current;
        const viewport = scrollViewportRef.current;
        if (!track || !viewport) return;

        const trackRect = track.getBoundingClientRect();
        const trackWidth = trackRect.width;
        const virtualScrollMax = resolveVirtualScrollMax(viewport);
        const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
          scrollLeft: virtualScrollLeftRef.current,
          scrollMax: virtualScrollMax,
          tableWidth: resolveTableWidth(viewport),
          trackWidth,
        });
        const maxThumbLeft = Math.max(0, trackWidth - metrics.thumbWidth);
        const rawThumbLeft =
          thumbDragOffset === null
            ? clientX - trackRect.left - metrics.thumbWidth / 2
            : clientX - trackRect.left - thumbDragOffset;
        const nextThumbLeft = Math.min(maxThumbLeft, Math.max(0, rawThumbLeft));
        const nextVirtualScrollLeft =
          maxThumbLeft <= 0 ? 0 : (nextThumbLeft / maxThumbLeft) * virtualScrollMax;

        commitVirtualScrollLeft(nextVirtualScrollLeft);
        measureViewportMaxWidth();
        latestMeasureEdgeShadowStateRef.current();
      },
      [commitVirtualScrollLeft, measureViewportMaxWidth, resolveTableWidth, resolveVirtualScrollMax],
    );
    const handleVirtualScrollbarPointerDown = useCallback(
      (event) => {
        isVirtualScrollbarDraggingRef.current = true;
        virtualScrollbarDragOffsetRef.current = null;
        event.currentTarget.setPointerCapture(event.pointerId);
        commitVirtualScrollLeftFromClientX(event.clientX);
      },
      [commitVirtualScrollLeftFromClientX],
    );
    const handleVirtualScrollbarPointerMove = useCallback(
      (event) => {
        if (!isVirtualScrollbarDraggingRef.current) return;
        commitVirtualScrollLeftFromClientX(event.clientX, virtualScrollbarDragOffsetRef.current);
      },
      [commitVirtualScrollLeftFromClientX],
    );
    const handleVirtualScrollbarPointerEnd = useCallback((event) => {
      isVirtualScrollbarDraggingRef.current = false;
      virtualScrollbarDragOffsetRef.current = null;
      if (event.currentTarget && event.currentTarget.hasPointerCapture && event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }, []);
    const handleVirtualScrollbarThumbPointerDown = useCallback((event) => {
      event.stopPropagation();
      const track = virtualScrollTrackRef.current;
      if (!track) return;

      const trackRect = track.getBoundingClientRect();
      isVirtualScrollbarDraggingRef.current = true;
      // The thumb is a track child; pressing it must not bubble to the track's
      // click-to-jump logic. Record the pointer offset within the thumb so
      // dragging preserves that relative offset instead of jumping to center.
      virtualScrollbarDragOffsetRef.current = Math.max(
        0,
        event.clientX - trackRect.left - virtualScrollThumbLeftRef.current,
      );
      event.currentTarget.setPointerCapture(event.pointerId);
    }, []);
    const handleVirtualScrollbarThumbPointerMove = useCallback(
      (event) => {
        event.stopPropagation();
        if (!isVirtualScrollbarDraggingRef.current) return;
        commitVirtualScrollLeftFromClientX(event.clientX, virtualScrollbarDragOffsetRef.current);
      },
      [commitVirtualScrollLeftFromClientX],
    );
    const handleVirtualScrollbarThumbPointerEnd = useCallback((event) => {
      event.stopPropagation();
      handleVirtualScrollbarPointerEnd(event);
    }, [handleVirtualScrollbarPointerEnd]);
    const handleVirtualScrollbarWheel = useCallback(
      (event) => {
        const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
        if (horizontalDelta === 0) return;

        const viewport = scrollViewportRef.current;
        if (!viewport || resolveVirtualScrollMax(viewport) <= 1) return;

        event.preventDefault();
        commitVirtualScrollLeft(virtualScrollLeftRef.current + horizontalDelta);
        measureViewportMaxWidth();
        latestMeasureEdgeShadowStateRef.current();
      },
      [commitVirtualScrollLeft, measureViewportMaxWidth, resolveVirtualScrollMax],
    );

    const handleCopyMarkdown = useCallback(async () => {
      if (typeof navigator === "undefined" || !navigator || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        notify(formatTemplate(labels.copyFailed, "clipboard-unavailable"), "error");
        return;
      }

      try {
        await navigator.clipboard.writeText(buildMarkdownTableText(getRows()));
        notify(labels.copySucceeded, "success");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        notify(formatTemplate(labels.copyFailed, msg), "error");
      }
    }, [getRows, labels, notify]);

    const handleDownloadCsv = useCallback(() => {
      if (
        typeof document === "undefined" ||
        typeof Blob === "undefined" ||
        typeof URL === "undefined" ||
        typeof URL.createObjectURL !== "function"
      ) {
        notify(labels.downloadFailed, "error");
        return;
      }

      // Wrap in try/catch (upstream did not): a click()/createObjectURL failure
      // must surface as an error, never silently succeed.
      try {
        const blob = new Blob([buildCsvTableText(getRows())], {
          type: "text/csv;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "table.csv";
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      } catch (error) {
        notify(labels.downloadFailed, "error");
      }
    }, [getRows, labels, notify]);

    const handleToggleExpandedScroll = useCallback(() => {
      const nextExpandedScrollEnabled = !expandedScrollEnabledRef.current;
      commitExpandedScrollEnabled(nextExpandedScrollEnabled);

      if (!nextExpandedScrollEnabled) {
        maxViewportLeftOffsetRef.current = 0;
        commitViewportLeftOffset(0);
        const viewport = scrollViewportRef.current;
        if (viewport) {
          // Collapsing back to normal mode: the existing virtual scroll
          // position may be consumed by the left borrow; clear leftOffset then
          // map the same virtual scrollLeft back to the real scrollLeft so the
          // table content does not jump to the start.
          viewport.scrollLeft = virtualScrollLeftRef.current;
        }
      }

      requestAnimationFrame(() => {
        measureViewportMaxWidth();
        latestMeasureEdgeShadowStateRef.current();
      });
    }, [commitExpandedScrollEnabled, commitViewportLeftOffset, measureViewportMaxWidth]);

    const copyLabel = labels.copyMarkdown;
    const downloadLabel = labels.downloadCsv;
    const previewLabel = labels.openPreview;
    const scrollModeLabel = expandedScrollEnabled ? labels.collapseScrollMode : labels.expandScrollMode;
    const previewTitle = labels.previewTitle;
    const previewDescription = labels.previewDescription;

    // viewportMaxWidth is the virtual scroll slot width, used for virtualScrollMax
    // and the thumb; the content layer itself translateX-borrows left, so the
    // borrowed width must be added back on the right or the visual right edge
    // would slide left with it.
    const contentViewportMaxWidth =
      viewportLeftOffset > 0
        ? `calc(${viewportMaxWidth} + ${Math.ceil(viewportLeftOffset)}px)`
        : viewportMaxWidth;

    return createElement(
      "div",
      { ref: rootRef, className: "ks-md-table-root" },
      createElement(
        "div",
        { className: "ks-md-table-toolbar", "data-markdown-table-toolbar": "" },
        createElement(
          MarkdownTableActionButton,
          { label: copyLabel, onClick: () => {
            // Fire-and-forget; failures are surfaced via notify().
            handleCopyMarkdown();
          } },
          createElement(CopyIcon, null),
        ),
        createElement(
          MarkdownTableActionButton,
          { label: downloadLabel, onClick: handleDownloadCsv },
          createElement(DownloadIcon, null),
        ),
        createElement(
          MarkdownTableActionButton,
          { label: previewLabel, onClick: () => setPreviewOpen(true) },
          createElement(MaximizeIcon, null),
        ),
        canToggleExpandedScroll
          ? createElement(
              MarkdownTableActionButton,
              {
                label: scrollModeLabel,
                onClick: handleToggleExpandedScroll,
                pressed: expandedScrollEnabled,
              },
              expandedScrollEnabled ? createElement(CollapseScrollIcon, null) : createElement(ExpandScrollIcon, null),
            )
          : null,
        !onNotify && status
          ? createElement(
              "div",
              {
                className: cx("ks-md-table-status", `ks-md-table-status-${status.kind}`),
                role: "status",
                "aria-live": "polite",
              },
              status.message,
            )
          : null,
      ),
      createElement(
        "div",
        {
          ref: frameRef,
          className: "ks-md-table-frame",
          "data-markdown-table-frame": "",
          "data-markdown-table-virtual-scroll-sticky": virtualScrollbarSticky ? "true" : "false",
        },
        createElement(
          "div",
          {
            className: cx(
              "ks-md-table-width",
              viewportLeftOffset <= 0 && "ks-md-table-width-transition",
            ),
            style: {
              maxWidth: contentViewportMaxWidth,
              transform: viewportLeftOffset > 0 ? `translateX(-${viewportLeftOffset}px)` : undefined,
            },
          },
          createElement(
            "div",
            { className: "ks-md-table-viewport-wrap" },
            createElement(
              "div",
              { ref: scrollViewportRef, className: "ks-md-table-scroll" },
              createElement(
                "table",
                {
                  ...props,
                  ref: tableRef,
                  className: cx("ks-md-table", className),
                  "data-streamdown": "table",
                },
                children,
              ),
            ),
            createElement(MarkdownTableEdgeShadow, { side: "left", state: edgeShadowState }),
            createElement(MarkdownTableEdgeShadow, { side: "right", state: edgeShadowState }),
          ),
        ),
        createElement(
          "div",
          {
            ref: virtualScrollbarWrapperRef,
            "aria-hidden": virtualScrollbarVisible ? "false" : "true",
            // Under a V4 transformed virtual row, sticky is simulated with
            // relative + translateY; computed position cannot express the
            // product semantics, so an explicit state is exposed for cross-
            // implementation E2E and a11y diagnostics.
            "data-markdown-table-virtual-scroll-sticky": virtualScrollbarSticky ? "true" : "false",
            "data-markdown-table-virtual-scroll-visible": virtualScrollbarVisible ? "true" : "false",
            // The track width must equal frameRect.width + rightDistance minus
            // the message column's responsive right padding; long tables need
            // horizontal scrolling while reading vertically, and the sticky
            // bottom must avoid the composer and bottom panels. When overflow
            // measurement changes only visibility toggles; the node and its
            // vertical footprint are preserved so timeline height is not
            // perturbed.
            style: { width: scrollbarWidth },
            className: cx(
              "ks-md-table-vbar",
              virtualScrollbarVisible ? "ks-md-table-vbar-visible" : "ks-md-table-vbar-hidden",
              virtualScrollbarSticky && "ks-md-table-vbar-sticky",
            ),
          },
          createElement(
            "div",
            {
              ref: virtualScrollTrackRef,
              "aria-hidden": "true",
              className: "ks-md-table-vtrack",
              "data-markdown-table-virtual-scroll-track": "",
              onPointerCancel: handleVirtualScrollbarPointerEnd,
              onPointerDown: handleVirtualScrollbarPointerDown,
              onPointerMove: handleVirtualScrollbarPointerMove,
              onPointerUp: handleVirtualScrollbarPointerEnd,
              onWheel: handleVirtualScrollbarWheel,
            },
            createElement("div", {
              className: "ks-md-table-vthumb",
              onPointerCancel: handleVirtualScrollbarThumbPointerEnd,
              onPointerDown: handleVirtualScrollbarThumbPointerDown,
              onPointerMove: handleVirtualScrollbarThumbPointerMove,
              onPointerUp: handleVirtualScrollbarThumbPointerEnd,
              style: virtualScrollThumbStyle,
            }),
          ),
        ),
      ),
      createElement(MarkdownTablePreviewDialog, {
        open: previewOpen,
        onClose: () => setPreviewOpen(false),
        title: previewTitle,
        description: previewDescription,
        tableClassName: className,
        tableProps: props,
        dialogTheme: theme,
        children,
      }),
    );
  }

  // ── thead / tbody / tr / th / td (strip the `node` prop Streamdown passes) ──

  function MarkdownTableHeader({ className, node: _node, ...props }) {
    return createElement("thead", { className: cx("ks-md-table-thead", className), ...props });
  }

  function MarkdownTableBody({ className, node: _node, ...props }) {
    return createElement("tbody", { className: cx("ks-md-table-tbody", className), ...props });
  }

  function MarkdownTableRow({ className, node: _node, ...props }) {
    return createElement("tr", { className: cx("ks-md-table-tr", className), ...props });
  }

  function MarkdownTableHead({ className, node: _node, ...props }) {
    return createElement("th", { className: cx("ks-md-table-th", className), ...props });
  }

  function MarkdownTableCell({ className, node: _node, ...props }) {
    return createElement("td", { className: cx("ks-md-table-td", className), ...props });
  }

  return {
    table: MarkdownTable,
    thead: MarkdownTableHeader,
    tbody: MarkdownTableBody,
    tr: MarkdownTableRow,
    th: MarkdownTableHead,
    td: MarkdownTableCell,
  };
}
