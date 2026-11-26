const API_BASE_URL = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;
axios.defaults.withCredentials = true;

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function currentMonthStr() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function attendanceMonthsForSchoolYear(schoolYear) {
    const { min, max } = attendanceSchoolYearDateBounds(schoolYear);
    if (!min || !max) return [];
    const start = min.slice(0, 7);
    const end = max.slice(0, 7);

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const [startYear, startMonth] = start.split('-').map(Number);
    const [endYear, endMonth] = end.split('-').map(Number);
    const endValue = endYear * 12 + endMonth;
    const options = [];
    for (let value = startYear * 12 + startMonth; value <= endValue; value++) {
        const year = Math.floor((value - 1) / 12);
        const month = (value - 1) % 12;
        options.push({ value: `${year}-${String(month + 1).padStart(2, '0')}`, label: monthNames[month] });
    }
    return options;
}

let attendanceMonthPicker = null;

function attendanceSchoolYearDateBounds(schoolYear) {
    const min = String(schoolYear?.date_start || '').slice(0, 10);
    const max = String(schoolYear?.date_end || '').slice(0, 10);
    const validDate = (value) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const [year, month, day] = value.split('-').map(Number);
        const date = new Date(0);
        date.setFullYear(year, month - 1, day);
        date.setHours(12, 0, 0, 0);
        return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
    };
    return validDate(min) && validDate(max) && min <= max ? { min, max } : { min: null, max: null };
}

function syncAttendanceMonthControl(input, schoolYear = null) {
    if (!input) return;
    const bounds = attendanceSchoolYearDateBounds(schoolYear);
    const inScopeMonths = attendanceMonthsForSchoolYear(schoolYear);
    const inScope = inScopeMonths.length > 0;

    input.disabled = !inScope;
    if (!inScope) input.value = '';
    attendanceMonthPicker?.setOptions(bounds);
    if (attendanceMonthPicker?.trigger) attendanceMonthPicker.trigger.disabled = !inScope;
    attendanceMonthPicker?.refresh();
}

function populateAttendanceMonthOptions(input, schoolYear, preferredMonth = '') {
    if (!input) return '';
    const options = attendanceMonthsForSchoolYear(schoolYear);
    const available = new Set(options.map((option) => option.value));
    const currentMonth = currentMonthStr();
    const selected = available.has(preferredMonth)
        ? preferredMonth
        : available.has(currentMonth)
            ? currentMonth
            : (options[0]?.value || '');
    input.value = selected;
    syncAttendanceMonthControl(input, schoolYear);
    return selected;
}

function normalizeGender(gender) {
    const g = String(gender || '').trim().toLowerCase();
    if (g === 'male' || g === 'm') return 'Male';
    if (g === 'female' || g === 'f') return 'Female';
    if (g) return 'Other';
    return '';
}

function toast(icon, title) {
    const kind = String(icon || 'info').toLowerCase();
    const tone = (kind === 'success' || kind === 'error' || kind === 'warning' || kind === 'info') ? kind : 'info';
    const normalized = tone === 'warning' ? 'info' : tone;

    if (typeof window.showNotification === 'function') {
        window.showNotification(title, normalized);
        return Promise.resolve();
    }

    if (typeof Swal !== 'undefined' && typeof Swal.fire === 'function') {
        return Swal.fire({
            toast: true,
            position: 'bottom-end',
            showConfirmButton: false,
            timer: 2400,
            timerProgressBar: true,
            icon: tone,
            title,
        });
    }

    if (typeof window.alert === 'function') window.alert(title);
    return Promise.resolve();
}

async function apiGet(path, params) {
    const res = await axios.get(`${API_BASE_URL}${path}`, { params: { ...params, _: Date.now() } });
    return res.data;
}

async function apiPost(path, params, body) {
    const res = await axios.post(`${API_BASE_URL}${path}?${new URLSearchParams(params)}`, body);
    return res.data;
}

const schoolYearsApi = {
    list: () => apiGet('/school_years/school_years.php', { operation: 'getAllSchoolYears' }),
};

const sectionsApi = {
    list: (schoolYearId) => apiGet('/sections/sections.php', { operation: 'getAllSections', school_year_id: Number(schoolYearId) || 0 }),
};

const attendanceApi = {
    roster: ({ sectionId, schoolYearId }) => apiGet('/attendance/attendance.php', {
        operation: 'getSectionRoster',
        section_id: Number(sectionId),
        school_year_id: Number(schoolYearId),
    }),
    myAttendance: (params = {}) => apiGet('/attendance/attendance.php', { operation: 'getMyAttendance', ...params }),
    monthlyGrid: ({ sectionId, schoolYearId, month }) => apiGet('/attendance/attendance.php', {
        operation: 'getMonthlyGrid',
        section_id: Number(sectionId),
        school_year_id: Number(schoolYearId),
        month,
    }),
    saveMonthlyGrid: ({ sectionId, schoolYearId, month, entries }) => apiPost('/attendance/attendance.php', {
        operation: 'saveMonthlyGrid',
    }, {
        section_id: Number(sectionId),
        school_year_id: Number(schoolYearId),
        month,
        entries,
    }),
};

function isLearnerRole() {
    const rname = String(window.CURRENT_ROLE_NAME || '').toLowerCase();
    const rid = Number(window.CURRENT_ROLE_ID || 0);
    return rname.includes('learner') || rname.includes('student') || rid === 10;
}

function canEditAttendanceRecords() {
    const role = String(window.CURRENT_ROLE_NAME || '').trim().toLowerCase();
    const roleId = Number(window.CURRENT_ROLE_ID || 0);
    if (roleId === 8 || role.includes('admin')) return false;
    return roleId === 9 || role.includes('teacher') || role.includes('adviser') || role.includes('advisor');
}

const state = {
    schoolYears: [],
    sections: [],
    roster: [],
    dirty: false,
    saving: false,
    canEditAttendance: false,
    lastSel: { syId: 0, yearLevelId: 'all', sectionId: 0, month: '' },
    learnerMonthlyRows: [],
    learnerWholeYearSummary: null,
    learnerEmptyMessage: '',
    monthDays: [],
    monthMarks: new Map(),
    originalMonthMarks: new Map(),
    nonSchoolDays: new Map(),
    originalNonSchoolDays: new Map(),
    monthHasUnrecordedCells: false,
};

function setSaveIndicator(kind, text) {
    const el = document.getElementById('attSaveInd');
    const lbl = document.getElementById('attSaveLbl');
    if (!el || !lbl) return;
    el.classList.remove('is-dirty', 'is-saving', 'is-saved');
    if (kind) el.classList.add(kind);
    lbl.textContent = text || '—';
}

function setSaved() {
    state.dirty = false;
    if (!state.canEditAttendance) {
        if (!state.saving) setSaveIndicator('is-saved', 'View only');
        return;
    }
    if (state.saving) return;
    setSaveIndicator('is-saved', 'All saved');
    setTimeout(() => {
        if (!state.dirty && !state.saving) setSaveIndicator('', 'All saved');
    }, 2500);
}

function setSaving() {
    state.saving = true;
    setSaveIndicator('is-saving', 'Saving...');
}

function clearSaving() {
    state.saving = false;
    if (state.dirty) setSaveIndicator('is-dirty', 'Unsaved Attendance Records');
    else setSaveIndicator('is-saved', 'All saved');
}

