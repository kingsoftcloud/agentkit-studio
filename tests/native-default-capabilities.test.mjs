import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentStore } from '../src/agent-store.mjs';
import { defaultNativeToolBindings, nativeLocalToolResources } from '../src/native-tool-catalog.mjs';
import { nativeDefaultToolsFromCatalog } from '../src/native-capability-defaults.mjs';

test('default authoring admits available built-ins, never external namesakes or unconfigured search', () => {
 const refs=defaultNativeToolBindings({env:{KSADK_SANDBOX_BACKEND:'local_process'}}).map(ref=>ref.resourceId);
 for(const name of ['read_workspace_file','write_workspace_file','edit_workspace_file','apply_workspace_patch','web_fetch','run_command']) assert.ok(refs.includes(name));
 assert.equal(refs.includes('web_search'),false);
 const catalog=nativeLocalToolResources({env:{KSADK_SANDBOX_BACKEND:'local_process',KSADK_WEB_SEARCH_PROVIDER:'http',KSADK_WEB_SEARCH_BASE_URL:'https://example.com/search'}});
 assert.ok(nativeDefaultToolsFromCatalog(catalog).includes('web_search'));
 assert.deepEqual(nativeDefaultToolsFromCatalog([{resourceId:'run_command',source:'external',status:'available'}]),[]);
});

test('new Native agents freeze automatic capabilities; explicit restrictions, old revisions and other runtimes retain their scope', async t => {
 const directory=await mkdtemp(join(tmpdir(),'native-auto-capabilities-')); t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=createAgentStore({storeDir:directory});
 const auto=await store.create({name:'Automatic Native'});
 assert.ok(auto.bindings.tools.some(ref=>ref.resourceId==='edit_workspace_file'));
 const before=structuredClone(auto.bindings.tools);
 await store.update(auto.metadata.id,{name:'Renamed',expectedRevision:1});
 assert.deepEqual((await store.getRevision(auto.metadata.id,1)).bindings.tools,before);
 assert.deepEqual((await store.get(auto.metadata.id)).bindings.tools,before);
 const restricted=await store.create({name:'Explicit chat',runtimeType:'harness',bindings:{tools:[]}});
 assert.deepEqual(restricted.bindings.tools,[]);
 for(const runtimeType of ['codex','dsh-native']) {
  const other=await store.create({name:runtimeType,runtimeType}); assert.equal(other.bindings.tools?.length??0,0);
 }
});
