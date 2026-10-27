const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
app.disable('x-powered-by');

// Permet au serveur de lire les données JSON envoyées par le site
app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname, { dotfiles: 'deny' }));

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
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || !Object.keys(req.body).length) {
            return res.status(400).json({ status: 'error', message: 'Championnat JSON invalide.' });
        }
        if (fs.existsSync(filePath)) {
            const backups = path.join(dataDir, 'backups');
            fs.mkdirSync(backups, { recursive: true });
            fs.copyFileSync(filePath, path.join(backups, 'championship.json.' + Date.now() + '.bak'));
        }
        const temp = filePath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
        try {
            fs.writeFileSync(temp, JSON.stringify(req.body, null, 2), { flag: 'wx' });
            fs.renameSync(temp, filePath);
        } finally {
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
        }
        
        res.json({ status: "success", message: "Championnat sauvegardé sur le serveur !" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", message: "Erreur lors de la sauvegarde sur le serveur." });
    }
});

// Accès administrateur : variable d'environnement Render GDSPADMIN.
const crypto = require('crypto');
const adminTokens = new Map();
const SESSION_MS = 8 * 60 * 60 * 1000;
const failedLogins = new Map();
function safeEqual(a, b) {
    return crypto.timingSafeEqual(
        crypto.createHash('sha256').update(String(a)).digest(),
        crypto.createHash('sha256').update(String(b)).digest()
    );
}
function requireAdmin(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !adminTokens.has(token) || adminTokens.get(token) < Date.now()) return res.status(401).json({ status: 'error', message: 'Connexion administrateur requise.' });
    next();
}
app.post('/api/admin/login', (req, res) => {
    const configuredUsername = process.env.ADMIN_USERNAME || 'gdspadmin';
    const configuredPassword = process.env.GDSPADMIN || process.env.ADMIN_PASSWORD;
    if (!configuredPassword) return res.status(503).json({ status: 'error', message: 'La variable ADMIN_PASSWORD (ou GDSPADMIN) doit être configurée dans Render.' });
    const now = Date.now();
    const ip = req.ip;
    const failures = (failedLogins.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
    if (failures.length >= 10) return res.status(429).json({ status: 'error', message: 'Trop de tentatives. Réessayez plus tard.' });
    const suppliedUsername = Buffer.from(String(req.body && req.body.username || ''));
    const expectedUsername = Buffer.from(configuredUsername);
    const suppliedPassword = Buffer.from(String(req.body && req.body.password || ''));
    const expectedPassword = Buffer.from(configuredPassword);
    const usernameValid = suppliedUsername.length === expectedUsername.length && crypto.timingSafeEqual(suppliedUsername, expectedUsername);
    const passwordValid = suppliedPassword.length === expectedPassword.length && crypto.timingSafeEqual(suppliedPassword, expectedPassword);
    if (!usernameValid || !passwordValid) {
        failedLogins.set(ip, [...failures, now]);
        return res.status(401).json({ status: 'error', message: 'Identifiant ou mot de passe incorrect.' });
    }
    failedLogins.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.set(token, Date.now() + SESSION_MS);
    res.json({ status: 'success', token });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => {
    adminTokens.delete(req.headers.authorization.slice(7));
    res.json({ status: 'success' });
});
app.post('/api/admin/reset-json', requireAdmin, (req, res) => {
    if (!req.body || req.body.confirmation !== 'SUPPRIMER') return res.status(400).json({ status: 'error', message: 'Confirmation manquante.' });
    try {
        const dataDir = path.join(__dirname, 'data');
        let deleted = [];
        if (fs.existsSync(dataDir)) {
            deleted = ['ranking.json', 'championship.json'].filter(name => fs.existsSync(path.join(dataDir, name)) && fs.statSync(path.join(dataDir, name)).isFile());
            const backups = path.join(dataDir, 'backups');
            fs.mkdirSync(backups, { recursive: true });
            for (const name of deleted) fs.copyFileSync(path.join(dataDir, name), path.join(backups, name + '.' + Date.now() + '.' + crypto.randomBytes(4).toString('hex') + '.bak'));
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