function fullName(r) {
    return String(r.learner_name || '').trim();
}

function formatLearnerNameForTable(value) {
    const name = String(value || '').trim();
    const comma = name.indexOf(',');
    if (comma < 0) return name;

    const surname = name.slice(0, comma).trim();
    const givenAndMiddle = name.slice(comma + 1).trim();
    const parts = givenAndMiddle.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return name;

    const suffixes = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v']);
    const suffix = suffixes.has(parts[parts.length - 1].toLowerCase()) ? parts.pop() : '';
    if (parts.length < 2) return name;

    const firstName = parts.shift();
    const middleInitials = parts.map((part) => {
        if (/^[A-Za-z]\.$/.test(part)) return part;
        if (/^[IVXLC]+\.$/i.test(part)) return part;
        const segments = part.split('-').filter(Boolean);
        return `${segments.map((segment) => `${Array.from(segment.replace(/\.+$/, ''))[0] || ''}.`).join('-')}`;
    }).filter(Boolean);
    return `${surname}, ${[firstName, ...middleInitials, suffix].filter(Boolean).join(' ')}`;
}

function renderAttendanceYearLevelOptions() {
    const elYearLevel = document.getElementById('attYearLevel');
    if (!elYearLevel) return;

    const current = String(state.lastSel.yearLevelId || '');
    const levels = new Map();
    state.sections
        .filter((section) => Number(section.is_deleted) !== 1)
        .forEach((section) => {
            const id = Number(section.grade_level_id || 0);
            if (!id || levels.has(String(id))) return;
            levels.set(String(id), {
                id,
                name: String(section.grade_name || `Year level ${id}`),
            });
        });

    const levelOptions = Array.from(levels.values())
        .sort((a, b) => a.id - b.id || a.name.localeCompare(b.name))
        .map((level) => `<option value="${level.id}">${escapeHtml(level.name)}</option>`)
        .join('');

    elYearLevel.innerHTML = '<option value="all">All year levels</option>' + levelOptions;
    const onlyLevelId = levels.size === 1 ? String(levels.keys().next().value) : '';
    elYearLevel.value = levels.has(current) ? current : (onlyLevelId || 'all');
    state.lastSel.yearLevelId = elYearLevel.value || 'all';
}

function renderAttendanceSectionOptions() {
    const elSection = document.getElementById('attSection');
    if (!elSection) return;

    const yearLevelId = String(document.getElementById('attYearLevel')?.value || 'all');
    const sections = state.sections
        .filter((section) => Number(section.is_deleted) !== 1)
        .filter((section) => yearLevelId === 'all' || Number(section.grade_level_id) === Number(yearLevelId))
        .sort((a, b) => String(a.section_name || '').localeCompare(String(b.section_name || '')));
    const options = sections
        .map((section) => `<option value="${Number(section.section_id)}">${escapeHtml(section.section_name || '')}</option>`)
        .join('');

    elSection.innerHTML = options
        ? '<option value="">— select section —</option>' + options
        : (yearLevelId === 'all'
            ? '<option value="">— no assigned sections —</option>'
            : '<option value="">— no sections for selected year level —</option>');

    const preferredSectionId = String(state.lastSel.sectionId || '');
    const hasPreferredSection = sections.some((section) => String(section.section_id) === preferredSectionId);
    const selectedSectionId = hasPreferredSection
        ? preferredSectionId
        : (sections.length === 1 ? String(sections[0].section_id) : '');
    elSection.value = selectedSectionId;
    state.lastSel.sectionId = Number(selectedSectionId || 0);
}

function isMobileAttendanceWizard() {
    return typeof window.matchMedia === 'function'
        && window.matchMedia('(max-width: 720px)').matches;
}

function setMobileAttendanceReady(isReady) {
    document.body?.classList.toggle('att-mobile-ready', Boolean(isReady));
}

function getMobileAttendanceValidation() {
    const selected = getSelected();
    const missing = [];
    if (!selected.syId) missing.push('School Year');
    if (!selected.yearLevelId || selected.yearLevelId === 'all') missing.push('Year Level');
    if (!selected.sectionId) missing.push('Section');
    if (!selected.month) missing.push('Month');
    return { selected, missing, valid: missing.length === 0 };
}

function updateMobileAttendanceWizard() {
    const proceed = document.getElementById('btnAttProceed');
    const validation = document.getElementById('attWizardValidation');
    const isMobile = isMobileAttendanceWizard();
    const fields = [
        ['attSchoolYear', 'School Year'],
        ['attYearLevel', 'Year Level'],
        ['attSection', 'Section'],
        ['attMonth', 'Month'],
    ];
    const { missing, valid } = getMobileAttendanceValidation();

    fields.forEach(([id, label]) => {
        const field = id === 'attMonth'
            ? (attendanceMonthPicker?.trigger || document.getElementById(id))
            : document.getElementById(id);
        if (!field) return;
        const invalid = isMobile && missing.includes(label);
        field.classList.toggle('att-wizard-field-invalid', invalid);
        if (isMobile) field.setAttribute('aria-invalid', String(invalid));
        else field.removeAttribute('aria-invalid');
    });

    if (proceed) {
        proceed.disabled = !isMobile || !valid;
        proceed.hidden = !isMobile || !valid;
        proceed.setAttribute('aria-disabled', String(!isMobile || !valid));
    }
    if (validation) {
        validation.classList.toggle('is-invalid', isMobile && !valid);
        validation.classList.toggle('is-valid', isMobile && valid);
        validation.hidden = !isMobile;
        validation.textContent = valid
            ? 'Ready to load monthly attendance.'
            : `Select ${missing.join(', ')} before proceeding.`;
    }
    return valid;
}

function setMobileAttendanceProceedLoading(isLoading) {
    const proceed = document.getElementById('btnAttProceed');
    if (!proceed) return;
    proceed.disabled = Boolean(isLoading);
    proceed.setAttribute('aria-busy', String(Boolean(isLoading)));
    proceed.innerHTML = isLoading
        ? '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Loading attendance...'
        : '<i class="fas fa-arrow-right" aria-hidden="true"></i> Proceed to Learners';
}


function updateInfoBar() {
    const { sectionId } = getSelected();
    const secName = state.sections.find(s => Number(s.section_id) === Number(sectionId))?.section_name || '—';
    const title = document.getElementById('attCardTitle');
    if (!title) return;
    if (!sectionId) {
        title.textContent = 'Select a section to begin';
        return;
    }
    title.textContent = `Learners - ${secName || 'this section'}`;
}

function getEmptyRosterMessage() {
    const { syId, sectionId } = getSelected();
    if (!syId) return 'Select School Year above.';
    if (!sectionId) return 'Select School Year and Section above.';
    return 'No learners found for this section.';
}

