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
      // UVI 3: SOLICITAR RETIRO (MIGRADÓ A SERVIDOR)
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

      // ==========================================================
      // UVI 7: CANCELAR PROCESO DE REGISTRO
      // ==========================================================
      case 'cancelRegistrationProcess':
        return await cancelRegistrationProcess(req.body, res);

      // ==========================================================
      // UVI 8: ANULAR TRANSACCIÓN
      // ==========================================================
      case 'anularTransaccion':
        return await anularTransaccion(req.body, res);

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
  const payloadData = body.payload || body;
  const transactionId = payloadData.transactionId || payloadData.activeTxId;
  const inputCode = payloadData.inputCode || payloadData.enteredCode;
  const sellerPhone = payloadData.sellerPhone;

  if (!transactionId || !inputCode) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos.' });
  }

  try {
    const txRef = db.ref(`transactions/${transactionId}`);
    const txSnapshot = await txRef.once('value');

    if (!txSnapshot.exists()) {
      return res.status(404).json({ error: 'La transacción no existe.' });
    }

    const tx = txSnapshot.val();

    if (tx.status !== 'esperando_codigo') {
      return res.status(400).json({ error: 'La transacción ya no está pendiente.' });
    }

    // Validación estricta del código idéntica al front
    if (String(tx.code).trim() !== String(inputCode).trim()) {
      return res.status(400).json({ error: 'El código de confirmación ingresado no coincide.' });
    }

    // Permisos del vendedor para procesar la venta
    if (sellerPhone && tx.sellerPhone !== sellerPhone) {
      return res.status(403).json({ error: 'No tienes permisos para esta transacción.' });
    }

    const [buyerSnap, sellerSnap] = await Promise.all([
      db.ref(`users/${tx.buyerPhone}`).once('value'),
      db.ref(`users/${tx.sellerPhone}`).once('value')
    ]);

    if (!buyerSnap.exists() || !sellerSnap.exists()) {
      return res.status(404).json({ error: 'Comprador o vendedor no encontrados.' });
    }

    const buyer = buyerSnap.val();
    const seller = sellerSnap.val();

    const amount = parseFloat(tx.amountUSD);
    let half = amount / 2;
    let commission = amount * 0.15; // 15% de comisión de la venta total
    let buyerBal = parseFloat(buyer.balanceUSD || 0);
    let buyerCredit = parseFloat(buyer.creditUSD || 0);
    let sellerBal = parseFloat(seller.balanceUSD || 0);

    const updates = {};
    const ahora = Date.now();

    // Cálculo Dinámico de Días de Plazo según el Nivel idéntico al frontend
    let nivelComprador = 1 + Math.floor((buyer.totalDeudaPagada || 0) / 20);
    if (nivelComprador > 12) nivelComprador = 12;
    const diasPlazo = 2 + nivelComprador; 
    const plazoMs = diasPlazo * 24 * 60 * 60 * 1000;

    if (tx.method === 'digital') {
      if (buyerBal < half) {
        return res.status(400).json({ error: `El comprador no tiene suficiente saldo digital ($${half.toFixed(2)} USD).` });
      }
      if (buyerCredit < half) {
        return res.status(400).json({ error: `El comprador no tiene suficiente línea de crédito ($${half.toFixed(2)} USD).` });
      }
      let sellerPay = amount - commission;
      if (sellerPay < 0) sellerPay = 0;
      
      updates[`users/${tx.buyerPhone}/balanceUSD`] = buyerBal - half;
      updates[`users/${tx.buyerPhone}/creditUSD`] = buyerCredit - half;
      updates[`users/${tx.sellerPhone}/balanceUSD`] = sellerBal + sellerPay;
    } else {
      if (buyerCredit < half) {
        return res.status(400).json({ error: 'El comprador no tiene suficiente crédito disponible.' });
      }
      let sellerDigitalShare = amount - half - commission;
      if (sellerDigitalShare < 0) sellerDigitalShare = 0;
      
      updates[`users/${tx.buyerPhone}/creditUSD`] = buyerCredit - half;
      updates[`users/${tx.sellerPhone}/balanceUSD`] = sellerBal + sellerDigitalShare;
    }

    updates[`commissions/espera/${transactionId}`] = { 
      amount: commission, 
      txId: transactionId, 
      timestamp: ahora,
      buyerPhone: tx.buyerPhone,
      buyerName: buyer.fullname,
      expiresAt: ahora + plazoMs
    };
    updates[`pending_payments/${tx.buyerPhone}/${transactionId}`] = {
      txId: transactionId,
      amountUSD: half,
      comisionTx: commission, 
      status: 'pendiente',
      timestamp: ahora,
      expiresAt: ahora + plazoMs
    };
    updates[`transactions/${transactionId}/status`] = 'completada';
    updates[`frequent_clients/${tx.sellerPhone}/${tx.buyerPhone}`] = {
      fullname: buyer.fullname,
      phone: buyer.phone,
      lastTx: ahora
    };

    // Usando admin.database() a través de 'db' para guardar los datos de forma segura
    await db.ref().update(updates);

    return res.status(200).json({ success: true, message: '¡Venta procesada exitosamente!' });
  } catch (error) {
    console.error("Error confirmando transacción UVI 1:", error);
    return res.status(500).json({ error: 'Error interno del servidor procesando la venta.' });
  }
}

