/* Catégorisation conservative des inscriptions de service. La source reste
 * intacte : cette fonction ne modifie ni sessions, ni classements, ni données. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GDSPEntrantRoles=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const norm=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('fr').replace(/[^a-z0-9]+/g,' ').trim();
  function serviceRole(entrant){
    if(!entrant||typeof entrant!=='object')return '';
    const name=norm(entrant.name);
    // Noms complets uniquement : ne pas exclure un pseudo contenant simplement
    // « broadcast » ou « pace car ». Un doute reste un pilote jusqu'à vérification.
    const suffix='(?: (?:gdsp|n ?[0-9]+|[0-9]+))*';
    if(new RegExp('^(?:gdsp )?broadcast'+suffix+'$').test(name))return 'Broadcast';
    if(new RegExp('^(?:gdsp )?(?:pace ?car|safety ?car|voiture de securite)'+suffix+'$').test(name))return 'Pace car / sécurité';
    return '';
  }
  const drivers=entries=>(Array.isArray(entries)?entries:[]).filter(e=>e&&!serviceRole(e));
  const services=entries=>(Array.isArray(entries)?entries:[]).filter(e=>e&&serviceRole(e));
  return {serviceRole,drivers,services};
});