function hasUnsavedChanges() {
    return Boolean(state.dirty || monthStateHasChanges());
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

async function confirmDiscardIfDirty() {
    if (!hasUnsavedChanges()) return true;
    const title = 'Unsaved attendance records';
    const message = 'Save attendance records first. Unsaved attendance entries will be lost.';
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
    return window.confirm(`${title}\n\n${message}\n\nLeave without saving?`);
}

function installAttendanceLeaveGuard() {
    document.addEventListener('click', async (event) => {
        if (!hasUnsavedChanges()) return;
        const link = event.target?.closest?.('a[href]');
        if (!link || link.hasAttribute('download') || link.target === '_blank') return;
        const href = String(link.getAttribute('href') || '');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        const destination = new URL(link.href, window.location.href);
        if (destination.href === window.location.href) return;
        event.preventDefault();
        event.stopPropagation();
        if (await confirmDiscardIfDirty()) {
            resetChanges();
            window.location.href = link.href;
        }
    }, true);
}

function resetChanges() {
    if (!hasUnsavedChanges()) return;
    state.monthMarks = new Map(state.originalMonthMarks);
    state.nonSchoolDays = new Map(state.originalNonSchoolDays);
    state.dirty = false;
    renderMonthlyAttendanceTable();
    setSaved();
}

async function proceedMobileAttendance() {
    if (!isMobileAttendanceWizard()) return;
    if (!updateMobileAttendanceWizard()) return;

    setMobileAttendanceProceedLoading(true);
    const loaded = await loadMonthlyAttendance().catch(() => false);
    setMobileAttendanceProceedLoading(false);

    if (loaded) {
        setMobileAttendanceReady(true);
        return;
    }

    setMobileAttendanceReady(false);
    updateMobileAttendanceWizard();
}

async function changeMobileAttendanceSelection() {
    if (!isMobileAttendanceWizard()) return;
    const ok = await confirmDiscardIfDirty();
    if (!ok) return;

    state.dirty = false;
    resetMonthlyAttendanceState();
    setSaved();
    setMobileAttendanceReady(false);
    renderMonthlyAttendanceTable();
    updateMobileAttendanceWizard();
}

function setLearnerSchoolYearMobileMenuOpen(isOpen) {
    const toggle = document.getElementById('myAttSchoolYearToggle');
    const menu = document.getElementById('myAttSchoolYearMenu');
    if (!toggle || !menu) return;
    const open = Boolean(isOpen) && !toggle.disabled;
    toggle.setAttribute('aria-expanded', String(open));
    menu.hidden = !open;
}

function syncLearnerSchoolYearMobileMenu() {
    const nativeSelect = document.getElementById('myAttSchoolYear');
    const toggle = document.getElementById('myAttSchoolYearToggle');
    const label = document.getElementById('myAttSchoolYearToggleLabel');
    const menu = document.getElementById('myAttSchoolYearMenu');
    if (!nativeSelect || !toggle || !label || !menu) return;

    const options = Array.from(nativeSelect.options)
        .filter((option) => String(option.value || '').trim() !== '');
    const selected = options.find((option) => String(option.value) === String(nativeSelect.value));
    label.textContent = selected?.textContent?.trim()
        || (options.length ? 'Select school year' : 'No attendance records');
    toggle.disabled = options.length === 0;
    menu.innerHTML = options.map((option) => `
        <button type="button"
            class="learner-att-school-year-option"
            role="option"
            data-value="${escapeHtml(option.value)}"
            aria-selected="${String(option.value) === String(nativeSelect.value)}">
            ${escapeHtml(option.textContent || '')}
        </button>
    `).join('');
    if (!options.length) setLearnerSchoolYearMobileMenuOpen(false);
}

function bindLearnerSchoolYearMobileMenu(nativeSelect) {
    const toggle = document.getElementById('myAttSchoolYearToggle');
    const menu = document.getElementById('myAttSchoolYearMenu');
    if (!nativeSelect || !toggle || !menu) return;
    syncLearnerSchoolYearMobileMenu();
    if (toggle.dataset.bound === 'true') return;
    toggle.dataset.bound = 'true';

    toggle.addEventListener('click', (event) => {
        event.preventDefault();
        setLearnerSchoolYearMobileMenuOpen(menu.hidden);
    });
    menu.addEventListener('click', (event) => {
        const option = event.target.closest('.learner-att-school-year-option');
        if (!option) return;
        nativeSelect.value = String(option.dataset.value || '');
        syncLearnerSchoolYearMobileMenu();
        setLearnerSchoolYearMobileMenuOpen(false);
        nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.learner-att-school-year-mobile')) {
            setLearnerSchoolYearMobileMenuOpen(false);
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setLearnerSchoolYearMobileMenuOpen(false);
    });
}

async function initLearnerAttendance() {
    document.body?.classList.add('att-learner-mode');
    document.getElementById('attMobileWizard')?.style.setProperty('display', 'none', 'important');
    document.querySelector('.att-filters')?.style.setProperty('display', 'none');
    document.querySelector('.att-table-wrap')?.style.setProperty('display', '');
    document.getElementById('attSearch')?.closest('.card-header')?.style.setProperty('display', 'none');
    document.getElementById('myAttendanceView')?.style.setProperty('display', 'block');
    document.getElementById('btnAttSaveTop')?.style.setProperty('display', 'none');
    document.getElementById('attSaveInd')?.style.setProperty('display', 'none');

    // Hide the second card used by teachers/admins for section roster.
    const cards = document.querySelectorAll('.card');
    if (cards.length > 1) cards[cards.length - 1].style.setProperty('display', 'none');
    const title = document.querySelector('.card-title');
    if (title) title.textContent = 'My Attendance Summary';

    const sySelect = document.getElementById('myAttSchoolYear');
    if (!sySelect) return;
    bindLearnerSchoolYearMobileMenu(sySelect);

    try {
        const yearsData = await attendanceApi.myAttendance({ school_year_id: 0 });
        const availableYears = Array.isArray(yearsData?.available_school_years)
            ? yearsData.available_school_years
            : [];
        const sorted = availableYears
            .filter((sy) => Number(sy.school_year_id) > 0)
            .sort((a, b) => {
                const startDiff = Number(a.year_start || 0) - Number(b.year_start || 0);
                return startDiff || Number(a.school_year_id) - Number(b.school_year_id);
            });
        sySelect.innerHTML = sorted.length
            ? sorted.map((sy) => `<option value="${Number(sy.school_year_id)}">${escapeHtml(sy.year_label || '')}</option>`).join('')
            : '<option value="">No attendance records</option>';

        if (sorted.length) {
            sySelect.value = String(sorted[sorted.length - 1].school_year_id);
        }
        syncLearnerSchoolYearMobileMenu();

        sySelect.addEventListener('change', () => {
            syncLearnerSchoolYearMobileMenu();
            loadMyAttendance();
        });
        if (sorted.length) {
            await loadMyAttendance();
        } else {
            state.learnerMonthlyRows = [];
            state.learnerWholeYearSummary = null;
            state.learnerEmptyMessage = 'No attendance records found for your learner account.';
            renderLearnerAttendanceTable();
        }
    } catch (error) {
        const tbody = document.getElementById('myAttendanceBody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--color-danger);">Unable to load attendance: ' + escapeHtml(error?.response?.data?.message || error.message) + '</td></tr>';
        }
    }
}

async function loadMyAttendance() {
    const sySelect = document.getElementById('myAttSchoolYear');
    const tbody = document.getElementById('myAttendanceBody');
    const schoolYearId = Number(sySelect?.value || 0);

    if (tbody) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;"><i class="fas fa-spinner fa-spin"></i> Loading attendance...</td></tr>';
    }

    try {
        const data = await attendanceApi.myAttendance({ school_year_id: schoolYearId });
        renderMyAttendance(data);
    } catch (error) {
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--color-danger);">Unable to load attendance: ' + escapeHtml(error?.response?.data?.message || error.message) + '</td></tr>';
        }
    }
}

