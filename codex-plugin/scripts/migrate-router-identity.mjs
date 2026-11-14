// Local installation identity switch only. Never imports runtime setup or provider clients.
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, readdir, realpath, rename, writeFile, open, unlink} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROUTER_ID, LEGACY_STORAGE_ID, LEGACY_PLUGIN_KEY, PLUGIN_KEY} from './router-identity.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
const equalPath = (a,b) => normalized(a) === normalized(b);
async function regular(file, directory = false) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || !equalPath(await realpath(file),path.resolve(file))) throw new Error('migration path must be regular and canonical');
}
async function missing(file) { try { await lstat(file); return false; } catch(e) { if(e.code === 'ENOENT') return true; throw e; } }
function disjoint(a,b) {
  for (const [root,target] of [[a,b],[b,a]]) {
    const rel=path.relative(root,target);
    if (!rel || (!rel.startsWith('..'+path.sep) && rel !== '..' && !path.isAbsolute(rel))) throw new Error('migration directories must be disjoint');
  }
}
async function tree(root) {
  await regular(root,true);
  const files=[];
  async function walk(dir,prefix='') {
    for (const item of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const relative=prefix+item.name, full=path.join(dir,item.name);
      await regular(full,item.isDirectory());
      if(item.isDirectory()) await walk(full,relative+'/');
      else files.push({path:relative,sha256:digest(await readFile(full))});
    }
  }
  await walk(root);return files;
}
function section(text,key,optional=false) {
  const header='[plugins.'+JSON.stringify(key)+']';
  const lines=[...text.matchAll(/^\[[^\r\n]+\][^\r\n]*(?:\r?\n|$)/gm)];
  const matches=lines.filter(m=>m[0].trim()===header);
  if(optional && matches.length===0 && !text.includes(key)) return null;
  if(matches.length!==1) throw new Error('expected exactly one supported plugin table: '+key);
  const current=matches[0],next=lines.find(m=>m.index>current.index);
  const start=current.index,end=next?.index??text.length,value=text.slice(start,end);
  const settings=[...value.matchAll(/^enabled\s*=\s*(true|false)\s*(?:#[^\r\n]*)?$/gm)];
  if(settings.length!==1) throw new Error('expected one enabled boolean: '+key);
  return {start,end,value,enabled:settings[0][1]==='true'};
}
function enabled(text,key,value) {
  const s=section(text,key);
  return text.slice(0,s.start)+s.value.replace(/^(enabled\s*=\s*)(true|false)/m,(_,a)=>a+String(value))+text.slice(s.end);
}
function restoreSections(text, originals) {
  for (const [key,value] of Object.entries(originals)) {
    const s=section(text,key,true);
    if(s) text=text.slice(0,s.start)+(value??'')+text.slice(s.end);
    else if(value!==null) throw new Error('owned plugin table disappeared');
  }
  return text;
}
function foreignHash(text) {
  for (const key of [LEGACY_PLUGIN_KEY,PLUGIN_KEY]) {
    const s=section(text,key,true);
    if(s) text=text.slice(0,s.start)+text.slice(s.end);
  }
  return digest(text.trimEnd());
}
function verifyPostInstallConfig(text,j) {
  if(foreignHash(text)!==j.foreignSha256) throw new Error('config contains changes outside owned plugin tables');
  if(section(text,LEGACY_PLUGIN_KEY).enabled) throw new Error('legacy plugin must be disabled before official installation');
  const expected=enabled(j.originalSections[LEGACY_PLUGIN_KEY],LEGACY_PLUGIN_KEY,false).trim();
  if(section(text,LEGACY_PLUGIN_KEY).value.trim()!==expected) throw new Error('legacy plugin table changed unexpectedly');
  const added=section(text,PLUGIN_KEY);
  if(j.originalSections[PLUGIN_KEY]!==null && added.value.trim()!==enabled(j.originalSections[PLUGIN_KEY],PLUGIN_KEY,added.enabled).trim()) throw new Error('existing new plugin table changed unexpectedly');
  if(added.value.replaceAll('\r\n','\n').trim()!==('[plugins.'+JSON.stringify(PLUGIN_KEY)+']\nenabled = '+String(added.enabled)).trim() && j.originalSections[PLUGIN_KEY]===null) throw new Error('unexpected fields in newly installed plugin table');
}
async function saveJournal(file,journal) {
  const temp=file+'.next';
  if(!await missing(temp)) throw new Error('migration journal temporary file already exists');
  await writeFile(temp,JSON.stringify(journal,null,2)+'\n',{flag:'wx',mode:0o600});
  await rename(temp,file);
}
async function loadJournal(file) {
  await regular(file);
  const j=JSON.parse(await readFile(file,'utf8'));
  if(j.schema!=='codex-router-identity-migration/v1') throw new Error('unknown migration journal');
  return j;
}
async function cas(file,expected,bytes) {
  await regular(file);
  if(digest(await readFile(file))!==expected) throw new Error('CAS conflict: config changed; no overwrite');
  // Replacement is same-volume; recheck immediately before rename under our migration lock.
  const temporary=file+'.router-identity-next';
  await writeFile(temporary,bytes,{flag:'wx',mode:0o600});
  try {
    if(digest(await readFile(file))!==expected) throw new Error('CAS conflict: config changed; no overwrite');
    await rename(temporary,file);
  } finally { await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
}
async function locked(file,action) {
  await regular(path.dirname(file),true);
  const lock=file+'.lock';const handle=await open(lock,'wx',0o600).catch(()=>{throw new Error('migration lock is busy; reconcile existing operation');});
  try{return await action();}finally{await handle.close();await unlink(lock);}
}
export async function prepareIdentityMigration({bundle,skillsRoot,configFile,journalFile,expectedConfigSha256}) {
  return locked(journalFile,async()=>{
    if(!await missing(journalFile)) throw new Error('migration journal already exists');
    bundle=path.resolve(bundle);skillsRoot=path.resolve(skillsRoot);configFile=path.resolve(configFile);
    await regular(skillsRoot,true);await regular(configFile);
    const oldSkill=path.join(skillsRoot,LEGACY_STORAGE_ID),newSkill=path.join(skillsRoot,ROUTER_ID);
    disjoint(bundle,oldSkill);disjoint(bundle,newSkill);
    await regular(oldSkill,true);await regular(path.join(oldSkill,'SKILL.md'));
    if(!await missing(newSkill)||!await missing(path.join(oldSkill,'SKILL.legacy-disabled.md'))) throw new Error('skill destination conflict');
    const files=await tree(bundle);
    if(files.some(f=>f.path.startsWith('codex-plugin/')||f.path.startsWith('skills/'))) throw new Error('bundle contains duplicate skill subtree');
    if(!files.some(f=>f.path==='SKILL.md') || !files.some(f=>f.path==='scripts/route.mjs')) throw new Error('incomplete canonical skill bundle');
    const manifest=JSON.parse(await readFile(path.join(bundle,'.codex-plugin','plugin.json'),'utf8'));
    if(manifest.name!==ROUTER_ID || manifest.skills!==undefined) throw new Error('wrong migration plugin bundle');
    const config=await readFile(configFile,'utf8');
    if(digest(config)!==expectedConfigSha256) throw new Error('CAS conflict: config changed; no overwrite');
    const oldSection=section(config,LEGACY_PLUGIN_KEY),newSection=section(config,PLUGIN_KEY,true);
    if(newSection?.enabled) throw new Error('an already registered new plugin must be disabled before prepare');
    const j={schema:'codex-router-identity-migration/v1',phase:'preparing',configFile,skillsRoot,oldSkill,newSkill,
      originalConfigSha256:digest(config),expectedConfigSha256:digest(config),
      foreignSha256:foreignHash(config), originalEnabled:oldSection.enabled,
      originalSections:{[LEGACY_PLUGIN_KEY]:oldSection.value,[PLUGIN_KEY]:newSection?.value??null},
      oldSkillSha256:digest(await readFile(path.join(oldSkill,'SKILL.md'))),files};
    await saveJournal(journalFile,j);
    await mkdir(newSkill); // exclusive: an existing target is never merged or overwritten
    for(const f of files) {
      const destination=path.join(newSkill,f.path==='SKILL.md'?'SKILL.pending.md':f.path);
      await mkdir(path.dirname(destination),{recursive:true});
      await writeFile(destination,await readFile(path.join(bundle,f.path)),{flag:'wx'});
      if(digest(await readFile(destination))!==f.sha256) throw new Error('bundle changed during prepare');
    }
    j.phase='prepared';await saveJournal(journalFile,j);
    return {phase:j.phase,configSha256:j.expectedConfigSha256,newSkill};
  });
}
async function verifySkills(j, active) {
  const expected=j.files.map(f=>({...f,path:f.path==='SKILL.md'?(active?'SKILL.md':'SKILL.pending.md'):f.path})).sort((a,b)=>a.path.localeCompare(b.path));
  const actual=(await tree(j.newSkill)).sort((a,b)=>a.path.localeCompare(b.path));
  if(JSON.stringify(expected)!==JSON.stringify(actual)) throw new Error('staged skill changed; refusing switch');
  const old=path.join(j.oldSkill,active?'SKILL.legacy-disabled.md':'SKILL.md');
  if(digest(await readFile(old))!==j.oldSkillSha256) throw new Error('legacy skill changed; refusing switch');
}
export async function beginIdentityMigration({journalFile}) {
  return locked(journalFile,async()=>{
    const j=await loadJournal(journalFile);
    if(j.phase!=='prepared') throw new Error('migration must be prepared');
    await verifySkills(j,false);
    const config=await readFile(j.configFile,'utf8');
    const disabled=enabled(config,LEGACY_PLUGIN_KEY,false);
    j.phase='beginning';j.nextConfigSha256=digest(disabled);await saveJournal(journalFile,j);
    await cas(j.configFile,j.expectedConfigSha256,disabled);
    j.expectedConfigSha256=digest(disabled);delete j.nextConfigSha256;j.phase='begun';await saveJournal(journalFile,j);
    return {phase:j.phase,configSha256:j.expectedConfigSha256};
  });
}
export async function activateIdentityMigration({journalFile,installedPlugin,expectedConfigSha256,failAfter}) {
  return locked(journalFile,async()=>{
    const j=await loadJournal(journalFile);
    if(j.phase!=='begun') throw new Error('migration must be begun; rollback partial operations before retry');
    await verifySkills(j,false);
    const installedFiles=await tree(path.resolve(installedPlugin));
    // CLI-owned cache may carry metadata; all bundle runtime files must be byte-identical.
    const installed=new Map(installedFiles.map(f=>[f.path,f.sha256]));
    if(j.files.some(f=>installed.get(f.path)!==f.sha256)) throw new Error('installed plugin does not match prepared bundle');
    let config=await readFile(j.configFile,'utf8');
    if(digest(config)!==expectedConfigSha256) throw new Error('CAS conflict: config changed; no overwrite');
    verifyPostInstallConfig(config,j);
    j.expectedConfigSha256=expectedConfigSha256;await saveJournal(journalFile,j);
    config=enabled(enabled(config,LEGACY_PLUGIN_KEY,false),PLUGIN_KEY,false);
    const disabledHash=digest(config);
    // Journal both expected states before every mutation: rollback can reconcile a crash after rename.
    j.phase='disabling';j.nextConfigSha256=disabledHash;await saveJournal(journalFile,j);
    await cas(j.configFile,j.expectedConfigSha256,config);
    j.expectedConfigSha256=disabledHash;j.phase='disabled';delete j.nextConfigSha256;await saveJournal(journalFile,j);
    if(failAfter==='disable') throw new Error('injected failure after disable');
    j.phase='switching-skills';await saveJournal(journalFile,j);
    await rename(path.join(j.oldSkill,'SKILL.md'),path.join(j.oldSkill,'SKILL.legacy-disabled.md'));
    if(failAfter==='old-skill') throw new Error('injected failure after old skill');
    await rename(path.join(j.newSkill,'SKILL.pending.md'),path.join(j.newSkill,'SKILL.md'));
    j.phase='skills-switched';await saveJournal(journalFile,j);
    if(failAfter==='skills') throw new Error('injected failure after skills');
    config=enabled(config,PLUGIN_KEY,j.originalEnabled);
    j.phase='enabling';j.nextConfigSha256=digest(config);await saveJournal(journalFile,j);
    await cas(j.configFile,j.expectedConfigSha256,config);
    j.expectedConfigSha256=j.nextConfigSha256;delete j.nextConfigSha256;j.phase='active';await saveJournal(journalFile,j);
    return {phase:j.phase,configSha256:j.expectedConfigSha256};
  });
}
export async function rollbackIdentityMigration({journalFile,expectedConfigSha256}) {
  return locked(journalFile,async()=>{
    const j=await loadJournal(journalFile);
    if(j.phase==='rolled-back') return {phase:j.phase};
    const config=await readFile(j.configFile,'utf8'),hash=digest(config);
    if(![j.expectedConfigSha256,j.nextConfigSha256].includes(hash)) {
      if(hash!==expectedConfigSha256) throw new Error('CAS conflict: config changed; reconcile before rollback');
      verifyPostInstallConfig(config,j);
    }
    // Keep both plugins disabled while restoring skill discovery.
    let disabled=enabled(config,LEGACY_PLUGIN_KEY,false);
    if(section(config,PLUGIN_KEY,true)) disabled=enabled(disabled,PLUGIN_KEY,false);
    j.phase='rollback-disabling';j.expectedConfigSha256=hash;j.nextConfigSha256=digest(disabled);await saveJournal(journalFile,j);
    await cas(j.configFile,hash,disabled);j.expectedConfigSha256=digest(disabled);delete j.nextConfigSha256;await saveJournal(journalFile,j);
    const oldLive=path.join(j.oldSkill,'SKILL.md'),oldSaved=path.join(j.oldSkill,'SKILL.legacy-disabled.md');
    const newLive=path.join(j.newSkill,'SKILL.md'),newPending=path.join(j.newSkill,'SKILL.pending.md');
    // Verify before moving either discoverable entry; never overwrite a later user edit.
    const oldPath=await missing(oldLive)?oldSaved:oldLive;
    if(digest(await readFile(oldPath))!==j.oldSkillSha256) throw new Error('legacy skill conflict during rollback');
    if(!await missing(newLive)) await verifySkills(j,true);
    else if(j.phase!=='preparing') {
      // A partial copy can only occur during prepare. Never delete it: leave it inert for inspection.
      const expectedSkill=j.files.find(f=>f.path==='SKILL.md');
      if(!await missing(newPending) && digest(await readFile(newPending))!==expectedSkill?.sha256) throw new Error('staged skill conflict during rollback');
    }
    if(!await missing(newLive)) await rename(newLive,newPending);
    if(await missing(oldLive)) await rename(oldSaved,oldLive);
    const restored=restoreSections(disabled,j.originalSections);
    j.nextConfigSha256=digest(restored);await saveJournal(journalFile,j);
    await cas(j.configFile,j.expectedConfigSha256,restored);j.expectedConfigSha256=digest(restored);delete j.nextConfigSha256;j.phase='rolled-back';await saveJournal(journalFile,j);
    return {phase:j.phase,configSha256:j.expectedConfigSha256};
  });
}
async function main(args) {
  const value=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
  const options={bundle:value('bundle'),skillsRoot:value('skills-root'),configFile:value('config'),journalFile:value('journal'),expectedConfigSha256:value('expected-config-sha256'),installedPlugin:value('installed-plugin')};
  try {
    if(!options.journalFile) throw new Error('--journal is required');
    const action=args[0],run={prepare:prepareIdentityMigration,begin:beginIdentityMigration,activate:activateIdentityMigration,rollback:rollbackIdentityMigration}[action];
    if(!run) throw new Error('expected prepare, begin, activate or rollback');
    console.log(JSON.stringify(await run(options)));
  } catch(e) {console.error(e.message);process.exitCode=1;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) await main(process.argv.slice(2));
