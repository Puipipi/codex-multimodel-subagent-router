import assert from 'node:assert/strict';
import path from 'node:path';
import {ROUTER_ID,LEGACY_STORAGE_ID,ROUTER_DISPLAY_NAME,ROUTER_VERSION} from '../scripts/router-identity.mjs';
import {resolveStateDir} from '../scripts/plugin-state.mjs';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import {NativeWriterLease,NativeTasks} from '../scripts/native-state.mjs';
import {readFileSync} from 'node:fs';
const oldState=process.env.SOL_LUNA_PLUGIN_STATE;delete process.env.SOL_LUNA_PLUGIN_STATE;
try{assert.ok(resolveStateDir().includes(LEGACY_STORAGE_ID));assert.ok(!resolveStateDir().includes(ROUTER_ID));}
finally{if(oldState!==undefined)process.env.SOL_LUNA_PLUGIN_STATE=oldState;}
const manifest=JSON.parse(readFileSync(new URL('../.codex-plugin/plugin.json',import.meta.url)));
assert.equal(manifest.name,ROUTER_ID);assert.equal(manifest.version,ROUTER_VERSION);assert.equal(manifest.interface.displayName,ROUTER_DISPLAY_NAME);
console.log('PASS installation and legacy storage identity separation');

const temp=await mkdtemp(path.join(os.tmpdir(),'identity-shared-state-'));
try {
 const workspace=path.join(temp,'workspace');await mkdir(workspace);
 const stateDir=path.join(temp,LEGACY_STORAGE_ID,'plugin');
 const oldLease=new NativeWriterLease({stateDir}),newLease=new NativeWriterLease({stateDir});
 await oldLease.reserve({workspace,parentThreadId:'legacy-parent',taskNonce:'legacy-nonce-001'});
 await oldLease.bind({workspace,parentThreadId:'legacy-parent',taskNonce:'legacy-nonce-001',childThreadId:'existing-child'});
 await assert.rejects(newLease.reserve({workspace,parentThreadId:'new-parent',taskNonce:'new-nonce-001'}),/already reserved/);
 assert.equal((await newLease.get(workspace)).child_thread_id,'existing-child');
 const tasks=new NativeTasks({stateDir});
 await tasks.begin({parentThreadId:'legacy-parent',childThreadId:'existing-child',taskNonce:'legacy-nonce-001',model:'gpt-6.1-sol',binding:{executor:'luna',model:'gpt-6.1-sol'}});
 await assert.rejects(tasks.begin({parentThreadId:'legacy-parent',childThreadId:'existing-child',taskNonce:'legacy-nonce-001',model:'different-model',binding:{executor:'luna',model:'different-model'}}),/model|binding/);
 console.log('PASS legacy state lease competition and immutable existing child binding');
}finally{await rm(temp,{recursive:true,force:true});}