function attendancePercentageColor(value) {
    const percentage = Number(value);
    if (!Number.isFinite(percentage)) return '';

    const clamped = Math.min(100, Math.max(0, percentage));
    let hue;
    if (clamped <= 50) {
        hue = clamped * 0.7;
    } else if (clamped <= 75) {
        hue = 35 + ((clamped - 50) / 25) * 22;
    } else {
        hue = 57 + ((clamped - 75) / 25) * 63;
    }
    return `hsl(${hue.toFixed(1)} 72% 36%)`;
}

function fmtAttendanceNumber(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function fmtAttendanceValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    return fmtAttendanceNumber(value);
}

function shortAttendanceMonthLabel(row) {
    const fullLabel = String(row?.month_label || row?.month || 'Month').trim();
    if (/^whole school year$/i.test(fullLabel)) return 'Whole SY';
    const monthMatch = fullLabel.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i);
    return monthMatch ? monthMatch[1].slice(0, 3) : fullLabel.slice(0, 3);
}

function renderLearnerAttendanceEmptyState(message) {
    const safeMessage = String(message || 'No attendance records found for the selected school year.').trim();
    return `<tr class="att-empty-row"><td colspan="7" class="att-empty-cell"><div class="att-empty-state" role="status" aria-live="polite">
        <video class="mp4-surface-blend att-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true">
            <source src="../assets/icons/learners.mp4" type="video/mp4">
        </video>
        <p class="att-empty-message">${escapeHtml(safeMessage)}</p>
    </div></td></tr>`;
}

function renderLearnerAttendanceTable() {
    const tbody = document.getElementById('myAttendanceBody');
    if (!tbody) return;

    const monthlyRows = Array.isArray(state.learnerMonthlyRows) ? state.learnerMonthlyRows : [];
    const wholeYear = state.learnerWholeYearSummary;
    const hasRecordedAttendance = Number(wholeYear?.recorded || 0) > 0
        || monthlyRows.some((row) => Number(row?.recorded || 0) > 0);

    if (!hasRecordedAttendance) {
        const message = state.learnerEmptyMessage || 'No attendance records found for the selected school year.';
        tbody.innerHTML = renderLearnerAttendanceEmptyState(message);
        return;
    }

    const renderRow = (row, extraClass = '') => {
        const hasPercent = row.attendance_percentage !== null && row.attendance_percentage !== undefined;
        const percent = hasPercent ? Number(row.attendance_percentage || 0).toFixed(2) : '—';
        const fullMonthLabel = String(row.month_label || row.month || 'Month');
        const shortMonthLabel = shortAttendanceMonthLabel(row);
        const attendanceColor = hasPercent ? attendancePercentageColor(percent) : '';
        const attendanceColorStyle = attendanceColor ? ` style="--learner-attendance-color: ${attendanceColor};"` : '';
        return `
            <tr class="${extraClass}">
                <td class="learner-att-month" title="${escapeHtml(fullMonthLabel)}" aria-label="${escapeHtml(fullMonthLabel)}"><span class="learner-att-month-full">${escapeHtml(fullMonthLabel)}</span><span class="learner-att-month-short" aria-hidden="true">${escapeHtml(shortMonthLabel)}</span></td>
                <td class="learner-att-number">${escapeHtml(fmtAttendanceValue(row.school_days))}</td>
                <td class="learner-att-number">${escapeHtml(fmtAttendanceNumber(row.present))}</td>
                <td class="learner-att-number learner-att-absent">${escapeHtml(fmtAttendanceNumber(row.absent))}</td>
                <td class="learner-att-number">${escapeHtml(fmtAttendanceNumber(row.late))}</td>
                <td class="learner-att-number">${escapeHtml(fmtAttendanceNumber(row.hd))}</td>
                <td class="learner-att-number"><span class="learner-att-percent"${attendanceColorStyle}>${escapeHtml(hasPercent ? `${percent}%` : percent)}</span></td>
            </tr>
        `;
    };

    const wholeYearRow = wholeYear ? renderRow({
            month_label: 'Whole School Year',
            school_days: wholeYear.total,
            present: wholeYear.present,
            absent: wholeYear.absent,
            late: wholeYear.late,
            hd: wholeYear.hd,
            attendance_percentage: wholeYear.attendance_percentage,
        }, 'learner-att-whole-year') : '';
    tbody.innerHTML = monthlyRows.map((row) => renderRow(row)).join('') + wholeYearRow;
}

function renderMyAttendance(data) {
    const rows = Array.isArray(data?.monthly_summary) ? data.monthly_summary : [];
    const calendarMessage = data?.calendar_configured === false
        ? String(data?.calendar_message || 'School-year or grading-period dates are not configured for this school year.').trim()
        : '';
    state.learnerMonthlyRows = rows;
    state.learnerWholeYearSummary = data?.whole_day_summary && typeof data.whole_day_summary === 'object'
        ? data.whole_day_summary
        : null;
    state.learnerEmptyMessage = calendarMessage || String(data?.message || '').trim();
    const note = document.getElementById('myAttendanceNote');
    if (note) {
        note.textContent = calendarMessage;
        note.hidden = !calendarMessage;
    }
    renderLearnerAttendanceTable();
}

function groupRosterByGender(rows) {
    const male = [];
    const female = [];
    const other = [];
    rows.forEach((r) => {
        const g = normalizeGender(r.gender);
        if (g === 'Male') male.push(r);
        else if (g === 'Female') female.push(r);
        else other.push(r);
    });
    const out = [];
    if (male.length) out.push({ key: 'male', label: 'MALE', rows: male });
    if (female.length) out.push({ key: 'female', label: 'FEMALE', rows: female });
    if (other.length) out.push({ key: 'other', label: 'OTHER / NOT SPECIFIED', rows: other });
    return out;
}

function getSelected() {
    return {
        syId: Number(document.getElementById('attSchoolYear')?.value || 0),
        yearLevelId: String(document.getElementById('attYearLevel')?.value || 'all'),
        sectionId: Number(document.getElementById('attSection')?.value || 0),
        month: String(document.getElementById('attMonth')?.value || '').trim(),
    };
}

function resetMonthlyAttendanceState() {
    state.roster = [];
    state.monthDays = [];
    state.monthMarks = new Map();
    state.originalMonthMarks = new Map();
    state.nonSchoolDays = new Map();
    state.originalNonSchoolDays = new Map();
    state.monthHasUnrecordedCells = false;
    state.dirty = false;
}

function attendanceMonthKey(enrollmentId, date) {
    return `${Number(enrollmentId)}|${String(date)}`;
}

