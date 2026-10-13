/** Reuse signed Windows bytes only after checking their original build and transport digest. */
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { join, resolve } from 'node:path';
const execute=promisify(execFile);
const {values}=parseArgs({options:Object.fromEntries(['repository','run','source','version','output'].map(key=>[key,{type:'string'}]))});
const {repository,run,source,version}=values;
if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository||'')||!/^\d+$/.test(run||'')||!/^[0-9a-f]{40}$/.test(source||''))throw Error('Invalid candidate identity');
const api=async path=>JSON.parse((await execute('gh',['api',`repos/${repository}/${path}`],{maxBuffer:32*1024*1024})).stdout);
const original=await api(`actions/runs/${run}`);
if(original.status!=='completed'||original.event!=='workflow_dispatch')throw Error('Candidate build must be a completed manual release run');
const jobs=await api(`actions/runs/${run}/jobs`);
const job=jobs.jobs.find(value=>value.name==='windows-x64');
for(const name of ['Verify immutable Studio source','Package the official DSH Windows target','Verify timestamped installer and actual installation']) {
 if(job?.steps.find(step=>step.name===name)?.conclusion!=='success')throw Error(`Original candidate has not passed ${name}`);
}
const logs=(await execute('gh',['api',`repos/${repository}/actions/jobs/${job.id}/logs`],{maxBuffer:32*1024*1024})).stdout;
const sources=[...new Set([...logs.matchAll(/\bSTUDIO_SHA:\s*([0-9a-f]{40})\b/g)].map(value=>value[1]))];
const versions=[...new Set([...logs.matchAll(/\bBUILD_VERSION:\s*([0-9A-Za-z.-]+)/g)].map(value=>value[1]))];
if(sources.length!==1||sources[0]!==source||versions.length!==1||versions[0]!==version)throw Error('Candidate source or version differs from the original immutable build');
const artifacts=await api(`actions/runs/${run}/artifacts`);
const artifact=artifacts.artifacts.find(value=>value.name===`agentkit-studio-${version}-win-x64`&&!value.expired);
if(!artifact||!/^sha256:[0-9a-f]{64}$/.test(artifact.digest||''))throw Error('Candidate artifact or GitHub SHA-256 digest unavailable');
const root=resolve(values.output||'.artifacts/windows-candidate');await mkdir(root,{recursive:true});
const archive=join(root,'candidate.zip');
const response=await fetch(artifact.archive_download_url,{headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`},signal:AbortSignal.timeout(900000)});
if(!response.ok||!response.body)throw Error(`Candidate download failed: HTTP ${response.status}`);
const hash=createHash('sha256');let bytes=0;
await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_encoding,done){hash.update(chunk);bytes+=chunk.length;done(null,chunk)}}),createWriteStream(archive,{flags:'wx'}));
const sha256=hash.digest('hex');
if(artifact.digest!==`sha256:${sha256}`||bytes!==artifact.size_in_bytes)throw Error('Candidate transport digest or size differs from GitHub');
await writeFile(join(root,'provenance.json'),JSON.stringify({sourceCommit:source,version,candidateRunId:Number(run),artifactId:artifact.id,sha256,bytes,originalSignedStagesVerified:true},null,2));
console.log('Signed candidate original source, version, signing stages and transport digest verified.');
