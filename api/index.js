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
        return await payPendingDebt(req.body, res);
    
// ==========================================================
      // UVI 3: SOLICITAR RETIRO (Siguiente a migrar)
      // ==========================================================
      case 'submitRetiroRequest':
        return await submitRetiroRequest(req.body, res);

  // ==========================================================
      // UVI 4: REGISTRO DE USUARIOS (Siguiente a migrar)
      // ==========================================================
      case 'handleRegistrationSubmit':
        return await handleRegistrationSubmit(req.body, res);
  
      // ==========================================================
      // UVI 5: VERIFICAR CÓDIGO WHATSAPP
      // ==========================================================
      case 'verifyWhatsAppCode':
        return await verifyWhatsAppCode(req.body, res);

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
// DESARROLLO DE LA FUNCIÓN 2: payPendingDebt (CÓDIGO SERVIDOR)
// =========================================================================
async function payPendingDebt(body, res) {
  const { phone, key, amountUSD } = body;

  if (!phone || !key || !amountUSD) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos (phone, key, amountUSD).' });
  }

  try {
    const userRef = db.ref(`users/${phone}`);
    const pendingRef = db.ref(`pending_payments/${phone}/${key}`);

    const [userSnap, pendingSnap] = await Promise.all([
      userRef.once('value'),
      pendingRef.once('value')
    ]);

    if (!userSnap.exists()) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    if (!pendingSnap.exists()) {
      return res.status(404).json({ error: 'La deuda pendiente no existe o ya fue pagada.' });
    }

    const userData = userSnap.val();
    const pendingData = pendingSnap.val();
    
    // Verificación segura de saldos directamente en servidor
    const deudaMonto = parseFloat(pendingData.amountUSD || 0);
    const userBalance = parseFloat(userData.balanceUSD || 0);
    const userCredit = parseFloat(userData.creditUSD || 0);

    if (userBalance < deudaMonto) {
      return res.status(400).json({ error: 'Saldo insuficiente para cancelar la deuda.' });
    }

    const txId = pendingData.txId;
    const commissionToMove = pendingData.comisionTx || (deudaMonto * 0.30);
    const updates = {};

    // 1. Actualizaciones de saldo y crédito
    updates[`users/${phone}/balanceUSD`] = userBalance - deudaMonto;
    updates[`users/${phone}/creditUSD`] = userCredit + deudaMonto;

    // 2. Sistema de Reputación: Sumar al pagar
    const totalPagado = (userData.totalDeudaPagada || 0) + deudaMonto;
    const txVerdes = (userData.txPagadasA_Tiempo || 0) + 1;
    updates[`users/${phone}/totalDeudaPagada`] = totalPagado;
    updates[`users/${phone}/txPagadasA_Tiempo`] = txVerdes;

    // 3. Eliminar la deuda de pending_payments
    updates[`pending_payments/${phone}/${key}`] = null;
    
    // 4. Eliminar la comisión en espera si existe un txId
    if (txId) {
      updates[`commissions/espera/${txId}`] = null;
    }

    // 5. Sumar comisión neta usando incremento atómico del Admin SDK
    updates[`commissions/neta_total`] = admin.database.ServerValue.increment(commissionToMove);

    // Guardar todos los cambios simultáneamente
    await db.ref().update(updates);

    return res.status(200).json({
      success: true,
      message: '¡Deuda saldada exitosamente! Tu línea de crédito ha sido restablecida.'
    });
  } catch (error) {
    console.error('Error al pagar la deuda:', error);
    return res.status(500).json({ error: 'Error interno del servidor al procesar el pago.' });
  }
}

// =========================================================================
// DESARROLLO DE LA FUNCIÓN 3: submitRetiroRequest (CÓDIGO SERVIDOR)
// =========================================================================
async function submitRetiroRequest(body, res) {
  const { phone, amountUSD } = body;

  if (!phone || !amountUSD || amountUSD <= 0) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos o monto inválido.' });
  }

  try {
    const userRef = db.ref(`users/${phone}`);
    const userSnap = await userRef.once('value');

    if (!userSnap.exists()) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const userData = userSnap.val();
    const userBalance = parseFloat(userData.balanceUSD || 0);

    if (userBalance < amountUSD) {
      return res.status(400).json({ error: `No puedes retirar esta cantidad. Tu saldo disponible es $${userBalance.toFixed(2)} USD.` });
    }

    const nuevoSaldo = userBalance - amountUSD;
    const retiroRef = db.ref('retiros').push();
    
    const updates = {};
    updates[`retiros/${retiroRef.key}`] = {
        sellerPhone: phone,
        sellerName: userData.fullname || '',
        bankInfo: userData.bank || 'No especificado',
        amountUSD: amountUSD,
        status: 'pendiente',
        timestamp: admin.database.ServerValue.TIMESTAMP
    };
    updates[`users/${phone}/balanceUSD`] = nuevoSaldo;

    await db.ref().update(updates);

    return res.status(200).json({
      success: true,
      message: `Solicitud de retiro de $${amountUSD.toFixed(2)} USD enviada. El saldo ha sido retenido temporalmente de tu cuenta.`
    });
  } catch (error) {
    console.error('Error al procesar el retiro:', error);
    return res.status(500).json({ error: 'Error interno del servidor al solicitar el retiro.' });
  }
}