function monthDaysForSchoolYear(month, schoolYear) {
    if (!/^\d{4}-\d{2}$/.test(month)) return [];
    const [year, monthNo] = month.split('-').map(Number);
    const lastDay = new Date(year, monthNo, 0).getDate();
    const schoolStart = String(schoolYear?.date_start || '').slice(0, 10);
    const schoolEnd = String(schoolYear?.date_end || '').slice(0, 10);
    const days = [];
    for (let day = 1; day <= lastDay; day++) {
        const date = `${year}-${String(monthNo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const weekday = new Date(year, monthNo - 1, day).getDay();
        if (weekday === 0 || weekday === 6) continue;
        if (schoolStart && date < schoolStart) continue;
        if (schoolEnd && date > schoolEnd) continue;
        days.push({
            date,
            day,
            weekday: ['SU', 'M', 'T', 'W', 'TH', 'F', 'SA'][weekday],
        });
    }
    return days;
}

function statusToSf2Symbol(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (['present', 'p', 'official business'].includes(normalized)) return 'P';
    if (['half-day', 'half day', 'halfday', 'hd'].includes(normalized)) return 'HD';
    if (['absent', 'excused', 'nlpa', 'a'].includes(normalized)) return 'X';
    if (['late', 'tardy', 't'].includes(normalized)) return 'L';
    if (['cutting', 'c'].includes(normalized)) return 'C';
    if (['holiday', 'h'].includes(normalized)) return 'H';
    if (['no classes', 'no class', 'no-class', 'nc'].includes(normalized)) return 'NC';
    return '';
}

function sf2MarkEquivalent(mark) {
    switch (String(mark || '').trim().toUpperCase()) {
        case 'P': return { present: 1, absent: 0, tardy: 0 };
        case 'X': return { present: 0, absent: 1, tardy: 0 };
        case 'L':
        case 'C': return { present: 1, absent: 0, tardy: 1 };
        case 'HD': return { present: 0.5, absent: 0.5, tardy: 0 };
        case 'H':
        case 'NC': return { present: 0, absent: 0, tardy: 0 };
        default: return { present: 0, absent: 0, tardy: 0 };
    }
}

function attendanceDisplayNumber(value) {
    const number = Math.round(Number(value || 0) * 100) / 100;
    return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function monthlyMarkDescription(mark) {
    const normalized = String(mark || '').trim().toUpperCase();
    if (normalized === 'X') return 'absent';
    if (normalized === 'L') return 'late or tardy; counted present';
    if (normalized === 'C') return 'cutting classes; counted present';
    if (normalized === 'HD') return 'half-day absence; half present and half absent';
    if (normalized === 'H') return 'holiday; excluded from school-day totals';
    if (normalized === 'NC') return 'no classes; excluded from school-day totals';
    if (normalized === 'P') return 'present';
    return 'not encoded';
}

function updateMonthlyUnrecordedState() {
    state.monthHasUnrecordedCells = state.roster.some((learner) => state.monthDays.some(({ date }) => {
        if (state.nonSchoolDays.has(date)) return false;
        return !(state.monthMarks.get(attendanceMonthKey(learner.enrollment_id, date)) || '').trim();
    }));
}

function monthlyDayHeaderKind(date) {
    const closure = state.nonSchoolDays.get(date) || '';
    if (closure) return closure;
    if (!state.roster.length) return '';
    const allPresent = state.roster.every((learner) => (
        (state.monthMarks.get(attendanceMonthKey(learner.enrollment_id, date)) || '').trim().toUpperCase() === 'P'
    ));
    return allPresent ? 'P' : '';
}

function monthlyDayHeaderActionLabel(date, kind) {
    if (kind === 'H') return `Change ${date} from holiday to no classes`;
    if (kind === 'NC') return `Set ${date} as a school day`;
    if (kind === 'P') return `Change ${date} from present to holiday`;
    return `Mark every learner present on ${date}`;
}

function syncMonthlyDayHeader(date) {
    const button = document.querySelector(`.sf2-day-kind[data-date="${date}"]`);
    if (!button) return;
    const kind = monthlyDayHeaderKind(date);
    button.dataset.kind = kind;
    button.textContent = kind || '—';
    button.setAttribute('aria-label', monthlyDayHeaderActionLabel(date, kind));
}

function monthStatusCounts(enrollmentId) {
    let present = 0;
    let absent = 0;
    let tardy = 0;
    state.monthDays.forEach(({ date }) => {
        const closure = state.nonSchoolDays.get(date) || '';
        if (closure) return;
        const mark = state.monthMarks.get(attendanceMonthKey(enrollmentId, date)) || '';
        const equivalent = sf2MarkEquivalent(mark);
        present += equivalent.present;
        absent += equivalent.absent;
        tardy += equivalent.tardy;
    });
    return { present, absent, tardy };
}

function monthlyAttendanceMetrics(rows = state.roster) {
    const learners = Array.isArray(rows) ? rows : [];
    const openDays = state.monthDays.filter(({ date }) => !state.nonSchoolDays.has(date));
    const totals = learners.reduce((summary, learner) => {
        const counts = monthStatusCounts(Number(learner.enrollment_id));
        summary.present += counts.present;
        summary.absent += counts.absent;
        summary.tardy += counts.tardy;
        return summary;
    }, { present: 0, absent: 0, tardy: 0 });
    const averageDailyAttendance = openDays.length ? totals.present / openDays.length : 0;
    const percentageAttendance = learners.length ? (averageDailyAttendance / learners.length) * 100 : 0;
    return {
        registeredLearners: learners.length,
        openDays: openDays.length,
        totalDailyAttendance: totals.present,
        totalAbsent: totals.absent,
        totalTardy: totals.tardy,
        averageDailyAttendance,
        percentageAttendance,
    };
}

function renderMonthlyAttendanceTable() {
    const thead = document.getElementById('attThead');
    const tbody = document.getElementById('attTbody');
    const tfoot = document.getElementById('attTfoot');
    const table = document.getElementById('sf2AttendanceTable');
    if (!thead || !tbody || !table) return;

    const search = String(document.getElementById('attSearch')?.value || '').trim().toLowerCase();
    const roster = state.roster.filter((learner) => {
        if (!search) return true;
        return fullName(learner).toLowerCase().includes(search)
            || String(learner.lrn || '').toLowerCase().includes(search);
    });
    const metrics = monthlyAttendanceMetrics();
    const columnSpan = 2 + state.monthDays.length + 2;
    if (!state.monthDays.length) {
        thead.innerHTML = '';
        tbody.innerHTML = `<tr><td colspan="${columnSpan}" class="sf2-empty">Choose a month that falls within the selected school year.</td></tr>`;
        if (tfoot) tfoot.innerHTML = '';
        return;
    }

    const dayHeaders = state.monthDays.map(({ date, day, weekday }) => {
        const kind = monthlyDayHeaderKind(date);
        const disabled = state.canEditAttendance ? '' : ' disabled';
        const label = monthlyDayHeaderActionLabel(date, kind);
        return `<th class="sf2-date" scope="col" aria-label="${date}, ${weekday}" title="${date}"><div class="sf2-date-heading"><span class="sf2-weekday">${weekday}</span><span class="sf2-day-number">${day}</span><button class="sf2-day-kind" type="button" data-date="${date}" data-kind="${kind}" aria-label="${escapeHtml(label)}" title="Cycle P, H, NC, clear"${disabled}>${kind || '—'}</button></div></th>`;
    }).join('');
    thead.innerHTML = `<tr>
        <th class="sf2-no sf2-sticky-name" scope="col">No.</th>
        <th class="sf2-name sf2-sticky-name" scope="col">Learner</th>
        ${dayHeaders}
        <th class="sf2-total" scope="col">Present</th>
        <th class="sf2-total" scope="col">Absent</th>
    </tr>`;

    if (!state.roster.length) {
        tbody.innerHTML = `<tr><td colspan="${columnSpan}" class="sf2-empty">${escapeHtml(getEmptyRosterMessage())}</td></tr>`;
        if (tfoot) tfoot.innerHTML = '';
        return;
    }
    if (!roster.length) {
        tbody.innerHTML = `<tr><td colspan="${columnSpan}" class="sf2-empty">No learners match the current search.</td></tr>`;
        if (tfoot) tfoot.innerHTML = '';
        return;
    }

    let number = 0;
    const groups = groupRosterByGender(roster);
    const rowsHtml = groups.map((group) => {
        const groupLabel = group.key === 'male' ? 'Male' : group.key === 'female' ? 'Female' : 'Other / not specified';
        const learnersHtml = group.rows.map((learner) => {
            number++;
            const enrollmentId = Number(learner.enrollment_id);
            const counts = monthStatusCounts(enrollmentId);
            const cells = state.monthDays.map(({ date, day, weekday }) => {
                const dayLabel = `data-day="${day}" data-weekday="${escapeHtml(weekday)}"`;
                const closed = state.nonSchoolDays.get(date) || '';
                if (closed) return `<td class="sf2-mark-cell sf2-non-school" ${dayLabel} title="${date}" aria-label="${date}: ${closed === 'H' ? 'Holiday' : 'No classes'}">${closed}</td>`;
                const mark = state.monthMarks.get(attendanceMonthKey(enrollmentId, date)) || '';
                const disabled = state.canEditAttendance ? '' : ' disabled aria-readonly="true"';
                const dirty = mark !== (state.originalMonthMarks.get(attendanceMonthKey(enrollmentId, date)) || '') ? ' is-unsaved' : '';
                const accessibleName = `${fullName(learner)}, ${date}: ${monthlyMarkDescription(mark)}`;
                return `<td class="sf2-mark-cell" ${dayLabel} title="${date}"><input class="sf2-mark-input${dirty}" type="text" maxlength="2" inputmode="text" autocomplete="off" spellcheck="false" data-eid="${enrollmentId}" data-date="${date}" data-mark="${mark}" value="${mark}" aria-label="${escapeHtml(accessibleName)}" title="Blank = not encoded; P = present; X = absent; L = late/tardy (upper triangular half-shade); C = cutting classes (lower triangular half-shade); HD = 0.5 present + 0.5 absent"${disabled}></td>`;
            }).join('');
            return `<tr>
                <td class="sf2-no sf2-sticky-name">${number}</td>
                <td class="sf2-name sf2-sticky-name" title="${escapeHtml(fullName(learner))}">${escapeHtml(formatLearnerNameForTable(fullName(learner)))}</td>
                ${cells}
                <td class="sf2-total sf2-total-number" data-total="present" data-eid="${enrollmentId}">${attendanceDisplayNumber(counts.present)}</td>
                <td class="sf2-total sf2-total-number" data-total="absent" data-eid="${enrollmentId}">${attendanceDisplayNumber(counts.absent)}</td>
            </tr>`;
        }).join('');
        return `<tr class="sf2-gender-row"><td class="sf2-no sf2-sticky-name sf2-gender-index" aria-hidden="true"></td><td class="sf2-name sf2-sticky-name sf2-gender-label">${escapeHtml(groupLabel)}</td><td class="sf2-gender-fill" colspan="${state.monthDays.length + 2}" aria-hidden="true"></td></tr>${learnersHtml}`;
    }).join('');

    const openDayCount = state.monthDays.filter(({ date }) => !state.nonSchoolDays.has(date)).length;
    const overallSchoolDays = openDayCount * state.roster.length;
    tbody.innerHTML = rowsHtml;
    if (tfoot) tfoot.innerHTML = `<tr class="sf2-month-total-row"><td colspan="2">Month total · ${openDayCount} school days</td><td colspan="${state.monthDays.length}"></td><td class="sf2-total-number sf2-summary-present" data-label="Present">${attendanceDisplayNumber(metrics.totalDailyAttendance)}</td><td class="sf2-total-number sf2-summary-absent" data-label="Absent">${attendanceDisplayNumber(metrics.totalAbsent)}</td></tr>`;
    table.setAttribute('aria-label', `Monthly attendance for ${state.lastSel.month || 'selected month'}, ${state.roster.length} learners and ${overallSchoolDays} learner school-days`);
}

async function loadMonthlyAttendance() {
    const selected = getSelected();
    const schoolYear = state.schoolYears.find((row) => Number(row.school_year_id) === selected.syId) || {};
    state.lastSel = { ...selected };
    state.monthDays = monthDaysForSchoolYear(selected.month, schoolYear);
    state.roster = [];
    state.monthMarks = new Map();
    state.originalMonthMarks = new Map();
    state.nonSchoolDays = new Map();
    state.originalNonSchoolDays = new Map();
    state.monthHasUnrecordedCells = false;
    state.dirty = false;
    const tbody = document.getElementById('attTbody');
    if (!selected.syId || !selected.sectionId || !selected.month) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="sf2-empty">Select School Year, section, and month to load attendance.</td></tr>';
        const tfoot = document.getElementById('attTfoot');
        if (tfoot) tfoot.innerHTML = '';
        setSaved();
        return false;
    }
    if (!state.monthDays.length) {
        renderMonthlyAttendanceTable();
        setSaved();
        return false;
    }
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="sf2-empty">Loading monthly attendance…</td></tr>';
    const tfoot = document.getElementById('attTfoot');
    if (tfoot) tfoot.innerHTML = '';
    try {
        const [roster, monthData] = await Promise.all([
            attendanceApi.roster({ sectionId: selected.sectionId, schoolYearId: selected.syId }),
            attendanceApi.monthlyGrid({ sectionId: selected.sectionId, schoolYearId: selected.syId, month: selected.month }),
        ]);
        state.roster = Array.isArray(roster) ? roster : [];
        state.roster.forEach((learner) => {
            state.monthDays.forEach(({ date }) => state.monthMarks.set(attendanceMonthKey(learner.enrollment_id, date), ''));
        });
        const records = Array.isArray(monthData?.records) ? monthData.records : (Array.isArray(monthData) ? monthData : []);
        const recordedKeys = new Set();
        records.forEach((record) => {
            const date = String(record.attendance_date || '').slice(0, 10);
            const enrollmentId = Number(record.enrollment_id || 0);
            if (!enrollmentId || !state.monthDays.some((entry) => entry.date === date)) return;
            const status = String(record.status || '').trim().toLowerCase();
            recordedKeys.add(attendanceMonthKey(enrollmentId, date));
            if (status === 'holiday' || status === 'h') state.nonSchoolDays.set(date, 'H');
            else if (status === 'no classes' || status === 'no-class' || status === 'nc') state.nonSchoolDays.set(date, 'NC');
            else {
                const key = attendanceMonthKey(enrollmentId, date);
                state.monthMarks.set(key, statusToSf2Symbol(record.status));
            }
        });
        state.monthHasUnrecordedCells = state.roster.some((learner) => state.monthDays.some(({ date }) => {
            if (state.nonSchoolDays.has(date)) return false;
            return !recordedKeys.has(attendanceMonthKey(learner.enrollment_id, date));
        }));
        state.originalMonthMarks = new Map(state.monthMarks);
        state.originalNonSchoolDays = new Map(state.nonSchoolDays);
        state.lastSel = { ...selected };
        renderMonthlyAttendanceTable();
        updateMonthlySaveIndicator();
        return true;
    } catch (error) {
        state.roster = [];
        const message = error?.response?.data?.message || error?.message || 'Unable to load monthly attendance.';
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="sf2-empty sf2-error">${escapeHtml(message)}</td></tr>`;
        if (tfoot) tfoot.innerHTML = '';
        await toast('error', message);
        return false;
    }
}

