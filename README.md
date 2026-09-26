# 🛒 Walmart Sniper — Tampermonkey Script

A smart, lightweight, professional-grade automation bot for Walmart.com. It monitors stock availability in real time and automatically purchases items when they come in stock at or below your target price.

---

## ✨ Features

- **🔍 Page Detection** — Automatically detects Home, Search, Product, and Checkout pages
- **📡 4-Layer Smart Stock Monitor** — Detects stock changes instantly without unnecessary page refreshes
- **💰 Price Threshold** — Only triggers a purchase if the price is at or below your set limit
- **🛒 Full Auto-Buy Flow** — Clicks Buy Now → sets quantity → enters CVV → places order
- **🔄 SPA Navigation Support** — Works seamlessly as you navigate Walmart without full page reloads
- **💾 Persistent Settings** — All settings (price, quantity, CVV, webhooks) are saved in your browser automatically
- **📋 AutoBuy Whitelist** — Target specific items to automatically buy by adding them to your custom AutoBuy list
- **⚡ Humanized Speed Profiles** — Choose between Aggressive, Balanced, Human, or Stealth modes with randomized interaction delays to evade anti-bot detection
- **🔔 Webhook Notifications** — Get instant Restock and Purchase alerts sent directly to Discord and Telegram
- **🎨 Beautiful Glassmorphism UI** — Sleek floating panel with an animated gradient header, neon glowing LED status indicators, collapsible sections, and a built-in activity log console

---

## 🚀 Installation & Permissions

