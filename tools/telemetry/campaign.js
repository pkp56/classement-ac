'use strict';
/*
 * Campagne de test BoP — 10 jours.
 *
 * Chaque jour a un objectif précis. Ce module sert à deux choses :
 *   1. décrire le protocole (ce qu'on mesure, pourquoi, et ce que ça invalide
 *      si on l'oublie) ;
 *   2. vérifier, à partir des données réellement collectées, que le protocole a
 *      été respecté — et **bloquer la génération du rapport** si ce n'est pas le
 *      cas. Un BoP calculé sur un protocole incomplet est plus dangereux qu'un
 *      BoP absent : il ferait changer les voitures pour de mauvaises raisons.
 */

const DAYS = [
  {
    day: 1,
    title: 'Référence',
    needs: ['session', 'laps'],
    purpose: 'Établir le tour médian de référence sur le circuit du prochain événement, avec un seul pilote et une seule voiture.',
    records: ['tour médian', 'meilleur tour', 'écart-type', 'météo + grip + FUEL_RATE + TYRE_WEAR_RATE'],
    invalidates: 'Sans FUEL_RATE ni TYRE_WEAR_RATE, la session n\'est pas comparable aux suivantes.'
  },
  {
    day: 2,
    title: 'Consommation et usure',
    needs: ['laps', 'fuel', 'tyre'],
    purpose: 'Relais longs (10 à 15 tours) pour mesurer les litres par tour et l\'usure par tour.',
    records: ['L/tour', 'usure %/tour par roue', 'températures de gomme'],
    invalidates: 'Un relais de 3 tours ne dit rien : l\'usure n\'est pas linéaire sur la fin de vie.'
  },
  {
    day: 3,
    title: 'Deuxième pilote',
    needs: ['laps', 'twoDrivers'],
    purpose: 'Le même programme avec un deuxième pilote : mesurer l\'écart inter-pilotes sur la même voiture.',
    records: ['écart entre pilotes', 'écart-type par pilote'],
    invalidates: 'Sans ce jour, on ne sait pas si un écart vient de la voiture ou du pilote.'
  },
  {
    day: 4,
    title: 'Mesure du pit-lane',
    needs: ['pitProfile'],
    purpose: 'Mesurer une fois pour toutes le temps perdu entrée → sortie des stands, le débit de ravitaillement et la durée du changement de gommes.',
    records: ['pit-lane loss (ms)', 'L/s de ravitaillement', 'durée changement de gommes'],
    invalidates: 'Sans ces trois valeurs, aucun temps de course ne peut être simulé. C\'est la brique la plus souvent oubliée.'
  },
  {
    day: 5,
    title: 'Sensibilité à la masse',
    needs: ['laps', 'fuel'],
    purpose: 'Relais avec réservoir bas puis plein : mesurer combien de temps au tour coûte 10 kg.',
    records: ['delta s / 10 kg', 'conso à vide vs plein'],
    invalidates: 'Sans cette mesure, un « lest de 10 kg » proposé par le BoP serait un chiffre inventé.'
  },
  {
    day: 6,
    title: 'Matrice pilote × voiture (1/3)',
    needs: ['laps', 'fuel', 'tyre', 'twoDrivers'],
    purpose: 'Chaque pilote roule dans chaque voiture candidate, sur le même circuit.',
    records: ['matrice pilote × voiture'],
    invalidates: 'Si un pilote manque une voiture, il sort de la comparaison.'
  },
  {
    day: 7,
    title: 'Matrice pilote × voiture (2/3)',
    needs: ['laps', 'fuel', 'tyre', 'twoDrivers'],
    purpose: 'Suite de la matrice, conditions identiques.',
    records: ['matrice pilote × voiture'],
    invalidates: 'Changer la météo entre deux jours rend la matrice inutilisable.'
  },
  {
    day: 8,
    title: 'Matrice pilote × voiture (3/3)',
    needs: ['laps', 'fuel', 'tyre', 'twoDrivers'],
    purpose: 'Fin de la matrice : chaque voiture a été roulée par tous les pilotes.',
    records: ['matrice complète'],
    invalidates: 'C\'est ce jour qui rend le BoP défendable : on compare les deltas, pas les temps absolus.'
  },
  {
    day: 9,
    title: 'Reproductibilité',
    needs: ['laps', 'repro'],
    purpose: 'Refaire à l\'identique une mesure déjà faite. Si le résultat bouge de plus de 0,3 %, la donnée n\'est pas fiable.',
    records: ['écart de reproductibilité'],
    invalidates: 'Sans contrôle de reproductibilité, on ne sait pas distinguer une vraie différence de voiture du bruit.'
  },
  {
    day: 10,
    title: 'Rapport et décision',
    needs: ['laps', 'fuel', 'tyre', 'pitProfile', 'twoDrivers'],
    purpose: 'Générer le rapport CSV / Markdown / HTML, lire les deltas et décider du BoP (lest, limiteur, ou rien).',
    records: ['rapport BoP', 'décision motivée'],
    invalidates: 'Toute décision prise sans les jours précédents est une intuition, pas une mesure.'
  }
];

