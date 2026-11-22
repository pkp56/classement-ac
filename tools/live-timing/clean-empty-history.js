'use strict';
// Nettoyage volontaire, hors ligne : uniquement les archives au format courant
// dont toutes les listes de données sont explicitement vides.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function emptyArchive(row) {
  const s = row && row.snapshot;
  return !!s && typeof s === 'object' && !Array.isArray(s) &&
    [s.storedTimes, s.cars, s.bestLaps, s.events, s.collisions,
      row.classification, row.best_laps, row.events].every(v => Array.isArray(v) && v.length === 0);
}
function writeBackup(dir, data) {
  if (!dir || !path.isAbsolute(dir)) throw new Error('Un dossier de sauvegarde absolu est obligatoire.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'live-history-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID() + '.json');
  fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
  return file;
}
function summary(rows) {
  const selected = rows.filter(emptyArchive);
  console.log('Archives examinees : ' + rows.length + ' ; archives explicitement vides : ' + selected.length);
  for (const r of selected) console.log('  id=' + r.id + ' | ' + String(r.started_at || '') + ' | ' + String(r.server_name || '') + ' | ' + String(r.track || '') + ' | ' + String(r.session_type || ''));
  return selected;
}
async function run(args = process.argv.slice(2)) {
  const apply = args.includes('--apply');
  if (args.some(a => a !== '--apply')) throw new Error('Option inconnue.');
  const envFile = String(process.env.LIVE_HISTORY_FILE || '').trim();
  if (envFile === 'off') throw new Error('Historique desactive : aucune modification.');
  const url = process.env.LIVE_DATABASE_URL || process.env.DATABASE_URL || '';
  const backupDir = process.env.GDSP_LIVE_CLEAN_BACKUP_DIR;
  if (envFile || !url) {
    const file = path.resolve(envFile || path.join('data', 'live-history.json'));
    console.log('Stockage fichier : ' + file);
    if (!fs.existsSync(file)) throw new Error('Fichier historique introuvable : ' + file);
    const original = fs.readFileSync(file, 'utf8');
    const rows = JSON.parse(original);
    if (!Array.isArray(rows)) throw new Error('Format historique inconnu : aucune modification.');
    const selected = summary(rows);
    if (!apply || !selected.length) { console.log('Aucune suppression effectuee.'); return; }
    const backup = writeBackup(backupDir, original);
    const selectedRows = new Set(selected);
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(rows.filter(r => !selectedRows.has(r)), null, 1), { flag: 'wx', mode: 0o600 });
      if (fs.readFileSync(file, 'utf8') !== original) throw new Error('Historique modifie pendant le nettoyage : abandon.');
      fs.renameSync(tmp, file);
    } finally { try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    console.log('Sauvegarde : ' + backup + '\nArchives supprimees : ' + selected.length);
    return;
  }
  console.log('Stockage : PostgreSQL (table gdsp_live_sessions).');
  const { Client } = require('pg');
  const client = new Client({ connectionString: url, ssl: /neon\.tech|render\.com/i.test(url) ? { rejectUnauthorized: false } : undefined });
  try {
    await client.connect();
    await client.query('BEGIN');
    // Empêche une modification concurrente entre sauvegarde et suppression.
    await client.query('LOCK TABLE gdsp_live_sessions IN ACCESS EXCLUSIVE MODE');
    const rows = (await client.query('SELECT * FROM gdsp_live_sessions ORDER BY id')).rows;
    const selected = summary(rows);
    if (!apply || !selected.length) { await client.query('ROLLBACK'); console.log('Aucune suppression effectuee.'); return; }
    const backup = writeBackup(backupDir, JSON.stringify(rows, null, 1));
    const result = await client.query('DELETE FROM gdsp_live_sessions WHERE id = ANY($1::bigint[])', [selected.map(r => r.id)]);
    if (result.rowCount !== selected.length) throw new Error('Nombre de suppressions inattendu : annulation.');
    await client.query('COMMIT');
    console.log('Sauvegarde : ' + backup + '\nArchives supprimees : ' + result.rowCount);
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { await client.end(); }
}
if (require.main === module) run().catch(e => { console.error('Nettoyage abandonne : ' + e.message); process.exitCode = 1; });
module.exports = { emptyArchive, run };
