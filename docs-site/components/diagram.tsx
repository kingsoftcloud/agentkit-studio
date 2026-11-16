'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Architecture diagram with a light and a dark capture.
 *
 * Archify bakes the theme into the rendered pixels, so each diagram ships two
 * files; CSS picks the one that matches the site theme. Clicking opens a
 * lightbox with wheel zoom around the cursor, drag-to-pan, and keyboard
 * dismissal. `react-medium-image-zoom` is deliberately not used here: it cannot
 * wheel-zoom and it cannot hide the duplicate screenshot from its own portal.
 *
 * The deployment base path is applied by hand because Next does not rewrite a
 * bare `<img src>`; without it every diagram 404s on GitHub Pages.
 */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

const MIN_SCALE = 1;
const MAX_SCALE = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function Diagram({ src, alt }: { src: string; alt?: string }) {
  const lightSrc = `${BASE_PATH}${src}`;
  const darkSrc = `${BASE_PATH}${src.replace(/\.png$/u, '.dark.png')}`;

  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const stageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const restoredFocus = useRef<HTMLElement | null>(null);

  const openLightbox = useCallback((event: React.MouseEvent<HTMLImageElement>) => {
    restoredFocus.current = event.currentTarget;
    setDark(document.documentElement.classList.contains('dark'));
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setScale(1);
    setOffset({ x: 0, y: 0 });
    restoredFocus.current?.focus?.();
  }, []);

  const zoomBy = useCallback((factor: number, origin?: { x: number; y: number }) => {
    setScale(current => {
      const next = clamp(current * factor, MIN_SCALE, MAX_SCALE);
      const ratio = next / current;
      if (ratio === 1) return current;
      const rect = stageRef.current?.getBoundingClientRect();
      const ox = origin?.x ?? rect ? (origin?.x ?? 0) : 0;
      const oy = origin?.y ?? 0;
      setOffset(previous => ({
        x: previous.x + (ox - previous.x) * (1 - ratio),
        y: previous.y + (oy - previous.y) * (1 - ratio),
      }));
      return next;
    });
  }, []);

  // Wheel zoom anchored on the cursor.
  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    if (!stage) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const origin = {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      };
      zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, origin);
    };

    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [open, zoomBy]);

  // Escape closes, body scroll is locked while the lightbox is up.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key === '+' || event.key === '=') zoomBy(1.25);
      if (event.key === '-') zoomBy(1 / 1.25);
      if (event.key === '0') {
        setScale(1);
        setOffset({ x: 0, y: 0 });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, close, zoomBy]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (scale <= 1) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    setOffset(previous => ({ x: previous.x + dx, y: previous.y + dy }));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const reset = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  return (
    <figure className="ak-diagram">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="ak-diagram-img ak-diagram-light"
        src={lightSrc}
        alt={alt ?? ''}
        loading="lazy"
        onClick={openLightbox}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="ak-diagram-img ak-diagram-dark"
        src={darkSrc}
        alt={alt ? `${alt} (dark)` : ''}
        loading="lazy"
        onClick={openLightbox}
      />
      <span className="ak-diagram-hint">点击放大 · 滚轮缩放 · 拖拽平移</span>

      {open ? (
        <div
          className="ak-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={alt ?? '架构图'}
          onMouseDown={event => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div className="ak-lightbox-bar">
            <span className="ak-lightbox-title">{alt ?? '架构图'}</span>
            <span className="ak-lightbox-controls">
              <button type="button" onClick={() => zoomBy(1 / 1.25)} aria-label="缩小">
                −
              </button>
              <button type="button" onClick={reset} aria-label="重置缩放">
                {Math.round(scale * 100)}%
              </button>
              <button type="button" onClick={() => zoomBy(1.25)} aria-label="放大">
                +
              </button>
              <button type="button" ref={closeRef} onClick={close} aria-label="关闭">
                ✕
              </button>
            </span>
          </div>

          <div
            className="ak-lightbox-stage"
            ref={stageRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={reset}
            data-zoomed={scale > 1 ? 'true' : 'false'}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={dark ? darkSrc : lightSrc}
              alt={alt ?? ''}
              draggable={false}
              style={{
                transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
              }}
            />
          </div>

          <p className="ak-lightbox-hint">滚轮缩放 · 拖拽平移 · 双击或 0 复位 · Esc 关闭</p>
        </div>
      ) : null}
    </figure>
  );
}
