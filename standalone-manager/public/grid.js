'use strict';
// Ordre d'arrivée exclusivement relu et validé par l'admin : aucun calcul de classement.
(function(root, factory){ if(typeof module==='object' && module.exports) module.exports=factory(); else root.GDSPGrid=factory(); })(typeof globalThis==='object'?globalThis:this,function(){
  function prepare(raw) {
    if (!raw || typeof raw!=='object' || Array.isArray(raw) || raw.Type!=='RACE') throw Error('Le fichier doit être un résultat AC de type RACE.');
    if (!Array.isArray(raw.Cars) || !Array.isArray(raw.Result) || !raw.Result.length || raw.Result.length>200 || raw.Cars.length>200) throw Error('Listes Cars et Result manquantes, vides ou trop longues.');
    const cars=new Map(), seen=new Set(), guids=new Set();
    for (const car of raw.Cars) {
      if (!car || !Number.isSafeInteger(car.CarId) || car.CarId<0 || cars.has(car.CarId)) throw Error('Identifiant voiture manquant ou en double.');
      cars.set(car.CarId,car);
    }
    const finish=raw.Result.map((item,index)=>{
      if (!item || !Number.isSafeInteger(item.CarId) || seen.has(item.CarId)) throw Error('Résultat avec identifiant voiture manquant ou en double.');
      seen.add(item.CarId);
      const car=cars.get(item.CarId);if(!car)throw Error('Voiture du résultat introuvable dans Cars.');
      const driver=car.Driver && typeof car.Driver==='object' ? car.Driver : {};
      const name=typeof driver.Name==='string'?driver.Name.trim():typeof car.DriverName==='string'?car.DriverName.trim():'';
      const guid=typeof driver.Guid==='string'?driver.Guid.trim():typeof car.DriverGuid==='string'?car.DriverGuid.trim():'';
      if(!name || name.length>150 || /[\x00-\x1f]/.test(name))throw Error('Nom de pilote manquant ou invalide.');
      if(guid.length>128 || /[\x00-\x1f]/.test(guid) || (guid && guids.has(guid.toLowerCase())))throw Error('GUID pilote invalide ou en double.');
      if(guid)guids.add(guid.toLowerCase());
      return {sourcePosition:index+1,carId:item.CarId,name,guid:guid||null};
    });
    return {date:typeof raw.Date==='string'?raw.Date.slice(0,100):null,track:typeof raw.TrackName==='string'?raw.TrackName.slice(0,120):null,layout:typeof raw.TrackConfig==='string'?raw.TrackConfig.slice(0,120):null,finish,grid:[...finish].reverse().map((driver,index)=>({...driver,gridPosition:index+1}))};
  }
  return {prepare};
});
