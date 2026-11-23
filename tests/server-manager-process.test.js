'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {windowsArgv,identify}=require('../tools/server-manager/process-identity');
const root='C:\\Program Files (x86)\\Steam\\steamapps\\common\\assettocorsa\\server';
function proc(id,pid=42){const base=root+'\\presets\\'+id;return {pid,executablePath:root+'\\acServer.exe',creationTime:'2026-11-21T10:00:00Z',commandLine:`"${root}\\acServer.exe" -c "${base}\\server_cfg.ini" -e "${base}\\entry_list.ini"`};}
test('Analyse les chemins Windows avec espaces et guillemets',()=>{
 const p=proc('SERVER_01');assert.deepEqual(windowsArgv(p.commandLine).slice(1),['-c',root+'\\presets\\SERVER_01\\server_cfg.ini','-e',root+'\\presets\\SERVER_01\\entry_list.ini']);
 assert.throws(()=>windowsArgv('"non terminé'),/Guillemets/);
});
test('Les deux instances CM sont identifiées individuellement',()=>{
 const result=identify({root,processes:[proc('SERVER_00',10),proc('SERVER_01',20)]});
 assert.equal(result.ambiguous,false);assert.equal(result.servers.local1[0].pid,10);assert.equal(result.servers.local2[0].pid,20);
});
test('Refuse les doublons, chemins mélangés et identités incomplètes',()=>{
 assert.equal(identify({root,processes:[proc('SERVER_00',10),proc('SERVER_00',11)]}).ambiguous,true);
 const mixed=proc('SERVER_00');mixed.commandLine=mixed.commandLine.replace(/SERVER_00\\entry_list/i,'SERVER_01\\entry_list');
 assert.equal(identify({root,processes:[mixed]}).ambiguous,true);
 const noDate=proc('SERVER_01');delete noDate.creationTime;assert.equal(identify({root,processes:[noDate]}).ambiguous,true);
 const duplicate=proc('SERVER_01');duplicate.commandLine+=' -c "'+root+'\\presets\\SERVER_00\\server_cfg.ini"';
 assert.equal(identify({root,processes:[duplicate]}).ambiguous,true);
 const relative=proc('SERVER_01');relative.commandLine=relative.commandLine.replace(root+'\\presets\\SERVER_01\\server_cfg.ini','presets\\SERVER_01\\server_cfg.ini');
 assert.equal(identify({root,processes:[relative]}).ambiguous,true);
});
