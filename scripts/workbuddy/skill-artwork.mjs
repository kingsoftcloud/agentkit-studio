/** Skill imagery must identify the Skill itself, never its containing expert. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const rules=[
  ['security',/authenticat|authoriz|permission|security|privacy|secret|password|audit|safety|安全|权限|认证|审计/i],
  ['spreadsheet',/xlsx|excel|spreadsheet|sheetagent|sheets?\b|表格|电子表/i],
  ['presentation',/pptx?|slides?|presentation|deck|演示|幻灯/i],
  ['pdf',/pdf|ocr|扫描/i],
  ['video',/video|film|movie|animate|remotion|视频|剪辑|运镜/i],
  ['audio',/audio|music|podcast|speech|tts|声音|音频|音乐|播客/i],
  ['image',/image|photo|picture|illustrat|design|canvas|图像|图片|设计|海报/i],
  ['browser',/browser|web-access|playwright|puppeteer|selenium|浏览器|网页访问/i],
  ['finance',/westock|neodata|stock|finance|financial|valuation|invest|tax|invoice|trading|金融|财务|投资|股票|税务|发票/i],
  ['database',/database|bigdata|data.?integration|table-|sql|kafka|pulsar|inlong|hive|hdfs|spark|flink|starrocks|存储|数据库/i],
  ['analytics',/analys|analytics|chart|dashboard|metric|statistics|data|分析|数据|统计|仪表盘/i],
  ['code',/code|python|github|gitlab|debug|typescript|javascript|react|frontend|backend|deploy|开发|代码|调试|部署/i],
  ['mail',/email|e-mail|smtp|imap|mail\b|邮件|邮箱/i],
  ['calendar',/calendar|schedule|meeting|todo|日历|日程|会议|待办/i],
  ['search',/search|research|query|retriev|检索|搜索|研究|查询/i],
  ['writing',/writ|book|humaniz|copywrit|markdown|docx|document|report|文档|写作|论文|报告/i],
  ['marketing',/market|campaign|sales|customer|commerce|品牌|营销|销售|电商/i],
  ['learning',/learn|teach|education|study|course|学习|教学|教育|课程/i],
  ['storage',/folder|drive|disk|file|文件|网盘/i],
  ['workflow',/workflow|automat|agent|orchestrat|工作流|自动化/i],
];
export function skillIconTheme(item) {
  for(const text of [item.name||'',item.description||''])for(const [theme,pattern]of rules)if(pattern.test(text))return theme;
  return 'skill';
}
export function findOwnSkillLogo(item,files) {
  const root=item.dependencies?.skills?.[0]?.path;if(!root)return;
  const prefix=root==='.'?'':root.replace(/\/$/,'')+'/';
  // Only explicit logos in the Skill's own directory or assets directory.
  // No recursive avatar, team, expert, README illustration or template search.
  const candidates=['icon','logo','_icon','assets/icon','assets/logo'].flatMap(name=>['png','jpg','jpeg','webp','svg'].map(ext=>prefix+name+'.'+ext));
  return candidates.map(path=>files.find(file=>file.path===path&&file.size>0&&file.size<=4*1024*1024)).find(Boolean);
}
const glyphs={
  security:'<path d="m32 11 17 7v14c0 12-17 22-17 22S15 44 15 32V18z"/><path d="m23 32 6 6 13-14" class="line"/>',
  spreadsheet:'<rect x="14" y="11" width="36" height="44" rx="5"/><path d="M15 25h34M15 35h34M15 45h34M26 25v29M38 25v29" class="line"/><path d="M22 18h18" class="line"/>',
  presentation:'<rect x="11" y="13" width="42" height="31" rx="5"/><path d="M32 44v11m-10 0 10-8 10 8" class="line"/><path d="M21 35V26m11 9V21m11 14V29" class="line"/>',
  pdf:'<path d="M17 9h24l9 10v36H17z"/><path d="M40 9v12h10M24 33h18M24 41h14" class="line"/><rect x="9" y="39" width="25" height="15" rx="4" fill="#fff2f2"/><text x="13" y="50" font-family="Arial,sans-serif" font-weight="bold" font-size="10" fill="#d54b55">PDF</text>',
  video:'<rect x="10" y="15" width="44" height="34" rx="7"/><path d="m27 24 14 8-14 8z" class="cut"/>',
  audio:'<path d="M28 16v31m0-27 20-5v27M28 20v10l20-5V15" class="line"/><ellipse cx="21" cy="46" rx="9" ry="6"/><ellipse cx="41" cy="42" rx="9" ry="6"/>',
  image:'<rect x="10" y="13" width="44" height="38" rx="7"/><circle cx="23" cy="25" r="5" class="cut"/><path d="m13 46 13-13 9 8 7-7 10 12" class="line"/>',
  browser:'<circle cx="32" cy="32" r="22"/><ellipse cx="32" cy="32" rx="10" ry="22" class="line"/><path d="M11 32h42M16 20h32M16 44h32" class="line"/>',
  finance:'<rect x="10" y="11" width="44" height="43" rx="7"/><path d="m18 42 10-11 8 4 12-16m-9 0h9v9" class="line"/>',
  database:'<path d="M12 20v25c0 11 40 11 40 0V20"/><ellipse cx="32" cy="20" rx="20" ry="9"/><path d="M13 32c5 10 33 10 38 0M13 43c5 10 33 10 38 0" class="line"/>',
  analytics:'<path d="M12 12v41h42" class="line"/><rect x="19" y="33" width="7" height="15" rx="2"/><rect x="31" y="24" width="7" height="24" rx="2"/><rect x="43" y="15" width="7" height="33" rx="2"/>',
  code:'<rect x="9" y="12" width="46" height="40" rx="7"/><path d="m24 25-8 8 8 8m16-16 8 8-8 8m-5-20-6 25" class="line"/>',
  mail:'<rect x="9" y="17" width="46" height="33" rx="6"/><path d="m11 21 21 16 21-16M12 46l14-13m26 13L38 33" class="line"/>',
  calendar:'<rect x="12" y="15" width="40" height="39" rx="6"/><path d="M13 27h38M23 10v12m18-12v12M22 36h5m10 0h5M22 45h5m10 0h5" class="line"/>',
  search:'<circle cx="28" cy="27" r="17"/><circle cx="28" cy="27" r="10" class="line"/><path d="m41 40 12 12" class="line"/>',
  writing:'<path d="M17 10h27v44H17z"/><path d="M24 22h13M24 30h10M24 38h8" class="line"/><path d="m34 48 4-12 13-17 7 6-14 17z" fill="#ffe7a6"/>',
  marketing:'<path d="m12 27 39-14v36L12 38z"/><path d="m19 39 6 15h10l-5-11M51 27h8" class="line"/>',
  learning:'<path d="m7 25 25-13 25 13-25 13zM16 33v13c10 7 23 7 33 0V33"/><path d="M56 27v20" class="line"/>',
  storage:'<path d="M9 20h19l6 7h21v23H9z"/><path d="M10 20v-6h17l6 6h21v7" class="line"/>',
  workflow:'<rect x="23" y="8" width="18" height="14" rx="4"/><rect x="6" y="42" width="18" height="14" rx="4"/><rect x="40" y="42" width="18" height="14" rx="4"/><path d="M32 23v9H15v9m17-9h17v9" class="line"/>',
  connector:'<path d="M22 23v-9m20 9v-9M18 23h28v9c0 10-7 14-14 14s-14-4-14-14z"/><path d="M32 46v9" class="link"/><path d="M26 30h12" class="line"/>',
  chat:'<path d="M10 15h44v29H29L17 54V44h-7z"/><path d="M20 25h24M20 34h17" class="line"/>',
  location:'<path d="M32 7c-12 0-20 8-20 19 0 14 20 31 20 31s20-17 20-31C52 15 44 7 32 7z"/><circle cx="32" cy="26" r="8" class="cut"/>',
  business:'<rect x="9" y="22" width="46" height="31" rx="6"/><path d="M23 22v-9h18v9" class="link"/><path d="M10 34h44M28 33v6h8v-6" class="line"/>',
  cloud:'<path d="M16 46C1 44 4 26 17 25 20 7 45 8 48 27c17 2 15 19 1 19z"/><path d="M24 35h16m-8-8v16" class="line"/>',
  skill:'<path d="m32 10 6 15 16 7-16 6-6 16-7-16-15-6 15-7z"/>',
};
const palettes={security:['#e8effc','#557ac2'],spreadsheet:['#e5f6ed','#31956b'],presentation:['#fff0e3','#dc8349'],pdf:['#ffeaec','#dd6470'],video:['#efe9fb','#8864c5'],audio:['#fff1d9','#d79b39'],image:['#f5eafa','#a66dbc'],browser:['#e8f1ff','#568ddd'],finance:['#e4f4ee','#3a9b7b'],database:['#e5f3f6','#438d9f'],analytics:['#eaf0fe','#6982d2'],code:['#eeeaff','#8470cc'],mail:['#e5f1fb','#4b93c9'],calendar:['#ffeded','#d97575'],search:['#e5f4f1','#4c9a8d'],writing:['#eaf0fa','#678ab9'],marketing:['#fbe9ef','#bf7290'],learning:['#edf4dd','#80a250'],storage:['#fff0d4','#cea04c'],workflow:['#eaeafb','#7f7dc7'],connector:['#e4f5f3','#329c91'],chat:['#e5f3fc','#3c92c1'],location:['#fdece5','#d9855b'],business:['#fff1db','#bf9443'],cloud:['#e8f0ff','#638dd1'],skill:['#eef2f7','#7d94ad']};
export function functionalIconSvg(theme) {
  if(!Object.hasOwn(glyphs,theme))theme='skill';const [bg,ink]=palettes[theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64"><rect width="64" height="64" rx="17" fill="${bg}"/><g fill="${ink}" stroke="none"><style>.line{fill:none;stroke:${bg};stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.link{fill:none;stroke:${ink};stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.cut{fill:${bg}}</style>${glyphs[theme]}</g></svg>`;
}
export const skillIconSvg=functionalIconSvg;
export function safeLogoSvg(bytes) {
  const text=bytes.toString('utf8').replace(/<!DOCTYPE\s+svg\s+PUBLIC\s+"[^"]*"\s+"[^"]*"\s*>/gi,'');
  if(!/<svg\b/.test(text)||/<!DOCTYPE|<!ENTITY|<script|<foreignObject|\bon\w+\s*=/i.test(text)
    ||/href\s*=\s*["'](?!#|data:image\/(?:png|jpeg|webp);base64,)/i.test(text)
    ||[...text.matchAll(/url\(([^)]*)\)/gi)].some(match=>!match[1].trim().replace(/^["']|["']$/g,'').startsWith('#')))throw new Error('Logo must be a self-contained static SVG');
  return text;
}
export async function createArtworkRenderer({output,rasterizer='rsvg-convert'}) {
  await mkdir(output,{recursive:true,mode:0o700});const images=new Map();
  async function image(bytes,svg=false) {
    if(bytes.length>4*1024*1024)throw new Error('Resource logo is too large');
    const digest=hash(bytes);if(images.has(digest))return images.get(digest);
    let file=join(output,digest+(svg?'.svg':'.png'));
    if(svg){await writeFile(file,safeLogoSvg(bytes),{mode:0o600});const png=join(output,digest+'.png');await run(rasterizer,['--width','128','--height','128','--output',png,file],{timeout:15000});file=png;}
    else {if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&!(bytes[0]===255&&bytes[1]===216)&&!(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'))throw new Error('Indexed logo must be PNG, JPEG, WebP or static SVG');await writeFile(file,bytes,{mode:0o600});}
    const png=await readFile(file),row={file,sha256:hash(png)};images.set(digest,row);return row;
  }
  return {image,images:()=>[...new Map([...images.values()].map(row=>[row.sha256,row])).values()]};
}
export async function applySkillArtwork({catalog,packageRoot,output,logos={},rasterizer='rsvg-convert'}) {
  const renderer=await createArtworkRenderer({output,rasterizer}),{image}=renderer,themes=new Map(),report={skills:0,originalLogos:0,functionalIcons:0,replacedPreviousArtwork:0};
  for(const item of catalog.resources.filter(row=>row.kind==='skill')) {
    report.skills++;if(item.artwork)report.replacedPreviousArtwork++;
    delete item.artwork;
    const bundle=catalog.packages[item.dependencies.package.digest],own=findOwnSkillLogo(item,bundle.files);
    let picture,origin,logoKey;
    if(own){
      const bytes=await readFile(join(packageRoot,bundle.path,own.path));if(hash(bytes)!==own.sha256)throw new Error('Skill logo changed');picture=await image(bytes,/\.svg$/i.test(own.path));origin='skill-file';logoKey=item.name;
    }else if(logos[item.name.toLowerCase()]){
      const logo=logos[item.name.toLowerCase()],bytes=await readFile(logo.file);if(hash(bytes)!==logo.sha256)throw new Error('Indexed skill logo changed');picture=await image(bytes,logo.format==='svg');origin='skill-logo';logoKey=logo.key;
    }else {
      const theme=skillIconTheme(item);if(!themes.has(theme))themes.set(theme,await image(Buffer.from(skillIconSvg(theme)),true));picture=themes.get(theme);origin='functional-icon';logoKey=theme;
    }
    if(origin==='functional-icon')report.functionalIcons++;else report.originalLogos++;
    item.artwork={path:basename(picture.file),packagePath:'artwork',blobId:picture.sha256,sha256:picture.sha256,source:origin,logoKey};
  }
  return {report,images:renderer.images()};
}
