const API_BASE_URL = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;
const schoolYearNoCache = () => ({
    headers: { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
});

function schoolYearJsonPayload(value) {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return value;
    }
}

const schoolYearsApi = {
    list: async () => axios.get(`${API_BASE_URL}/school_years/school_years.php`, {
        ...schoolYearNoCache(),
        params: { operation: 'getAllSchoolYears', _cb: Date.now() }
    }).then(r => normalizeSchoolYearListPayload(schoolYearJsonPayload(r?.data))),
    gradingModes: async (schoolYearId) => axios.get(`${API_BASE_URL}/school_years/school_years.php`, {
        ...schoolYearNoCache(),
        params: {
            operation: 'getElementaryGradingModes',
            school_year_id: schoolYearId,
            _cb: Date.now()
        }
    }).then(r => schoolYearJsonPayload(r?.data)),
    create: async (data) => axios.post(`${API_BASE_URL}/school_years/school_years.php?operation=createSchoolYear`, data).then(r => r.data),
    update: async (id, data) => axios.post(
        `${API_BASE_URL}/school_years/school_years.php?operation=updateSchoolYear`,
        {
            ...data,
            school_year_id: id,
            // Grading-period changes are submitted with the School Year
            // update so the modal has one save boundary.
            grading_periods: typeof schoolYearPeriodPayloadForSave === 'function'
                ? schoolYearPeriodPayloadForSave()
                : []
        },
        { ...schoolYearNoCache(), timeout: 15000 }
    ).then(r => r.data),
    remove: async (id) => axios.post(`${API_BASE_URL}/school_years/school_years.php?operation=archiveSchoolYear`, { school_year_id: id }).then(r => r.data)
};

async function resolveMappedSchoolYearCurriculum(record) {
    // Always resolve the mapping from the server for edit. The row list is a
    // convenience snapshot; the curriculum map is the source of truth.
    if (Number(record?.school_year_id) > 0) {
        const response = await axios.get(`${API_BASE_URL}/curricula/curricula.php`, {
            ...schoolYearNoCache(),
            params: {
                operation: 'getPrimaryCurriculumForSchoolYear',
                school_year_id: record?.school_year_id,
                _cb: Date.now()
            }
        });
        const payload = schoolYearJsonPayload(response?.data);
        const mapped = payload?.data || (payload?.curriculum_id ? payload : null);
        if (mapped) {
            record.curriculum_id = mapped.curriculum_id;
            record.curriculum_display_name = `${mapped.curriculum_code || ''} - ${mapped.curriculum_name || ''}`.trim();
        }
    }
}

function syncMappedSchoolYearCurriculumDisplay(record) {
    const display = document.getElementById('field-curriculum_id');
    const curriculumId = Number(record?.curriculum_id || 0);
    if (!display) return;
    display.textContent = String(record?.curriculum_display_name || (curriculumId > 0 ? `Curriculum ${curriculumId}` : 'Not assigned'));
    display.dataset.referenceValue = curriculumId > 0 ? String(curriculumId) : '';
}

async function loadMappedSchoolYearCurriculum(record) {
    await resolveMappedSchoolYearCurriculum(record);
    syncMappedSchoolYearCurriculumDisplay(record);
}

function normalizeElementaryGradingMode(value, fallback) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'descriptive') return 'Descriptive';
    if (normalized === 'numeric') return 'Numeric';
    return fallback;
}

function elementaryGradingModesFromPayload(payload) {
    const source = payload?.modes || payload?.data?.modes || payload?.elementary_grading_modes || payload?.data?.elementary_grading_modes || payload;
    if (!source || typeof source !== 'object') return {};
    return [1, 2, 3].reduce((modes, gradeNo) => {
        const value = source[gradeNo] ?? source[String(gradeNo)] ?? source[`grade_${gradeNo}_grading_mode`];
        if (value !== undefined && value !== null && value !== '') modes[gradeNo] = value;
        return modes;
    }, {});
}

async function resolveSavedElementaryGradingModes(record) {
    const listModes = elementaryGradingModesFromPayload(record);
    [1, 2, 3].forEach(gradeNo => {
        const key = `grade_${gradeNo}_grading_mode`;
        if (listModes[gradeNo] !== undefined) record[key] = listModes[gradeNo];
    });

    if (Number(record?.school_year_id) > 0 && typeof schoolYearsApi.gradingModes === 'function') {
        try {
            const payload = await schoolYearsApi.gradingModes(record.school_year_id);
            const modes = elementaryGradingModesFromPayload(payload);
            [1, 2, 3].forEach(gradeNo => {
                const key = `grade_${gradeNo}_grading_mode`;
                if (modes[gradeNo] !== undefined) record[key] = modes[gradeNo];
            });
            record.elementary_grading_modes = modes;
        } catch (error) {
            // Keep the list snapshot when the focused read is unavailable.
            // This avoids replacing a saved value with a UI default.
            console.warn('Unable to refresh saved elementary grading modes:', error);
        }
    }

    const defaults = { 1: 'Descriptive', 2: 'Numeric', 3: 'Numeric' };
    const canonicalModes = {};
    [1, 2, 3].forEach(gradeNo => {
        const key = `grade_${gradeNo}_grading_mode`;
        canonicalModes[gradeNo] = gradeNo === 1
            ? 'Descriptive'
            : normalizeElementaryGradingMode(record[key], defaults[gradeNo]);
        record[key] = canonicalModes[gradeNo];
    });
    record.elementary_grading_modes = canonicalModes;
    return canonicalModes;
}

function normalizeSchoolYearListPayload(payload) {
    const rows = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.rows) ? payload.rows : (payload?.data || []));
    if (!Array.isArray(rows)) return payload;
    return rows.map(record => {
        const modes = elementaryGradingModesFromPayload(record);
        [1, 2, 3].forEach(gradeNo => {
            if (modes[gradeNo] === undefined) return;
            record[`grade_${gradeNo}_grading_mode`] = modes[gradeNo];
        });
        return record;
    });
}

function syncElementaryGradingModeControls(record) {
    const defaults = { 1: 'Descriptive', 2: 'Numeric', 3: 'Numeric' };
    [1, 2, 3].forEach(gradeNo => {
        const key = `grade_${gradeNo}_grading_mode`;
        const select = document.getElementById(`field-${key}`);
        if (!select) return;
        const value = gradeNo === 1
            ? 'Descriptive'
            : normalizeElementaryGradingMode(record?.[key], defaults[gradeNo]);
        if (!Array.from(select.options).some(option => String(option.value) === value)) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            select.appendChild(option);
        }
        const options = Array.from(select.options);
        const selectedIndex = options.findIndex(option => String(option.value) === value);
        options.forEach((option, index) => {
            option.selected = index === selectedIndex;
            if (index === selectedIndex) option.setAttribute('selected', 'selected');
            else option.removeAttribute('selected');
        });
        select.selectedIndex = selectedIndex;
        select.value = value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        window.syncFloatingSelect?.(select);
    });
}

