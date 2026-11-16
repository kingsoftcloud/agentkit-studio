'use client';

import UncontrolledZoom from 'react-medium-image-zoom';

/**
 * Architecture diagram with a light and a dark capture.
 *
 * Archify bakes the theme into the rendered pixels, so each diagram ships two
 * files and CSS picks the one that matches the site theme. Both are real
 * `<img>` elements so the zoom wrapper can open either full size on click.
 *
 * The deployment base path is applied by hand: GitHub Pages serves this project
 * site under `/agentkit-studio`, and a bare `<img src>` is not rewritten by
 * Next the way `next/link` and `next/image` are.
 */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

export function Diagram({ src, alt }: { src: string; alt?: string }) {
  const lightSrc = `${BASE_PATH}${src}`;
  const darkSrc = `${BASE_PATH}${src.replace(/\.png$/u, '.dark.png')}`;

  return (
    <figure className="ak-diagram">
      <UncontrolledZoom zoomMargin={24} wrapElement="span">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="ak-diagram-img ak-diagram-light" src={lightSrc} alt={alt ?? ''} loading="lazy" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="ak-diagram-img ak-diagram-dark" src={darkSrc} alt="" aria-hidden="true" loading="lazy" />
      </UncontrolledZoom>
    </figure>
  );
}