// =========================================================================
// DESARROLLO DE LA FUNCIÓN 2: payPendingDebt (CÓDIGO SERVIDOR)
// =========================================================================
async function payPendingDebt(body, res) {
  const payloadData = body.payload || body;
  const { phone, key, amountUSD } = payloadData;

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
  const payloadData = body.payload || body;
  const { phone, amountUSD, cedula } = payloadData;

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
        cedula: cedula || userData.cedula || 'N/A',
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
  const payloadData = body.payload || body;
  const { uid, role, firstname, lastname, cedula, dob, location, phone, bank, idImage, faceImage, email, password } = payloadData;

  if (!firstname || !lastname || !cedula || !dob || !location || !phone || !password || !email || !idImage || !faceImage) {
    return res.status(400).json({ error: 'Por favor complete todos los campos obligatorios.' });
  }
  // Verificación de edad >= 18 en el servidor (Idéntica a la lógica del frontend)
  const birthDate = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
  
  if (age < 18) {
    return res.status(400).json({ error: 'Debes ser mayor de edad para registrarte.' });
  }

  try {
    const cleanPhone = phone.replace(/\s+/g, '');
    
    // Verificar si el usuario ya existe
    const userRef = db.ref(`users/${cleanPhone}`);
    const snapshot = await userRef.once('value');
    if (snapshot.exists()) {
      return res.status(400).json({ error: 'El número de teléfono ya se encuentra registrado.' });
    }

    const userData = {
      uid: uid || 'por_asignar',
      role: role || 'comprador',
      firstname: firstname,
      lastname: lastname,
      fullname: `${firstname} ${lastname}`,
      cedula: cedula,
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

    // Guardar en la base de datos usando el Admin SDK
    await userRef.set(userData);

    return res.status(200).json({
      success: true,
      message: 'Solicitud enviada exitosamente. Espera el mensaje de verificación en WhatsApp.'
    });
  } catch (error) {
    console.error("Error en UVI 4 handleRegistrationSubmit:", error);
    return res.status(500).json({ error: 'Error interno del servidor al procesar el registro.' });
  }
}


// =========================================================================
// DESARROLLO DE LA FUNCIÓN 5: verifyWhatsAppCode (CÓDIGO SERVIDOR)
// =========================================================================
async function verifyWhatsAppCode(body, res) {
  const payloadData = body.payload || body;
  const { phone, inputCode } = payloadData;

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

    if (user && String(user.verificationCode).trim() === String(inputCode).trim() && inputCode !== '') {
      let uid = user.uid;

      try {
        // AHORA creamos la cuenta en Auth (o la usamos si ya existe porque entraron con Google)
        const userRecord = await admin.auth().createUser({
          email: user.email,
          password: user.password
        });
        uid = userRecord.uid;

        // Actualizamos estado y UID
        await userRef.update({
          status: 'aprobado',
          uid: uid,
          verificationCode: ''
        });

        return res.status(200).json({
          success: true,
          message: '¡Tu cuenta ha sido aprobada con éxito! Ya puedes ingresar con tu número y contraseña.'
        });

      } catch (authError) {
        if (authError.code === 'auth/email-already-exists' || authError.code === 'auth/email-already-in-use') {
          // La cuenta ya existe vía Google, solo actualizamos la aprobación
          await userRef.update({
            status: 'aprobado',
            verificationCode: ''
          });

          return res.status(200).json({
            success: true,
            message: '¡Tu cuenta ha sido aprobada con éxito! Usa tu número y contraseña para ingresar.'
          });
        } else {
          return res.status(400).json({ error: "Error al crear cuenta Auth: " + authError.message });
        }
      }
    } else {
      return res.status(400).json({ error: 'El código de verificación ingresado es incorrecto.' });
    }

  } catch (error) {
    console.error('Error al verificar código WhatsApp:', error);
    return res.status(500).json({ error: 'Error interno del servidor al verificar el código.' });
  }
}


