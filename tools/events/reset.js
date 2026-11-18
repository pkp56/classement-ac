'use strict';
// L'appelant vérifie l'authentification, la méthode et la confirmation.
async function resetWithBackup({store,slug,user,backup}){
  const previous=slug?await store.get(slug):await store.legacyChampionship();
  if(slug&&!previous)throw Object.assign(Error('event-not-found'),{status:404});
  await backup(previous||{}); // doit réussir AVANT la première écriture en base
  const data={...((previous&&(previous.data||previous.championship))||{}),_reset:true,sessions:[],penMap:{},manualDrivers:null,customCalendar:null};
  const saved=slug?await store.saveData(slug,data,user):await store.saveLegacy(data,user);
  if(!saved)throw Object.assign(Error('event-not-found'),{status:404});
  return saved;
}
module.exports={resetWithBackup};