function monthStateHasChanges() {
    if (state.monthMarks.size !== state.originalMonthMarks.size || state.nonSchoolDays.size !== state.originalNonSchoolDays.size) return true;
    for (const [key, value] of state.monthMarks) if ((state.originalMonthMarks.get(key) || '') !== value) return true;
    for (const [date, value] of state.nonSchoolDays) if ((state.originalNonSchoolDays.get(date) || '') !== value) return true;
    return false;
}

function updateMonthlySaveIndicator() {
    state.dirty = monthStateHasChanges();
    if (state.dirty) setSaveIndicator('is-dirty', 'Unsaved Attendance Records');
    else if (state.canEditAttendance && state.monthHasUnrecordedCells) setSaveIndicator('', 'Blank cells are not encoded; use P to mark present');
    else setSaved();
}

function setMonthlyMark(enrollmentId, date, mark) {
    const key = attendanceMonthKey(enrollmentId, date);
    state.monthMarks.set(key, mark);
    const input = document.querySelector(`.sf2-mark-input[data-eid="${enrollmentId}"][data-date="${date}"]`);
    if (input) {
        input.dataset.mark = mark;
        input.value = mark;
        input.classList.toggle('is-unsaved', mark !== (state.originalMonthMarks.get(key) || ''));
        input.setAttribute('aria-label', `${input.getAttribute('aria-label').split(':')[0]}, ${date}: ${monthlyMarkDescription(mark)}`);
    }
    const counts = monthStatusCounts(enrollmentId);
    document.querySelectorAll(`.sf2-total-number[data-eid="${enrollmentId}"]`).forEach((cell) => {
        const type = cell.dataset.total;
        if (type && counts[type] !== undefined) cell.textContent = attendanceDisplayNumber(counts[type]);
    });
    const metrics = monthlyAttendanceMetrics();
    const summaryPresent = document.querySelector('.sf2-summary-present');
    const summaryAbsent = document.querySelector('.sf2-summary-absent');
    if (summaryPresent) summaryPresent.textContent = attendanceDisplayNumber(metrics.totalDailyAttendance);
    if (summaryAbsent) summaryAbsent.textContent = attendanceDisplayNumber(metrics.totalAbsent);
    syncMonthlyDayHeader(date);
    updateMonthlyUnrecordedState();
    updateMonthlySaveIndicator();
}

