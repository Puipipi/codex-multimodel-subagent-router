import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareIdentityMigration,beginIdentityMigration,activateIdentityMigration,rollbackIdentityMigration} from '../scripts/migrate-router-identity.mjs';
import {ROUTER_ID,LEGACY_STORAGE_ID,PLUGIN_KEY,LEGACY_PLUGIN_KEY} from '../scripts/router-identity.mjs';

const root=await mkdtemp(path.join(os.tmpdir(),'router-identity-migration-'));
const sha=s=>createHash('sha256').update(s).digest('hex');
async function fixture(name,oldEnabled=true,crlf=false) {
 const dir=path.join(root,name),skillsRoot=path.join(dir,'skills'),bundle=path.join(dir,'bundle');
 const configFile=path.join(dir,'config.toml'),journalFile=path.join(dir,'migration.json');
 const old=path.join(skillsRoot,LEGACY_STORAGE_ID);
 await mkdir(path.join(old,'scripts'),{recursive:true});
 await writeFile(path.join(old,'SKILL.md'),'old skill');
 await writeFile(path.join(old,'scripts','in-flight.mjs'),'in-flight reference');
 await mkdir(path.join(bundle,'.codex-plugin'),{recursive:true});
 await mkdir(path.join(bundle,'scripts'));
 await writeFile(path.join(bundle,'.codex-plugin','plugin.json'),JSON.stringify({name:ROUTER_ID,version:'0.13.0'}));
 await writeFile(path.join(bundle,'scripts','route.mjs'),'source');
 await writeFile(path.join(bundle,'SKILL.md'),'new skill');
 let config='model = "keep-exact-model"\n# credential reference stays private\n[plugins."other@registry"]\nenabled = true\n\n[plugins.'+JSON.stringify(LEGACY_PLUGIN_KEY)+']\nenabled = '+oldEnabled+'\n';
 if(crlf) config=config.replaceAll('\n','\r\n');
 await writeFile(configFile,config);
 const state=path.join(dir,LEGACY_STORAGE_ID,'native-api','router.json');
 await mkdir(path.dirname(state),{recursive:true});await writeFile(state,'{"enabled":false,"fixedExecutor":"immutable-profile"}');
 return {bundle,skillsRoot,configFile,journalFile,expectedConfigSha256:sha(config),config,state,old};
}
async function install(f) { // Stand-in for the official CLI's local registration only, no providers.
 const config=await readFile(f.configFile,'utf8');
 assert.match(config,new RegExp('enabled = false\\s*$'));
 const nl=config.includes('\r\n')?'\r\n':'\n';
 await writeFile(f.configFile,config+nl+'[plugins.'+JSON.stringify(PLUGIN_KEY)+']'+nl+'enabled = true'+nl);
 return sha(await readFile(f.configFile));
}
async function discovered(f) {
 const found=[];
 for(const name of await readdir(f.skillsRoot)) {
   try {await readFile(path.join(f.skillsRoot,name,'SKILL.md'));found.push(name);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 return found;
}
try {
 for(const [enabled,crlf] of [[true,false],[false,false],[true,true]]) {
  const f=await fixture('happy-'+enabled+'-'+crlf,enabled,crlf),state=await readFile(f.state);
  await prepareIdentityMigration(f);
  assert.deepEqual(await discovered(f),[LEGACY_STORAGE_ID]);
  const journal=await readFile(f.journalFile,'utf8');
  assert.ok(!journal.includes('keep-exact-model'),'journal excludes unrelated config/model');
  assert.ok(!journal.includes('credential reference'),'journal excludes unrelated comments');
  await beginIdentityMigration(f);
  const expectedConfigSha256=await install(f);
  await activateIdentityMigration({...f,installedPlugin:f.bundle,expectedConfigSha256});
  assert.deepEqual(await discovered(f),[ROUTER_ID]);
  assert.equal(await readFile(path.join(f.old,'scripts','in-flight.mjs'),'utf8'),'in-flight reference');
  assert.equal(await readFile(f.state,'utf8'),state.toString());
  assert.match(await readFile(f.configFile,'utf8'),new RegExp('enabled = '+enabled+'\\s*$'));
  await rollbackIdentityMigration(f);
  assert.deepEqual(await discovered(f),[LEGACY_STORAGE_ID]);
  assert.equal(await readFile(f.configFile,'utf8'),f.config);
  assert.deepEqual(await readFile(f.state),state);
 }
 for(const failAfter of ['disable','old-skill','skills']) {
  const f=await fixture('partial-'+failAfter);
  await prepareIdentityMigration(f);await beginIdentityMigration(f);
  const expectedConfigSha256=await install(f);
  await assert.rejects(activateIdentityMigration({...f,installedPlugin:f.bundle,expectedConfigSha256,failAfter}),/injected failure/);
  await rollbackIdentityMigration(f);
  assert.deepEqual(await discovered(f),[LEGACY_STORAGE_ID]);
  assert.equal(await readFile(f.configFile,'utf8'),f.config);
 }
 {
  const f=await fixture('cas');
  await prepareIdentityMigration(f);
  const changed=f.config+'# concurrent user edit\n';await writeFile(f.configFile,changed);
  await assert.rejects(beginIdentityMigration(f),/CAS conflict/);
  await assert.rejects(rollbackIdentityMigration(f),/CAS conflict/);
  assert.equal(await readFile(f.configFile,'utf8'),changed);
 }
 {
  const f=await fixture('foreign-install-change');
  await prepareIdentityMigration(f);await beginIdentityMigration(f);await install(f);
  const changed=(await readFile(f.configFile,'utf8')).replace('keep-exact-model','user-new-model');
  await writeFile(f.configFile,changed);
  await assert.rejects(activateIdentityMigration({...f,installedPlugin:f.bundle,expectedConfigSha256:sha(changed)}),/outside owned/);
  assert.equal(await readFile(f.configFile,'utf8'),changed);
 }
 {
  const f=await fixture('rollback-between-install-and-activate');
  await prepareIdentityMigration(f);await beginIdentityMigration(f);
  const expectedConfigSha256=await install(f);
  await assert.rejects(rollbackIdentityMigration(f),/CAS conflict/);
  await rollbackIdentityMigration({...f,expectedConfigSha256});
  assert.equal(await readFile(f.configFile,'utf8'),f.config);
 }
 {
  const f=await fixture('destination-conflict');
  await mkdir(path.join(f.skillsRoot,ROUTER_ID));
  await assert.rejects(prepareIdentityMigration(f),/destination conflict/);
  assert.equal(await readFile(f.configFile,'utf8'),f.config);
 }
 {
  const f=await fixture('bundle-drift');
  await prepareIdentityMigration(f);await beginIdentityMigration(f);
  const expectedConfigSha256=await install(f);
  await writeFile(path.join(f.bundle,'scripts','route.mjs'),'unexpected cache');
  await assert.rejects(activateIdentityMigration({...f,installedPlugin:f.bundle,expectedConfigSha256}),/does not match/);
  await rollbackIdentityMigration({...f,expectedConfigSha256});
 }
 {
  const f=await fixture('registered-disabled');
  f.config+='\n[plugins.'+JSON.stringify(PLUGIN_KEY)+']\nenabled = false\n';
  await writeFile(f.configFile,f.config);f.expectedConfigSha256=sha(f.config);
  await prepareIdentityMigration(f);await beginIdentityMigration(f);
  let config=await readFile(f.configFile,'utf8');
  const at=config.lastIndexOf('enabled = false');
  config=config.slice(0,at)+config.slice(at).replace('enabled = false','enabled = true');
  await writeFile(f.configFile,config);
  await activateIdentityMigration({...f,installedPlugin:f.bundle,expectedConfigSha256:sha(config)});
  await rollbackIdentityMigration(f);
  assert.equal(await readFile(f.configFile,'utf8'),f.config);
 }
 {
  const f=await fixture('new-plugin-extra-fields');
  await prepareIdentityMigration(f);await beginIdentityMigration(f);await install(f);
  const changed=(await readFile(f.configFile,'utf8'))+'unexpected = true\n';await writeFile(f.configFile,changed);
  await assert.rejects(activateIdentityMigration({...f,installedPlugin:f.bundle,expectedConfigSha256:sha(changed)}),/unexpected fields/);
  assert.equal(await readFile(f.configFile,'utf8'),changed);
 }
 console.log('PASS isolated identity migration: single discovery, state preservation, conflict, partial failure and rollback');
}finally{await rm(root,{recursive:true,force:true});}
