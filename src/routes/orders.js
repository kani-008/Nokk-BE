const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, isAdmin } = require('../middleware/auth');

// POST /api/orders - Place a new order (Protected)
router.post('/', verifyToken, async (req, res) => {
  const { 
    items, subtotal, deliveryCharge, discount, 
    couponApplied, total, paymentMethod, address 
  } = req.body;

  if (!items || items.length === 0 || !address || total === undefined) {
    return res.status(400).json({ success: false, message: 'Missing required order fields' });
  }

  try {
    // Start Transaction
    await db.query('BEGIN');

    // 1. Validate Coupon if applied
    if (couponApplied) {
      const couponRes = await db.query(
        'SELECT * FROM coupons WHERE code = $1 AND is_active = TRUE AND (expiry_date IS NULL OR expiry_date > NOW())',
        [couponApplied]
      );
      
      if (couponRes.rows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `Coupon code '${couponApplied}' is invalid or expired` });
      }

      const coupon = couponRes.rows[0];
      if (parseFloat(subtotal) < parseFloat(coupon.min_order)) {
        await db.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `Minimum order value of ₹${coupon.min_order} required for coupon` });
      }

      if (coupon.usage_count >= coupon.max_uses) {
        await db.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Coupon usage limit has been reached' });
      }

      // Increment coupon usage count
      await db.query('UPDATE coupons SET usage_count = usage_count + 1 WHERE id = $1', [coupon.id]);
    }

    // 2. Verify and Deduct Variant Stocks
    for (const item of items) {
      // Find variant by product ID and weight label
      const varRes = await db.query(
        'SELECT id, price, stock_qty FROM product_variants WHERE product_id = $1 AND weight_label = $2 AND is_active = TRUE FOR UPDATE',
        [item.productId, item.weight]
      );

      if (varRes.rows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `Product variant ${item.weight} for product ID ${item.productId} not found` });
      }

      const variant = varRes.rows[0];
      if (variant.stock_qty < item.quantity) {
        await db.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `Insufficient stock for ${item.nameEn || item.productId} (${item.weight}). Available: ${variant.stock_qty}` });
      }

      // Deduct Stock
      await db.query(
        'UPDATE product_variants SET stock_qty = stock_qty - $1, updated_at = NOW() WHERE id = $2',
        [item.quantity, variant.id]
      );
    }

    // 3. Generate Unique Order ID (ORD-XXXX)
    let orderId = '';
    let isUnique = false;
    while (!isUnique) {
      const rand = Math.floor(1000 + Math.random() * 9000);
      orderId = `ORD-${rand}`;
      const checkRes = await db.query('SELECT id FROM orders WHERE id = $1', [orderId]);
      if (checkRes.rows.length === 0) {
        isUnique = true;
      }
    }

    // 4. Insert Order
    // Support doorNo/street OR addressLine1/addressLine2 structure
    const addrLine1 = address.addressLine1 || `${address.doorNo || ''} ${address.street || ''}`.trim();
    const addrLine2 = address.addressLine2 || null;
    const paymentStatus = paymentMethod && paymentMethod.toLowerCase().includes('cod') ? 'pending' : 'paid';

    await db.query(
      `INSERT INTO orders (
         id, user_id, customer_name, customer_email, customer_phone,
         subtotal, delivery_charge, discount, coupon_applied, total,
         status, payment_method, payment_status,
         shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_pincode
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12, $13, $14, $15, $16, $17)`,
      [
        orderId, req.user.id, address.fullName || req.user.full_name || 'Customer', req.user.email,
        address.phone || req.user.phone || '9999999999', subtotal, deliveryCharge, discount, couponApplied || null, total,
        paymentMethod, paymentStatus, addrLine1, addrLine2, address.city, address.state || 'Tamil Nadu', address.pincode
      ]
    );

    // 5. Insert Order Items
    for (const item of items) {
      // Sourced variant ID
      const varRes = await db.query(
        'SELECT id FROM product_variants WHERE product_id = $1 AND weight_label = $2',
        [item.productId, item.weight]
      );
      const variantId = varRes.rows[0] ? varRes.rows[0].id : null;

      await db.query(
        `INSERT INTO order_items (order_id, product_id, variant_id, name_en, name_ta, weight, price, quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderId, item.productId, variantId, item.nameEn, item.nameTa || null, item.weight, item.price, item.quantity]
      );
    }

    // 6. Insert Initial Timeline Event
    await db.query(
      `INSERT INTO order_timelines (order_id, status, notes)
       VALUES ($1, 'pending', 'Order placed by customer.')`,
      [orderId]
    );

    // 7. Clear User's Database Cart
    const cartRes = await db.query('SELECT id FROM carts WHERE user_id = $1', [req.user.id]);
    if (cartRes.rows.length > 0) {
      await db.query('DELETE FROM cart_items WHERE cart_id = $1', [cartRes.rows[0].id]);
    }

    await db.query('COMMIT');
    
    // Fetch full order info to return
    const insertedOrder = {
      id: orderId,
      date: new Date().toISOString(),
      customerName: address.fullName || req.user.full_name,
      customerEmail: req.user.email,
      customerPhone: address.phone || req.user.phone,
      items,
      subtotal,
      deliveryCharge,
      discount,
      couponApplied,
      total,
      status: 'pending',
      paymentMethod,
      paymentStatus,
      address
    };

    return res.status(201).json({ success: true, message: 'Order placed successfully!', order: insertedOrder });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Checkout error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// GET /api/orders - Fetch customer order history (Protected)
router.get('/', verifyToken, async (req, res) => {
  try {
    const ordersRes = await db.query(
      'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );

    const orders = [];
    for (const ord of ordersRes.rows) {
      // Fetch items
      const itemsRes = await db.query(
        'SELECT product_id AS "productId", name_en AS "nameEn", name_ta AS "nameTa", weight, price, quantity FROM order_items WHERE order_id = $1',
        [ord.id]
      );

      // Fetch timelines
      const timelineRes = await db.query(
        'SELECT status, notes, created_at AS date FROM order_timelines WHERE order_id = $1 ORDER BY created_at ASC',
        [ord.id]
      );

      orders.push({
        id: ord.id,
        date: ord.created_at,
        customerName: ord.customer_name,
        customerEmail: ord.customer_email,
        customerPhone: ord.customer_phone,
        items: itemsRes.rows.map(item => ({
          ...item,
          price: parseFloat(item.price),
          quantity: parseInt(item.quantity)
        })),
        subtotal: parseFloat(ord.subtotal),
        deliveryCharge: parseFloat(ord.delivery_charge),
        discount: parseFloat(ord.discount),
        couponApplied: ord.coupon_applied,
        total: parseFloat(ord.total),
        status: ord.status,
        paymentMethod: ord.payment_method,
        paymentStatus: ord.payment_status,
        address: {
          fullName: ord.customer_name,
          phone: ord.customer_phone,
          addressLine1: ord.shipping_address_line1,
          addressLine2: ord.shipping_address_line2,
          city: ord.shipping_city,
          state: ord.shipping_state,
          pincode: ord.shipping_pincode
        },
        timeline: timelineRes.rows
      });
    }

    return res.json({ success: true, orders });
  } catch (err) {
    console.error('Order history fetch error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// GET /api/orders/admin/list - Master list of all orders (Admin Protected)
router.get('/admin/list', verifyToken, isAdmin, async (req, res) => {
  try {
    const ordersRes = await db.query(
      'SELECT * FROM orders ORDER BY created_at DESC'
    );

    const orders = [];
    for (const ord of ordersRes.rows) {
      const itemsRes = await db.query(
        'SELECT product_id AS "productId", name_en AS "nameEn", name_ta AS "nameTa", weight, price, quantity FROM order_items WHERE order_id = $1',
        [ord.id]
      );
      const timelineRes = await db.query(
        'SELECT status, notes, created_at AS date FROM order_timelines WHERE order_id = $1 ORDER BY created_at ASC',
        [ord.id]
      );

      orders.push({
        id: ord.id,
        date: ord.created_at,
        customerName: ord.customer_name,
        customerEmail: ord.customer_email,
        customerPhone: ord.customer_phone,
        items: itemsRes.rows.map(item => ({
          ...item,
          price: parseFloat(item.price),
          quantity: parseInt(item.quantity)
        })),
        subtotal: parseFloat(ord.subtotal),
        deliveryCharge: parseFloat(ord.delivery_charge),
        discount: parseFloat(ord.discount),
        couponApplied: ord.coupon_applied,
        total: parseFloat(ord.total),
        status: ord.status,
        paymentMethod: ord.payment_method,
        paymentStatus: ord.payment_status,
        address: {
          fullName: ord.customer_name,
          phone: ord.customer_phone,
          addressLine1: ord.shipping_address_line1,
          addressLine2: ord.shipping_address_line2,
          city: ord.shipping_city,
          state: ord.shipping_state,
          pincode: ord.shipping_pincode
        },
        timeline: timelineRes.rows
      });
    }

    return res.json({ success: true, orders });
  } catch (err) {
    console.error('Admin order list error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// GET /api/orders/:id - Fetch single order details (Protected)
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const ordCheck = await db.query(
      'SELECT * FROM orders WHERE id = $1',
      [req.params.id]
    );

    if (ordCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const ord = ordCheck.rows[0];

    // Restrict to owner unless admin
    if (ord.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Access denied: Unauthorized' });
    }

    const itemsRes = await db.query(
      'SELECT product_id AS "productId", name_en AS "nameEn", name_ta AS "nameTa", weight, price, quantity FROM order_items WHERE order_id = $1',
      [ord.id]
    );

    const timelineRes = await db.query(
      'SELECT status, notes, created_at AS date FROM order_timelines WHERE order_id = $1 ORDER BY created_at ASC',
      [ord.id]
    );

    const order = {
      id: ord.id,
      date: ord.created_at,
      customerName: ord.customer_name,
      customerEmail: ord.customer_email,
      customerPhone: ord.customer_phone,
      items: itemsRes.rows.map(item => ({
        ...item,
        price: parseFloat(item.price),
        quantity: parseInt(item.quantity)
      })),
      subtotal: parseFloat(ord.subtotal),
      deliveryCharge: parseFloat(ord.delivery_charge),
      discount: parseFloat(ord.discount),
      couponApplied: ord.coupon_applied,
      total: parseFloat(ord.total),
      status: ord.status,
      paymentMethod: ord.payment_method,
      paymentStatus: ord.payment_status,
      address: {
        fullName: ord.customer_name,
        phone: ord.customer_phone,
        addressLine1: ord.shipping_address_line1,
        addressLine2: ord.shipping_address_line2,
        city: ord.shipping_city,
        state: ord.shipping_state,
        pincode: ord.shipping_pincode
      },
      timeline: timelineRes.rows
    };

    return res.json({ success: true, order });
  } catch (err) {
    console.error('Fetch order detail error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// PUT /api/orders/:id/status - Update Order Status (Admin Protected)
router.put('/:id/status', verifyToken, isAdmin, async (req, res) => {
  const { status, notes } = req.body;

  if (!status) {
    return res.status(400).json({ success: false, message: 'Status code is required' });
  }

  try {
    await db.query('BEGIN');

    // Get current order status
    const ordCheck = await db.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (ordCheck.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const currentStatus = ordCheck.rows[0].status;

    // Update Status
    await db.query(
      'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, req.params.id]
    );

    // If order was not cancelled, but is now cancelled, restore variant stock!
    if (currentStatus !== 'cancelled' && status === 'cancelled') {
      const itemsRes = await db.query(
        'SELECT variant_id, quantity FROM order_items WHERE order_id = $1',
        [req.params.id]
      );

      for (const item of itemsRes.rows) {
        if (item.variant_id) {
          await db.query(
            'UPDATE product_variants SET stock_qty = stock_qty + $1, updated_at = NOW() WHERE id = $2',
            [item.quantity, item.variant_id]
          );
        }
      }
    }

    // Insert Timeline Event
    await db.query(
      `INSERT INTO order_timelines (order_id, status, notes)
       VALUES ($1, $2, $3)`,
      [req.params.id, status, notes || `Order status updated to: ${status}`]
    );

    await db.query('COMMIT');
    return res.json({ success: true, message: 'Order status updated successfully!' });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Update order status error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// POST /api/orders/:id/return - File return request (Protected)
router.post('/:id/return', verifyToken, async (req, res) => {
  const { reason, details } = req.body;

  if (!reason) {
    return res.status(400).json({ success: false, message: 'Return reason is required' });
  }

  try {
    await db.query('BEGIN');

    // Verify order ownership
    const ordCheck = await db.query('SELECT user_id, status FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (ordCheck.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const ord = ordCheck.rows[0];
    if (ord.user_id !== req.user.id) {
      await db.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'Unauthorized action' });
    }

    if (ord.status !== 'delivered') {
      await db.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Only delivered orders can be returned' });
    }

    // Update order status to return_requested
    await db.query(
      "UPDATE orders SET status = 'return_requested', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );

    // Create return request record
    await db.query(
      `INSERT INTO return_requests (order_id, user_id, reason, details, status)
       VALUES ($1, $2, $3, $4, 'requested')`,
      [req.params.id, req.user.id, reason, details || null]
    );

    // Timeline event
    await db.query(
      `INSERT INTO order_timelines (order_id, status, notes)
       VALUES ($1, 'return_requested', $2)`,
      [req.params.id, `Return requested. Reason: ${reason}`]
    );

    await db.query('COMMIT');
    return res.json({ success: true, message: 'Return request submitted successfully!' });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('File return request error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// GET /api/orders/admin/returns - Fetch all return requests (Admin Protected)
router.get('/admin/returns', verifyToken, isAdmin, async (req, res) => {
  try {
    const returnsRes = await db.query(
      `SELECT r.*, u.full_name AS "customerName", u.email AS "customerEmail" 
       FROM return_requests r
       JOIN users u ON u.id = r.user_id
       ORDER BY r.created_at DESC`
    );
    return res.json({ success: true, returns: returnsRes.rows });
  } catch (err) {
    console.error('Fetch returns admin error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// PUT /api/orders/admin/returns/:requestId - Approve / Reject / Complete Return (Admin Protected)
router.put('/admin/returns/:requestId', verifyToken, isAdmin, async (req, res) => {
  const { status, adminNotes } = req.body; // approved | rejected | completed

  if (!status) {
    return res.status(400).json({ success: false, message: 'Status is required' });
  }

  try {
    await db.query('BEGIN');

    const reqCheck = await db.query('SELECT * FROM return_requests WHERE id = $1 FOR UPDATE', [req.params.requestId]);
    if (reqCheck.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Return request not found' });
    }

    const retReq = reqCheck.rows[0];

    // Update return request status
    await db.query(
      `UPDATE return_requests 
       SET status = $1, admin_notes = COALESCE($2, admin_notes), updated_at = NOW() 
       WHERE id = $3`,
      [status, adminNotes || null, req.params.requestId]
    );

    // Sync order status based on return request actions
    let orderStatus = 'return_requested';
    let timelineNote = `Return request updated to: ${status}.`;
    
    if (status === 'approved') {
      orderStatus = 'processing'; // Or keep return_requested / intermediate status
      timelineNote = `Return approved. Shop admin notes: ${adminNotes || 'None'}`;
    } else if (status === 'rejected') {
      orderStatus = 'delivered'; // Reverts to delivered
      timelineNote = `Return rejected. Shop admin notes: ${adminNotes || 'None'}`;
    } else if (status === 'completed') {
      orderStatus = 'returned'; // Order status changes to returned/refunded
      timelineNote = `Return completed. Refund processed. Shop admin notes: ${adminNotes || 'None'}`;

      // Optionally restore stock upon successful return completion!
      const itemsRes = await db.query(
        'SELECT variant_id, quantity FROM order_items WHERE order_id = $1',
        [retReq.order_id]
      );

      for (const item of itemsRes.rows) {
        if (item.variant_id) {
          await db.query(
            'UPDATE product_variants SET stock_qty = stock_qty + $1, updated_at = NOW() WHERE id = $2',
            [item.quantity, item.variant_id]
          );
        }
      }
    }

    // Update main order status
    await db.query(
      'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
      [orderStatus, retReq.order_id]
    );

    // Insert timeline note
    await db.query(
      `INSERT INTO order_timelines (order_id, status, notes)
       VALUES ($1, $2, $3)`,
      [retReq.order_id, orderStatus, timelineNote]
    );

    await db.query('COMMIT');
    return res.json({ success: true, message: 'Return request updated and order synchronized!' });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Update return status error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

module.exports = router;