async function saveAll() {
    if (!state.canEditAttendance) {
        await toast('error', 'Attendance entry is available only to the assigned adviser or teacher.');
        return;
    }
    const { syId, sectionId, month } = getSelected();
    if (!syId || !sectionId || !month || !state.monthDays.length) {
        await toast('error', 'Select a school year, section, and valid month first.');
        return;
    }
    if (!monthStateHasChanges()) {
        await toast('info', 'No changes to save.');
        setSaved();
        return;
    }
    const entries = [];
    state.roster.forEach((learner) => {
        state.monthDays.forEach(({ date }) => {
            const currentClosure = state.nonSchoolDays.get(date) || '';
            const key = attendanceMonthKey(learner.enrollment_id, date);
            const symbol = currentClosure || state.monthMarks.get(key) || '';
            entries.push({
                enrollment_id: Number(learner.enrollment_id),
                attendance_date: date,
                symbol,
            });
        });
    });
    setSaving();
    try {
        const result = await attendanceApi.saveMonthlyGrid({ sectionId, schoolYearId: syId, month, entries });
        if (result?.success === false) throw new Error(result?.message || 'Save failed.');
        state.originalMonthMarks = new Map(state.monthMarks);
        state.originalNonSchoolDays = new Map(state.nonSchoolDays);
        updateMonthlyUnrecordedState();
        state.dirty = false;
        renderMonthlyAttendanceTable();
        await toast('success', `Saved ${Number(result?.saved || 0)} monthly attendance entries.`);
        setSaved();
    } catch (error) {
        await toast('error', error?.response?.data?.message || error?.message || 'Save failed.');
    } finally {
        clearSaving();
        updateMonthlySaveIndicator();
    }
}

async function loadSectionsAndPeriodsForSY() {
    const selected = getSelected();
    const levelSelect = document.getElementById('attYearLevel');
    const sectionSelect = document.getElementById('attSection');
    const yearSelect = document.getElementById('attSchoolYear');
    const monthInput = document.getElementById('attMonth');
    if (!selected.syId && yearSelect && state.schoolYears.length) {
        const defaultYear = state.schoolYears.find((row) => Number(row.is_active) === 1) || state.schoolYears[0];
        yearSelect.value = String(defaultYear.school_year_id);
        selected.syId = Number(yearSelect.value || 0);
    }
    if (!selected.syId) {
        state.sections = [];
        state.roster = [];
        state.monthDays = [];
        state.monthMarks = new Map();
        state.originalMonthMarks = new Map();
        state.nonSchoolDays = new Map();
        state.originalNonSchoolDays = new Map();
        state.monthHasUnrecordedCells = false;
        state.lastSel.syId = 0;
        state.lastSel.sectionId = 0;
        state.lastSel.month = '';
        if (levelSelect) levelSelect.innerHTML = '<option value="all">All year levels</option>';
        if (sectionSelect) sectionSelect.innerHTML = '<option value="">— select school year —</option>';
        if (monthInput) {
            monthInput.value = '';
            monthInput.disabled = true;
            syncAttendanceMonthControl(monthInput);
        }
        renderMonthlyAttendanceTable();
        setSaved();
        return;
    }
    const year = state.schoolYears.find((row) => Number(row.school_year_id) === selected.syId) || {};
    const selectedMonth = populateAttendanceMonthOptions(monthInput, year, selected.month);
    if (yearSelect) state.lastSel.syId = Number(yearSelect.value || 0);
    state.lastSel.month = selectedMonth;

    if (sectionSelect) sectionSelect.innerHTML = '<option value="">Loading sections…</option>';
    const sections = await sectionsApi.list(selected.syId);
    state.sections = Array.isArray(sections) ? sections : [];
    state.lastSel.yearLevelId = '';
    state.lastSel.sectionId = 0;
    renderAttendanceYearLevelOptions();
    renderAttendanceSectionOptions();
    if (isMobileAttendanceWizard()) {
        resetMonthlyAttendanceState();
        setMobileAttendanceReady(false);
        renderMonthlyAttendanceTable();
        updateMobileAttendanceWizard();
        return;
    }
    await loadMonthlyAttendance();
}