// =========================================================================
// DESARROLLO DE LA FUNCIÓN 6: iniciarCobroVenta (CÓDIGO SERVIDOR)
// =========================================================================
async function iniciarCobroVenta(body, res) {
  const payloadData = body.payload || body;
  const { sellerPhone, buyerPhone, montoUSD, metodo } = payloadData;

  if (!sellerPhone || !buyerPhone || !montoUSD) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos.' });
  }

  if (montoUSD < 0.10 || montoUSD > 20) {
    return res.status(400).json({ error: 'Monto inválido (Mínimo $0.10 y Máximo $20).' });
  }

  try {
    // 1. Consultar si el comprador existe y validar el rol (Igual al frontend)
    const buyerSnap = await db.ref(`users/${buyerPhone}`).once('value');
    if (!buyerSnap.exists() || buyerSnap.val().role !== 'comprador') {
      return res.status(404).json({ error: 'El teléfono ingresado no corresponde a un comprador registrado.' });
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
   
    // 3. Generar código exacto de 6 dígitos
    const codigoSeguro = Math.floor(100000 + Math.random() * 900000).toString();

    // 4. Crear la transacción en la base de datos usando admin.database()
    const txRef = db.ref('transactions').push();
    const txId = txRef.key;

    const nuevaTransaccion = {
      sellerPhone: sellerPhone,
      buyerPhone: buyerPhone,
      amountUSD: parseFloat(montoUSD),
      method: metodo || 'digital',
      code: codigoSeguro,
      status: 'esperando_codigo',
      timestamp: admin.database.ServerValue.TIMESTAMP
    };

    await txRef.set(nuevaTransaccion);

    // 5. Retornar el ID de transacción al frontend
    return res.status(200).json({
      success: true,
      txId: txId,
      message: 'Cobro iniciado correctamente.'
    });
  } catch (error) {
    console.error('Error en iniciarCobroVenta UVI 6:', error);
    return res.status(500).json({ error: 'Error interno del servidor al iniciar el cobro.' });
  }
}

// =========================================================================
// DESARROLLO DE LA FUNCIÓN 7: cancelRegistrationProcess (CÓDIGO SERVIDOR)
// =========================================================================
async function cancelRegistrationProcess(body, res) {
  const payloadData = body.payload || body;
  const { phone } = payloadData;

  if (!phone) {
    return res.status(400).json({ error: 'Falta el número de teléfono para cancelar el registro.' });
  }

  try {
    // Usando admin.database() para eliminar el registro de forma segura desde el backend
    const userRef = db.ref(`users/${phone}`);
    const userSnap = await userRef.once('value');

    if (userSnap.exists()) {
      await userRef.remove();
    }

    return res.status(200).json({
      success: true,
      message: 'Proceso de registro cancelado exitosamente.'
    });
  } catch (error) {
    console.error("Error en UVI 7 cancelRegistrationProcess:", error);
    return res.status(500).json({ error: 'Error interno del servidor al cancelar el registro.' });
  }
}

// =========================================================================
// DESARROLLO DE LA FUNCIÓN 8: anularTransaccion (CÓDIGO SERVIDOR)
// =========================================================================
async function anularTransaccion(body, res) {
  const payloadData = body.payload || body;
  const { transactionId } = payloadData;

  if (!transactionId) {
    return res.status(400).json({ error: 'Falta el ID de la transacción para anular.' });
  }

  try {
    const txRef = db.ref(`transactions/${transactionId}`);
    const txSnapshot = await txRef.once('value');

    if (!txSnapshot.exists()) {
      return res.status(404).json({ error: 'La transacción no existe.' });
    }

    // Usando admin.database() para anular desde el servidor
    await txRef.update({ status: 'anulada' });

    return res.status(200).json({
      success: true,
      message: 'Transacción anulada exitosamente.'
    });
  } catch (error) {
    console.error("Error en UVI 8 anularTransaccion:", error);
    return res.status(500).json({ error: 'Error interno del servidor al anular la transacción.' });
  }
}