/**
 * Évalue la couverture du protocole à partir des données collectées.
 * @param {object} data
 * @param {Array} data.laps        tours collectés
 * @param {object} data.session    contexte de session (avec fuel_rate, tyre_wear_rate)
 * @param {object|null} data.pitProfile  mesures pit-lane / ravitaillement / gommes
 * @param {Array} data.cars        voitures distinctes vues
 * @param {Array} data.driverGuids pilotes distincts vus
 * @param {number|null} data.reproDeltaMs écart mesuré au jour 9, en ms
 * @returns {{days:Array, ready:boolean, blocking:string[]}}
 */
function evaluateCampaign(data) {
  const laps = (data && data.laps) || [];
  const measuredLaps = laps.filter(l => l.measured !== false && Number.isFinite(Number(l.lapMs != null ? l.lapMs : l.lap_ms)));
  const withFuel = measuredLaps.filter(l => Number.isFinite(Number(l.fuel_used_l != null ? l.fuel_used_l : l.fuelUsedL)));
  const withTyre = measuredLaps.filter(l => Number.isFinite(Number(l.tyre_wear_pct != null ? l.tyre_wear_pct : l.tyreWearPct)));
  const drivers = [...new Set(measuredLaps.map(l => l.driver_guid || l.driverGuid).filter(Boolean))];
  const cars = [...new Set(measuredLaps.map(l => l.car).filter(Boolean))];
  const session = (data && data.session) || null;
  const pitProfile = (data && data.pitProfile) || null;
  const reproDelta = data && data.reproDeltaMs != null ? Number(data.reproDeltaMs) : null;

  const checks = {
    session: !!(session && session.track),
    laps: measuredLaps.length >= 10,
    fuel: withFuel.length >= 5,
    tyre: withTyre.length >= 5,
    twoDrivers: drivers.length >= 2,
    pitProfile: !!(pitProfile && Number.isFinite(Number(pitProfile.pit_lane_loss_ms)) && Number.isFinite(Number(pitProfile.refuel_rate_lps)) && Number.isFinite(Number(pitProfile.tyre_change_ms))),
    repro: reproDelta != null && Math.abs(reproDelta) <= 0.003 * (measuredLaps.length ? medianLap(measuredLaps) : 1)
  };
  // Le jour 4 (pit-lane) et le jour 9 (repro) ne peuvent pas être déduits des
  // tours : ce sont des mesures dédiées, déclarées explicitement.
  const contextRates = !!(session && session.fuel_rate != null && session.tyre_wear_rate != null);

  const days = DAYS.map(d => {
    let ok = false;
    let missing = [];
    switch (d.day) {
      case 1:
        ok = checks.session && checks.laps && contextRates;
        if (!checks.session) missing.push('aucune session ouverte');
        if (!checks.laps) missing.push('moins de 10 tours mesurés');
        if (!contextRates) missing.push('FUEL_RATE / TYRE_WEAR_RATE absents de la session');
        break;
      case 2:
        ok = checks.fuel && checks.tyre;
        if (!checks.fuel) missing.push('aucune mesure de carburant (le live timing seul ne suffit pas)');
        if (!checks.tyre) missing.push('aucune mesure d\'usure de gomme');
        break;
      case 3:
        ok = checks.twoDrivers;
        if (!checks.twoDrivers) missing.push('un seul pilote enregistré');
        break;
      case 4:
        ok = checks.pitProfile;
        if (!checks.pitProfile) missing.push('pit-lane / ravitaillement / changement de gommes non mesurés');
        break;
      case 5:
        ok = checks.fuel && cars.length >= 1;
        if (!checks.fuel) missing.push('pas de mesure carburant pour la sensibilité à la masse');
        break;
      case 6:
      case 7:
      case 8:
        ok = checks.twoDrivers && cars.length >= 2 && checks.fuel && checks.tyre;
        if (!checks.twoDrivers) missing.push('un seul pilote');
        if (cars.length < 2) missing.push('une seule voiture');
        if (!checks.fuel || !checks.tyre) missing.push('mesures carburant/gomme incomplètes');
        break;
      case 9:
        ok = checks.repro;
        if (!checks.repro) missing.push('contrôle de reproductibilité non fait (écart ≤ 0,3 %)');
        break;
      case 10:
        ok = checks.session && checks.laps && checks.fuel && checks.tyre && checks.pitProfile && checks.twoDrivers;
        if (!ok) missing.push('les jours 1 à 4 et 6 ne sont pas tous validés');
        break;
      default:
        ok = false;
    }
    return { day: d.day, title: d.title, ok, missing, purpose: d.purpose, records: d.records, invalidates: d.invalidates };
  });

  const blocking = days.filter(d => !d.ok).map(d => `J${d.day} ${d.title} : ${d.missing.join(' ; ')}`);
  return {
    days,
    ready: blocking.length === 0,
    blocking,
    coverage: {
      laps: measuredLaps.length,
      lapsWithFuel: withFuel.length,
      lapsWithTyre: withTyre.length,
      drivers: drivers.length,
      cars: cars.length,
      contextRates
    }
  };
}

function medianLap(laps) {
  const vals = laps.map(l => Number(l.lapMs != null ? l.lapMs : l.lap_ms)).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!vals.length) return null;
  return vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
}

module.exports = { DAYS, evaluateCampaign, medianLap };
