'use strict';
/**
 * Métadonnées des circuits du championnat Lola T290 GDSP (6 manches).
 *
 * Source de vérité pour `tools/build-circuits-data.js` qui produit
 * `data/circuits.json`.
 *
 * Conventions
 * -----------
 * - `published` : calendrier publié sur le site (date ISO + libellé + vainqueur).
 *   Une manche sans `date` est « à venir » : le build n'invente jamais de date.
 * - `sectors` : bornes de secteur en fraction de tour, 0 et 1 **inclus**
 *   (`[0, 0.28, 0.65, 1]` => 3 secteurs).
 * - `asset` : dossier sous `maquette-circuit/assets/tracks/` contenant
 *   `line.json`, `preview.png`, `surfaces.ini`, `overlays.ini`, `ui_track.json`.
 * - `driverFolder` : nom du dossier `fast_lane.ai` du mod, tel qu'il apparaît
 *   dans les sessions importées (clé d'appariement avec `s.track`).
 */

/** Surfaces partagées par tous les circuits (grip par défaut si `.ini` muet). */
const COMMON_SURFACES = {
  ROAD: { label: 'Asphalte', note: 'Surface de course principale' },
  ASPHALT: { label: 'Asphalte', note: 'Surface de course principale' },
  CURB: { label: 'Vibreurs', note: 'Francissables, attention au survirage' },
  PITS: { label: 'Voie des stands', note: "Zone de dégagement — vitesse limitée" },
  PIT: { label: 'Voie des stands', note: "Zone de dégagement — vitesse limitée" },
  GRASS: { label: 'Herbe', note: 'Hors piste — adhérence très faible' },
  SAND: { label: 'Graviers', note: 'Bac à gravier — sortie de piste' },
  PADDOCK: { label: 'Paddock', note: 'Hors piste — validé uniquement aux stands' },
  CONCRETE: { label: 'Béton', note: 'Zone de dégagement' },
  CARPET: { label: 'Tapis', note: 'Tapis vert / dégagement bordure' }
};

/**
 * Les 6 manches, dans l'ordre du championnat.
 * M6 (Österreichring 1979) est « à venir » : `published.date` reste null.
 */
