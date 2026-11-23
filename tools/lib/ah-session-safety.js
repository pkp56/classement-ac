'use strict';

// Une heure voisine ne prouve pas que le résultat appartient au championnat.
// Seuls les résultats présents dans son export peuvent être importés sans
// validation manuelle ; les autres restent signalés comme indisponibles.
function retainVerifiedSessions(items, diagnostics) {
  for (const item of items) {
    if (item.source !== 'export') {
      item.source = 'missing';
      diagnostics.missing.push(item);
    }
  }
  return items.filter(item => item.source === 'export');
}
module.exports = { retainVerifiedSessions };
