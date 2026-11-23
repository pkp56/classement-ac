'use strict';
// Projection minimale de l'export AH : ne jamais renvoyer mots de passe,
// données de configuration serveur, GUID Steam ou export brut au navigateur.
const text=(v,max=2000)=>typeof v==='string'?v.trim().slice(0,max):'';
const values=v=>Array.isArray(v)?v:(v&&typeof v==='object'?Object.values(v):[]);
function frenchDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT/.test(value)||!/(?:Z|[+-]\d\d:\d\d)$/i.test(value)||Number(value.slice(0,4))<2000)return '';
  const year=Number(value.slice(0,4)),month=Number(value.slice(5,7)),day=Number(value.slice(8,10));
  if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate())return '';
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return '';
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(x=>[x.type,x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function summarizeChampionship(j,server,uuid){
  if(!j||typeof j!=='object'||Array.isArray(j)||!text(j.Name,120))throw new Error('Export championnat invalide.');
  if(j.ID && String(j.ID).toLowerCase()!==uuid.toLowerCase())throw new Error('Le championnat reçu ne correspond pas à la sélection.');
  const classes=Array.isArray(j.Classes)?j.Classes:[];
  const models=[...new Set(classes.flatMap(c=>Array.isArray(c.AvailableCars)?c.AvailableCars:[]).map(x=>text(x,120)).filter(x=>x&&x!=='any_car_model'))];
  // Une liste absente/incomplète n'est pas une liste vide confirmée.
  const entrantsAvailable=classes.length>0&&classes.every(c=>c&&c.Entrants&&typeof c.Entrants==='object');
  const entrants=[],seen=new Set();
  for(const c of classes)for(const e of values(c&&c.Entrants)){
    if(entrants.length>=500)break;
    if(!e||e.IsPlaceHolder||e.ConnectAsSpectator)continue;
    const name=text(e.Name,100),team=text(e.Team,100),car=text(e.Model,120);
    if(!name)continue;
    const key=(name+'\0'+team).toLowerCase();if(seen.has(key))continue;seen.add(key);
    entrants.push({name,team,car:car==='any_car_model'?'':car,skin:text(e.Skin,128)});
    if(entrants.length>=500)break;
  }
  const rounds=[];
  for(const ev of values(j.Events).slice(0,100)){
    if(!ev||typeof ev!=='object')continue;
    const weekend=ev.RaceWeekend||{};
    const sessions=Array.isArray(weekend.Sessions)?weekend.Sessions:values(ev.Sessions);
    const rc=sessions.map(s=>s&&s.RaceConfig).find(r=>r&&text(r.Track,120))||ev.RaceSetup||{};
    const track=text(rc.Track,120),layout=text(rc.TrackLayout,80);
    const summary=[];
    const configs=sessions.flatMap(session=>values(session?.RaceConfig?.Sessions));
    if(!configs.length)configs.push(...values(ev.RaceSetup?.Sessions));
    for(const c of configs){
      if(!c||typeof c!=='object')continue;
      const name=text(c.Name,60),minutes=Number(c.Time),laps=Number(c.Laps);
      if(name&&minutes>0&&Number.isFinite(minutes))summary.push(`${name} : ${minutes} min`);
      else if(name&&laps>0&&Number.isFinite(laps))summary.push(`${name} : ${laps} tour(s)`);
    }
    rounds.push({name:text(ev.Name||weekend.Name,160),date:frenchDate(ev.Scheduled),track,layout,format:summary.join(' · ').slice(0,500)});
  }
  const formats=[...new Set(rounds.map(r=>r.format).filter(Boolean))];
  let points=null;
  if(classes.length===1&&classes[0]&&classes[0].Points){
    const p=classes[0].Points;
    const cfg={};
    if(Array.isArray(p.Places)&&p.Places.length&&p.Places.length<=100&&p.Places.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0))cfg.pointsScale=p.Places;
    for(const [from,to] of [['PolePosition','polePoints'],['BestLap','bestLapPoints'],['MostLapsLed','mostLapsLedPoints'],['SecondRaceMultiplier','secondRaceMultiplier']]){
      if(typeof p[from]==='number'&&Number.isFinite(p[from])&&p[from]>=0)cfg[to]=p[from];
    }
    // 0 sur AH signifie souvent « non configuré » : ne pas remplacer le seuil GDSP.
    if(typeof p.RequiredRaceTimePercentage==='number'&&p.RequiredRaceTimePercentage>0&&p.RequiredRaceTimePercentage<=100)cfg.minPercentDistance=p.RequiredRaceTimePercentage/100;
    if(Object.keys(cfg).length)points=cfg;
  }
  return {
    server,uuid,name:text(j.Name,120),briefing:text(j.Info,2000),car:models.join(' / ').slice(0,500),
    registrationUrl:j.SignUpForm?.Enabled?`${server}/championship/${uuid}`:'',
    formatText:formats.length===1&&rounds.every(r=>r.format)?formats[0]:'',entrantsAvailable,entrants,rounds,points,
    note:[formats.length>1?'Les formats diffèrent entre les manches : aucun format unique proposé.':(formats.length&&rounds.some(r=>!r.format)?'Certaines manches n’ont pas de format exploitable : aucun format unique proposé.':''),entrants.length>=500?'Liste des engagés limitée à 500 personnes.':''].filter(Boolean).join(' ')
  };
}
module.exports={summarizeChampionship,frenchDate};
