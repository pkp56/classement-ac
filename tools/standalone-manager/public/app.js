'use strict';
document.getElementById('weekend').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const fields = new FormData(form);
  const draft = {
    schema: 'gdsp-weekend-draft-v1',
    status: 'planning-only',
    name: fields.get('name').trim(),
    track: fields.get('track'), layout: fields.get('layout'), car: fields.get('car'),
    slots: Number(fields.get('slots')),
    sessions: [
      {type: 'qualifying', minutes: Number(fields.get('qualify'))},
      {type: 'race', minutes: Number(fields.get('race1'))},
      {type: 'race', minutes: Number(fields.get('race2')), desiredGrid: fields.get('grid')},
    ],
    fixedSetupRequested: fields.has('fixedSetup'),
  };
  if (!draft.name) { document.getElementById('status').textContent = 'Saisis un nom pour le brouillon.'; return; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2) + '\n'], {type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'gdsp-weekend-brouillon.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  document.getElementById('status').textContent = 'Brouillon téléchargé. Aucun serveur ni classement modifié.';
});

const fileInput = document.getElementById('grid-file');
const confirmGrid = document.getElementById('grid-confirm');
const downloadGrid = document.getElementById('grid-download');
const gridMessage = document.getElementById('grid-message');
const gridPreview = document.getElementById('grid-preview');
let proposal = null, fileVersion = 0;
fileInput.addEventListener('change', async () => {
  const version=++fileVersion; proposal=null; confirmGrid.checked=false;confirmGrid.disabled=true;downloadGrid.disabled=true;
  gridPreview.replaceChildren();gridMessage.textContent='';
  const file=fileInput.files[0];if(!file)return;
  if(file.size>2*1024*1024){gridMessage.textContent='Fichier trop volumineux (2 Mo maximum).';return;}
  try {
    const text=await file.text(); if(version!==fileVersion)return;
    proposal=GDSPGrid.prepare(JSON.parse(text));
    const info=document.createElement('p');info.textContent=`Date : ${proposal.date || 'non indiquée'} · Circuit : ${proposal.track || 'non indiqué'} · Variante : ${proposal.layout || 'non indiquée'}`;gridPreview.append(info);
    const table=document.createElement('table');const head=document.createElement('tr');
    for(const title of ['Grille proposée','Pilote','Position dans Result','GUID']){const th=document.createElement('th');th.textContent=title;head.append(th);}table.append(head);
    for(const driver of proposal.grid){const tr=document.createElement('tr');for(const value of [driver.gridPosition,driver.name,driver.sourcePosition,driver.guid?'présent':'absent']){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}table.append(tr);}
    gridPreview.append(table);confirmGrid.disabled=false;
    gridMessage.textContent='Proposition non officielle : vérifie d’abord la course, l’ordre d’arrivée, les absents et les décisions.';
  } catch(error) {if(version===fileVersion)gridMessage.textContent=`Import impossible : ${error.message}. Aucun fichier modifié.`;}
});
confirmGrid.addEventListener('change',()=>{downloadGrid.disabled=!proposal||!confirmGrid.checked;});
downloadGrid.addEventListener('click',()=>{
  if(!proposal||!confirmGrid.checked)return;
  const draft={schema:'gdsp-grid-proposal-v1',status:'manual-review-test-only',source:{date:proposal.date,track:proposal.track,layout:proposal.layout,order:'Result array; manually reviewed'},grid:proposal.grid};
  const url=URL.createObjectURL(new Blob([JSON.stringify(draft,null,2)+'\n'],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='gdsp-grille-proposee.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  gridMessage.textContent='Proposition téléchargée : aucun serveur ni résultat officiel modifié.';
});

const raceFile=document.getElementById('race-file'),raceMinutes=document.getElementById('race-minutes');
const raceMessage=document.getElementById('race-message'),racePreview=document.getElementById('race-preview');
const raceConfirm=document.getElementById('race-confirm'),raceDownload=document.getElementById('race-download');
let raceVersion=0,raceCopy=null;
function clearRacePreview(){raceVersion++;raceCopy=null;raceConfirm.checked=false;raceConfirm.disabled=true;raceDownload.disabled=true;racePreview.replaceChildren();raceMessage.textContent='';}
raceFile.addEventListener('change',clearRacePreview);raceMinutes.addEventListener('input',clearRacePreview);
document.getElementById('race-preview-btn').addEventListener('click',async()=>{
  clearRacePreview();const version=raceVersion,file=raceFile.files[0];
  if(!file){raceMessage.textContent='Choisis une copie du fichier de configuration.';return;}
  if(file.size>1048576){raceMessage.textContent='Fichier trop volumineux (1 Mo maximum).';return;}
  try{
    const text=await file.text();if(version!==raceVersion)return;
    const prepared=GDSPRacePreview.createCopy(text,raceMinutes.value);const plan=prepared.plan;
    const lines=[`Circuit : ${plan.track||'non déterminé'} ; variante : ${plan.layout||'non indiquée'}.`, `Course au temps : ${plan.beforeMinutes} → ${plan.afterMinutes} minutes${plan.changed?'':' (aucun changement)'}.`, `Autres séances actives : ${plan.otherActiveSessions.length?plan.otherActiveSessions.join(', '):'aucune détectée'}.`, `Course inversée native : ${plan.nativeReverse===null?'absente':plan.nativeReverse} → 0 dans la copie.`];
    for(const line of lines){const p=document.createElement('p');p.textContent=line;racePreview.append(p);}
    raceCopy=prepared.text;raceConfirm.disabled=false;raceMessage.textContent='Copie préparée en mémoire : aucun fichier serveur écrit, aucun port modifié, aucune grille appliquée.';
  }catch(error){if(version===raceVersion)raceMessage.textContent=`Aperçu impossible : ${error.message} Aucun fichier modifié.`;}
});

raceConfirm.addEventListener('change',()=>{raceDownload.disabled=!raceCopy||!raceConfirm.checked;});
raceDownload.addEventListener('click',()=>{
 if(!raceCopy||!raceConfirm.checked)return;
 const url=URL.createObjectURL(new Blob([raceCopy],{type:'text/plain;charset=utf-8'}));
 const link=document.createElement('a');link.href=url;link.download='course2-copie-test-confidentielle.ini';link.click();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
 raceMessage.textContent='Copie privée téléchargée. Aucun serveur modifié ou démarré ; grille non appliquée.';
});

const entryFile=document.getElementById('entry-file'),entryPreview=document.getElementById('entry-preview');
const entryMessage=document.getElementById('entry-message'),entryConfirm=document.getElementById('entry-confirm'),entryDownload=document.getElementById('entry-download');
let entryVersion=0,entryCopy=null;
function clearEntry(){entryVersion++;entryCopy=null;entryConfirm.checked=false;entryConfirm.disabled=true;entryDownload.disabled=true;entryPreview.replaceChildren();entryMessage.textContent='';}
entryFile.addEventListener('change',clearEntry);
fileInput.addEventListener('change',clearEntry);confirmGrid.addEventListener('change',clearEntry);
document.getElementById('entry-preview-btn').addEventListener('click',async()=>{
 clearEntry();const version=entryVersion,file=entryFile.files[0];
 if(!proposal||!confirmGrid.checked){entryMessage.textContent='Vérifie et confirme d’abord la grille proposée.';return;}
 if(!file){entryMessage.textContent='Choisis une copie de la liste des places.';return;}
 if(file.size>1048576){entryMessage.textContent='Fichier trop volumineux (1 Mo maximum).';return;}
 try{
  const text=await file.text();if(version!==entryVersion)return;
  const result=GDSPEntryPreview.prepare(text,proposal.grid);entryCopy=result.text;
  const table=document.createElement('table'),head=document.createElement('tr');
  for(const title of ['Position souhaitée','Pilote','Place initiale','Voiture','Skin']){const th=document.createElement('th');th.textContent=title;head.append(th);}table.append(head);
  for(const row of result.mapping){const tr=document.createElement('tr');for(const value of [row.gridPosition,row.name,row.oldSlot+1,row.model,row.skin||'—']){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}table.append(tr);}
  entryPreview.append(table);entryConfirm.disabled=false;
  entryMessage.textContent=`Association proposée : ${result.mapping.length} pilote(s), ${result.unreserved} place(s) libre(s). Vérifie les détails et teste l’ordre réel en jeu.`;
 }catch(error){if(version===entryVersion)entryMessage.textContent=`Association impossible : ${error.message} Aucun fichier modifié.`;}
});
entryConfirm.addEventListener('change',()=>{entryDownload.disabled=!entryCopy||!entryConfirm.checked;});
entryDownload.addEventListener('click',()=>{
 if(!entryCopy||!entryConfirm.checked)return;
 const url=URL.createObjectURL(new Blob([entryCopy],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='entry-list-copie-test-confidentielle.ini';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 entryMessage.textContent='Copie privée téléchargée. Aucun serveur ni fichier d’origine modifié.';
});
