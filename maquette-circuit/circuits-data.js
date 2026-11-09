/*
 * Données des circuits du championnat International Series Lola T290 - GDSP
 * Infos extraites des ui_track.json sur Google Drive
 * Les tracés SVG et dénivelés réels nécessitent l'extraction des fast_lane.ai de chaque circuit
 */

window.CIRCUITS_DATA = {

  // ============================================================
  // M1 · Mont-Tremblant 69 (Canada)
  // ============================================================
  'mont-tremblant-69': {
    id: 'mont-tremblant-69',
    name: 'Mont-Tremblant 1969',
    layout: 'Grand Prix (League)',
    country: 'Canada',
    city: 'St-Jovite',
    gps: '46° 07′ 17″ N · 74° 35′ 40″ W',
    length: 4260,
    lengthStr: '4,260 km',
    pitboxes: 34,
    direction: 'clockwise',
    year: 1969,
    author: 'Patrice Cote',
    version: '1.2',
    elevation: { min: 230, max: 290, delta: 60 },
    layoutLabel: 'Configuration Grand Prix · Sens horaire',
    driveFolderId: '1lOuOZtNJdgH7gna1dsKvDUUBSX0P2hk4',
    driveName: 'mt-tremblant_69',
    variants: ['gp'],
    surfaces: [
      { key: 'ROAD', label: 'Piste', grip: 97, valid: true, pit: false, note: 'Surface de course principale' },
      { key: 'CURB', label: 'Bordure', grip: 85, valid: true, pit: false, note: 'Zones de bordure autorisées' },
      { key: 'CARPET', label: 'Tapis', grip: 70, valid: true, pit: false, note: 'Zones de ralentissement' },
      { key: 'PIT', label: 'Stands', grip: 95, valid: true, pit: true, note: 'Voie des stands' },
      { key: 'OFFTRACK', label: 'Hors-piste', grip: 30, valid: false, pit: false, note: 'Coup de circuit sanctionné' },
      { key: 'INSIDE', label: 'Intérieur', grip: 20, valid: false, pit: false, note: 'Coupe d\'intérieur interdite' }
    ],
    sectors: [0.000, 0.280, 0.650, 1.000],
    sections: [
      { id: 1, name: 'Virage du Casino', type: 'Virage', dist: 0.45, alt: 245, dy: +8, slope: +2.1, gear: '3' },
      { id: 2, name: 'Virage de l\'Église', type: 'Épingle', dist: 1.20, alt: 260, dy: +15, slope: +3.8, gear: '2' },
      { id: 3, name: 'Virage de la Descente', type: 'Virage rapide', dist: 2.10, alt: 235, dy: -12, slope: -4.2, gear: '4' },
      { id: 4, name: 'Virage du Pont', type: 'Virage', dist: 2.80, alt: 250, dy: +10, slope: +2.5, gear: '3' },
      { id: 5, name: 'Virage du Village', type: 'Épingle', dist: 3.40, alt: 270, dy: +8, slope: +1.9, gear: '2' },
      { id: 6, name: 'Virage de la Montée', type: 'Virage rapide', dist: 3.90, alt: 285, dy: +5, slope: +1.2, gear: '4' },
      { id: 7, name: 'Virage de la Descente Finale', type: 'Virage', dist: 4.50, alt: 240, dy: -20, slope: -5.1, gear: '3' },
      { id: 8, name: 'Virage des Stands', type: 'Virage d\'entrée stands', dist: 4.90, alt: 230, dy: -5, slope: -1.3, gear: '2' },
      { id: 9, name: 'Ligne de départ/arrivée', type: 'Ligne droite', dist: 5.40, alt: 235, dy: +2, slope: +0.5, gear: '5' }
    ],
    demoCollisions: [
      { id: 1, a: 'Kimy Hoyer', b: 'SHERMAN', speed: 28.5, lap: 1, clock: '00:03:12', corner: 'Virage du Casino', x: 0, z: 0 },
      { id: 2, a: 'Fmherrou', b: 'Tofusan', speed: 15.2, lap: 3, clock: '00:12:45', corner: 'Virage de l\'Église', x: 0, z: 0 },
      { id: 3, a: 'Assassins Street', b: 'Streetbike', speed: 35.0, lap: 5, clock: '00:21:30', corner: 'Virage de la Descente', x: 0, z: 0 }
    ],
    records: {
      s1: { time: '38.210', driver: 'Kimy Hoyer' },
      s2: { time: '45.820', driver: 'SHERMAN' },
      s3: { time: '28.150', driver: 'Fmherrou' },
      ideal: '1:52.180',
      best: '1:52.940'
    }
  },

  // ============================================================
  // M2 · Riverside (USA)
  // ============================================================
  'riverside': {
    id: 'riverside',
    name: 'Riverside',
    layout: 'NASCAR (56 pits)',
    country: 'U.S.A.',
    city: 'Riverside',
    gps: 'Non disponible',
    length: 4220,
    lengthStr: '4,220 km',
    pitboxes: 56,
    direction: 'clockwise',
    year: null,
    author: null,
    version: null,
    elevation: { min: 230, max: 250, delta: 20 },
    layoutLabel: 'Configuration NASCAR · Sens horaire',
    driveFolderId: '130coM7HrdLB0_kHb0ttcerrYcTe6sktc',
    driveName: 'riverside',
    variants: ['long', 'short', 'spike', 'nascar'],
    surfaces: [
      { key: 'ROAD', label: 'Piste', grip: 96, valid: true, pit: false, note: 'Surface de course principale' },
      { key: 'CURB', label: 'Bordure', grip: 82, valid: true, pit: false, note: 'Zones de bordure autorisées' },
      { key: 'CARPET', label: 'Tapis', grip: 68, valid: true, pit: false, note: 'Zones de ralentissement' },
      { key: 'PIT', label: 'Stands', grip: 94, valid: true, pit: true, note: 'Voie des stands' },
      { key: 'OFFTRACK', label: 'Hors-piste', grip: 25, valid: false, pit: false, note: 'Coup de circuit sanctionné' },
      { key: 'INSIDE', label: 'Intérieur', grip: 15, valid: false, pit: false, note: 'Coupe d\'intérieur interdite' }
    ],
    sectors: [0.000, 0.300, 0.700, 1.000],
    sections: [
      { id: 1, name: 'Virage 1', type: 'Virage', dist: 0.60, alt: 240, dy: +3, slope: +0.7, gear: '4' },
      { id: 2, name: 'Virage 2', type: 'Virage', dist: 1.10, alt: 245, dy: +2, slope: +0.4, gear: '3' },
      { id: 3, name: 'Virage 3', type: 'Virage rapide', dist: 1.80, alt: 248, dy: +1, slope: +0.2, gear: '4' },
      { id: 4, name: 'Virage 4', type: 'Virage', dist: 2.40, alt: 242, dy: -3, slope: -0.8, gear: '3' },
      { id: 5, name: 'Virage 5', type: 'Virage rapide', dist: 3.00, alt: 246, dy: +2, slope: +0.5, gear: '4' },
      { id: 6, name: 'Virage 6', type: 'Épingle', dist: 3.60, alt: 241, dy: -2, slope: -0.6, gear: '2' },
      { id: 7, name: 'Virage 7', type: 'Virage', dist: 4.10, alt: 244, dy: +1, slope: +0.3, gear: '3' },
      { id: 8, name: 'Virage des Stands', type: 'Virage d\'entrée stands', dist: 4.60, alt: 238, dy: -3, slope: -0.7, gear: '2' },
      { id: 9, name: 'Ligne de départ/arrivée', type: 'Ligne droite', dist: 5.00, alt: 235, dy: -1, slope: -0.2, gear: '5' }
    ],
    demoCollisions: [],
    records: {
      s1: { time: '52.100', driver: '51R Sherman' },
      s2: { time: '48.350', driver: 'Kimy Hoyer' },
      s3: { time: '39.200', driver: 'Fmherrou' },
      ideal: '2:19.650',
      best: '2:20.110'
    }
  },

  // ============================================================
  // M3 · Sebring 90s (USA)
  // ============================================================
  'sebring-90s': {
    id: 'sebring-90s',
    name: 'Sebring',
    layout: 'International Raceway',
    country: 'USA',
    city: 'Sebring',
    gps: '27° 30′ 45″ N · 81° 26′ 26″ W',
    length: 5811,
    lengthStr: '5,811 km',
    pitboxes: 32,
    direction: 'clockwise',
    year: 1999,
    author: null,
    version: null,
    elevation: { min: 10, max: 22, delta: 12 },
    layoutLabel: 'Configuration Sebring 90s · Sens horaire',
    driveFolderId: '1c3lISoUSH82srvI63PHMZFTRQzJKNBO9',
    driveName: 'sebring_90s',
    variants: ['fia_gt', 'johnson_club', 'school'],
    surfaces: [
      { key: 'ROAD', label: 'Piste', grip: 95, valid: true, pit: false, note: 'Surface de course principale' },
      { key: 'CURB', label: 'Bordure', grip: 80, valid: true, pit: false, note: 'Zones de bordure autorisées' },
      { key: 'CARPET', label: 'Tapis', grip: 65, valid: true, pit: false, note: 'Zones de ralentissement' },
      { key: 'PIT', label: 'Stands', grip: 93, valid: true, pit: true, note: 'Voie des stands' },
      { key: 'OFFTRACK', label: 'Hors-piste', grip: 20, valid: false, pit: false, note: 'Coup de circuit sanctionné' },
      { key: 'INSIDE', label: 'Intérieur', grip: 10, valid: false, pit: false, note: 'Coupe d\'intérieur interdite' }
    ],
    sectors: [0.000, 0.330, 0.760, 1.000],
    sections: [
      { id: 1, name: 'Virage 1 (Hairpin)', type: 'Épingle', dist: 0.80, alt: 15, dy: +2, slope: +0.3, gear: '2' },
      { id: 2, name: 'Virage 2', type: 'Virage', dist: 1.60, alt: 18, dy: +1, slope: +0.2, gear: '3' },
      { id: 3, name: 'Virage 3', type: 'Virage rapide', dist: 2.50, alt: 20, dy: +1, slope: +0.3, gear: '4' },
      { id: 4, name: 'Virage 4', type: 'Virage', dist: 3.30, alt: 14, dy: -3, slope: -0.6, gear: '3' },
      { id: 5, name: 'Virage 5', type: 'Virage rapide', dist: 4.10, alt: 16, dy: +1, slope: +0.2, gear: '4' },
      { id: 6, name: 'Virage 6', type: 'Épingle', dist: 4.80, alt: 12, dy: -2, slope: -0.5, gear: '2' },
      { id: 7, name: 'Virage 7', type: 'Virage', dist: 5.30, alt: 14, dy: +1, slope: +0.3, gear: '3' },
      { id: 8, name: 'Virage des Stands', type: 'Virage d\'entrée stands', dist: 5.70, alt: 10, dy: -2, slope: -0.4, gear: '2' },
      { id: 9, name: 'Ligne de départ/arrivée', type: 'Ligne droite', dist: 6.40, alt: 11, dy: +1, slope: +0.2, gear: '5' }
    ],
    demoCollisions: [],
    records: {
      s1: { time: '1:02.450', driver: 'Fmherrou' },
      s2: { time: '1:15.200', driver: 'Kimy Hoyer' },
      s3: { time: '58.900', driver: 'SHERMAN' },
      ideal: '3:16.550',
      best: '3:17.320'
    }
  },

  // ============================================================
  // M4 · Mid-Ohio (USA)
  // ============================================================
  'mid-ohio': {
    id: 'mid-ohio',
    name: 'Mid-Ohio',
    layout: 'No Chicane',
    country: 'USA',
    city: null,
    gps: '40° 41′ 27″ N · 82° 38′ 15″ W',
    length: 3621,
    lengthStr: '3,621 km',
    pitboxes: 32,
    direction: 'clockwise',
    year: null,
    author: 'Terra21',
    version: null,
    elevation: { min: 330, max: 360, delta: 30 },
    layoutLabel: 'Configuration Sans Chicane · Sens horaire',
    driveFolderId: '1GX3lDUu8fDRJMS0xKmpUJUOEB_KGzkFg',
    driveName: 'mid_ohio',
    variants: ['chicane', 'no_chicane'],
    surfaces: [
      { key: 'ROAD', label: 'Piste', grip: 94, valid: true, pit: false, note: 'Surface de course principale' },
      { key: 'CURB', label: 'Bordure', grip: 84, valid: true, pit: false, note: 'Zones de bordure autorisées' },
      { key: 'CARPET', label: 'Tapis', grip: 66, valid: true, pit: false, note: 'Zones de ralentissement' },
      { key: 'PIT', label: 'Stands', grip: 92, valid: true, pit: true, note: 'Voie des stands' },
      { key: 'OFFTRACK', label: 'Hors-piste', grip: 22, valid: false, pit: false, note: 'Coup de circuit sanctionné' },
      { key: 'INSIDE', label: 'Intérieur', grip: 12, valid: false, pit: false, note: 'Coupe d\'intérieur interdite' }
    ],
    sectors: [0.000, 0.250, 0.600, 1.000],
    sections: [
      { id: 1, name: 'Keyhole', type: 'Épingle', dist: 0.50, alt: 340, dy: +5, slope: +1.2, gear: '2' },
      { id: 2, name: 'The Esses', type: 'Enchaînement', dist: 1.10, alt: 350, dy: +3, slope: +0.6, gear: '3' },
      { id: 3, name: 'The Carousel', type: 'Virage rapide', dist: 1.80, alt: 355, dy: +2, slope: +0.4, gear: '4' },
      { id: 4, name: 'Thunder Valley', type: 'Virage rapide', dist: 2.40, alt: 345, dy: -5, slope: -1.1, gear: '5' },
      { id: 5, name: 'The Tollhouse', type: 'Virage', dist: 3.00, alt: 335, dy: -5, slope: -1.2, gear: '3' },
      { id: 6, name: 'The Picnic Tables', type: 'Virage rapide', dist: 3.60, alt: 340, dy: +2, slope: +0.5, gear: '4' },
      { id: 7, name: 'The Bottom', type: 'Virage', dist: 4.20, alt: 330, dy: -5, slope: -1.3, gear: '3' },
      { id: 8, name: 'Virage des Stands', type: 'Virage d\'entrée stands', dist: 4.80, alt: 332, dy: +1, slope: +0.3, gear: '2' },
      { id: 9, name: 'Ligne de départ/arrivée', type: 'Ligne droite', dist: 5.40, alt: 335, dy: +2, slope: +0.4, gear: '5' }
    ],
    demoCollisions: [],
    records: {
      s1: { time: '42.150', driver: 'Fmherrou' },
      s2: { time: '38.400', driver: 'Kimy Hoyer' },
      s3: { time: '31.200', driver: 'SHERMAN' },
      ideal: '1:51.750',
      best: '1:52.310'
    }
  },

  // ============================================================
  // M5 · Österreichring 1979 (Autriche) - DÉJÀ DÉTAILLÉ
  // ============================================================
  'oesterreichring-1979': {
    id: 'oesterreichring-1979',
    name: 'Österreichring 1979',
    layout: 'Avec Chicane / Sans Chicane',
    country: 'Autriche',
    city: 'Spielberg',
    gps: '47° 13′ 52″ N · 14° 47′ 36″ E',
    length: 5901,
    lengthStr: '5,901 km',
    pitboxes: 32,
    direction: 'clockwise',
    year: 1979,
    author: 'Jim Lloyd & Terra 21',
    version: '1.0',
    elevation: { min: -3.5, max: 68.1, delta: 71.7 },
    layoutLabel: 'Configuration Chicane Hella-Licht · Sens horaire',
    driveFolderId: '1V98St2Q9GFirTMH-anhRbzEZZ4CpOYBo',
    driveName: 'oesterreichring1979',
    variants: ['chicane', 'no_chicane'],
    surfaces: [], // rempli par track-data.js
    sectors: [0.0006, 0.2630, 0.7770, 1.000],
    sections: [], // rempli par track-data.js
    demoCollisions: [], // rempli par track-data.js
    records: {
      s1: { time: '28.412', driver: 'SHERMAN' },
      s2: { time: '54.188', driver: 'Kimy Hoyer' },
      s3: { time: '21.890', driver: 'Fmherrou' },
      ideal: '1:44.490',
      best: '1:44.812'
    }
  }

};

// Ordre des manches du championnat
window.CHAMPIONSHIP_ROUNDS = [
  { id: 'mont-tremblant-69', num: 'M1', name: 'Mont-Tremblant 69', country: 'Canada' },
  { id: 'riverside', num: 'M2', name: 'Riverside', country: 'USA' },
  { id: 'sebring-90s', num: 'M3', name: 'Sebring 90s', country: 'USA' },
  { id: 'mid-ohio', num: 'M4', name: 'Mid-Ohio', country: 'USA' },
  { id: 'oesterreichring-1979', num: 'M5', name: 'Österreichring 1979', country: 'Autriche' }
];