function syncSchoolYearStatusControl(record) {
    const checkbox = document.getElementById('field-is_active');
    if (!checkbox) return;

    const isActive = Number(record?.is_active) === 1;
    checkbox.checked = isActive;
    // The active record cannot be switched off because the application must
    // always have one active school year. Inactive records remain editable so
    // this checkbox can be used to activate/switch to them.
    checkbox.disabled = isActive;
    checkbox.title = isActive
        ? 'The active school year cannot be deactivated.'
        : 'Enable this to make this school year active.';
    checkbox.setAttribute('aria-disabled', String(isActive));
}

async function finalizeSchoolYearEdit(record) {
    // Re-read once after the generic modal has populated its controls. This
    // protects the saved values from a stale list snapshot or a default option
    // selected during reference-data loading.
    const gradingModes = await resolveSavedElementaryGradingModes(record);
    syncMappedSchoolYearCurriculumDisplay(record);
    syncSchoolYearStatusControl(record);
    syncElementaryGradingModeControls({
        ...record,
        grade_1_grading_mode: gradingModes[1],
        grade_2_grading_mode: gradingModes[2],
        grade_3_grading_mode: gradingModes[3],
    });
    captureSchoolYearEditSnapshot();
}

function enhanceSchoolYearGradingDropdown() {
    const select = document.getElementById('field-grading_system_type');
    const modal = document.getElementById('recordModal');
    const instance = window.createFloatingSelect?.(select);
    if (!instance || !modal) return;

    // Generic modal actions set select.value programmatically before opening.
    // Refresh the floating label whenever add, edit, or view mode opens.
    new MutationObserver(() => instance.sync()).observe(modal, {
        attributes: true,
        attributeFilter: ['class'],
    });
}

const schoolYearPeriodsApi = {
    list: async (schoolYearId) => axios.get(`${API_BASE_URL}/grading_periods/grading_periods.php`, {
        ...schoolYearNoCache(),
        params: {
            operation: 'getAllGradingPeriods',
            school_year_id: schoolYearId,
            _cb: Date.now()
        }
    }).then(response => schoolYearJsonPayload(response?.data))
};

let schoolYearPeriodState = {
    schoolYearId: null,
    schoolYear: null,
    periods: [],
    mode: 'view',
    editingId: null
};
let schoolYearPeriodActionMenu = null;
let schoolYearEditSnapshot = null;

const schoolYearSnapshotFields = [
    'year_start', 'year_end', 'date_start', 'date_end',
    'grading_system_type', 'is_active',
    'grade_1_grading_mode'
];

function schoolYearCurrentFormSnapshot() {
    return Object.fromEntries(schoolYearSnapshotFields.map(key => {
        const field = document.getElementById(`field-${key}`);
        if (!field) return [key, null];
        return [key, field.type === 'checkbox' ? (field.checked ? '1' : '0') : String(field.value ?? '').trim()];
    }));
}

function schoolYearCurrentPeriodSnapshot() {
    return schoolYearPeriodState.periods.map(period => ({
        id: String(period.grading_period_id),
        date_start: schoolYearPeriodDateValue(period.date_start),
        date_end: schoolYearPeriodDateValue(period.date_end),
        status_mode: schoolYearPeriodStatusMode(period),
        status: schoolYearPeriodStatus(period, schoolYearPeriodState.schoolYear)
    }));
}

function captureSchoolYearEditSnapshot() {
    schoolYearEditSnapshot = {
        fields: schoolYearCurrentFormSnapshot(),
        periods: schoolYearCurrentPeriodSnapshot()
    };
}

function schoolYearHasUnsavedChanges() {
    if (!schoolYearEditSnapshot) return false;
    if (schoolYearPeriodState.editingId !== null) return true;
    return JSON.stringify(schoolYearEditSnapshot.fields) !== JSON.stringify(schoolYearCurrentFormSnapshot())
        || JSON.stringify(schoolYearEditSnapshot.periods) !== JSON.stringify(schoolYearCurrentPeriodSnapshot());
}

function confirmSchoolYearClose() {
    if (!schoolYearHasUnsavedChanges()) return true;
    const prompt = {
        title: 'Leave without saving?',
        message: 'This School Year has changes that are not yet saved. Choose Update School Year to keep them.',
        eyebrow: 'Unsaved changes',
        confirmLabel: 'Leave without saving'
    };
    const decision = typeof window.mfConfirm === 'function'
        ? window.mfConfirm(prompt)
        : window.confirm(`${prompt.title}\n\n${prompt.message}`);
    if (decision && typeof decision.then === 'function') {
        return decision.then(allowClose => {
            if (allowClose) {
                closeSchoolYearPeriodDateModal();
                closeSchoolYearPeriodActionMenu();
                schoolYearEditSnapshot = null;
            }
            return allowClose;
        });
    }
    if (decision) {
        closeSchoolYearPeriodDateModal();
        closeSchoolYearPeriodActionMenu();
        schoolYearEditSnapshot = null;
    }
    return decision;
}

function schoolYearPeriodEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function schoolYearPeriodDateValue(value) {
    const raw = String(value || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function schoolYearPeriodDate(value) {
    const raw = schoolYearPeriodDateValue(value);
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return '—';
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (date.getFullYear() !== Number(match[1])
        || date.getMonth() !== Number(match[2]) - 1
        || date.getDate() !== Number(match[3])) return '—';
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function schoolYearPeriodStatus(period, schoolYear = schoolYearPeriodState.schoolYear) {
    if (schoolYearPeriodStatusMode(period) === 'manual') {
        return String(period?.status_name || period?.status || 'Locked').trim() || 'Locked';
    }
    return schoolYearPeriodAutomaticStatus(period, schoolYear);
}

function schoolYearPeriodStatusMode(period) {
    return String(period?.status_mode || 'automatic').trim().toLowerCase() === 'manual'
        ? 'manual'
        : 'automatic';
}

function schoolYearPeriodAutomaticStatus(period, schoolYear = schoolYearPeriodState.schoolYear) {
    if (Number(schoolYear?.is_active) !== 1) return 'Locked';
    const start = schoolYearPeriodDateValue(period?.date_start);
    const end = schoolYearPeriodDateValue(period?.date_end);
    if (!start || !end) return String(period?.status_name || 'Locked').trim() || 'Locked';
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return today >= start && today <= end ? 'Open' : 'Locked';
}

function schoolYearPeriodStatusBadge(period, schoolYear) {
    const status = schoolYearPeriodStatus(period, schoolYear);
    const statusClass = status.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `<span class="school-year-period-status school-year-period-status--${schoolYearPeriodEscape(statusClass)}">${schoolYearPeriodEscape(status)}</span>`;
}

function schoolYearPeriodNotify(message, type = 'success') {
    if (typeof window.showNotification === 'function') {
        window.showNotification(message, type);
        return;
    }
    if (window.Swal?.fire) {
        window.Swal.fire({
            toast: true,
            position: 'top-end',
            icon: type === 'error' ? 'error' : 'success',
            title: message,
            showConfirmButton: false,
            timer: type === 'error' ? 8000 : 4000
        });
        return;
    }
    window.alert(message);
}

function schoolYearPeriodBounds(schoolYear = schoolYearPeriodState.schoolYear) {
    return {
        min: schoolYearPeriodDateValue(schoolYear?.date_start),
        max: schoolYearPeriodDateValue(schoolYear?.date_end)
    };
}

function schoolYearPeriodOverlaps(periods, periodId, dateStart, dateEnd) {
    if (!dateStart || !dateEnd) return false;
    return periods.some(other => {
        if (String(other.grading_period_id) === String(periodId)) return false;
        const otherStart = schoolYearPeriodDateValue(other.date_start);
        const otherEnd = schoolYearPeriodDateValue(other.date_end);
        return otherStart && otherEnd && dateStart <= otherEnd && dateEnd >= otherStart;
    });
}

function placeSchoolYearPeriodsPanel() {
    const panel = document.getElementById('schoolYearPeriodsPanel');
    const endDateField = document.getElementById('field-date_end');
    const endDateGroup = endDateField?.closest('.form-group');
    if (!panel || !endDateGroup?.parentElement) return;
    if (panel.previousElementSibling !== endDateGroup) {
        endDateGroup.parentElement.insertBefore(panel, endDateGroup.nextSibling);
    }
}

const schoolYearPeriodMonths = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];
const schoolYearPeriodWeekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let schoolYearPeriodDatePickerState = null;

function schoolYearPeriodParseDate(value) {
    const raw = schoolYearPeriodDateValue(value);
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (date.getFullYear() !== Number(match[1])
        || date.getMonth() !== Number(match[2]) - 1
        || date.getDate() !== Number(match[3])) return null;
    return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
}

function schoolYearPeriodPickerBounds(record = schoolYearPeriodState.schoolYear) {
    const configured = schoolYearPeriodBounds(record);
    const fallbackStartYear = Number(record?.year_start) || Number(configured.min.slice(0, 4)) || new Date().getFullYear();
    const fallbackEndYear = Number(record?.year_end) || Number(configured.max.slice(0, 4)) || fallbackStartYear;
    const minYear = Math.min(fallbackStartYear, fallbackEndYear);
    const maxYear = Math.max(fallbackStartYear, fallbackEndYear);
    return {
        min: configured.min || `${minYear}-01-01`,
        max: configured.max || `${maxYear}-12-31`,
        minYear,
        maxYear
    };
}

function schoolYearPeriodPickerYear(periodDate, field, record) {
    const selected = schoolYearPeriodParseDate(periodDate);
    const bounds = schoolYearPeriodPickerBounds(record);
    if (selected && selected.year >= bounds.minYear && selected.year <= bounds.maxYear) return selected.year;
    return field === 'date_end' ? bounds.maxYear : bounds.minYear;
}

function schoolYearPeriodPickerYearAllowed(year, record) {
    const bounds = schoolYearPeriodPickerBounds(record);
    return year >= bounds.minYear && year <= bounds.maxYear;
}

function schoolYearPeriodPickerMonthAllowed(year, month, record) {
    const bounds = schoolYearPeriodPickerBounds(record);
    const monthKey = year * 12 + month;
    const start = schoolYearPeriodParseDate(bounds.min);
    const end = schoolYearPeriodParseDate(bounds.max);
    if (!start || !end) return false;
    return monthKey >= start.year * 12 + start.month && monthKey <= end.year * 12 + end.month;
}

function schoolYearPeriodPickerDateAllowed(year, month, day, record, pickerState = schoolYearPeriodDatePickerState) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const bounds = schoolYearPeriodPickerBounds(record);
    if (iso < bounds.min || iso > bounds.max) return false;

    const currentPeriod = schoolYearPeriodState.periods.find(
        period => String(period.grading_period_id) === String(pickerState?.periodId)
    );
    if (pickerState?.field === 'date_start') {
        const currentEnd = schoolYearPeriodDateValue(currentPeriod?.date_end);
        if (currentEnd && iso > currentEnd) return false;
    }
    if (pickerState?.field === 'date_end') {
        const currentStart = schoolYearPeriodDateValue(currentPeriod?.date_start);
        if (currentStart && iso < currentStart) return false;
    }

    const occupied = schoolYearPeriodState.periods.some(period => {
        if (String(period.grading_period_id) === String(pickerState?.periodId)) return false;
        const otherStart = schoolYearPeriodDateValue(period.date_start);
        const otherEnd = schoolYearPeriodDateValue(period.date_end);
        if (!otherStart && !otherEnd) return false;
        const occupiedStart = otherStart || otherEnd;
        const occupiedEnd = otherEnd || otherStart;
        return iso >= occupiedStart && iso <= occupiedEnd;
    });
    return !occupied;
}

function schoolYearPeriodDateEditor(period, field, record) {
    const value = schoolYearPeriodDateValue(period?.[field]);
    const label = field === 'date_start' ? 'Start date' : 'End date';
    const setupField = field === 'date_start' ? 'period-start' : 'period-end';
    const pickerId = `schoolYearPeriodDatePicker-${period.grading_period_id}-${field}`;
    return `<div class="school-year-period-date-editor setup-date-field" data-date-picker-field="${setupField}">
        <button type="button" class="setup-date-trigger${value ? ' has-value' : ''}" data-sygp-date-trigger="${field}" data-period-id="${schoolYearPeriodEscape(period.grading_period_id)}" aria-label="${label} for ${schoolYearPeriodEscape(period.period_name || 'grading period')}" aria-haspopup="dialog" aria-expanded="false" aria-controls="${schoolYearPeriodEscape(pickerId)}">
            <span class="setup-date-trigger-value">${schoolYearPeriodEscape(value ? schoolYearPeriodDate(value) : `Choose ${label.toLowerCase()}`)}</span>
            <i class="fas fa-calendar-alt" aria-hidden="true"></i>
        </button>
        <input type="hidden" data-sygp-field="${field}" value="${schoolYearPeriodEscape(value)}">
        <div id="${schoolYearPeriodEscape(pickerId)}" class="school-year-period-date-picker" data-sygp-date-picker hidden role="dialog" aria-label="${label}"></div>
    </div>`;
}

function schoolYearPeriodPositionDatePicker() {
    const state = schoolYearPeriodDatePickerState;
    if (!state?.picker || !state.trigger || state.picker.hidden) return;
    const margin = 12;
    const width = Math.min(320, window.innerWidth - margin * 2);
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    state.picker.style.position = 'fixed';
    state.picker.style.width = `${width}px`;
    state.picker.style.maxHeight = `${Math.max(240, viewportHeight - margin * 2)}px`;
    state.picker.style.overflowY = 'auto';
    const rect = state.trigger.getBoundingClientRect();
    const height = state.picker.offsetHeight;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    let top = rect.bottom + 8;
    if (top + height > viewportHeight - margin) top = rect.top - height - 8;
    top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
    state.picker.style.left = `${left}px`;
    state.picker.style.top = `${top}px`;
}

function closeSchoolYearPeriodDatePicker(restoreFocus = false) {
    const state = schoolYearPeriodDatePickerState;
    if (!state) return;
    if (state.picker) {
        state.picker.hidden = true;
        state.picker.removeAttribute('style');
        state.editor?.appendChild(state.picker);
    }
    state.editor?.classList.remove('is-open');
    state.trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !state.trigger?.disabled) state.trigger?.focus();
    schoolYearPeriodDatePickerState = null;
}

