const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

// Permet au serveur de lire les données JSON envoyées par le site
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Route pour charger la page principale
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ROUTE DE SAUVEGARDE : Enregistre les classements sur le serveur
app.post('/api/save-championship', requireAdmin, (req, res) => {
    try {
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir);
        }
        
        const filePath = path.join(dataDir, 'championship.json');
        fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2));
        
        res.json({ status: "success", message: "Championnat sauvegardé sur le serveur !" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", message: "Erreur lors de la sauvegarde sur le serveur." });
    }
});

// Accès administrateur : variable d'environnement Render GDSPADMIN.
const crypto = require('crypto');
const adminTokens = new Set();
function requireAdmin(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !adminTokens.has(token)) return res.status(401).json({ status: 'error', message: 'Connexion administrateur requise.' });
    next();
}
app.post('/api/admin/login', (req, res) => {
    const configuredPassword = process.env.GDSPADMIN || process.env.ADMIN_PASSWORD;
    if (!configuredPassword) return res.status(503).json({ status: 'error', message: 'La variable GDSPADMIN doit être configurée dans Render.' });
    const supplied = Buffer.from(String(req.body && req.body.password || ''));
    const expected = Buffer.from(configuredPassword);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(401).json({ status: 'error', message: 'Mot de passe incorrect.' });
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.add(token);
    res.json({ status: 'success', token });
});
app.post('/api/admin/reset-json', requireAdmin, (req, res) => {
    if (!req.body || req.body.confirmation !== 'SUPPRIMER') return res.status(400).json({ status: 'error', message: 'Confirmation manquante.' });
    try {
        const dataDir = path.join(__dirname, 'data');
        let deleted = [];
        if (fs.existsSync(dataDir)) {
            deleted = fs.readdirSync(dataDir).filter(name => name.toLowerCase().endsWith('.json') && fs.statSync(path.join(dataDir, name)).isFile());
            for (const name of deleted) fs.unlinkSync(path.join(dataDir, name));
        }
        res.json({ status: 'success', deletedCount: deleted.length, message: deleted.length + ' fichier(s) JSON supprimé(s) dans le dossier data.' });
    } catch (error) {
        console.error('Échec de réinitialisation JSON :', error);
        res.status(500).json({ status: 'error', message: 'Erreur pendant la suppression des fichiers JSON.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
