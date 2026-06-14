const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

// DB pool — importing it runs the startup connection check.
const db = require('./config/db');

// Routers
const loginRoute = require('./routes/loginRoute');
// As you build more features, add their routers here, e.g.:
// const productsRoute = require('./routes/productsRoute');

const app = express();
const PORT = process.env.PORT || 5000;

// ---- Global middleware ----
app.use(cors());                              // allow the frontend to call the API
app.use(morgan('dev'));                       // request logging
app.use(express.json());                      // parse JSON bodies (REQUIRED before routes)
app.use(express.urlencoded({ extended: true }));

// ---- Health check ----
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'API server is live',
    version: '1.0.0',
    timestamp: new Date()
  });
});

// ---- API routes ----
// loginRoute defines /login, /register, /me — so the full paths become
// /api/auth/login, /api/auth/register, /api/auth/me.
// (Change '/api/auth' to '/api/login' if you prefer that prefix.)
app.use('/api/auth', loginRoute);
// app.use('/api/products', productsRoute);

// ---- 404 handler ----
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Resource not found' });
});

// ---- Global error handler ----
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err.message);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ---- Start ----
app.listen(PORT, () => {
  console.log('=======================================================');
  console.log(` Backend listening on port ${PORT}`);
  console.log(` Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('=======================================================');
});

module.exports = app;