function renderSchoolYearPeriodDatePicker() {
    const state = schoolYearPeriodDatePickerState;
    if (!state?.picker) return;
    const record = schoolYearPeriodState.schoolYear;
    const bounds = schoolYearPeriodPickerBounds(record);
    const selected = schoolYearPeriodParseDate(state.input?.value);
    state.year = Math.max(bounds.minYear, Math.min(bounds.maxYear, Number(state.year) || bounds.minYear));
    const previousYearDisabled = !schoolYearPeriodPickerYearAllowed(state.year - 1, record);
    const nextYearDisabled = !schoolYearPeriodPickerYearAllowed(state.year + 1, record);
    const yearControls = `
        <button class="setup-date-nav" type="button" data-sygp-date-action="previous-year" aria-label="Previous year"${previousYearDisabled ? ' disabled' : ''}><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
        <strong class="setup-date-year">${state.year}</strong>
        <button class="setup-date-nav" type="button" data-sygp-date-action="next-year" aria-label="Next year"${nextYearDisabled ? ' disabled' : ''}><i class="fas fa-chevron-right" aria-hidden="true"></i></button>`;
    const header = `<div class="setup-date-picker-header">
        ${yearControls}
        <button class="setup-date-close" type="button" data-sygp-date-action="close" aria-label="Close date picker"><i class="fas fa-times" aria-hidden="true"></i></button>
    </div>`;

    if (state.view === 'months') {
        const monthButtons = schoolYearPeriodMonths.map((month, index) => ({ month, index }))
            .filter(({ index }) => schoolYearPeriodPickerMonthAllowed(state.year, index, record))
            .map(({ month, index }) => {
                const isCurrent = selected?.year === state.year && selected.month === index;
                return `<button type="button" data-sygp-date-action="month" data-month="${index}" aria-pressed="${isCurrent}"${isCurrent ? ' class="is-current"' : ''}>${month}</button>`;
            }).join('');
        state.picker.innerHTML = `${header}<p class="setup-date-picker-hint">Choose a month</p><div class="setup-date-month-grid" role="group" aria-label="Months in ${state.year}">${monthButtons}</div>`;
    } else {
        const month = Math.max(0, Math.min(11, Number(state.month) || 0));
        const daysInMonth = new Date(state.year, month + 1, 0).getDate();
        const firstWeekday = new Date(state.year, month, 1).getDay();
        const blanks = Array.from({ length: firstWeekday }, () => '<span class="setup-date-empty" aria-hidden="true"></span>').join('');
        const days = Array.from({ length: daysInMonth }, (_, index) => {
            const day = index + 1;
            const iso = `${state.year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const allowed = schoolYearPeriodPickerDateAllowed(state.year, month, day, record, state);
            const isSelected = selected?.year === state.year && selected.month === month && selected.day === day;
            return `<button type="button" data-sygp-date-value="${iso}" data-date="${iso}" aria-pressed="${isSelected}"${allowed ? '' : ' disabled'}${isSelected ? ' class="is-selected"' : ''}>${day}</button>`;
        }).join('');
        state.picker.innerHTML = `${header}<div class="setup-date-month-heading"><button type="button" data-sygp-date-action="months" aria-label="Choose another month"><i class="fas fa-chevron-left" aria-hidden="true"></i> Months</button><strong>${schoolYearPeriodMonths[month]}</strong></div><div class="setup-date-day-grid" role="group" aria-label="Days in ${schoolYearPeriodMonths[month]} ${state.year}">${schoolYearPeriodWeekdays.map(day => `<span class="setup-date-weekday" aria-hidden="true">${day}</span>`).join('')}${blanks}${days}</div>`;
    }
    state.picker.hidden = false;
    schoolYearPeriodPositionDatePicker();
}

function openSchoolYearPeriodDatePicker(trigger) {
    const editor = trigger.closest('.school-year-period-date-editor');
    const picker = editor?.querySelector('[data-sygp-date-picker]');
    const input = editor?.querySelector(`[data-sygp-field="${trigger.dataset.sygpDateTrigger}"]`);
    if (!editor || !picker || !input) return;
    closeSchoolYearPeriodDatePicker();
    schoolYearPeriodDatePickerState = {
        trigger,
        editor,
        picker,
        input,
        field: trigger.dataset.sygpDateTrigger,
        periodId: trigger.dataset.periodId,
        year: schoolYearPeriodPickerYear(input.value, trigger.dataset.sygpDateTrigger, schoolYearPeriodState.schoolYear),
        month: schoolYearPeriodParseDate(input.value)?.month ?? 0,
        view: 'months'
    };
    editor.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    document.body.appendChild(picker);
    renderSchoolYearPeriodDatePicker();
}

function handleSchoolYearPeriodDatePickerClick(event) {
    const state = schoolYearPeriodDatePickerState;
    if (!state?.picker) return;
    const action = event.target.closest('[data-sygp-date-action]')?.dataset.sygpDateAction;
    if (action === 'close') {
        closeSchoolYearPeriodDatePicker(true);
        return;
    }
    if (action === 'previous-year' || action === 'next-year') {
        const nextYear = state.year + (action === 'previous-year' ? -1 : 1);
        if (!schoolYearPeriodPickerYearAllowed(nextYear, schoolYearPeriodState.schoolYear)) return;
        state.year = nextYear;
        state.view = 'months';
        renderSchoolYearPeriodDatePicker();
        state.picker.querySelector(`[data-sygp-date-action="${action}"]`)?.focus({ preventScroll: true });
        return;
    }
    if (action === 'months') {
        state.view = 'months';
        renderSchoolYearPeriodDatePicker();
        return;
    }
    if (action === 'month') {
        state.month = Number(event.target.closest('[data-month]')?.dataset.month || 0);
        state.view = 'days';
        renderSchoolYearPeriodDatePicker();
        return;
    }
    const dateButton = event.target.closest('[data-sygp-date-value]');
    if (!dateButton || dateButton.disabled) return;
    state.input.value = dateButton.dataset.sygpDateValue;
    state.input.dispatchEvent(new Event('change', { bubbles: true }));
    const value = state.trigger.querySelector('.setup-date-trigger-value');
    if (value) value.textContent = schoolYearPeriodDate(state.input.value);
    state.trigger.classList.add('has-value');
    closeSchoolYearPeriodDatePicker(true);
}

function renderSchoolYearPeriods(record, mode = schoolYearPeriodState.mode) {
    const panel = document.getElementById('schoolYearPeriodsPanel');
    if (!panel) return;

    closeSchoolYearPeriodDatePicker();
    closeSchoolYearPeriodActionMenu();
    schoolYearPeriodState.mode = mode;
    schoolYearPeriodState.schoolYear = record;
    panel.hidden = false;

    const isEdit = mode === 'edit';
    const periods = schoolYearPeriodState.periods;
    panel.classList.toggle('is-edit', isEdit);

    panel.innerHTML = `
        <div class="school-year-periods-header">
            <div>
                <h3 class="school-year-periods-title">Grading periods</h3>
                ${isEdit ? '<p class="school-year-periods-help" role="note"><i class="fas fa-circle-exclamation" aria-hidden="true"></i><span>Click the period row to show control options.</span></p>' : ''}
            </div>
        </div>
        <div class="school-year-periods-table-wrap">
            <table class="school-year-periods-table">
                <thead>
                    <tr>
                        <th>Period</th>
                        <th>Start date</th>
                        <th>End date</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${periods.length ? periods.map(period => {
                        const rowActionAttrs = isEdit
                            ? ` tabindex="0" class="school-year-period-row school-year-period-row--actionable" aria-haspopup="menu" aria-label="Actions for ${schoolYearPeriodEscape(period.period_name || 'grading period')}"`
                            : '';
                        return `<tr data-school-year-period-id="${schoolYearPeriodEscape(period.grading_period_id)}"${rowActionAttrs}>
                            <td data-label="Period">
                                <span class="school-year-period-name">${schoolYearPeriodEscape(period.period_name || 'Grading period')}</span>
                                <span class="school-year-period-number">Period ${schoolYearPeriodEscape(period.period_no || '—')}</span>
                                ${isEdit ? `<div class="mf-row-action-source" hidden>
                                    <button type="button" data-action="edit" data-sygp-row-action="edit" data-period-id="${schoolYearPeriodEscape(period.grading_period_id)}" aria-label="Edit dates">Edit dates</button>
                                    <button type="button" data-action="toggle" data-sygp-row-action="toggle" data-period-id="${schoolYearPeriodEscape(period.grading_period_id)}" aria-label="${schoolYearPeriodStatus(period, record).toLowerCase() === 'open' ? 'Lock period' : 'Open period'}">${schoolYearPeriodStatus(period, record).toLowerCase() === 'open' ? 'Lock period' : 'Open period'}</button>
                                    ${schoolYearPeriodStatusMode(period) === 'manual' ? `<button type="button" data-action="automatic" data-sygp-row-action="automatic" data-period-id="${schoolYearPeriodEscape(period.grading_period_id)}" aria-label="Use automatic dates">Use automatic dates</button>` : ''}
                                </div>` : ''}
                            </td>
                            <td data-label="Start date"><span class="school-year-period-date">${schoolYearPeriodEscape(schoolYearPeriodDate(period.date_start))}</span></td>
                            <td data-label="End date"><span class="school-year-period-date">${schoolYearPeriodEscape(schoolYearPeriodDate(period.date_end))}</span></td>
                            <td data-label="Status">${schoolYearPeriodStatusBadge(period, record)}</td>
                        </tr>`;
                    }).join('') : '<tr><td class="school-year-periods-empty" colspan="4">No grading periods have been configured for this school year.</td></tr>'}
                </tbody>
            </table>
        </div>`;
}

async function loadSchoolYearPeriods(record, mode) {
    const panel = document.getElementById('schoolYearPeriodsPanel');
    const schoolYearId = Number(record?.school_year_id || 0);
    if (!panel || schoolYearId <= 0) return;

    placeSchoolYearPeriodsPanel();
    schoolYearPeriodState = {
        schoolYearId,
        schoolYear: record,
        periods: [],
        mode: mode || 'view',
        editingId: null
    };
    panel.hidden = false;
    panel.innerHTML = '<div class="school-year-periods-loading"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Loading grading periods…</div>';

    try {
        const payload = await schoolYearPeriodsApi.list(schoolYearId);
        const rows = Array.isArray(payload)
            ? payload
            : (Array.isArray(payload?.data) ? payload.data : []);
        schoolYearPeriodState.periods = rows
            .sort((a, b) => Number(a.period_no || 0) - Number(b.period_no || 0))
            .map(period => ({
                ...period,
                __originalDateStart: schoolYearPeriodDateValue(period.date_start),
                __originalDateEnd: schoolYearPeriodDateValue(period.date_end),
                __originalStatusMode: schoolYearPeriodStatusMode(period),
                __originalStatus: schoolYearPeriodStatus(period, record),
                __dirty: false
            }));
        renderSchoolYearPeriods(record, mode);
    } catch (error) {
        console.error('Unable to load grading periods for school year:', error);
        panel.innerHTML = '<div class="school-year-periods-error">Unable to load grading periods for this school year. Please try again.</div>';
    }
}

function toggleSchoolYearPeriod(periodId) {
    const period = schoolYearPeriodState.periods.find(item => String(item.grading_period_id) === String(periodId));
    if (!period) return;

    const currentStatus = schoolYearPeriodStatus(period, schoolYearPeriodState.schoolYear).toLowerCase();
    period.status_mode = 'manual';
    period.status_name = currentStatus === 'open' ? 'Locked' : 'Open';
    period.__dirty = period.status_name !== period.__originalStatus
        || schoolYearPeriodStatusMode(period) !== period.__originalStatusMode
        || schoolYearPeriodDateValue(period.date_start) !== period.__originalDateStart
        || schoolYearPeriodDateValue(period.date_end) !== period.__originalDateEnd;
    closeSchoolYearPeriodActionMenu();
    renderSchoolYearPeriods(schoolYearPeriodState.schoolYear, 'edit');
}

function useAutomaticSchoolYearPeriod(periodId) {
    const period = schoolYearPeriodState.periods.find(item => String(item.grading_period_id) === String(periodId));
    if (!period) return;

    period.status_mode = 'automatic';
    period.status_name = schoolYearPeriodAutomaticStatus(period, schoolYearPeriodState.schoolYear);
    period.__dirty = period.status_name !== period.__originalStatus
        || schoolYearPeriodStatusMode(period) !== period.__originalStatusMode
        || schoolYearPeriodDateValue(period.date_start) !== period.__originalDateStart
        || schoolYearPeriodDateValue(period.date_end) !== period.__originalDateEnd;
    closeSchoolYearPeriodActionMenu();
    renderSchoolYearPeriods(schoolYearPeriodState.schoolYear, 'edit');
}

function closeSchoolYearPeriodActionMenu() {
    schoolYearPeriodActionMenu?.remove();
    schoolYearPeriodActionMenu = null;
    document.getElementById('mfContextMenu')?.remove();
    document.body.classList.remove('mf-mobile-sheet-open');
}

function openSchoolYearPeriodActionMenu(periodId, anchor, clickPoint = null) {
    if (schoolYearPeriodState.mode !== 'edit') return;
    const period = schoolYearPeriodState.periods.find(item => String(item.grading_period_id) === String(periodId));
    if (!period) return;
    const rect = anchor?.getBoundingClientRect?.() || { left: 16, top: 16, width: 0, bottom: 58 };
    const menuPoint = {
        clientX: Number.isFinite(Number(clickPoint?.clientX))
            ? Number(clickPoint.clientX)
            : rect.left + (rect.width / 2),
        clientY: Number.isFinite(Number(clickPoint?.clientY))
            ? Number(clickPoint.clientY)
            : (rect.bottom || rect.top + 32)
    };

    if (typeof window.mfOpenContextMenu === 'function') {
        closeSchoolYearPeriodDatePicker();
        closeSchoolYearPeriodActionMenu();
        window.mfOpenContextMenu(menuPoint, anchor, { position: 'point' });
        return;
    }

    closeSchoolYearPeriodDatePicker();
    closeSchoolYearPeriodActionMenu();
    const status = schoolYearPeriodStatus(period, schoolYearPeriodState.schoolYear);
    const toggleLabel = status.toLowerCase() === 'open' ? 'Lock period' : 'Open period';
    const toggleIcon = status.toLowerCase() === 'open' ? 'fa-lock' : 'fa-lock-open';
    const menu = document.createElement('div');
    menu.className = 'school-year-period-row-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
        <button type="button" role="menuitem" data-sygp-row-action="edit" data-period-id="${schoolYearPeriodEscape(periodId)}">
            <i class="fas fa-pen" aria-hidden="true"></i><span>Edit dates</span>
        </button>
        <button type="button" role="menuitem" data-sygp-row-action="toggle" data-period-id="${schoolYearPeriodEscape(periodId)}">
            <i class="fas ${toggleIcon}" aria-hidden="true"></i><span>${toggleLabel}</span>
        </button>
        ${schoolYearPeriodStatusMode(period) === 'manual' ? `<button type="button" role="menuitem" data-sygp-row-action="automatic" data-period-id="${schoolYearPeriodEscape(periodId)}">
            <i class="fas fa-calendar-check" aria-hidden="true"></i><span>Use automatic dates</span>
        </button>` : ''}`;
    document.body.appendChild(menu);
    const menuWidth = Math.max(188, menu.offsetWidth || 188);
    const menuHeight = menu.offsetHeight || 96;
    const margin = 12;
    const left = Math.max(margin, Math.min(menuPoint.clientX, window.innerWidth - menuWidth - margin));
    const top = Math.max(margin, Math.min(menuPoint.clientY, window.innerHeight - menuHeight - margin));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    schoolYearPeriodActionMenu = menu;
    menu.querySelector('button')?.focus({ preventScroll: true });
}

function closeSchoolYearPeriodDateModal() {
    closeSchoolYearPeriodDatePicker();
    const modal = document.getElementById('schoolYearPeriodModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    const fields = modal.querySelector('[data-sygp-period-modal-fields]');
    fields?.removeAttribute('data-sygp-period-editor');
    fields?.replaceChildren();
    modal.querySelector('[data-sygp-period-modal-error]')?.replaceChildren();
    schoolYearPeriodState.editingId = null;
}

function openSchoolYearPeriodDateModal(periodId) {
    if (schoolYearPeriodState.mode !== 'edit') return;
    const period = schoolYearPeriodState.periods.find(item => String(item.grading_period_id) === String(periodId));
    const modal = document.getElementById('schoolYearPeriodModal');
    const fields = modal?.querySelector('[data-sygp-period-modal-fields]');
    if (!period || !modal || !fields) return;
    if (schoolYearPeriodState.editingId !== null
        && String(schoolYearPeriodState.editingId) !== String(periodId)) {
        schoolYearPeriodNotify('Save or cancel the current grading-period edit first.', 'error');
        return;
    }

    closeSchoolYearPeriodActionMenu();
    schoolYearPeriodState.editingId = String(periodId);
    fields.dataset.sygpPeriodEditor = String(periodId);
    modal.querySelector('[data-sygp-period-modal-title]').textContent = `${period.period_name || `Period ${period.period_no}`} dates`;
    fields.innerHTML = `
        <div class="school-year-period-modal-field">
            <label>Start Date</label>
            ${schoolYearPeriodDateEditor(period, 'date_start', schoolYearPeriodState.schoolYear)}
        </div>
        <div class="school-year-period-modal-field">
            <label>End Date</label>
            ${schoolYearPeriodDateEditor(period, 'date_end', schoolYearPeriodState.schoolYear)}
        </div>`;
    modal.querySelector('[data-sygp-period-modal-error]')?.replaceChildren();
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => fields.querySelector('[data-sygp-date-trigger]')?.focus(), 0);
}

function cancelSchoolYearPeriodEdit() {
    closeSchoolYearPeriodDateModal();
}

function schoolYearPeriodModalError(message) {
    const modal = document.getElementById('schoolYearPeriodModal');
    const error = modal?.querySelector('[data-sygp-period-modal-error]');
    if (modal?.classList.contains('show') && error) {
        error.textContent = message;
        return;
    }
    schoolYearPeriodNotify(message, 'error');
}

function schoolYearPeriodDateDraft(periodId) {
    const period = schoolYearPeriodState.periods.find(item => String(item.grading_period_id) === String(periodId));
    const row = Array.from(document.querySelectorAll('#schoolYearPeriodsPanel tr[data-school-year-period-id]'))
        .find(item => String(item.dataset.schoolYearPeriodId) === String(periodId));
    const editor = Array.from(document.querySelectorAll('#schoolYearPeriodModal [data-sygp-period-editor]'))
        .find(item => String(item.dataset.sygpPeriodEditor) === String(periodId));
    const source = editor || row;
    if (!period || !source) return null;

    const dateStart = schoolYearPeriodDateValue(source.querySelector('[data-sygp-field="date_start"]')?.value);
    const dateEnd = schoolYearPeriodDateValue(source.querySelector('[data-sygp-field="date_end"]')?.value);
    if (!dateStart || !dateEnd) {
        schoolYearPeriodModalError('Choose both a start date and an end date.');
        return null;
    }
    if (dateStart > dateEnd) {
        schoolYearPeriodModalError('End date must be on or after start date.');
        return null;
    }
    const { min, max } = schoolYearPeriodBounds();
    if ((min && ((dateStart && dateStart < min) || (dateEnd && dateEnd < min)))
        || (max && ((dateStart && dateStart > max) || (dateEnd && dateEnd > max)))) {
        schoolYearPeriodModalError(`Period dates must fall within the school year (${schoolYearPeriodDate(min)} – ${schoolYearPeriodDate(max)}).`);
        return null;
    }
    if (schoolYearPeriodOverlaps(schoolYearPeriodState.periods, periodId, dateStart, dateEnd)) {
        schoolYearPeriodModalError('Choose dates that are available for this grading period.');
        return null;
    }

    return { dateStart: dateStart || null, dateEnd: dateEnd || null };
}

function applySchoolYearPeriodDraft(periodId) {
    const period = schoolYearPeriodState.periods.find(item => String(item.grading_period_id) === String(periodId));
    if (!period) return;
    const draft = schoolYearPeriodDateDraft(periodId);
    if (!draft) return;
    period.date_start = draft.dateStart;
    period.date_end = draft.dateEnd;
    period.__dirty = draft.dateStart !== period.__originalDateStart
        || draft.dateEnd !== period.__originalDateEnd
        || schoolYearPeriodStatusMode(period) !== period.__originalStatusMode
        || schoolYearPeriodStatus(period, schoolYearPeriodState.schoolYear) !== period.__originalStatus;
    closeSchoolYearPeriodDateModal();
    renderSchoolYearPeriods(schoolYearPeriodState.schoolYear, 'edit');
}

function saveSchoolYearPeriodDateModal() {
    const periodId = schoolYearPeriodState.editingId;
    if (periodId === null) return;
    applySchoolYearPeriodDraft(periodId);
}

function schoolYearPeriodPayloadForSave() {
    const periods = schoolYearPeriodState.periods.map(period => ({ ...period }));
    if (schoolYearPeriodState.editingId !== null) {
        const draft = schoolYearPeriodDateDraft(schoolYearPeriodState.editingId);
        if (!draft) {
            throw new Error('Save or cancel the current grading-period edit before updating the school year.');
        }
        const period = periods.find(item => String(item.grading_period_id) === String(schoolYearPeriodState.editingId));
        if (period) {
            period.date_start = draft.dateStart;
            period.date_end = draft.dateEnd;
            period.__dirty = draft.dateStart !== period.__originalDateStart
                || draft.dateEnd !== period.__originalDateEnd
                || schoolYearPeriodStatusMode(period) !== period.__originalStatusMode
                || schoolYearPeriodStatus(period, schoolYearPeriodState.schoolYear) !== period.__originalStatus;
        }
    }
    return periods
        .filter(period => period.__dirty)
        .map(period => ({
            grading_period_id: period.grading_period_id,
            date_start: period.date_start || null,
            date_end: period.date_end || null,
            status_mode: schoolYearPeriodStatusMode(period),
            status: schoolYearPeriodStatus(period, schoolYearPeriodState.schoolYear)
        }));
}

function bindSchoolYearPeriodControls() {
    const panel = document.getElementById('schoolYearPeriodsPanel');
    if (!panel || panel.dataset.bound === 'true') return;
    panel.dataset.bound = 'true';
    panel.addEventListener('click', event => {
        const row = event.target.closest('tr[data-school-year-period-id]');
        if (!row || !panel.contains(row) || schoolYearPeriodState.mode !== 'edit' || event.target.closest('button, input, select, textarea, a')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openSchoolYearPeriodActionMenu(row.dataset.schoolYearPeriodId, row, {
            clientX: event.clientX,
            clientY: event.clientY
        });
    });
    panel.addEventListener('keydown', event => {
        const row = event.target.closest('tr[data-school-year-period-id]');
        if (!row || !panel.contains(row) || schoolYearPeriodState.mode !== 'edit') return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openSchoolYearPeriodActionMenu(row.dataset.schoolYearPeriodId, row);
    });

    document.addEventListener('click', event => {
        const actionButton = event.target.closest('[data-sygp-row-action]');
        if (actionButton && schoolYearPeriodActionMenu?.contains(actionButton)) {
            const action = actionButton.dataset.sygpRowAction;
            const periodId = actionButton.dataset.periodId;
            closeSchoolYearPeriodActionMenu();
            if (action === 'edit') openSchoolYearPeriodDateModal(periodId);
            if (action === 'toggle') toggleSchoolYearPeriod(periodId);
            if (action === 'automatic') useAutomaticSchoolYearPeriod(periodId);
            return;
        }
        if (actionButton && actionButton.dataset.sygpRowAction) {
            const action = actionButton.dataset.sygpRowAction;
            const periodId = actionButton.dataset.periodId;
            if (action === 'edit') openSchoolYearPeriodDateModal(periodId);
            if (action === 'toggle') toggleSchoolYearPeriod(periodId);
            if (action === 'automatic') useAutomaticSchoolYearPeriod(periodId);
            return;
        }
        // The period panel owns clicks on editable grading-period rows. Keep
        // this outside-click handler from closing the menu that the row just
        // opened during the same event cycle.
        const periodRow = event.target.closest?.('#schoolYearPeriodsPanel tr[data-school-year-period-id]');
        if (periodRow && schoolYearPeriodState.mode === 'edit') return;
        if (schoolYearPeriodActionMenu?.contains(event.target)) return;

        const trigger = event.target.closest('[data-sygp-date-trigger]');
        const periodModal = document.getElementById('schoolYearPeriodModal');
        if (trigger && (panel.contains(trigger) || periodModal?.contains(trigger))) {
            event.preventDefault();
            openSchoolYearPeriodDatePicker(trigger);
            return;
        }

        closeSchoolYearPeriodActionMenu();
        const state = schoolYearPeriodDatePickerState;
        if (!state) return;
        const path = event.composedPath?.() || [];
        if (state.picker && path.includes(state.picker)) {
            handleSchoolYearPeriodDatePickerClick(event);
            return;
        }
        closeSchoolYearPeriodDatePicker();
    });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (schoolYearPeriodDatePickerState) return closeSchoolYearPeriodDatePicker(true);
        if (document.getElementById('schoolYearPeriodModal')?.classList.contains('show')) return closeSchoolYearPeriodDateModal();
        closeSchoolYearPeriodActionMenu();
    });
    document.querySelector('[data-sygp-period-modal-close]')?.addEventListener('click', closeSchoolYearPeriodDateModal);
    document.querySelector('[data-sygp-period-modal-cancel]')?.addEventListener('click', closeSchoolYearPeriodDateModal);
    document.querySelector('[data-sygp-period-modal-save]')?.addEventListener('click', saveSchoolYearPeriodDateModal);
    document.getElementById('schoolYearPeriodModal')?.addEventListener('click', event => {
        if (event.target?.id === 'schoolYearPeriodModal') closeSchoolYearPeriodDateModal();
    });
    document.addEventListener('scroll', schoolYearPeriodPositionDatePicker, true);
    window.addEventListener('resize', schoolYearPeriodPositionDatePicker);
}

async function prepareSchoolYearView(record) {
    schoolYearEditSnapshot = null;
    await resolveMappedSchoolYearCurriculum(record);
    const gradingModes = await resolveSavedElementaryGradingModes(record);
    syncMappedSchoolYearCurriculumDisplay(record);
    syncElementaryGradingModeControls({
        ...record,
        grade_1_grading_mode: gradingModes[1],
        grade_2_grading_mode: gradingModes[2],
        grade_3_grading_mode: gradingModes[3],
    });
    await loadSchoolYearPeriods(record, 'view');
}

async function prepareSchoolYearEdit(record) {
    schoolYearEditSnapshot = null;
    await loadMappedSchoolYearCurriculum(record);
    await resolveSavedElementaryGradingModes(record);
    await loadSchoolYearPeriods(record, 'edit');
}

const gradingSystemOptions = [
    { value: 'Quarterly', label: 'Quarterly' },
    { value: 'Three-Term', label: 'Three-Term' }
];

const elementaryGradingModeOptions = [
    { value: 'Descriptive', label: 'Descriptive' }
];

document.addEventListener('DOMContentLoaded', () => {
    initializeMasterfile({
        key: 'school_years',
        navKey: 'school_years',
        entity: 'School Year',
        pageTitle: 'School Years',
        subtitle: 'Manage school year definitions',
        breadcrumb: 'School Years',
        disableAdd: true,
        primaryKey: 'school_year_id',
        enableView: true,
        canEdit: () => true,
        canDelete: (row) => Number(row?.is_active) !== 1,
        beforeOpenView: prepareSchoolYearView,
        beforeOpenEdit: prepareSchoolYearEdit,
        afterOpenEdit: finalizeSchoolYearEdit,
        validate(payload) {
            const duplicate = Array.isArray(MF_RECORDS) && MF_RECORDS.some((row) => (
                String(row?.school_year_id) !== String(MF_CURRENT_ID ?? '')
                && Number(row?.year_start) === Number(payload?.year_start)
                && Number(row?.year_end) === Number(payload?.year_end)
            ));
            if (!duplicate) return null;
            return {
                year_start: 'This school year already exists. Choose a different year range.',
                year_end: 'This school year already exists. Choose a different year range.'
            };
        },
        // Related curriculum, policy, and grading-period data are loaded after
        // the editor opens so a slow request never hides the Edit modal.
        openModalBeforeAsyncEdit: true,
        confirmClose: confirmSchoolYearClose,
        columns: [
            { key: 'year_label', label: 'School Year', formatter: (_value, row) => row.year_label || `${row.year_start}-${row.year_end}` },
            { key: 'curriculum_display_name', label: 'Curriculum', tableVisible: false, formatter: (value) => value || 'Not assigned' },
            { key: 'system_name', label: 'Periods Number Type' },
            {
                key: 'is_active',
                label: 'Status',
                tableVisible: true,
                formatter: (value) => {
                    const active = Number(value) === 1;
                    return `<span class="status-badge ${active ? 'active' : 'inactive'}">${active ? 'Active' : 'Inactive'}</span>`;
                }
            }
        ],
        fieldSections: [
            {
                title: 'School year details',
                fields: [
                    { key: 'year_start', label: 'Year Start', type: 'number', required: true },
                    { key: 'year_end', label: 'Year End', type: 'number', required: true },
                    { key: 'date_start', label: 'Start Date', type: 'academic-date', defaultYearField: 'year_start', omitIfEmpty: true },
                    { key: 'date_end', label: 'End Date', type: 'academic-date', defaultYearField: 'year_end', omitIfEmpty: true },
                    {
                        key: 'curriculum_id',
                        label: 'Curriculum',
                        type: 'readonly-reference',
                        displayKey: 'curriculum_display_name',
                        viewDisplayKey: 'curriculum_display_name',
                        emptyText: 'Not assigned',
                        helpText: 'Curriculum templates are preserved per school year. Manage curriculum versions in Curriculum Components.'
                    },
                    {
                        key: 'grading_system_type',
                        label: 'Periods Number Type',
                        type: 'select',
                        required: true,
                        valueKey: 'value',
                        labelKey: 'label',
                        optionLabelKey: 'label',
                        viewDisplayKey: 'system_name',
                        displayTransform: (value) => value === 'Semester' ? '' : value,
                        loadOptions: async () => gradingSystemOptions
                    },
                    { key: 'is_active', label: 'Set as Active Year', type: 'checkbox', defaultValue: false }
                ]
            },
            {
                title: 'Elementary grading mode',
                fields: [
                    {
                        key: 'grade_1_grading_mode',
                        label: 'Grade 1 mode',
                        type: 'select',
                        required: true,
                        valueKey: 'value',
                        labelKey: 'label',
                        optionLabelKey: 'label',
                        defaultValue: 'Descriptive',
                        options: elementaryGradingModeOptions
                    }
                ]
            }
        ],
        api: schoolYearsApi
    });

    enhanceSchoolYearGradingDropdown();
    bindSchoolYearPeriodControls();
});
