/** Reuse signed macOS bytes after verifying their original build, source and transport digest. */
import {execFile} from 'node:child_process';
import {promisify,parseArgs,stripVTControlCharacters} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Readable,Transform} from 'node:stream';
import {join,resolve} from 'node:path';
const execute=promisify(execFile);
const {values}=parseArgs({options:Object.fromEntries(['repository','run','source','version','output'].map(key=>[key,{type:'string'}]))});
const {repository,run,source,version}=values;
if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository||'')||!/^\d+$/.test(run||'')||!/^[0-9a-f]{40}$/.test(source||'')) throw Error('Invalid candidate identity');
const api=async path=>JSON.parse((await execute('gh',['api',`repos/${repository}/${path}`],{maxBuffer:32*1024*1024})).stdout);
const original=await api(`actions/runs/${run}`);
if(original.status!=='completed'||original.event!=='workflow_dispatch') throw Error('Candidate must be a completed manual release run');
const job=(await api(`actions/runs/${run}/jobs`)).jobs.find(item=>item.name==='macos-arm64');
for(const name of ['Verify immutable source inputs','Build, sign and notarize Studio','Verify signed and notarized artifacts']) {
  if(job?.steps.find(step=>step.name===name)?.conclusion!=='success') throw Error(`Original candidate has not passed ${name}`);
}
const logs=stripVTControlCharacters((await execute('gh',['api','--allow-escape-sequences',`repos/${repository}/actions/jobs/${job.id}/logs`],{maxBuffer:32*1024*1024})).stdout);
const sources=[...new Set([...logs.matchAll(/\bSTUDIO_REF_VALUE:\s*([0-9a-f]{40})\b/g)].map(match=>match[1]))];
const versions=[...new Set([...logs.matchAll(/\bBUILD_VERSION(?:_VALUE)?:\s*([0-9A-Za-z.-]+)/g)].map(match=>match[1]))];
if(sources.length!==1||sources[0]!==source||versions.length!==1||versions[0]!==version) throw Error('Original signed source or version differs');
const artifact=(await api(`actions/runs/${run}/artifacts`)).artifacts.find(item=>item.name===`agentkit-studio-${source}-preview-mac-arm64`&&!item.expired);
if(!artifact||!/^sha256:[0-9a-f]{64}$/.test(artifact.digest||'')) throw Error('Signed artifact transport digest unavailable');
const root=resolve(values.output);await mkdir(root,{recursive:true});
const response=await fetch(artifact.archive_download_url,{headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`},signal:AbortSignal.timeout(900000)});
if(!response.ok||!response.body) throw Error('Signed candidate download failed');
const hash=createHash('sha256');let bytes=0;
await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_encoding,done){hash.update(chunk);bytes+=chunk.length;done(null,chunk);}}),createWriteStream(join(root,'candidate.zip'),{flags:'wx'}));
const sha256=hash.digest('hex');
if(artifact.digest!==`sha256:${sha256}`||artifact.size_in_bytes!==bytes) throw Error('Signed candidate transport integrity differs');
await writeFile(join(root,'provenance.json'),JSON.stringify({sourceCommit:source,version,candidateRunId:Number(run),artifactId:artifact.id,sha256,bytes,originalSignedStagesVerified:true},null,2));
console.log('Original macOS signing stages, source, version and artifact digest verified');
