// Generic masterfile controller used across DepEd pages

// Keep the visual refresh centralized so every CRUD masterfile gets the same
// treatment without duplicating links or touching each page's event wiring.
(function ensureMasterfileVisualLayer() {
    if (!document.querySelector('link[data-masterfile-premium]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.dataset.masterfilePremium = 'true';
        // Masterfiles live in both /pages/ and /pages/masterfiles/. Resolve
        // from this script rather than the document URL so both locations use
        // the application asset root.
        link.href = new URL('../../assets/css/masterfiles-premium.css?v=20261014-period-row-menu-v2', document.currentScript?.src || document.baseURI).href;
        document.head.appendChild(link);
    }
})();

let MF_CONFIG = null;
let MF_RECORDS = [];
let MF_FILTERED = [];
let MF_CURRENT_ID = null;
let MF_MODAL_MODE = 'add';
let MF_SORT_KEY = null;
let MF_SORT_DIR = 'asc';
let MF_CURRENT_PAGE = 1;
const MF_ITEMS_PER_PAGE = 8;
const MF_SELECT_OPTIONS = {};
const MF_SELECTED_IDS = new Set();
let MF_CLOSE_CONFIRM_PENDING = false;
const MF_ACADEMIC_DATE_MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];
const MF_ACADEMIC_DATE_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let MF_ACTIVE_ACADEMIC_DATE_PICKER = null;
let MF_LONG_PRESS_TIMER = null;
let MF_ROW_CLICK_TIMER = null;
let MF_LAST_ROW_CLICK = null;

function mfItemsPerPage() {
    const configured = Number(MF_CONFIG?.itemsPerPage);
    return Number.isInteger(configured) && configured > 0 ? configured : MF_ITEMS_PER_PAGE;
}

function mfAfterTableRender(rows) {
    if (typeof MF_CONFIG?.afterTableRender !== 'function') return;
    try {
        MF_CONFIG.afterTableRender(rows, MF_RECORDS, MF_FILTERED);
    } catch (error) {
        console.error('Masterfile table hook error:', error);
    }
}

function mfUsesArchive() {
    return window.location.pathname.includes('/pages/masterfiles/');
}

function mfCanView() {
    return Boolean(MF_CONFIG?.enableView);
}

function mfCanEditRow(row) {
    if (MF_CONFIG?.disableEdit) return false;
    if (typeof MF_CONFIG?.canEdit !== 'function') return true;
    try {
        return Boolean(MF_CONFIG.canEdit(row));
    } catch (_) {
        return false;
    }
}

function mfCanDeleteRow(row) {
    if (MF_CONFIG?.disableDelete) return false;
    if (typeof MF_CONFIG?.canDelete !== 'function') return true;
    try {
        return Boolean(MF_CONFIG.canDelete(row));
    } catch (_) {
        return false;
    }
}

function mfHideActions() {
    return Boolean(MF_CONFIG?.readOnly || MF_CONFIG?.hideActions);
}

function mfVisibleColumns() {
    return (MF_CONFIG?.columns || []).filter(col => {
        if (col?.tableVisible === false) return false;
        if (col?.tableVisible === true) return true;
        const key = String(col?.key || '').toLowerCase().replace(/[^a-z]/g, '');
        const label = String(col?.label || '').trim().toLowerCase();
        return !['isactive', 'active', 'status', 'tatus'].includes(key)
            && !/^(active|status|tatus)(value|flag)?$/.test(key)
            && !/^(active|status|tatus)$/.test(label);
    });
}

function mfCanSelect() {
    return !mfHideActions() && !MF_CONFIG?.disableDelete;
}

function mfTableColSpan() {
    return mfVisibleColumns().length + (mfCanSelect() ? 1 : 0);
}

function mfEmptyVideoMarkup() {
    const assetByKey = {
        announcements: 'sorry',
        family_members: 'learners',
        honor_levels: 'medal',
        risk_assessments: 'learners',
        school_years: 'fast-forward',
    };
    const asset = assetByKey[String(MF_CONFIG?.key || '')] || 'search';
    const assetRoot = mfUsesArchive() ? '../../assets' : '../assets';
    const source = `${assetRoot}/icons/${asset}.mp4`;
    return `<video class="empty-state-video mf-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="${mfEscapeAttr(source)}" type="video/mp4"></video>`;
}

function mfPrimaryColumn() {
    const columns = mfVisibleColumns();
    const priorities = [
        /(^|_)(full_name|display_name|name)(_|$)/i,
        /(^|_)subject(_|$)/i,
        /(^|_)(description|year_label|code|number|role|position)(_|$)/i
    ];
    for (const pattern of priorities) {
        const match = columns.find(col => pattern.test(String(col?.key || '')));
        if (match) return match;
    }
    return columns[0] || null;
}

function mfIsTeacherColumn(column) {
    return /(^|_)(teacher|teacher_name|adviser|adviser_name|instructor)(_|$)/i.test(String(column?.key || ''))
        || /teacher|adviser|instructor/i.test(String(column?.label || ''));
}

function mfIsMobileHiddenColumn(column) {
    if (column?.mobileHidden === true) return true;

    const key = String(column?.key || '').toLowerCase().replace(/[^a-z]/g, '');
    const label = String(column?.label || '').trim().toLowerCase();
    return ['role', 'rolename', 'position', 'positionname', 'workposition', 'workpositionname'].includes(key)
        || /^(system\s*role|work\s*position|position|role)$/.test(label);
}

function mfEscapeAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function mfNormalizeGender(gender) {
    const value = String(gender || '').trim().toLowerCase();
    if (value === 'm' || value === 'male' || value === 'man' || value === 'boy') return 'male';
    if (value === 'f' || value === 'female' || value === 'woman' || value === 'girl') return 'female';
    if (value) return 'other';
    return 'neutral';
}

