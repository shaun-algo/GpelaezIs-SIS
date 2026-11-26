// Shared archive view, loaded only by Masterfiles pages.
(() => {
    'use strict';
    const script = document.currentScript;
    const requested = (script.dataset.modules || '').split(',');
    const root = new URL('../../', script.src);
    const endpoint = new URL('api/archive/archive.php', root);
    if (!document.querySelector('link[data-masterfile-premium]')) {
        const premium = document.createElement('link');
        premium.rel = 'stylesheet';
        premium.dataset.masterfilePremium = 'true';
        premium.href = new URL('assets/css/masterfiles-premium.css?v=20260929-mobile-density-v1', root).href;
        document.head.append(premium);
    }
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('assets/css/masterfile-archive.css?v=20261005-users-position-restore-v1', root).href;
    document.head.append(css);
    const state = { modules: {}, module: '', page: 1, pages: 1, csrf: '', sequence: 0, restored: false, busy: false };

    // Shared context menu for custom masterfile tables (Sections and Curriculum),
    // which do not use the generic controller.
    if (typeof window.mfOpenContextMenu !== 'function') {
        window.mfOpenContextMenu = (event, row) => {
            if (!row) return;
            document.getElementById('mfContextMenu')?.remove();
            document.body.classList.remove('mf-mobile-sheet-open');
            const sources = [...row.querySelectorAll('.mf-row-action-source button, .mf-actions-cell button, .mf-mobile-actions button')];
            if (!sources.length) return;
            const menu = document.createElement('div');
            menu.id = 'mfContextMenu';
            menu.className = 'mf-context-menu';
            menu.setAttribute('role', 'menu');
            sources.forEach(source => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'mf-context-menu-item';
                item.setAttribute('role', 'menuitem');
                const actionKey = String(source.dataset.action || '').toLowerCase();
                const label = source.getAttribute('aria-label') || source.title || ({ view: 'View', edit: 'Edit', delete: 'Archive' }[actionKey] || source.dataset.action || 'Action');
                const icon = document.createElement('i');
                icon.className = `fas ${{ view: 'fa-eye', edit: 'fa-pen', add: 'fa-plus', copy: 'fa-copy', toggle: 'fa-lock', automatic: 'fa-calendar-check', delete: 'fa-box-archive', 'remove-subject-item': 'fa-minus' }[actionKey] || 'fa-arrow-right'}`;
                icon.setAttribute('aria-hidden', 'true');
                const text = document.createElement('span');
                text.textContent = label;
                item.append(icon, text);
                item.addEventListener('click', () => { menu.remove(); document.body.classList.remove('mf-mobile-sheet-open'); source.click(); });
                menu.append(item);
            });
            document.body.append(menu);
            if (window.matchMedia?.('(max-width: 768px)').matches) {
                document.body.classList.add('mf-mobile-sheet-open');
            }
            const margin = 8;
            menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - margin))}px`;
            menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - margin))}px`;
            const close = closeEvent => {
                if (closeEvent.type === 'keydown' && closeEvent.key !== 'Escape') return;
                if (!menu.contains(closeEvent.target) || closeEvent.key === 'Escape') {
                    menu.remove();
                    document.body.classList.remove('mf-mobile-sheet-open');
                    document.removeEventListener('pointerdown', close);
                    document.removeEventListener('keydown', close);
                }
            };
            document.addEventListener('pointerdown', close);
            document.addEventListener('keydown', close);
        };
    }
    const openRowActions = event => {
        const value = event.target.closest('.sm-record-row .mf-record-value, .cc-subject-record .mf-record-value');
        if (!value || event.target.closest('a, button, input, select, textarea, label')) return;
        event.preventDefault();
        window.mfOpenContextMenu(event, value.closest('tr'));
    };
    document.addEventListener('click', openRowActions);
    document.addEventListener('contextmenu', openRowActions);
    const label = key => key === 'role_name' ? 'Role'
        : key === 'position_name' ? 'Work Position'
            : key === 'deleted_at' ? 'Archived'
                : key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const formatRelativeTime = value => {
        const raw = String(value ?? '').trim();
        if (!raw) return '—';
        const date = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
        if (Number.isNaN(date.getTime())) return raw;
        const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
        const months = Math.floor(days / 30);
        if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
        const years = Math.floor(months / 12);
        return `${years} year${years === 1 ? '' : 's'} ago`;
    };
    const archiveTimeNode = value => {
        const wrap = document.createElement('span');
        wrap.className = 'archive-time';
        const prefix = document.createElement('span');
        prefix.className = 'archive-time-label';
        prefix.textContent = 'Archived · ';
        const relative = document.createElement('span');
        relative.textContent = formatRelativeTime(value);
        wrap.append(prefix, relative);
        return wrap;
    };
    const hiddenFields = new Set(['employee_id', 'position_id', 'user_id', 'description',
        'effective_from', 'effective_until', 'year_start', 'year_end', 'date_start', 'date_end', 'is_active', 'status']);
    const nameFields = ['first_name', 'middle_name', 'last_name', 'name_extension'];
    const isTeacherField = field => /teacher|adviser|instructor/i.test(String(field));
    const fullName = row => String(row?.full_name ?? '').trim()
        || nameFields.map(field => String(row[field] ?? '').trim()).filter(Boolean).join(' ');
    function displayFields(config) {
        const fields = [];
        for (const field of config.fields) {
            if (field === config.pk || hiddenFields.has(field)) continue;
            if (config.pk === 'user_id' && field === 'username') {
                if (!fields.includes('full_name')) fields.push('full_name');
                if (!fields.includes('position_name')) fields.push('position_name');
                continue;
            }
            if (config.pk === 'user_id' && field === 'role_id') {
                fields.push('role_name');
                continue;
            }
            if (nameFields.includes(field)) {
                if (!fields.includes('full_name')) fields.push('full_name');
            } else fields.push(field);
        }
        return fields;
    }
    const node = (tag, text, className) => {
        const el = document.createElement(tag);
        if (text !== undefined) el.textContent = text;
        if (className) el.className = className;
        return el;
    };
    const button = text => { const el = node('button', text, 'btn btn-outline'); el.type = 'button'; return el; };
    async function request(operation, params = {}, body) {
        const url = new URL(endpoint);
        url.search = new URLSearchParams({ operation, ...params });
        const response = await fetch(url, {
            credentials: 'include', cache: 'no-store',
            ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
        });
        const data = await response.json();
        if (!response.ok || data.success === false) throw new Error(data.message || 'Unable to load archive.');
        return data;
    }
    async function initialize() {
        // Match the existing Masterfiles write permission. The API rechecks it.
        const role = String(window.CURRENT_ROLE_NAME || '').toLowerCase();
        if (role && !role.includes('admin')) {
            document.querySelector('[data-mf-option="archive"]')?.remove();
            return;
        }
        const existingArchiveOption = document.querySelector('[data-mf-option="archive"]');
        const opener = existingArchiveOption || button('View Archive');
        if (!existingArchiveOption) {
            opener.id = 'masterfileArchiveButton';
            opener.innerHTML = '<i class="fas fa-box-archive" aria-hidden="true"></i> View Archive';
        }
        const toolbar = ['.page-header .header-actions', '.page-header-actions', '.page-header', '.content-header .header-right', '.content-header', 'main', '.main-content']
            .map(selector => document.querySelector(selector)).find(Boolean);
        if (!existingArchiveOption && !toolbar) return;
        const isCurriculumWizard = document.body.classList.contains('curriculum-components-page');
        if (!existingArchiveOption && (document.getElementById('addButton') || isCurriculumWizard)) {
            // The shared Options menu forwards to this opener if it initializes later.
            opener.hidden = true;
            opener.style.display = 'none';
            document.body.append(opener);
        } else if (!existingArchiveOption) {
            const actions = node('div', undefined, 'mf-archive-options');
            const toggle = button('');
            toggle.className = 'btn btn-outline mf-options-icon-btn';
            toggle.setAttribute('aria-label', 'Options');
            toggle.setAttribute('title', 'Options');
            toggle.innerHTML = '<i class="fas fa-ellipsis-vertical" aria-hidden="true"></i>';
            toggle.setAttribute('aria-expanded', 'false');
            const menu = node('div', undefined, 'mf-options-menu');
            menu.id = 'mfArchiveOptionsMenu';
            menu.setAttribute('role', 'menu');
            toggle.setAttribute('aria-controls', menu.id);
            toggle.setAttribute('aria-haspopup', 'menu');
            opener.setAttribute('role', 'menuitem');
            opener.textContent = 'View archive';
            menu.append(opener);
            actions.append(toggle, menu);
            toolbar.append(actions);
            const shouldPortalMenu = document.body.classList.contains('curriculum-components-page');
            const isMobileViewport = () => window.matchMedia?.('(max-width: 768px)').matches;
            const portalMenu = () => {
                if (shouldPortalMenu && isMobileViewport() && menu.parentElement !== document.body) {
                    document.body.append(menu);
                }
            };
            const restoreMenu = () => {
                if (menu.parentElement !== actions) actions.append(menu);
            };
            const closeMenu = () => {
                menu.classList.remove('is-open');
                toggle.setAttribute('aria-expanded', 'false');
                document.body.classList.remove('mf-mobile-sheet-open');
                restoreMenu();
            };
            toggle.addEventListener('click', () => {
                const open = !menu.classList.contains('is-open');
                if (open) portalMenu();
                menu.classList.toggle('is-open', open);
                toggle.setAttribute('aria-expanded', String(open));
                if (isMobileViewport()) document.body.classList.toggle('mf-mobile-sheet-open', open);
            });
            opener.addEventListener('click', closeMenu);
            document.addEventListener('pointerdown', event => {
                if (!actions.contains(event.target) && !menu.contains(event.target)) closeMenu();
            });
            actions.addEventListener('keydown', event => {
                if (event.key === 'Escape') { closeMenu(); toggle.focus(); }
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    portalMenu();
                    menu.classList.add('is-open');
                    toggle.setAttribute('aria-expanded', 'true');
                    opener.focus();
                }
            });
            actions.addEventListener('focusout', event => {
                if (!actions.contains(event.relatedTarget) && !menu.contains(event.relatedTarget)) closeMenu();
            });
        }
        const dialog = node('dialog', undefined, 'masterfile-archive');
        dialog.setAttribute('aria-labelledby', 'masterfileArchiveTitle');
        const header = node('div', undefined, 'archive-header');
        const heading = node('h2', 'Archive'); heading.id = 'masterfileArchiveTitle';
        const close = button('Close'); header.append(heading, close);
        const controls = node('div', undefined, 'archive-controls');
        const select = node('select'); select.dataset.native = 'true'; select.setAttribute('aria-label', 'Masterfile archive');
        const search = node('input'); search.type = 'search'; search.placeholder = 'Search archived records'; search.setAttribute('aria-label', search.placeholder);
        const refresh = button('Search'); controls.append(select, search, refresh);
        const notice = node('p', '', 'archive-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
        const setNotice = (message, isError = false) => {
            notice.textContent = message;
            notice.classList.toggle('archive-notice--error', isError);
            notice.setAttribute('role', isError ? 'alert' : 'status');
        };
        const wrap = node('div', undefined, 'archive-table-wrap'); wrap.tabIndex = 0; wrap.setAttribute('aria-label', 'Archived records table');
        const table = node('table'); const thead = node('thead'); const tbody = node('tbody'); table.append(thead, tbody); wrap.append(table);
        const footer = node('div', undefined, 'archive-footer');
        const previous = button('Previous'); const next = button('Next'); const count = node('span'); footer.append(previous, count, next);
        dialog.append(header, controls, notice, wrap, footer); document.body.append(dialog);
        function setBusy(value) {
            state.busy = value;
            select.disabled = search.disabled = refresh.disabled = value;
            previous.disabled = value || state.page <= 1;
            next.disabled = value || state.page >= state.pages;
            close.disabled = value;
        }
        async function load() {
            const sequence = ++state.sequence;
            setNotice('Loading archived records…');
            setBusy(true);
            tbody.replaceChildren();
            try {
                const data = await request('list', { module: state.module, page: state.page, search: search.value.trim() });
                if (sequence !== state.sequence) return;
                const config = state.modules[state.module];
                heading.textContent = `${config.label} Archive`;
                const fields = displayFields(config);
                const tr = node('tr');
                for (const field of fields) { const th = node('th', label(field)); th.scope = 'col'; tr.append(th); }
                tr.append(node('th', 'Action')); thead.replaceChildren(tr);
                for (const row of data.records) {
                    const tr = node('tr');
                    if (config.restore) tr.classList.add('archive-restorable');
                    const values = fields.map(field => field === 'full_name' ? (fullName(row) || '—') : (row[field] ?? '—'));
                    fields.forEach((field, index) => {
                        const td = node('td', undefined, index === 0 ? 'archive-primary' : 'archive-secondary');
                        td.dataset.label = label(field);
                        if (field === 'deleted_at') td.replaceChildren(archiveTimeNode(values[index]));
                        else td.textContent = values[index];
                        if (index === 0) {
                            const strong = node('strong', values[index], 'archive-primary-value');
                            const meta = node('div', undefined, 'archive-meta');
                            fields.slice(1).forEach((metaField, metaIndex) => {
                                const item = node('span', undefined, `archive-meta-item${isTeacherField(metaField) ? ' archive-teacher-meta' : ''}`);
                                const metaValue = values[metaIndex + 1];
                                if (metaField === 'deleted_at') item.append(archiveTimeNode(metaValue));
                                else item.textContent = metaValue;
                                meta.append(item);
                            });
                            td.replaceChildren(strong, meta);
                        }
                        tr.append(td);
                    });
                    const action = node('td', undefined, 'archive-action'); action.dataset.label = 'Action';
                    if (config.restore) {
                        const restore = button('');
                        restore.classList.add('archive-restore');
                        restore.title = 'Restore';
                        restore.setAttribute('aria-label', 'Restore');
                        restore.innerHTML = '<i class="fas fa-rotate-left" aria-hidden="true"></i>';
                        restore.addEventListener('click', () => restoreRecord(row, restore)); action.append(restore);
                    } else {
                        action.textContent = state.module === 'learners' ? 'Reinstate through Import Learners.' : 'Reinstate through the curriculum editor.';
                    }
                    tr.append(action); tbody.append(tr);
                }
                state.page = data.page; state.pages = data.pages;
                count.textContent = `Page ${data.page} of ${data.pages}`;
                setNotice(data.total ? '' : (search.value.trim() ? 'No archived records match your search.' : 'No archived records in this masterfile.'));
            } catch (error) { setNotice(error.message, true); count.textContent = ''; }
            finally { if (sequence === state.sequence) setBusy(false); }
        }
        async function restoreRecord(row, restoreButton) {
            if (state.busy) return;
            const config = state.modules[state.module];
            const name = fullName(row) || displayFields(config).filter(f => f !== 'deleted_at').map(f => row[f]).find(v => v !== null && v !== '') || row[config.pk];
            const accountNote = ['users', 'employees'].includes(state.module) ? ' The linked staff profile will be restored too, and the account will be reactivated.' : '';
            if (!await window.mfConfirm({
                title: `Restore “${name}”?`,
                message: `This record will return to the active list.${accountNote}`,
                confirmLabel: 'Restore',
                intent: 'restore',
                eyebrow: 'Restore from archive'
            })) return;
            setBusy(true); restoreButton.disabled = true;
            try {
                const data = await request('restore', { module: state.module }, { id: row[config.pk], csrf: state.csrf });
                state.restored = true;
                await load();
                setNotice(data.message);
            } catch (error) { setNotice(error.message, true); }
            finally { setBusy(false); restoreButton.disabled = false; }
        }
        opener.addEventListener('click', async () => {
            dialog.showModal(); setNotice('Loading archive…'); setBusy(true);
            try {
                const data = await request('modules'); state.csrf = data.csrf;
                state.modules = Object.fromEntries(requested.filter(key => data.modules[key]).map(key => [key, data.modules[key]]));
                select.replaceChildren();
                for (const [key, config] of Object.entries(state.modules)) { const option = node('option', config.label); option.value = key; select.append(option); }
                select.hidden = Object.keys(state.modules).length === 1;
                state.module = select.value; state.page = 1; search.value = '';
                if (!state.module) { setNotice('This masterfile has no stored archive. Its values are maintained as fixed references.'); return; }
                await load();
            } catch (error) { setNotice(error.message, true); }
            finally { setBusy(false); }
        });
        close.addEventListener('click', () => dialog.close());
        dialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
        dialog.addEventListener('close', () => {
            // Refresh custom controllers and their reference caches after restoration.
            if (state.restored) window.location.reload();
        });
        select.addEventListener('change', () => { state.module = select.value; state.page = 1; load(); });
        search.addEventListener('search', () => { state.page = 1; load(); });
        search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); state.page = 1; load(); } });
        refresh.addEventListener('click', () => { if (state.module) { state.page = 1; load(); } });
        previous.addEventListener('click', () => { state.page--; load(); });
        next.addEventListener('click', () => { state.page++; load(); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
    else initialize();
})();