function bindEvents() {
    const schoolYear = document.getElementById('attSchoolYear');
    const yearLevel = document.getElementById('attYearLevel');
    const section = document.getElementById('attSection');
    const month = document.getElementById('attMonth');
    schoolYear?.addEventListener('change', async () => {
        const oldValue = String(state.lastSel.syId || '');
        if (!await confirmDiscardIfDirty()) { schoolYear.value = oldValue; return; }
        state.dirty = false;
        await loadSectionsAndPeriodsForSY().catch((error) => toast('error', error?.message || 'Unable to load sections.'));
    });
    yearLevel?.addEventListener('change', async () => {
        const oldValue = String(state.lastSel.yearLevelId || 'all');
        if (!await confirmDiscardIfDirty()) { yearLevel.value = oldValue; return; }
        state.dirty = false;
        state.lastSel.yearLevelId = String(yearLevel.value || 'all');
        state.lastSel.sectionId = 0;
        renderAttendanceSectionOptions();
        if (isMobileAttendanceWizard()) {
            resetMonthlyAttendanceState();
            setMobileAttendanceReady(false);
            renderMonthlyAttendanceTable();
            updateMobileAttendanceWizard();
            return;
        }
        await loadMonthlyAttendance();
    });
    section?.addEventListener('change', async () => {
        const oldValue = String(state.lastSel.sectionId || '');
        if (!await confirmDiscardIfDirty()) { section.value = oldValue; return; }
        state.dirty = false;
        state.lastSel.sectionId = Number(section.value || 0);
        if (isMobileAttendanceWizard()) {
            resetMonthlyAttendanceState();
            setMobileAttendanceReady(false);
            renderMonthlyAttendanceTable();
            updateMobileAttendanceWizard();
            return;
        }
        await loadMonthlyAttendance();
    });
    month?.addEventListener('change', async () => {
        const oldValue = String(state.lastSel.month || '');
        if (!await confirmDiscardIfDirty()) {
            month.value = oldValue;
            attendanceMonthPicker?.refresh();
            return;
        }
        state.dirty = false;
        state.lastSel.month = String(month.value || '').trim();
        if (isMobileAttendanceWizard()) {
            resetMonthlyAttendanceState();
            setMobileAttendanceReady(false);
            renderMonthlyAttendanceTable();
            updateMobileAttendanceWizard();
            return;
        }
        await loadMonthlyAttendance();
    });
    document.getElementById('btnAttProceed')?.addEventListener('click', () => {
        proceedMobileAttendance().catch(() => {});
    });
    document.getElementById('btnAttChangeSelection')?.addEventListener('click', () => {
        changeMobileAttendanceSelection().catch(() => {});
    });
    document.getElementById('attSearch')?.addEventListener('input', renderMonthlyAttendanceTable);
    document.getElementById('attTbody')?.addEventListener('input', (event) => {
        const input = event.target.closest('.sf2-mark-input');
        if (!input || !state.canEditAttendance) return;
        const rawValue = String(input.value || '').trim().toUpperCase();
        if (rawValue === 'H') {
            input.value = 'H'; // allow the first keystroke of the HD half-day code
            return;
        }
        const value = rawValue === 'A' ? 'X' : rawValue === 'T' ? 'L' : rawValue;
        input.value = value && !['P', 'X', 'L', 'C', 'HD'].includes(value) ? '' : value;
        setMonthlyMark(Number(input.dataset.eid), String(input.dataset.date), input.value);
    });
    document.getElementById('attTbody')?.addEventListener('change', (event) => {
        const input = event.target.closest('.sf2-mark-input');
        if (!input || input.value !== 'H') return;
        const key = attendanceMonthKey(input.dataset.eid, input.dataset.date);
        input.value = state.monthMarks.get(key) || '';
    });
    document.getElementById('attThead')?.addEventListener('click', (event) => {
        const button = event.target.closest('.sf2-day-kind');
        if (!button || !state.canEditAttendance) return;
        const date = String(button.dataset.date || '');
        const current = monthlyDayHeaderKind(date);
        const next = current === '' ? 'P' : current === 'P' ? 'H' : current === 'H' ? 'NC' : '';
        if (next === 'P') {
            state.nonSchoolDays.delete(date);
            state.roster.forEach((learner) => {
                state.monthMarks.set(attendanceMonthKey(learner.enrollment_id, date), 'P');
            });
        } else if (next === 'H' || next === 'NC') {
            state.roster.forEach((learner) => {
                state.monthMarks.delete(attendanceMonthKey(learner.enrollment_id, date));
            });
            state.nonSchoolDays.set(date, next);
        } else {
            state.nonSchoolDays.delete(date);
        }
        updateMonthlyUnrecordedState();
        updateMonthlySaveIndicator();
        renderMonthlyAttendanceTable();
    });
    document.getElementById('btnAttSaveTop')?.addEventListener('click', () => saveAll().catch(() => {}));
    window.addEventListener('beforeunload', (event) => {
        if (!hasUnsavedChanges()) return;
        event.preventDefault();
        event.returnValue = '';
    });
    installAttendanceLeaveGuard();
}


async function init() {
    if (isLearnerRole()) {
        await initLearnerAttendance();
        return;
    }
    state.canEditAttendance = canEditAttendanceRecords();
    const saveButton = document.getElementById('btnAttSaveTop');
    if (saveButton && !state.canEditAttendance) saveButton.hidden = true;
    setSaveIndicator('is-saved', state.canEditAttendance ? 'All saved' : 'View only');
    const monthInput = document.getElementById('attMonth');
    attendanceMonthPicker = window.AcademicCalendarDatePicker?.attach(monthInput, {
        label: 'Month',
        placeholder: 'Choose month',
        monthOnly: true,
    }) || null;
    if (attendanceMonthPicker?.trigger) attendanceMonthPicker.trigger.disabled = true;
    const schoolYear = document.getElementById('attSchoolYear');
    if (schoolYear) schoolYear.innerHTML = '<option value="">Loading school years…</option>';
    const schoolYears = await schoolYearsApi.list();
    state.schoolYears = Array.isArray(schoolYears) ? schoolYears : [];
    if (schoolYear) {
        schoolYear.innerHTML = state.schoolYears.map((row) => {
            const label = `${row.year_label || ''}${Number(row.is_active) === 1 ? ' (active)' : ''}`.trim();
            return `<option value="${Number(row.school_year_id)}">${escapeHtml(label)}</option>`;
        }).join('') || '<option value="">No school years</option>';
        const initialYear = state.schoolYears.find((row) => Number(row.is_active) === 1) || state.schoolYears[0];
        schoolYear.value = initialYear ? String(initialYear.school_year_id) : '';
    }
    state.lastSel.syId = Number(schoolYear?.value || 0);
    bindEvents();
    await loadSectionsAndPeriodsForSY();
    if (monthInput) state.lastSel.month = monthInput.value;
}

function waitForRole(cb, attempts = 0) {
    const rid = Number(window.CURRENT_ROLE_ID || 0);
    const rname = String(window.CURRENT_ROLE_NAME || '');
    if (rid > 0 || rname) {
        cb();
    } else if (attempts < 30) {
        setTimeout(() => waitForRole(cb, attempts + 1), 150);
    } else {
        cb();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    waitForRole(() => init().catch((e) => toast('error', e?.message || 'Attendance init failed')));
});