function mfRecordInitials(row, fallback) {
    const first = String(row?.first_name || '').trim();
    const last = String(row?.last_name || '').trim();
    const name = `${first} ${last}`.trim() || String(fallback || '').trim();
    const parts = name.split(/\s+/).filter(Boolean);
    if (!parts.length) return 'U';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function initializeMasterfile(config) {
    MF_CONFIG = config;
    wireStaticText();
    buildFormFields();
    ensureBulkControls();
    buildTableHead();
    wireEvents();
    loadReferenceData()
        .then(() => loadRecords())
        .catch(error => {
            console.error('Error loading reference data:', error);
            loadRecords();
        });
}

function wireStaticText() {
    setText('pageTitle', MF_CONFIG.pageTitle);
    const rawSubtitle = String(MF_CONFIG.subtitle || '').trim();
    const subtitle = /^manage\b/i.test(rawSubtitle) ? '' : rawSubtitle;
    setText('pageSubtitle', subtitle);
    setText('breadcrumbCurrent', MF_CONFIG.breadcrumb || MF_CONFIG.pageTitle);
    setText('addButtonLabel', MF_CONFIG.addLabel || `Add ${MF_CONFIG.entity}`);
    setText('modalTitle', `Add ${MF_CONFIG.entity}`);
    setText('saveButtonText', `Save ${MF_CONFIG.entity}`);

    document.querySelectorAll('[data-masterfile-link], [data-transaction-link]').forEach(link => {
        link.classList.remove('active');
        if ((link.dataset.masterfileLink === MF_CONFIG.navKey) || (link.dataset.transactionLink === MF_CONFIG.navKey)) {
            link.classList.add('active');
        }
    });

    if (MF_CONFIG.readOnly || MF_CONFIG.disableAdd) {
        const addBtn = document.getElementById('addButton');
        if (addBtn) addBtn.style.display = 'none';
    }
    setupMasterfileOptions();
}

function setupMasterfileOptions() {
    const addButton = document.getElementById('addButton');
    if (!addButton || addButton.dataset.optionsReady === 'true') return;
    addButton.dataset.optionsReady = 'true';
    addButton.removeAttribute('onclick');
    addButton.setAttribute('aria-haspopup', 'menu');
    addButton.setAttribute('aria-expanded', 'false');
    addButton.setAttribute('aria-label', 'Options');
    addButton.setAttribute('title', 'Options');
    addButton.innerHTML = '<i class="fas fa-ellipsis-vertical" aria-hidden="true"></i>';
    addButton.classList.add('mf-options-icon-btn');

    const menu = document.createElement('div');
    menu.id = 'mfOptionsMenu';
    addButton.setAttribute('aria-controls', menu.id);
    menu.className = 'mf-options-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
        <button type="button" role="menuitem" data-mf-option="add">
            <i class="fas fa-plus" aria-hidden="true"></i>
            <span>Add ${mfEscapeAttr(MF_CONFIG.entity || 'record')}</span>
        </button>
        ${MF_CONFIG?.disableArchive ? '' : `<button type="button" role="menuitem" data-mf-option="archive">
            <i class="fas fa-clock-rotate-left" aria-hidden="true"></i>
            <span>View archive</span>
        </button>`}
    `;
    addButton.insertAdjacentElement('afterend', menu);
    const setOpen = (open) => {
        menu.classList.toggle('is-open', open);
        addButton.setAttribute('aria-expanded', String(open));
        if (window.matchMedia?.('(max-width: 768px)').matches) {
            document.body.classList.toggle('mf-mobile-sheet-open', open);
        }
    };
    addButton.addEventListener('click', () => setOpen(!menu.classList.contains('is-open')));
    menu.addEventListener('click', (event) => {
        const option = event.target.closest('[data-mf-option]');
        if (!option) return;
        if (option.disabled || option.getAttribute('aria-disabled') === 'true') return;
        setOpen(false);
        if (option.dataset.mfOption === 'add') {
            openAddModal();
        } else {
            document.getElementById('masterfileArchiveButton')?.click();
        }
    });
    document.addEventListener('pointerdown', (event) => {
        if (!menu.contains(event.target) && event.target !== addButton && !addButton.contains(event.target)) setOpen(false);
    });
    addButton.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setOpen(false);
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); menu.querySelector('button:not([disabled])')?.focus(); }
    });
    menu.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            addButton.focus();
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const items = [...menu.querySelectorAll('button:not(:disabled)')];
            const step = event.key === 'ArrowDown' ? 1 : -1;
            items[(items.indexOf(document.activeElement) + step + items.length) % items.length]?.focus();
        }
    });
    menu.parentElement.addEventListener('focusout', (event) => {
        if (!menu.contains(event.relatedTarget) && event.relatedTarget !== addButton) setOpen(false);
    });
}

function ensureBulkControls() {
    const toolbar = document.querySelector('.table-header-section');
    if (!toolbar || !mfCanSelect() || toolbar.querySelector('#mfBulkControls')) return;

    const controls = document.createElement('div');
    controls.id = 'mfBulkControls';
    controls.className = 'mf-bulk-controls';
    controls.innerHTML = `
        <label class="mf-select-all">
            <input type="checkbox" id="mfSelectAll" aria-label="Select all visible records">
            <span>Select all</span>
        </label>
        <button type="button" id="mfBulkArchiveBtn" class="btn mf-bulk-archive-btn" aria-label="Archive selected records" disabled aria-disabled="true">
            <i class="fas fa-box-archive" aria-hidden="true"></i>
            <span class="mf-bulk-archive-label">Archive selected</span>
        </button>
    `;
    toolbar.insertBefore(controls, toolbar.firstElementChild?.nextElementSibling || null);

    controls.querySelector('#mfSelectAll')?.addEventListener('change', (event) => {
        const ids = MF_FILTERED.map(row => row?.[MF_CONFIG.primaryKey]).filter(id => id !== undefined && id !== null && id !== '');
        ids.forEach(id => event.target.checked ? MF_SELECTED_IDS.add(String(id)) : MF_SELECTED_IDS.delete(String(id)));
        renderTable();
    });
    controls.querySelector('#mfBulkArchiveBtn')?.addEventListener('click', () => {
        if (MF_SELECTED_IDS.size > 0) applyBulkAction();
    });
    controls.addEventListener('contextmenu', (event) => {
        if (!MF_SELECTED_IDS.size) return;
        event.preventDefault();
        mfOpenBulkContextMenu(event, MF_SELECTED_IDS.size);
    });
    updateBulkControls();
}

function updateBulkControls() {
    if (document.querySelector('#mfContextMenu[data-bulk-selection]')) mfCloseContextMenu();
    const selected = MF_SELECTED_IDS.size;
    document.body.classList.toggle('mf-selection-mode', selected > 0);
    const selectAll = document.getElementById('mfSelectAll');
    if (selectAll) {
        const visibleIds = MF_FILTERED.map(row => String(row?.[MF_CONFIG.primaryKey] ?? '')).filter(Boolean);
        const selectedVisible = visibleIds.filter(id => MF_SELECTED_IDS.has(id)).length;
        selectAll.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
        selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
    }
    const headerSelectAll = document.getElementById('mfSelectAllHeader');
    if (headerSelectAll && selectAll) {
        headerSelectAll.checked = selectAll.checked;
        headerSelectAll.indeterminate = selectAll.indeterminate;
    }
    document.querySelectorAll('#dataTableBody tr[data-row-id]').forEach(row => {
        const checked = MF_SELECTED_IDS.has(row.dataset.rowId);
        row.classList.toggle('is-selected', checked);
        const checkbox = row.querySelector('input[data-selection-id]');
        if (checkbox) checkbox.checked = checked;
    });
    // Bulk archive is available only beside Select all.
    const archiveBtn = document.getElementById('mfBulkArchiveBtn');
    if (archiveBtn) {
        archiveBtn.hidden = selected === 0;
        archiveBtn.disabled = selected === 0;
        archiveBtn.setAttribute('aria-disabled', String(selected === 0));
        archiveBtn.classList.toggle('is-visible', selected > 0);
        const label = archiveBtn.querySelector('.mf-bulk-archive-label');
        if (label) {
            label.textContent = selected === 0
                ? 'Archive selected'
                : `Archive selected (${selected})`;
        }
    }
}

async function applyBulkAction() {
    const ids = [...MF_SELECTED_IDS];
    if (!ids.length) return;
    const confirmed = await showConfirmDialog(
        'Archive selected records',
        MF_CONFIG.bulkArchiveConfirmMessage || `The ${ids.length} selected records will be hidden from the active list and kept in View archive. You can restore them later.`,
        { intent: 'archive', eyebrow: 'Bulk archive' }
    );
    if (!confirmed) return;

    try {
        for (const id of ids) {
            const result = await MF_CONFIG.api.remove(id);
            if (result?.success === false) throw new Error(result.message || 'Unable to archive a selected record.');
        }
        MF_SELECTED_IDS.clear();
        showNotification(`${ids.length} ${MF_CONFIG.entity.toLowerCase()}${ids.length === 1 ? '' : 's'} archived.`);
        await loadRecords();
    } catch (error) {
        console.error('Bulk archive error', error);
        showNotification(error?.response?.data?.message || error.message || 'Unable to archive selected records.', 'error');
        updateBulkControls();
    }
}

function mfOpenBulkContextMenu(event, count) {
    mfCloseContextMenu();
    if (!MF_SELECTED_IDS.size || !count) return;
    const menu = document.createElement('div');
    menu.id = 'mfContextMenu';
    menu.dataset.bulkSelection = 'true';
    menu.className = 'mf-context-menu';
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mf-context-menu-item';
    item.setAttribute('role', 'menuitem');
    const icon = document.createElement('i');
    icon.className = 'fas fa-box-archive';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = `Archive ${count} selected record${count === 1 ? '' : 's'}`;
    item.append(icon, text);
    item.addEventListener('click', () => { mfCloseContextMenu(); applyBulkAction(); });
    menu.append(item);
    document.body.append(menu);
    if (window.matchMedia?.('(max-width: 768px)').matches) {
        document.body.classList.add('mf-mobile-sheet-open');
    }
    const margin = 8;
    menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - margin))}px`;
    const close = (closeEvent) => {
        if (closeEvent.type === 'keydown' && closeEvent.key !== 'Escape') return;
        if (!menu.contains(closeEvent.target) || closeEvent.key === 'Escape') {
            mfCloseContextMenu();
            document.removeEventListener('pointerdown', close);
            document.removeEventListener('keydown', close);
        }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
}

function buildFormFields() {
    const container = document.getElementById('dynamicFields');
    if (!container) return;

    // Check if fieldSections is defined (structured form with sections)
    if (MF_CONFIG.fieldSections && Array.isArray(MF_CONFIG.fieldSections)) {
        container.innerHTML = MF_CONFIG.fieldSections.map(section => {
            const fieldsHtml = section.fields.map(field => renderField(field)).join('\n');
            const sectionHelp = String(section.helpText || '').replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
            return `
                <div class="form-section">
                    <h3 class="section-title">${section.title}</h3>
                    ${sectionHelp ? `<p class="section-help">${sectionHelp}</p>` : ''}
                    <div class="section-fields">
                        ${fieldsHtml}
                    </div>
                </div>
            `;
        }).join('\n');
    } else if (MF_CONFIG.fields) {
        // Legacy: simple field array without sections
        container.innerHTML = MF_CONFIG.fields.map(field => renderField(field)).join('\n');
    }
}

function renderField(field) {
    const id = `field-${field.key}`;
    const required = field.required ? 'required' : '';
    const label = `<label for="${id}">${field.label}${field.required ? ' <span class="required">*</span>' : ''}</label>`;

    if (field.type === 'academic-date') {
        const triggerId = `${id}-display`;
        const pickerId = `${id}-picker`;
        const errorId = `${id}-error`;
        const placeholder = mfEscapeAttr(field.placeholder || `Choose ${String(field.label || 'date').toLowerCase()}`);
        const dateLabel = mfEscapeAttr(field.label || 'Choose date');
        return `<div class="form-group mf-academic-date-group"${field.hideOnAdd ? ' data-hide-on-add="true" hidden style="display:none"' : ''}>
            <label for="${triggerId}">${field.label}${field.required ? ' <span class="required">*</span>' : ''}</label>
            <input type="hidden" id="${id}" class="form-control mf-academic-date-value" ${required}>
            <button type="button" id="${triggerId}" class="form-control mf-academic-date-trigger" data-mf-academic-date-trigger data-field-key="${mfEscapeAttr(field.key)}" aria-haspopup="dialog" aria-expanded="false" aria-controls="${pickerId}" aria-describedby="${errorId}">
                <span class="mf-academic-date-trigger-value">${placeholder}</span>
                <i class="fas fa-calendar-alt" aria-hidden="true"></i>
            </button>
            <div class="error-message" id="${errorId}" aria-live="polite"></div>
            <div class="mf-academic-date-picker" id="${pickerId}" role="dialog" aria-label="Choose ${dateLabel}" hidden></div>
        </div>`;
    }

    if (field.type === 'select') {
        const helpText = String(field.helpText || '').replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
        return `<div class="form-group">${label}<select id="${id}" class="form-control" ${required}${helpText ? ` aria-describedby="${id}-help"` : ''}><option value="">Select ${field.label}</option></select><div class="error-message" aria-live="polite"></div>${helpText ? `<small id="${id}-help" class="field-help">${helpText}</small>` : ''}</div>`;
    }

    if (field.type === 'readonly-reference') {
        const helpText = String(field.helpText || '').replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
        const emptyText = mfEscapeAttr(field.emptyText || 'Not assigned');
        const labelId = `${id}-label`;
        return `<div class="form-group mf-readonly-reference-group"><label id="${labelId}">${field.label}</label><div id="${id}" class="form-control mf-readonly-reference" role="status" aria-labelledby="${labelId}" aria-readonly="true" data-empty-text="${emptyText}">${field.emptyText || 'Not assigned'}</div><div class="error-message" aria-live="polite"></div>${helpText ? `<small id="${id}-help" class="field-help">${helpText}</small>` : ''}</div>`;
    }

    if (field.type === 'checkbox') {
        const checked = field.defaultValue ? 'checked' : '';
        const checkboxClass = MF_CONFIG?.key === 'school_years' && field.key === 'is_active'
            ? 'form-group checkbox-group school-year-active-checkbox'
            : 'form-group checkbox-group';
        return `<div class="${checkboxClass}"><label class="checkbox-label"><input type="checkbox" id="${id}" ${checked}> ${field.label}</label></div>`;
    }

    if (field.type === 'textarea') {
        const placeholder = field.placeholder ? `placeholder="${mfEscapeAttr(field.placeholder)}"` : '';
        const rows = Math.max(3, Math.min(12, Number(field.rows) || 5));
        const maxLength = field.maxLength ? `maxlength="${Number(field.maxLength)}"` : '';
        const helpText = String(field.helpText || '').replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
        return `<div class="form-group"><label for="${id}">${field.label}${field.required ? ' <span class="required">*</span>' : ''}</label><textarea id="${id}" class="form-control" rows="${rows}" ${required} ${maxLength} ${placeholder}${helpText ? ` aria-describedby="${id}-help"` : ''}></textarea><div class="error-message" aria-live="polite"></div>${helpText ? `<small id="${id}-help" class="field-help">${helpText}</small>` : ''}</div>`;
    }

    const inputType = ['number', 'date', 'password', 'email'].includes(field.type) ? field.type : 'text';
    const placeholder = field.placeholder ? `placeholder="${field.placeholder}"` : '';
    const maskAttr = field.mask ? `data-mask="${field.mask}"` : '';
    const minAttr = (field.min !== undefined && field.min !== null) ? `min="${field.min}"` : '';
    const maxAttr = (field.max !== undefined && field.max !== null) ? `max="${field.max}"` : '';
    const stepAttr = field.step ? `step="${field.step}"` : '';
    const readOnlyAttr = field.readonly ? 'readonly' : '';
    const attrs = [required, placeholder, maskAttr, minAttr, maxAttr, stepAttr, readOnlyAttr, field.maxLength ? `maxlength="${field.maxLength}"` : ''].filter(Boolean).join(' ');
    const helpText = String(field.helpText || '').replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
    return `<div class="form-group"${field.hideOnAdd ? ' data-hide-on-add="true" hidden style="display:none"' : ''}>${label}<input type="${inputType}" id="${id}" class="form-control" ${attrs}${helpText ? ` aria-describedby="${id}-help"` : ''}><div class="error-message" aria-live="polite"></div>${helpText ? `<small id="${id}-help" class="field-help">${helpText}</small>` : ''}</div>`;
}

function mfAcademicDateInputId(fieldKey) {
    return `field-${fieldKey}`;
}

function mfAcademicDateTriggerId(fieldKey) {
    return `${mfAcademicDateInputId(fieldKey)}-display`;
}

function mfAcademicDatePickerId(fieldKey) {
    return `${mfAcademicDateInputId(fieldKey)}-picker`;
}

function mfAcademicDateFieldConfig(fieldKey) {
    const fields = MF_CONFIG?.fieldSections
        ? MF_CONFIG.fieldSections.flatMap(section => section.fields)
        : (MF_CONFIG?.fields || []);
    return fields.find(field => field.key === fieldKey && field.type === 'academic-date');
}

function mfParseAcademicDate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(0);
    date.setFullYear(year, month, day);
    date.setHours(12, 0, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
    return { year, month, day };
}

function mfAcademicCalendarDate(year, month, day = 1) {
    const date = new Date(0);
    date.setFullYear(year, month, day);
    date.setHours(12, 0, 0, 0);
    return date;
}

function mfUpdateAcademicDateDisplay(fieldKey) {
    const input = document.getElementById(mfAcademicDateInputId(fieldKey));
    const trigger = document.getElementById(mfAcademicDateTriggerId(fieldKey));
    const value = trigger?.querySelector('.mf-academic-date-trigger-value');
    if (!input || !value) return;
    const parsed = mfParseAcademicDate(input.value);
    const field = mfAcademicDateFieldConfig(fieldKey);
    value.textContent = parsed
        ? `${MF_ACADEMIC_DATE_MONTHS[parsed.month]} ${parsed.day}, ${parsed.year}`
        : (MF_MODAL_MODE === 'view' ? 'Not set' : (field?.placeholder || `Choose ${String(field?.label || 'date').toLowerCase()}`));
    trigger.classList.toggle('has-value', Boolean(parsed));
}

function mfAcademicDateInitialYear(fieldKey) {
    const selected = mfParseAcademicDate(document.getElementById(mfAcademicDateInputId(fieldKey))?.value);
    if (selected) return selected.year;
    const field = mfAcademicDateFieldConfig(fieldKey);
    const yearFromField = Number(document.getElementById(mfAcademicDateInputId(field?.defaultYearField || ''))?.value || 0);
    return yearFromField > 0 ? yearFromField : new Date().getFullYear();
}

function mfPositionAcademicDatePicker() {
    const state = MF_ACTIVE_ACADEMIC_DATE_PICKER;
    if (!state) return;
    const picker = document.getElementById(mfAcademicDatePickerId(state.fieldKey));
    const trigger = document.getElementById(mfAcademicDateTriggerId(state.fieldKey));
    if (!picker || !trigger || picker.hidden) return;

    const margin = 12;
    const width = Math.max(180, Math.min(320, window.innerWidth - margin * 2));
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    picker.style.position = 'fixed';
    picker.style.width = `${width}px`;
    picker.style.maxHeight = `${Math.max(180, viewportHeight - margin * 2)}px`;
    picker.style.overflowY = 'auto';
    const rect = trigger.getBoundingClientRect();
    const height = picker.offsetHeight;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    let top = rect.bottom + 8;
    if (top + height > viewportHeight - margin) top = rect.top - height - 8;
    top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
}

function mfCloseAcademicDatePicker(restoreFocus = false) {
    const state = MF_ACTIVE_ACADEMIC_DATE_PICKER;
    if (!state) return;
    const picker = document.getElementById(mfAcademicDatePickerId(state.fieldKey));
    const trigger = document.getElementById(mfAcademicDateTriggerId(state.fieldKey));
    const group = document.getElementById(mfAcademicDateInputId(state.fieldKey))?.closest('.mf-academic-date-group');
    if (picker) {
        picker.hidden = true;
        picker.removeAttribute('style');
        group?.appendChild(picker);
    }
    if (trigger) {
        trigger.setAttribute('aria-expanded', 'false');
        group?.classList.remove('is-date-picker-open');
        if (restoreFocus && !trigger.disabled) trigger.focus();
    }
    MF_ACTIVE_ACADEMIC_DATE_PICKER = null;
}

function mfRenderAcademicDatePicker() {
    const state = MF_ACTIVE_ACADEMIC_DATE_PICKER;
    if (!state) return;
    const picker = document.getElementById(mfAcademicDatePickerId(state.fieldKey));
    if (!picker) return;
    const selected = mfParseAcademicDate(document.getElementById(mfAcademicDateInputId(state.fieldKey))?.value);
    const { year, month, view } = state;
    const yearControls = `
        <button class="mf-academic-date-nav" type="button" data-mf-academic-date-action="previous-year" aria-label="Previous year"><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
        <strong class="mf-academic-date-year">${year}</strong>
        <button class="mf-academic-date-nav" type="button" data-mf-academic-date-action="next-year" aria-label="Next year"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>`;

    if (view === 'months') {
        picker.innerHTML = `
            <div class="mf-academic-date-header">${yearControls}<button class="mf-academic-date-close" type="button" data-mf-academic-date-action="close" aria-label="Close date picker"><i class="fas fa-times" aria-hidden="true"></i></button></div>
            <p class="mf-academic-date-hint">Choose a month</p>
            <div class="mf-academic-date-month-grid" role="group" aria-label="Months in ${year}">
                ${MF_ACADEMIC_DATE_MONTHS.map((name, index) => `<button type="button" data-mf-academic-month="${index}" aria-pressed="${selected?.year === year && selected.month === index}" class="${selected?.year === year && selected.month === index ? 'is-current' : ''}">${name}</button>`).join('')}
            </div>`;
    } else {
        const daysInMonth = mfAcademicCalendarDate(year, month + 1, 0).getDate();
        const firstWeekday = mfAcademicCalendarDate(year, month, 1).getDay();
        const blanks = Array.from({ length: firstWeekday }, () => '<span class="mf-academic-date-empty" aria-hidden="true"></span>').join('');
        const days = Array.from({ length: daysInMonth }, (_, index) => {
            const day = index + 1;
            const isSelected = selected?.year === year && selected.month === month && selected.day === day;
            const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            return `<button type="button" data-mf-academic-date="${iso}" aria-pressed="${isSelected}" class="${isSelected ? 'is-selected' : ''}">${day}</button>`;
        }).join('');
        picker.innerHTML = `
            <div class="mf-academic-date-header">${yearControls}<button class="mf-academic-date-close" type="button" data-mf-academic-date-action="close" aria-label="Close date picker"><i class="fas fa-times" aria-hidden="true"></i></button></div>
            <div class="mf-academic-date-month-heading"><button type="button" data-mf-academic-date-action="months" aria-label="Choose another month"><i class="fas fa-chevron-left" aria-hidden="true"></i> Months</button><strong>${MF_ACADEMIC_DATE_MONTHS[month]}</strong></div>
            <div class="mf-academic-date-day-grid" role="group" aria-label="Days in ${MF_ACADEMIC_DATE_MONTHS[month]} ${year}">
                ${MF_ACADEMIC_DATE_WEEKDAYS.map(day => `<span class="mf-academic-date-weekday" aria-hidden="true">${day}</span>`).join('')}
                ${blanks}${days}
            </div>`;
    }
    mfPositionAcademicDatePicker();
}

function mfOpenAcademicDatePicker(fieldKey) {
    if (MF_ACTIVE_ACADEMIC_DATE_PICKER?.fieldKey === fieldKey) {
        mfCloseAcademicDatePicker();
        return;
    }
    mfCloseAcademicDatePicker();
    const input = document.getElementById(mfAcademicDateInputId(fieldKey));
    const trigger = document.getElementById(mfAcademicDateTriggerId(fieldKey));
    const picker = document.getElementById(mfAcademicDatePickerId(fieldKey));
    const group = input?.closest('.mf-academic-date-group');
    if (!input || !trigger || !picker || trigger.disabled) return;
    const selected = mfParseAcademicDate(input.value);
    MF_ACTIVE_ACADEMIC_DATE_PICKER = {
        fieldKey,
        year: mfAcademicDateInitialYear(fieldKey),
        month: selected?.month ?? null,
        view: 'months'
    };
    trigger.setAttribute('aria-expanded', 'true');
    group?.classList.add('is-date-picker-open');
    document.body.appendChild(picker);
    picker.hidden = false;
    mfRenderAcademicDatePicker();
    picker.querySelector('[data-mf-academic-month].is-current, [data-mf-academic-month]')?.focus({ preventScroll: true });
}

function mfHandleAcademicDatePickerClick(event, picker) {
    const actionButton = event.target.closest('[data-mf-academic-date-action]');
    if (actionButton) {
        const action = actionButton.dataset.mfAcademicDateAction;
        if (action === 'close') {
            mfCloseAcademicDatePicker(true);
        } else if (action === 'previous-year' || action === 'next-year') {
            MF_ACTIVE_ACADEMIC_DATE_PICKER.year += action === 'previous-year' ? -1 : 1;
            mfRenderAcademicDatePicker();
            picker.querySelector(`[data-mf-academic-date-action="${action}"]`)?.focus({ preventScroll: true });
        } else if (action === 'months') {
            MF_ACTIVE_ACADEMIC_DATE_PICKER.view = 'months';
            mfRenderAcademicDatePicker();
            picker.querySelector('[data-mf-academic-month].is-current, [data-mf-academic-month]')?.focus({ preventScroll: true });
        }
        return;
    }

    const monthButton = event.target.closest('[data-mf-academic-month]');
    if (monthButton) {
        MF_ACTIVE_ACADEMIC_DATE_PICKER.month = Number(monthButton.dataset.mfAcademicMonth);
        MF_ACTIVE_ACADEMIC_DATE_PICKER.view = 'days';
        mfRenderAcademicDatePicker();
        picker.querySelector('[data-mf-academic-date]')?.focus({ preventScroll: true });
        return;
    }

    const dayButton = event.target.closest('[data-mf-academic-date]');
    if (!dayButton) return;
    const input = document.getElementById(mfAcademicDateInputId(MF_ACTIVE_ACADEMIC_DATE_PICKER.fieldKey));
    if (!input) return;
    input.value = dayButton.dataset.mfAcademicDate;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    mfUpdateAcademicDateDisplay(MF_ACTIVE_ACADEMIC_DATE_PICKER.fieldKey);
    mfCloseAcademicDatePicker(true);
}

function setFieldVisibilityForMode(fields, mode) {
    (fields || []).forEach(field => {
        if (!field.hideOnAdd) return;
        const group = document.getElementById(`field-${field.key}`)?.closest('.form-group');
        if (group) {
            group.hidden = mode === 'add';
            group.style.display = mode === 'add' ? 'none' : '';
        }
    });
}

function mfSetFieldError(fieldKey, message) {
    const el = document.getElementById(`field-${fieldKey}`);
    if (!el) return;
    el.classList.add('error');
    const dateTrigger = document.getElementById(mfAcademicDateTriggerId(fieldKey));
    dateTrigger?.classList.add('error');
    dateTrigger?.setAttribute('aria-invalid', 'true');

    const group = el.closest('.form-group');
    if (!group) return;

    let msgEl = group.querySelector('.error-message');
    if (!msgEl) {
        msgEl = document.createElement('div');
        msgEl.className = 'error-message';
        // Keep it adjacent to match CSS: .form-control.error + .error-message
        el.insertAdjacentElement('afterend', msgEl);
    }
    msgEl.textContent = message || 'This field is required.';
}

function mfClearFieldError(fieldKey) {
    const el = document.getElementById(`field-${fieldKey}`);
    if (!el) return;
    el.classList.remove('error');
    const dateTrigger = document.getElementById(mfAcademicDateTriggerId(fieldKey));
    dateTrigger?.classList.remove('error');
    dateTrigger?.removeAttribute('aria-invalid');

    const group = el.closest('.form-group');
    const msgEl = group?.querySelector('.error-message');
    if (msgEl) msgEl.textContent = '';
}

function mfClearAllFieldErrors(allFields) {
    (allFields || []).forEach((field) => {
        if (!field?.key) return;
        mfClearFieldError(field.key);
    });
}

function mfNormalizeUniqueValue(value) {
    return String(value ?? '').trim().toLowerCase();
}

function mfHasDuplicateUniqueValue(field, value) {
    if (!field?.unique || value === '' || value === undefined || value === null) return false;
    const normalizedValue = mfNormalizeUniqueValue(value);
    const currentId = MF_CURRENT_ID === null || MF_CURRENT_ID === undefined
        ? null
        : String(MF_CURRENT_ID);
    const primaryKey = MF_CONFIG?.primaryKey;

    return Array.isArray(MF_RECORDS) && MF_RECORDS.some((record) => {
        if (currentId !== null && String(record?.[primaryKey]) === currentId) return false;
        return mfNormalizeUniqueValue(record?.[field.key]) === normalizedValue;
    });
}

function buildTableHead() {
    const head = document.getElementById('dataTableHead');
    if (!head) return;
    const cols = mfVisibleColumns().map(col => `<th>${col.label}${col.sortable ? ' <i class="fas fa-sort"></i>' : ''}</th>`).join('');
    const select = mfCanSelect()
        ? '<th class="mf-select-column"><input type="checkbox" id="mfSelectAllHeader" aria-label="Select all visible records"></th>'
        : '';
    head.innerHTML = `${select}${cols}`;
    document.getElementById('mfSelectAllHeader')?.addEventListener('change', (event) => {
        const control = document.getElementById('mfSelectAll');
        if (control) control.checked = event.target.checked;
        control?.dispatchEvent(new Event('change'));
    });
    document.getElementById('mfSelectAllHeader')?.addEventListener('contextmenu', (event) => {
        if (!MF_SELECTED_IDS.size) return;
        event.preventDefault();
        mfOpenBulkContextMenu(event, MF_SELECTED_IDS.size);
    });
}

/**
 * Auto-format a date input as MM/DD/YYYY while the user types.
 * The element must have data-mask="date".
 */
function applyDateMask(inputEl) {
    if (!inputEl || inputEl.dataset.mask !== 'date') return;

    const raw = inputEl.value;
    const digits = raw.replace(/\D/g, '').slice(0, 8);
    if (!digits) {
        inputEl.value = '';
        return;
    }

    let formatted = '';
    if (digits.length >= 1) formatted = digits.slice(0, 2);
    if (digits.length >= 3) formatted += '/' + digits.slice(2, 4);
    if (digits.length >= 5) formatted += '/' + digits.slice(4, 8);

    if (formatted !== raw) {
        // Preserve caret position roughly at the end of user typing.
        inputEl.value = formatted;
    }
}

function mfSelectRow(row, toggle = false) {
    const checkbox = row?.querySelector('input[data-selection-id]');
    if (!checkbox || checkbox.disabled) return;
    clearTimeout(MF_ROW_CLICK_TIMER);
    mfCloseContextMenu();
    const id = checkbox.dataset.selectionId;
    if (toggle && MF_SELECTED_IDS.has(id)) MF_SELECTED_IDS.delete(id);
    else MF_SELECTED_IDS.add(id);
    updateBulkControls();
}

function wireEvents() {
    document.addEventListener('pointerdown', () => clearTimeout(MF_ROW_CLICK_TIMER));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') clearTimeout(MF_ROW_CLICK_TIMER);
    });
    document.getElementById('searchInput')?.addEventListener('input', (e) => {
        filterRecords(e.target.value);
    });
    document.getElementById('prevBtn')?.addEventListener('click', () => changePage(-1));
    document.getElementById('nextBtn')?.addEventListener('click', () => changePage(1));

    const tbody = document.getElementById('dataTableBody');
    if (tbody) {
        tbody.addEventListener('click', (e) => {
            const selectBox = e.target.closest('input[data-selection-id]');
            if (selectBox) {
                clearTimeout(MF_ROW_CLICK_TIMER);
                mfCloseContextMenu();
                const id = String(selectBox.dataset.selectionId || '');
                if (id) {
                    if (selectBox.checked) MF_SELECTED_IDS.add(id);
                    else MF_SELECTED_IDS.delete(id);
                    updateBulkControls();
                }
                return;
            }
            const mobileToggle = e.target.closest('[data-mobile-actions-toggle]');
            if (mobileToggle) {
                toggleMobileActions(mobileToggle.closest('tr'));
                return;
            }
            const row = e.target.closest('tr.mf-record-row');
            if (row && !e.target.closest('a, button, input, select, textarea, label')) {
                clearTimeout(MF_ROW_CLICK_TIMER);
                const checkbox = row.querySelector('input[data-selection-id]');
                const now = performance.now();
                const doubleClick = MF_LAST_ROW_CLICK?.row === row && now - MF_LAST_ROW_CLICK.time < 450;
                MF_LAST_ROW_CLICK = { row, time: now };
                if (checkbox && (MF_SELECTED_IDS.size > 0 || doubleClick || e.detail >= 2)) {
                    mfSelectRow(row, e.detail < 2 && !doubleClick);
                    MF_LAST_ROW_CLICK = null;
                } else {
                    // Wait briefly so the first click of a double-click does not open a menu over the row.
                    const point = { clientX: e.clientX, clientY: e.clientY };
                    MF_ROW_CLICK_TIMER = setTimeout(() => {
                        if (row.isConnected) window.mfOpenContextMenu?.(point, row);
                    }, 450);
                }
                return;
            }
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const id = btn.dataset.id;
            const action = btn.dataset.action;
            if (action === 'view') startView(id);
            else if (action === 'edit') startEdit(id);
            else if (action === 'delete') deleteRecord(id);
            else if (typeof MF_CONFIG?.onAction === 'function') {
                const row = MF_RECORDS.find(r => String(r?.[MF_CONFIG.primaryKey]) === String(id))
                    || MF_FILTERED.find(r => String(r?.[MF_CONFIG.primaryKey]) === String(id));
                MF_CONFIG.onAction(action, id, row);
            }
        });

        tbody.addEventListener('dblclick', event => {
            const row = event.target.closest('tr.mf-record-row');
            if (!row || event.target.closest('a, button, input, select, textarea, label')) return;
            clearTimeout(MF_ROW_CLICK_TIMER);
            event.preventDefault();
            mfSelectRow(row);
        });

        tbody.addEventListener('pointerdown', (event) => {
            const value = event.target.closest('.mf-record-value');
            if (!value || event.pointerType === 'mouse') return;
            clearTimeout(MF_LONG_PRESS_TIMER);
            MF_LONG_PRESS_TIMER = setTimeout(() => {
                const rect = value.getBoundingClientRect();
                window.mfOpenContextMenu?.({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }, value.closest('tr'));
            }, 520);
        });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => {
            tbody.addEventListener(type, () => clearTimeout(MF_LONG_PRESS_TIMER));
        });
        tbody.addEventListener('contextmenu', (event) => {
            const value = event.target.closest('.mf-record-value');
            if (!value) return;
            event.preventDefault();
            if (typeof window.mfOpenContextMenu === 'function') window.mfOpenContextMenu(event, value.closest('tr'));
            else toggleMobileActions(value.closest('tr'));
        });
        tbody.addEventListener('keydown', (event) => {
            const value = event.target.closest('.mf-record-value');
            if (!value || !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            const rect = value.getBoundingClientRect();
            window.mfOpenContextMenu?.({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }, value.closest('tr'));
        });
    }

    // Clear validation errors as the user edits
    const container = document.getElementById('dynamicFields');
    if (container) {
        const clearIfEditable = (target) => {
            if (!target) return;
            if (!target.classList?.contains('form-control')) return;
            if (target.disabled || target.readOnly) return;
            target.classList.remove('error');
            const group = target.closest('.form-group');
            const msgEl = group?.querySelector('.error-message');
            if (msgEl) msgEl.textContent = '';
            const dateTrigger = group?.querySelector('.mf-academic-date-trigger');
            dateTrigger?.classList.remove('error');
            dateTrigger?.removeAttribute('aria-invalid');
        };
        container.addEventListener('input', (e) => {
            clearIfEditable(e.target);
            applyDateMask(e.target);
        });
        container.addEventListener('change', (e) => clearIfEditable(e.target));
    }

    document.addEventListener('click', event => {
        const trigger = event.target?.closest?.('[data-mf-academic-date-trigger]');
        if (trigger) {
            mfOpenAcademicDatePicker(trigger.dataset.fieldKey);
            return;
        }
        const state = MF_ACTIVE_ACADEMIC_DATE_PICKER;
        if (!state) return;
        const picker = document.getElementById(mfAcademicDatePickerId(state.fieldKey));
        const clickPath = event.composedPath?.() || [];
        if (picker && clickPath.includes(picker)) {
            mfHandleAcademicDatePickerClick(event, picker);
            return;
        }
        mfCloseAcademicDatePicker();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && MF_ACTIVE_ACADEMIC_DATE_PICKER) {
            mfCloseAcademicDatePicker(true);
        }
    });
    document.addEventListener('scroll', () => mfPositionAcademicDatePicker(), true);
    window.addEventListener('resize', mfPositionAcademicDatePicker);
}

