const API_BASE_URL = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;

const setupApi = {
    defaults: async () => axios.get(`${API_BASE_URL}/academic_setup/academic_setup.php`, {
        params: { operation: 'getSetupDefaults' }
    }).then(r => r.data),
    create: async (data) => axios.post(`${API_BASE_URL}/academic_setup/academic_setup.php?operation=createAcademicYearSetup`, data).then(r => r.data)
};

const setupState = {
    defaults: null,
    gradeLevels: [],
    teachers: [],
    gradingSystems: [],
    activeCurriculum: null,
    sections: [],
    periodDates: {},
    editingPeriodNo: null,
    editingPeriodDates: null,
    selectedSectionIds: new Set(),
    lastSectionClick: null,
    sectionClickTimer: null,
    editingSectionId: null,
    dirty: false,
    hydrating: false,
    saving: false,
    firstPeriodAutoOpened: false
};

const academicDateMonths = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];
const academicDateWeekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const academicDatePickerState = { field: null, year: null, month: null, view: 'months' };
document.addEventListener('DOMContentLoaded', async () => {
    wireSetupEvents();
    installSetupLeaveGuard();
    await loadSetupDefaults();
});

function $(id) {
    return document.getElementById(id);
}

function setupHasUnsavedChanges() {
    return Boolean(setupState.dirty);
}

function setSetupDirty(isDirty = true, target = null) {
    if (setupState.hydrating || setupState.saving) return;
    setupState.dirty = Boolean(isDirty);
    const targetGroup = target?.closest?.('.setup-field');
    if (targetGroup) {
        targetGroup.classList.toggle('is-unsaved', setupState.dirty);
    } else if (setupState.dirty) {
        $('sectionsBody')?.classList.add('is-unsaved');
    }
    if (!setupState.dirty) {
        document.querySelectorAll('.setup-field.is-unsaved').forEach((group) => group.classList.remove('is-unsaved'));
        $('sectionsBody')?.classList.remove('is-unsaved');
    }
    const btn = $('saveSetupBtn');
    if (btn) {
        btn.classList.toggle('is-unsaved', setupState.dirty);
        btn.title = setupState.dirty ? 'Unsaved Academic Year Setup' : '';
    }
}

function clearSetupDirty() {
    setupState.dirty = false;
    document.querySelectorAll('.setup-field.is-unsaved').forEach((group) => group.classList.remove('is-unsaved'));
    $('sectionsBody')?.classList.remove('is-unsaved');
    const btn = $('saveSetupBtn');
    if (btn) {
        btn.classList.remove('is-unsaved');
        btn.title = '';
    }
}

async function closeOpenChoicesForUnsavedPrompt() {
    document.querySelectorAll('select').forEach(select => {
        try {
            select._choicesInstance?.hideDropdown();
            select._choicesInstance?.containerOuter?.element?.classList.remove('is-open');
        } catch (_) {}
    });
    document.querySelectorAll('.choices.is-open').forEach(choices => {
        choices.classList.remove('is-open', 'is-focused');
        choices.querySelector('.choices__list--dropdown.is-active, .choices__list[aria-expanded="true"]')?.classList.remove('is-active');
        choices.querySelector('.choices__list--dropdown, .choices__list[aria-expanded]')?.setAttribute('aria-expanded', 'false');
        choices.querySelector('.choices__input')?.blur();
    });
    document.querySelectorAll('.choices__list--dropdown.is-active, .choices__list[aria-expanded="true"]').forEach(dropdown => {
        dropdown.classList.remove('is-active');
        dropdown.setAttribute('aria-expanded', 'false');
        dropdown.closest('.choices')?.classList.remove('is-open', 'is-focused');
    });
    const active = document.activeElement;
    if (active && typeof active.blur === 'function') active.blur();
    await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
}

async function confirmLeaveSetup() {
    if (!setupHasUnsavedChanges()) return true;
    const title = 'Unsaved Academic Year Setup';
    const message = 'Finalize the Academic Year Setup first. Unsaved setup records will be lost.';
    if (typeof window.confirmUnsavedChanges === 'function') {
        return window.confirmUnsavedChanges({
            title,
            message,
            confirmLabel: 'Leave without saving',
            cancelLabel: 'Stay',
            beforeOpen: closeOpenChoicesForUnsavedPrompt
        });
    }

    await closeOpenChoicesForUnsavedPrompt();
    return window.confirm(`${title}\n\n${message}\n\nContinue without saving?`);
}

async function confirmFinalizeSetup(payload, periodCount) {
    const message = `Finalize ${payload.year_start}-${payload.year_end} with ${periodCount} grading period(s) and ${payload.sections.length} section(s)?`;
    if (typeof Swal !== 'undefined' && typeof Swal.fire === 'function') {
        const result = await Swal.fire({
            icon: 'question',
            title: 'Finalize Academic Year Setup',
            text: message,
            showCancelButton: true,
            confirmButtonText: 'Finalize Setup',
            cancelButtonText: 'Stay',
            confirmButtonColor: 'var(--deped-blue)',
            cancelButtonColor: '#64748b',
        });
        return !!result.isConfirmed;
    }
    return window.confirm(`${message}\n\nFinalize setup?`);
}

