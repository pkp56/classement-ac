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
app.post('/api/save-championship', (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