const TRACKS = [
  {
    round: 1,
    id: 'mont-tremblant-69',
    name: 'Mont-Tremblant 1969',
    shortName: 'Mont-Tremblant',
    layout: 'Grand Prix (League)',
    layoutKey: 'gp_league_grid',
    driverFolder: 'mt-tremblant_69',
    country: 'Canada',
    countryCode: 'CAN',
    city: 'St-Jovite',
    gps: '46° 07′ 17″ N · 74° 35′ 40″ W',
    year: 1969,
    author: 'Patrice Cote',
    version: '1.2',
    direction: 'clockwise',
    pitboxes: 34,
    width: '8,5 m',
    driveFolderId: '1lOuOZtNJdgH7gna1dsKvDUUBSX0P2hk4',
    driveName: 'mt-tremblant_69',
    format: '2 courses',
    asset: 'tremblant',
    sectors: [0, 0.280, 0.650, 1],
    published: { date: '2026-09-08', label: '8 septembre 2026', winner: 'Thomas PONGE' }
  },
  {
    round: 2,
    id: 'riverside',
    name: 'Riverside International Raceway',
    shortName: 'Riverside',
    layout: 'Long (56 pits)',
    layoutKey: 'long_56',
    driverFolder: 'riverside',
    country: 'U.S.A.',
    countryCode: 'USA',
    city: 'Riverside (Californie)',
    gps: null,
    year: null,
    author: null,
    version: '1.0',
    direction: 'clockwise',
    pitboxes: 56,
    width: '9 à 12 m',
    driveFolderId: '130coM7HrdLB0_kHb0ttcerrYcTe6sktc',
    driveName: 'riverside',
    format: '2 courses',
    asset: 'riverside',
    sectors: [0, 0.240, 0.660, 1],
    published: { date: '2026-09-22', label: '22 septembre 2026', winner: 'Thomas PONGE' }
  },
  {
    round: 3,
    id: 'sebring-90s',
    name: 'Sebring International Raceway',
    shortName: 'Sebring',
    layout: 'Grand Prix',
    layoutKey: '',
    driverFolder: 'sebring_90s',
    country: 'U.S.A.',
    countryCode: 'USA',
    city: 'Sebring (Floride)',
    gps: '27° 30′ 45″ N · 81° 26′ 26″ W',
    year: 1999,
    author: null,
    version: '1.0',
    direction: 'clockwise',
    pitboxes: 32,
    width: '7 à 11 m',
    driveFolderId: '1c3lISoUSH82srvI63PHMZFTRQzJKNBO9',
    driveName: 'sebring_90s',
    format: 'Endurance',
    asset: 'sebring',
    sectors: [0, 0.300, 0.700, 1],
    published: { date: '2026-10-06', label: '6 octobre 2026', winner: 'Tx3Rony68z' }
  },
  {
    round: 4,
    id: 'mid-ohio',
    name: 'Mid-Ohio Sports Car Course',
    shortName: 'Mid-Ohio',
    layout: 'No Chicane',
    layoutKey: 'chicane',
    driverFolder: 'mid_ohio',
    country: 'U.S.A.',
    countryCode: 'USA',
    city: null,
    gps: '40.6907° N · 82.6376° W',
    year: null,
    author: 'Terra21',
    version: '1.0',
    direction: 'clockwise',
    pitboxes: 32,
    width: '8 à 10 m',
    driveFolderId: '1GX3lDUu8fDRJMS0xKmpUJUOEB_KGzkFg',
    driveName: 'mid_ohio',
    format: '2 courses',
    asset: 'midohio',
    sectors: [0, 0.290, 0.680, 1],
    published: { date: '2026-10-20', label: '20 octobre 2026', winner: 'Kimy Hoyer' }
  },
  {
    round: 5,
    id: 'mexico-67',
    name: '6th GP Mexico 1967',
    shortName: 'Mexico 1967',
    layout: 'Grand Prix',
    layoutKey: 'gp',
    driverFolder: '6thgpmexico67',
    country: 'Mexique',
    countryCode: 'MEX',
    city: 'Mexico City',
    gps: '19° 26′ 55″ N · 99° 08′ 59″ W',
    year: 1967,
    author: 'Tibor Beke, Soma Plecsko · rework M.T.K.',
    version: 'rework',
    direction: 'clockwise',
    pitboxes: 60,
    width: '10 à 12 m',
    driveFolderId: '1GOiVzcPOKGOOHg1hyAL1lvtps4PY9Uyh',
    driveName: '6thgpmexico67',
    format: '2 courses',
    asset: 'mexico67',
    sectors: [0, 0.300, 0.700, 1],
    published: { date: '2026-11-03', label: '3 novembre 2026', winner: 'Kami_Kaze31' }
  },
  {
    round: 6,
    id: 'oesterreichring-1979',
    name: 'Österreichring 1979',
    shortName: 'Österreichring',
    layout: 'Avec Chicane (Hella-Licht)',
    layoutKey: 'chicane',
    driverFolder: 'oesterreichring1979',
    country: 'Autriche',
    countryCode: 'AUT',
    city: 'Spielberg (Styrie)',
    gps: '47° 13′ 52″ N · 14° 47′ 36″ E',
    year: 1979,
    author: 'Jim Lloyd & Terra 21',
    version: '1.0',
    direction: 'clockwise',
    pitboxes: 32,
    width: '9 à 12 m',
    driveFolderId: '1V98St2Q9GFirTMH-anhRbzEZZ4CpOYBo',
    driveName: 'oesterreichring1979',
    format: 'À venir',
    // Pas de dossier `assets/tracks/` : le tracé vient de `maquette-circuit/track-data.js`.
    asset: null,
    // Bornes de secteur. Le fichier OST1979_DATA donne 0.0006 comme départ :
    // la ligne d'arrivée du mod est décalée de ~4 m, on la ramène à 0 pour que
    // la chronométrie couvre bien le tour entier.
    sectors: [0, 0.263, 0.777, 1],
    // Manche à venir : aucune date inventée, `date` reste null.
    published: { date: null, label: null, winner: null }
  }
];

module.exports = { TRACKS, COMMON_SURFACES };
