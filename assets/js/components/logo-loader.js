/* ============================================
   Logo Loader Component - Reusable Loading Screen
   ============================================ */

(function (window, document) {
    'use strict';

    const LOADER_ID = 'logoLoader';
    const LOADER_ACTIVE_CLASS = 'logo-loader-active';
    // Keep the loading state visible long enough to be perceptible, but never
    // replace the real page-load signal with a fixed timeout.
    const MINIMUM_DISPLAY_MS = 500;
    const componentScript = document.currentScript;
    const defaultLogoUrl = componentScript && componentScript.src
        ? new URL('../../img/logo/logo.png', componentScript.src).href
        : 'assets/img/logo/logo.png';
    let loadListenerAttached = false;
    let pageLoadComplete = false;
    let loaderStartedAt = 0;
    let minimumDisplayTimer = null;

    function now() {
        return window.performance && typeof window.performance.now === 'function'
            ? window.performance.now()
            : Date.now();
    }

    function createLoader() {
        let loader = document.getElementById(LOADER_ID);

        if (!loader) {
            loader = document.createElement('div');
            loader.id = LOADER_ID;
            loader.className = 'logo-loader';
            loader.setAttribute('role', 'status');
            loader.setAttribute('aria-live', 'polite');
            loader.setAttribute('aria-label', 'Loading page');
            loader.innerHTML = `
                <div class="logo-loader-content">
                    <img src="${defaultLogoUrl}" alt="" class="logo-loader-image">
                    <span class="logo-loader-label">Loading</span>
                </div>
            `;

            // The script is loaded in the head, so place the overlay immediately
            // even when the body has not been parsed yet.
            document.documentElement.appendChild(loader);
        }

        loader.classList.remove('loaded');
        loader.setAttribute('aria-hidden', 'false');
        document.documentElement.classList.add(LOADER_ACTIVE_CLASS);
        return loader;
    }

    function hideLogoLoader() {
        const loader = document.getElementById(LOADER_ID);
        if (!loader) return;

        if (minimumDisplayTimer !== null) {
            window.clearTimeout(minimumDisplayTimer);
            minimumDisplayTimer = null;
        }
        loader.classList.add('loaded');
        loader.setAttribute('aria-hidden', 'true');
        document.documentElement.classList.remove(LOADER_ACTIVE_CLASS);
        loaderStartedAt = 0;
    }

    function showLogoLoader() {
        if (minimumDisplayTimer !== null) {
            window.clearTimeout(minimumDisplayTimer);
            minimumDisplayTimer = null;
        }
        loaderStartedAt = now();
        createLoader();
    }

    function hideWhenReady() {
        if (!pageLoadComplete || loaderStartedAt === 0) return;

        const remaining = MINIMUM_DISPLAY_MS - (now() - loaderStartedAt);
        if (remaining > 0) {
            minimumDisplayTimer = window.setTimeout(hideWhenReady, remaining);
            return;
        }

        hideLogoLoader();
    }

    function waitForPageLoad() {
        if (document.readyState === 'complete') {
            pageLoadComplete = true;
            hideWhenReady();
            return;
        }

        if (loadListenerAttached) return;
        loadListenerAttached = true;

        // The overlay stays up until the browser has finished loading the
        // document and its dependent resources.
        window.addEventListener('load', () => {
            pageLoadComplete = true;
            hideWhenReady();
        }, { once: true });
    }

    function initLogoLoader() {
        loaderStartedAt = now();
        createLoader();
        waitForPageLoad();
    }

    window.initLogoLoader = initLogoLoader;
    window.hideLogoLoader = hideLogoLoader;
    window.showLogoLoader = showLogoLoader;

    initLogoLoader();
}(window, document));
