const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();

// Habilitar lectura de JSON y CORS
app.use(express.json());
app.use(cors());

// Inicializar Firebase Admin con la llave segura que pondremos en Vercel
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            // Reemplaza esta URL con la URL de tu Firebase Realtime Database si es distinta
            databaseURL: "https://motoweb-a6fdd-default-rtdb.firebaseio.com"
        });
    } catch (error) {
        console.error("Error inicializando Firebase Admin:", error.message);
    }
}

// Ruta de prueba para saber que la API está viva
app.get('/api/test', (req, res) => {
    res.json({ status: "OK", mensaje: "¡El backend en Vercel está funcionando!" });
});

// Exportar Express para que Vercel lo ejecute como Serverless
module.exports = app;
