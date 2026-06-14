const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

const db = require('./src/config/db');
const runMigrations = require('./src/config/migrate');

// Initialize routers
const authRouter = require('./src/routes/auth');
const categoriesRouter = require('./src/routes/categories');
const productsRouter = require('./src/routes/products');
const cartRouter = require('./src/routes/cart');
const wishlistRouter = require('./src/routes/wishlist');
const ordersRouter = require('./src/routes/orders');
const offersRouter = require('./src/routes/offers');
const bannersRouter = require('./src/routes/banners');
const settingsRouter = require('./src/routes/settings');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS with full origin support for standard dev/prod setups
app.use(cors());

// HTTP Request logging
app.use(morgan('dev'));

// JSON payload parses
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static images/files if any
// app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check and root route
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'NammaOorKaruvattuKadai API Server is live!',
    version: '1.0.0',
    timestamp: new Date()
  });
});

// Register API Routers
app.use('/api/auth', authRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/products', productsRouter);
app.use('/api/cart', cartRouter);
app.use('/api/wishlist', wishlistRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/offers', offersRouter);
app.use('/api/banners', bannersRouter);
app.use('/api/settings', settingsRouter);

// Global 404 Route handler
app.use((req, res, next) => {
  res.status(404).json({ success: false, message: 'Resource not found' });
});

// Global Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err.message);
  res.status(500).json({ success: false, message: 'Internal Server Error' });
});

// Run migrations and then start the listener
runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(` NammaOorKaruvattuKadai Backend listening on port ${PORT}`);
    console.log(` Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`=======================================================`);
  });
}).catch(err => {
  console.error('Startup migration checks failed, starting server anyway.', err.message);
  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT} (without successful migrations)`);
  });
});
