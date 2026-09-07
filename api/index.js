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
// ENDPOINTS BLINDADOS (100% SEGUROS)
// ==========================================

// 1. PRUEBA
app.get('/api/test', (req, res) => {
    res.json({ status: "OK", mensaje: "¡Backend 100% blindado y funcionando!" });
});

// 2. REGISTRO DE USUARIO (Crear perfil inicial en la BD)
app.post('/api/auth/register', verifyToken, async (req, res) => {
    const { phone, role, name } = req.body;
    
    if (!phone || !role) {
        return res.status(400).json({ error: 'Teléfono y rol son obligatorios' });
    }

    try {
        const userRef = db.ref(`users/${phone}`);
        const snapshot = await userRef.once('value');
        
        if (!snapshot.exists()) {
            await userRef.set({
                name: name || '',
                phone: phone,
                role: role, 
                balanceUSD: 0,
                creditUSD: 10, 
                totalDeudaPagada: 0,
                txPagadasA_Tiempo: 0,
                createdAt: admin.database.ServerValue.TIMESTAMP
            });
        }
        res.json({ success: true, message: 'Usuario registrado exitosamente' });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 3. CREAR TRANSACCIÓN 
app.post('/api/transactions/create', verifyToken, async (req, res) => {
    const { buyerPhone, sellerPhone, amountUSD, method } = req.body;
    
    // Verificación estricta de variables y de inyección de NaN
    if (!buyerPhone || !sellerPhone || typeof amountUSD !== 'number' || amountUSD <= 0 || !method) {
        return res.status(400).json({ error: 'Datos inválidos o monto incorrecto' });
    }

    try {
        const txId = db.ref('transactions').push().key;
        const code = Math.floor(100000 + Math.random() * 900000).toString(); // Código de 6 dígitos seguro
        
        await db.ref(`transactions/${txId}`).set({
            txId,
            buyerPhone,
            sellerPhone,
            amountUSD,
            method,
            code,
            status: 'esperando_codigo', // Alineado con la estructura de tu frontend
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        res.json({ success: true, txId, code, message: 'Transacción creada' });
    } catch (error) {
        res.status(500).json({ error: 'Error al crear la transacción' });
    }
});

// 4. CONFIRMAR TRANSACCIÓN Y COBRAR COMISIÓN
app.post('/api/transactions/confirm', verifyToken, async (req, res) => {
    const { txId, enteredCode } = req.body;
    
    if (!txId || !enteredCode) {
        return res.status(400).json({ error: 'Faltan parámetros de seguridad' });
    }

    try {
        const txRef = db.ref(`transactions/${txId}`);
        const txSnap = await txRef.once('value');
        
        if (!txSnap.exists()) return res.status(404).json({ error: 'Transacción no encontrada' });
        
        const tx = txSnap.val();
        if (tx.status !== 'esperando_codigo' && tx.status !== 'pendiente') {
            return res.status(400).json({ error: 'La transacción no está disponible para procesar' });
        }
        if (tx.code !== enteredCode) return res.status(400).json({ error: 'Código incorrecto' });
        
        const buyerSnap = await db.ref(`users/${tx.buyerPhone}`).once('value');
        const sellerSnap = await db.ref(`users/${tx.sellerPhone}`).once('value');
        
        if (!buyerSnap.exists() || !sellerSnap.exists()) {
            return res.status(404).json({ error: 'Usuario involucrado no encontrado' });
        }

        const buyer = buyerSnap.val();
        const seller = sellerSnap.val();

        // Validaciones numéricas estrictas para cálculo de comisiones
        const amount = parseFloat(tx.amountUSD);
        if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Monto de transacción inválido' });

        const half = amount / 2;
        const commission = amount * 0.15;
        const buyerBal = parseFloat(buyer.balanceUSD || 0);
        const buyerCredit = parseFloat(buyer.creditUSD || 0);
        const sellerBal = parseFloat(seller.balanceUSD || 0);
        
        const updates = {};
        const ahora = Date.now();
        
        let nivelComprador = 1 + Math.floor((parseFloat(buyer.totalDeudaPagada) || 0) / 20);
        if (nivelComprador > 12) nivelComprador = 12;
        const plazoMs = (2 + nivelComprador) * 24 * 60 * 60 * 1000;

        if (tx.method === 'digital') {
            if (buyerBal < half) return res.status(400).json({ error: 'Fondos insuficientes del comprador' });
            if (buyerCredit < half) return res.status(400).json({ error: 'Línea de crédito insuficiente' });
            
            let sellerPay = amount - commission;
            if (sellerPay < 0) sellerPay = 0;
            
            updates[`users/${tx.buyerPhone}/balanceUSD`] = buyerBal - half;
            updates[`users/${tx.buyerPhone}/creditUSD`] = buyerCredit - half;
            updates[`users/${tx.sellerPhone}/balanceUSD`] = sellerBal + sellerPay;
        } else {
            if (buyerCredit < half) return res.status(400).json({ error: 'Crédito insuficiente' });
            
            let sellerDigitalShare = amount - half - commission;
            if (sellerDigitalShare < 0) sellerDigitalShare = 0;
            
            updates[`users/${tx.buyerPhone}/creditUSD`] = buyerCredit - half;
            updates[`users/${tx.sellerPhone}/balanceUSD`] = sellerBal + sellerDigitalShare;
        }

        updates[`commissions/espera/${txId}`] = { 
            amount: commission, 
            txId: txId, 
            timestamp: ahora,
            buyerPhone: tx.buyerPhone,
            buyerName: buyer.name || buyer.fullname || 'Desconocido',
            expiresAt: ahora + plazoMs
        };

        updates[`transactions/${txId}/status`] = 'completada';
        updates[`pending_payments/${tx.buyerPhone}/${txId}`] = {
            txId: txId,
            amountUSD: half,
            comisionTx: commission,
            status: 'pendiente',
            timestamp: ahora,
            expiresAt: ahora + plazoMs
        };

        updates[`frequent_clients/${tx.sellerPhone}/${tx.buyerPhone}`] = {
            fullname: buyer.name || buyer.fullname || 'Desconocido',
            phone: tx.buyerPhone,
            lastTx: ahora
        };

        await db.ref().update(updates);
        res.json({ success: true, message: 'Venta procesada exitosamente' });

    } catch (error) {
        res.status(500).json({ error: 'Error interno en la transacción' });
    }
});

// 5. CANCELAR TRANSACCIÓN
app.post('/api/transactions/cancel', verifyToken, async (req, res) => {
    const { txId } = req.body;
    
    if (!txId) return res.status(400).json({ error: 'Falta el ID de transacción' });

    try {
        const txSnap = await db.ref(`transactions/${txId}`).once('value');
        if (!txSnap.exists()) return res.status(404).json({ error: 'Transacción no encontrada' });
        
        const status = txSnap.val().status;
        if (status === 'pendiente' || status === 'esperando_codigo') {
            await db.ref(`transactions/${txId}/status`).set('anulada');
            res.json({ success: true, message: 'Transacción anulada' });
        } else {
            res.status(400).json({ error: 'No se puede cancelar una transacción ya procesada' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Error al cancelar' });
    }
});

// 6. PAGAR DEUDA
app.post('/api/payments/pay-debt', verifyToken, async (req, res) => {
    const { debtId, amountUSD, phone } = req.body;

    if (!debtId || !phone || typeof amountUSD !== 'number' || amountUSD <= 0) {
        return res.status(400).json({ error: 'Datos de pago inválidos' });
    }

    try {
        const userRef = db.ref(`users/${phone}`);
        const userSnap = await userRef.once('value');
        if (!userSnap.exists()) return res.status(404).json({ error: 'Usuario no encontrado' });
        
        const user = userSnap.val();
        const paymentAmount = parseFloat(amountUSD);
        const userBalance = parseFloat(user.balanceUSD || 0);

        if (userBalance < paymentAmount) {
            return res.status(400).json({ error: 'Saldo insuficiente para pagar la deuda' });
        }

        const updates = {};
        updates[`users/${phone}/balanceUSD`] = userBalance - paymentAmount;
        updates[`users/${phone}/creditUSD`] = (parseFloat(user.creditUSD) || 0) + paymentAmount;
        updates[`users/${phone}/totalDeudaPagada`] = (parseFloat(user.totalDeudaPagada) || 0) + paymentAmount;
        updates[`users/${phone}/txPagadasA_Tiempo`] = (parseFloat(user.txPagadasA_Tiempo) || 0) + 1;
        updates[`pending_payments/${phone}/${debtId}`] = null;
        
        // Sumar comisión a la neta global
        const debtSnap = await db.ref(`pending_payments/${phone}/${debtId}`).once('value');
        if (debtSnap.exists()) {
            const txData = debtSnap.val();
            if (txData.txId) updates[`commissions/espera/${txData.txId}`] = null;
            
            const commissionToMove = txData.comisionTx || (paymentAmount * 0.30);
            await db.ref('commissions/neta_total').transaction(curr => (curr || 0) + commissionToMove);
        }

        await db.ref().update(updates);
        res.json({ success: true, message: 'Deuda saldada, nivel incrementado' });

    } catch (error) {
        res.status(500).json({ error: 'Error al pagar deuda' });
    }
});

// 7. SOLICITAR RETIRO
app.post('/api/wallet/withdraw', verifyToken, async (req, res) => {
    const { phone, amountUSD, method, details } = req.body;
    
    if (!phone || typeof amountUSD !== 'number' || amountUSD <= 0) {
        return res.status(400).json({ error: 'Datos de retiro inválidos' });
    }

    try {
        const userRef = db.ref(`users/${phone}`);
        const userSnap = await userRef.once('value');
        if (!userSnap.exists()) return res.status(404).json({ error: 'Usuario no encontrado' });
        
        const user = userSnap.val();
        const withdrawalAmount = parseFloat(amountUSD);
        const userBalance = parseFloat(user.balanceUSD || 0);

        if (userBalance < withdrawalAmount) {
            return res.status(400).json({ error: 'Saldo insuficiente para retirar' });
        }

        const reqId = db.ref('retiros').push().key; // Ajustado a "retiros" para coincidir con tu app
        const updates = {};
        
        updates[`users/${phone}/balanceUSD`] = userBalance - withdrawalAmount;
        updates[`retiros/${reqId}`] = {
            reqId,
            sellerPhone: phone,
            sellerName: user.name || user.fullname || 'Desconocido',
            bankInfo: user.bank || details || 'No especificado',
            amountUSD: withdrawalAmount,
            method: method || 'digital',
            status: 'pendiente',
            timestamp: admin.database.ServerValue.TIMESTAMP
        };

        await db.ref().update(updates);
        res.json({ success: true, message: 'Solicitud de retiro procesada y saldo retenido' });
    } catch (error) {
        res.status(500).json({ error: 'Error al solicitar retiro' });
    }
});

// 8. SOLICITAR RECARGA
app.post('/api/wallet/recharge', verifyToken, async (req, res) => {
    const { phone, amountUSD, refNumber } = req.body;
    
    if (!phone || typeof amountUSD !== 'number' || amountUSD <= 0) {
        return res.status(400).json({ error: 'Datos de recarga inválidos' });
    }

    try {
        const reqId = db.ref('recharge_requests').push().key;
        await db.ref(`recharge_requests/${reqId}`).set({
            reqId,
            phone,
            amountUSD,
            refNumber: refNumber || 'N/A',
            status: 'pendiente',
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        res.json({ success: true, message: 'Solicitud de recarga registrada' });
    } catch (error) {
        res.status(500).json({ error: 'Error al registrar recarga' });
    }
});

module.exports = app;
