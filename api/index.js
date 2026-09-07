const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();

// Habilitar lectura de JSON y CORS
app.use(express.json());
app.use(cors());

// Inicializar Firebase Admin
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://motoweb-a6fdd-default-rtdb.firebaseio.com"
        });
    } catch (error) {
        console.error("Error inicializando Firebase Admin:", error.message);
    }
}

const db = admin.database();

// ==========================================
// MIDDLEWARE DE SEGURIDAD
// ==========================================
const verifyToken = async (req, res, next) => {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    try {
        req.user = await admin.auth().verifyIdToken(token);
        next();
    } catch (e) {
        res.status(401).json({ error: 'Token inválido' });
    }
};

// ==========================================
// ENDPOINTS
// ==========================================

// 1. PRUEBA
app.get('/api/test', (req, res) => {
    res.json({ status: "OK", mensaje: "¡Backend funcionando!" });
});

// 2. REGISTRO DE USUARIO (Crear perfil inicial en la BD)
app.post('/api/auth/register', verifyToken, async (req, res) => {
    const { phone, role, name } = req.body;
    try {
        const userRef = db.ref(`users/${phone}`);
        const snapshot = await userRef.once('value');
        
        if (!snapshot.exists()) {
            await userRef.set({
                name: name || '',
                phone: phone,
                role: role, // 'pasajero' o 'conductor'
                balanceUSD: 0,
                creditUSD: 10, // Crédito inicial
                totalDeudaPagada: 0,
                txPagadasA_Tiempo: 0,
                createdAt: admin.database.ServerValue.TIMESTAMP
            });
        }
        res.json({ success: true, message: 'Usuario registrado exitosamente' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. CREAR TRANSACCIÓN (Cuando se escanea el QR o inicia viaje)
app.post('/api/transactions/create', verifyToken, async (req, res) => {
    const { buyerPhone, sellerPhone, amountUSD, method } = req.body;
    try {
        const txId = db.ref('transactions').push().key;
        const code = Math.floor(1000 + Math.random() * 9000).toString(); // Código de 4 dígitos
        
        await db.ref(`transactions/${txId}`).set({
            txId,
            buyerPhone,
            sellerPhone,
            amountUSD,
            method,
            code,
            status: 'pendiente',
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        res.json({ success: true, txId, code, message: 'Transacción creada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. CONFIRMAR TRANSACCIÓN Y COBRAR COMISIÓN (La función más crítica)
app.post('/api/transactions/confirm', verifyToken, async (req, res) => {
    const { txId, enteredCode } = req.body;
    try {
        const txRef = db.ref(`transactions/${txId}`);
        const txSnap = await txRef.once('value');
        if (!txSnap.exists()) return res.status(404).json({ error: 'Transacción no encontrada' });
        
        const tx = txSnap.val();
        if (tx.status !== 'pendiente') return res.status(400).json({ error: 'Transacción ya procesada' });
        if (tx.code !== enteredCode) return res.status(400).json({ error: 'Código incorrecto' });
        
        const buyerSnap = await db.ref(`users/${tx.buyerPhone}`).once('value');
        const sellerSnap = await db.ref(`users/${tx.sellerPhone}`).once('value');
        const buyer = buyerSnap.val();
        const seller = sellerSnap.val();

        const amount = tx.amountUSD;
        const half = amount / 2;
        const commission = amount * 0.15;
        const updates = {};
        const ahora = Date.now();
        
        // Calcular plazo en base al nivel (totalDeudaPagada)
        let nivelComprador = 1 + Math.floor((buyer.totalDeudaPagada || 0) / 20);
        if (nivelComprador > 12) nivelComprador = 12;
        const plazoMs = (2 + nivelComprador) * 24 * 60 * 60 * 1000;

        // Lógica de saldos según método
        if (tx.method === 'digital') {
            if (buyer.balanceUSD < half || buyer.creditUSD < half) {
                return res.status(400).json({ error: 'Fondos insuficientes' });
            }
            updates[`users/${tx.buyerPhone}/balanceUSD`] = buyer.balanceUSD - half;
            updates[`users/${tx.buyerPhone}/creditUSD`] = buyer.creditUSD - half;
            updates[`users/${tx.sellerPhone}/balanceUSD`] = seller.balanceUSD + Math.max(0, amount - commission);
        } else {
            if (buyer.creditUSD < half) {
                return res.status(400).json({ error: 'Crédito insuficiente' });
            }
            updates[`users/${tx.buyerPhone}/creditUSD`] = buyer.creditUSD - half;
            updates[`users/${tx.sellerPhone}/balanceUSD`] = seller.balanceUSD + Math.max(0, amount - half - commission);
        }

        // Actualizar estados
        updates[`transactions/${txId}/status`] = 'completada';
        updates[`pending_payments/${tx.buyerPhone}/${txId}`] = {
            txId: txId,
            amountUSD: half,
            comisionTx: commission,
            status: 'pendiente',
            timestamp: ahora,
            expiresAt: ahora + plazoMs
        };

        await db.ref().update(updates);
        res.json({ success: true, message: 'Venta procesada exitosamente' });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. CANCELAR TRANSACCIÓN
app.post('/api/transactions/cancel', verifyToken, async (req, res) => {
    const { txId } = req.body;
    try {
        const txSnap = await db.ref(`transactions/${txId}`).once('value');
        if (!txSnap.exists()) return res.status(404).json({ error: 'No encontrada' });
        
        if (txSnap.val().status === 'pendiente') {
            await db.ref(`transactions/${txId}/status`).set('cancelada');
            res.json({ success: true, message: 'Transacción cancelada' });
        } else {
            res.status(400).json({ error: 'No se puede cancelar una transacción completada' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. PAGAR DEUDA
app.post('/api/payments/pay-debt', verifyToken, async (req, res) => {
    const { debtId, amountUSD, phone } = req.body;
    try {
        const userRef = db.ref(`users/${phone}`);
        const userSnap = await userRef.once('value');
        const user = userSnap.val();

        if (user.balanceUSD < amountUSD) {
            return res.status(400).json({ error: 'Saldo en cuenta insuficiente' });
        }

        const updates = {};
        updates[`users/${phone}/balanceUSD`] = user.balanceUSD - amountUSD;
        updates[`users/${phone}/creditUSD`] = user.creditUSD + amountUSD;
        updates[`users/${phone}/totalDeudaPagada`] = (user.totalDeudaPagada || 0) + amountUSD;
        updates[`users/${phone}/txPagadasA_Tiempo`] = (user.txPagadasA_Tiempo || 0) + 1;
        updates[`pending_payments/${phone}/${debtId}`] = null;

        await db.ref().update(updates);
        res.json({ success: true, message: 'Deuda saldada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. SOLICITAR RETIRO (Para conductores)
app.post('/api/wallet/withdraw', verifyToken, async (req, res) => {
    const { phone, amountUSD, method, details } = req.body;
    try {
        const userRef = db.ref(`users/${phone}`);
        const userSnap = await userRef.once('value');
        const user = userSnap.val();

        if (user.balanceUSD < amountUSD) {
            return res.status(400).json({ error: 'Saldo insuficiente para retirar' });
        }

        const reqId = db.ref('withdraw_requests').push().key;
        const updates = {};
        
        // Descontar saldo inmediatamente
        updates[`users/${phone}/balanceUSD`] = user.balanceUSD - amountUSD;
        updates[`withdraw_requests/${reqId}`] = {
            reqId,
            phone,
            amountUSD,
            method, // Ej: Pago móvil
            details,
            status: 'pendiente',
            timestamp: admin.database.ServerValue.TIMESTAMP
        };

        await db.ref().update(updates);
        res.json({ success: true, message: 'Solicitud de retiro enviada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 8. SOLICITAR RECARGA (Para enviar notificación al admin antes del WhatsApp)
app.post('/api/wallet/recharge', verifyToken, async (req, res) => {
    const { phone, amountUSD, refNumber } = req.body;
    try {
        const reqId = db.ref('recharge_requests').push().key;
        await db.ref(`recharge_requests/${reqId}`).set({
            reqId,
            phone,
            amountUSD,
            refNumber,
            status: 'pendiente',
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        res.json({ success: true, message: 'Solicitud de recarga registrada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = app;