// =========================================================================
// DESARROLLO DE LA FUNCIÓN 4: handleRegistrationSubmit (CÓDIGO SERVIDOR)
// =========================================================================
async function handleRegistrationSubmit(body, res) {
  const payload = body.payload || body;
  const { uid, role, firstname, lastname, dob, location, phone, bank, idImage, faceImage, email, password } = payload;

  if (!firstname || !lastname || !dob || !location || !phone || !password || !email || !idImage || !faceImage) {
    return res.status(400).json({ error: 'Faltan campos obligatorios para el registro.' });
  }

  try {
    const cleanPhone = phone.replace(/\s+/g, '');
    
    // Verificar si el usuario ya existe
    const userRef = db.ref(`users/${cleanPhone}`);
    const snapshot = await userRef.once('value');
    if (snapshot.exists()) {
      return res.status(400).json({ error: 'El número de teléfono ya está registrado.' });
    }

    const userData = {
      uid: uid || 'por_asignar',
      role: role || 'comprador',
      firstname: firstname,
      lastname: lastname,
      fullname: `${firstname} ${lastname}`,
      dob: dob,
      location: location,
      phone: cleanPhone,
      bank: role === 'vendedor' ? bank : '',
      idImage: idImage,
      faceImage: faceImage,
      email: email,
      password: password,
      status: 'pendiente',
      balanceUSD: 0,
      creditUSD: 0,
      verificationCode: '',
      timestamp: admin.database.ServerValue.TIMESTAMP
    };

    // Guardar en la base de datos usando admin SDK
    await userRef.set(userData);

    return res.status(200).json({
      success: true,
      message: 'Solicitud de registro creada exitosamente.'
    });
  } catch (error) {
    console.error("Error en handleRegistrationSubmit:", error);
    return res.status(500).json({ error: 'Error interno al procesar el registro.' });
  }
}

// =========================================================================
// DESARROLLO DE LA FUNCIÓN 5: verifyWhatsAppCode (CÓDIGO SERVIDOR)
// =========================================================================
async function verifyWhatsAppCode(body, res) {
  const { phone, inputCode } = body;

  if (!phone || !inputCode) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos (phone, inputCode).' });
  }

  try {
    const userRef = db.ref(`users/${phone}`);
    const userSnap = await userRef.once('value');

    if (!userSnap.exists()) {
      return res.status(404).json({ error: 'El usuario no existe.' });
    }

    const user = userSnap.val();

    if (String(user.verificationCode).trim() !== String(inputCode).trim() || inputCode === '') {
      return res.status(400).json({ error: 'El código de verificación ingresado es incorrecto.' });
    }

    let uid = user.uid;

    // Manejo de Firebase Auth desde el servidor (Admin SDK)
    try {
      const userRecord = await admin.auth().createUser({
        email: user.email,
        password: user.password
      });
      uid = userRecord.uid;
    } catch (authError) {
      if (authError.code === 'auth/email-already-exists') {
        // Si el usuario ya existe (ej. por Google Sign-In), obtenemos su UID
        const existingUser = await admin.auth().getUserByEmail(user.email);
        uid = existingUser.uid;
      } else {
        throw authError;
      }
    }

    // Actualizar el estado en la base de datos
    await userRef.update({
      status: 'aprobado',
      uid: uid,
      verificationCode: ''
    });

    return res.status(200).json({
      success: true,
      message: 'Cuenta aprobada con éxito.'
    });

  } catch (error) {
    console.error('Error al verificar código WhatsApp:', error);
    return res.status(500).json({ error: 'Error interno del servidor al verificar el código.' });
  }
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
