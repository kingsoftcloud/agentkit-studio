/** Check every blob and historical path reachable from the public branch. Never print matching content. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { auditPath, auditText } from './public-surface-audit.mjs';
import { PUBLIC_HISTORY_BASELINE } from './public-history-baseline.mjs';

/** Exact historical false positives cannot exempt a changed blob or another path. */
export function auditHistoricalBlob(file, source) {
  const hits = auditText(file, source, { historical: true });
  if (!hits.length) return hits;
  const blob = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
  const approved = PUBLIC_HISTORY_BASELINE.find(entry => entry.blob === blob && entry.file === file);
  return approved ? hits.filter(hit => !approved.findings.some(finding =>
    finding.kind === hit.kind && finding.line === hit.line)) : hits;
}

export function auditPublicHistory(root=process.cwd(), { allRefs = false } = {}) {
  const git=(args,input)=>execFileSync('git',args,{cwd:root,input,maxBuffer:128*1024*1024});
  const revisions = allRefs ? ['--all'] : ['HEAD'];
  if(git(['rev-parse','--is-shallow-repository']).toString().trim()!=='false') throw new Error('Public history audit requires a complete checkout');
  const historicalPaths=new Set(git(['log','--format=','--name-only','-z',...revisions]).toString().split('\0').map(path=>path.trim()).filter(Boolean));
  const hits=[...historicalPaths].flatMap(auditPath);
  const rows=git(['rev-list','--objects',...revisions]).toString().trim().split('\n');
  const types=git(['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],rows.map(row=>row.split(' ')[0]).join('\n')+'\n').toString().trim().split('\n');
  let blobs=0;
  for(let i=0;i<rows.length;i++) {
    const [sha,type]=types[i].split(' ');
    if(type!=='blob')continue;
    hits.push(...auditHistoricalBlob(rows[i].slice(41),git(['cat-file','blob',sha])));blobs++;
  }
  return {commit:git(['rev-parse','HEAD']).toString().trim(),allRefs,blobs,historicalPaths:historicalPaths.size,hits};
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(value=>value!=='--all-refs')) throw new Error('usage: public-history-audit.mjs [--all-refs]');
  const result=auditPublicHistory(process.cwd(),{allRefs:process.argv.includes('--all-refs')});
  for(const hit of result.hits)console.error(`${hit.file}${hit.line?':'+hit.line:''}: ${hit.kind}`);
  if(result.hits.length)process.exitCode=1;
  else console.log(`public history audit passed: ${result.blobs} blobs and ${result.historicalPaths} historical paths`);
}
