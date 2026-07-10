# Nokk-BE

Backend for Namma Oor Karuvattu Kadai — dry fish, pickles and seafood, sold direct to customers in Tamil Nadu. Express API sitting in front of Postgres (hosted on Supabase), handling everything from product/order management to payments, media uploads, and WhatsApp messaging.

## Stack

- Node.js + Express 4
- PostgreSQL via `pg`, connection pooled, hosted on Supabase
- JWT auth (separate access/refresh secrets), bcryptjs for password hashing
- Razorpay for payments — Orders API plus webhook signature verification
- ImageKit for media storage, with `sharp` converting images to WebP and `fluent-ffmpeg`/`ffmpeg-static` converting video to H.264 before upload
- WhatsApp Cloud API, talking to Meta directly rather than going through a BSP
- Helmet, a CORS allowlist, and `express-rate-limit` on the sensitive routes
- Deployed on Render

## Running it locally

Node 18+, and a Postgres database (Supabase is what we use in prod, so easiest to match that).

```bash
git clone https://github.com/kani-008/Nokk-BE.git
cd Nokk-BE
git checkout develop
npm install
npm run dev
```

That's just `node server.js` — no nodemon/watch wired in currently, so restart manually after changes.

## Environment variables

No `.env.example` checked in — here's what `server.js` and the config files actually read:

```
PORT=                        # Render sets this itself, but set something locally
NODE_ENV=                    # development / production

# pick ONE of these two approaches for the DB connection
DATABASE_URL=
# or:
DB_USER=
DB_PASSWORD=
DB_HOST=
DB_PORT=
DB_NAME=

ALLOWED_ORIGINS=             # comma-separated, no trailing slashes needed — they get stripped
TRUST_PROXY=                 # defaults to 1 if unset, correct for Render's setup

ACCESS_TOKEN_SECRET=
REFRESH_TOKEN_SECRET=

GOOGLE_CLIENT_ID=            # for verifying Google Sign-In tokens server-side

RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

IMAGEKIT_PUBLIC_KEY=
IMAGEKIT_PRIVATE_KEY=
IMAGEKIT_URL_ENDPOINT=

WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_OTP_TEMPLATE=       # not usable yet — see the WhatsApp section below

GEOAPIFY_API_KEY=
GOV_API_KEY=                 # data.gov.in
GOV_PINCODE_RESOURCE_ID=
```

Heads up: this project has had two `.env` files leak already (June 24 and July 4). Every secret that was in either of those leaks has been rotated and should stay rotated — never paste live values into a commit, an issue, a chat, anywhere. If you're not sure whether a value is still live, assume it is.

In production, if `ALLOWED_ORIGINS` isn't set, CORS blocks everything rather than quietly falling back to localhost — that's intentional, not a bug.

## Folder structure

Pulled directly from `develop`, node_modules stripped:

```
Nokk-BE/
├── .claude/
│   ├── launch.json
│   └── settings.json
├── .gitattributes
├── .gitignore
├── package.json
├── package-lock.json
├── server.js                       # entry point — middleware chain, route mounting, health check
│
└── src/
    ├── config/
    │   ├── db.js                   # pg Pool, DATABASE_URL or discrete DB_* vars
    │   ├── imagekit.js
    │   ├── offerMatching.js        # coupon/offer eligibility logic
    │   └── razorpay.js             # lazy singleton, doesn't crash boot if keys are missing
    │
    ├── middleware/
    │   ├── auth.js                 # JWT verification / role checks
    │   ├── maintenance.js
    │   └── ratelimiter.js
    │
    ├── services/
    │   └── whatsappService.js      # Meta Cloud API calls, template sending
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
    │   ├── loginController.js      # register, login, OTP (paused), password reset
    │   ├── newsletterController.js
    │   ├── notificationController.js
    │   ├── offersController.js
    │   ├── orderController.js      # includes the Razorpay webhook handler
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

23 route files, each paired 1:1 with a controller of the same domain name (`combosRoute.js` → `combosController.js`, etc.), except `whatsappWebhookController.js`, which doesn't get its own route file — it's wired up wherever the WhatsApp webhook is mounted.

## How the API is shaped

Routes are verb-named, not REST-style — `/get-by-id`, `/update-offer`, that kind of thing, not `/products/:id`. IDs travel in the body for writes and the query string for single-item GETs. This was a deliberate early call, not something to "fix" — the frontend is built around it.

Every response comes back as `{ success, message, ...}`. Keep that shape for anything new.

New files: lowercase-first, so `orderRoute.js` / `orderController.js`, not `OrderRoute.js`.

Transactions (`BEGIN` / `COMMIT` / `ROLLBACK`) have to run on the same pooled connection. We had a bug early on where a transaction was split across separate `pool.query()` calls — looked fine, wasn't atomic at all. Grab a client with `pool.connect()` and run the whole transaction on it.

Stock is binary — `stock_qty` is 1 or 0, in stock or not. Orders never decrement it. Don't build "low stock" logic against this schema, there's nothing to calculate.

## Security setup, and one open issue

Helmet's on for headers, CORS is an explicit allowlist (normalized so trailing slashes don't cause mismatches), and the Razorpay webhook route is mounted with `express.raw()` ahead of the global JSON parser — Razorpay signs the raw body, so if that parser order ever gets changed, signature verification breaks silently. Body size is capped at 50kb on JSON/urlencoded parsers.

**The thing that still needs fixing:** `POST /reset-password` has its OTP check commented out in `loginController.js` (the `setpassword` function). Right now it'll reset a password for any phone number without confirming a verified OTP first. It's commented out, not removed, because it's waiting on WhatsApp OTP being re-enabled — but until that block goes back in, this endpoint is not safe to leave as-is in production. Flagging this again because it's been sitting here across a couple of sessions now.

## WhatsApp

Going direct through Meta's Cloud API rather than a BSP. `/register-otp`, `/otp-create`, and `/otp-verify` are all commented out right now — Meta Business Verification hasn't gone through yet, and you need that approved to unlock the Authentication template category, which the OTP flow depends on. `checkPhone` and the webhook handler are unaffected and still live.

## Media pipeline

ImageKit replaced Supabase Storage as the media store. Upload pipeline is shared across products and reviews: images get run through `sharp` to WebP, videos through `fluent-ffmpeg` to H.264, before either hits ImageKit.

## Deploying

Render, deployed off `develop`. `api.nammaoorkaruvattukadai.com` points here, DNS through Spaceship.

If a feature spans both repos, deploy this one first. The frontend has broken before from hitting a route that hadn't shipped yet on this side.

## Not doing (on purpose)

No i18n, no outbound newsletter emails (we only capture subscribers right now), no analytics, no PWA.

## Related repo

Frontend's at [kani-008/Nokk-FE](https://github.com/kani-008/Nokk-FE).
