/*!
 * network-status.js
 * Dependency-free global online/offline banner.
 *
 * Drop-in usage:
 *   <script src="assets/js/network-status.js" defer></script>
 *
 * Consumers can listen for:
 *   document.addEventListener('network-status', (event) => {
 *       const online = event.detail.online;
 *   });
 */
(function () {
    'use strict';

    // The shared shell and individual entry pages can both load this file.
    // Keep one controller and one banner per document.
    if (window.__networkStatusController) return;

    const PING_INTERVAL = 10000;
    const PING_TIMEOUT = 5000;
    const HIDE_AFTER = 3000;
    const STYLE_ID = 'network-status-styles';
    const BANNER_ID = 'net-status';

    let bar = null;
    let hideTimer = null;
    let pingTimer = null;
    let pingController = null;
    let checking = false;
    let hasResolved = false;
    let isOnline = navigator.onLine !== false;

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${BANNER_ID} {
                position: fixed;
                top: 0;
                right: 0;
                left: 0;
                z-index: 99999;
                display: block;
                box-sizing: border-box;
                min-height: 3.25rem;
                padding: .86rem 1rem;
                padding-top: max(.86rem, env(safe-area-inset-top));
                text-align: center;
                font: 600 .82rem/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
                letter-spacing: .005em;
                text-wrap: balance;
                color: #344054;
                background: #f7f9fb;
                border-bottom: 1px solid #dfe5eb;
                box-shadow: 0 3px 12px rgba(31, 41, 55, .08);
                -webkit-backdrop-filter: blur(10px);
                backdrop-filter: blur(10px);
                transform: translateY(-100%);
                transition: transform .3s ease, background-color .3s ease;
                pointer-events: none;
            }

            #${BANNER_ID}.show,
            #${BANNER_ID}.is-visible {
                transform: translateY(0);
            }

            #${BANNER_ID}.offline,
            #${BANNER_ID}[data-state="offline"] {
                color: #8f3b34;
                background: #fff4f2;
                border-bottom-color: #e8c9c4;
                box-shadow: 0 3px 12px rgba(143, 59, 52, .11);
            }

            #${BANNER_ID}.online,
            #${BANNER_ID}[data-state="online"] {
                color: #34704a;
                background: #f0f8f1;
                border-bottom-color: #cbe2d0;
                box-shadow: 0 3px 12px rgba(52, 112, 74, .10);
            }

            @media (max-width: 480px) {
                #${BANNER_ID} {
                    min-height: 2.9rem;
                    padding-top: max(.72rem, env(safe-area-inset-top));
                    padding-bottom: .72rem;
                    padding-right: .75rem;
                    padding-left: .75rem;
                    font-size: .76rem;
                }
            }

            @media (prefers-reduced-motion: reduce) {
                #${BANNER_ID} {
                    transition: none;
                }
            }
        `;
        document.head.appendChild(style);
    }

    function ensureBanner() {
        injectStyles();

        bar = document.getElementById(BANNER_ID);
        if (!bar) {
            bar = document.createElement('div');
            bar.id = BANNER_ID;
            bar.setAttribute('role', 'status');
            bar.setAttribute('aria-live', 'polite');
            bar.setAttribute('aria-atomic', 'true');
            bar.setAttribute('aria-hidden', 'true');
            document.body.appendChild(bar);
        }
        return bar;
    }

    function hide() {
        if (!bar) return;
        bar.classList.remove('is-visible');
        bar.classList.remove('show');
        bar.setAttribute('aria-hidden', 'true');
    }

    function show(state, text, autoHide) {
        ensureBanner();
        clearTimeout(hideTimer);
        bar.classList.remove('offline', 'online');
        bar.classList.add(state, 'show');
        bar.dataset.state = state;
        bar.textContent = text;
        bar.classList.add('is-visible');
        bar.setAttribute('aria-hidden', 'false');

        if (autoHide) {
            hideTimer = window.setTimeout(hide, HIDE_AFTER);
        }
    }

    function publish(online, source) {
        const changed = !hasResolved || online !== isOnline;
        const wasOnline = isOnline;
        isOnline = Boolean(online);
        hasResolved = true;

        if (!isOnline) {
            show('offline', 'No internet connection. Some features may not work.', false);
        } else if (changed && wasOnline === false) {
            show('online', 'Back online. Connection restored.', true);
        }

        if (changed) {
            document.dispatchEvent(new CustomEvent('network-status', {
                detail: {
                    online: isOnline,
                    source: source || 'unknown'
                }
            }));
        }
    }

    async function check(source) {
        if (checking || (document.hidden && source !== 'initial')) return;

        if (navigator.onLine === false) {
            publish(false, source || 'browser');
            return;
        }

        checking = true;
        pingController = new AbortController();
        const timeout = window.setTimeout(() => pingController.abort(), PING_TIMEOUT);

        try {
            // A same-origin HEAD response is enough to prove that the server
            // can be reached. The cache-busting query avoids stale proxies.
            const pingUrl = new URL(window.location.href);
            // Do not replay page query parameters: reset/recovery links can
            // contain one-time secrets that must never be sent repeatedly.
            pingUrl.search = '';
            pingUrl.searchParams.set('_network_ping', String(Date.now()));
            pingUrl.hash = '';

            await fetch(pingUrl.href, {
                method: 'HEAD',
                cache: 'no-store',
                credentials: 'same-origin',
                headers: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                },
                signal: pingController.signal
            });

            // Any HTTP response, including an application error response,
            // means the network/server path is reachable.
            publish(true, source || 'ping');
        } catch (_) {
            publish(false, source || 'ping');
        } finally {
            window.clearTimeout(timeout);
            pingController = null;
            checking = false;
        }
    }

    function start() {
        if (window.__networkStatusController) return;
        window.__networkStatusController = {
            check: function () { return check('manual'); },
            get online() { return isOnline; }
        };

        ensureBanner();
        if (!isOnline) {
            show('offline', 'No internet connection. Some features may not work.', false);
        }

        window.addEventListener('online', function () {
            check('browser-online');
        });
        window.addEventListener('offline', function () {
            publish(false, 'browser-offline');
        });
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) check('visibility');
        });

        const startPingTimer = function () {
            if (pingTimer !== null) return;
            pingTimer = window.setInterval(function () {
                check('interval');
            }, PING_INTERVAL);
        };

        startPingTimer();

        window.addEventListener('pagehide', function (event) {
            // A persisted page is entering the back-forward cache. Keep the
            // controller alive and restart its interval on pageshow.
            if (event.persisted) return;
            window.clearInterval(pingTimer);
            pingTimer = null;
            clearTimeout(hideTimer);
            if (pingController) pingController.abort();
        });
        window.addEventListener('pageshow', function (event) {
            if (!event.persisted) return;
            startPingTimer();
            check('pageshow');
        });

        // Resolve the initial state without flashing an unnecessary green bar.
        check('initial');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
