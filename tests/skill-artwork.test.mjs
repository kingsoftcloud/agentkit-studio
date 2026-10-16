import test from 'node:test';
import assert from 'node:assert/strict';
import {findOwnSkillLogo,skillIconTheme,skillIconSvg,safeLogoSvg} from '../scripts/workbuddy/skill-artwork.mjs';
const skill=name=>({name,dependencies:{skills:[{path:'skills/'+name}]}});
test('Skill artwork never falls back to an expert or team portrait, nor an example asset',()=>{
 const row=skill('finance');const files=['avatars/expert.png','avatars/team.png','skills/finance/references/logo.png','skills/finance/examples/icon.png'].map(path=>({path,size:100}));
 assert.equal(findOwnSkillLogo(row,files),undefined);
 const own={path:'skills/finance/assets/logo.png',size:120};assert.equal(findOwnSkillLogo(row,[...files,own]),own);
 assert.equal(findOwnSkillLogo(skill('another-skill'),[...files,own]),undefined);
});
test('fallback icons reflect specific Skill functions instead of containing expert identity',()=>{
 for(const [name,theme]of [['Authentication','security'],['table-permission-check','security'],['xlsx','spreadsheet'],['pptx','presentation'],['pdfkit-py','pdf'],['westock','finance'],['ab-analysis','analytics'],['tencent-bigdata','database'],['web-access','browser'],['podcast','audio']])assert.equal(skillIconTheme({name}),theme,name);
 assert.notEqual(skillIconSvg('security'),skillIconSvg('analytics'));
});
test('logo rasterization refuses active SVGs and external references',()=>{
 assert.throws(()=>safeLogoSvg(Buffer.from('<svg><image href="https://example.com/tracking.png"/></svg>')));
 assert.throws(()=>safeLogoSvg(Buffer.from('<svg onload="alert(1)"/>')));
 assert.throws(()=>safeLogoSvg(Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>')));
 assert.equal(safeLogoSvg(Buffer.from(skillIconSvg('finance'))),skillIconSvg('finance'));
});