function toggleMobileActions(row) {
    if (!row) return;
    if (!row.querySelector('.mf-mobile-actions')) {
        const value = row.querySelector('.mf-record-value');
        const rect = value?.getBoundingClientRect();
        window.mfOpenContextMenu?.({
            clientX: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
            clientY: rect ? rect.top + rect.height / 2 : window.innerHeight / 2
        }, row);
        return;
    }
    const open = row.classList.toggle('mf-actions-open');
    const toggle = row.querySelector('[data-mobile-actions-toggle]');
    if (toggle) {
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? 'Hide actions' : 'Show actions');
    }
}

// Text-only, native-style context menu for desktop right-click actions.
function mfCloseContextMenu() {
    document.getElementById('mfContextMenu')?.remove();
    document.body.classList.remove('mf-mobile-sheet-open');
}

window.mfOpenContextMenu = function(event, row, options = {}) {
    if (!row) return;
    mfCloseContextMenu();
    const sourceButtons = [...row.querySelectorAll('.mf-row-action-source button[data-action]')];
    if (!sourceButtons.length) return;
    const menu = document.createElement('div');
    menu.id = 'mfContextMenu';
    menu.className = 'mf-context-menu';
    if (options?.position === 'point') menu.dataset.position = 'point';
    menu.setAttribute('role', 'menu');
    sourceButtons.forEach(source => {
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
        item.addEventListener('click', () => { mfCloseContextMenu(); source.click(); });
        menu.append(item);
    });
    document.body.append(menu);
    if (window.matchMedia?.('(max-width: 768px)').matches) {
        document.body.classList.add('mf-mobile-sheet-open');
    }
    const margin = 8;
    const x = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - margin);
    const y = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - margin);
    const pointMenu = options?.position === 'point';
    menu.style.setProperty('left', `${Math.max(margin, x)}px`, pointMenu ? 'important' : '');
    menu.style.setProperty('top', `${Math.max(margin, y)}px`, pointMenu ? 'important' : '');
    const close = (closeEvent) => {
        if (closeEvent.type === 'keydown' && closeEvent.key !== 'Escape') return;
        if (!menu.contains(closeEvent.target) || closeEvent.key === 'Escape') {
            mfCloseContextMenu();
            document.removeEventListener('pointerdown', close);
            document.removeEventListener('keydown', close);
        }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
};

