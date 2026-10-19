import test from 'node:test';
import assert from 'node:assert/strict';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';
import { createAssistantRoutes } from '../src/host/routes/assistant.mjs';
import { createProductClient } from '../src/remote/control-client.mjs';
import { ASSISTANT_ATTACHMENT_CAPABILITIES, ASSISTANT_UPLOAD_BODY_BYTES, ASSISTANT_UPLOAD_CHANNEL } from '../src/contracts/assistant-attachments.mjs';
import { assistantInputLimit, encodeAssistantInput, readAssistantResponse, assistantCloudFailure } from '../src/assistant-transport.mjs';

test('only attachment upload receives the bounded large-body allowance', async t => {
  const calls = [], assistant = async (op, payload) => { calls.push({op, payload}); return {accepted:true}; };
  Object.assign(assistant, {attachmentUploadSupported:true, contentSupported:true, fileReadSupported:true});
  const token='fixture-assistant-transport-not-a-live-token';
  const runtime=await startBuildRuntimeHttp({agentId:'a',buildId:'build_0123456789abcdef0123',token,runner:async()=>{},assistant,port:0});
  t.after(()=>runtime.close());
  const base=`http://127.0.0.1:${runtime.address.port}`, headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  const large={data:'a'.repeat(300*1024)};
  for(const op of ['submit','snapshot','file-read','unknown']) {
    const response=await fetch(`${base}/v1/assistant/${op}`,{method:'POST',headers,body:JSON.stringify(large)});
    assert.equal(response.status,413);
    assert.equal((await response.json()).error.code,'RUNTIME_INPUT_TOO_LARGE');
  }
  assert.equal(calls.length,0);
  assert.equal((await fetch(`${base}/v1/assistant/attachment-upload`,{method:'POST',headers,body:JSON.stringify(large)})).status,200);
  assert.equal(calls.length,1);
  const oversized=await fetch(`${base}/v1/assistant/attachment-upload`,{method:'POST',headers,body:JSON.stringify({data:'a'.repeat(ASSISTANT_UPLOAD_BODY_BYTES)})});
  assert.equal(oversized.status,413);assert.equal(calls.length,1);
  const caps=(await (await fetch(`${base}/v1/agentkit/runtime`,{headers})).json()).capabilities;
  for(const capability of Object.values(ASSISTANT_ATTACHMENT_CAPABILITIES))assert.ok(caps.includes(capability));
  assert.equal(assistantInputLimit('attachment-upload'),ASSISTANT_UPLOAD_BODY_BYTES);
  assert.equal(assistantInputLimit('submit'),256*1024);
});

test('Host checks live attachment capabilities before forwarding bytes or content', async()=>{
  let calls=0;
  const connected={agent:{spec:{runtime:{type:'dsh-native'}}},endpoint:'https://runtime.example.test',token:'fixture-token',capabilities:['personal-assistant/v1']};
  const route=createAssistantRoutes({deployments:async()=>({agents:{connect:async()=>connected}}),fetchImpl:async()=>{calls++;return Response.json({accepted:true});}});
  for(const [operation,input] of [['attachment-upload',{}],['file-read',{}],['submit',{content:[]}],['approval-decide',{}]])await assert.rejects(route('assistant/execute',{agentId:'a',operation,input}),{code:'ASSISTANT_IMAGE_UPGRADE_REQUIRED'});
  assert.equal(calls,0);
  connected.capabilities.push(...Object.values(ASSISTANT_ATTACHMENT_CAPABILITIES));
  assert.equal((await route('assistant/execute',{agentId:'a',operation:'attachment-upload',input:{data:'synthetic'}})).value.accepted,true);
  assert.equal(calls,1);
  connected.capabilities.push('personal-assistant-approval-bridge/v1');
  assert.equal((await route('assistant/execute',{agentId:'a',operation:'approval-decide',input:{requestId:'live-only'}})).value.accepted,true);
  assert.equal(calls,2);
  await assert.rejects(route('assistant/execute',{agentId:'a',operation:'submit',input:{text:'x'.repeat(256*1024)}}),{code:'ASSISTANT_INPUT_TOO_LARGE'});
  assert.equal(calls,2);
});

test('cloud response parsing is bounded even without a declared length', async()=>{
  assert.deepEqual(await readAssistantResponse(Response.json({accepted:true})),{accepted:true});
  await assert.rejects(readAssistantResponse(new Response('{}',{headers:{'content-length':String(ASSISTANT_UPLOAD_BODY_BYTES+1)}})),{code:'ASSISTANT_RESPONSE_TOO_LARGE'});
  let cancelled=false;
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(ASSISTANT_UPLOAD_BODY_BYTES+1));},cancel(){cancelled=true;}});
  await assert.rejects(readAssistantResponse(new Response(stream)),{code:'ASSISTANT_RESPONSE_TOO_LARGE'});
  assert.equal(cancelled,true);
  await assert.rejects(readAssistantResponse(new Response('not json')),{code:'ASSISTANT_RESPONSE_INVALID'});
  assert.throws(()=>encodeAssistantInput('submit',[]),{code:'ASSISTANT_INPUT_INVALID'});
});

