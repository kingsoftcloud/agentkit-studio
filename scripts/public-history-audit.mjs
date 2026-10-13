/** Check every blob and historical path reachable from the public branch. Never print matching content. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditPath, auditText } from './public-surface-audit.mjs';

export function auditPublicHistory(root=process.cwd()) {
  const git=(args,input)=>execFileSync('git',args,{cwd:root,input,maxBuffer:128*1024*1024});
  if(git(['rev-parse','--is-shallow-repository']).toString().trim()!=='false') throw new Error('Public history audit requires a complete checkout');
  const historicalPaths=new Set(git(['log','--format=','--name-only','-z','HEAD']).toString().split('\0').map(path=>path.trim()).filter(Boolean));
  const hits=[...historicalPaths].flatMap(auditPath);
  const rows=git(['rev-list','--objects','HEAD']).toString().trim().split('\n');
  const types=git(['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],rows.map(row=>row.split(' ')[0]).join('\n')+'\n').toString().trim().split('\n');
  let blobs=0;
  for(let i=0;i<rows.length;i++) {
    const [sha,type]=types[i].split(' ');
    if(type!=='blob')continue;
    hits.push(...auditText(rows[i].slice(41),git(['cat-file','blob',sha])));blobs++;
  }
  return {commit:git(['rev-parse','HEAD']).toString().trim(),blobs,historicalPaths:historicalPaths.size,hits};
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const result=auditPublicHistory();
  for(const hit of result.hits)console.error(`${hit.file}${hit.line?':'+hit.line:''}: ${hit.kind}`);
  if(result.hits.length)process.exitCode=1;
  else console.log(`public history audit passed: ${result.blobs} blobs and ${result.historicalPaths} historical paths`);
}
