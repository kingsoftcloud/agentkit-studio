/** Original, local SVG illustrations. No remote image requests or third-party portrait assets. */
export function createCatalogArtwork(React) {
  const h = React.createElement;
  const portraits = [
    ['#e4ebf4','#254761','#edc4a5','#263140',0], ['#f3e8d8','#4d684e','#ddb193','#382e2e',1],
    ['#e9e6f6','#7465a5','#eec8ae','#3c3041',2], ['#e7efe9','#46685d','#b77d5e','#332a29',3],
    ['#e7edf6','#5c7294','#f0cdb4','#493a35',4], ['#f1e8df','#a26c4e','#d39e7c','#2e2927',5],
    ['#f6e8e3','#bc7365','#ecc3ab','#483833',2], ['#eee8f3','#82739d','#e6b79b','#302b39',4],
    ['#f2edda','#9e854b','#bd8667','#322f30',1], ['#e2edf2','#4a798d','#f1c9ab','#343842',3],
    ['#eae9f6','#67659a','#d49c78','#37343a',0], ['#e3eee9','#538678','#ecc3a8','#4b3430',5],
    ['#eee7f2','#907899','#edc4af','#362e38',4], ['#e8edf2','#5d7c91','#bd8667','#292e36',0],
    ['#f2e8dd','#a78152','#e7bfa3','#544236',1], ['#e2eeeb','#487b72','#efc9ac','#333837',2],
    ['#f0e7df','#856b58','#bb8160','#2b292b',3], ['#ebedf7','#6a80a5','#eac2a6','#463933',5],
  ];
  const ids = ['fullstack-engineer','code-reviewer','api-architect','research-analyst','long-term-researcher','decision-advisor','editor','personal-writer','content-planner','data-analyst','metrics-designer','experiment-reviewer','meeting-assistant','project-planner','retrospective-coach','knowledge-assistant','policy-advisor','onboarding-guide'];
  function Person({ index = 0 }) {
    const [bg, coat, skin, hair, style] = portraits[index % portraits.length];
    return h('g', null,
      h('rect', { width: 80, height: 80, rx: 22, fill: bg }),
      h('circle', { cx: 64, cy: 15, r: 18, fill: '#fff', opacity: .3 }),
      style === 2 || style === 4 ? h('path', { d: 'M21 49V29C21 7 59 9 59 31v26H21Z', fill: hair }) : null,
      h('path', { d: 'M8 82v-5c0-18 13-24 32-24s32 6 32 24v5', fill: coat }),
      h('path', { d: 'M30 53l10 18 11-18-11-4Z', fill: '#faf8f3' }),
      h('path', { d: 'M34 45h12v12c-3 5-9 5-12 0Z', fill: skin }),
      h('path', { d: 'M24 29c0-18 32-18 32 0v12c0 12-9 17-16 17s-16-5-16-17Z', fill: skin }),
      h('path', { d: style === 0 ? 'M23 34V23C23 8 60 12 57 26L53 35l-3-12c-6 7-14 5-22 2l-2 11Z' : style === 1 ? 'M22 36V24C22 9 56 7 57 25l-4 11-3-14-7 4-15-1-2 12Z' : style === 2 ? 'M24 38c-6-29 30-32 33-8l-3 10-4-18c-4 9-11 12-24 11Z' : style === 3 ? 'M23 34C18 6 64 10 56 35l-6-12c-9 3-16 1-22-1l-1 14Z' : style === 4 ? 'M23 36c-4-28 36-30 34 0l-5-2-2-11c-5 10-15 9-24 8l1 8Z' : 'M23 35C17 8 58 9 57 29l-5 7-3-13c-8 7-16 7-23 4v10Z', fill: hair }),
      h('circle', { cx: 33, cy: 38, r: 1.3, fill: '#493a35' }), h('circle', { cx: 47, cy: 38, r: 1.3, fill: '#493a35' }),
      h('path', { d: 'M36 47q4 3 8 0', fill: 'none', stroke: '#ac705f', strokeWidth: 1.3, strokeLinecap: 'round' }),
      index % 3 === 0 ? h('g', { fill: 'none', stroke: '#3c4650', strokeWidth: 1.3 }, h('rect', { x: 27, y: 33, width: 11, height: 10, rx: 4 }), h('rect', { x: 42, y: 33, width: 11, height: 10, rx: 4 }), h('path', { d: 'M38 36h4' })) : null,
      style === 1 ? h('path', { d: 'M27 44q13 20 26 0l-2 9q-12 14-23 0Z', fill: hair, opacity: .8 }) : null,
      h('path', { d: 'M25 76v-9m30 9v-9', stroke: '#fff', strokeWidth: 1, opacity: .35 }));
  }
  const logos = {
    'code-reviewer': ['#173f39', [['path',{d:'M40 13 61 22v18c0 14-15 24-21 27-6-3-21-13-21-27V22Z',fill:'#6cd2aa'}],['path',{d:'m28 40 8 8 17-19',fill:'none',stroke:'#143e37',strokeWidth:6,strokeLinecap:'round',strokeLinejoin:'round'}]]],
    'api-architect': ['#eee9fa', [['path',{d:'M22 24 57 29 41 58Z',fill:'none',stroke:'#9b89cc',strokeWidth:3}],['circle',{cx:22,cy:24,r:11,fill:'#7058bc'}],['circle',{cx:57,cy:29,r:9,fill:'#b59ee7'}],['circle',{cx:41,cy:58,r:13,fill:'#49397e'}],['circle',{cx:38,cy:54,r:3,fill:'#b9a2eb'}]]],
    'research-analyst': ['#162b44', [['circle',{cx:40,cy:40,r:25,fill:'none',stroke:'#56788e',strokeWidth:1.5}],['circle',{cx:40,cy:40,r:17,fill:'none',stroke:'#56788e'}],['path',{d:'m53 20-8 25-18 15 8-25Z',fill:'#7ed3d4'}],['path',{d:'m53 20-8 25-10-10Z',fill:'#f4e6bd'}],['circle',{cx:40,cy:40,r:4,fill:'#182f45'}]]],
    'decision-advisor': ['#f3e7c9', [['path',{d:'M27 17h7v9h12v-9h7v21l-7 7v11H34V45l-7-7Z',fill:'#7e684b'}],['path',{d:'M29 55h22l6 11H23Z',fill:'#ad874c'}],['path',{d:'M34 31h12v5H34Z',fill:'#e6c68d'}],['circle',{cx:59,cy:18,r:5,fill:'#d4a74f'}]]],
    'editor': ['#e5f3f7', [['path',{d:'M19 19 40 11v28L19 48Z',fill:'#61b8e9'}],['path',{d:'m40 11 21 12v28L40 39Z',fill:'#2d84bb'}],['path',{d:'M19 48 40 39v29L19 57Z',fill:'#2e99bd'}],['path',{d:'m40 39 21 12-21 17Z',fill:'#91d3dd'}],['path',{d:'m25 24 9-4m-9 10 9-4',stroke:'#d3f1ff',strokeWidth:2}]]],
    'content-planner': ['#f7e5df', [['rect',{x:14,y:17,width:38,height:31,rx:12,fill:'#d87061'}],['path',{d:'m22 43-2 13 17-10',fill:'#d87061'}],['rect',{x:35,y:35,width:31,height:25,rx:10,fill:'#efae7b'}],['path',{d:'m58 53 6 14-14-8',fill:'#efae7b'}],['path',{d:'M24 29h18m-18 8h10',stroke:'#fff1e8',strokeWidth:3,strokeLinecap:'round'}]]],
    'data-analyst': ['#142e46', [['path',{d:'M19 62V23m0 39h47',stroke:'#50738c',strokeWidth:2}],['rect',{x:27,y:40,width:8,height:15,rx:3,fill:'#53b8cf'}],['rect',{x:40,y:30,width:8,height:25,rx:3,fill:'#87dcca'}],['rect',{x:53,y:19,width:8,height:36,rx:3,fill:'#e2d4a1'}],['path',{d:'m25 28 16-11 15-4',stroke:'#a6c4db',strokeWidth:2,fill:'none'}]]],
    'metrics-designer': ['#e4f0ed', [['circle',{cx:38,cy:42,r:24,fill:'#4b927f'}],['circle',{cx:38,cy:42,r:16,fill:'#bce1d0'}],['circle',{cx:38,cy:42,r:8,fill:'#4b927f'}],['path',{d:'m38 42 23-25m-1-7 1 7 9 1',stroke:'#e4ae52',strokeWidth:5,fill:'none',strokeLinecap:'round'}]]],
    'experiment-reviewer': ['#ebe6f6', [['path',{d:'M29 14h22m-17 0v22L19 59c-3 5 1 8 6 8h30c5 0 9-3 6-8L46 36V14',fill:'#c4b4e7',stroke:'#7863a7',strokeWidth:3,strokeLinejoin:'round'}],['path',{d:'m30 44-11 15c-3 5 1 8 6 8h30c5 0 9-3 6-8L50 44Z',fill:'#79b9bb'}],['circle',{cx:35,cy:55,r:4,fill:'#d8eee2'}],['circle',{cx:47,cy:59,r:2.5,fill:'#d8eee2'}]]],
    'project-planner': ['#f5eadb', [['path',{d:'M23 66V17h4v49Z',fill:'#607380'}],['path',{d:'M27 17h33l-9 12 9 12H27Z',fill:'#e59a43'}],['path',{d:'M17 66h47',stroke:'#c2b7a8',strokeWidth:3,strokeLinecap:'round'}],['circle',{cx:51,cy:54,r:10,fill:'#7c9b84'}],['path',{d:'m46 54 3 3 6-6',stroke:'#f5f6e8',strokeWidth:2,fill:'none'}]]],
    'retrospective-coach': ['#dfeee8', [['path',{d:'M22 30a22 22 0 0 1 40 9',stroke:'#4c8877',strokeWidth:7,fill:'none',strokeLinecap:'round'}],['path',{d:'m56 28 7 13 8-11',fill:'#4c8877'}],['path',{d:'M58 51a22 22 0 0 1-40-9',stroke:'#9dbf94',strokeWidth:7,fill:'none',strokeLinecap:'round'}],['path',{d:'m24 52-7-13-8 11',fill:'#9dbf94'}],['circle',{cx:40,cy:40,r:5,fill:'#e7b955'}]]],
    'knowledge-assistant': ['#e4eff7', [['path',{d:'m13 23 27 8v35l-27-8Z',fill:'#3f8fba'}],['path',{d:'m40 31 27-8v35l-27 8Z',fill:'#71b4cf'}],['path',{d:'m19 15 21 9 21-9v37l-21 9-21-9Z',fill:'#eaf7fa'}],['path',{d:'M40 24v37',stroke:'#b7dbe6',strokeWidth:2}],['path',{d:'m24 27 10 4m-10 4 10 4m12-8 10-4m-10 12 10-4',stroke:'#80acbc',strokeWidth:2}]]],
    'policy-advisor': ['#343d4d', [['path',{d:'M40 16v46m-16 0h32M18 29h44',stroke:'#ddbd7b',strokeWidth:3,strokeLinecap:'round'}],['path',{d:'m22 28-10 19h20Zm36 0L48 47h20Z',stroke:'#c9aa6e',strokeWidth:2,fill:'none'}],['path',{d:'M12 47h20a10 10 0 0 1-20 0m36 0h20a10 10 0 0 1-20 0',fill:'#e6c889'}],['circle',{cx:40,cy:17,r:4,fill:'#f3d7a0'}]]],
    'onboarding-guide': ['#f3e7df', [['path',{d:'m24 51 6-20 25-15 8 8-15 25-20 6Z',fill:'#f7f5e9'}],['path',{d:'m30 31-14 4-4 17 14-5m22 2-4 15-17 4 6-15',fill:'#d48158'}],['path',{d:'m22 55-6 9 11-4',fill:'#efbc69'}],['circle',{cx:48,cy:31,r:7,fill:'#78a8b6'}],['path',{d:'m55 16 8 8 2-12Z',fill:'#c77451'}]]],
  };
  function Avatar({ id, size = 50 }) {
    const index = ids.indexOf(id), logo = logos[id];
    return h('svg', { width: size, height: size, viewBox: '0 0 80 80', 'aria-hidden': true, className: 'ec-portrait' },
      logo ? h('g', null, h('rect', {width:80,height:80,rx:21,fill:logo[0]}), ...logo[1].map(([type, props], key) => h(type, {key,...props})))
        : h(Person, { index: index < 0 ? [...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 18 : index }));
  }
  function Scene({ kind }) {
    const index = { code: 0, research: 3, writing: 6, data: 9, office: 12, knowledge: 15 }[kind] || 0;
    const ink = portraits[index][1];
    return h('svg', { viewBox: '0 0 180 120', className: 'ec-scene', 'aria-hidden': true },
      h('circle', { cx: 113, cy: 61, r: 53, fill: '#fff', opacity: .28 }),
      h('rect', { x: 11, y: 28, width: 39, height: 33, rx: 6, fill: '#fff', opacity: .6 }),
      h('path', { d: kind === 'code' ? 'm26 38-7 6 7 6m9-12 7 6-7 6' : kind === 'data' ? 'M21 51V44m9 7V38m9 13V33' : kind === 'research' ? 'M22 38h16m-16 7h12m-12 7h8' : kind === 'writing' ? 'm22 49 13-14 5 4-13 14-7 2Z' : kind === 'office' ? 'M21 39h20m-20 8h14' : 'M21 36v17l10-2 10 2V36l-10-2-10 2m10-2v17', stroke: ink, strokeWidth: 2, fill: 'none', opacity: .55, strokeLinecap: 'round' }),
      h('g', { transform: 'translate(59 12) scale(1.04)' }, h(Person, { index })),
      h('path', { d: 'M15 106h153', stroke: ink, strokeWidth: 3, strokeLinecap: 'round', opacity: .4 }),
      h('path', { d: 'M70 78h66l-7 28H78Z', fill: '#fdfdfc' }), h('path', { d: 'M70 78h66l-7 28H78Z', fill: ink, opacity: .11 }),
      h('circle', { cx: 103, cy: 92, r: 3, fill: ink, opacity: .4 }),
      h('path', { d: 'M144 105V88m0 4c-12-1-11-14-11-14 12 0 11 14 11 14m0 6c13-1 13-12 13-12-13 0-13 12-13 12', stroke: ink, fill: 'none', strokeWidth: 2, opacity: .65 }),
      h('path', { d: 'M136 100h17l-3 8h-11Z', fill: ink, opacity: .5 }),
      h('path', { d: 'm153 15 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z', fill: '#fff', opacity: .9 }));
  }
  return { Avatar, Scene };
}
