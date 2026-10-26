const express = require('express');
const path = require('path');
const app = express();

// Permet au serveur de rendre accessibles tous les fichiers du projet (CSS, images, etc.)
app.use(express.static(__dirname));

// Envoie le fichier index.html lorsque quelqu'un visite le site
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Écoute sur le port attribué dynamiquement par Render ou sur le port 3000 en local
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré avec succès sur le port ${PORT}`);
});