async function loadReferenceData() {
    // Get all fields from either fieldSections or fields array
    const allFields = MF_CONFIG.fieldSections
        ? MF_CONFIG.fieldSections.flatMap(section => section.fields)
        : (MF_CONFIG.fields || []);

    const promises = allFields
        .filter(f => f.type === 'select' && (typeof f.loadOptions === 'function' || Array.isArray(f.options)))
        .map(async (field) => {
            try {
                let options;
                if (typeof field.loadOptions === 'function') {
                    options = await field.loadOptions();
                } else {
                    // Static options array — normalise to {value, label} shape so
                    // populateSelect can use valueKey/labelKey as normal.
                    const vk = field.valueKey || 'value';
                    const lk = field.labelKey || 'label';
                    options = field.options.map(o => ({ [vk]: o.value, [lk]: o.label }));
                    field = { ...field, valueKey: vk, labelKey: lk };
                }
                MF_SELECT_OPTIONS[field.key] = options;
                populateSelect(field, options);
            } catch (error) {
                console.error(`Error loading options for ${field.key}:`, error);
                MF_SELECT_OPTIONS[field.key] = [];
            }
        });
    await Promise.all(promises);
}

async function loadRecords() {
    showLoading();
    try {
        const params = typeof MF_CONFIG.listParams === 'function' ? MF_CONFIG.listParams() : undefined;
        const data = params ? await MF_CONFIG.api.list(params) : await MF_CONFIG.api.list();
        MF_RECORDS = Array.isArray(data)
            ? data
            : (Array.isArray(data?.rows) ? data.rows : (data?.data || []));
        const validIds = new Set(MF_RECORDS.map(row => String(row?.[MF_CONFIG.primaryKey] ?? '')).filter(Boolean));
        [...MF_SELECTED_IDS].forEach(id => { if (!validIds.has(id)) MF_SELECTED_IDS.delete(id); });
        MF_FILTERED = [...MF_RECORDS];
        MF_CURRENT_PAGE = 1;
        renderTable();
    } catch (error) {
        console.error('Load error', error);
        const serverMessage = error?.response?.data?.message;
        const fallback = error?.message || 'Failed to load records.';
        showError(serverMessage || fallback);
    }
}

