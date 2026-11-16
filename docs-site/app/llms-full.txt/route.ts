import { getLLMText, source } from '@/lib/source';

export const revalidate = false;

/** Every Chinese page concatenated, for agents that need the whole corpus. */
export async function GET() {
  const pages = source.getPages('cn');
  const scanned = await Promise.all(pages.map(getLLMText));

  return new Response(scanned.join('\n\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
