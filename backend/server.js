require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const dns = require('dns');

dns.setServers(['8.8.8.8', '8.8.4.4']);

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..')));

// ── Routes ──
const authRouter = require('./routes/auth');
const escaneadorasRouter = require('./routes/escaneadoras');
const dashboardRouter = require('./routes/dashboard');
const resumenRouter = require('./routes/resumen');

app.use('/api/auth', authRouter);
app.use('/api/escaneadoras', escaneadorasRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/resumen', resumenRouter);

// ── Health check (public) ──
app.get('/api/health', async (req, res) => {
  try {
    const EscaneadoraRegistro = require('./models/EscaneadoraRegistro');
    const User = require('./models/User');
    const registros = await EscaneadoraRegistro.countDocuments();
    const usuarios = await User.countDocuments();
    res.json({
      success: true,
      status: 'OK',
      database: 'MongoDB Atlas',
      registros,
      usuarios,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, status: 'ERROR', error: error.message });
  }
});

// ── Connect and start ──
const PORT = process.env.PORT || 3009;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI no definida en .env');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(async () => {
    const EscaneadoraRegistro = require('./models/EscaneadoraRegistro');
    const User = require('./models/User');
    const registros = await EscaneadoraRegistro.countDocuments();
    const usuarios = await User.countDocuments();

    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('  MI-TECH Paletizado v3.0');
    console.log(`  http://localhost:${PORT}`);
    console.log('═══════════════════════════════════════');
    console.log(`  MongoDB: conectado (${mongoose.connection.db.databaseName})`);
    console.log(`  Registros: ${registros}`);
    console.log(`  Usuarios: ${usuarios}`);
    if (usuarios === 0) {
      console.log('');
      console.log('  ⚠ No hay usuarios. Ejecuta:');
      console.log('    node scripts/seed-users.js');
    }
    console.log('═══════════════════════════════════════');

    app.listen(PORT, () => {
      console.log(`  Servidor listo en puerto ${PORT}`);
    });
  })
  .catch(err => {
    console.error('ERROR conectando a MongoDB:', err.message);
    process.exit(1);
  });