function renderTable() {
    clearTimeout(MF_ROW_CLICK_TIMER);
    MF_LAST_ROW_CLICK = null;
    const tbody = document.getElementById('dataTableBody');
    if (!tbody) return;

    if (!MF_FILTERED.length) {
        tbody.innerHTML = `<tr class="mf-state-row"><td colspan="${mfTableColSpan()}" class="text-center"><div class="empty-state">${mfEmptyVideoMarkup()}<h3>No records</h3><p>No records match your criteria</p></div></td></tr>`;
        updateBulkControls();
        updatePaginationInfo(0, 0, 0);
        updatePaginationButtons(1, 1);
        mfAfterTableRender([]);
        return;
    }

    let data = [...MF_FILTERED];
    if (MF_SORT_KEY) {
        data.sort((a, b) => {
            const aVal = a[MF_SORT_KEY] ?? '';
            const bVal = b[MF_SORT_KEY] ?? '';
            if (aVal === bVal) return 0;
            if (MF_SORT_DIR === 'asc') return aVal > bVal ? 1 : -1;
            return aVal < bVal ? 1 : -1;
        });
    }

    const pageSize = mfItemsPerPage();
    const totalPages = Math.max(1, Math.ceil(data.length / pageSize));
    if (MF_CURRENT_PAGE > totalPages) MF_CURRENT_PAGE = totalPages;
    const start = (MF_CURRENT_PAGE - 1) * pageSize;
    const end = Math.min(start + pageSize, data.length);
    const pageData = data.slice(start, end);

    tbody.innerHTML = pageData.map(row => renderRow(row)).join('');
    updateBulkControls();
    updatePaginationInfo(start + 1, end, data.length);
    updatePaginationButtons(MF_CURRENT_PAGE, totalPages);
    mfAfterTableRender(pageData);
}

