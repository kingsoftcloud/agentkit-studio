import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {connectorIconTheme,indexConnectorLogos,loadConnectorLogos,applyConnectorArtwork} from '../scripts/workbuddy/connector-artwork.mjs';
import {functionalIconSvg} from '../scripts/workbuddy/skill-artwork.mjs';

test('connector logos use canonical identity and explicit aliases, refusing ambiguous brands',()=>{
  const a={key:'Brand-A',aliases:['declared-mcp','ambiguous','brand-b']};
  const b={key:'brand-b',aliases:['ambiguous']};
  const {logos,ambiguous}=indexConnectorLogos([a,b]);
  assert.equal(logos['brand-a'],a);
  assert.equal(logos['declared-mcp'],a);
  assert.equal(logos['brand-b'],b);
  assert.equal(logos.ambiguous,undefined);
  assert.deepEqual(ambiguous,['ambiguous']);
  assert.equal(Object.getPrototypeOf(logos),null);
});

test('connector functional icons reflect the service and unknown services receive a plug',()=>{
  for(const [name,theme]of [['qqmail','mail'],['腾讯会议','calendar'],['权限中台助手','security'],['sheetagent','spreadsheet'],['HR数仓查询','database'],['singstat','analytics'],['ChatCut 视频剪辑师','video'],['design-converter','image'],['hr-ai-knowledge','search'],['hr-claw-app','business'],['huijin-workflow','workflow'],['context7','code'],['an-unknown-service','connector']]) {
    assert.equal(connectorIconTheme({name,preset:{key:name}}),theme,name);
  }
  assert.equal(connectorIconTheme({name:'未知服务',description:'读取文件和网盘'}),'storage');
  assert.notEqual(functionalIconSvg('connector'),functionalIconSvg('skill'));
  assert.notEqual(functionalIconSvg('mail'),functionalIconSvg('database'));
});

test('connector artwork only reads its own logo and declared server names; other resources remain intact',async()=>{
  const root=await mkdtemp(join(tmpdir(),'connector-artwork-'));
  try {
    await mkdir(join(root,'icons'));await mkdir(join(root,'connectors','jinshuju'),{recursive:true});
    // A minimal PNG fixture exercises identity selection without an optional SVG CLI dependency.
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=','base64');
    await writeFile(join(root,'icons','jinshuju.png'),png);
    await writeFile(join(root,'connectors','jinshuju','mcp.json'),JSON.stringify({mcpServers:{'form-service':{headers:{Authorization:'must-never-enter-logo-index'}}}}));
    const index=await loadConnectorLogos({connectorRoot:root,output:join(root,'originals')});
    assert.equal(index.logos['form-service'].key,'jinshuju');
    assert.equal(index.logos['jinshuju-table'].key,'jinshuju');
    assert.equal(JSON.stringify(index).includes('must-never-enter-logo-index'),false);
    const rows=['form-service','jinshuju-table'].map(key=>({kind:'mcp',name:'unrelated expert name',preset:{key},artwork:{blobId:'wrong-expert-portrait'}}));
    const skill={kind:'skill',name:'skill',artwork:{blobId:'retained-skill-logo'}},team={kind:'team',artwork:{blobId:'retained-team'}};
    const catalog={items:[{name:'retained-agent'}],resources:[...rows,skill,team],packages:{unchanged:true}};
    const original=structuredClone(catalog);
    const result=await applyConnectorArtwork({catalog,logos:index.logos,output:join(root,'artwork')});
    assert.equal(result.report.originalLogos,2);assert.equal(result.images.length,1);
    assert.equal(rows[0].artwork.source,'connector-logo');
    assert.equal(rows[0].artwork.logoKey,'jinshuju');
    assert.equal(rows[0].artwork.sha256,createHash('sha256').update(png).digest('hex'));
    assert.deepEqual(catalog.items,original.items);assert.deepEqual(catalog.packages,original.packages);
    assert.deepEqual(skill,original.resources[2]);assert.deepEqual(team,original.resources[3]);
    assert.deepEqual(rows.map(({artwork,...row})=>row),original.resources.slice(0,2).map(({artwork,...row})=>row));
  }finally{await rm(root,{recursive:true,force:true});}
});
