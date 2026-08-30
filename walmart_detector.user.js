// ==UserScript==
// @name         Walmart Bot
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Smart stock monitor + auto-buy bot for Walmart
// @author       You
// @match        https://www.walmart.com/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ─── State ───────────────────────────────────────────────────────────────
    let autoBuyEnabled      = localStorage.getItem('wpd-autobuy') === 'true';
    let maxPrice            = parseFloat(localStorage.getItem('wpd-max-price')) || 50.00;
    let targetQuantity      = parseInt(localStorage.getItem('wpd-quantity')) || 1;
    let targetCvv           = localStorage.getItem('wpd-cvv') || '';
    let botInterval         = null;
    let autoBuyTriggered    = false;
    let stockStatus         = 'UNKNOWN';  // UNKNOWN | IN_STOCK | OUT_OF_STOCK
    let currentPrice        = null;
    let stockPollTimer      = null;
    let stockObserver       = null;

    // ─── LAYER 1: Fetch Interceptor ──────────────────────────────────────────
    // Intercept Walmart's own fetch calls to detect stock changes with ZERO extra requests.
    (function installFetchInterceptor() {
        const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const originalFetch = win.fetch;

        win.fetch = function(...args) {
            return originalFetch.apply(this, args).then(response => {
                try {
                    const url = (args[0] && typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url ? args[0].url : '');
                    const isRelevant = url.includes('api/2/items') ||
                                       url.includes('graphql') ||
                                       url.includes('orchestra') ||
                                       url.includes('product') ||
                                       url.includes('availability') ||
                                       url.includes('offers');

                    if (isRelevant) {
                        const cloned = response.clone();
                        cloned.json().then(data => {
                            const extracted = extractStockFromData(data);
                            if (extracted) {
                                onStockDataReceived(extracted.status, extracted.price, 'fetch-interceptor');
                            }
                        }).catch(() => {});
                    }
                } catch(e) {}
                return response;
            });
        };

        // Also intercept XHR for older Walmart API calls
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this._wpd_url = url;
            return origOpen.apply(this, [method, url, ...rest]);
        };
        XMLHttpRequest.prototype.send = function(...args) {
            const url = this._wpd_url || '';
            const isRelevant = url.includes('api/2/items') || url.includes('graphql') || url.includes('availability');
            if (isRelevant) {
                this.addEventListener('load', () => {
                    try {
                        const data = JSON.parse(this.responseText);
                        const extracted = extractStockFromData(data);
                        if (extracted) {
                            onStockDataReceived(extracted.status, extracted.price, 'xhr-interceptor');
                        }
                    } catch(e) {}
                });
            }
            return origSend.apply(this, args);
        };
    })();

    // ─── Stock Data Parser ───────────────────────────────────────────────────
    // Recursively search any JSON response for availability fields.
    function extractStockFromData(data) {
        if (!data || typeof data !== 'object') return null;
        const str = JSON.stringify(data);
        let status = null;
        let price = null;

        // Look for availabilityStatus field
        const statusMatch = str.match(/"availabilityStatus"\s*:\s*"([^"]+)"/);
        if (statusMatch) {
            status = statusMatch[1]; // "IN_STOCK" | "OUT_OF_STOCK" | "PRE_ORDER"
        }
        // Look for price field
        const priceMatch = str.match(/"price"\s*:\s*([\d.]+)/);
        if (priceMatch) {
            price = parseFloat(priceMatch[1]);
        }
        return status ? { status, price } : null;
    }

    // ─── Stock Event Handler ─────────────────────────────────────────────────
    function onStockDataReceived(status, price, source) {
        const wasOutOfStock = stockStatus !== 'IN_STOCK';
        stockStatus = status;
        if (price !== null && !isNaN(price)) currentPrice = price;

        console.log(`[WPD] Stock update from ${source}: ${status} @ $${currentPrice}`);
        updateStockUI();

        // If it just came IN_STOCK, try to buy
        if (status === 'IN_STOCK' && wasOutOfStock && autoBuyEnabled && !autoBuyTriggered) {
            if (currentPrice === null || currentPrice <= maxPrice) {
                console.log('[WPD] Stock just became available! Triggering buy flow...');
                triggerBuyFlow();
            }
        }
    }

    // ─── LAYER 2: DOM MutationObserver ───────────────────────────────────────
    // Watch for Buy Now / Add to Cart button becoming enabled.
    function installDomObserver() {
        if (stockObserver) stockObserver.disconnect();

        stockObserver = new MutationObserver(() => {
            const buyBtn = document.querySelector('[data-testid="buy-now-wrapper"]:not([disabled])');
            const addBtn = document.querySelector('[data-testid="add-to-cart-button"]:not([disabled])');

            if ((buyBtn || addBtn) && stockStatus !== 'IN_STOCK') {
                console.log('[WPD] DOM observer: Buy/Cart button appeared/enabled!');
                onStockDataReceived('IN_STOCK', currentPrice, 'dom-observer');
            }
        });

        stockObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
    }

    // ─── LAYER 3: Lightweight Background Poll ────────────────────────────────
    // Only used as fallback when page is idle and makes no native calls.
    function startStockPoll(itemId) {
        stopStockPoll();

        function poll() {
            // Randomized 45–90 second interval to look human
            const delay = (45 + Math.random() * 45) * 1000;
            stockPollTimer = setTimeout(async () => {
                if (!window.location.pathname.includes('/ip/')) return;
                try {
                    console.log('[WPD] Background poll checking stock...');
                    const res = await fetch(`/api/2/items?ids=${itemId}`, {
                        headers: { 'Accept': 'application/json' }
                    });
                    if (res.ok) {
                        const data = await res.json();
                        const extracted = extractStockFromData(data);
                        if (extracted) {
                            onStockDataReceived(extracted.status, extracted.price, 'background-poll');
                        }
                    }
                } catch(e) {
                    console.log('[WPD] Poll error:', e);
                }
                poll(); // schedule next poll
            }, delay);
        }

        poll();
    }

    function stopStockPoll() {
        if (stockPollTimer) {
            clearTimeout(stockPollTimer);
            stockPollTimer = null;
        }
    }

    // ─── LAYER 4: __NEXT_DATA__ Reader ───────────────────────────────────────
    // Read embedded JSON on initial page load — instant, no extra request.
    function readNextData() {
        const nextDataEl = document.getElementById('__NEXT_DATA__');
        if (nextDataEl) {
            try {
                const data = JSON.parse(nextDataEl.textContent);
                const extracted = extractStockFromData(data);
                if (extracted) {
                    onStockDataReceived(extracted.status, extracted.price, '__NEXT_DATA__');
                    return true;
                }
            } catch(e) {}
        }
        return false;
    }

    // ─── UI Injection ─────────────────────────────────────────────────────────
    // We inject the UI after DOMContentLoaded so elements are ready.
    function initUI() {
        if (document.getElementById('walmart-page-detector-ui')) return;

        const fontLink = document.createElement('link');
        fontLink.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap';
        fontLink.rel = 'stylesheet';
        document.head.appendChild(fontLink);

        const style = document.createElement('style');
        style.innerHTML = `
            #walmart-page-detector-ui {
                position: fixed;
                bottom: 30px;
                right: 30px;
                background: rgba(15, 23, 42, 0.92);
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 16px;
                padding: 20px 24px;
                color: #f8fafc;
                font-family: 'Inter', system-ui, -apple-system, sans-serif;
                z-index: 9999999;
                box-shadow: 0 20px 25px -5px rgba(0,0,0,0.3);
                transform: translateY(30px) scale(0.95);
                opacity: 0;
                transition: all 0.5s cubic-bezier(0.175,0.885,0.32,1.275);
                display: flex;
                flex-direction: column;
                gap: 10px;
                pointer-events: auto;
                width: 270px;
            }
            #walmart-page-detector-ui.wpd-visible { transform: translateY(0) scale(1); opacity: 1; }
            .wpd-title {
                font-weight: 700;
                font-size: 10px;
                text-transform: uppercase;
                letter-spacing: 0.12em;
                color: #64748b;
            }
            .wpd-row {
                display: flex;
                align-items: center;
                gap: 10px;
                font-weight: 600;
                font-size: 17px;
            }
            .wpd-indicator {
                width: 11px; height: 11px;
                border-radius: 50%;
                flex-shrink: 0;
                animation: wpdPulse 2s infinite;
            }
            .wpd-led-home    { background:#8b5cf6; box-shadow:0 0 10px #8b5cf6; }
            .wpd-led-search  { background:#ec4899; box-shadow:0 0 10px #ec4899; }
            .wpd-led-product { background:#10b981; box-shadow:0 0 10px #10b981; }
            .wpd-led-checkout{ background:#f59e0b; box-shadow:0 0 10px #f59e0b; }
            .wpd-led-default { background:#3b82f6; box-shadow:0 0 10px #3b82f6; }
            .wpd-stock-row {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                padding: 6px 10px;
                border-radius: 8px;
                background: rgba(255,255,255,0.06);
            }
            .wpd-stock-dot {
                width: 8px; height: 8px;
                border-radius: 50%;
                flex-shrink: 0;
            }
            .wpd-stock-dot.in  { background: #10b981; box-shadow: 0 0 6px #10b981; }
            .wpd-stock-dot.out { background: #ef4444; box-shadow: 0 0 6px #ef4444; }
            .wpd-stock-dot.unk { background: #64748b; }
            .wpd-badge {
                background: rgba(255,255,255,0.1);
                padding: 2px 8px;
                border-radius: 20px;
                font-size: 11px;
                font-family: monospace;
                color: #e2e8f0;
            }
            .wpd-divider { border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 2px 0; }
            .wpd-settings { display: none; flex-direction: column; gap: 10px; }
            .wpd-input-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 12px;
                color: #94a3b8;
            }
            .wpd-input-row input {
                background: rgba(0,0,0,0.25);
                border: 1px solid rgba(255,255,255,0.1);
                color: white;
                border-radius: 6px;
                padding: 5px 9px;
                width: 85px;
                font-family: 'Inter', sans-serif;
                font-size: 13px;
                outline: none;
                transition: border-color 0.2s;
            }
            .wpd-input-row input:focus { border-color: #3b82f6; }
            .wpd-btn {
                padding: 9px;
                border-radius: 8px;
                border: none;
                font-weight: 600;
                font-size: 13px;
                cursor: pointer;
                transition: all 0.2s;
                font-family: 'Inter', sans-serif;
                width: 100%;
            }
            .wpd-btn-off { background: rgba(255,255,255,0.08); color:#94a3b8; }
            .wpd-btn-off:hover { background: rgba(255,255,255,0.13); }
            .wpd-btn-on  { background:#10b981; color:white; box-shadow:0 4px 14px rgba(16,185,129,0.35); }
            .wpd-btn-on:hover { background:#059669; }
            .wpd-source-tag {
                font-size: 10px;
                color: #475569;
                text-align: right;
                font-family: monospace;
            }
            @keyframes wpdPulse {
                0%   { opacity:0.7; transform:scale(0.9); }
                50%  { opacity:1;   transform:scale(1.15); }
                100% { opacity:0.7; transform:scale(0.9); }
            }
        `;
        document.head.appendChild(style);

        const ui = document.createElement('div');
        ui.id = 'walmart-page-detector-ui';
        ui.innerHTML = `
            <div class="wpd-title">Walmart Bot v2.0</div>
            <div class="wpd-row">
                <div class="wpd-indicator wpd-led-default" id="wpd-led"></div>
                <span id="wpd-text">Detecting...</span>
            </div>
            <div id="wpd-stock-row" class="wpd-stock-row" style="display:none;">
                <div class="wpd-stock-dot unk" id="wpd-stock-dot"></div>
                <span id="wpd-stock-text" style="flex:1;color:#cbd5e1;">Checking stock...</span>
                <span class="wpd-badge" id="wpd-price-badge" style="display:none;"></span>
            </div>
            <div class="wpd-source-tag" id="wpd-source"></div>
            <hr class="wpd-divider" id="wpd-settings-divider" style="display:none;">
            <div class="wpd-settings" id="wpd-settings">
                <div class="wpd-input-row">
                    <label>Max Price ($)</label>
                    <input type="number" id="wpd-max-price" step="0.01" min="0">
                </div>
                <div class="wpd-input-row">
                    <label>Quantity</label>
                    <input type="number" id="wpd-quantity" min="1" max="99">
                </div>
                <div class="wpd-input-row">
                    <label>CVV</label>
                    <input type="password" id="wpd-cvv" maxlength="4" placeholder="3 digits">
                </div>
                <button id="wpd-auto-buy-btn" class="wpd-btn wpd-btn-off">Auto Buy: OFF</button>
            </div>
        `;
        document.body.appendChild(ui);
        setTimeout(() => ui.classList.add('wpd-visible'), 100);

        // Wire up elements
        const led          = document.getElementById('wpd-led');
        const textEl       = document.getElementById('wpd-text');
        const stockRow     = document.getElementById('wpd-stock-row');
        const stockDot     = document.getElementById('wpd-stock-dot');
        const stockText    = document.getElementById('wpd-stock-text');
        const priceBadge   = document.getElementById('wpd-price-badge');
        const sourceTag    = document.getElementById('wpd-source');
        const settingDiv   = document.getElementById('wpd-settings');
        const settingDiv2  = document.getElementById('wpd-settings-divider');
        const maxPriceInput= document.getElementById('wpd-max-price');
        const qtyInput     = document.getElementById('wpd-quantity');
        const cvvInput     = document.getElementById('wpd-cvv');
        const autoBuyBtn   = document.getElementById('wpd-auto-buy-btn');

        // Pre-fill saved values
        maxPriceInput.value = maxPrice.toFixed(2);
        qtyInput.value      = targetQuantity;
        cvvInput.value      = targetCvv;

        // Persist on input
        maxPriceInput.addEventListener('input', e => {
            maxPrice = parseFloat(e.target.value) || 0;
            localStorage.setItem('wpd-max-price', maxPrice);
        });
        qtyInput.addEventListener('input', e => {
            targetQuantity = parseInt(e.target.value) || 1;
            localStorage.setItem('wpd-quantity', targetQuantity);
        });
        cvvInput.addEventListener('input', e => {
            targetCvv = e.target.value;
            localStorage.setItem('wpd-cvv', targetCvv);
            // Live-update checkout page CVV field if visible
            const actualCvvField = document.getElementById('cvv-field');
            if (actualCvvField) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(actualCvvField, targetCvv);
                actualCvvField.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });

        autoBuyBtn.addEventListener('click', () => {
            autoBuyEnabled = !autoBuyEnabled;
            localStorage.setItem('wpd-autobuy', autoBuyEnabled);
            syncBtnState();
        });

        function syncBtnState() {
            autoBuyBtn.innerText = autoBuyEnabled ? 'Auto Buy: ON' : 'Auto Buy: OFF';
            autoBuyBtn.className = autoBuyEnabled ? 'wpd-btn wpd-btn-on' : 'wpd-btn wpd-btn-off';
        }
        syncBtnState();

        // ── Expose update functions globally so other code can call them ──
        window._wpdUpdatePageUI = function(pageType, extra) {
            const configs = {
                home:     { label:'Home Page',     cls:'wpd-led-home'    },
                search:   { label:'Search Page',   cls:'wpd-led-search'  },
                product:  { label:'Product Page',  cls:'wpd-led-product' },
                checkout: { label:'Checkout Page', cls:'wpd-led-checkout'},
                other:    { label:'Other Page',    cls:'wpd-led-default' },
            };
            const cfg = configs[pageType] || configs.other;
            textEl.innerText = cfg.label;
            led.className = 'wpd-indicator ' + cfg.cls;

            const isProduct  = pageType === 'product';
            const isCheckout = pageType === 'checkout';
            settingDiv.style.display   = (isProduct || isCheckout) ? 'flex' : 'none';
            settingDiv2.style.display  = (isProduct || isCheckout) ? 'block' : 'none';
            stockRow.style.display     = isProduct ? 'flex' : 'none';

            if (extra && extra.query) {
                stockText.innerText = `Query: ${extra.query}`;
                stockRow.style.display = 'flex';
                stockDot.className = 'wpd-stock-dot unk';
            }
        };

        window._wpdUpdateStockUI = function(status, price, source) {
            const isIn = status === 'IN_STOCK';
            stockDot.className = 'wpd-stock-dot ' + (isIn ? 'in' : status === 'OUT_OF_STOCK' ? 'out' : 'unk');
            stockText.innerText = isIn ? 'IN STOCK' : status === 'OUT_OF_STOCK' ? 'Out of Stock' : 'Checking...';
            if (price != null) {
                priceBadge.style.display = '';
                priceBadge.innerText = `$${price.toFixed(2)}`;
            }
            sourceTag.innerText = source ? `via ${source}` : '';
        };
    }

    function updateStockUI() {
        if (window._wpdUpdateStockUI) {
            window._wpdUpdateStockUI(stockStatus, currentPrice, '');
        }
    }

    // ─── Page Router ──────────────────────────────────────────────────────────
    function checkPage() {
        const pathname = window.location.pathname;

        if (pathname === '/' || pathname === '/home') {
            if (window._wpdUpdatePageUI) window._wpdUpdatePageUI('home');
            stopStockPoll();
            if (stockObserver) stockObserver.disconnect();

        } else if (pathname.includes('/search')) {
            const q = new URLSearchParams(window.location.search).get('q');
            if (window._wpdUpdatePageUI) window._wpdUpdatePageUI('search', { query: q });
            stopStockPoll();

        } else if (pathname.includes('/ip/')) {
            if (window._wpdUpdatePageUI) window._wpdUpdatePageUI('product');
            stockStatus = 'UNKNOWN';
            currentPrice = null;
            autoBuyTriggered = false;

            // Start price bot
            startPriceBot();

            // Layer 4: read embedded data first
            const gotData = readNextData();

            // Layer 2: watch the DOM
            installDomObserver();

            // Layer 3: start lightweight background poll
            const itemIdMatch = pathname.match(/\/ip\/[^/]+\/(\d+)/);
            const itemId = itemIdMatch ? itemIdMatch[1] : null;
            if (itemId) startStockPoll(itemId);

        } else if (pathname.includes('/checkout')) {
            if (window._wpdUpdatePageUI) window._wpdUpdatePageUI('checkout');
            stopStockPoll();
            if (autoBuyEnabled) startCheckoutBot();

        } else {
            if (window._wpdUpdatePageUI) window._wpdUpdatePageUI('other');
            stopStockPoll();
        }
    }

    // ─── Price Bot (product page) ─────────────────────────────────────────────
    function startPriceBot() {
        if (botInterval) clearInterval(botInterval);
        botInterval = setInterval(() => {
            const priceEl = document.querySelector('[itemprop="price"], [data-fs-element="price"]');
            if (priceEl) {
                const price = parseFloat(priceEl.innerText.replace(/[^0-9.]/g, ''));
                if (!isNaN(price)) {
                    currentPrice = price;
                    updateStockUI();
                }
            }
        }, 1500);
    }

    // ─── Buy Flow ─────────────────────────────────────────────────────────────
    function triggerBuyFlow() {
        autoBuyTriggered = true;
        const buyBtn = document.querySelector('button[data-testid="buy-now-wrapper"]');
        if (buyBtn && !buyBtn.disabled) {
            buyBtn.click();
            waitForPanelAndSetQuantity();
        } else {
            autoBuyTriggered = false; // retry next stock event
        }
    }

    function waitForPanelAndSetQuantity() {
        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;
            const incBtn  = document.querySelector('[data-testid="quantity-stepper-inc-button"]');
            const qtyLabel= document.querySelector('[data-testid="quantity-label"]');
            if (incBtn && qtyLabel) {
                const cur = parseInt(qtyLabel.innerText);
                if (cur < targetQuantity) {
                    if (!incBtn.disabled) incBtn.click();
                    else {
                        clearInterval(interval);
                        proceedToCheckoutOrPlaceOrder();
                    }
                } else {
                    clearInterval(interval);
                    proceedToCheckoutOrPlaceOrder();
                }
            }
            if (attempts > 40) clearInterval(interval);
        }, 400);
    }

    function proceedToCheckoutOrPlaceOrder() {
        setTimeout(() => {
            const cvvBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Enter your CVV'));
            if (cvvBtn) {
                cvvBtn.click();
            } else {
                const btn = document.querySelector('button[aria-label*="Place order"]');
                if (btn) btn.click();
            }
        }, 400);
    }

    // ─── Checkout Bot ─────────────────────────────────────────────────────────
    function startCheckoutBot() {
        const interval = setInterval(() => {
            if (!autoBuyEnabled || !window.location.pathname.includes('/checkout')) {
                clearInterval(interval);
                return;
            }
            const cvvField = document.getElementById('cvv-field');
            if (cvvField) {
                if (targetCvv && cvvField.value !== targetCvv) {
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(cvvField, targetCvv);
                    cvvField.dispatchEvent(new Event('input', { bubbles: true }));
                    cvvField.dispatchEvent(new Event('change', { bubbles: true }));
                }
                const placeBtn = document.querySelector('[data-testid="place-order-button"], [data-automation-id="place-order-button"]');
                if (placeBtn && !placeBtn.disabled) {
                    placeBtn.click();
                    console.log('[WPD] Final Place Order clicked!');
                }
            }
        }, 50);
    }

    // ─── Bootstrap ────────────────────────────────────────────────────────────
    // UI needs DOM, routing can start immediately
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { initUI(); checkPage(); });
    } else {
        initUI();
        checkPage();
    }

    // SPA navigation watcher
    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            checkPage();
        }
    }).observe(document.documentElement, { subtree: true, childList: true });

})();