function installSetupLeaveGuard() {
    window.addEventListener('beforeunload', (event) => {
        if (!setupHasUnsavedChanges()) return;
        event.preventDefault();
        event.returnValue = '';
    });

    document.addEventListener('click', async (event) => {
        if (!setupHasUnsavedChanges() || setupState.saving) return;
        const link = event.target?.closest?.('a[href]');
        if (!link || link.hasAttribute('download') || link.target === '_blank') return;
        const href = String(link.getAttribute('href') || '');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        const destination = new URL(link.href, window.location.href);
        if (destination.href === window.location.href) return;
        event.preventDefault();
        event.stopPropagation();
        if (await confirmLeaveSetup()) {
            clearSetupDirty();
            window.location.href = link.href;
        }
    }, true);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function teacherName(teacher) {
    const last = teacher.last_name || '';
    const first = teacher.first_name || '';
    const middle = teacher.middle_name ? ` ${String(teacher.middle_name).charAt(0)}.` : '';
    const ext = teacher.name_extension ? ` ${teacher.name_extension}` : '';
    const name = `${last}, ${first}${middle}${ext}`.replace(/^,\s*/, '').trim();
    return name || teacher.employee_number || `Employee #${teacher.employee_id}`;
}

function showAlert(message, type = 'error') {
    const el = $('setupAlert');
    if (!el) return;
    el.className = `setup-alert show ${type}`;
    el.setAttribute('role', type === 'success' ? 'status' : 'alert');
    el.setAttribute('aria-live', type === 'success' ? 'polite' : 'assertive');
    el.innerHTML = message;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function dateInputId(field) {
    return ({ end: 'setupDateEnd', 'period-start': 'setupPeriodDateStart', 'period-end': 'setupPeriodDateEnd' })[field] || 'setupDateStart';
}

function dateDisplayId(field) {
    return ({ end: 'setupDateEndDisplay', 'period-start': 'setupPeriodDateStartDisplay', 'period-end': 'setupPeriodDateEndDisplay' })[field] || 'setupDateStartDisplay';
}

function datePickerId(field) {
    return ({ end: 'setupDateEndPicker', 'period-start': 'setupPeriodDateStartPicker', 'period-end': 'setupPeriodDateEndPicker' })[field] || 'setupDateStartPicker';
}

function parseAcademicDate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(year, month, day);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
    return { year, month, day };
}

function updateAcademicDateDisplay(inputId) {
    const field = ({ setupDateEnd: 'end', setupPeriodDateStart: 'period-start', setupPeriodDateEnd: 'period-end' })[inputId] || 'start';
    const input = $(inputId);
    const display = $(dateDisplayId(field));
    const valueTarget = display?.querySelector('.setup-date-trigger-value');
    if (!input || !valueTarget) return;
    const parsed = parseAcademicDate(input.value);
    valueTarget.textContent = parsed
        ? `${academicDateMonths[parsed.month]} ${parsed.day}, ${parsed.year}`
        : `Choose ${field.endsWith('end') ? 'end' : 'start'} date`;
    display.classList.toggle('has-value', Boolean(parsed));
}

function academicDateInitialYear(field) {
    const inputDate = parseAcademicDate($(dateInputId(field))?.value);
    if (field.startsWith('period-')) {
        const scope = academicDateScope();
        if (scope) {
            const preferredYear = inputDate?.year ?? (field === 'period-end' ? scope.parsedEnd.year : scope.parsedStart.year);
            return Math.max(scope.parsedStart.year, Math.min(scope.parsedEnd.year, preferredYear));
        }
    }
    if (inputDate) return inputDate.year;
    if (field.startsWith('period-')) {
        const boundary = parseAcademicDate($(field === 'period-end' ? 'setupDateEnd' : 'setupDateStart')?.value);
        if (boundary) return boundary.year;
    }
    const yearStart = Number($('setupYearStart')?.value || new Date().getFullYear());
    return field === 'end' || field === 'period-end' ? yearStart + 1 : yearStart;
}

function academicDateAllowed(field, isoDate) {
    if (!field.startsWith('period-')) return true;
    const scope = academicDateScope();
    if (!scope || isoDate < scope.start || isoDate > scope.end) return false;
    const oppositeDate = $(dateInputId(field === 'period-start' ? 'period-end' : 'period-start'))?.value || '';
    if (oppositeDate && field === 'period-start' && isoDate > oppositeDate) return false;
    if (oppositeDate && field === 'period-end' && isoDate < oppositeDate) return false;
    const currentPeriodNo = Number(setupState.editingPeriodNo || 0);
    const occupied = Object.entries(setupState.periodDates).some(([periodNo, dates]) =>
        Number(periodNo) !== currentPeriodNo
        && dates?.date_start && dates?.date_end
        && isoDate >= dates.date_start && isoDate <= dates.date_end
    );
    if (occupied) return false;
    return true;
}

function academicDateScope() {
    const start = $('setupDateStart')?.value || '';
    const end = $('setupDateEnd')?.value || '';
    const parsedStart = parseAcademicDate(start);
    const parsedEnd = parseAcademicDate(end);
    if (!parsedStart || !parsedEnd || start > end) return null;
    return { start, end, parsedStart, parsedEnd };
}

function academicDateYearAllowed(field, year) {
    if (!field.startsWith('period-')) return true;
    const scope = academicDateScope();
    return Boolean(scope && year >= scope.parsedStart.year && year <= scope.parsedEnd.year);
}

function academicDateMonthAllowed(field, year, month) {
    if (!field.startsWith('period-')) return true;
    const scope = academicDateScope();
    if (!scope) return false;
    const monthKey = year * 12 + month;
    const startKey = scope.parsedStart.year * 12 + scope.parsedStart.month;
    const endKey = scope.parsedEnd.year * 12 + scope.parsedEnd.month;
    return monthKey >= startKey && monthKey <= endKey;
}

function closeAcademicDatePicker(restoreFocus = false) {
    const field = academicDatePickerState.field;
    if (!field) return;
    const picker = $(datePickerId(field));
    const trigger = $(dateDisplayId(field));
    if (picker) picker.hidden = true;
    if (trigger) {
        trigger.setAttribute('aria-expanded', 'false');
        trigger.closest('.setup-date-field')?.classList.remove('is-open');
        if (restoreFocus) trigger.focus();
    }
    academicDatePickerState.field = null;
}

function openAcademicDatePicker(field) {
    if (academicDatePickerState.field === field) {
        closeAcademicDatePicker();
        return;
    }
    closeAcademicDatePicker();
    academicDatePickerState.field = field;
    academicDatePickerState.year = academicDateInitialYear(field);
    const selected = parseAcademicDate($(dateInputId(field))?.value);
    academicDatePickerState.month = selected?.month ?? null;
    academicDatePickerState.view = 'months';
    const trigger = $(dateDisplayId(field));
    const picker = $(datePickerId(field));
    if (!trigger || !picker) return;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.closest('.setup-date-field')?.classList.add('is-open');
    picker.hidden = false;
    renderAcademicDatePicker();
    picker.querySelector('[data-month].is-current')?.focus({ preventScroll: true });
}

function renderAcademicDatePicker() {
    const field = academicDatePickerState.field;
    const picker = field ? $(datePickerId(field)) : null;
    if (!picker) return;
    const { year, month, view } = academicDatePickerState;
    const selected = parseAcademicDate($(dateInputId(field))?.value);
    const scope = field.startsWith('period-') ? academicDateScope() : null;
    const previousYearDisabled = field.startsWith('period-') && (!scope || year <= scope.parsedStart.year);
    const nextYearDisabled = field.startsWith('period-') && (!scope || year >= scope.parsedEnd.year);
    const yearControls = `
        <button class="setup-date-nav" type="button" data-date-picker-action="previous-year" aria-label="Previous year"${previousYearDisabled ? ' disabled' : ''}><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
        <strong class="setup-date-year">${year}</strong>
        <button class="setup-date-nav" type="button" data-date-picker-action="next-year" aria-label="Next year"${nextYearDisabled ? ' disabled' : ''}><i class="fas fa-chevron-right" aria-hidden="true"></i></button>`;

    if (view === 'months') {
        picker.innerHTML = `
            <div class="setup-date-picker-header">${yearControls}<button class="setup-date-close" type="button" data-date-picker-action="close" aria-label="Close date picker"><i class="fas fa-times" aria-hidden="true"></i></button></div>
            <p class="setup-date-picker-hint">Choose a month</p>
            ${scope || !field.startsWith('period-')
                ? `<div class="setup-date-month-grid" role="group" aria-label="Months in ${year}">
                    ${academicDateMonths.map((name, index) => ({ name, index })).filter(monthItem => academicDateMonthAllowed(field, year, monthItem.index)).map(({ name, index }) => `<button type="button" data-month="${index}" aria-pressed="${selected?.year === year && selected.month === index}" class="${selected?.year === year && selected.month === index ? 'is-current' : ''}">${name}</button>`).join('')}
                </div>`
                : '<p class="setup-date-picker-hint">Set the school-year start and end dates first.</p>'}`;
        return;
    }

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstWeekday = new Date(year, month, 1).getDay();
    const blanks = Array.from({ length: firstWeekday }, () => '<span class="setup-date-empty" aria-hidden="true"></span>').join('');
    const days = Array.from({ length: daysInMonth }, (_, index) => {
        const day = index + 1;
        const isSelected = selected?.year === year && selected.month === month && selected.day === day;
        const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const disabled = !academicDateAllowed(field, iso);
        return `<button type="button" data-day="${day}" data-date="${iso}" aria-pressed="${isSelected}"${disabled ? ' disabled' : ''} class="${isSelected ? 'is-selected' : ''}">${day}</button>`;
    }).join('');
    picker.innerHTML = `
        <div class="setup-date-picker-header">${yearControls}<button class="setup-date-close" type="button" data-date-picker-action="close" aria-label="Close date picker"><i class="fas fa-times" aria-hidden="true"></i></button></div>
        <div class="setup-date-month-heading"><button type="button" data-date-picker-action="months" aria-label="Choose another month"><i class="fas fa-chevron-left" aria-hidden="true"></i> Months</button><strong>${academicDateMonths[month]}</strong></div>
        <div class="setup-date-day-grid" role="group" aria-label="Days in ${academicDateMonths[month]} ${year}">
            ${academicDateWeekdays.map(day => `<span class="setup-date-weekday" aria-hidden="true">${day}</span>`).join('')}
            ${blanks}${days}
        </div>`;
}

function handleAcademicDatePickerClick(event) {
    const actionButton = event.target.closest('[data-date-picker-action]');
    if (actionButton) {
        const action = actionButton.dataset.datePickerAction;
        if (action === 'close') {
            closeAcademicDatePicker(true);
        } else if (action === 'previous-year' || action === 'next-year') {
            const nextYear = academicDatePickerState.year + (action === 'previous-year' ? -1 : 1);
            if (!academicDateYearAllowed(academicDatePickerState.field, nextYear)) return;
            academicDatePickerState.year = nextYear;
            renderAcademicDatePicker();
            $(datePickerId(academicDatePickerState.field))?.querySelector(`[data-date-picker-action="${action}"]`)?.focus({ preventScroll: true });
        } else if (action === 'months') {
            academicDatePickerState.view = 'months';
            renderAcademicDatePicker();
            $(datePickerId(academicDatePickerState.field))?.querySelector('[data-month].is-current, [data-month]')?.focus({ preventScroll: true });
        }
        return;
    }
    const monthButton = event.target.closest('[data-month]');
    if (monthButton) {
        if (!academicDateMonthAllowed(academicDatePickerState.field, academicDatePickerState.year, Number(monthButton.dataset.month))) return;
        academicDatePickerState.month = Number(monthButton.dataset.month);
        academicDatePickerState.view = 'days';
        renderAcademicDatePicker();
        $(datePickerId(academicDatePickerState.field))?.querySelector('[data-day]')?.focus({ preventScroll: true });
        return;
    }
    const dayButton = event.target.closest('[data-date]');
    if (!dayButton) return;
    if (!academicDateAllowed(academicDatePickerState.field, dayButton.dataset.date)) return;
    const inputId = dateInputId(academicDatePickerState.field);
    const input = $(inputId);
    if (!input) return;
    input.value = dayButton.dataset.date;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    closeAcademicDatePicker(true);
}

function clearAlert() {
    const el = $('setupAlert');
    if (!el) return;
    el.className = 'setup-alert';
    el.removeAttribute('role');
    el.removeAttribute('aria-live');
    el.textContent = '';
}

function wireSetupEvents() {
    $('setupYearStart')?.addEventListener('input', () => {
        syncGeneratedYear();
        setSetupDirty(true, $('setupYearStart'));
    });
    ['setupDateStart', 'setupDateEnd'].forEach(inputId => {
        $(inputId)?.addEventListener('change', () => {
            updateAcademicDateDisplay(inputId);
            const group = $(inputId).closest('.setup-field');
            group?.classList.remove('is-error');
            group?.querySelector('.error-message')?.replaceChildren();
            $(inputId)?.removeAttribute('aria-invalid');
            $(dateDisplayId(inputId === 'setupDateEnd' ? 'end' : 'start'))?.removeAttribute('aria-invalid');
            syncSummary();
            updateSetupPeriodDateBounds();
            syncFirstPeriodStartDate();
            maybeOpenFirstPeriodDatesModal();
            setSetupDirty(true, $(inputId));
        });
    });
    [['start', 'setupDateStartDisplay'], ['end', 'setupDateEndDisplay']].forEach(([field, displayId]) => {
        $(displayId)?.addEventListener('click', () => openAcademicDatePicker(field));
        $(datePickerId(field))?.addEventListener('click', handleAcademicDatePickerClick);
    });
    [['period-start', 'setupPeriodDateStartDisplay'], ['period-end', 'setupPeriodDateEndDisplay']].forEach(([field, displayId]) => {
        $(displayId)?.addEventListener('click', () => openAcademicDatePicker(field));
        $(datePickerId(field))?.addEventListener('click', handleAcademicDatePickerClick);
    });
    ['setupPeriodDateStart', 'setupPeriodDateEnd'].forEach(inputId => {
        $(inputId)?.addEventListener('change', () => {
            updateAcademicDateDisplay(inputId);
            clearPeriodDatesModalError();
        });
    });
    $('setupGradingSystem')?.addEventListener('change', () => {
        setupState.periodDates = {};
        setupState.firstPeriodAutoOpened = false;
        renderSetupPeriods();
        syncFirstPeriodStartDate({ open: true });
        syncSummary();
        setSetupDirty(true, $('setupGradingSystem'));
    });
    $('setupPeriodsBody')?.addEventListener('click', event => {
        const row = event.target.closest('[data-period-row]');
        if (row) openPeriodDatesModal(Number(row.dataset.periodNo));
    });
    $('setupPeriodsBody')?.addEventListener('keydown', event => {
        const row = event.target.closest('[data-period-row]');
        if (row && ['Enter', ' '].includes(event.key)) {
            event.preventDefault();
            openPeriodDatesModal(Number(row.dataset.periodNo));
        }
    });
    $('closePeriodDatesModalBtn')?.addEventListener('click', closePeriodDatesModal);
    $('cancelPeriodDatesModalBtn')?.addEventListener('click', closePeriodDatesModal);
    $('savePeriodDatesModalBtn')?.addEventListener('click', savePeriodDatesModal);
    $('periodDatesModal')?.addEventListener('click', event => {
        if (event.target?.id === 'periodDatesModal') closePeriodDatesModal();
    });
    $('setupIsActive')?.addEventListener('change', () => setSetupDirty(true, $('setupIsActive')));
    $('addSectionBtn')?.addEventListener('click', () => openSectionModal());
    $('resetSetupBtn')?.addEventListener('click', async () => {
        if (!(await confirmLeaveSetup())) return;
        resetSetup();
        clearSetupDirty();
    });
    $('saveSetupBtn')?.addEventListener('click', saveSetup);
    $('closeSectionModalBtn')?.addEventListener('click', closeSectionModal);
    $('cancelSectionModalBtn')?.addEventListener('click', closeSectionModal);
    $('saveSectionModalBtn')?.addEventListener('click', saveSectionFromModal);
    ['modalGradeLevel', 'modalSectionName', 'modalCapacity', 'modalAdviser'].forEach(id => {
        const input = $(id);
        const eventName = input?.tagName === 'SELECT' ? 'change' : 'input';
        input?.addEventListener(eventName, () => clearSectionModalFieldError(id));
    });
    $('sectionModal')?.addEventListener('click', (event) => {
        if (event.target?.id === 'sectionModal') {
            closeSectionModal();
        }
    });
    $('sectionsBody')?.addEventListener('click', handleSectionPreviewClick);
    $('sectionsBody')?.addEventListener('dblclick', handleSectionPreviewDoubleClick);
    $('sectionsBody')?.addEventListener('contextmenu', (event) => {
        const row = event.target.closest('tr[data-row-id]');
        if (!row) return;
        event.preventDefault();
        openSectionPreviewMenu({ clientX: event.clientX, clientY: event.clientY }, row);
    });
    $('sectionsBody')?.addEventListener('keydown', (event) => {
        const row = event.target.closest('tr[data-row-id]');
        if (!row || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        const bounds = row.getBoundingClientRect();
        openSectionPreviewMenu({ clientX: bounds.left + Math.min(bounds.width / 2, 300), clientY: bounds.top + bounds.height / 2 }, row);
    });
    $('sectionsSelectAll')?.addEventListener('change', (event) => setPreviewSelection(event.target.checked));
    $('removeSelectedSectionsBtn')?.addEventListener('click', removeSelectedPreviewSections);
    document.addEventListener('click', (event) => {
        const action = event.target.closest('[data-preview-section-action]');
        if (action) {
            const { previewSectionAction, rowId } = action.dataset;
            closeSectionPreviewMenu();
            if (previewSectionAction === 'edit') openSectionModal(rowId);
            else if (previewSectionAction === 'remove') removePreviewSection(rowId);
            return;
        }
        if (!event.target.closest('#sectionPreviewContextMenu')) closeSectionPreviewMenu();
    });
    document.addEventListener('click', event => {
        const activeField = academicDatePickerState.field
            ? $(datePickerId(academicDatePickerState.field))?.closest('.setup-date-field')
            : null;
        if (!activeField) return;
        const clickPath = event.composedPath?.() || [];
        if (!clickPath.includes(activeField)) closeAcademicDatePicker();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeSectionPreviewMenu();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            if (academicDatePickerState.field) closeAcademicDatePicker(true);
            else if ($('periodDatesModal')?.classList.contains('show')) closePeriodDatesModal();
        }
    });
}

function handleSectionPreviewClick(event) {
    const checkbox = event.target.closest('input[data-preview-selection]');
    if (checkbox) {
        const id = String(checkbox.dataset.previewSelection || '');
        if (checkbox.checked) setupState.selectedSectionIds.add(id);
        else setupState.selectedSectionIds.delete(id);
        updatePreviewSelectionControls();
        return;
    }
    const row = event.target.closest('tr[data-row-id]');
    if (!row || event.target.closest('button, input, label')) return;

    clearTimeout(setupState.sectionClickTimer);
    const now = performance.now();
    const doubleClick = setupState.lastSectionClick?.row === row && now - setupState.lastSectionClick.time < 450;
    setupState.lastSectionClick = { row, time: now };
    if (setupState.selectedSectionIds.size || doubleClick || event.detail >= 2) {
        togglePreviewRowSelection(row, !doubleClick && event.detail < 2);
        setupState.lastSectionClick = null;
        return;
    }
    const point = { clientX: event.clientX, clientY: event.clientY };
    setupState.sectionClickTimer = setTimeout(() => {
        if (row.isConnected) openSectionPreviewMenu(point, row);
    }, 400);
}

function handleSectionPreviewDoubleClick(event) {
    const row = event.target.closest('tr[data-row-id]');
    if (!row || event.target.closest('button, input, label')) return;
    clearTimeout(setupState.sectionClickTimer);
    event.preventDefault();
    togglePreviewRowSelection(row, false);
    setupState.lastSectionClick = null;
}

function togglePreviewRowSelection(row, toggle = false) {
    const id = String(row?.dataset.rowId || '');
    if (!id) return;
    if (toggle && setupState.selectedSectionIds.has(id)) setupState.selectedSectionIds.delete(id);
    else setupState.selectedSectionIds.add(id);
    updatePreviewSelectionControls();
}

function setPreviewSelection(checked) {
    setupState.sections.forEach(row => {
        const id = String(row.id);
        if (checked) setupState.selectedSectionIds.add(id);
        else setupState.selectedSectionIds.delete(id);
    });
    updatePreviewSelectionControls();
}

function updatePreviewSelectionControls() {
    const visibleIds = [...document.querySelectorAll('#sectionsBody tr[data-row-id]')].map(row => String(row.dataset.rowId));
    const countVisible = visibleIds.filter(id => setupState.selectedSectionIds.has(id)).length;
    document.body.classList.toggle('setup-selection-mode', countVisible > 0);
    const selectAll = $('sectionsSelectAll');
    if (selectAll) {
        selectAll.checked = visibleIds.length > 0 && countVisible === visibleIds.length;
        selectAll.indeterminate = countVisible > 0 && countVisible < visibleIds.length;
    }
    document.querySelectorAll('#sectionsBody tr[data-row-id]').forEach(row => {
        const chosen = setupState.selectedSectionIds.has(String(row.dataset.rowId));
        row.classList.toggle('is-selected', chosen);
        const checkbox = row.querySelector('input[data-preview-selection]');
        if (checkbox) checkbox.checked = chosen;
    });
    const removeButton = $('removeSelectedSectionsBtn');
    if (removeButton) {
        removeButton.hidden = countVisible === 0;
        removeButton.disabled = countVisible === 0;
        removeButton.textContent = countVisible ? `Remove selected (${countVisible})` : 'Remove selected';
    }
}

function openSectionPreviewMenu(point, row) {
    closeSectionPreviewMenu();
    const menu = document.createElement('div');
    menu.id = 'sectionPreviewContextMenu';
    menu.className = 'setup-row-context-menu';
    menu.setAttribute('role', 'menu');
    const id = String(row.dataset.rowId || '');
    menu.innerHTML = `
        <button type="button" role="menuitem" data-preview-section-action="edit" data-row-id="${escapeHtml(id)}"><i class="fas fa-pen" aria-hidden="true"></i><span>Edit section</span></button>
        <button type="button" role="menuitem" data-preview-section-action="remove" data-row-id="${escapeHtml(id)}"><i class="fas fa-trash" aria-hidden="true"></i><span>Remove section</span></button>`;
    document.body.append(menu);
    const margin = 8;
    menu.style.left = `${Math.max(margin, Math.min(point.clientX, window.innerWidth - menu.offsetWidth - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(point.clientY, window.innerHeight - menu.offsetHeight - margin))}px`;
    menu.querySelector('button')?.focus();
}

function closeSectionPreviewMenu() {
    $('sectionPreviewContextMenu')?.remove();
}

function removePreviewSection(id) {
    setupState.sections = setupState.sections.filter(row => String(row.id) !== String(id));
    setupState.selectedSectionIds.delete(String(id));
    renderSections();
    syncSummary();
    setSetupDirty();
}

async function removeSelectedPreviewSections() {
    const ids = new Set(setupState.selectedSectionIds);
    if (!ids.size) return;
    const confirmed = typeof Swal !== 'undefined' && typeof Swal.fire === 'function'
        ? (await Swal.fire({
            icon: 'warning',
            title: `Remove ${ids.size} selected section${ids.size === 1 ? '' : 's'}?`,
            text: 'The selected sections will be removed from this setup preview.',
            showCancelButton: true,
            confirmButtonText: 'Remove selected',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#dc2626'
        })).isConfirmed
        : window.confirm(`Remove ${ids.size} selected section${ids.size === 1 ? '' : 's'} from this setup preview?`);
    if (!confirmed) return;
    setupState.sections = setupState.sections.filter(row => !ids.has(String(row.id)));
    setupState.selectedSectionIds.clear();
    renderSections();
    syncSummary();
    setSetupDirty();
    showAlert(`${ids.size} section${ids.size === 1 ? '' : 's'} removed from the preview.`, 'success');
}

async function loadSetupDefaults() {
    setupState.hydrating = true;
    try {
        const payload = await setupApi.defaults();
        if (!payload?.success) {
            throw new Error(payload?.message || 'Failed to load setup defaults.');
        }

        setupState.defaults = payload;
        setupState.gradeLevels = Array.isArray(payload.grade_levels) ? payload.grade_levels : [];
        setupState.teachers = Array.isArray(payload.teachers) ? payload.teachers : [];
        setupState.gradingSystems = Array.isArray(payload.grading_systems) ? payload.grading_systems : [];
        setupState.activeCurriculum = payload.active_curriculum || null;

        const suggested = payload.suggested_school_year || {};
        $('setupYearStart').value = suggested.year_start || new Date().getFullYear();
        syncGeneratedYear();

        const supportedSystems = setupState.gradingSystems.filter(system => ['Quarterly', 'Three-Term'].includes(system.value));
        $('setupGradingSystem').innerHTML = '<option value="">Select periods number type</option>' + supportedSystems.map(system => (
            `<option value="${escapeHtml(system.value)}">${escapeHtml(system.label)}</option>`
        )).join('');
        $('setupGradingSystem').value = '';
        renderActiveCurriculum();

        setupState.periodDates = {};
        setupState.firstPeriodAutoOpened = false;
        renderSetupPeriods();
        setupState.sections = [];
        populateSectionModalOptions();
        renderSections();
        syncSummary();
        clearSetupDirty();
    } catch (error) {
        showAlert(escapeHtml(error?.message || 'Failed to load Academic Year Setup.'));
    } finally {
        setupState.hydrating = false;
    }
}

function renderActiveCurriculum() {
    const input = $('setupActiveCurriculum');
    if (!input) return;

    const curriculum = setupState.activeCurriculum;
    input.value = curriculum
        ? [curriculum.curriculum_code, curriculum.curriculum_name].filter(Boolean).join(' - ')
        : 'No active curriculum configured';
}

function newSection(seed = {}) {
    return {
        id: `row_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        grade_level_id: seed.grade_level_id || '',
        section_name: seed.section_name || '',
        adviser_id: seed.adviser_id || '',
        max_capacity: seed.max_capacity || 45
    };
}

function syncGeneratedYear() {
    const yearStart = Number($('setupYearStart')?.value || 0);
    const yearEnd = yearStart > 0 ? yearStart + 1 : '';
    if ($('setupYearEnd')) $('setupYearEnd').value = yearEnd;
    if ($('setupYearLabel')) $('setupYearLabel').value = yearStart > 0 ? `${yearStart}-${yearEnd}` : '';
    syncSummary();
}

function syncFirstPeriodStartDate({ open = false } = {}) {
    const schoolStart = $('setupDateStart')?.value || '';
    const periods = selectedSystem().periods || [];
    if (!schoolStart || !periods.some(period => Number(period.period_no) === 1)) return;

    const current = setupState.periodDates[1] || {};
    const next = {
        ...current,
        date_start: schoolStart,
        date_end: current.date_end && current.date_end < schoolStart ? '' : (current.date_end || '')
    };
    if (current.date_start !== next.date_start || current.date_end !== next.date_end) {
        setupState.periodDates[1] = next;
        renderSetupPeriods();
    }
    if (open) maybeOpenFirstPeriodDatesModal();
}

function maybeOpenFirstPeriodDatesModal() {
    const schoolStart = $('setupDateStart')?.value || '';
    const schoolEnd = $('setupDateEnd')?.value || '';
    const periods = selectedSystem().periods || [];
    if (setupState.firstPeriodAutoOpened || !schoolStart || !schoolEnd || schoolStart > schoolEnd
        || !periods.some(period => Number(period.period_no) === 1)) return;
    setupState.firstPeriodAutoOpened = true;
    requestAnimationFrame(() => openPeriodDatesModal(1));
}

function selectedSystem() {
    const value = $('setupGradingSystem')?.value || '';
    return setupState.gradingSystems.find(system => system.value === value) || {
        value,
        label: value,
        periods: []
    };
}

function renderSetupPeriods() {
    const field = $('setupPeriodsField');
    const body = $('setupPeriodsBody');
    if (!field || !body) return;
    const system = $('setupGradingSystem')?.value || '';
    const periods = selectedSystem().periods || [];
    field.hidden = !system;
    if (!system) {
        body.replaceChildren();
        clearSetupPeriodDateError();
        return;
    }
    $('setupPeriodsTitle').textContent = system === 'Three-Term'
        ? 'THREE-TERM PERIOD DATE SET UP'
        : 'QUARTER PERIOD DATE SET UP';
    body.innerHTML = periods.map(period => {
        const periodNo = Number(period.period_no);
        const savedDates = setupState.periodDates[periodNo] || {};
        const range = savedDates.date_start && savedDates.date_end
            ? `${formatAcademicDate(savedDates.date_start)} – ${formatAcademicDate(savedDates.date_end)}`
            : '<span class="setup-period-set-note"><i class="fas fa-calendar-plus" aria-hidden="true"></i> Set date</span>';
        return `<tr data-period-row data-period-no="${periodNo}" tabindex="0" aria-label="Set dates for ${escapeHtml(period.period_name || `period ${periodNo}`)}">
            <th scope="row">${periodNo}</th><td>${range}</td>
        </tr>`;
    }).join('');
}

function formatAcademicDate(value) {
    const parsed = parseAcademicDate(value);
    return parsed ? `${academicDateMonths[parsed.month]} ${parsed.day}, ${parsed.year}` : '';
}

function updateSetupPeriodDateBounds() {
    if (!$('setupGradingSystem')?.value) return;
    const start = $('setupDateStart')?.value || '';
    const end = $('setupDateEnd')?.value || '';
    document.querySelectorAll('#setupPeriodsBody input[type="date"]').forEach(input => {
        input.min = start;
        input.max = end;
    });
}

function clearSetupPeriodDateError() {
    const error = $('setupPeriodsError');
    if (error) error.textContent = '';
    $('setupPeriodsField')?.classList.remove('is-error');
}

function validateSetupPeriodDates(dateStart, dateEnd) {
    clearSetupPeriodDateError();
    const periods = selectedSystem().periods || [];
    if (!periods.length) return { valid: true, dates: [] };
    const dates = periods.map(period => ({
        ...period,
        period_no: Number(period.period_no),
        period_name: period.period_name || `Period ${period.period_no}`,
        date_start: Number(period.period_no) === 1
            ? (dateStart || setupState.periodDates[period.period_no]?.date_start || '')
            : (setupState.periodDates[period.period_no]?.date_start || ''),
        date_end: setupState.periodDates[period.period_no]?.date_end || ''
    }));
    let message = '';
    for (const period of dates) {
        if (!period.date_start || !period.date_end) {
            message = `Choose both dates for ${period.period_name}.`;
            break;
        }
        if (period.date_start > period.date_end) {
            message = `${period.period_name} end date must be on or after its start date.`;
            break;
        }
        if (period.date_start < dateStart || period.date_end > dateEnd) {
            message = `${period.period_name} dates must fall within the school-year dates.`;
            break;
        }
    }
    if (!message && dates.some((period, index) => index > 0 && period.date_start <= dates[index - 1].date_end)) {
        message = 'Period dates must be in order and must not overlap.';
    }
    if (message) {
        const field = $('setupPeriodsField');
        field?.classList.add('is-error');
        const error = $('setupPeriodsError');
        if (error) error.textContent = message;
        return { valid: false, dates };
    }
    return { valid: true, dates };
}

function clearPeriodDatesModalError() {
    const error = $('periodDatesModalError');
    if (error) error.textContent = '';
}

function openPeriodDatesModal(periodNo) {
    const period = selectedSystem().periods?.find(item => Number(item.period_no) === periodNo);
    if (!period) return;
    const current = setupState.periodDates[periodNo] || {};
    setupState.editingPeriodNo = periodNo;
    setupState.editingPeriodDates = { date_start: current.date_start || '', date_end: current.date_end || '' };
    $('periodDatesModalTitle').textContent = `${period.period_name || `Period ${periodNo}`} dates`;
    $('setupPeriodDateStart').value = setupState.editingPeriodDates.date_start;
    $('setupPeriodDateEnd').value = setupState.editingPeriodDates.date_end;
    updateAcademicDateDisplay('setupPeriodDateStart');
    updateAcademicDateDisplay('setupPeriodDateEnd');
    clearPeriodDatesModalError();
    const modal = $('periodDatesModal');
    modal?.classList.add('show');
    modal?.setAttribute('aria-hidden', 'false');
    setTimeout(() => $('setupPeriodDateStartDisplay')?.focus(), 0);
}

function closePeriodDatesModal() {
    closeAcademicDatePicker();
    const modal = $('periodDatesModal');
    modal?.classList.remove('show');
    modal?.setAttribute('aria-hidden', 'true');
    setupState.editingPeriodNo = null;
    setupState.editingPeriodDates = null;
    clearPeriodDatesModalError();
}

function savePeriodDatesModal() {
    const periodNo = Number(setupState.editingPeriodNo || 0);
    const schoolStart = $('setupDateStart')?.value || '';
    const dateStart = periodNo === 1 ? schoolStart : ($('setupPeriodDateStart')?.value || '');
    const dateEnd = $('setupPeriodDateEnd')?.value || '';
    const schoolEnd = $('setupDateEnd')?.value || '';
    let message = '';
    if (!schoolStart || !schoolEnd) message = 'Set the school-year start and end dates first.';
    else if (!dateStart || !dateEnd) message = 'Choose both a start date and an end date.';
    else if (dateStart > dateEnd) message = 'End date must be on or after start date.';
    else if (dateStart < schoolStart || dateEnd > schoolEnd) message = 'Period dates must fall within the school-year dates.';

    if (!message) {
        const periods = selectedSystem().periods || [];
        const earlier = periods.filter(item => Number(item.period_no) < periodNo)
            .map(item => setupState.periodDates[item.period_no]).filter(item => item?.date_start && item?.date_end)
            .sort((a, b) => a.date_start.localeCompare(b.date_start)).at(-1);
        const later = periods.filter(item => Number(item.period_no) > periodNo)
            .map(item => setupState.periodDates[item.period_no]).filter(item => item?.date_start && item?.date_end)
            .sort((a, b) => a.date_start.localeCompare(b.date_start))[0];
        if (earlier && dateStart <= earlier.date_end) message = 'This period must start after the previous period ends.';
        else if (later && dateEnd >= later.date_start) message = 'This period must end before the next period starts.';
    }
    if (message) {
        if ($('periodDatesModalError')) $('periodDatesModalError').textContent = message;
        return;
    }
    setupState.periodDates[periodNo] = { date_start: dateStart, date_end: dateEnd };
    renderSetupPeriods();
    setSetupDirty();
    closePeriodDatesModal();
}

function renderSections() {
    const body = $('sectionsBody');
    if (!body) return;

    if (!setupState.sections.length) {
        setupState.selectedSectionIds.clear();
        body.innerHTML = `
            <tr>
                <td colspan="5">
                    <div class="setup-empty">No sections added yet.</div>
                </td>
            </tr>
        `;
        updatePreviewSelectionControls();
        return;
    }

    body.innerHTML = setupState.sections.map(row => `
        <tr class="setup-preview-row${setupState.selectedSectionIds.has(String(row.id)) ? ' is-selected' : ''}" data-row-id="${escapeHtml(row.id)}" tabindex="0" aria-label="${escapeHtml(gradeName(row.grade_level_id))} ${escapeHtml(row.section_name)}">
            <td class="setup-row-select"><input type="checkbox" data-preview-selection="${escapeHtml(row.id)}" aria-label="Select ${escapeHtml(row.section_name)}"${setupState.selectedSectionIds.has(String(row.id)) ? ' checked' : ''}></td>
            <td>${escapeHtml(gradeName(row.grade_level_id))}</td>
            <td>${escapeHtml(row.section_name)}</td>
            <td>${escapeHtml(adviserName(row.adviser_id))}</td>
            <td>${Number(row.max_capacity || 45)}</td>
        </tr>
    `).join('');
    updatePreviewSelectionControls();
}

function gradeName(gradeLevelId) {
    const grade = setupState.gradeLevels.find(item => String(item.grade_level_id) === String(gradeLevelId));
    return grade?.grade_name || '';
}

function adviserName(adviserId) {
    if (!adviserId) return 'No adviser';
    const teacher = setupState.teachers.find(item => String(item.employee_id) === String(adviserId));
    return teacher ? teacherName(teacher) : 'No adviser';
}

function populateSectionModalOptions(selectedAdviserId = '') {
    const gradeSelect = $('modalGradeLevel');
    if (gradeSelect) {
        const orderedGradeLevels = [...setupState.gradeLevels].sort((a, b) =>
            Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0)
        );
        gradeSelect.innerHTML = '<option value="">Select grade level</option>' + orderedGradeLevels.map(grade => `
            <option value="${Number(grade.grade_level_id)}">${escapeHtml(grade.grade_name)}</option>
        `).join('');
    }

    const usedAdvisers = new Set(
        setupState.sections
            .filter(row => String(row.id) !== String(setupState.editingSectionId || ''))
            .map(row => String(row.adviser_id || ''))
            .filter(Boolean)
    );
    const adviserSelect = $('modalAdviser');
    if (adviserSelect) {
        adviserSelect.innerHTML = '<option value="">No adviser</option>' + setupState.teachers
            .filter(teacher => !usedAdvisers.has(String(teacher.employee_id)))
            .map(teacher => {
            const value = String(teacher.employee_id);
            return `
                <option value="${Number(teacher.employee_id)}">
                    ${escapeHtml(teacherName(teacher))}
                </option>
            `;
            }).join('');
    }
}

function syncSetupSelect(id, value) {
    const select = $(id);
    if (!select) return;
    select.value = value == null ? '' : String(value);
    try {
        select._choicesInstance?.refresh();
        if (value !== undefined && value !== null) select._choicesInstance?.setChoiceByValue(String(value));
    } catch (_) {
        // Keep native select state as the fallback if Choices is unavailable.
    }
}

function openSectionModal(sectionId = null) {
    clearSectionModalErrors();
    setupState.editingSectionId = sectionId;
    const row = sectionId ? setupState.sections.find(item => item.id === sectionId) : null;
    populateSectionModalOptions(row?.adviser_id || '');

    $('sectionModalTitle').textContent = row ? 'Edit Section' : 'Add Section';
    $('saveSectionModalBtn').innerHTML = row
        ? '<i class="fas fa-check"></i> Update Preview'
        : '<i class="fas fa-check"></i> Add to Preview';
    $('sectionEditId').value = row?.id || '';
    $('modalGradeLevel').value = row?.grade_level_id || '';
    $('modalSectionName').value = row?.section_name || '';
    $('modalAdviser').value = row?.adviser_id || '';
    $('modalCapacity').value = row?.max_capacity || 45;

    const modal = $('sectionModal');
    modal?.classList.add('show');
    modal?.setAttribute('aria-hidden', 'false');
    window.enhanceControls?.();
    syncSetupSelect('modalGradeLevel', row?.grade_level_id || '');
    syncSetupSelect('modalAdviser', row?.adviser_id || '');
    setTimeout(() => $('modalSectionName')?.focus(), 0);
}

function closeSectionModal() {
    const modal = $('sectionModal');
    modal?.classList.remove('show');
    modal?.setAttribute('aria-hidden', 'true');
    try {
        $('modalGradeLevel')?._choicesInstance?.hideDropdown();
        $('modalAdviser')?._choicesInstance?.hideDropdown();
    } catch (_) {}
    setupState.editingSectionId = null;
    clearSectionModalErrors();
}

function clearSectionModalErrors() {
    document.querySelectorAll('#sectionModal .setup-field').forEach(group => {
        group.classList.remove('is-error');
        group.querySelector('input, select')?.removeAttribute('aria-invalid');
        const msg = group.querySelector('.error-message');
        if (msg) msg.textContent = '';
    });
}

function clearSectionModalFieldError(inputId) {
    const input = $(inputId);
    const group = input?.closest('.setup-field');
    if (!group) return;
    group.classList.remove('is-error');
    input.removeAttribute('aria-invalid');
    const msg = group.querySelector('.error-message');
    if (msg) msg.textContent = '';
}

function setSectionModalError(inputId, message) {
    const input = $(inputId);
    const group = input?.closest('.setup-field');
    if (!group) return;
    group.classList.add('is-error');
    input.setAttribute('aria-invalid', 'true');
    const msg = group.querySelector('.error-message');
    if (msg) {
        if (!msg.id) msg.id = `${inputId}Error`;
        input.setAttribute('aria-describedby', msg.id);
        msg.textContent = message;
        msg.setAttribute('role', 'alert');
        msg.setAttribute('aria-live', 'polite');
    }
}

function showSectionValidationPopup() {
    const errors = [...document.querySelectorAll('#sectionModal .setup-field.is-error')].map(group => {
        const label = group.querySelector('label')?.textContent.replace('*', '').trim() || 'Field';
        const message = group.querySelector('.error-message')?.textContent.trim() || 'Check this value.';
        return { label, message };
    });
    if (!errors.length) return;

    document.getElementById('sectionValidationDialog')?.close();
    document.getElementById('sectionValidationDialog')?.remove();
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.id = 'sectionValidationDialog';
    dialog.className = 'setup-validation-dialog';
    dialog.setAttribute('aria-labelledby', 'sectionValidationTitle');
    dialog.setAttribute('aria-describedby', 'sectionValidationMessage');

    const heading = document.createElement('h2');
    heading.id = 'sectionValidationTitle';
    heading.textContent = 'SECTION VALIDATION';
    const message = document.createElement('p');
    message.id = 'sectionValidationMessage';
    message.textContent = 'Please correct the highlighted fields:';
    const list = document.createElement('ul');
    errors.forEach(({ label, message: detail }) => {
        const item = document.createElement('li');
        const field = document.createElement('strong');
        field.textContent = `${label}: `;
        item.append(field, document.createTextNode(detail));
        list.append(item);
    });
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-primary';
    button.textContent = 'Got it';
    button.addEventListener('click', () => dialog.close());
    dialog.append(heading, message, list, button);
    dialog.addEventListener('close', () => {
        dialog.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    button.focus();
}

function saveSectionFromModal() {
    clearSectionModalErrors();
    clearAlert();
    const capacityValue = String($('modalCapacity')?.value ?? '').trim();
    const section = {
        grade_level_id: Number($('modalGradeLevel')?.value || 0),
        section_name: String($('modalSectionName')?.value || '').trim(),
        adviser_id: $('modalAdviser')?.value ? Number($('modalAdviser').value) : null,
        max_capacity: capacityValue === '' ? NaN : Number(capacityValue)
    };

    let valid = true;
    if (!section.grade_level_id) {
        setSectionModalError('modalGradeLevel', 'Choose a grade level.');
        valid = false;
    }
    if (!section.section_name) {
        setSectionModalError('modalSectionName', 'Enter a section name.');
        valid = false;
    } else if (section.section_name.length > 100) {
        setSectionModalError('modalSectionName', 'Use 100 characters or fewer.');
        valid = false;
    }
    if (!Number.isInteger(section.max_capacity) || section.max_capacity < 1 || section.max_capacity > 60) {
        const capacityError = capacityValue === ''
            ? 'Capacity is required.'
            : !Number.isInteger(section.max_capacity)
                ? 'Enter a whole-number capacity.'
                : section.max_capacity < 1
                    ? 'Capacity must be at least 1.'
                    : 'Capacity cannot exceed 60.';
        setSectionModalError('modalCapacity', capacityError);
        valid = false;
    }

    const duplicate = setupState.sections.find(row =>
        row.id !== setupState.editingSectionId &&
        String(row.section_name || '').trim().toLocaleLowerCase() === section.section_name.toLocaleLowerCase()
    );
    if (section.section_name && duplicate) {
        setSectionModalError('modalSectionName', 'Name already taken. Use a different name.');
        valid = false;
    }

    if (section.adviser_id) {
        const adviserUsed = setupState.sections.find(row =>
            row.id !== setupState.editingSectionId &&
            Number(row.adviser_id || 0) === section.adviser_id
        );
        if (adviserUsed) {
            setSectionModalError('modalAdviser', 'This adviser is already assigned to another preview section.');
            valid = false;
        }
    }

    if (!valid) {
        showSectionValidationPopup();
        const firstInvalid = document.querySelector('#sectionModal .setup-field.is-error input, #sectionModal .setup-field.is-error select');
        const choicesFocus = firstInvalid?.closest('.setup-field')?.querySelector('.choices__inner');
        (choicesFocus || firstInvalid)?.focus();
        return;
    }

    if (setupState.editingSectionId) {
        setupState.sections = setupState.sections.map(row =>
            row.id === setupState.editingSectionId ? { ...row, ...section } : row
        );
    } else {
        setupState.sections.push(newSection(section));
    }

    const wasEditing = Boolean(setupState.editingSectionId);
    closeSectionModal();
    renderSections();
    syncSummary();
    setSetupDirty();
    showAlert(wasEditing ? 'Section updated in the preview.' : 'Section added to the preview.', 'success');
}

function resetSetup() {
    clearAlert();
    closeAcademicDatePicker();
    const suggested = setupState.defaults?.suggested_school_year || {};
    $('setupYearStart').value = suggested.year_start || new Date().getFullYear();
    $('setupDateStart').value = '';
    $('setupDateEnd').value = '';
    updateAcademicDateDisplay('setupDateStart');
    updateAcademicDateDisplay('setupDateEnd');
    $('setupGradingSystem').value = '';
    setupState.periodDates = {};
    setupState.firstPeriodAutoOpened = false;
    renderSetupPeriods();
    $('setupIsActive').checked = true;
    setupState.sections = [];
    syncGeneratedYear();
    renderSections();
    clearFieldErrors();
}

function syncSummary() {
    const target = $('setupSummary');
    if (!target) return;
    const completeSections = setupState.sections.length;
    const periodCount = selectedSystem().periods?.length || 0;
    const curriculum = setupState.activeCurriculum;
    target.innerHTML = `
        <span class="setup-chip"><i class="fas fa-calendar"></i> ${escapeHtml($('setupYearLabel')?.value || 'No year')}</span>
        <span class="setup-chip"><i class="fas fa-book-open"></i> ${escapeHtml(curriculum?.curriculum_code || 'No curriculum')}</span>
        <span class="setup-chip"><i class="fas fa-layer-group"></i> ${periodCount} period${periodCount === 1 ? '' : 's'}</span>
        <span class="setup-chip"><i class="fas fa-school"></i> ${completeSections} section${completeSections === 1 ? '' : 's'}</span>
    `;
}

function collectSections(onlyComplete = true) {
    void onlyComplete;
    return setupState.sections.map(row => ({
        grade_level_id: Number(row.grade_level_id || 0),
        section_name: String(row.section_name || '').trim(),
        adviser_id: row.adviser_id ? Number(row.adviser_id) : null,
        max_capacity: Number(row.max_capacity || 45)
    }));
}

function clearFieldErrors() {
    document.querySelectorAll('.setup-field').forEach(group => {
        group.classList.remove('is-error');
        group.querySelectorAll('[aria-invalid="true"]').forEach(input => input.removeAttribute('aria-invalid'));
        const msg = group.querySelector('.error-message');
        if (msg) msg.textContent = '';
    });
}

function setFieldError(inputId, message) {
    const input = $(inputId);
    const group = input?.closest('.setup-field');
    if (!group) return;
    group.classList.add('is-error');
    input.setAttribute('aria-invalid', 'true');
    const dateTrigger = inputId === 'setupDateStart' ? $('setupDateStartDisplay') : inputId === 'setupDateEnd' ? $('setupDateEndDisplay') : null;
    dateTrigger?.setAttribute('aria-invalid', 'true');
    const msg = group.querySelector('.error-message');
    if (msg) {
        msg.textContent = message;
        if (dateTrigger && msg.id) dateTrigger.setAttribute('aria-describedby', msg.id);
    }
}

function validateClientPayload() {
    clearFieldErrors();
    const yearStart = Number($('setupYearStart')?.value || 0);
    const yearEnd = yearStart + 1;
    const dateStart = $('setupDateStart')?.value || '';
    const dateEnd = $('setupDateEnd')?.value || '';
    const curriculumId = Number(setupState.activeCurriculum?.curriculum_id || 0);
    const periodValidation = validateSetupPeriodDates(dateStart, dateEnd);
    const sections = collectSections(true);

    let valid = true;
    if (yearStart < 2000 || yearStart > 2100) {
        setFieldError('setupYearStart', 'Enter a valid school year.');
        valid = false;
    }
    if (!dateStart) {
        setFieldError('setupDateStart', 'Start date is required.');
        valid = false;
    }
    if (!dateEnd) {
        setFieldError('setupDateEnd', 'End date is required.');
        valid = false;
    }
    if (dateStart && dateEnd && dateStart > dateEnd) {
        setFieldError('setupDateEnd', 'End date must be on or after start date.');
        valid = false;
    }
    if (!curriculumId) {
        setFieldError('setupActiveCurriculum', 'Exactly one active curriculum must be configured before setup.');
        valid = false;
    }
    if (!$('setupGradingSystem')?.value) {
        setFieldError('setupGradingSystem', 'Select periods number type.');
        valid = false;
    }
    if (!periodValidation.valid) valid = false;

    const nameKeys = new Set();
    const adviserKeys = new Set();
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
        const section = sections[sectionIndex];
        if (section.max_capacity < 1 || section.max_capacity > 60) {
            showAlert('Section capacity must be between 1 and 60.');
            valid = false;
            break;
        }

        const nameKey = section.section_name.trim().toLocaleLowerCase();
        if (nameKeys.has(nameKey)) {
            const row = setupState.sections[sectionIndex];
            if (row) {
                openSectionModal(row.id);
                setSectionModalError('modalSectionName', 'Name already taken. Use a different name.');
            }
            valid = false;
            break;
        }
        nameKeys.add(nameKey);

        if (section.adviser_id) {
            if (adviserKeys.has(section.adviser_id)) {
                showAlert('An adviser can be assigned to only one section.');
                valid = false;
                break;
            }
            adviserKeys.add(section.adviser_id);
        }
    }

    return {
        valid,
        payload: {
            year_start: yearStart,
            year_end: yearEnd,
            date_start: dateStart,
            date_end: dateEnd,
            grading_system_type: $('setupGradingSystem')?.value || '',
            period_dates: periodValidation.dates,
            is_active: $('setupIsActive')?.checked ? 1 : 0,
            sections
        }
    };
}

async function saveSetup() {
    clearAlert();
    const { valid, payload } = validateClientPayload();
    if (!valid) return;

    const periodCount = selectedSystem().periods?.length || 0;
    const ok = await confirmFinalizeSetup(payload, periodCount);
    if (!ok) return;

    const btn = $('saveSetupBtn');
    const original = btn?.innerHTML;
    setupState.saving = true;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    }

    try {
        const result = await setupApi.create(payload);
        if (!result?.success) {
            throw new Error(result?.message || 'Failed to finalize setup.');
        }
        showAlert(
            `Academic year ${escapeHtml(result.year_label)} was created with ${Number(result.grading_periods_created || 0)} grading period(s) and ${Number(result.sections_created || 0)} section(s).`,
            'success'
        );
        clearSetupDirty();
        await loadSetupDefaults();
    } catch (error) {
        const message = error?.response?.data?.message || error?.message || 'Failed to finalize setup.';
        if (message === 'Name already taken.') {
            const duplicateIndex = setupState.sections.findIndex((candidate, index) =>
                setupState.sections.slice(0, index).some(previous => previous.section_name.trim().toLocaleLowerCase() === candidate.section_name.trim().toLocaleLowerCase())
            );
            const row = duplicateIndex >= 0 ? setupState.sections[duplicateIndex] : null;
            if (row) {
                openSectionModal(row.id);
                setSectionModalError('modalSectionName', 'Name already taken. Use a different name.');
                showSectionValidationPopup();
                return;
            }
        }
        showAlert(escapeHtml(message));
    } finally {
        setupState.saving = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    }
}