function renderRow(row) {
    const id = row[MF_CONFIG.primaryKey];
    const idString = String(id ?? '');
    const primaryColumn = mfPrimaryColumn();
    const visibleColumns = mfVisibleColumns();
    const rowAttr = (id === undefined || id === null || id === '')
        ? ''
        : ` data-row-id="${mfEscapeAttr(id)}"`;

    const formatValue = (col) => col.formatter
        ? col.formatter(row[col.key], row)
        : (mfUsesArchive() ? mfEscapeAttr(row[col.key] ?? '') : (row[col.key] ?? ''));
    const cells = visibleColumns.map(col => {
        const value = formatValue(col);
        const colKey = mfEscapeAttr(col.key || '');
        const isPrimary = primaryColumn?.key === col.key;
        const isNameColumn = /(^|_)(full_name|display_name)(_|$)/i.test(String(col?.key || ''))
            || /full\s*name/i.test(String(col?.label || ''));
        const mobileMeta = isPrimary
            ? `<div class="mf-mobile-meta">${visibleColumns.filter(item => item.key !== col.key && !mfIsMobileHiddenColumn(item)).map(item => `<span class="mf-meta-item${mfIsTeacherColumn(item) ? ' mf-teacher-meta' : ''}">${formatValue(item) || '—'}</span>`).join('')}</div>`
            : '';
        const valueClass = isPrimary ? 'mf-primary-value' : '';
        const renderedValue = isPrimary && isNameColumn
            ? `<span class="mf-name-with-avatar"><span class="mf-record-avatar gender-${mfNormalizeGender(row?.gender)}" aria-hidden="true">${mfEscapeAttr(mfRecordInitials(row, value))}</span><span class="${valueClass}">${value || '—'}</span></span>`
            : `<span class="${valueClass}">${value || '—'}</span>`;
        return `<td data-col-key="${colKey}" data-label="${mfEscapeAttr(col.label)}" class="mf-data-cell${isPrimary ? ' mf-primary-cell' : ''}"><div class="mf-record-value" tabindex="0" aria-label="Show actions for ${mfEscapeAttr(String(value || col.label))}">${renderedValue}${mobileMeta}${isPrimary ? '<!--MF_ACTION_TRIGGER-->' : ''}</div>${isPrimary ? '<!--MF_ACTION_SOURCE-->' : ''}</td>`;
    }).join('');

    let mobileSummary = '';
    if (typeof MF_CONFIG?.mobileSummaryFormatter === 'function') {
        try {
            const summary = MF_CONFIG.mobileSummaryFormatter(row);
            if (summary) {
                const label = mfEscapeAttr(MF_CONFIG.mobileSummaryLabel ?? 'Additional details');
                mobileSummary = `<td class="mf-mobile-summary-cell" data-label="${label}">${summary}</td>`;
            }
        } catch (_) {
            mobileSummary = '';
        }
    }

    if (mfHideActions()) {
        return `<tr${rowAttr} class="mf-record-row">${cells}${mobileSummary}</tr>`;
    }

    const viewBtn = mfCanView()
        ? `<button class="action-btn view" data-action="view" data-id="${id}"><i class="fas fa-eye"></i></button>`
        : '';

    const extraActions = (() => {
        const ra = MF_CONFIG?.rowActions;
        if (!ra) return [];
        if (typeof ra === 'function') {
            try {
                const out = ra(row);
                return Array.isArray(out) ? out : [];
            } catch (_) {
                return [];
            }
        }
        return Array.isArray(ra) ? ra : [];
    })();

    const extraBtns = extraActions.map((a) => {
        const action = mfEscapeAttr(a?.action || '');
        if (!action) return '';
        const title = mfEscapeAttr(a?.title || a?.label || action);
        const icon = mfEscapeAttr(a?.iconClass || 'fa-file-lines');
        const variant = mfEscapeAttr(a?.variant || 'view');
        return `<button class="action-btn ${variant}" data-action="${action}" data-id="${id}" title="${title}"><i class="fas ${icon}"></i></button>`;
    }).join('');

    const editBtn = !mfCanEditRow(row)
        ? ''
        : `<button class="action-btn edit" data-action="edit" data-id="${id}"><i class="fas fa-edit"></i></button>`;
    const delBtn = !mfCanDeleteRow(row)
        ? ''
        : `<button class="action-btn delete" data-action="delete" data-id="${id}" title="${mfUsesArchive() ? 'Archive' : 'Delete'}" aria-label="${mfUsesArchive() ? 'Archive' : 'Delete'}"><i class="fas ${mfUsesArchive() ? 'fa-box-archive' : 'fa-trash'}"></i></button>`;
    const actions = `${viewBtn}${extraBtns}${editBtn}${delBtn}`;
    const selection = mfCanSelect()
        ? `<td class="mf-select-cell"><input type="checkbox" data-selection-id="${mfEscapeAttr(idString)}" aria-label="Select record"${MF_SELECTED_IDS.has(idString) ? ' checked' : ''}></td>`
        : '';
    const mobileTrigger = `<button type="button" class="mf-mobile-action-toggle" data-mobile-actions-toggle aria-expanded="false" aria-label="Show actions" title="Show actions"><i class="fas fa-ellipsis-vertical" aria-hidden="true"></i></button>`;
    const cellsWithActions = cells
        .replace('<!--MF_ACTION_TRIGGER-->', mobileTrigger)
        .replace('<!--MF_ACTION_SOURCE-->', `<div class="mf-row-action-source" hidden>${actions}</div>`);
    return `<tr${rowAttr} class="mf-record-row${mfCanSelect() ? ' mf-selectable' : ''}">${selection}${cellsWithActions}${mobileSummary}</tr>`;
}

function showLoading() {
    const tbody = document.getElementById('dataTableBody');
    if (tbody) {
        tbody.innerHTML = `<tr class="mf-state-row"><td colspan="${mfTableColSpan()}" class="text-center"><div class="empty-state"><i class="fas fa-spinner fa-spin"></i><h3>Loading records</h3><p>Please wait...</p></div></td></tr>`;
    }
}

function showError(message) {
    const tbody = document.getElementById('dataTableBody');
    if (tbody) {
        tbody.innerHTML = `<tr class="mf-state-row"><td colspan="${mfTableColSpan()}" class="text-center"><div class="empty-state"><i class="fas fa-circle-exclamation"></i><h3>Unable to load records</h3><p>${message}</p></div></td></tr>`;
    }
}

function filterRecords(term) {
    const lower = (term || '').toLowerCase();
    MF_FILTERED = !lower ? [...MF_RECORDS] : MF_RECORDS.filter(row => Object.values(row).some(val => String(val || '').toLowerCase().includes(lower)));
    MF_CURRENT_PAGE = 1;
    renderTable();
}

function changePage(delta) {
    const pageSize = mfItemsPerPage();
    const totalPages = Math.max(1, Math.ceil(MF_FILTERED.length / pageSize));
    const next = MF_CURRENT_PAGE + delta;
    if (next >= 1 && next <= totalPages) {
        MF_CURRENT_PAGE = next;
        renderTable();
    }
}

    function mfGoToRowById(rowId) {
        if (!MF_CONFIG || !MF_CONFIG.primaryKey) return false;
        if (rowId === undefined || rowId === null || rowId === '') return false;

        const idx = MF_FILTERED.findIndex((row) => String(row?.[MF_CONFIG.primaryKey]) === String(rowId));
        if (idx < 0) return false;

        const targetPage = Math.floor(idx / mfItemsPerPage()) + 1;
        if (targetPage !== MF_CURRENT_PAGE) {
            MF_CURRENT_PAGE = targetPage;
            renderTable();
        }
        return true;
    }

    function mfFindRowIdByPredicate(predicateFn) {
        if (typeof predicateFn !== 'function' || !MF_CONFIG || !MF_CONFIG.primaryKey) return null;
        const hit = MF_FILTERED.find((row) => {
            try {
                return Boolean(predicateFn(row));
            } catch (_) {
                return false;
            }
        });
        return hit ? hit[MF_CONFIG.primaryKey] : null;
    }

function updatePaginationInfo(from, to, total) {
    setText('showingFrom', from);
    setText('showingTo', to);
    setText('totalRecords', total);
    setText('currentPage', MF_CURRENT_PAGE);
    setText('totalPages', Math.max(1, Math.ceil((total || 1) / mfItemsPerPage())));
}

function updatePaginationButtons(current, total) {
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    if (prevBtn) prevBtn.disabled = current <= 1;
    if (nextBtn) nextBtn.disabled = current >= total;
}

function openAddModal() {
    if (MF_CONFIG?.disableAdd) return;
    mfCloseAcademicDatePicker();
    MF_MODAL_MODE = 'add';
    MF_CURRENT_ID = null;
    setText('modalTitle', `Add ${MF_CONFIG.entity}`);
    setText('saveButtonText', `Save ${MF_CONFIG.entity}`);
    setSaveButtonVisible(true);
    resetForm();
    openModal();
    if (typeof MF_CONFIG?.beforeOpenAdd === 'function') {
        Promise.resolve()
            .then(() => MF_CONFIG.beforeOpenAdd())
            .catch(error => console.error('Unable to refresh add-form options:', error));
    }
}

function setModalFieldValue(field, record) {
    const input = document.getElementById(`field-${field.key}`);
    if (!input) return;

    const value = record[field.key];
    if (field.type === 'readonly-reference') {
        const displayKey = field.displayKey || field.viewDisplayKey || `${field.key}_display_name`;
        const label = record[displayKey] ?? field.emptyText ?? 'Not assigned';
        input.textContent = String(label || field.emptyText || 'Not assigned');
        input.dataset.referenceValue = value === null || value === undefined ? '' : String(value);
        return;
    }
    if (field.type === 'checkbox') {
        input.checked = value === 1 || value === true || value === '1';
        return;
    }

    const displayValue = typeof field.displayTransform === 'function' ? field.displayTransform(value) : value;
    if (field.type === 'select' && MF_MODAL_MODE === 'view') {
        const valueKey = field.valueKey || 'value';
        const labelKey = field.labelKey || 'label';
        const options = MF_SELECT_OPTIONS[field.key] || [];
        const matchedOption = options.find(option => String(option?.[valueKey] ?? '') === String(displayValue ?? ''));
        const recordLabel = record[field.viewDisplayKey] ?? record[field.optionLabelKey];
        const optionLabel = matchedOption?.[labelKey];
        const label = recordLabel != null && String(recordLabel).trim() !== ''
            ? recordLabel
            : (optionLabel != null && String(optionLabel).trim() !== ''
                ? optionLabel
                : (displayValue === null || displayValue === undefined ? '' : displayValue));

        // View mode should show the saved record label even when the related
        // option is inactive, missing from the reference list, or has a
        // differently formatted value. Keep the control disabled, but give it
        // one explicit selected option so the browser can display that label.
        input.replaceChildren();
        if (label !== '') {
            const option = document.createElement('option');
            option.value = displayValue === null || displayValue === undefined || String(displayValue) === ''
                ? String(label)
                : String(displayValue);
            option.textContent = String(label);
            option.selected = true;
            input.appendChild(option);
            input.value = option.value;
        } else {
            input.value = '';
        }
        return;
    }

    if (field.type === 'select' && displayValue !== null && displayValue !== undefined && displayValue !== '') {
        const hasOption = Array.from(input.options).some(option => String(option.value) === String(displayValue));
        if (!hasOption) {
            const option = document.createElement('option');
            option.value = String(displayValue);
            option.textContent = record[field.viewDisplayKey]
                ?? record[field.optionLabelKey]
                ?? record[field.labelKey]
                ?? String(displayValue);
            input.appendChild(option);
        }
    }
    input.value = displayValue ?? '';
    if (field.type === 'select') {
        const selected = Array.from(input.options).find(option => String(option.value) === String(input.value));
        if (selected) selected.selected = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        window.syncFloatingSelect?.(input);
    }
}

async function startView(id) {
    const record = MF_RECORDS.find(r => String(r[MF_CONFIG.primaryKey]) === String(id));
    if (!record) return;
    mfCloseAcademicDatePicker();

    MF_MODAL_MODE = 'view';
    MF_CURRENT_ID = record[MF_CONFIG.primaryKey];
    setText('modalTitle', `View ${MF_CONFIG.entity}`);

    // Get all fields from either fieldSections or fields array
    const allFields = MF_CONFIG.fieldSections
        ? MF_CONFIG.fieldSections.flatMap(section => section.fields)
        : (MF_CONFIG.fields || []);

    setFieldVisibilityForMode(allFields, 'view');
    allFields.forEach(field => {
        setModalFieldValue(field, record);
        if (field.type === 'academic-date') mfUpdateAcademicDateDisplay(field.key);
    });

    lockAllFields(allFields);
    setSaveButtonVisible(false);

    if (typeof MF_CONFIG?.beforeOpenView === 'function') {
        try {
            await MF_CONFIG.beforeOpenView(record);
        } catch (error) {
            console.error('Unable to load view-only related records:', error);
        }
    }

    openModal();

    if (typeof MF_CONFIG?.afterOpenView === 'function') {
        try {
            await MF_CONFIG.afterOpenView(record);
        } catch (error) {
            console.error('Unable to finalize view-only related records:', error);
        }
    }
}

