/** Freeze plugin tarballs before the long-running official packaging pipeline reads them. */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

export async function snapshotDesktopPluginInputs(inputs, directory) {
  const sources=String(inputs||'').split(delimiter).map(value=>value.trim()).filter(Boolean).map(value=>resolve(value));
  if(!sources.length) return {value:'',dispose:async()=>{}};
  const root=await mkdtemp(join(directory,'plugin-inputs-'));
  const targets=[];
  try {
    for(const [index,source] of sources.entries()) {
      const target=join(root,String(index));
      await mkdir(target);
      for(const name of (await readdir(source)).filter(name=>name.endsWith('.tgz')).sort()) {
        const path=join(source,name);
        const before=await stat(path);
        const bytes=await readFile(path);
        const after=await stat(path);
        if(!before.isFile()||before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==after.size) throw new Error('desktop plugin input changed while snapshotting; retry after pack finishes');
        await writeFile(join(target,name),bytes,{mode:0o600,flag:'wx'});
      }
      targets.push(target);
    }
    return {value:targets.join(delimiter),dispose:()=>rm(root,{recursive:true,force:true})};
  } catch(error) {await rm(root,{recursive:true,force:true});throw error;}
}
