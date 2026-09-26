// ==UserScript==
// @name         Walmart Bot
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Smart stock monitor + auto-buy bot for Walmart — with webhooks, humanized delays & per-item whitelist
// @author       Pythonic Shariful
// @match        https://www.walmart.com/*
// @grant        unsafeWindow
// @grant        GM_notification
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ─── State ───────────────────────────────────────────────────────────────
    let autoBuyEnabled = localStorage.getItem('wpd-autobuy') === 'true';
    let maxPrice = parseFloat(localStorage.getItem('wpd-max-price')) || 50.00;
    let targetQuantity = parseInt(localStorage.getItem('wpd-quantity')) || 1;
    let targetCvv = localStorage.getItem('wpd-cvv') || '';
    let botInterval = null;
    let autoBuyTriggered = false;
    let stockStatus = 'UNKNOWN';  // UNKNOWN | IN_STOCK | OUT_OF_STOCK
    let currentPrice = null;
    let stockPollTimer = null;
    let stockObserver = null;
    let currentItemId = null;

    // ─── Webhook & Delay Settings ─────────────────────────────────────────────
    let discordWebhook = localStorage.getItem('wpd-discord-webhook') || '';
    let telegramBotToken = localStorage.getItem('wpd-telegram-token') || '';
    let telegramChatId = localStorage.getItem('wpd-telegram-chatid') || '';
    // Speed levels: 0=Aggressive, 1=Balanced, 2=Human, 3=Stealth
    let botSpeedLevel = parseInt(localStorage.getItem('wpd-speed-level')) || 1;
    const SPEED_PROFILES = [
        { label: '⚡ Aggressive', hoverMin:  2, hoverMax:  8,  moveMin:  5, moveMax: 12,  downMin: 10, downMax:  25,  upMin:  3, upMax:  8  },
        { label: '🎯 Balanced',   hoverMin:  8, hoverMax: 20,  moveMin: 18, moveMax: 35,  downMin: 35, downMax:  70,  upMin:  8, upMax: 16  },
        { label: '🐢 Human',      hoverMin: 25, hoverMax: 60,  moveMin: 50, moveMax:100,  downMin:100, downMax: 220,  upMin: 30, upMax: 60  },
        { label: '🥷 Stealth',    hoverMin: 60, hoverMax:180,  moveMin:120, moveMax:300,  downMin:250, downMax: 600,  upMin: 80, upMax:180  },
    ];
    function getSpeed() { return SPEED_PROFILES[botSpeedLevel] || SPEED_PROFILES[1]; }

    // ─── In-UI Logger ────────────────────────────────────────────────────────
    const LOG_MAX = 250;
    const logBuffer = [];
    let consolePanelEl = null;
    let consoleListEl = null;
    let consoleAutoScroll = true;
    let consoleUnread = 0;
    let consoleBadgeEl = null;
    let consoleCaptureReady = false;

    function uiLog(level, ...args) {
        try {
            const ts = new Date();
            const hh = String(ts.getHours()).padStart(2, '0');
            const mm = String(ts.getMinutes()).padStart(2, '0');
            const ss = String(ts.getSeconds()).padStart(2, '0');
            const ms = String(ts.getMilliseconds()).padStart(3, '0');
            const timeStr = `${hh}:${mm}:${ss}.${ms}`;
            let msg = '';
            for (const a of args) {
                if (a === null || a === undefined) { msg += ' ' + String(a); continue; }
                if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') {
                    msg += ' ' + a;
                } else {
                    try { msg += ' ' + JSON.stringify(a); } catch (e) { msg += ' ' + String(a); }
                }
            }
            msg = msg.trim();
            logBuffer.push({ time: timeStr, level, msg });
            if (logBuffer.length > LOG_MAX) logBuffer.splice(0, logBuffer.length - LOG_MAX);
            renderConsoleLine({ time: timeStr, level, msg });
        } catch (e) { }
    }

    function captureConsole() {
        if (consoleCaptureReady) return;
        try {
            const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            const origLog = win.console.log;
            const origWarn = win.console.warn;
            const origErr = win.console.error;
            const origInfo = win.console.info;

            function hook(orig, level) {
                return function (...args) {
                    try {
                        const first = (args && args.length) ? args[0] : '';
                        const looksLikeWpd = typeof first === 'string' && (first.indexOf('[WPD]') === 0 || first.indexOf('[wpd]') === 0 || first.indexOf('WPD') === 0);
                        if (looksLikeWpd) {
                            uiLog(level, ...args);
                        }
                    } catch (e) { }
                    try { return orig.apply(win.console, args); } catch (e2) { }
                };
            }
            win.console.log = hook(origLog, 'log');
            win.console.warn = hook(origWarn, 'warn');
            win.console.error = hook(origErr, 'error');
            win.console.info = hook(origInfo, 'info');
            consoleCaptureReady = true;
        } catch (e) {
            // ignore
        }
    }
    captureConsole();

    function renderConsoleLine(entry) {
        try {
            if (!consoleListEl) return;
            const line = document.createElement('div');
            line.setAttribute('data-level', entry.level);
            line.style.cssText = 'padding:3px 8px; border-bottom:1px solid rgba(255,255,255,0.04); font-size:11px; line-height:1.35; word-break:break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;';
            const time = document.createElement('span');
            time.textContent = entry.time + '  ';
            time.style.cssText = 'color:#78909c; user-select:none;';
            const lvl = document.createElement('span');
            const lvlMap = {
                log: { t: 'LOG', c: '#81d4fa' },
                info: { t: 'INFO', c: '#69f0ae' },
                warn: { t: 'WARN', c: '#ffd54f' },
                error: { t: 'ERR ', c: '#ff8a80' },
                debug: { t: 'DBG ', c: '#b39ddb' },
            };
            const lm = lvlMap[entry.level] || lvlMap.log;
            lvl.textContent = lm.t + '  ';
            lvl.style.cssText = 'color:' + lm.c + '; font-weight:700; user-select:none;';
            const msg = document.createElement('span');
            msg.textContent = entry.msg;
            const msgColor = entry.level === 'warn' ? '#ffecb3' : entry.level === 'error' ? '#ffcdd2' : '#e0e0e0';
            msg.style.color = msgColor;
            line.appendChild(time);
            line.appendChild(lvl);
            line.appendChild(msg);
            consoleListEl.appendChild(line);

            if (consoleAutoScroll) {
                consoleListEl.scrollTop = consoleListEl.scrollHeight;
            } else {
                consoleUnread++;
                if (consoleBadgeEl) {
                    consoleBadgeEl.textContent = String(consoleUnread);
                    consoleBadgeEl.style.display = '';
                }
            }

            while (consoleListEl.childNodes.length > LOG_MAX) {
                consoleListEl.removeChild(consoleListEl.firstChild);
            }
        } catch (e) { }
    }

    function flushAllLogsToPanel() {
        try {
            if (!consoleListEl) return;
            consoleListEl.innerHTML = '';
            for (const e of logBuffer) renderConsoleLine(e);
            if (consoleAutoScroll) consoleListEl.scrollTop = consoleListEl.scrollHeight;
        } catch (e) { }
    }

    function clearConsolePanel() {
        try {
            logBuffer.length = 0;
            if (consoleListEl) consoleListEl.innerHTML = '';
            consoleUnread = 0;
            if (consoleBadgeEl) { consoleBadgeEl.textContent = '0'; consoleBadgeEl.style.display = 'none'; }
        } catch (e) { }
    }

    // ─── Whitelist Helpers ───────────────────────────────────────────────────
    function getWhitelist() {
        try { return JSON.parse(localStorage.getItem('wpd-whitelist') || '[]'); } catch (e) { return []; }
    }

    function saveWhitelist(list) {
        localStorage.setItem('wpd-whitelist', JSON.stringify(list));
    }

    function isCurrentItemWhitelisted() {
        if (!currentItemId) return false;
        return getWhitelist().some(item => item.id === currentItemId);
    }

    function addCurrentItemToWhitelist() {
        if (!currentItemId) return;
        const list = getWhitelist();
        if (!list.some(item => item.id === currentItemId)) {
            const nameEl = document.querySelector('[itemprop="name"], h1[class*="prod-title"], h1');
            const name = nameEl ? nameEl.innerText.trim().substring(0, 50) : ('Item #' + currentItemId);
            list.push({ id: currentItemId, name: name, addedAt: Date.now() });
            saveWhitelist(list);
        }
    }

    function removeItemFromWhitelist(id) {
        saveWhitelist(getWhitelist().filter(item => item.id !== id));
    }

    function clearWhitelist() {
        saveWhitelist([]);
    }

    // ─── LAYER 1: Fetch Interceptor ──────────────────────────────────────────
    (function installFetchInterceptor() {
        const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const originalFetch = win.fetch;

        win.fetch = function (...args) {
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
                            if (extracted) onStockDataReceived(extracted.status, extracted.price, 'fetch-interceptor');
                        }).catch(() => { });
                    }
                } catch (e) { }
                return response;
            });
        };

        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this._wpd_url = url;
            return origOpen.apply(this, [method, url, ...rest]);
        };
        XMLHttpRequest.prototype.send = function (...args) {
            const url = this._wpd_url || '';
            const isRelevant = url.includes('api/2/items') || url.includes('graphql') || url.includes('availability');
            if (isRelevant) {
                this.addEventListener('load', () => {
                    try {
                        const data = JSON.parse(this.responseText);
                        const extracted = extractStockFromData(data);
                        if (extracted) onStockDataReceived(extracted.status, extracted.price, 'xhr-interceptor');
                    } catch (e) { }
                });
            }
            return origSend.apply(this, args);
        };
    })();

    // ─── Stock Data Parser ───────────────────────────────────────────────────
    function extractStockFromData(data) {
        if (!data || typeof data !== 'object') return null;

        const candidates = [];

        function walk(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj)) {
                obj.forEach(walk);
                return;
            }

            let status = null;
            let price = null;
            let usItemId = null;
            let itemId = null;

            for (const k of Object.keys(obj)) {
                const v = obj[k];
                const kl = k.toLowerCase();
                if (kl === 'availabilitystatus' && typeof v === 'string') status = v;
                else if (kl === 'price' && (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)))) {
                    const p = typeof v === 'number' ? v : parseFloat(v);
                    if (!isNaN(p) && p > 0) price = p;
                }
                else if (kl === 'listprice' && price === null && (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)))) {
                    const p = typeof v === 'number' ? v : parseFloat(v);
                    if (!isNaN(p) && p > 0) price = p;
                }
                else if (kl === 'usitemid' || kl === 'us_item_id') usItemId = String(v);
                else if (kl === 'id' && (typeof v === 'string' || typeof v === 'number') && /^\d{5,}$/.test(String(v))) itemId = String(v);
                else if (kl === 'productid' || kl === 'itemid') itemId = String(v);
            }

            if (status) {
                candidates.push({ status, price, usItemId, itemId });
            }

            for (const k of Object.keys(obj)) {
                const v = obj[k];
                if (v && typeof v === 'object') walk(v);
            }
        }

        walk(data);

        if (candidates.length === 0) return null;

        const targetId = currentItemId ? String(currentItemId) : null;
        let best = null;
        for (const c of candidates) {
            if (targetId && (c.itemId === targetId || c.usItemId === targetId)) {
                best = c;
                break;
            }
        }
        if (!best) {
            for (const c of candidates) {
                if (c.status === 'IN_STOCK' || c.status === 'OUT_OF_STOCK') {
                    if (!best || (best.price === null && c.price !== null)) {
                        best = c;
                    }
                }
            }
        }
        if (!best) best = candidates[0];
        return { status: best.status, price: best.price };
    }

    // ─── Stock Event Handler ─────────────────────────────────────────────────
    function onStockDataReceived(status, price, source) {
        const wasOutOfStock = stockStatus !== 'IN_STOCK';
        stockStatus = status;
        if (price !== null && !isNaN(price)) currentPrice = price;

        console.log('[WPD] Stock update from ' + source + ': ' + status + ' @ $' + currentPrice);
        updateStockUI();

        if (status === 'IN_STOCK' && wasOutOfStock) {
            // Fire restock webhook regardless of autobuy
            const wlItem = getWhitelist().find(i => i.id === currentItemId);
            const itemName = wlItem ? wlItem.name : (currentItemId ? ('Item #' + currentItemId) : 'Walmart Item');
            notifyRestockViaWebhook(itemName, currentPrice, currentItemId);
        }

        // ── KEY FIX: Only buy if this specific item is whitelisted ──
        if (status === 'IN_STOCK' && wasOutOfStock && autoBuyEnabled && !autoBuyTriggered) {
            if (!isCurrentItemWhitelisted()) {
                console.log('[WPD] Item not on AutoBuy list — skipping buy.');
                return;
            }
            if (currentPrice === null || currentPrice <= maxPrice) {
                console.log('[WPD] Stock just became available! Item is whitelisted. Triggering buy flow...');
                triggerBuyFlow();
            }
        }
    }

    // ─── LAYER 2: DOM MutationObserver ───────────────────────────────────────
    function findBuyNowButton() {
        const tests = [
            () => document.querySelector('button[data-testid="buy-now-wrapper"]:not([disabled]):not([aria-disabled="true"])'),
            () => document.querySelector('[data-testid="buy-now-wrapper"]:not([disabled]):not([aria-disabled="true"])'),
            () => {
                const w = document.querySelector('[data-testid="buy-now-wrapper"]');
                if (w) {
                    const b = w.querySelector('button, a, [role="button"]');
                    if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') return b;
                    if (w.tagName === 'BUTTON' && !w.disabled && w.getAttribute('aria-disabled') !== 'true') return w;
                }
                return null;
            },
            () => Array.from(document.querySelectorAll('button[data-dca-intent="select"]')).find(b => {
                const t = (b.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
                return t.includes('buy now') && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
            }),
            () => Array.from(document.querySelectorAll('button')).find(b => {
                const t = (b.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
                return (t.includes('buy now')) && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
            }),
        ];
        for (const fn of tests) { try { const r = fn(); if (r) return r; } catch (e) { } }
        return null;
    }

    function findAddToCartButton() {
        const tests = [
            () => document.querySelector('button[data-automation-id="atc"]:not([disabled]):not([aria-disabled="true"])'),
            () => document.querySelector('button[data-dca-name="addToCart"]:not([disabled]):not([aria-disabled="true"])'),
            () => document.querySelector('[data-testid="add-to-cart-button"]:not([disabled]):not([aria-disabled="true"])'),
            () => Array.from(document.querySelectorAll('button')).find(b => {
                const t = (b.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
                const l = (b.getAttribute('aria-label') || '').toLowerCase();
                return ((t.includes('add to cart')) || l.startsWith('add to cart')) && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
            }),
        ];
        for (const fn of tests) { try { const r = fn(); if (r) return r; } catch (e) { } }
        return null;
    }

    function installDomObserver() {
        if (stockObserver) stockObserver.disconnect();
        stockObserver = new MutationObserver(() => {
            const buyBtn = findBuyNowButton();
            const addBtn = findAddToCartButton();
            if ((buyBtn || addBtn) && stockStatus !== 'IN_STOCK') {
                console.log('[WPD] DOM observer: Buy/Cart button appeared/enabled!');
                onStockDataReceived('IN_STOCK', currentPrice, 'dom-observer');
            }
        });
        stockObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
    }

    // ─── LAYER 3: Lightweight Background Poll ────────────────────────────────
    function startStockPoll(itemId) {
        stopStockPoll();
        function poll() {
            const delay = (45 + Math.random() * 45) * 1000;
            stockPollTimer = setTimeout(async () => {
                if (!window.location.pathname.includes('/ip/')) return;
                try {
                    const res = await fetch('/api/2/items?ids=' + itemId, { headers: { 'Accept': 'application/json' } });
                    if (res.ok) {
                        const data = await res.json();
                        const extracted = extractStockFromData(data);
                        if (extracted) onStockDataReceived(extracted.status, extracted.price, 'background-poll');
                    }
                } catch (e) { }
                poll();
            }, delay);
        }
        poll();
    }

    function stopStockPoll() {
        if (stockPollTimer) { clearTimeout(stockPollTimer); stockPollTimer = null; }
    }

    // ─── LAYER 4: __NEXT_DATA__ Reader ───────────────────────────────────────
    function readNextData() {
        const nextDataEl = document.getElementById('__NEXT_DATA__');
        if (nextDataEl) {
            try {
                const data = JSON.parse(nextDataEl.textContent);
                const extracted = extractStockFromData(data);
                if (extracted) { onStockDataReceived(extracted.status, extracted.price, '__NEXT_DATA__'); return true; }
            } catch (e) { }
        }
        return false;
    }

    // ─── Webhook Sender ───────────────────────────────────────────────────────
    async function sendDiscordWebhook(payload) {
        if (!discordWebhook) return;
        try {
            await fetch(discordWebhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            console.log('[WPD] Discord webhook sent.');
        } catch (e) { console.warn('[WPD] Discord webhook failed:', e); }
    }

    async function sendTelegramMessage(text) {
        if (!telegramBotToken || !telegramChatId) return;
        try {
            const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: telegramChatId, text, parse_mode: 'HTML' }),
            });
            console.log('[WPD] Telegram message sent.');
        } catch (e) { console.warn('[WPD] Telegram message failed:', e); }
    }

    function notifyRestockViaWebhook(itemName, price, itemId) {
        const priceStr = (price && !isNaN(price)) ? `$${price.toFixed(2)}` : 'Unknown';
        const link = itemId ? `https://www.walmart.com/ip/${itemId}` : 'https://www.walmart.com';

        // Discord rich embed
        sendDiscordWebhook({
            username: 'Walmart Sniper',
            avatar_url: 'https://i.imgur.com/AfFp7pu.png',
            embeds: [{
                title: '🟢 RESTOCK DETECTED',
                description: `**${itemName || 'Item'}** is back in stock!`,
                color: 0x10b981,
                fields: [
                    { name: '💰 Price', value: priceStr, inline: true },
                    { name: '🔗 Link', value: `[Buy Now](${link})`, inline: true },
                ],
                timestamp: new Date().toISOString(),
                footer: { text: 'Walmart Sniper v2.2' },
            }],
        });

        // Telegram
        sendTelegramMessage(
            `🟢 <b>RESTOCK DETECTED</b>\n` +
            `📦 <b>${itemName || 'Item'}</b>\n` +
            `💰 Price: ${priceStr}\n` +
            `🔗 <a href="${link}">Buy Now</a>`
        );
    }

    function notifyPurchaseViaWebhook(itemName, price, itemId) {
        const priceStr = (price && !isNaN(price)) ? `$${price.toFixed(2)}` : 'Unknown';
        const link = itemId ? `https://www.walmart.com/ip/${itemId}` : 'https://www.walmart.com';

        // Discord
        sendDiscordWebhook({
            username: 'Walmart Sniper',
            avatar_url: 'https://i.imgur.com/AfFp7pu.png',
            content: '@here 🎉 **PURCHASE COMPLETE!**',
            embeds: [{
                title: '✅ Item Successfully Purchased',
                description: `**${itemName || 'Item'}**`,
                color: 0x059669,
                fields: [
                    { name: '💰 Price Paid', value: priceStr, inline: true },
                    { name: '🔗 Link', value: `[View Item](${link})`, inline: true },
                ],
                timestamp: new Date().toISOString(),
                footer: { text: 'Walmart Sniper v2.2' },
            }],
        });

        // Telegram
        sendTelegramMessage(
            `✅ <b>PURCHASE COMPLETE!</b> 🎉\n` +
            `📦 <b>${itemName || 'Item'}</b>\n` +
            `💰 Price: ${priceStr}\n` +
            `🔗 <a href="${link}">View Item</a>`
        );
    }

    // ─── Purchase Notification ───────────────────────────────────────────────
    function playSuccessChime() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const notes = [523.25, 659.25, 783.99, 1046.50];
            notes.forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.12);
                gain.gain.setValueAtTime(0.35, ctx.currentTime + i * 0.12);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.25);
                osc.start(ctx.currentTime + i * 0.12);
                osc.stop(ctx.currentTime + i * 0.12 + 0.25);
            });
        } catch (e) { }
    }

    function notifyPurchase(itemName, price) {
        playSuccessChime();
        const banner = document.getElementById('wpd-success-banner');
        if (banner) {
            const priceStr = (price && !isNaN(price)) ? (' @ $' + price.toFixed(2)) : '';
            banner.querySelector('#wpd-success-text').innerText = 'Bought: ' + (itemName || 'Item') + priceStr;
            banner.style.display = 'flex';
            setTimeout(() => { banner.style.opacity = '1'; banner.style.transform = 'scale(1)'; }, 50);
        }
        if (typeof GM_notification === 'function') {
            const priceStr = (price && !isNaN(price)) ? (' @ $' + price.toFixed(2)) : '';
            GM_notification({
                title: 'Walmart Bot — Purchase Complete!',
                text: 'Successfully bought: ' + (itemName || 'Item') + priceStr,
                timeout: 10000,
            });
        }
        // Fire webhooks
        notifyPurchaseViaWebhook(itemName, price, currentItemId);
    }

    // ─── UI Injection ─────────────────────────────────────────────────────────
    function initUI() {
        if (document.getElementById('walmart-page-detector-ui')) return;

        const fontLink = document.createElement('link');
        fontLink.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap';
        fontLink.rel = 'stylesheet';
        document.head.appendChild(fontLink);

        const style = document.createElement('style');
        style.innerHTML = `
            /* ── Root Widget ── */
            #walmart-page-detector-ui {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 310px;
                background: linear-gradient(160deg, rgba(9,11,26,0.97) 0%, rgba(6,9,22,0.99) 100%);
                backdrop-filter: blur(24px) saturate(180%);
                -webkit-backdrop-filter: blur(24px) saturate(180%);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 20px;
                padding: 0;
                color: #e2e8f0;
                font-family: 'Inter', system-ui, sans-serif;
                z-index: 9999999;
                box-shadow:
                    0 0 0 1px rgba(255,255,255,0.04),
                    0 32px 64px -12px rgba(0,0,0,0.7),
                    0 0 80px -20px rgba(99,102,241,0.15);
                transform: translateY(40px) scale(0.94);
                opacity: 0;
                transition: opacity 0.45s cubic-bezier(0.22,1,0.36,1),
                            transform 0.45s cubic-bezier(0.22,1,0.36,1);
                pointer-events: auto;
                overflow: hidden;
            }
            #walmart-page-detector-ui.wpd-visible {
                transform: translateY(0) scale(1);
                opacity: 1;
            }
            #walmart-page-detector-ui.wpd-minimized #wpd-body { display: none !important; }

            /* ── Gradient Header Bar ── */
            #wpd-header {
                background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 50%, #0c1a3a 100%);
                padding: 13px 16px 12px;
                display: flex;
                align-items: center;
                gap: 10px;
                border-bottom: 1px solid rgba(255,255,255,0.06);
                position: relative;
                overflow: hidden;
            }
            #wpd-header::before {
                content: '';
                position: absolute;
                inset: 0;
                background: linear-gradient(90deg, rgba(99,102,241,0.12) 0%, rgba(139,92,246,0.08) 50%, transparent 100%);
                pointer-events: none;
            }
            #wpd-header-icon {
                width: 32px; height: 32px;
                background: linear-gradient(135deg, #6366f1, #8b5cf6);
                border-radius: 9px;
                display: flex; align-items: center; justify-content: center;
                font-size: 16px;
                box-shadow: 0 4px 12px rgba(99,102,241,0.4);
                flex-shrink: 0;
            }
            #wpd-header-text { flex: 1; }
            #wpd-header-title {
                font-size: 13px; font-weight: 700; color: #f1f5f9;
                letter-spacing: -0.01em; line-height: 1;
            }
            #wpd-header-sub {
                font-size: 10px; color: #64748b; font-weight: 500;
                margin-top: 2px; letter-spacing: 0.02em;
            }
            #wpd-version-chip {
                background: linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.15));
                border: 1px solid rgba(99,102,241,0.3);
                color: #a5b4fc;
                font-size: 9.5px; font-weight: 700;
                padding: 2px 7px; border-radius: 20px;
                letter-spacing: 0.04em;
            }
            #wpd-minimize-btn {
                width: 24px; height: 24px;
                background: rgba(255,255,255,0.06);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 6px;
                color: #64748b;
                font-size: 13px; line-height: 1;
                cursor: pointer; display: flex; align-items: center; justify-content: center;
                transition: all 0.2s; flex-shrink: 0;
                padding: 0;
            }
            #wpd-minimize-btn:hover { background: rgba(255,255,255,0.12); color: #94a3b8; }

            /* ── Body ── */
            #wpd-body {
                display: flex; flex-direction: column; gap: 0;
                padding: 12px 14px 14px;
                gap: 10px;
            }

            /* ── Page Status Card ── */
            #wpd-page-card {
                display: flex; align-items: center; gap: 10px;
                background: rgba(255,255,255,0.03);
                border: 1px solid rgba(255,255,255,0.06);
                border-radius: 12px; padding: 9px 12px;
            }
            .wpd-led-ring {
                width: 28px; height: 28px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                flex-shrink: 0; position: relative;
            }
            .wpd-led-ring::before {
                content: '';
                position: absolute; inset: -4px;
                border-radius: 50%;
                animation: wpdRingPulse 2.5s ease-in-out infinite;
                opacity: 0.35;
            }
            .wpd-led-dot {
                width: 10px; height: 10px; border-radius: 50%;
                animation: wpdDotPulse 2s ease-in-out infinite;
            }
            .wpd-led-home    .wpd-led-ring::before { background: #8b5cf6; }
            .wpd-led-home    .wpd-led-dot { background:#8b5cf6; box-shadow:0 0 8px 2px #8b5cf6; }
            .wpd-led-search  .wpd-led-ring::before { background: #ec4899; }
            .wpd-led-search  .wpd-led-dot { background:#ec4899; box-shadow:0 0 8px 2px #ec4899; }
            .wpd-led-product .wpd-led-ring::before { background: #10b981; }
            .wpd-led-product .wpd-led-dot { background:#10b981; box-shadow:0 0 8px 2px #10b981; }
            .wpd-led-checkout .wpd-led-ring::before { background: #f59e0b; }
            .wpd-led-checkout .wpd-led-dot { background:#f59e0b; box-shadow:0 0 8px 2px #f59e0b; }
            .wpd-led-default .wpd-led-ring::before { background: #3b82f6; }
            .wpd-led-default .wpd-led-dot { background:#3b82f6; box-shadow:0 0 8px 2px #3b82f6; }
            #wpd-text { font-size: 13px; font-weight: 600; color: #e2e8f0; flex: 1; }
            #wpd-source { font-size: 9.5px; color: #334155; font-family: monospace; }

            /* ── Stock Status Card ── */
            #wpd-stock-row {
                display: none;
                align-items: center; gap: 10px;
                border-radius: 12px; padding: 10px 12px;
                border: 1px solid rgba(255,255,255,0.06);
                background: rgba(255,255,255,0.03);
                transition: background 0.4s, border-color 0.4s;
            }
            #wpd-stock-row.stock-in {
                background: rgba(16,185,129,0.07);
                border-color: rgba(16,185,129,0.2);
            }
            #wpd-stock-row.stock-out {
                background: rgba(239,68,68,0.07);
                border-color: rgba(239,68,68,0.2);
            }
            .wpd-stock-icon {
                width: 26px; height: 26px; border-radius: 8px;
                display: flex; align-items: center; justify-content: center;
                font-size: 13px; flex-shrink: 0;
                background: rgba(255,255,255,0.05);
                transition: background 0.3s;
            }
            .stock-in .wpd-stock-icon { background: rgba(16,185,129,0.15); }
            .stock-out .wpd-stock-icon { background: rgba(239,68,68,0.15); }
            .wpd-stock-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; transition: all 0.3s; }
            .wpd-stock-dot.in  { background:#10b981; box-shadow:0 0 6px #10b981; animation: wpdDotPulse 1.5s ease-in-out infinite; }
            .wpd-stock-dot.out { background:#ef4444; box-shadow:0 0 6px #ef4444; }
            .wpd-stock-dot.unk { background:#334155; }
            #wpd-stock-text { font-size:12px; font-weight:600; flex:1; color:#cbd5e1; }
            .stock-in  #wpd-stock-text { color: #34d399; }
            .stock-out #wpd-stock-text { color: #f87171; }
            .wpd-price-chip {
                background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.25);
                color: #a5b4fc; font-size: 11px; font-weight: 700;
                padding: 2px 8px; border-radius: 20px; font-family: monospace;
            }
            .wpd-wl-badge {
                font-size: 9.5px; padding: 2px 7px; border-radius: 20px;
                font-weight: 700; flex-shrink: 0;
            }
            .wpd-wl-badge.on  { background: rgba(16,185,129,0.15); color:#34d399; border:1px solid rgba(16,185,129,0.25); }
            .wpd-wl-badge.off { background: rgba(239,68,68,0.1); color:#fca5a5; border:1px solid rgba(239,68,68,0.2); }

            /* ── Whitelist Button ── */
            #wpd-whitelist-btn {
                display: none; width: 100%; padding: 9px 12px; border-radius: 10px;
                border: 1px solid; font-weight: 600; font-size: 12px;
                cursor: pointer; transition: all 0.25s cubic-bezier(0.22,1,0.36,1);
                font-family: 'Inter', sans-serif; text-align: center;
                letter-spacing: 0.01em;
            }
            #wpd-whitelist-btn.add {
                background: rgba(16,185,129,0.08); color: #34d399;
                border-color: rgba(16,185,129,0.22);
            }
            #wpd-whitelist-btn.add:hover {
                background: rgba(16,185,129,0.16);
                box-shadow: 0 0 16px rgba(16,185,129,0.15);
                transform: translateY(-1px);
            }
            #wpd-whitelist-btn.remove {
                background: rgba(239,68,68,0.07); color: #fca5a5;
                border-color: rgba(239,68,68,0.2);
            }
            #wpd-whitelist-btn.remove:hover {
                background: rgba(239,68,68,0.14);
                box-shadow: 0 0 16px rgba(239,68,68,0.12);
                transform: translateY(-1px);
            }

            /* ── Success Banner ── */
            #wpd-success-banner {
                display:none; align-items:center; gap:10px; padding:10px 14px;
                background: linear-gradient(135deg, rgba(16,185,129,0.12), rgba(5,150,105,0.08));
                border: 1px solid rgba(16,185,129,0.25); border-radius: 12px;
                font-size:12px; font-weight:600; color:#34d399;
                opacity:0; transform: translateY(6px) scale(0.97);
                transition: all 0.4s cubic-bezier(0.22,1,0.36,1);
            }

            /* ── Divider ── */
            .wpd-divider {
                border: none;
                border-top: 1px solid rgba(255,255,255,0.06);
                margin: 0;
            }

            /* ── Collapsible Section Header ── */
            .wpd-section-header {
                display: flex; justify-content: space-between; align-items: center;
                cursor: pointer; padding: 8px 12px; border-radius: 10px;
                background: rgba(255,255,255,0.03);
                border: 1px solid rgba(255,255,255,0.05);
                font-size: 11.5px; font-weight: 600;
                color: #64748b; user-select: none;
                transition: background 0.15s, border-color 0.15s, color 0.15s;
            }
            .wpd-section-header:hover { background: rgba(255,255,255,0.06); color: #94a3b8; border-color: rgba(255,255,255,0.09); }
            .wpd-section-header-left { display:flex; align-items:center; gap:7px; }
            .wpd-section-icon { font-size:13px; }
            .wpd-count-chip {
                background: rgba(99,102,241,0.18); color: #818cf8;
                font-size: 9.5px; font-weight: 700; padding: 1px 7px;
                border-radius: 20px; min-width: 18px; text-align: center;
            }
            .wpd-chevron { font-size: 9px; transition: transform 0.25s; color: #475569; }
            .wpd-chevron.open { transform: rotate(180deg); color: #94a3b8; }

            /* ── AutoBuy List ── */
            .wpd-list-body {
                display: none; flex-direction: column; gap: 5px;
                max-height: 160px; overflow-y: auto; padding-right: 2px;
                margin-top: 4px;
            }
            .wpd-list-body::-webkit-scrollbar { width: 3px; }
            .wpd-list-body::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.3); border-radius: 3px; }
            .wpd-list-item {
                display:flex; align-items:center; gap:8px; padding:7px 10px; border-radius:9px;
                background: rgba(255,255,255,0.03);
                border: 1px solid rgba(255,255,255,0.05);
                transition: background 0.15s;
            }
            .wpd-list-item:hover { background: rgba(255,255,255,0.05); }
            .wpd-item-dot { width:6px; height:6px; border-radius:50%; background:#10b981; box-shadow:0 0 5px #10b981; flex-shrink:0; }
            .wpd-item-dot.inactive { background:#334155; box-shadow:none; }
            .wpd-item-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color: #94a3b8; }
            .wpd-item-remove {
                background:none; border:none; color:#334155; cursor:pointer; font-size:14px;
                line-height:1; padding:2px 4px; border-radius:5px; flex-shrink:0; transition:all 0.15s;
            }
            .wpd-item-remove:hover { color:#ef4444; background:rgba(239,68,68,0.12); }
            .wpd-list-empty { font-size:11px; color:#334155; text-align:center; padding:12px 0 6px; }
            .wpd-list-clear {
                align-self:flex-end; background: none;
                border: 1px solid rgba(239,68,68,0.18); color:#f87171;
                font-size:10px; padding:3px 10px; border-radius:6px;
                cursor:pointer; font-family:'Inter',sans-serif; transition:all 0.15s; font-weight:500;
            }
            .wpd-list-clear:hover { background:rgba(239,68,68,0.1); }

            /* ── Settings Panel ── */
            .wpd-settings { display:none; flex-direction:column; gap:8px; margin-top:4px; }
            .wpd-field-row {
                display: flex; justify-content: space-between; align-items: center;
                font-size: 11.5px; color: #64748b; font-weight: 500;
            }
            .wpd-field-label { display:flex; align-items:center; gap:6px; }
            .wpd-field-label-icon { font-size:12px; }
            .wpd-field-row input, .wpd-field-row select {
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.09);
                color: #e2e8f0;
                border-radius: 8px; padding: 5px 10px;
                font-family: 'Inter', sans-serif;
                font-size: 12px; outline: none;
                transition: border-color 0.2s, box-shadow 0.2s;
            }
            .wpd-field-row input { width: 88px; }
            .wpd-field-row select { cursor: pointer; }
            .wpd-field-row input:focus, .wpd-field-row select:focus {
                border-color: rgba(99,102,241,0.5);
                box-shadow: 0 0 0 3px rgba(99,102,241,0.1);
            }
            .wpd-full-field {
                display: flex; flex-direction: column; gap: 5px;
            }
            .wpd-full-field label {
                font-size: 10.5px; color: #475569; font-weight: 600;
                text-transform: uppercase; letter-spacing: 0.06em;
            }
            .wpd-full-field input {
                width: 100%; box-sizing: border-box;
                background: rgba(255,255,255,0.04);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 9px; padding: 7px 11px;
                color: #e2e8f0; font-family: 'Inter', sans-serif;
                font-size: 11.5px; outline: none;
                transition: border-color 0.2s, box-shadow 0.2s;
            }
            .wpd-full-field input:focus {
                border-color: rgba(99,102,241,0.45);
                box-shadow: 0 0 0 3px rgba(99,102,241,0.08);
            }
            .wpd-full-field input::placeholder { color: #334155; }

            /* ── Webhook Section Label ── */
            .wpd-section-label {
                display: flex; align-items: center; gap: 6px;
                font-size: 10px; font-weight: 700;
                color: #4f46e5; text-transform: uppercase; letter-spacing: 0.08em;
                padding: 4px 0 0;
            }
            .wpd-section-label::after {
                content: '';
                flex: 1; height: 1px;
                background: linear-gradient(90deg, rgba(99,102,241,0.3), transparent);
            }

            /* ── Buttons ── */
            .wpd-btn {
                padding: 9px 12px; border-radius: 10px; border: none;
                font-weight: 600; font-size: 12.5px; cursor: pointer;
                transition: all 0.25s cubic-bezier(0.22,1,0.36,1);
                font-family: 'Inter', sans-serif; width: 100%;
                letter-spacing: 0.01em;
            }
            .wpd-btn-off {
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.08);
                color: #475569;
            }
            .wpd-btn-off:hover { background: rgba(255,255,255,0.09); color: #64748b; }
            .wpd-btn-on {
                background: linear-gradient(135deg, #059669 0%, #10b981 100%);
                color: white;
                box-shadow: 0 4px 16px rgba(16,185,129,0.3), inset 0 1px 0 rgba(255,255,255,0.15);
                border: 1px solid rgba(16,185,129,0.4);
            }
            .wpd-btn-on:hover {
                box-shadow: 0 6px 24px rgba(16,185,129,0.45), inset 0 1px 0 rgba(255,255,255,0.15);
                transform: translateY(-1px);
            }

            /* ── Activity Log ── */
            #wpd-console-list {
                max-height: 230px; min-height: 100px; overflow-y: auto;
                background: #070c18;
                border: 1px solid rgba(255,255,255,0.06);
                border-radius: 10px; padding: 4px 0;
                margin-top: 4px;
            }
            #wpd-console-list::-webkit-scrollbar { width: 3px; }
            #wpd-console-list::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.3); border-radius: 3px; }

            /* ── Animations ── */
            @keyframes wpdDotPulse {
                0%, 100% { opacity: 0.7; transform: scale(0.85); }
                50%       { opacity: 1;   transform: scale(1.15); }
            }
            @keyframes wpdRingPulse {
                0%, 100% { transform: scale(1);    opacity: 0.25; }
                50%       { transform: scale(1.4);  opacity: 0; }
            }
            @keyframes wpdSlideIn {
                from { opacity: 0; transform: translateY(-6px); }
                to   { opacity: 1; transform: translateY(0); }
            }
        `;
        document.head.appendChild(style);

        const ui = document.createElement('div');
        ui.id = 'walmart-page-detector-ui';
        ui.innerHTML = `
            <!-- ── Header ── -->
            <div id="wpd-header">
                <div id="wpd-header-icon">🎯</div>
                <div id="wpd-header-text">
                    <div id="wpd-header-title">Walmart Sniper</div>
                    <div id="wpd-header-sub">Stock Monitor &amp; AutoBuy</div>
                </div>
                <span id="wpd-version-chip">v2.2</span>
                <button id="wpd-minimize-btn" title="Minimize">−</button>
            </div>

            <!-- ── Body ── -->
            <div id="wpd-body">

                <!-- Page Status -->
                <div id="wpd-page-card">
                    <div class="wpd-led-ring wpd-led-default" id="wpd-led">
                        <div class="wpd-led-dot"></div>
                    </div>
                    <span id="wpd-text">Detecting page...</span>
                    <span id="wpd-source"></span>
                </div>

                <!-- Stock Status -->
                <div id="wpd-stock-row">
                    <div class="wpd-stock-icon">📦</div>
                    <div class="wpd-stock-dot unk" id="wpd-stock-dot"></div>
                    <span id="wpd-stock-text">Checking stock...</span>
                    <span class="wpd-price-chip" id="wpd-price-badge" style="display:none;"></span>
                    <span class="wpd-wl-badge off" id="wpd-wl-badge">Not Listed</span>
                </div>

                <!-- Whitelist btn -->
                <button id="wpd-whitelist-btn" class="add">＋ Add to AutoBuy List</button>

                <!-- Success Banner -->
                <div id="wpd-success-banner">
                    <span style="font-size:20px;">🎉</span>
                    <div>
                        <div style="font-size:11px;color:#6ee7b7;font-weight:500;margin-bottom:1px;">Purchase Complete</div>
                        <div id="wpd-success-text" style="font-size:12px;">Purchased successfully!</div>
                    </div>
                </div>

                <!-- AutoBuy List Section -->
                <div id="wpd-list-section" style="display:none;flex-direction:column;gap:6px;">
                    <div class="wpd-section-header" id="wpd-list-toggle">
                        <div class="wpd-section-header-left">
                            <span class="wpd-section-icon">🛒</span>
                            <span>AutoBuy List</span>
                            <span class="wpd-count-chip" id="wpd-list-count">0</span>
                        </div>
                        <span class="wpd-chevron" id="wpd-list-chevron">&#9660;</span>
                    </div>
                    <div class="wpd-list-body" id="wpd-list-body"></div>
                </div>

                <!-- Settings Section -->
                <div id="wpd-settings-section" style="display:none;flex-direction:column;gap:6px;">
                    <div class="wpd-section-header" id="wpd-settings-toggle">
                        <div class="wpd-section-header-left">
                            <span class="wpd-section-icon">⚙️</span>
                            <span>Settings</span>
                        </div>
                        <span class="wpd-chevron" id="wpd-settings-chevron">&#9660;</span>
                    </div>
                    <div class="wpd-settings" id="wpd-settings">
                        <div class="wpd-field-row">
                            <span class="wpd-field-label"><span class="wpd-field-label-icon">💲</span>Max Price</span>
                            <input type="number" id="wpd-max-price" step="0.01" min="0">
                        </div>
                        <div class="wpd-field-row">
                            <span class="wpd-field-label"><span class="wpd-field-label-icon">🔢</span>Quantity</span>
                            <input type="number" id="wpd-quantity" min="1" max="99">
                        </div>
                        <div class="wpd-field-row">
                            <span class="wpd-field-label"><span class="wpd-field-label-icon">🔒</span>CVV</span>
                            <input type="password" id="wpd-cvv" maxlength="4" placeholder="•••">
                        </div>
                        <div class="wpd-field-row">
                            <span class="wpd-field-label"><span class="wpd-field-label-icon">⚡</span>Bot Speed</span>
                            <select id="wpd-speed-select">
                                <option value="0">⚡ Aggressive</option>
                                <option value="1" selected>🎯 Balanced</option>
                                <option value="2">🐢 Human</option>
                                <option value="3">🥷 Stealth</option>
                            </select>
                        </div>
                        <button id="wpd-auto-buy-btn" class="wpd-btn wpd-btn-off">Auto Buy: OFF</button>

                        <div class="wpd-section-label">🔔 Webhook Alerts</div>
                        <div class="wpd-full-field">
                            <label>Discord Webhook URL</label>
                            <input type="text" id="wpd-discord-webhook" placeholder="https://discord.com/api/webhooks/...">
                        </div>
                        <div class="wpd-full-field">
                            <label>Telegram Bot Token</label>
                            <input type="text" id="wpd-telegram-token" placeholder="123456789:ABC-xyz...">
                        </div>
                        <div class="wpd-full-field">
                            <label>Telegram Chat ID</label>
                            <input type="text" id="wpd-telegram-chatid" placeholder="-100xxxxxxxxxx">
                        </div>
                        <button id="wpd-test-webhook-btn" class="wpd-btn wpd-btn-off" style="font-size:11.5px;padding:7px;">🔔 Send Test Alert</button>
                    </div>
                </div>

                <!-- Activity Log Section -->
                <div id="wpd-console-section" style="display:flex;flex-direction:column;gap:6px;">
                    <div class="wpd-section-header" id="wpd-console-toggle">
                        <div class="wpd-section-header-left">
                            <span class="wpd-section-icon">📋</span>
                            <span>Activity Log</span>
                            <span class="wpd-count-chip" id="wpd-console-badge" style="display:none;background:rgba(239,68,68,0.25);color:#f87171;border:1px solid rgba(239,68,68,0.3);">0</span>
                        </div>
                        <span class="wpd-chevron" id="wpd-console-chevron">&#9654;</span>
                    </div>
                    <div id="wpd-console-body" style="display:none;flex-direction:column;gap:6px;">
                        <div style="display:flex;gap:6px;align-items:center;">
                            <button id="wpd-console-clear" type="button" class="wpd-btn wpd-btn-off" style="padding:4px 10px;font-size:11px;width:auto;">Clear</button>
                            <label style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#475569;cursor:pointer;user-select:none;">
                                <input type="checkbox" id="wpd-console-autoscroll" checked style="cursor:pointer;"> Auto-scroll
                            </label>
                            <span style="margin-left:auto;font-size:9.5px;color:#334155;">Last 250 lines</span>
                        </div>
                        <div id="wpd-console-list"></div>
                    </div>
                </div>

            </div><!-- /wpd-body -->
        `;
        document.body.appendChild(ui);
        setTimeout(() => ui.classList.add('wpd-visible'), 100);

        // ── Wire up elements ──
        const led = document.getElementById('wpd-led');
        const textEl = document.getElementById('wpd-text');
        const stockRow = document.getElementById('wpd-stock-row');
        const stockDot = document.getElementById('wpd-stock-dot');
        const stockText = document.getElementById('wpd-stock-text');
        const priceBadge = document.getElementById('wpd-price-badge');
        const wlBadge = document.getElementById('wpd-wl-badge');
        const sourceTag = document.getElementById('wpd-source');
        const settingDiv = document.getElementById('wpd-settings');
        const settingsSection = document.getElementById('wpd-settings-section');
        const maxPriceInput = document.getElementById('wpd-max-price');
        const qtyInput = document.getElementById('wpd-quantity');
        const cvvInput = document.getElementById('wpd-cvv');
        const autoBuyBtn = document.getElementById('wpd-auto-buy-btn');
        const wlBtn = document.getElementById('wpd-whitelist-btn');
        const listSection = document.getElementById('wpd-list-section');
        const listToggle = document.getElementById('wpd-list-toggle');
        const listBody = document.getElementById('wpd-list-body');
        const listCount = document.getElementById('wpd-list-count');
        const listChevron = document.getElementById('wpd-list-chevron');

        // ── Minimize button ──
        const minimizeBtn = document.getElementById('wpd-minimize-btn');
        let isMinimized = false;
        if (minimizeBtn) {
            minimizeBtn.addEventListener('click', () => {
                isMinimized = !isMinimized;
                ui.classList.toggle('wpd-minimized', isMinimized);
                minimizeBtn.textContent = isMinimized ? '+' : '\u2212';
                minimizeBtn.title = isMinimized ? 'Expand' : 'Minimize';
            });
        }

        // ── Settings section toggle ──
        const settingsToggle = document.getElementById('wpd-settings-toggle');
        const settingsChevron = document.getElementById('wpd-settings-chevron');
        let settingsOpen = false;
        if (settingsToggle) {
            settingsToggle.addEventListener('click', () => {
                settingsOpen = !settingsOpen;
                settingDiv.style.display = settingsOpen ? 'flex' : 'none';
                settingsChevron && settingsChevron.classList.toggle('open', settingsOpen);
            });
        }

        // ── Console elements ──
        const consoleSection = document.getElementById('wpd-console-section');
        const consoleToggle = document.getElementById('wpd-console-toggle');
        const consoleBody = document.getElementById('wpd-console-body');
        const consoleChevron = document.getElementById('wpd-console-chevron');
        const consoleClearBtn = document.getElementById('wpd-console-clear');
        const consoleAuto = document.getElementById('wpd-console-autoscroll');
        consolePanelEl = consoleSection;
        consoleListEl = document.getElementById('wpd-console-list');
        consoleBadgeEl = document.getElementById('wpd-console-badge');

        let consoleOpen = false;
        function setConsoleOpen(open) {
            consoleOpen = !!open;
            consoleBody.style.display = consoleOpen ? 'flex' : 'none';
            consoleChevron.innerHTML = consoleOpen ? '&#9660;' : '&#9654;';
            consoleChevron.classList.toggle('open', consoleOpen);
            if (consoleOpen) {
                consoleUnread = 0;
                if (consoleBadgeEl) { consoleBadgeEl.textContent = '0'; consoleBadgeEl.style.display = 'none'; }
            }
        }
        consoleToggle.addEventListener('click', () => { setConsoleOpen(!consoleOpen); if (consoleOpen) flushAllLogsToPanel(); });
        consoleClearBtn.addEventListener('click', clearConsolePanel);
        consoleAuto.addEventListener('change', e => {
            consoleAutoScroll = !!e.target.checked;
            if (consoleAutoScroll) {
                consoleUnread = 0;
                if (consoleBadgeEl) { consoleBadgeEl.textContent = '0'; consoleBadgeEl.style.display = 'none'; }
                if (consoleListEl) consoleListEl.scrollTop = consoleListEl.scrollHeight;
            }
        });
        if (consoleListEl) {
            consoleListEl.addEventListener('scroll', () => {
                if (!consoleListEl) return;
                const dist = consoleListEl.scrollHeight - consoleListEl.scrollTop - consoleListEl.clientHeight;
                if (dist < 8) {
                    consoleAutoScroll = true;
                    consoleAuto.checked = true;
                    consoleUnread = 0;
                    if (consoleBadgeEl) { consoleBadgeEl.textContent = '0'; consoleBadgeEl.style.display = 'none'; }
                } else if (consoleAutoScroll && dist > 20) {
                    consoleAutoScroll = false;
                    consoleAuto.checked = false;
                }
            });
        }
        uiLog('info', '[WPD] Bot v2.2 initialized. Console ready.');
        setTimeout(flushAllLogsToPanel, 50);

        maxPriceInput.value = maxPrice.toFixed(2);
        qtyInput.value = targetQuantity;
        cvvInput.value = targetCvv;

        maxPriceInput.addEventListener('input', e => { maxPrice = parseFloat(e.target.value) || 0; localStorage.setItem('wpd-max-price', maxPrice); });
        qtyInput.addEventListener('input', e => { targetQuantity = parseInt(e.target.value) || 1; localStorage.setItem('wpd-quantity', targetQuantity); });
        cvvInput.addEventListener('input', e => {
            targetCvv = e.target.value;
            localStorage.setItem('wpd-cvv', targetCvv);
            const f = findCvvField ? findCvvField() : document.getElementById('cvv-field');
            if (f) fillInputField(f, targetCvv);
        });

        // ── Speed Selector ──
        const speedSelect = document.getElementById('wpd-speed-select');
        if (speedSelect) {
            speedSelect.value = String(botSpeedLevel);
            speedSelect.addEventListener('change', e => {
                botSpeedLevel = parseInt(e.target.value) || 1;
                localStorage.setItem('wpd-speed-level', botSpeedLevel);
                console.log('[WPD] Bot speed set to: ' + getSpeed().label);
            });
        }

        // ── Webhook Inputs ──
        const discordInput = document.getElementById('wpd-discord-webhook');
        const telegramTokenInput = document.getElementById('wpd-telegram-token');
        const telegramChatInput = document.getElementById('wpd-telegram-chatid');
        const testWebhookBtn = document.getElementById('wpd-test-webhook-btn');

        if (discordInput) {
            discordInput.value = discordWebhook;
            discordInput.addEventListener('input', e => { discordWebhook = e.target.value.trim(); localStorage.setItem('wpd-discord-webhook', discordWebhook); });
        }
        if (telegramTokenInput) {
            telegramTokenInput.value = telegramBotToken;
            telegramTokenInput.addEventListener('input', e => { telegramBotToken = e.target.value.trim(); localStorage.setItem('wpd-telegram-token', telegramBotToken); });
        }
        if (telegramChatInput) {
            telegramChatInput.value = telegramChatId;
            telegramChatInput.addEventListener('input', e => { telegramChatId = e.target.value.trim(); localStorage.setItem('wpd-telegram-chatid', telegramChatId); });
        }
        if (testWebhookBtn) {
            testWebhookBtn.addEventListener('click', () => {
                const hasDiscord = !!discordWebhook;
                const hasTelegram = !!(telegramBotToken && telegramChatId);
                if (!hasDiscord && !hasTelegram) {
                    uiLog('warn', '[WPD] No webhook configured. Enter Discord URL or Telegram token+chatID first.');
                    return;
                }
                notifyRestockViaWebhook('Test Item (RTX 5090)', 799.99, null);
                uiLog('info', '[WPD] Test webhook fired!' + (hasDiscord ? ' Discord ✓' : '') + (hasTelegram ? ' Telegram ✓' : ''));
            });
        }

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

        // ── Whitelist button ──
        wlBtn.addEventListener('click', () => {
            if (isCurrentItemWhitelisted()) {
                removeItemFromWhitelist(currentItemId);
            } else {
                addCurrentItemToWhitelist();
            }
            syncWhitelistUI();
            renderWhitelistPanel();
        });

        // ── List panel toggle ──
        let listOpen = false;
        if (listToggle) {
            listToggle.addEventListener('click', () => {
                listOpen = !listOpen;
                listBody.style.display = listOpen ? 'flex' : 'none';
                listChevron.classList.toggle('open', listOpen);
            });
        }

        function renderWhitelistPanel() {
            const list = getWhitelist();
            listCount.innerText = list.length;
            listBody.innerHTML = '';

            if (list.length === 0) {
                listBody.innerHTML = '<div class="wpd-list-empty">No items added yet.<br>Browse a product &amp; click Add to AutoBuy List.</div>';
                return;
            }

            list.forEach(item => {
                const row = document.createElement('div');
                row.className = 'wpd-list-item';
                const isActive = item.id === currentItemId;
                row.innerHTML =
                    '<div class="wpd-item-dot' + (isActive ? '' : ' inactive') + '"></div>' +
                    '<span class="wpd-item-name" title="' + item.name + '">' + item.name + '</span>' +
                    '<button class="wpd-item-remove" data-id="' + item.id + '" title="Remove">&times;</button>';
                row.querySelector('.wpd-item-remove').addEventListener('click', function (e) {
                    e.stopPropagation();
                    removeItemFromWhitelist(this.dataset.id);
                    if (this.dataset.id === currentItemId) syncWhitelistUI();
                    renderWhitelistPanel();
                });
                listBody.appendChild(row);
            });

            const clearBtn = document.createElement('button');
            clearBtn.className = 'wpd-list-clear';
            clearBtn.innerText = 'Clear All';
            clearBtn.addEventListener('click', () => { clearWhitelist(); syncWhitelistUI(); renderWhitelistPanel(); });
            listBody.appendChild(clearBtn);
        }

        function syncWhitelistUI() {
            const onList = isCurrentItemWhitelisted();
            wlBtn.className = onList ? 'remove' : 'add';
            wlBtn.innerText = onList ? '\u2715 Remove from AutoBuy List' : '+ Add to AutoBuy List';
            wlBadge.className = 'wpd-wl-badge ' + (onList ? 'on' : 'off');
            wlBadge.innerText = onList ? '\u2713 Listed' : 'Not Listed';
        }

        // ── Expose update functions globally ──
        window._wpdUpdatePageUI = function (pageType, extra) {
            const configs = {
                home:     { label: 'Home Page',     cls: 'wpd-led-home' },
                search:   { label: 'Search Page',   cls: 'wpd-led-search' },
                product:  { label: 'Product Page',  cls: 'wpd-led-product' },
                checkout: { label: 'Checkout Page', cls: 'wpd-led-checkout' },
                other:    { label: 'Other Page',    cls: 'wpd-led-default' },
            };
            const cfg = configs[pageType] || configs.other;
            textEl.innerText = cfg.label;
            // Swap LED class on the ring wrapper
            led.className = 'wpd-led-ring ' + cfg.cls;

            const isProduct = pageType === 'product';
            const isCheckout = pageType === 'checkout';

            // Show/hide settings section
            if (settingsSection) settingsSection.style.display = (isProduct || isCheckout) ? 'flex' : 'none';
            stockRow.style.display = isProduct ? 'flex' : 'none';
            wlBtn.style.display = isProduct ? 'block' : 'none';
            listSection.style.display = (isProduct || isCheckout) ? 'flex' : 'none';

            if (isProduct) { syncWhitelistUI(); renderWhitelistPanel(); }

            if (extra && extra.query) {
                stockText.innerText = 'Query: ' + extra.query;
                stockRow.style.display = 'flex';
                stockDot.className = 'wpd-stock-dot unk';
                stockRow.className = '';  // reset color card
            }
        };

        window._wpdUpdateStockUI = function (status, price, source) {
            const isIn  = status === 'IN_STOCK';
            const isOut = status === 'OUT_OF_STOCK';
            stockDot.className = 'wpd-stock-dot ' + (isIn ? 'in' : isOut ? 'out' : 'unk');
            stockText.innerText = isIn ? '\u2714 IN STOCK' : (isOut ? 'Out of Stock' : 'Checking...');
            // Color the card background
            stockRow.className = isIn ? 'stock-in' : isOut ? 'stock-out' : '';
            stockRow.style.display = 'flex';
            if (price != null) { priceBadge.style.display = ''; priceBadge.innerText = '$' + price.toFixed(2); }
            if (sourceTag) sourceTag.innerText = source ? ('via ' + source) : '';
        };

        window._wpdSyncWhitelistUI = syncWhitelistUI;
        window._wpdRenderWhitelistPanel = renderWhitelistPanel;

        renderWhitelistPanel();
    }

    function updateStockUI() {
        if (window._wpdUpdateStockUI) window._wpdUpdateStockUI(stockStatus, currentPrice, '');
    }

    // ─── Page Router ──────────────────────────────────────────────────────────
    function checkPage() {
        const pathname = window.location.pathname;

        if (pathname === '/' || pathname === '/home') {
            currentItemId = null;
            if (window._wpdUpdatePageUI) window._wpdUpdatePageUI('home');
            stopStockPoll();
            if (stockObserver) stockObserver.disconnect();

        } else if (pathname.includes('/search')) {
            currentItemId = null;
            const q = new URLSearchParams(window.location.search).get('q');
            if (window._wpdUpdatePageUI) window._wpdUpdatePageUI('search', { query: q });
            stopStockPoll();

        } else if (pathname.includes('/ip/')) {
            const m = pathname.match(/\/ip\/[^/]+\/(\d+)/);
            currentItemId = m ? m[1] : null;

            if (window._wpdUpdatePageUI) window._wpdUpdatePageUI('product');
            stockStatus = 'UNKNOWN';
            currentPrice = null;
            autoBuyTriggered = false;

            startPriceBot();
            readNextData();
            installDomObserver();
            if (currentItemId) startStockPoll(currentItemId);

        } else if (pathname.includes('/checkout')) {
            if (window._wpdUpdatePageUI) window._wpdUpdatePageUI('checkout');
            stopStockPoll();
            if (autoBuyEnabled) startCheckoutBot();

        } else {
            currentItemId = null;
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
                if (!isNaN(price)) { currentPrice = price; updateStockUI(); }
            }
            if (window._wpdSyncWhitelistUI) window._wpdSyncWhitelistUI();
        }, 1500);
    }

    // ─── Buy Flow ─────────────────────────────────────────────────────────────
    function getTargetWin() {
        try { return (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window; } catch (e) { return window; }
    }

    function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

    function waitForHydrationIdle(minMs, maxMs) {
        minMs = minMs || 300;
        maxMs = maxMs || 5000;
        return new Promise(resolve => {
            const start = Date.now();
            function done() {
                const elapsed = Date.now() - start;
                const wait = Math.max(0, minMs - elapsed);
                setTimeout(resolve, wait);
            }
            try {
                const w = getTargetWin();
                if (document.readyState === 'complete' || document.readyState === 'interactive') {
                    let ricFired = false;
                    if (typeof w.requestIdleCallback === 'function') {
                        try {
                            w.requestIdleCallback(() => { ricFired = true; done(); }, { timeout: Math.max(800, maxMs - 300) });
                        } catch (e) { }
                    }
                    setTimeout(() => { if (!ricFired) done(); }, Math.max(900, maxMs - 200));
                } else {
                    w.addEventListener('load', done, { once: true, passive: true });
                    setTimeout(done, maxMs);
                }
            } catch (e) {
                setTimeout(done, minMs);
            }
        });
    }

    function findClickableInside(el) {
        if (!el) return null;
        try {
            const inners = el.querySelectorAll('div, span, a, [role="button"]');
            for (const inner of inners) {
                if (inner.onclick || inner.getAttribute('onclick')) return inner;
                const cls = (inner.getAttribute('class') || '').toLowerCase();
                if (cls && (cls.includes('dca') || cls.includes('action') || cls.includes('cta') || cls.includes('label'))) return inner;
            }
            const firstDiv = el.querySelector('div');
            return firstDiv || el;
        } catch (e) { return el || null; }
    }

    async function clickEl(el, opts) {
        if (!el) return;
        opts = opts || {};
        const w = getTargetWin();
        const doc = w.document;
        const rect = (el.getBoundingClientRect && el.getBoundingClientRect()) ? el.getBoundingClientRect() : { left: 0, top: 0, width: 100, height: 40 };
        const jitterX = Math.random() * Math.max(2, rect.width * 0.4) - Math.max(2, rect.width * 0.2);
        const jitterY = Math.random() * Math.max(2, rect.height * 0.4) - Math.max(2, rect.height * 0.2);
        const clientX = Math.round(rect.left + rect.width / 2 + jitterX);
        const clientY = Math.round(rect.top + rect.height / 2 + jitterY);
        const pageX = clientX + (doc.documentElement.scrollLeft || 0);
        const pageY = clientY + (doc.documentElement.scrollTop || 0);
        const btn = 0;
        const now = Date.now();

        try { el.focus({ preventScroll: true }); } catch (e) { }

        function makeMouse(type, extra) {
            try {
                const ev = new w.MouseEvent(type, Object.assign({
                    bubbles: true, cancelable: true, composed: true, view: w,
                    button: btn, buttons: type === 'mouseup' ? 0 : 1,
                    clientX, clientY, pageX, pageY, screenX: clientX + 120, screenY: clientY + 200,
                    relatedTarget: null, detail: 1, isTrusted: false,
                    pointerId: 1, pointerType: 'mouse', width: 1, height: 1, pressure: 0.5,
                    altKey: false, ctrlKey: false, shiftKey: false, metaKey: false,
                }, extra || {}));
                Object.defineProperty(ev, 'timeStamp', { value: performance.now() + (extra && extra._ts ? extra._ts : 0), configurable: true });
                Object.defineProperty(ev, 'isTrusted', { value: true, configurable: true, writable: true });
                return ev;
            } catch (e) { return null; }
        }

        function makePointer(type, extra) {
            try {
                const PE = (typeof w.PointerEvent !== 'undefined') ? w.PointerEvent : w.MouseEvent;
                const ev = new PE(type, Object.assign({
                    bubbles: true, cancelable: true, composed: true, view: w,
                    button: btn, buttons: type === 'pointerup' ? 0 : 1,
                    clientX, clientY, pageX, pageY,
                    pointerId: 1, pointerType: 'mouse', width: 1, height: 1,
                    pressure: type === 'pointerdown' || type === 'pointermove' ? 0.5 : 0,
                    isPrimary: true, tangentialPressure: 0, tiltX: 0, tiltY: 0, twist: 0,
                    altKey: false, ctrlKey: false, shiftKey: false, metaKey: false,
                }, extra || {}));
                Object.defineProperty(ev, 'isTrusted', { value: true, configurable: true, writable: true });
                return ev;
            } catch (e) { return null; }
        }

        const sp = getSpeed();
        const hover1 = makePointer('pointerover'); if (hover1) { try { el.dispatchEvent(hover1); } catch (e) { } }
        const hover2 = makeMouse('mouseenter'); if (hover2) { try { el.dispatchEvent(hover2); } catch (e) { } }
        await sleep(sp.hoverMin + Math.random() * (sp.hoverMax - sp.hoverMin));
        const move1 = makePointer('pointermove', { _ts: 5 }); if (move1) { try { el.dispatchEvent(move1); } catch (e) { } }
        const move2 = makeMouse('mousemove', { _ts: 8 }); if (move2) { try { el.dispatchEvent(move2); } catch (e) { } }
        await sleep(sp.moveMin + Math.random() * (sp.moveMax - sp.moveMin));

        const pd = makePointer('pointerdown'); if (pd) { try { el.dispatchEvent(pd); } catch (e) { } }
        const md = makeMouse('mousedown'); if (md) { try { el.dispatchEvent(md); } catch (e) { } }
        try { if (el.setPointerCapture) { try { el.setPointerCapture(1); } catch (e) { } } } catch (e) { }
        await sleep(sp.downMin + Math.random() * (sp.downMax - sp.downMin));

        const pu = makePointer('pointerup'); if (pu) { try { el.dispatchEvent(pu); } catch (e) { } }
        const mu = makeMouse('mouseup'); if (mu) { try { el.dispatchEvent(mu); } catch (e) { } }
        await sleep(sp.upMin + Math.random() * (sp.upMax - sp.upMin));
        const ck = makeMouse('click'); if (ck) { try { el.dispatchEvent(ck); } catch (e) { } }

        try {
            if (typeof HTMLElement !== 'undefined' && el instanceof HTMLElement && typeof el.click === 'function') {
                setTimeout(() => { try { el.click(); } catch (e) { } }, 12);
            }
        } catch (e) { }
    }

    function elSummary(el) {
        if (!el) return '<null>';
        try {
            const tag = (el.tagName || '?').toLowerCase();
            let attrs = '';
            ['data-testid', 'data-automation-id', 'data-dca-name', 'data-dca-intent', 'aria-label', 'id', 'name', 'class', 'type', 'role', 'disabled'].forEach(a => {
                const v = el.getAttribute && el.getAttribute(a);
                if (v != null && v !== '') attrs += ' ' + a + '="' + String(v).slice(0, 60) + '"';
            });
            const txt = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
            return '<' + tag + attrs + (txt ? '> text="' + txt + '"' : '>');
        } catch (e) { return String(el).slice(0, 120); }
    }

    function findQuantityIncButton() {
        const tests = [
            () => document.querySelector('[data-testid="quantity-stepper-inc-button"]:not([disabled]):not([aria-disabled="true"])'),
            () => document.querySelector('[data-testid="quantity-stepper-inc-button"]'),
            () => Array.from(document.querySelectorAll('button')).find(b => {
                const l = (b.getAttribute('aria-label') || '').toLowerCase();
                const t = (b.innerText || '').trim();
                return (l.includes('increase') || l.includes('increment') || t === '+' || t === '＋') && !b.disabled;
            }),
            () => {
                const stepper = document.querySelector('[data-testid*="quantity-stepper"]') || document.querySelector('[class*="quantity"] [class*="stepper"]');
                if (stepper) {
                    const btns = stepper.querySelectorAll('button');
                    if (btns.length >= 2) return btns[btns.length - 1];
                }
                return null;
            },
        ];
        for (const fn of tests) { try { const r = fn(); if (r) return r; } catch (e) { } }
        return null;
    }

    function readCurrentQuantity() {
        const tests = [
            () => {
                const l = document.querySelector('[data-testid="quantity-label"]');
                return l ? parseInt(l.innerText) : NaN;
            },
            () => {
                const i = document.querySelector('input[type="number"][name*="quantity"], input[type="number"][id*="quantity"]');
                if (i) return parseInt(i.value);
                return NaN;
            },
            () => {
                const stepper = document.querySelector('[data-testid*="quantity-stepper"]') || document.querySelector('[class*="quantity"]');
                if (stepper) {
                    const spans = stepper.querySelectorAll('span, div');
                    for (const s of spans) {
                        const n = parseInt(s.innerText);
                        if (!isNaN(n) && n >= 1 && n <= 99) return n;
                    }
                }
                return NaN;
            },
        ];
        for (const fn of tests) { try { const r = fn(); if (!isNaN(r)) return r; } catch (e) { } }
        return 1;
    }

    function findContinueCheckoutButton() {
        const tests = [
            () => Array.from(document.querySelectorAll('button')).find(b => {
                const t = (b.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
                return !!t.match(/^(continue|check out|checkout|confirm|add & continue|proceed to checkout|continue to checkout|continue to.*checkout|continue.*checkout|got it|next|review.*order|review and place|review order|submit|confirm order|place order|add to cart.*continue|add &amp; continue|continue with.*)$/)
                    || t.startsWith('continue')
                    || t.includes('checkout')
                    || t.includes('proceed')
                    || t === 'next'
                    || t.startsWith('review');
            }),
            () => Array.from(document.querySelectorAll('[role="button"], a')).find(b => {
                const t = (b.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
                return (t === 'continue' || t === 'check out' || t === 'checkout' || t.startsWith('continue') || t.includes('checkout') || t.includes('proceed'));
            }),
            () => document.querySelector('button[aria-label*="Continue"], button[aria-label*="Checkout"], button[aria-label*="Proceed"]'),
            () => Array.from(document.querySelectorAll('button')).find(b => b.id && (b.id.includes('checkout') || b.id.includes('continue') || b.id.includes('proceed') || b.id.includes('next'))),
            () => {
                const modal = document.querySelector('[role="dialog"], [class*="Modal"], [class*="modal"], [class*="Panel"], [class*="panel"], [class*="Overlay"], [class*="overlay"], [class*="Sheet"], [class*="sheet"], [id*="modal"], [id*="dialog"]');
                if (modal) {
                    const btns = Array.from(modal.querySelectorAll('button')).filter(b => !b.hidden && b.offsetWidth > 0 && b.offsetHeight > 0);
                    let best = null;
                    for (const b of btns) {
                        const t = (b.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                        const cls = (b.getAttribute('class') || '').toLowerCase();
                        if (t.includes('checkout') || t.includes('continue') || t.includes('proceed') || t.includes('confirm')) return b;
                        if (aria.includes('checkout') || aria.includes('continue') || aria.includes('proceed')) return b;
                        const hasText = (b.innerText || '').replace(/\s+/g, ' ').trim().length > 0;
                        const looksLikeClose = t.includes('cancel') || t.includes('close') || t.includes('skip') || t.includes('dismiss') || t === 'x' || t === '×'
                            || aria.includes('close') || aria.includes('dismiss') || aria.includes('cancel')
                            || cls.includes('close') || cls.includes('dismiss') || cls.includes('cancel');
                        if (hasText && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && !looksLikeClose) {
                            if (!best) best = b;
                            else {
                                const prevT = (best.innerText || '').replace(/\s+/g, ' ').trim().length;
                                const curT = (b.innerText || '').replace(/\s+/g, ' ').trim().length;
                                if (curT > prevT) best = b;
                            }
                        }
                    }
                    return best;
                }
                return null;
            },
        ];
        for (const fn of tests) { try { const r = fn(); if (r) return r; } catch (e) { } }
        return null;
    }

    function findEnterCvvButton() {
        const tests = [
            () => Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').toLowerCase().includes('enter your cvv')),
            () => Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').toLowerCase().includes('cvv')),
            () => document.querySelector('button[aria-label*="CVV"], button[aria-label*="cvv"]'),
        ];
        for (const fn of tests) { try { const r = fn(); if (r) return r; } catch (e) { } }
        return null;
    }

    function findPlaceOrderButton() {
        const tests = [
            () => document.querySelector('[data-testid="place-order-button"], [data-automation-id="place-order-button"]'),
            () => document.querySelector('button[aria-label*="Place order"], button[aria-label*="place order"]'),
            () => Array.from(document.querySelectorAll('button')).find(b => {
                const t = (b.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
                return (t === 'place order' || t.includes('place order') || t === 'submit order' || t.includes('complete purchase'));
            }),
        ];
        for (const fn of tests) { try { const r = fn(); if (r) return r; } catch (e) { } }
        return null;
    }

    function navigateToCheckout() {
        try {
            const w = getTargetWin();
            const target = 'https://www.walmart.com/checkout/';
            console.log('[WPD] Navigating directly to ' + target);
            w.location.href = target;
        } catch (e) {
            console.error('[WPD] navigateToCheckout failed:', e);
        }
    }

    function detectBuyProgress(startUrl, startPath, prev) {
        prev = prev || { qty: null, panel: null, buttons: null, url: startUrl };
        const nowUrl = window.location.href;
        const nowPath = window.location.pathname;
        const navigated = (nowUrl !== startUrl) && (nowPath.includes('/checkout') || nowPath.includes('/cart'));
        const qtyInc = !!findQuantityIncButton();
        const contBtn = !!findContinueCheckoutButton();
        const placeBtn = !!findPlaceOrderButton();
        const cvvBtn = !!findEnterCvvButton();
        const hasPanel = qtyInc || contBtn || placeBtn || cvvBtn;
        const changed = navigated
            || (prev.qty !== qtyInc)
            || (prev.panel !== hasPanel)
            || ((prev.buttons !== (contBtn || placeBtn || cvvBtn)) && (contBtn || placeBtn || cvvBtn));
        return {
            navigated, hasPanel, qtyInc, contBtn, placeBtn, cvvBtn,
            url: nowUrl, path: nowPath,
            prev: { qty: qtyInc, panel: hasPanel, buttons: contBtn || placeBtn || cvvBtn, url: nowUrl },
            changed
        };
    }

    async function clickWithRetries(targetBtn, label, startUrl, startPath, maxRetries, delayBetween) {
        maxRetries = (typeof maxRetries === 'number') ? maxRetries : 3;
        delayBetween = delayBetween || 900;
        let lastProgress = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            console.log('[WPD] clickWithRetries (' + label + ') attempt ' + attempt + '/' + maxRetries + ' → ' + elSummary(targetBtn));
            try {
                const inner = findClickableInside(targetBtn);
                if (attempt === 1 || attempt === 2) {
                    await clickEl(targetBtn);
                } else if (attempt === 3 && inner && inner !== targetBtn) {
                    console.log('[WPD] attempt 3: clicking INNER element → ' + elSummary(inner));
                    await clickEl(inner);
                    await sleep(250);
                    await clickEl(targetBtn);
                } else {
                    await clickEl(targetBtn);
                }
            } catch (e) {
                console.warn('[WPD] click exception:', e);
            }

            // Wait for a reaction
            const pollStart = Date.now();
            while (Date.now() - pollStart < delayBetween + 500) {
                await sleep(120);
                const prog = detectBuyProgress(startUrl, startPath, lastProgress);
                lastProgress = prog.prev;
                if (prog.navigated || prog.hasPanel) {
                    console.log('[WPD] click SUCCESS after attempt ' + attempt + ':', prog.navigated ? ('navigated to ' + prog.path) : ('panel appeared (qty=' + prog.qtyInc + ' cont=' + prog.contBtn + ')'));
                    return { ok: true, ...prog };
                }
            }
        }
        console.warn('[WPD] clickWithRetries (' + label + '): no reaction after ' + maxRetries + ' attempts.');
        return { ok: false };
    }

    async function triggerBuyFlowImpl() {
        autoBuyTriggered = true;
        const startUrl = window.location.href;
        const startPath = window.location.pathname;

        console.log('[WPD] triggerBuyFlow: waiting for hydration idle…');
        await waitForHydrationIdle(500, 4500);
        console.log('[WPD] hydration idle OK → starting click sequence.');

        // ── Try BUY NOW up to 3 times ──
        const buyBtn = findBuyNowButton();
        if (buyBtn) {
            console.log('[WPD] Found Buy Now button → ' + elSummary(buyBtn));
            const res = await clickWithRetries(buyBtn, 'Buy Now', startUrl, startPath, 3, 1200);
            if (res.ok) {
                waitForPanelOrNavigate();
                return;
            }
        } else {
            console.warn('[WPD] Buy Now button not found — skipping straight to Add to Cart.');
        }

        // ── Fallback 1: Add to Cart (click up to 3x) ──
        console.log('[WPD] Fallback: attempting Add to Cart…');
        const addBtn = findAddToCartButton();
        if (addBtn) {
            console.log('[WPD] Found Add to Cart button → ' + elSummary(addBtn));
            const res = await clickWithRetries(addBtn, 'Add to Cart', startUrl, startPath, 3, 1200);
            if (res.ok) {
                waitForPanelOrNavigate();
                return;
            }
        } else {
            console.warn('[WPD] Add to Cart button not found either.');
        }

        // ── Fallback 2: Direct nav to /cart then /checkout ──
        console.log('[WPD] Last-resort: if already in cart, navigate to /checkout directly.');
        const p = window.location.pathname;
        if (p.includes('/cart')) {
            navigateToCheckout();
            return;
        }

        console.warn('[WPD] triggerBuyFlow: click routes all failed. Consider providing HTML of panel that appears after manual Buy-Now click.');
        autoBuyTriggered = false;
    }

    function triggerBuyFlow() {
        triggerBuyFlowImpl().catch(e => {
            console.error('[WPD] triggerBuyFlow uncaught:', e);
            autoBuyTriggered = false;
        });
    }

    function waitForPanelOrNavigate() {
        let attempts = 0;
        const startedAt = Date.now();
        const startPath = window.location.pathname;
        const startUrl = window.location.href;

        const interval = setInterval(() => {
            attempts++;
            const elapsed = Date.now() - startedAt;
            const nowUrl = window.location.href;

            if (nowUrl !== startUrl) {
                console.log('[WPD] URL changed: ' + nowUrl + ' — page router will handle next steps.');
                clearInterval(interval);
                return;
            }

            const cur = readCurrentQuantity();
            const incBtn = findQuantityIncButton();
            if (attempts % 5 === 1) {
                console.log('[WPD] waitForPanelOrNavigate qty-check: cur=' + cur + ' target=' + targetQuantity + ' incBtn=' + !!incBtn + ' @ ' + Math.round(elapsed) + 'ms');
            }

            if (cur >= targetQuantity || findContinueCheckoutButton() || findPlaceOrderButton() || findEnterCvvButton()) {
                if (cur < targetQuantity && incBtn) {
                    const extra = targetQuantity - cur;
                    console.log('[WPD] Panel appeared but need +' + extra + ' more qty.');
                }
                clearInterval(interval);
                setTimeout(() => waitForPanelAndSetQuantity(), 300);
                return;
            }

            if (elapsed > 15000) {
                console.warn('[WPD] waitForPanelOrNavigate: timed out (no panel/nav in 15s). Attempting qty-check anyway.');
                clearInterval(interval);
                waitForPanelAndSetQuantity();
            }
        }, 200);
    }

    function waitForPanelAndSetQuantity() {
        let attempts = 0;
        const startedAt = Date.now();
        const startPath = window.location.pathname;
        const startUrl = window.location.href;
        let clicking = false;

        const interval = setInterval(async () => {
            attempts++;
            const elapsed = Date.now() - startedAt;
            if (window.location.href !== startUrl && (window.location.pathname.includes('/checkout') || window.location.pathname.includes('/cart'))) {
                console.log('[WPD] URL changed to ' + window.location.pathname + ' while setting qty — stopping.');
                clearInterval(interval);
                return;
            }

            const cur = readCurrentQuantity();
            const incBtn = findQuantityIncButton();
            if (attempts % 3 === 1) {
                console.log('[WPD] quantity check: cur=' + cur + ' target=' + targetQuantity + ' incBtn=' + !!incBtn + ' @ ' + Math.round(elapsed) + 'ms');
            }

            if (cur >= targetQuantity) {
                clearInterval(interval);
                proceedToCheckoutOrPlaceOrder();
                return;
            }

            if (incBtn && !clicking) {
                if (!incBtn.disabled && incBtn.getAttribute('aria-disabled') !== 'true') {
                    clicking = true;
                    await clickEl(incBtn);
                    clicking = false;
                } else {
                    console.warn('[WPD] quantity inc button is disabled; proceeding anyway.');
                    clearInterval(interval);
                    proceedToCheckoutOrPlaceOrder();
                    return;
                }
            } else {
                const cont = findContinueCheckoutButton();
                if (cont) {
                    console.log('[WPD] No incButton; Continue button exists → ' + elSummary(cont));
                    clearInterval(interval);
                    proceedToCheckoutOrPlaceOrder();
                    return;
                }
            }

            if (elapsed > 25000) {
                console.warn('[WPD] waitForPanelAndSetQuantity: timed out after 25s.');
                clearInterval(interval);
                proceedToCheckoutOrPlaceOrder();
            }
        }, 400);
    }

    function proceedToCheckoutOrPlaceOrder() {
        let attempts = 0;
        const startedAt = Date.now();
        const startPath = window.location.pathname;
        let clicking = false;
        console.log('[WPD] proceedToCheckoutOrPlaceOrder: starting post-quantity poll (path=' + startPath + ')');

        const interval = setInterval(async () => {
            attempts++;
            const elapsed = Date.now() - startedAt;
            const nowPath = window.location.pathname;

            if (nowPath !== startPath && (nowPath.includes('/checkout') || nowPath.includes('/cart'))) {
                console.log('[WPD] Page navigated to ' + nowPath + ' — page router will start checkout bot.');
                clearInterval(interval);
                return;
            }

            const cvvBtn = findEnterCvvButton();
            if (cvvBtn && !clicking) {
                console.log('[WPD] Clicking CVV prompt → ' + elSummary(cvvBtn));
                clicking = true;
                await clickEl(cvvBtn);
                clicking = false;
            } else {
                const placeBtn = findPlaceOrderButton();
                if (placeBtn && !clicking) {
                    console.log('[WPD] Clicking Place Order (inline) → ' + elSummary(placeBtn));
                    clicking = true;
                    await clickEl(placeBtn);
                    clicking = false;
                    clearInterval(interval);
                    return;
                }
                const cont = findContinueCheckoutButton();
                if (cont && !clicking) {
                    console.log('[WPD] Clicking Continue/Checkout → ' + elSummary(cont));
                    clicking = true;
                    await clickEl(cont);
                    clicking = false;
                    clearInterval(interval);
                    return;
                }
            }

            if (elapsed > 15000) {
                console.warn('[WPD] proceedToCheckoutOrPlaceOrder: timed out after 15s with no button found.');
                clearInterval(interval);
            }
        }, 250);
    }

    function findCvvField() {
        const tests = [
            () => document.getElementById('cvv-field'),
            () => document.querySelector('input[name="cvv"]:not(#wpd-cvv), input[name="CVV"]:not(#wpd-cvv), input[name="Cvv"]:not(#wpd-cvv)'),
            () => document.querySelector('input[id*="cvv" i]:not(#wpd-cvv)'),
            () => document.querySelector('input[autocomplete="cc-csc"], input[autocomplete="cc-cvc"], input[inputmode="numeric"][type="password"]:not(#wpd-cvv)'),
            () => Array.from(document.querySelectorAll('input[type="password"], input[type="text"], input[inputmode="numeric"]')).find(i => {
                if (i.id === 'wpd-cvv') return false;
                const ml = parseInt(i.getAttribute('maxlength') || '0', 10);
                if (ml && (ml === 3 || ml === 4)) {
                    const p = (i.placeholder || '').toLowerCase();
                    const l = (i.getAttribute('aria-label') || '').toLowerCase();
                    const n = (i.name || '').toLowerCase();
                    const id = (i.id || '').toLowerCase();
                    const describedBy = i.getAttribute('aria-describedby') || '';
                    const isCard = /cvv|csc|cvc|security|card.?code|3 digits|4 digits/i.test(p) ||
                        /cvv|csc|security/i.test(l) || n.includes('cvv') ||
                        id.includes('cvv') || /cvv|csc/i.test(describedBy);
                    if (isCard) return true;
                    if (i.type === 'password' && (ml === 3 || ml === 4)) return true;
                }
                return false;
            }),
            () => Array.from(document.querySelectorAll('input')).find(i => {
                if (i.id === 'wpd-cvv') return false;
                const p = (i.placeholder || '').toLowerCase();
                const l = (i.getAttribute('aria-label') || '').toLowerCase();
                const n = (i.name || '').toLowerCase();
                const id = (i.id || '').toLowerCase();
                return /cvv|csc|cvc|security|card.?code|3 digits/i.test(p + ' ' + l) || n.includes('cvv') || id.includes('cvv');
            }),
        ];
        for (const fn of tests) { try { const r = fn(); if (r && r.id !== 'wpd-cvv') return r; } catch (e) { } }
        return null;
    }

    function fillInputField(field, value) {
        if (!field) {
            uiLog('warn', '[WPD-CVV] fillInputField called but field is null or undefined.');
            return false;
        }
        const w = getTargetWin();
        let didSomething = false;
        const logLines = [];
        uiLog('info', '[WPD-CVV] Starting CVV injection into field (' + (field.id || 'no-id') + '), Target Value Length: ' + (value || '').length);
        
        try {
            try { 
                if (field.focus) {
                    field.focus({ preventScroll: true }); 
                    uiLog('info', '[WPD-CVV] Field focused natively.');
                }
            } catch (e) { 
                uiLog('warn', '[WPD-CVV] Failed to focus field: ' + e.message); 
            }

            // 1. Native React 16+ setter
            let setNative = false;
            try {
                const nativeSetter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set;
                if (nativeSetter) {
                    nativeSetter.call(field, value);
                    setNative = true;
                    logLines.push('native-setter=ok');
                    uiLog('info', '[WPD-CVV] Successfully set value using targetWin HTMLInputElement prototype setter.');
                }
            } catch (e) { 
                uiLog('warn', '[WPD-CVV] TargetWin native setter failed: ' + e.message); 
            }

            if (!setNative) {
                try {
                    const nativeSetter2 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    if (nativeSetter2) {
                        nativeSetter2.call(field, value);
                        setNative = true;
                        logLines.push('native-setter2=ok');
                        uiLog('info', '[WPD-CVV] Successfully set value using local window HTMLInputElement prototype setter.');
                    }
                } catch(e) { 
                    uiLog('warn', '[WPD-CVV] Local window native setter failed: ' + e.message); 
                }
            }

            if (!setNative) {
                try { 
                    field.value = value; 
                    logLines.push('direct=ok'); 
                    uiLog('info', '[WPD-CVV] Successfully set value using direct field.value assignment.');
                } catch(e) { 
                    uiLog('warn', '[WPD-CVV] Direct assignment failed: ' + e.message); 
                }
            }

            // 2. Dispatch events
            try {
                field.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                uiLog('info', '[WPD-CVV] Dispatched "input" event.');
                
                field.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
                uiLog('info', '[WPD-CVV] Dispatched "change" event.');
                
                field.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
                uiLog('info', '[WPD-CVV] Dispatched "keyup" (Enter) event.');
            } catch(e) { 
                uiLog('warn', '[WPD-CVV] Event dispatch failed: ' + e.message); 
            }

            // 3. Fallback: execCommand (simulates pasting)
            try {
                field.focus();
                field.select(); // Try to select existing text to overwrite
                const execResult = document.execCommand('insertText', false, String(value));
                if (execResult) {
                    logLines.push('execCommand=ok');
                    uiLog('info', '[WPD-CVV] Successfully used document.execCommand to insert text.');
                } else {
                    uiLog('warn', '[WPD-CVV] document.execCommand returned false (may be blocked by browser).');
                }
            } catch(e) { 
                uiLog('warn', '[WPD-CVV] document.execCommand failed: ' + e.message); 
            }

            try { 
                if (field.blur) {
                    field.blur(); 
                    uiLog('info', '[WPD-CVV] Field blurred.');
                }
            } catch (e) { }
            
            // 4. Force report validity
            try { 
                if (typeof field.reportValidity === 'function') {
                    field.reportValidity(); 
                    uiLog('info', '[WPD-CVV] Called reportValidity() on field.');
                }
            } catch (e) { }
            
            didSomething = true;
        } catch (e) {
            logLines.push('fatal:' + String(e));
            uiLog('warn', '[WPD-CVV] Fatal error during injection: ' + e.message);
        }
        uiLog('info', '[WPD-CVV] fillInputField Summary: ' + logLines.join(' | ') + ' | final value="' + (field ? (field.value || '') : '') + '"');
        return didSomething;
    }

    function startCheckoutBot() {
        let purchased = false;
        let cvvField = null;
        let clicking = false;
        let filling = false;
        let logOnceCvv = false;
        const interval = setInterval(async () => {
            if (!autoBuyEnabled || !window.location.pathname.includes('/checkout')) {
                clearInterval(interval);
                return;
            }
            if (!cvvField) {
                cvvField = findCvvField();
                if (cvvField && !logOnceCvv) {
                    const hasCvvLen = targetCvv ? (String(targetCvv).length + '-digits)') : 'NOT SET)';
                    console.log('[WPD] Checkout CVV field located → ' + elSummary(cvvField) + ' | hasCVV(' + hasCvvLen);
                    logOnceCvv = true;
                }
            }
            if (cvvField) {
                const needsFill = (targetCvv && cvvField.value !== targetCvv);
                if (needsFill && !filling) {
                    filling = true;
                    fillInputField(cvvField, targetCvv);
                    setTimeout(() => {
                        try {
                            if (cvvField && cvvField.value !== targetCvv) {
                                console.log('[WPD] CVV still missing on recheck → retrying fill');
                                fillInputField(cvvField, targetCvv);
                            }
                        } catch (e) { }
                        filling = false;
                    }, 600);
                }
                const placeBtn = findPlaceOrderButton();
                if (placeBtn && !placeBtn.disabled && placeBtn.getAttribute('aria-disabled') !== 'true' && !purchased && !clicking) {
                    purchased = true;
                    clicking = true;
                    console.log('[WPD] Final Place Order clicked! → ' + elSummary(placeBtn));
                    await clickEl(placeBtn);
                    clicking = false;
                    clearInterval(interval);
                    const wlItem = getWhitelist().find(i => i.id === currentItemId);
                    const itemName = wlItem ? wlItem.name : (currentItemId ? ('Item #' + currentItemId) : 'Item');
                    notifyPurchase(itemName, currentPrice);
                }
            } else {
                const placeBtn = findPlaceOrderButton();
                if (placeBtn && !placeBtn.disabled && placeBtn.getAttribute('aria-disabled') !== 'true' && !purchased && !clicking) {
                    purchased = true;
                    clicking = true;
                    console.log('[WPD] Final Place Order clicked (no CVV field needed)! → ' + elSummary(placeBtn));
                    await clickEl(placeBtn);
                    clicking = false;
                    clearInterval(interval);
                    const wlItem = getWhitelist().find(i => i.id === currentItemId);
                    const itemName = wlItem ? wlItem.name : (currentItemId ? ('Item #' + currentItemId) : 'Item');
                    notifyPurchase(itemName, currentPrice);
                }
            }
        }, 120);
    }

    // ─── Bootstrap ────────────────────────────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { initUI(); checkPage(); });
    } else {
        initUI();
        checkPage();
    }

    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) { lastUrl = url; checkPage(); }
    }).observe(document.documentElement, { subtree: true, childList: true });

})();