async function startEdit(id) {
    const record = MF_RECORDS.find(r => String(r[MF_CONFIG.primaryKey]) === String(id));
    if (!record) return;
    if (!mfCanEditRow(record)) {
        showNotification('This record is locked and cannot be edited.', 'error');
        return;
    }
    mfCloseAcademicDatePicker();
    MF_MODAL_MODE = 'edit';
    MF_CURRENT_ID = record[MF_CONFIG.primaryKey];
    setText('modalTitle', `Edit ${MF_CONFIG.entity}`);
    setText('saveButtonText', `Update ${MF_CONFIG.entity}`);
    setSaveButtonVisible(true);

    const openModalBeforeAsyncEdit = MF_CONFIG?.openModalBeforeAsyncEdit === true;

    // Get all fields from either fieldSections or fields array
    const allFields = MF_CONFIG.fieldSections
        ? MF_CONFIG.fieldSections.flatMap(section => section.fields)
        : (MF_CONFIG.fields || []);

    const populateEditFields = () => {
        setFieldVisibilityForMode(allFields, 'edit');
        allFields.forEach(field => {
            setModalFieldValue(field, record);
            if (field.type === 'academic-date') mfUpdateAcademicDateDisplay(field.key);
        });
        applyFieldEditability(allFields, true);
    };

    // Pages with related data may need asynchronous setup before the editor is
    // fully hydrated. Open the modal first when requested so a slow related
    // request cannot make the Edit action appear to do nothing.
    if (openModalBeforeAsyncEdit) {
        populateEditFields();
        openModal();
    }

    if (typeof MF_CONFIG?.beforeOpenEdit === 'function') {
        try {
            await MF_CONFIG.beforeOpenEdit(record);
        } catch (error) {
            console.error('Unable to refresh edit-form options:', error);
        }
    }

    if (!openModalBeforeAsyncEdit) {
        populateEditFields();
    }

    if (!openModalBeforeAsyncEdit && !MF_CONFIG?.deferModalOpenUntilAfterEdit) {
        openModal();
    }

    // Some pages resolve related records asynchronously. Run a page-specific
    // finalizer after every generic field has been populated so that a mapped
    // value cannot be overwritten by the select placeholder during modal
    // setup.
    if (typeof MF_CONFIG?.afterOpenEdit === 'function') {
        try {
            await MF_CONFIG.afterOpenEdit(record);
        } catch (error) {
            console.error('Unable to finalize edit-form values:', error);
        }
    }

    if (!openModalBeforeAsyncEdit && MF_CONFIG?.deferModalOpenUntilAfterEdit) {
        openModal();
    }
}

function resetForm() {
    // Get all fields from either fieldSections or fields array
    const allFields = MF_CONFIG.fieldSections
        ? MF_CONFIG.fieldSections.flatMap(section => section.fields)
        : (MF_CONFIG.fields || []);

    setFieldVisibilityForMode(allFields, 'add');
    allFields.forEach(field => {
        const el = document.getElementById(`field-${field.key}`);
        if (!el) return;
        if (field.type === 'readonly-reference') {
            el.textContent = field.emptyText || 'Not assigned';
        } else if (field.type === 'checkbox') {
            el.checked = Boolean(field.defaultValue);
        } else if (field.defaultValue !== undefined) {
            el.value = field.defaultValue;
        } else {
            el.value = '';
        }
        if (field.type === 'academic-date') mfUpdateAcademicDateDisplay(field.key);
    });

    applyFieldEditability(allFields, Boolean(MF_CURRENT_ID));
}

function applyFieldEditability(allFields, isEdit) {
    (allFields || []).forEach((field) => {
        const el = document.getElementById(`field-${field.key}`);
        if (!el) return;

        // Always clear view-mode disabling when leaving View.
        // (View uses disabled=true for all controls.)
        try {
            el.disabled = false;
        } catch (_) {
            // ignore
        }
        try {
            el.readOnly = false;
        } catch (_) {
            // ignore
        }

        const shouldLock = Boolean(
            field.readonly ||
            (isEdit ? field.readonlyOnEdit : field.readonlyOnAdd)
        );

        // For add/edit modes, we prefer readOnly for text-like inputs
        // and disabled for controls that don't support readOnly.
        if (field.type === 'checkbox' || field.type === 'select') {
            el.disabled = shouldLock;
            return;
        }

        if (field.type === 'academic-date') {
            const trigger = document.getElementById(mfAcademicDateTriggerId(field.key));
            if (trigger) trigger.disabled = shouldLock;
            el.readOnly = shouldLock;
            return;
        }

        // Some input types (e.g., date) still allow picker interaction when readOnly.
        // Only use disabled if explicitly requested by config; otherwise keep readOnly.
        el.readOnly = shouldLock;
    });
}

async function saveRecord() {
    if (MF_MODAL_MODE === 'view') {
        closeModal({ skipConfirm: true });
        return;
    }
    // Get all fields from either fieldSections or fields array
    const allFields = MF_CONFIG.fieldSections
        ? MF_CONFIG.fieldSections.flatMap(section => section.fields)
        : (MF_CONFIG.fields || []);

    const payload = {};
    const invalidFields = [];

    mfClearAllFieldErrors(allFields);
    for (const field of allFields) {
        if (field.type === 'readonly-reference') continue;
        const el = document.getElementById(`field-${field.key}`);
        if (!el) continue;
        let value;
        if (field.type === 'checkbox') {
            value = el.checked ? 1 : 0;
        } else {
            value = el.value?.trim();
            if (field.type === 'number' && value !== '') {
                value = Number(value);
            }
            if (typeof field.transform === 'function') {
                value = field.transform(value);
            }
        }

        if (field.required && (value === '' || value === undefined || value === null)) {
            invalidFields.push(field);
            mfSetFieldError(field.key, 'This field is required.');
        } else if (value !== '' && value !== undefined && value !== null) {
            // Pattern validation
            if (field.pattern) {
                try {
                    const regex = new RegExp(field.pattern, field.patternFlags || '');
                    if (!regex.test(String(value))) {
                        invalidFields.push(field);
                        mfSetFieldError(field.key, field.patternMessage || `${field.label} is invalid.`);
                    }
                } catch (_) {
                    // ignore malformed regex
                }
            }

            // Custom validation callback (receives current value and growing payload)
            if (!invalidFields.includes(field) && typeof field.validate === 'function') {
                const message = field.validate(value, payload);
                if (typeof message === 'string' && message !== '') {
                    invalidFields.push(field);
                    mfSetFieldError(field.key, message);
                }
            }

            if (!invalidFields.includes(field) && mfHasDuplicateUniqueValue(field, value)) {
                invalidFields.push(field);
                mfSetFieldError(
                    field.key,
                    field.uniqueMessage || `${field.label} already taken. Choose a different value.`
                );
            }
        }

        if (field.omitIfEmpty && (value === '' || value === undefined || value === null)) {
            continue;
        }
        payload[field.key] = value;
    }

    // Cross-field validation (e.g. date hired vs birth date)
    if (typeof MF_CONFIG?.validate === 'function' && !invalidFields.length) {
        const crossResult = MF_CONFIG.validate(payload);
        if (crossResult) {
            if (typeof crossResult === 'string' && crossResult !== '') {
                showNotification(crossResult, 'error');
                return;
            }
            if (typeof crossResult === 'object') {
                for (const [key, message] of Object.entries(crossResult)) {
                    const field = allFields.find(f => f.key === key);
                    if (field) {
                        invalidFields.push(field);
                        mfSetFieldError(field.key, message);
                    } else {
                        showNotification(`${key}: ${message}`, 'error');
                    }
                }
            }
        }
    }

    if (invalidFields.length) {
        const first = invalidFields[0];
        const firstEl = first.type === 'academic-date'
            ? document.getElementById(mfAcademicDateTriggerId(first.key))
            : (document.getElementById(`field-${first.key}-floating-trigger`) || document.getElementById(`field-${first.key}`));
        try {
            firstEl?.focus?.();
            firstEl?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        } catch (_) {
            // ignore
        }
        const invalidLabels = [...new Set(invalidFields
            .map(field => String(field?.label || '').trim())
            .filter(Boolean))];
        const validationMessage = invalidLabels.length === 1
            ? `Please complete or correct the ${invalidLabels[0]} field.`
            : `Please complete or correct these fields: ${invalidLabels.join(', ')}.`;
        showNotification(validationMessage, 'error');
        return;
    }

    try {
        if (MF_CURRENT_ID) {
            await MF_CONFIG.api.update(MF_CURRENT_ID, payload);
            showNotification(`${MF_CONFIG.entity} updated.`);
        } else {
            await MF_CONFIG.api.create(payload);
            showNotification(`${MF_CONFIG.entity} created.`);
        }
        closeModal({ skipConfirm: true });
        loadRecords();
    } catch (error) {
        console.error('Save error', error);
        const apiMessage = error?.response?.data?.message;
        if (error?.response?.status === 422 && error?.response?.data?.errors) {
            // Surface per-field API validation messages
            const visibleMessages = [];
            const fallbackMessages = [];
            Object.entries(error.response.data.errors).forEach(([key, msg]) => {
                const field = allFields.find(f => f.key === key);
                const text = Array.isArray(msg) ? msg.join(' ') : String(msg || '').trim();
                if (!text) return;
                if (field) {
                    mfSetFieldError(key, text);
                    visibleMessages.push(text);
                } else {
                    fallbackMessages.push(`${key}: ${text}`);
                }
            });
            const specificMessage = fallbackMessages[0] || visibleMessages[0] || apiMessage;
            showNotification(specificMessage || 'Please review the form and try again.', 'error');
        } else {
            showNotification(apiMessage || error?.message || 'Unable to save. Please try again.', 'error');
        }
    }
}

