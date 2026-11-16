import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Callout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import UncontrolledZoom from 'react-medium-image-zoom';
import 'react-medium-image-zoom/dist/styles.css';
import type { MDXComponents } from 'mdx/types';
import type { DetailedHTMLProps, ImgHTMLAttributes } from 'react';
import { Diagram } from '@/components/diagram';
import { Mermaid } from '@/components/mdx/mermaid';
import { Video } from '@/components/mdx/video';

// Markdown `![]()` is wrapped in react-medium-image-zoom so screenshots can be
// opened full size. Native <img> is used on purpose: Next/Image rejects SVG and
// would render an empty box for our diagrams.
function ZoomableImg({
  src,
  alt,
  ...rest
}: DetailedHTMLProps<ImgHTMLAttributes<HTMLImageElement>, HTMLImageElement>) {
  const srcStr =
    typeof src === 'string'
      ? src
      : src && typeof src === 'object' && 'src' in src
        ? String(src.src)
        : '';
  return (
    <UncontrolledZoom zoomMargin={20} wrapElement="span">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img {...rest} src={srcStr} alt={alt ?? ''} loading="lazy" />
    </UncontrolledZoom>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Tab,
    Tabs,
    Accordion,
    Accordions,
    Step,
    Steps,
    Callout,
    Card,
    Cards,
    TypeTable,
    File,
    Files,
    Folder,
    Diagram,
    Mermaid,
    Video,
    img: ZoomableImg,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
