import { llms } from 'fumadocs-core/source';
import { source } from '@/lib/source';

export const revalidate = false;

/** Machine-readable index of the Chinese documentation (default locale). */
export function GET() {
  return new Response(llms(source).index(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
