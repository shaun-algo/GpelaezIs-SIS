/* Account operations need PHP and same-origin session cookies. */
(() => {
    const current = new URL(window.location.href);
    const port = Number(current.port);
    const preview = current.protocol === 'file:' || (port >= 5500 && port <= 5599);
    if (!preview) return;

    // Set PORTAL_PHP_BASE_URL before this script for a different PHP port or app folder.
    // Never take this destination from query parameters: reset links contain secrets.
    const base = new URL(window.PORTAL_PHP_BASE_URL || 'http://localhost/deped_capstone2/');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return;
    base.pathname = base.pathname.replace(/\/?$/, '/');
    base.search = '';
    base.hash = '';
    const page = current.pathname.split('/').pop() || 'index.html';
    const target = new URL(page, base);
    target.search = current.search;
    target.hash = current.hash;
    if (target.href !== current.href) window.location.replace(target.href);
})();
