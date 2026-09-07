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
        return await confirmarTransaccionVendedor(req.body, res);

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
      // UVI 6: INICIAR COBRO DE VENTA
      // ==========================================================
      case 'iniciarCobroVenta':
        return await iniciarCobroVenta(req.body, res);

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
async function confirmarTransaccionVendedor(body, res) {
  const transactionId = body.transactionId || body.activeTxId || (body.payload && (body.payload.transactionId || body.payload.activeTxId));
  const inputCode = body.inputCode || body.enteredCode || (body.payload && (body.payload.inputCode || body.payload.enteredCode));
  const sellerPhone = body.sellerPhone || (body.payload && body.payload.sellerPhone);

  if (!transactionId || !inputCode) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos (transactionId, inputCode).' });
  }

  // 1. Consultar la transacción en la base de datos
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

  const codigoValido = tx.verificationCode || tx.code;
  if (String(codigoValido).trim() !== String(inputCode).trim()) {
    return res.status(400).json({ error: 'El código de confirmación es incorrecto.' });
  }

  if (sellerPhone && tx.sellerPhone !== sellerPhone) {
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

  const monto = parseFloat(tx.amountUSD) || 0;
  const updates = {};

  // 4. Lógica de Cobro al Comprador (Si el método es Digital)
  if (tx.method === 'digital') {
    const balanceDisponible = parseFloat(buyer.balanceUSD || 0);
    const creditoDisponible = parseFloat(buyer.creditUSD || 0);

    if (balanceDisponible + creditoDisponible < monto) {
      return res.status(400).json({ error: 'El comprador no posee suficiente saldo ni línea de crédito disponible.' });
    }

    if (balanceDisponible >= monto) {
      // Se descuenta totalmente del saldo digital
      updates[`users/${tx.buyerPhone}/balanceUSD`] = balanceDisponible - monto;
    } else {
      // Se consume todo el saldo digital y el resto de la línea de crédito
      const restanteDeuda = monto - balanceDisponible;
      updates[`users/${tx.buyerPhone}/balanceUSD`] = 0;
      updates[`users/${tx.buyerPhone}/creditUSD`] = creditoDisponible - restanteDeuda;

      // Generar registro en pagos pendientes (pending_payments)
      const nivel = Math.min(12, 1 + Math.floor((buyer.totalDeudaPagada || 0) / 20));
      const diasPlazo = 2 + nivel;
      const ahora = Date.now();
      const expiresAt = ahora + (diasPlazo * 24 * 60 * 60 * 1000);
      const comisionTx = restanteDeuda * 0.30;

      updates[`pending_payments/${tx.buyerPhone}/${transactionId}`] = {
        amountUSD: restanteDeuda,
        timestamp: admin.database.ServerValue.TIMESTAMP,
        expiresAt: expiresAt,
        status: 'pendiente',
        comisionTx: comisionTx,
        txId: transactionId
      };
    }
  }

  // 5. Acreditación de Saldo al Vendedor
  const nuevoSaldoVendedor = (parseFloat(seller.balanceUSD) || 0) + monto;
  updates[`users/${tx.sellerPhone}/balanceUSD`] = nuevoSaldoVendedor;

  // Registrar cliente frecuente
  updates[`users/${tx.sellerPhone}/frequentClients/${tx.buyerPhone}`] = true;
  updates[`frequent_clients/${tx.sellerPhone}/${tx.buyerPhone}`] = {
    fullname: buyer.fullname || `${buyer.firstname || ''} ${buyer.lastname || ''}`.trim(),
    phone: tx.buyerPhone
  };

  // 6. Finalizar la transacción
  updates[`transactions/${transactionId}/status`] = 'completada';
  updates[`transactions/${transactionId}/completedAt`] = admin.database.ServerValue.TIMESTAMP;

  // 7. Guardar cambios en la base de datos usando admin.database()
  await db.ref().update(updates);

  return res.status(200).json({
    success: true,
    message: '¡Venta procesada exitosamente y saldo acreditado!'
  });
}

// =========================================================================
// DESARROLLO DE LA FUNCIÓN 6: iniciarCobroVenta (CÓDIGO SERVIDOR)
// =========================================================================
async function iniciarCobroVenta(body, res) {
  const { sellerPhone, buyerPhone, montoUSD, metodo } = body;

  if (!sellerPhone || !buyerPhone || !montoUSD) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos (sellerPhone, buyerPhone, montoUSD).' });
  }

  // 1. Consultar si el comprador existe
  const buyerSnap = await db.ref(`users/${buyerPhone}`).once('value');
  if (!buyerSnap.exists()) {
    return res.status(404).json({ error: 'El comprador no existe en la base de datos.' });
  }
  
  // 2. Validar si la cuenta está congelada (pagos vencidos)
  const pendingSnap = await db.ref(`pending_payments/${buyerPhone}`).once('value');
  let cuentaCongelada = false;
  const ahora = Date.now();
  
  if (pendingSnap.exists()) {
    pendingSnap.forEach(deuda => {
      if (deuda.val().expiresAt && ahora > deuda.val().expiresAt) {
        cuentaCongelada = true;
      }
    });
  }

  if (cuentaCongelada) {
    return res.status(403).json({ cuentaCongelada: true, error: 'El usuario tiene pagos pendientes vencidos.' });
  }

  // 3. Generar código exacto de 6 dígitos usando matemáticas seguras
  const codigoSeguro = Math.floor(100000 + Math.random() * 900000).toString();

  // 4. Crear la transacción en la base de datos usando admin.database()
  const txRef = db.ref('transactions').push();
  const txId = txRef.key;

  const nuevaTransaccion = {
    amountUSD: parseFloat(montoUSD),
    buyerPhone: buyerPhone,
    sellerPhone: sellerPhone,
    method: metodo || 'digital',
    status: 'esperando_codigo',
    code: codigoSeguro, 
    verificationCode: codigoSeguro, // Emparejado para confirmarTransaccionVendedor
    timestamp: admin.database.ServerValue.TIMESTAMP
  };

  await txRef.set(nuevaTransaccion);

  // 5. Retornar el ID de transacción al frontend (QuickEdit)
  return res.status(200).json({
    success: true,
    txId: txId,
    message: 'Cobro iniciado correctamente.'
  });
}