function lockAllFields(allFields) {
    (allFields || []).forEach((field) => {
        const el = document.getElementById(`field-${field.key}`);
        if (!el) return;

        // In View mode, fully disable all controls to avoid any interaction.
        try {
            el.disabled = true;
        } catch (_) {
            // ignore
        }
        try {
            el.readOnly = true;
        } catch (_) {
            // ignore
        }
        if (field.type === 'academic-date') {
            const trigger = document.getElementById(mfAcademicDateTriggerId(field.key));
            if (trigger) trigger.disabled = true;
        }
    });
}

function setSaveButtonVisible(visible) {
    const saveText = document.getElementById('saveButtonText');
    const saveBtn = saveText?.closest('button');
    if (saveBtn) saveBtn.style.display = visible ? '' : 'none';
}

function mfPlainRecordText(value) {
    return String(value ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function mfGetRecordLabel(row) {
    if (!row) return '';
    if (typeof MF_CONFIG?.getRecordLabel === 'function') {
        const custom = mfPlainRecordText(MF_CONFIG.getRecordLabel(row));
        if (custom) return custom;
    }
    const columns = mfVisibleColumns();
    const primaryColumn = mfPrimaryColumn();
    const candidates = [
        primaryColumn,
        ...columns.filter(col => /name|title|label|description|code|year/i.test(String(col?.key || col?.label || ''))),
        ...columns
    ].filter(Boolean);
    for (const column of candidates) {
        const raw = column.formatter ? column.formatter(row[column.key], row) : row[column.key];
        const text = mfPlainRecordText(raw);
        if (text) return text;
    }
    return mfPlainRecordText(row[MF_CONFIG.primaryKey]);
}

function showConfirmDialog(title, message, options = {}) {
    const intent = options.intent || (mfUsesArchive() ? 'archive' : 'delete');
    if (typeof window.mfConfirm !== 'function') {
        return Promise.resolve(window.confirm(`${title}\n\n${message}`));
    }
    return window.mfConfirm({
        title,
        message,
        intent,
        eyebrow: options.eyebrow,
        confirmLabel: options.confirmLabel || (mfUsesArchive() ? 'Archive' : 'Delete')
    });
}

async function deleteRecord(id) {
    const record = MF_RECORDS.find(r => String(r?.[MF_CONFIG.primaryKey]) === String(id))
        || MF_FILTERED.find(r => String(r?.[MF_CONFIG.primaryKey]) === String(id));
    if (!mfCanDeleteRow(record)) {
        showNotification('This record cannot be archived.', 'error');
        return;
    }
    const entityName = String(MF_CONFIG.entity || 'record').toLowerCase();
    const recordLabel = mfGetRecordLabel(record);
    const confirmed = await showConfirmDialog(
        mfUsesArchive()
            ? `Archive ${recordLabel ? `“${recordLabel}”` : entityName}?`
            : `Delete ${recordLabel ? `“${recordLabel}”` : entityName}?`,
        mfUsesArchive()
            ? (MF_CONFIG.archiveConfirmMessage || `This ${entityName} will be hidden from the active list and kept in View archive. You can restore it later.`)
            : `This ${entityName} will be permanently deleted. This action cannot be undone.`,
        { intent: mfUsesArchive() ? 'archive' : 'delete' }
    );
    if (!confirmed) return;
    try {
        const result = await MF_CONFIG.api.remove(id);
        if (result?.success === false) throw new Error(result.message || 'Unable to complete the action.');
        showNotification(`${MF_CONFIG.entity} ${mfUsesArchive() ? 'archived' : 'deleted'}.`);
        loadRecords();
    } catch (error) {
        console.error('Delete error', error);
        showNotification(error?.response?.data?.message || error.message || (mfUsesArchive() ? 'Unable to archive. Please try again.' : 'Unable to delete. Please try again.'), 'error');
    }
}

function populateSelect(field, options = []) {
    const select = document.getElementById(`field-${field.key}`);
    if (!select) return;
    select.innerHTML = `<option value="">Select ${field.label}</option>` + options.map(opt => `<option value="${opt[field.valueKey]}"${field.defaultValue && field.defaultValue === opt[field.valueKey] ? ' selected' : ''}>${opt[field.labelKey]}</option>`).join('');
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function openModal() {
    const modal = document.getElementById('recordModal');
    if (modal) {
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
    }
}

function closeModal(options = {}) {
    const skipConfirm = Boolean(options?.skipConfirm);
    if (!skipConfirm) {
        if (MF_CLOSE_CONFIRM_PENDING) return;
        if (typeof MF_CONFIG?.confirmClose === 'function') {
            let decision;
            try {
                decision = MF_CONFIG.confirmClose();
            } catch (error) {
                console.error('Unable to confirm modal close:', error);
                decision = true;
            }
            if (decision && typeof decision.then === 'function') {
                MF_CLOSE_CONFIRM_PENDING = true;
                Promise.resolve(decision).then(allowClose => {
                    MF_CLOSE_CONFIRM_PENDING = false;
                    if (allowClose !== false) closeModal({ skipConfirm: true });
                }).catch(error => {
                    MF_CLOSE_CONFIRM_PENDING = false;
                    console.error('Unable to confirm modal close:', error);
                });
                return;
            }
            if (decision === false) return;
        }
    }
    mfCloseAcademicDatePicker();
    const modal = document.getElementById('recordModal');
    if (modal) {
        modal.classList.remove('show');
        document.body.style.overflow = '';
    }
}

window.onclick = function(event) {
    const modal = document.getElementById('recordModal');
    if (event.target === modal) {
        closeModal();
    }
};

let MF_NOTIFICATION_EL = null;
let MF_NOTIFICATION_TIMER = null;

function showNotification(message, type = 'success') {
    if (MF_NOTIFICATION_EL) {
        MF_NOTIFICATION_EL.remove();
        MF_NOTIFICATION_EL = null;
    }
    if (MF_NOTIFICATION_TIMER) {
        clearTimeout(MF_NOTIFICATION_TIMER);
        MF_NOTIFICATION_TIMER = null;
    }

    const ensureGovToastStyles = () => {
        if (document.getElementById('govToastStyles')) return;
        const style = document.createElement('style');
        style.id = 'govToastStyles';
        style.textContent = `
            .gov-toast{position:fixed;bottom:80px;right:20px;background:var(--gray-50);border:0;box-shadow:var(--shadow-sm);border-radius:6px;padding:.9rem 1rem;z-index:10001;min-width:320px;max-width:420px;opacity:0;transform:translateX(30px);transition:opacity .25s ease,transform .25s ease}
            .gov-toast.show{opacity:1;transform:translateX(0)}
            .gov-toast__content{display:flex;align-items:flex-start;gap:.75rem}
            .gov-toast__icon{font-size:1.1rem;margin-top:.05rem}
            .gov-toast__text{display:flex;flex-direction:column;gap:.15rem;min-width:0;flex:1}
            .gov-toast__title{font-size:.78rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--gray-700);line-height:1.15}
            .gov-toast__message{font-size:.92rem;color:var(--gray-900);line-height:1.35;word-break:break-word}
            .gov-toast__dismiss{background:transparent;border:none;color:var(--gray-500);font-size:1rem;cursor:pointer;line-height:1}
            .gov-toast--success{border:0}
            .gov-toast--success .gov-toast__icon{color:var(--gray-500)}
            .gov-toast--error{border:0}
            .gov-toast--error .gov-toast__icon{color:var(--color-danger)}
            .gov-toast--info{border:0}
            .gov-toast--info .gov-toast__icon{color:var(--gray-500)}
        `;
        document.head.appendChild(style);
    };

    ensureGovToastStyles();

    document.querySelectorAll('.gov-toast').forEach((el) => el.remove());

    const normalizedType = type === 'success' || type === 'error' || type === 'info' ? type : 'success';
    const title = normalizedType === 'success' ? 'Completed' : normalizedType === 'error' ? 'Action Required' : 'Notice';
    const iconClass = normalizedType === 'success' ? 'fa-circle-check' : normalizedType === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info';

    const toast = document.createElement('div');
    toast.className = `gov-toast gov-toast--${normalizedType}`;
    toast.innerHTML = `
        <div class="gov-toast__content">
            <i class="fas ${iconClass} gov-toast__icon"></i>
            <div class="gov-toast__text">
                <div class="gov-toast__title">${title}</div>
                <div class="gov-toast__message">${message}</div>
            </div>
            <button type="button" class="gov-toast__dismiss" aria-label="Dismiss">&times;</button>
        </div>
    `;

    document.body.appendChild(toast);
    MF_NOTIFICATION_EL = toast;

    requestAnimationFrame(() => toast.classList.add('show'));

    const timeoutMs = normalizedType === 'error' ? 9000 : 4500;

    const dismiss = () => {
        if (MF_NOTIFICATION_TIMER) {
            clearTimeout(MF_NOTIFICATION_TIMER);
            MF_NOTIFICATION_TIMER = null;
        }
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 250);
        MF_NOTIFICATION_EL = null;
    };

    const startTimer = () => {
        MF_NOTIFICATION_TIMER = setTimeout(dismiss, timeoutMs);
    };

    const dismissBtn = toast.querySelector('button[aria-label="Dismiss"]');
    if (dismissBtn) {
        dismissBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dismiss();
        });
    }
    toast.addEventListener('mouseenter', () => {
        if (MF_NOTIFICATION_TIMER) {
            clearTimeout(MF_NOTIFICATION_TIMER);
            MF_NOTIFICATION_TIMER = null;
        }
    });
    toast.addEventListener('mouseleave', () => {
        if (!MF_NOTIFICATION_TIMER) {
            startTimer();
        }
    });

    startTimer();
}

// Add animation styles if not already present
if (!document.getElementById('notificationStyles')) {
    const style = document.createElement('style');
    style.id = 'notificationStyles';
    style.textContent = `
        @keyframes slideInRight {
            from {
                opacity: 0;
                transform: translateX(100px);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }
        @keyframes slideOutRight {
            from {
                opacity: 1;
                transform: translateX(0);
            }
            to {
                opacity: 0;
                transform: translateX(100px);
            }
        }
    `;
    document.head.appendChild(style);
}

window.openAddModal = openAddModal;
window.saveRecord = saveRecord;
window.masterfileGoToRowById = mfGoToRowById;
window.masterfileFindRowIdByPredicate = mfFindRowIdByPredicate;
window.closeModal = closeModal;
window.reloadMasterfileRecords = loadRecords;
