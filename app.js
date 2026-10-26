const express = require('express');
const path = require('path');
const app = express();

// Rendre le dossier racine et ses sous-dossiers accessibles (HTML, CSS, JS, data)
app.use(express.static(__dirname));

// Route principale pour charger la page d'accueil
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Écoute sur le port dynamique de Render ou 3000 en local
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur en ligne sur le port ${PORT}`);
});
