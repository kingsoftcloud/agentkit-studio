/** Declared public observations only. No remote tool execution or permission
 * is inferred from these frames. Based on reference355059d presentation.py and
 * _a2a_tool_activity.py; bounded state is committed by the original caller. */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { a2aIdentity } from './native-a2a-events.mjs';

export const A2A_TOOL_ACTIVITY_URI = 'urn:ksadk:a2a:tool-activity:v1';
const schema = 'ksadk.a2a.tool-activity/v1', eventLimit = 16 * 1024, invocationLimit = 1024 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const truth = value => object(value) ? Object.keys(value).length > 0 : Array.isArray(value) ? value.length > 0 : Boolean(value);
export const hasA2AActivityDeclaration = artifact => truth(artifact?.metadata?.extension_uri);
// Pydantic's Rust regex uses Unicode White_Space for IDs. Python re adds
// U+001C..001F for the public-payload scanners; JS \s instead adds BOM.
const white = /[\x09-\x0d\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const pythonSpace = '\\x09-\\x0d\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const identity = value => typeof value === 'string' && Array.from(value).length > 0 && Array.from(value).length <= 256
  && !white.test(Array.from(value)[0]) && !white.test(Array.from(value).at(-1)) && !value.includes('\n');
const sensitiveKey = /(?:^|[_-])(authorization|cookie|credential|password|permit|secret|token|api[_-]?key)(?:$|[_-])|stack(?:[_-]?trace)?|trace[_-]?back|exception/iu;
const sensitiveValue = new RegExp(`(?<![\\p{L}\\p{N}_])(?:Bearer[${pythonSpace}]+[^${pythonSpace}]{4,}|(?:api[_ -]?key|password|secret|token)[${pythonSpace}]*[:=][${pythonSpace}]*[^${pythonSpace}]{4,})`, 'iu');
const urlPattern = new RegExp(`https?://[^${pythonSpace}(){}<>"']+`, 'giu');
// Python re.IGNORECASE includes the dotted/dotless I variants in ASCII labels.
const caseVariants = value => value.replace(/[\u0130\u0131]/gu, 'i');
const redacted = new Set(['[REDACTED]', '[REDACTED_INTERNAL_URL]']);
function address(host) {
  if (isIP(host) === 4) return host.split('.').reduce((n, part) => n * 256n + BigInt(part), 0n);
  let raw = host;
  if (raw.includes('.')) {
    const split = raw.lastIndexOf(':'), v4 = address(raw.slice(split + 1));
    raw = raw.slice(0, split + 1) + (v4 >> 16n).toString(16) + ':' + (v4 & 65535n).toString(16);
  }
  const [left, right] = raw.split('::'), head = left ? left.split(':') : [], tail = right ? right.split(':') : [];
  const parts = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  return parts.reduce((n, part) => (n << 16n) + BigInt('0x' + part), 0n);
}
const ranges = list => list.map(cidr => { const [host, bits] = cidr.split('/'); return { base: address(host), bits: BigInt(bits) }; });
const v4Private = ranges(['0.0.0.0/8','10.0.0.0/8','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','240.0.0.0/4','100.64.0.0/10']);
const v6Private = ranges(['::1/128','::/128','64:ff9b:1::/48','100::/64','2001::/23','2001:db8::/32','2002::/16','3fff::/20','fc00::/7','fe80::/10']);
const v6Exceptions = ranges(['2001:1::1/128','2001:1::2/128','2001:3::/32','2001:4:112::/48','2001:20::/28','2001:30::/28']);
const inRange = (number, bits, set) => set.some(range => number >> (bits - range.bits) === range.base >> (bits - range.bits));
function nonGlobal4(number) { return number !== 0xc0000009n && number !== 0xc000000an && inRange(number, 32n, v4Private); }
export function a2aNonGlobalAddress(host) {
  const raw = host.split('%')[0], version = isIP(raw);
  if (!version) return false;
  const number = address(raw);
  if (version === 4) return nonGlobal4(number);
  if (number >> 32n === 65535n) return nonGlobal4(number & 0xffffffffn);
  return inRange(number, 128n, v6Private) && !inRange(number, 128n, v6Exceptions);
}
function internalUrl(value) {
  for (const match of value.matchAll(urlPattern)) {
    const authority = match[0].replace(/^https?:\/\//iu, '').split(/[/?#]/u)[0];
    const normalized = authority.replace(/[@:#?]/gu, '').normalize('NFKC');
    if (/[/?#@:]/u.test(normalized)) return true;
    const target = authority.slice(authority.lastIndexOf('@') + 1); let host;
    if (target.includes('[') || target.includes(']')) {
      const bracket = target.match(/^\[([^\]]+)\](?::.*)?$/u);
      if (!bracket || isIP(bracket[1].split('%')[0]) !== 6 && !/^v[0-9a-f]+\..+$/iu.test(bracket[1])) return true;
      host = bracket[1];
    } else host = target.split(':')[0];
    host = host.toLowerCase().replace(/\.+$/u, '');
    if (host === 'localhost' || /\.(?:internal|local|localhost)$/u.test(host) || a2aNonGlobalAddress(host)) return true;
  }
  return false;
}
function unsafe(value) {
  if (Array.isArray(value)) return value.some(unsafe);
  if (object(value)) return Object.entries(value).some(([key, child]) => {
    const normalized = key.replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2').replace(/([a-z0-9])([A-Z])/gu, '$1_$2');
    return sensitiveKey.test(caseVariants(normalized)) && child !== '[REDACTED]' || unsafe(child);
  });
  return typeof value === 'string' && !redacted.has(value) && (internalUrl(value) || sensitiveValue.test(caseVariants(value)));
}
const compare = (a, b) => {
  const aa = Array.from(a, c => c.codePointAt(0)), bb = Array.from(b, c => c.codePointAt(0));
  for (let i = 0; i < Math.min(aa.length,bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
};
/** Python's double-valued JSON domain; sort/ASCII choices match the reference
 * fingerprint. Pydantic's event quota uses a different float representation.
 * Neither is a legacy DB digest. */
export function a2aActivityJson(value, { sorted = false, ascii = false, pydantic = false } = {}) {
  if (typeof value === 'number') {
    if (Object.is(value,-0)) return '-0.0';
    const abs=Math.abs(value);
    if (abs && (abs < (pydantic ? 1e-5 : 1e-4) || abs >= 1e16)) return value.toExponential().replace(/e([+-])(\d+)$/u,
      (_,sign,exponent)=>pydantic ? `e${sign==='-'?'-':''}${exponent}` : `e${sign}${exponent.padStart(2,'0')}`);
    return Number.isInteger(value) ? value + '.0' : String(value);
  }
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return ascii ? JSON.stringify(value).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')) : JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(child=>a2aActivityJson(child,{sorted,ascii,pydantic})).join(',') + ']';
  const keys=Object.keys(value); if (sorted) keys.sort(compare);
  return '{' + keys.map(key=>a2aActivityJson(key,{sorted,ascii,pydantic})+':'+a2aActivityJson(value[key],{sorted,ascii,pydantic})).join(',') + '}';
}
const fields = new Set(['schema','schema_','event_id','item_id','call_id','item_kind','operation','execution_status','name','arguments','result','is_error','visibility','truncated']);
function activity(raw) {
  const code='A2A_TOOL_ACTIVITY_INVALID'; invariant(object(raw) && Object.keys(raw).every(key=>fields.has(key)),code);
  invariant(!Object.hasOwn(raw,'schema') || !Object.hasOwn(raw,'schema_'),code);
  const fallback=(field,value)=>Object.hasOwn(raw,field)?raw[field]:value;
  const value={schema:fallback('schema',fallback('schema_',schema)),event_id:raw.event_id,item_id:raw.item_id,call_id:raw.call_id,item_kind:raw.item_kind,
    operation:raw.operation,execution_status:raw.execution_status,name:raw.name ?? null,arguments:raw.arguments ?? null,result:raw.result ?? null,
    is_error:fallback('is_error',false),visibility:fallback('visibility','public'),truncated:fallback('truncated',false)};
  invariant(value.schema===schema && ['event_id','item_id','call_id'].every(key=>identity(value[key])) && ['tool_call','tool_result'].includes(value.item_kind)
    && ['started','updated','completed','failed'].includes(value.operation) && ['running','completed','failed','unknown'].includes(value.execution_status)
    && (value.name===null || typeof value.name==='string' && /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(value.name))
    && typeof value.is_error==='boolean' && typeof value.truncated==='boolean' && value.visibility==='public',code);
  invariant(!unsafe({arguments:value.arguments,result:value.result}) && (value.item_kind==='tool_call' ? value.name!==null && value.result===null : value.arguments===null)
    && (!value.is_error || value.execution_status==='failed') && (value.operation!=='failed' || value.execution_status==='failed'),code);
  invariant(Buffer.byteLength(a2aActivityJson(value,{pydantic:true}))<=eventLimit,code); return value;
}
/** Callee-side public disclosure. The same scanners validate outbound observations. */
export function buildA2aPublicToolActivity(payload) {
  let truncated = payload.truncated === true;
  function sanitize(value, depth = 0) {
    if (depth > 64) { truncated = true; return '[truncated]'; }
    if (Array.isArray(value)) {
      if (value.length > 128) truncated = true;
      return value.slice(0, 128).map(child => sanitize(child, depth + 1));
    }
    if (object(value)) {
      const entries = Object.entries(value), clean = {};
      if (entries.length > 128) truncated = true;
      for (const [raw, child] of entries.slice(0, 128)) {
        const key = Array.from(raw).slice(0, 256).join('');
        const normalized = key.replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2').replace(/([a-z0-9])([A-Z])/gu, '$1_$2');
        const sensitive = sensitiveKey.test(caseVariants(normalized));
        if (sensitive) truncated = true;
        Object.defineProperty(clean, key, { value: sensitive ? '[REDACTED]' : sanitize(child, depth + 1), enumerable: true, configurable: true });
      }
      return clean;
    }
    if (typeof value === 'string') {
      if (internalUrl(value)) { truncated = true; return '[REDACTED_INTERNAL_URL]'; }
      if (sensitiveValue.test(caseVariants(value))) { truncated = true; return '[REDACTED]'; }
      if (Array.from(value).length > 4096) { truncated = true; return Array.from(value).slice(0, 4096).join('') + '…[truncated]'; }
    }
    return value;
  }
  const result = { ...payload, arguments: sanitize(payload.arguments ?? null), result: sanitize(payload.result ?? null) };
  result.truncated = truncated;
  if (Buffer.byteLength(a2aActivityJson(result, { pydantic: true })) > eventLimit) {
    for (const field of ['arguments', 'result']) if (result[field] !== null)
      result[field] = { summary: 'public tool payload omitted by size policy' };
    result.truncated = true;
  }
  return activity(result);
}
/** Returns false only for ordinary artifacts. `state` belongs to an unpublished
 * checkpoint shadow; caller commits it and emitted facts in one transaction. */
export function mapA2AToolActivity({ artifact, state, scope, remoteId, emit }) {
  const declared=artifact.metadata?.extension_uri;
  if (!hasA2AActivityDeclaration(artifact)) return false;
  state.toolActivities ??= {}; state.toolActivityBytes ??= 0;
  invariant(object(state.toolActivities) && Number.isSafeInteger(state.toolActivityBytes) && state.toolActivityBytes>=0 && state.toolActivityBytes<=invocationLimit,'A2A_CANONICAL_CHECKPOINT_INVALID');
  for (const [index,part] of (artifact.parts ?? []).entries()) {
    const id=a2aIdentity('item','a2a-tool',scope,artifact.artifactId ?? '',index), previous=state.toolActivities[id];
    let content,kind,terminal,occurrence,prior=previous;
    try {
      invariant(declared===A2A_TOOL_ACTIVITY_URI,'A2A_TOOL_ACTIVITY_INVALID');
      const value=activity(part.data), encoded=a2aActivityJson(value,{sorted:true,ascii:true});
      const digest=createHash('sha256').update(encoded).digest('hex');
      if (previous?.digest===digest) continue;
      invariant(!previous?.closed,'A2A_TOOL_CLOSED_CONFLICT');
      const size=Buffer.byteLength(encoded); invariant(state.toolActivityBytes+size<=invocationLimit,'A2A_TOOL_ACTIVITY_INVALID'); state.toolActivityBytes+=size;
      const partId=a2aIdentity('part','a2a',id,'public-tool'),callId=a2aIdentity('item','a2a-tool',scope,value.call_id);
      kind=value.item_kind;terminal=['completed','failed'].includes(value.operation);occurrence=value.event_id;
      content=kind==='tool_call'?{content_type:kind,part_id:partId,call_id:callId,name:value.name,arguments:value.arguments}
        :{content_type:kind,part_id:partId,call_id:callId,result:value.result,is_error:value.is_error};
      state.toolActivities[id]={digest,closed:terminal};
    } catch (error) {
      if (error?.code==='A2A_TOOL_CLOSED_CONFLICT') throw error;
      if (previous) continue;
      occurrence='extension-degraded';content={content_type:'data',part_id:a2aIdentity('part','a2a',id,'diagnostic'),data:{code:'A2A_TOOL_ACTIVITY_UNAVAILABLE'}};
      kind='status';terminal=true;prior=null;state.toolActivities[id]={digest:occurrence,closed:true};
    }
    const source={framework:'a2a',protocol:null,native_event_id:null,native_cursor:null,native_run_id:remoteId,native_item_id:artifact.artifactId ?? '',metadata:{remote_observation:true}};
    if (!prior) emit('item.started',id,kind,{phase:null,initial:null},source,occurrence);
    if (terminal) emit('item.completed',id,kind,{snapshot:{parts:[content]}},source,occurrence);
    else emit('item.updated',id,kind,{op:'replace',update:content},source,occurrence);
  }
  return true;
}