### Prerequisites
- A Chromium-based browser (Chrome, Edge, Brave) or Firefox
- [Tampermonkey](https://www.tampermonkey.net/) extension installed

### Steps

1. Open the **Tampermonkey** extension dashboard and click the **+ (Create a new script)** tab.
2. Delete any default code in the editor.
3. Copy and paste the entire contents of [`walmart_detector.user.js`](./walmart_detector.user.js).
4. Press **Ctrl + S** (or File → Save).
5. Ensure the script is **enabled** in Tampermonkey.
6. Navigate to [walmart.com](https://www.walmart.com). The bot panel will appear in the bottom-right corner.

### 🛡️ Required Permissions
The script requires the following Tampermonkey `@grant` permissions to function correctly:
- `@grant unsafeWindow` — To intercept Walmart's internal GraphQL/REST fetch and XHR responses.
- `@grant GM_notification` — To show system-level desktop notifications on successful purchases.

*Note: For webhook notifications to Discord and Telegram, your browser will make standard `fetch()` requests directly from the Walmart page.*

---

## 🖥️ UI Overview

The floating panel appears in the **bottom-right corner** of every Walmart page. You can click the **`-` minimize button** in the header to collapse the bot when you want it out of the way.

```
┌──────────────────────────────────────┐
│ 🎯 Walmart Sniper v2.2            −  │
│ ──────────────────────────────────── │
│ 🟢 Product Page                      │
│ 📦 ✔ IN STOCK          [ $41.99 ]    │
│ ＋ Add to AutoBuy List                │
│                                      │
│ 🛒 AutoBuy List                  (1) ▼│
│ ⚙️ Settings                         ▼│
│ 📋 Activity Log                  (0) ▼│
└──────────────────────────────────────┘
```

### LED Indicator Colors
| Color | Page |
|---|---|
| 🟣 Violet | Home Page |
| 🩷 Pink | Search Page |
| 🟢 Green | Product Page |
| 🟡 Amber | Checkout Page |
| 🔵 Blue | Other Page |

### Stock Dot Colors
| Color | Status |
|---|---|
| 🟢 Green (Pulsing) | In Stock |
| 🔴 Red | Out of Stock |
| ⚫ Gray | Unknown / Checking / Searching |

---

## ⚙️ Configuration & Usage

All settings are configured directly in the collapsible **Settings** section of the UI panel.

### Core Settings
| Setting | Description |
|---|---|
| **Max Price ($)** | Bot will only trigger a buy if the item price is ≤ this value. |
| **Quantity** | Number of items to add before placing the order (1-99). |
| **CVV** | The 3- or 4-digit CVV for your saved payment method on Walmart. |
| **Bot Speed** | Controls the delay between clicks and navigation. Choose from: **⚡ Aggressive**, **🎯 Balanced**, **🐢 Human**, or **🥷 Stealth**. |
| **Auto Buy** | Master toggle to enable/disable the automated purchase flow. |

### Webhook Alerts
You can receive instant messages when an item restocks or when the bot successfully buys it.
- **Discord Webhook URL**: Paste your Discord channel webhook URL.
- **Telegram Bot Token**: The token for your Telegram Bot (e.g., `123456:ABC-DEF`).
- **Telegram Chat ID**: The ID of the chat/channel you want the bot to message.
*Click **🔔 Send Test Alert** to verify your webhooks are working properly.*

### AutoBuy List (Whitelist)
To prevent the bot from buying random items, you can curate an **AutoBuy List**.
1. Navigate to a product page you want to snipe.
2. Click **＋ Add to AutoBuy List**.
3. Turn **Auto Buy: ON**.
4. The bot will now actively monitor and snipe this item as soon as it goes in stock below your Max Price.

---

## 📡 Stock Monitoring Architecture

The bot uses a **4-layer system** to detect stock changes instantly while minimizing bot-detection risk:

### Layer 1 — Fetch & XHR Interceptor *(Primary)*
Overrides `window.fetch` and `XMLHttpRequest` to silently read every API response Walmart's own JavaScript makes. When Walmart's internal GraphQL/REST API returns `availabilityStatus: "IN_STOCK"`, the bot reacts **within milliseconds** — generating **zero extra network requests**.

### Layer 2 — DOM MutationObserver *(Instant Fallback)*
Watches the "Buy Now" and "Add to Cart" buttons for any DOM state change (appearing, becoming enabled). Reacts instantly with no extra requests.

### Layer 3 — Lightweight Background Poll *(Safety Net)*
If the page sits idle and Walmart makes no native API calls, the bot periodically fetches **only** the lightweight item endpoint: `GET /api/2/items?ids={itemId}`
Polls at a **randomized 45–90 second interval** to mimic human browsing behavior and avoid rate limits.

### Layer 4 — `__NEXT_DATA__` Reader *(Initial Load)*
On every product page load, immediately reads the embedded `<script id="__NEXT_DATA__">` JSON tag that Walmart's Next.js server injects.

---

## 🤖 Auto-Buy Flow

When Auto Buy is **ON**, the item is on your **AutoBuy List**, and stock is detected at or below your Max Price:

```text
1. Detect IN_STOCK via any monitoring layer
      ↓
2. Click "Buy Now" button (with humanized pointer events + delay)
      ↓
3. Wait for slide panel → click "Checkout" or increment quantity
      ↓
4. If Buy Now fails, fall back to "Add to Cart" → Direct Navigation to Checkout
      ↓
5. On checkout page:
   - Inject saved CVV into form field
   - Click "Place order" button (retries every 50ms until successful)
      ↓
6. Play success chime, display on-screen banner, and fire webhooks!
```

---

## 🛡️ Anti-Bot Evasion

| Technique | How it helps |
|---|---|
| **Humanized Delays** | Introduces randomized `setTimeout` pauses between clicks (based on your Bot Speed setting). |
| **Realistic Click Events** | Synthesizes full pointer sequences (`pointerover`, `mouseenter`, `pointerdown`, `pointerup`, `click`) to bypass basic event listeners. |
| **Passive Monitoring** | Reads Walmart's own traffic instead of hammering the servers with manual `fetch` loops. |

---

## ⚠️ Disclaimer

This script is provided for **educational and personal research purposes only**.

- Automating purchases on Walmart.com may violate their [Terms of Use](https://www.walmart.com/help/article/walmart-com-terms-of-use/3b75080af40340d6bbd596f116fae5a0).
- Use at your own risk — your account or IP could be suspended.
- The author takes no responsibility for any bans, financial losses, or other consequences.

---

## 📝 Changelog

### v2.2
- **New Feature**: Discord & Telegram Webhook integration.
- **New Feature**: 4 Humanized Bot Speed profiles (Aggressive, Balanced, Human, Stealth).
- **New Feature**: Item Whitelist (AutoBuy List) to control exactly what gets purchased.
- **UI Update**: Complete redesign with dark mode glassmorphism, animated neon LEDs, collapsible sections, and an activity log console.

### v2.0
- Complete rewrite with 4-layer smart stock monitoring.
- Added Fetch + XHR interceptor (Layer 1) — zero extra requests.

### v1.0
- Initial release.