test('only allowlisted cloud failures surface without raw upstream diagnostics',()=>{
  const raw={error:{code:'ASSISTANT_ATTACHMENT_EXPIRED',message:'private provider diagnostic'}};
  const error=assistantCloudFailure(409,raw);
  assert.equal(error.code,'ASSISTANT_ATTACHMENT_EXPIRED');assert.ok(!error.message.includes('private'));
  for(const code of ['UNKNOWN','__proto__','constructor'])assert.equal(assistantCloudFailure(500,{error:{code,message:'private diagnostic'}}).code,'ASSISTANT_CLOUD_REQUEST_FAILED');
});

test('attachment transport forwards an optional cancellation signal unchanged',async()=>{
  const calls=[];const connection={rpc:{call:async(...args)=>{calls.push(args);return {ok:true,value:{accepted:true}};}}};
  const client=createProductClient(connection,{window:{__AGENTKIT_STUDIO__:{},location:{hash:''}}});
  const controller=new AbortController();
  await client.assistantExecute('a','attachment-upload',{data:'synthetic'},controller.signal);
  assert.equal(calls[0][0],ASSISTANT_UPLOAD_CHANNEL);
  assert.equal(calls[0][1],'assistant/execute');
  assert.equal(calls[0][3],controller.signal);
  await client.assistantExecute('a','submit',{text:'fixture'});
  assert.equal(calls[1][0],'/agentkit');
});

test('native carrier negotiates its own capability and does not widen upload limits', async () => {
  const calls = [], connected = { agent: { spec: { runtime: { type: 'dsh-native' } }, deployment: { id: 'receipt-a', buildId: 'build-a', versionId: 'initial' } }, endpoint: 'https://runtime.example.test', token: 'fixture-token', capabilities: ['personal-assistant/v1'] };
  const route = createAssistantRoutes({ deployments: async () => ({ agents: { connect: async () => connected } }), fetchImpl: async (url, init) => { calls.push({url, init}); return Response.json({ carrierId: 'memory-handle' }); } });
  for (const operation of ['native-open', 'native-call', 'native-stream-open', 'native-stream-poll', 'native-stream-cancel', 'native-close']) {
    await assert.rejects(route('assistant/execute', { agentId: 'a', operation, input: {} }), { code: 'ASSISTANT_IMAGE_UPGRADE_REQUIRED' });
    assert.equal(assistantInputLimit(operation), 256 * 1024);
  }
  assert.equal(calls.length, 0);
  connected.capabilities.push('personal-assistant-native-carrier/v1');
  assert.equal((await route('assistant/execute', { agentId: 'a', operation: 'native-open', input: { conversation: 'own' } })).value.carrierId, 'memory-handle');
  assert.equal(calls[0].url, 'https://runtime.example.test/v1/assistant/native-open');
  const open = () => route('assistant/execute', {agentId:'a',operation:'native-open',input:{conversation:'own'}});
  const scopeA = (await open()).value.journalScope;
  assert.match(scopeA,/^[a-f0-9]{64}$/); assert.equal((await open()).value.journalScope,scopeA);
  connected.agent.deployment.versionId = 'version-b';
  assert.notEqual((await open()).value.journalScope,scopeA);
  delete connected.agent.deployment;
  await assert.rejects(open(),{code:'ASSISTANT_NATIVE_UNAVAILABLE'});
});

test('native read disconnect aborts its carrier poll but durable submit ignores client lifetime', async t => {
  const observations = []; let pollStarted;
  const started = new Promise(resolve => { pollStarted = resolve; });
  const assistant = async (operation, _payload, options) => {
    observations.push({ operation, signal: options?.signal });
    if (operation === 'native-stream-poll') {
      pollStarted();
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      return { items: [], ended: true };
    }
    return { accepted: true };
  };
  let disposed = 0; assistant.dispose = () => { disposed++; }; assistant.nativeCarrierSupported = true;
  const token = 'fixture-native-carrier-transport-secret';
  const runtime = await startBuildRuntimeHttp({ agentId: 'a', buildId: 'build_0123456789abcdef0123', token, runner: async () => {}, assistant, port: 0 });
  t.after(() => runtime.close());
  const base = `http://127.0.0.1:${runtime.address.port}`, headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const caps = await (await fetch(`${base}/v1/agentkit/runtime`, {headers})).json();
  assert.ok(caps.capabilities.includes('personal-assistant-native-carrier/v1'));
  const cancel = new AbortController();
  const poll = fetch(`${base}/v1/assistant/native-stream-poll`, { method: 'POST', headers, body: '{}', signal: cancel.signal }).catch(error => error);
  await started; cancel.abort(); await poll;
  const deadline = Date.now() + 1000;
  while (!observations[0].signal.aborted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(observations[0].signal.aborted, true);
  assert.equal((await fetch(`${base}/v1/assistant/submit`, { method: 'POST', headers, body: '{}' })).status, 202);
  assert.equal(observations[1].signal, undefined);
  await runtime.close(); assert.equal(disposed, 1);
});
