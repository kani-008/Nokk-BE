# Nokk-BE

Nokk-BE is the backend API for Namma Oor Karuvattu Kadai, a Tamil Nadu based dry fish, pickle and seafood store.
It handles products, orders, payments, auth, media uploads and WhatsApp messaging for both the storefront and the admin panel.
Built with Node.js, Express and PostgreSQL, deployed on Render.



🔗 [https://api.nammaoorkaruvattukadai.com](https://api.nammaoorkaruvattukadai.com)

## Tech Stack

- Node.js
- Express 4
- PostgreSQL (`pg`, pooled) via Supabase
- JWT auth (access + refresh tokens)
- bcryptjs
- Google Auth Library
- Razorpay Orders API + webhooks
- ImageKit
- sharp (image → WebP)
- fluent-ffmpeg / ffmpeg-static (video → H.264)
- WhatsApp Cloud API (Meta, direct)
- Helmet
- express-rate-limit
- Multer

## Folder Structure

```
Nokk-BE/
├── .env.example
├── .gitattributes
├── .gitignore
├── package.json
├── package-lock.json
├── server.js
│
└── src/
    ├── config/
    │   ├── db.js
    │   ├── imagekit.js
    │   ├── offerMatching.js
    │   └── razorpay.js
    │
    ├── middleware/
    │   ├── auth.js
    │   ├── maintenance.js
    │   └── ratelimiter.js
    │
    ├── services/
    │   └── whatsappService.js
    │
    ├── utils/
    │   └── jwtToken.js
    │
    ├── controllers/
    │   ├── bannerController.js
    │   ├── btextController.js
    │   ├── cartController.js
    │   ├── categoryController.js
    │   ├── combosController.js
    │   ├── couponController.js
    │   ├── customerVideoController.js
    │   ├── dashboardController.js
    │   ├── inventoryController.js
    │   ├── locationController.js
    │   ├── loginController.js
    │   ├── newsletterController.js
    │   ├── notificationController.js
    │   ├── offersController.js
    │   ├── orderController.js
    │   ├── productController.js
    │   ├── reportController.js
    │   ├── reviewController.js
    │   ├── settingsController.js
    │   ├── uploadController.js
    │   ├── userController.js
    │   ├── whatsappWebhookController.js
    │   └── wishlistController.js
    │
    └── routes/
        ├── bannerRoute.js
        ├── btextRoute.js
        ├── cartRoute.js
        ├── categoryRoute.js
        ├── combosRoute.js
        ├── couponRoute.js
        ├── customerVideoRoute.js
        ├── dashboardRoute.js
        ├── inventoryRoute.js
        ├── locationRoute.js
        ├── loginRoutes.js
        ├── newsletterRoute.js
        ├── notificationRoute.js
        ├── offersRoute.js
        ├── orderRoute.js
        ├── productRoute.js
        ├── reportRoute.js
        ├── reviewRoute.js
        ├── settingsRoute.js
        ├── sitemapRoute.js
        ├── uploadRoute.js
        ├── userRoute.js
        ├── whatsappRoutes.js
        └── wishlistRoute.js
```

## Environment Variables

```
# Server
PORT=
NODE_ENV=
# Comma-separated list of allowed frontend origins (CORS whitelist)
ALLOWED_ORIGINS=

# Database
DATABASE_URL=

# JWT Secrets
ACCESS_TOKEN_SECRET=
REFRESH_TOKEN_SECRET=

# ImageKit Credentials
IMAGEKIT_PUBLIC_KEY=
IMAGEKIT_PRIVATE_KEY=
IMAGEKIT_URL_ENDPOINT=

# Razorpay
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

# WhatsApp Business API
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_OTP_TEMPLATE=

# Google OAuth Client ID — from Google Cloud Console, used to verify ID tokens
GOOGLE_CLIENT_ID=
```

## APIs Used

- **Razorpay** — payments, via the Orders API and webhook-verified confirmation
- **ImageKit** — media storage for product images, review photos, and testimonial videos
- **WhatsApp Cloud API (Meta)** — customer messaging and OTP templates
- **Google OAuth** — verifying Google Sign-In tokens server-side
- **Supabase (PostgreSQL)** — primary database

## About the Project

**Powering the storefront** — Every customer-facing action on the site ends up here. Product and category data, cart and wishlist persistence, order placement, Razorpay payment confirmation through webhooks, coupon validation with race-condition safety during high-traffic moments, reviews, and customer video testimonials are all served from this API. It also handles authentication for both phone/password and Google Sign-In, and resolves addresses through an internal PIN code lookup during checkout.

**Powering the admin panel** — Everything the admin panel manages is backed by the same service. Product, category, combo, offer, and coupon management, inventory status, banner and homepage content control, dashboard analytics, reporting, notifications, and user account management all run through dedicated routes here. Media uploaded from the admin side — product photos, review images, testimonial videos — is processed and pushed to ImageKit through a shared pipeline, and WhatsApp messaging is handled through a direct Meta Cloud API integration.

## Deploying

Hosted on Render, connected to a Postgres instance on Supabase.

## Related Repository

Frontend: [kani-008/Nokk-FE](https://github.com/kani-008/Nokk-FE)
