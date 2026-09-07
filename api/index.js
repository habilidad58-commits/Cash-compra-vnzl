const admin = require('firebase-admin');

// Inicialización segura del Firebase Admin SDK
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = admin.database();

export default async function handler(req, res) {
  // Configuración de cabeceras CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Manejo de petición preliminar CORS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Utiliza POST.' });
  }

  const { action, payload } = req.body;

  try {
    switch (action) {
      // ==========================================================
      // UVI 1: CONFIRMAR TRANSACCIÓN VENDEDOR
      // ==========================================================
      case 'confirmarTransaccionVendedor':
        return await confirmarTransaccionVendedor(payload, res);

      // ==========================================================
      // UVI 2: PAGAR DEUDA PENDIENTE (Siguiente a migrar)
      // ==========================================================
      case 'payPendingDebt':
        return res.status(501).json({ error: 'Función payPendingDebt aún no migrada.' });

      // ==========================================================
      // UVI 3: SOLICITAR RETIRO (Siguiente a migrar)
      // ==========================================================
      case 'submitRetiroRequest':
        return res.status(501).json({ error: 'Función submitRetiroRequest aún no migrada.' });

      // ==========================================================
      // UVI 4: REGISTRO DE USUARIOS (Siguiente a migrar)
      // ==========================================================
      case 'handleRegistrationSubmit':
        return res.status(501).json({ error: 'Función handleRegistrationSubmit aún no migrada.' });

      // ==========================================================
      // UVI 5: VERIFICAR CÓDIGO WHATSAPP (Siguiente a migrar)
      // ==========================================================
      case 'verifyWhatsAppCode':
        return res.status(501).json({ error: 'Función verifyWhatsAppCode aún no migrada.' });

      // ==========================================================
      // UVI 6: INICIAR COBRO DE VENTA (Siguiente a migrar)
      // ==========================================================
      case 'iniciarCobroVenta':
        return res.status(501).json({ error: 'Función iniciarCobroVenta aún no migrada.' });

      default:
        return res.status(400).json({ error: 'Acción no reconocida o no especificada.' });
    }
  } catch (error) {
    console.error("Error en Vercel Function:", error);
    return res.status(500).json({ error: error.message || 'Error interno del servidor.' });
  }
}

// =========================================================================
// DESARROLLO DE LA FUNCIÓN 1: confirmarTransaccionVendedor (CÓDIGO SERVIDOR)
// =========================================================================
async function confirmarTransaccionVendedor(payload, res) {
  const { transactionId, inputCode, sellerPhone } = payload;

  if (!transactionId || !inputCode || !sellerPhone) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos (transactionId, inputCode, sellerPhone).' });
  }

  // 1. Consultar la transacción en la base de datos de manera segura
  const txRef = db.ref(`transactions/${transactionId}`);
  const txSnapshot = await txRef.once('value');

  if (!txSnapshot.exists()) {
    return res.status(404).json({ error: 'La transacción no existe.' });
  }

  const tx = txSnapshot.val();

  // 2. Validaciones de Seguridad
  if (tx.status !== 'esperando_codigo') {
    return res.status(400).json({ error: 'La transacción ya no está pendiente o ya fue procesada.' });
  }

  if (String(tx.verificationCode) !== String(inputCode).trim()) {
    return res.status(400).json({ error: 'El código de confirmación es incorrecto.' });
  }

  if (tx.sellerPhone !== sellerPhone) {
    return res.status(403).json({ error: 'No tienes permisos para autorizar esta transacción.' });
  }

  // 3. Obtener los datos del comprador y del vendedor
  const [buyerSnap, sellerSnap] = await Promise.all([
    db.ref(`users/${tx.buyerPhone}`).once('value'),
    db.ref(`users/${tx.sellerPhone}`).once('value')
  ]);

  if (!buyerSnap.exists() || !sellerSnap.exists()) {
    return res.status(404).json({ error: 'Comprador o vendedor no encontrados.' });
  }

  const buyer = buyerSnap.val();
  const seller = sellerSnap.val();

  // 4. Cálculos Financieros Backend
  const monto = parseFloat(tx.amountUSD) || 0;
  const nuevoSaldoVendedor = (parseFloat(seller.balanceUSD) || 0) + monto;

  // Objeto con todas las actualizaciones atómicas
  const updates = {};

  // Actualizar saldo del vendedor
  updates[`users/${sellerPhone}/balanceUSD`] = nuevoSaldoVendedor;

  // Marcar la transacción como completada
  updates[`transactions/${transactionId}/status`] = 'completada';
  updates[`transactions/${transactionId}/completedAt`] = new Date().toISOString();

  // Si aplica cliente frecuente
  if (tx.buyerPhone) {
    updates[`users/${sellerPhone}/frequentClients/${tx.buyerPhone}`] = true;
  }

  // 5. Ejecutar la actualización en Firebase Admin
  await db.ref().update(updates);

  return res.status(200).json({
    success: true,
    message: 'Transacción confirmada y saldo liberado exitosamente.'
  });
}
