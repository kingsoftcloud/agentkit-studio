/** Connector identity comes from its own marketplace key or explicitly declared MCP key. */
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {join,basename,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {createArtworkRenderer,functionalIconSvg} from './skill-artwork.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const keyOf=value=>String(value||'').trim().toLowerCase();
// Reviewed product variants; never infer brands from a gateway host or containing expert.
const productAliases={'jinshuju':['jinshuju-form','jinshuju-table']};
const rules=[
  ['mail',/mail\b|smtp|imap|邮箱|邮件/i],
  ['calendar',/calendar|schedule|meeting|日历|日程|会议/i],
  ['security',/auth|permission|security|权限|认证|安全/i],
  ['spreadsheet',/spreadsheet|sheetagent|excel|表格|表单/i],
  ['database',/database|starrocks|sql|数仓|数据库/i],
  ['analytics',/singstat|statistic|analytics|统计|分析|数据/i],
  ['video',/chatcut|video|视频|剪辑/i],
  ['image',/ardot|design|canva|image|设计|图片/i],
  ['pdf',/pdf|ocr|扫描/i],
  ['audio',/music|audio|音乐|音频/i],
  ['finance',/finance|stock|金融|股票|财务/i],
  ['search',/search|grep_app|knowledge|检索|搜索|知识/i],
  ['code',/context7|godot|testbuddy|github|code|dev|game|代码|开发/i],
  ['writing',/document|docs?|文档|写作/i],
  ['storage',/drive|storage|file|网盘|文件/i],
  ['marketing',/marketing|营销|电商/i],
  ['chat',/chat|message|沟通|聊天|消息/i],
  ['location',/maps?|location|地图|位置/i],
  ['business',/recruit|\bhr\b|^hr[-_]|erp|crm|招聘|自评|人事|客户|商机/i],
  ['cloud',/cloud|云平台|云服务/i],
  ['workflow',/workflow|requirement|agent|claw|ssvskillhub|流程|需求|自动化/i],
];
export function connectorIconTheme(item) {
  for(const text of [[item.preset?.key,item.name].filter(Boolean).join(' '),item.description||'']) {
    for(const [theme,pattern]of rules)if(pattern.test(text))return theme;
  }
  return 'connector';
}

export function indexConnectorLogos(entries) {
  const exact=new Map(),aliases=new Map();
  for(const entry of entries) {
    const key=keyOf(entry.key);exact.set(key,entry);
    for(const alias of entry.aliases||[]) {
      const name=keyOf(alias);if(!name)continue;
      const matches=aliases.get(name)||new Map();matches.set(key,entry);aliases.set(name,matches);
    }
  }
  const logos=Object.create(null),ambiguous=[];
  for(const [name,matches]of aliases) {
    if(exact.has(name))continue;
    if(matches.size===1)logos[name]=[...matches.values()][0];else ambiguous.push(name);
  }
  for(const [key,entry]of exact)logos[key]=entry;
  return {logos,ambiguous};
}

/** Read only public image bytes and MCP server names, never copy connector account/config data. */
export async function loadConnectorLogos({connectorRoot,output}) {
  if(output)await mkdir(output,{recursive:true,mode:0o700});
  const entries=[],failures=[];
  const files=(await readdir(join(connectorRoot,'icons'),{withFileTypes:true})).filter(row=>row.isFile()&&/\.(png|jpe?g|webp|svg)$/i.test(row.name)).sort((a,b)=>a.name.localeCompare(b.name));
  for(const row of files) {
    const extension=extname(row.name).toLowerCase(),key=basename(row.name,extname(row.name));
    const file=join(connectorRoot,'icons',row.name),bytes=await readFile(file);
    if(!bytes.length||bytes.length>4*1024*1024){failures.push({key,reason:'invalid-logo-size'});continue;}
    let aliases=[];
    try {const definition=JSON.parse(await readFile(join(connectorRoot,'connectors',key,'mcp.json'),'utf8'));aliases=Object.keys(definition.mcpServers||{});}catch{/* Canonical image key is still usable without a cached definition. */}
    aliases.push(...(productAliases[keyOf(key)]||[]));
    const sha256=hash(bytes),snapshot=output?join(output,sha256+extension):file;
    if(output)await writeFile(snapshot,bytes,{mode:0o600});
    entries.push({key,aliases,file:snapshot,format:extension==='.svg'?'svg':'raster',sha256});
  }
  return {...indexConnectorLogos(entries),failures,sourceImages:entries.length};
}

export async function applyConnectorArtwork({catalog,output,logos={},rasterizer='rsvg-convert'}) {
  const renderer=await createArtworkRenderer({output,rasterizer}),themes=new Map();
  const report={connectors:0,originalLogos:0,functionalIcons:0,replacedPreviousArtwork:0,logoFailures:[]};
  for(const item of catalog.resources.filter(row=>row.kind==='mcp')) {
    report.connectors++;if(item.artwork)report.replacedPreviousArtwork++;
    // Ignore previous artwork completely: it may have been a generic icon or an expert portrait.
    let picture,source,logoKey;
    const key=keyOf(item.preset?.key),logo=Object.hasOwn(logos,key)?logos[key]:undefined;
    if(logo) {
      try {
        const bytes=await readFile(logo.file);if(hash(bytes)!==logo.sha256)throw new Error('Logo changed');
        picture=await renderer.image(bytes,logo.format==='svg');source='connector-logo';logoKey=logo.key;
      }catch {report.logoFailures.push({key,logoKey:logo.key,reason:'invalid-or-unrenderable-logo'});}
    }
    if(!picture) {
      const theme=connectorIconTheme(item);
      if(!themes.has(theme))themes.set(theme,await renderer.image(Buffer.from(functionalIconSvg(theme)),true));
      picture=themes.get(theme);source='functional-icon';logoKey=theme;
    }
    if(source==='connector-logo')report.originalLogos++;else report.functionalIcons++;
    item.artwork={path:basename(picture.file),packagePath:'artwork',blobId:picture.sha256,sha256:picture.sha256,source,logoKey};
  }
  return {report,images:renderer.images()};
}
