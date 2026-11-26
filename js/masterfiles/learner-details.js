function getApiBaseUrl() {
    const parts = String(window.location.pathname || '/').split('/').filter(Boolean);
    const appPrefix = parts.length ? `/${parts[0]}` : '';
    return `${window.location.origin}${appPrefix}/api`;
}

const API_BASE_URL = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;

const learnerRegistrationApi = {
    list: async () => axios
        .get(`${API_BASE_URL}/learner_registration/learner_registration.php`, { params: { operation: 'getAllRegistrations' } })
        .then((r) => r.data),
    getStatus: async (learnerId, schoolYearId) => axios
        .get(`${API_BASE_URL}/learner_registration/learner_registration.php`, {
            params: { operation: 'getEnrollmentStatus', learner_id: learnerId, school_year_id: schoolYearId }
        })
        .then((r) => r.data),
    updateStatus: async (data) => axios
        .post(`${API_BASE_URL}/learner_registration/learner_registration.php?operation=updateEnrollmentStatus`, data)
        .then((r) => r.data),
    update: async (learnerId, data) => axios
        .post(`${API_BASE_URL}/learner_registration/learner_registration.php?operation=updateRegistration`, { ...data, learner_id: learnerId })
        .then((r) => r.data)
};

const optionLoaders = {
    grade_level_id: () => axios.get(`${API_BASE_URL}/grade_levels/grade_levels.php`, { params: { operation: 'getAllGradeLevels' } }).then((r) => r.data),
    school_year_id: () => axios.get(`${API_BASE_URL}/school_years/school_years.php`, { params: { operation: 'getAllSchoolYears' } }).then((r) => r.data),
    guardian_relationship: () => axios.get(`${API_BASE_URL}/family_relationships/family_relationships.php`, { params: { operation: 'getAllFamilyRelationships', scope: 'guardian' } }).then((r) => r.data),
    enrollment_type_id: () => axios.get(`${API_BASE_URL}/enrollment_types/enrollment_types.php`, { params: { operation: 'getAllEnrollmentTypes' } }).then((r) => r.data)
};

const sectionsApi = {
    getByGradeLevel: async (gradeLevelId, schoolYearId) => axios
        .get(`${API_BASE_URL}/sections/sections.php`, {
            params: {
                operation: 'getSectionsByGradeLevel',
                grade_level_id: gradeLevelId,
                school_year_id: schoolYearId || undefined
            }
        })
        .then((r) => r.data)
};

const optionConfig = {
    grade_level_id: { valueKey: 'grade_level_id', labelKey: 'grade_name' },
    section_id: { valueKey: 'section_id', labelKey: 'section_name' },
    school_year_id: { valueKey: 'school_year_id', labelKey: 'year_label', defaultPick: (row) => Number(row.is_active) === 1 },
    guardian_relationship: { valueKey: 'relationship_name', labelKey: 'relationship_name' },
    enrollment_type_id: { valueKey: 'enrollment_type_id', labelKey: 'type_name' }
};

const fieldSections = [
    {
        title: 'School Information',
        fields: [
            { key: 'school_id', label: 'School ID', type: 'text', required: false, maxLength: 6, readonly: true },
            { key: 'school_year_id', label: 'School Year', type: 'select', required: true },
            { key: 'school_name', label: 'School Name', type: 'text', required: false, readonly: true },
            { key: 'enrollment_type_id', label: 'Enrollment Type', type: 'select', required: false }
        ]
    },
    {
        title: 'Learner Information',
        fields: [
            { key: 'grade_level_id', label: 'Grade Level', type: 'select', required: true },
            { key: 'section_id', label: 'Section', type: 'select', required: true },
            { key: 'lrn', label: 'Learner Reference Number (LRN)', type: 'text', required: true, maxLength: 12, placeholder: '12-digit LRN' },
            {
                key: 'enrollment_status',
                label: 'Enrollment Status',
                type: 'select',
                required: false,
                statusControl: true,
                staticOptions: [
                    { value: 'Enrolled', label: 'Enrolled' },
                    { value: 'Transferred Out', label: 'Transferred Out' },
                    { value: 'Dropped', label: 'Dropped' },
                    { value: 'Completed', label: 'Completed' }
                ]
            }
        ]
    },
    {
        title: 'Personal Details',
        fields: [
            { key: 'last_name', label: 'Last Name', type: 'text', required: true, placeholder: 'Enter last name' },
            { key: 'first_name', label: 'First Name', type: 'text', required: true, placeholder: 'Enter first name' },
            { key: 'middle_name', label: 'Middle Name', type: 'text', required: false, placeholder: 'Enter middle name (optional)' },
            {
                key: 'sex',
                label: 'Sex',
                type: 'select',
                required: true,
                staticOptions: [
                    { value: '', label: 'Select Sex' },
                    { value: 'M', label: 'Male' },
                    { value: 'F', label: 'Female' }
                ]
            },
            { key: 'date_of_birth', label: 'Date of Birth', type: 'birthday-picker', required: true, placeholder: 'Choose date of birth' },
            { key: 'birth_province_text', label: 'Place of Birth (Province)', type: 'text', required: false, maxLength: 150 },
            { key: 'age_by_june', label: 'Age by June (1st Friday)', type: 'number', required: false, readonly: true },
            { key: 'mother_tongue', label: 'Mother Tongue', type: 'text', required: false, maxLength: 100 },
            { key: 'indigenous_group', label: 'Indigenous Group (if applicable)', type: 'text', required: false, maxLength: 150, placeholder: 'Specify ethnic group' },
            { key: 'religion', label: 'Religion', type: 'text', required: false, maxLength: 100 }
        ]
    },
    {
        title: 'Current Address',
        fields: [
            { key: 'house_street', label: 'House Number & Street', type: 'text', required: false, placeholder: 'e.g., 123 Main Street' },
            { key: 'barangay', maxLength: 150, label: 'Barangay', type: 'text', required: false, placeholder: 'Enter barangay' },
            { key: 'municipality', maxLength: 150, label: 'City/Municipality', type: 'text', required: false, placeholder: 'Enter city or municipality' },
            { key: 'province', maxLength: 150, label: 'Province', type: 'text', required: false, placeholder: 'Enter province' }
        ]
    },
    {
        title: 'Family / Guardian Information',
        fields: [
            { key: 'father_name', label: 'Father\'s Full Name', type: 'text', required: false, placeholder: 'Enter father\'s complete name' },
            { key: 'mother_name', label: 'Mother\'s Full Name', type: 'text', required: false, placeholder: 'Enter mother\'s complete name' },
            { key: 'guardian_name', label: 'Guardian\'s Full Name', type: 'text', required: false, placeholder: 'Enter guardian\'s complete name' },
            { key: 'guardian_relationship', label: 'Relationship to Learner', type: 'select', required: false },
            { key: 'guardian_contact', label: 'Contact number of family / guardian', type: 'tel', required: false, maxLength: 11, placeholder: '11-digit mobile number' }
        ]
    }
];

function notify(type, message, title) {
    if (typeof window.showNotification === 'function') {
        const msg = title ? `${title}: ${message}` : message;
        window.showNotification(msg, type);
        return;
    }
    // eslint-disable-next-line no-console
    console[type === 'error' ? 'error' : 'log'](message);
}

function createLabel(field) {
    const label = document.createElement('label');
    label.setAttribute('for', field.key);
    label.textContent = field.label;

    return label;
}

function createLegacyBirthdayPicker(field) {
    const wrapper = document.createElement('div');
    wrapper.className = `form-group field-${String(field.key).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

    const label = createLabel(field);
    wrapper.appendChild(label);

    const pickerContainer = document.createElement('div');
    pickerContainer.className = 'birthday-picker-container';
    pickerContainer.style.cssText = `
        position: relative;
        display: flex;
        align-items: center;
    `;

    const input = document.createElement('input');
    input.type = 'text';
    input.id = field.key;
    input.name = field.key;
    input.className = 'form-control birthday-input';
    input.placeholder = field.placeholder || 'MM/DD/YYYY';
    input.maxLength = 10;
    input.style.cssText = `
        width: 100%;
        padding: 8px 12px;
        border: 1px solid var(--gray-300);
        border-radius: 4px;
        font-size: 14px;
        background: var(--surface-0);
        color: var(--gray-900);
    `;

    if (field.required) input.required = true;

    const dropdown = document.createElement('div');
    dropdown.className = 'birthday-dropdown';
    dropdown.style.cssText = `
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        background: var(--surface-0);
        border: 1px solid var(--gray-300);
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        z-index: 1000;
        display: none;
        padding: 12px;
    `;

    // Create month, day, year selects
    const monthSelect = document.createElement('select');
    monthSelect.className = 'month-select';
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
                   'July', 'August', 'September', 'October', 'November', 'December'];
    monthSelect.innerHTML = '<option value="">Month</option>' +
        months.map((month, i) => `<option value="${String(i + 1).padStart(2, '0')}">${month}</option>`).join('');
    monthSelect.style.cssText = 'margin-right: 8px; padding: 4px; border: 1px solid var(--gray-300); border-radius: 3px; background: var(--surface-0); color: var(--gray-900);';

    const daySelect = document.createElement('select');
    daySelect.className = 'day-select';
    daySelect.innerHTML = '<option value="">Day</option>' +
        Array.from({length: 31}, (_, i) => `<option value="${String(i + 1).padStart(2, '0')}">${i + 1}</option>`).join('');
    daySelect.style.cssText = 'margin-right: 8px; padding: 4px; border: 1px solid var(--gray-300); border-radius: 3px; background: var(--surface-0); color: var(--gray-900);';

    const yearSelect = document.createElement('select');
    yearSelect.className = 'year-select';
    const currentYear = new Date().getFullYear();
    const years = Array.from({length: 100}, (_, i) => currentYear - i);
    yearSelect.innerHTML = '<option value="">Year</option>' +
        years.map(year => `<option value="${year}">${year}</option>`).join('');
    yearSelect.style.cssText = 'padding: 4px; border: 1px solid var(--gray-300); border-radius: 3px; background: var(--surface-0); color: var(--gray-900);';

    dropdown.appendChild(monthSelect);
    dropdown.appendChild(daySelect);
    dropdown.appendChild(yearSelect);

    pickerContainer.appendChild(input);
    pickerContainer.appendChild(dropdown);
    wrapper.appendChild(pickerContainer);

    // Event handlers
    let isOpen = false;

    function showDropdown() {
        if (!isOpen) {
            dropdown.style.display = 'block';
            isOpen = true;

            // Parse current value and set selects
            const currentValue = input.value;
            if (currentValue && /^\d{2}\/\d{2}\/\d{4}$/.test(currentValue)) {
                const [month, day, year] = currentValue.split('/');
                monthSelect.value = month;
                daySelect.value = day;
                yearSelect.value = year;
            }
        }
    }

    function hideDropdown() {
        setTimeout(() => {
            dropdown.style.display = 'none';
            isOpen = false;
        }, 200); // Small delay to allow clicking on selects
    }

    function updateInput() {
        const month = monthSelect.value;
        const day = daySelect.value;
        const year = yearSelect.value;

        if (month && day && year) {
            input.value = `${month}/${day}/${year}`;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            hideDropdown();
        }
    }

    input.addEventListener('focus', showDropdown);
    input.addEventListener('click', (e) => {
        e.stopPropagation();
        showDropdown();
    });

    dropdown.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', hideDropdown);

    monthSelect.addEventListener('change', updateInput);
    daySelect.addEventListener('change', updateInput);
    yearSelect.addEventListener('change', updateInput);

    // Auto-format as user types
    input.addEventListener('input', (e) => {
        let value = e.target.value.replace(/\D/g, '');
        if (value.length >= 2) {
            value = value.slice(0, 2) + '/' + value.slice(2);
        }
        if (value.length >= 5) {
            value = value.slice(0, 5) + '/' + value.slice(5, 9);
        }
        e.target.value = value;
    });

    return wrapper;
}

function createBirthdayPicker(field) {
    const wrapper = document.createElement('div');
    wrapper.className = `form-group field-${String(field.key).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    wrapper.appendChild(createLabel(field));

    const input = document.createElement('input');
    input.type = 'hidden';
    input.id = field.key;
    input.name = field.key;
    input.className = 'form-control academic-date-value';
    wrapper.appendChild(input);

    const picker = window.AcademicCalendarDatePicker?.attach(input, {
        label: field.label,
        placeholder: field.placeholder || `Choose ${String(field.label || 'date').toLowerCase()}`,
        min: '1900-01-01',
        max: () => window.AcademicCalendarDatePicker?.todayIso?.() || new Date().toISOString().slice(0, 10)
    });

    if (!picker) {
        input.type = 'date';
        input.className = 'form-control';
    }

    const error = document.createElement('div');
    error.className = 'error-message';
    error.setAttribute('aria-live', 'polite');
    wrapper.appendChild(error);
    return wrapper;
}

function renderField(field, selectOptionsByKey) {
    const fieldClass = `field-${String(field.key).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    if (field.type === 'birthday-picker') {
        return createBirthdayPicker(field);
    }
    if (field.type === 'checkbox') {
        const wrapper = document.createElement('div');
        wrapper.className = `form-check ${fieldClass}`;

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = field.key;
        input.name = field.key;

        const label = document.createElement('label');
        label.setAttribute('for', field.key);
        label.textContent = field.label;

        wrapper.appendChild(input);
        wrapper.appendChild(label);
        return wrapper;
    }

    const group = document.createElement('div');
    group.className = `form-group ${fieldClass}`;

    group.appendChild(createLabel(field));

    let control;
    if (field.type === 'select') {
        control = document.createElement('select');
        control.className = 'form-control';
        control.id = field.key;
        control.name = field.key;

        if (field.key === 'section_id') {
            control.dataset.searchEnabled = 'true';
            control.dataset.searchPlaceholder = 'Search section...';
        } else if (field.key === 'guardian_relationship') {
            control.dataset.searchEnabled = 'true';
            control.dataset.searchPlaceholder = 'Search relationship...';
        }

        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = 'Select...';
        control.appendChild(defaultOption);

        const options = field.staticOptions ?? selectOptionsByKey[field.key] ?? [];
        const cfg = optionConfig[field.key];

        for (const row of options) {
            const opt = document.createElement('option');
            if (field.staticOptions) {
                opt.value = row.value;
                opt.textContent = row.label;
            } else {
                opt.value = row?.[cfg.valueKey] ?? '';
                opt.textContent = row?.[cfg.labelKey] ?? '';
                if (field.key === 'school_year_id' && Number(row?.is_active) === 1) {
                    opt.dataset.isActive = '1';
                }
            }
            control.appendChild(opt);
        }

        if (!field.staticOptions && cfg?.defaultPick) {
            const match = options.find(cfg.defaultPick);
            if (match) {
                control.value = String(match[cfg.valueKey]);
            }
        }
    } else {
        control = document.createElement('input');
        control.className = 'form-control';
        control.type = field.type || 'text';
        control.id = field.key;
        control.name = field.key;
        if (field.maxLength) control.maxLength = field.maxLength;
    }

    if (field.readonly) control.readOnly = true;
    if (field.required) control.required = true;

    group.appendChild(control);

    if (field.helpText) {
        const help = document.createElement('small');
        help.className = 'field-help';
        help.textContent = field.helpText;
        group.appendChild(help);
    }

    if (field.statusControl) {
        const feedback = document.createElement('small');
        feedback.className = 'status-feedback';
        feedback.setAttribute('role', 'status');
        feedback.setAttribute('aria-live', 'polite');
        feedback.hidden = true;
        group.appendChild(feedback);
    }

    const error = document.createElement('div');
    error.className = 'error-message';
    error.setAttribute('aria-live', 'polite');
    group.appendChild(error);

    return group;
}

function clearControlError(control) {
    if (!control) return;
    control.classList.remove('error');
    control.closest('.form-group')?.querySelector('.academic-date-trigger')?.classList.remove('error');
    control.closest('.form-group')?.querySelector('.academic-date-trigger')?.removeAttribute('aria-invalid');
    const group = control.closest('.form-group');
    const msg = group?.querySelector('.error-message');
    if (msg) msg.textContent = '';
}

function setControlError(control, message) {
    if (!control) return;
    control.classList.add('error');
    const dateTrigger = control.closest('.form-group')?.querySelector('.academic-date-trigger');
    dateTrigger?.classList.add('error');
    dateTrigger?.setAttribute('aria-invalid', 'true');
    const group = control.closest('.form-group');
    const msg = group?.querySelector('.error-message');
    if (msg) msg.textContent = message || 'This field is required.';
}

function validateRequiredFields(form) {
    const requiredFields = fieldSections.flatMap((s) => s.fields).filter((f) => f.required);
    const invalidControls = [];

    for (const field of requiredFields) {
        const el = form.querySelector(`#${CSS.escape(String(field.key))}`);
        if (!el) continue;

        // Skip if disabled (e.g., permanent address fields when same-as-current)
        if (el.disabled) {
            clearControlError(el);
            continue;
        }

        const raw = el.type === 'checkbox' ? (el.checked ? '1' : '') : String(el.value || '').trim();
        if (!raw) {
            setControlError(el, 'This field is required.');
            invalidControls.push(el._academicCalendarDatePicker?.trigger || el);
        } else {
            clearControlError(el);
        }
    }

    return invalidControls;
}

function highlightFieldsFromServerMessage(form, message) {
    const msg = String(message || '').toLowerCase();
    const candidates = [];

    const map = [
        { re: /\bgrade\b/, id: 'grade_level_id' },
        { re: /\bsection\b/, id: 'section_id' },
        { re: /\bschool\s*year\b|\byear\b/, id: 'school_year_id' },
        { re: /\blrn\b/, id: 'lrn' },
        { re: /\blast\s*name\b|\bsurname\b/, id: 'last_name' },
        { re: /\bfirst\s*name\b/, id: 'first_name' }
    ];

    for (const m of map) {
        if (!m.re.test(msg)) continue;
        const el = form.querySelector(`#${CSS.escape(m.id)}`);
        if (el && !el.disabled) candidates.push(el);
    }

    for (const el of candidates) {
        setControlError(el, 'Please check this field.');
    }

    return candidates;
}

function applyFieldErrors(form, fieldErrors) {
    if (!fieldErrors || typeof fieldErrors !== 'object') return [];
    const controls = [];

    for (const [key, msg] of Object.entries(fieldErrors)) {
        const id = String(key);
        const el = form.querySelector(`#${CSS.escape(id)}`);
        if (!el || el.disabled) continue;
        setControlError(el, String(msg || 'Invalid value'));
        controls.push(el);
    }

    return controls;
}

function renderForm(container, selectOptionsByKey) {
    container.innerHTML = '';

    const slugify = (s) => String(s || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

    for (const section of fieldSections) {
        const sectionEl = document.createElement('div');
        sectionEl.className = `form-section section-${slugify(section.title)}`;

        const title = document.createElement('h2');
        title.className = 'section-title';
        title.textContent = section.title;
        sectionEl.appendChild(title);

        const fieldsEl = document.createElement('div');
        fieldsEl.className = 'section-fields';

        for (const field of section.fields) {
            fieldsEl.appendChild(renderField(field, selectOptionsByKey));
        }

        sectionEl.appendChild(fieldsEl);
        container.appendChild(sectionEl);
    }
}

function resetSelect(selectEl, placeholderText = 'Select...') {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = placeholderText;
    selectEl.appendChild(defaultOption);
}

function setSelectRows(selectEl, rows, valueKey, labelKey, placeholderText = 'Select...') {
    resetSelect(selectEl, placeholderText);
    if (!selectEl) return;
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
        const opt = document.createElement('option');
        opt.value = row?.[valueKey] ?? '';
        opt.textContent = row?.[labelKey] ?? '';
        selectEl.appendChild(opt);
    }
}

function restrictLearnerGradeLevelToRecord(formElement, record) {
    const gradeEl = formElement?.querySelector('#grade_level_id');
    const gradeLevelId = Number(record?.grade_level_id || 0);
    if (!gradeEl || !gradeLevelId) return;

    const existingOption = Array.from(gradeEl.options || [])
        .find((option) => String(option.value) === String(gradeLevelId));
    const gradeLabel = String(record?.grade_name || existingOption?.textContent || `Grade ${gradeLevelId}`).trim();

    gradeEl.innerHTML = '';
    const option = document.createElement('option');
    option.value = String(gradeLevelId);
    option.textContent = gradeLabel;
    option.selected = true;
    gradeEl.appendChild(option);
    gradeEl.dataset.fixedPlacement = 'true';
    gradeEl.title = 'Grade level is fixed for this learner. Change the section only.';
    gradeEl.disabled = true;

    syncChoicesValue(gradeEl, String(gradeLevelId));
    syncChoicesDisabledState(gradeEl);
}

function syncChoicesDisabledState(selectEl) {
    const instance = selectEl?._choicesInstance;
    if (!instance) return;
    try {
        if (selectEl.disabled) {
            instance.disable();
        } else {
            instance.enable();
        }
    } catch {
        // ignore
    }
}

function syncChoicesValue(selectEl, value) {
    if (!selectEl) return;

    const instance = selectEl?._choicesInstance;
    const isMultiple = !!selectEl.multiple;

    const normalizedValues = isMultiple
        ? (Array.isArray(value) ? value : value ? [value] : []).map((v) => String(v))
        : [value === null || value === undefined ? '' : String(value)];

    // Always set the underlying element value for form submission.
    if (!isMultiple) {
        selectEl.value = normalizedValues[0];
    } else {
        // For multiple selects, keep DOM options in sync.
        const want = new Set(normalizedValues);
        Array.from(selectEl.options || []).forEach((opt) => {
            opt.selected = want.has(String(opt.value));
        });
    }

    if (!instance) {
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        return;
    }

    try {
        // Ensure Choices has the latest options, then apply selection.
        instance.refresh();
        instance.removeActiveItems();
        if (normalizedValues.length && normalizedValues[0] !== '') {
            instance.setChoiceByValue(isMultiple ? normalizedValues : normalizedValues[0]);
        }
    } catch {
        // ignore
    }
}

function syncFlatpickrValue(inputEl, value) {
    if (!inputEl) return;
    const fp = inputEl?._flatpickr;
    if (!fp) return;
    try {
        if (value === null || value === undefined || String(value).trim() === '') {
            fp.clear();
            return;
        }
        fp.setDate(String(value), true);
    } catch {
        // ignore
    }
}

function wireGradeSectionCascade(formElement) {
    const gradeEl = formElement.querySelector('#grade_level_id');
    const sectionEl = formElement.querySelector('#section_id');
    const schoolYearEl = formElement.querySelector('#school_year_id');
    if (!gradeEl || !sectionEl) return;

    async function onGradeChange() {
        const gradeLevelId = Number(gradeEl.value || 0);
        const schoolYearId = Number(schoolYearEl?.value || 0);
        resetSelect(sectionEl, 'Select section...');

        if (!gradeLevelId) return;

        try {
            const rows = await sectionsApi.getByGradeLevel(gradeLevelId, schoolYearId);
            setSelectRows(sectionEl, rows, 'section_id', 'section_name', 'Select section...');
        } catch {
            // keep empty
        }
    }

    gradeEl.addEventListener('change', () => { void onGradeChange(); });
    if (schoolYearEl) {
        schoolYearEl.addEventListener('change', () => { void onGradeChange(); });
    }

    // Initial state: no sections until a grade is chosen
    resetSelect(sectionEl, 'Select section...');
}

async function populateSections(formElement, record) {
    const gradeEl = formElement.querySelector('#grade_level_id');
    const sectionEl = formElement.querySelector('#section_id');
    const schoolYearEl = formElement.querySelector('#school_year_id');
    if (!gradeEl || !sectionEl) return;

    const gradeLevelId = Number(record?.grade_level_id || 0);
    const schoolYearId = Number(record?.school_year_id || schoolYearEl?.value || 0);
    const sectionId = Number(record?.section_id || 0);

    resetSelect(sectionEl, 'Select section...');
    if (!gradeLevelId) return;

    try {
        const rows = await sectionsApi.getByGradeLevel(gradeLevelId, schoolYearId);
        setSelectRows(sectionEl, rows, 'section_id', 'section_name', 'Select section...');
        syncChoicesValue(sectionEl, sectionId ? String(sectionId) : '');
    } catch {
        // ignore
    }
}

function coerceValue(fieldKey, value) {
    if (value === '') return null;
    if (fieldKey.endsWith('_id')) {
        const trimmed = String(value).trim();
        if (/^\d+$/.test(trimmed)) return Number(trimmed);
        return value;
    }
    return value;
}

function getFormPayload(formElement, { includeStatus = false } = {}) {
    const payload = {};

    for (const section of fieldSections) {
        for (const field of section.fields) {
            const input = formElement.querySelector(`#${CSS.escape(field.key)}`);
            if (!input) continue;

            // Enrollment status is part of the single save flow only for the
            // roles allowed to change it. The server enforces this again.
            if (field.statusControl && !includeStatus) continue;

            if (field.type === 'checkbox') {
                payload[field.key] = input.checked ? 1 : 0;
                continue;
            }

            if (field.type === 'birthday-picker') {
                // The calendar stores ISO values directly; keep legacy typed values compatible.
                const value = input.value.trim();
                if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                    payload[field.key] = value;
                } else if (value && /^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
                    const [month, day, year] = value.split('/');
                    payload[field.key] = `${year}-${month}-${day}`;
                } else {
                    payload[field.key] = '';
                }
                continue;
            }

            payload[field.key] = coerceValue(field.key, input.value);
        }
    }

    return payload;
}

function normalizeSortText(value) {
    return String(value || '').trim().toLowerCase();
}

function compareLearnersByName(a, b) {
    const aLast = normalizeSortText(a?.last_name);
    const bLast = normalizeSortText(b?.last_name);
    if (aLast !== bLast) return aLast.localeCompare(bLast);

    const aFirst = normalizeSortText(a?.first_name);
    const bFirst = normalizeSortText(b?.first_name);
    if (aFirst !== bFirst) return aFirst.localeCompare(bFirst);

    const aMiddle = normalizeSortText(a?.middle_name);
    const bMiddle = normalizeSortText(b?.middle_name);
    if (aMiddle !== bMiddle) return aMiddle.localeCompare(bMiddle);

    const aId = Number(a?.learner_id || 0);
    const bId = Number(b?.learner_id || 0);
    return aId - bId;
}

function formatLearnerLabel(row) {
    const last = row?.last_name ?? '';
    const first = row?.first_name ?? '';
    const middle = row?.middle_name ?? '';

    const base = `${last}, ${first}`.trim().replace(/^,\s*/, '');
    const mid = middle ? ` ${middle}` : '';
    return `${base}${mid}`.trim();
}

function formatShortSchoolYear(yearLabel) {
    const value = String(yearLabel || '').trim();
    const match = value.replace(/[–—]/g, '-').match(/^(\d{4})\s*-\s*(\d{4})$/);
    return match ? `${match[1].slice(-2)}-${match[2].slice(-2)}` : value;
}

function setFixedHeader(record) {
    const header = document.getElementById('studentFixedHeader');
    if (!header) return;

    // Always visible; show placeholders when no learner is selected.
    document.getElementById('fixedLrn').textContent = record?.lrn || '-';
    const placement = [
        record?.grade_name || '',
        record?.section_name || '',
        formatShortSchoolYear(record?.year_label)
    ].filter(Boolean).join(' · ') || '-';
    const placementEl = document.getElementById('fixedPlacement');
    if (placementEl) {
        placementEl.textContent = placement;
        placementEl.setAttribute('aria-label', placement);
    }
}

const learnerSegmentSections = {
    personal: ['section-learner-information', 'section-personal-details'],
    address: ['section-current-address'],
    guardian: ['section-family-guardian-information']
};

let activeLearnerSegment = 'personal';

function setLearnerSegment(segment) {
    const nextSegment = Object.prototype.hasOwnProperty.call(learnerSegmentSections, segment)
        ? segment
        : 'personal';
    activeLearnerSegment = nextSegment;

    document.querySelectorAll('[data-learner-segment]').forEach((tab) => {
        const isActive = tab.dataset.learnerSegment === nextSegment;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tab.tabIndex = isActive ? 0 : -1;
    });

    const visibleSections = new Set(learnerSegmentSections[nextSegment]);
    document.querySelectorAll('#studentDetailsFields > .form-section, #sf1RecordForm > .form-section').forEach((section) => {
        const isSchoolInformation = section.classList.contains('section-school-information');
        const isVisible = !isSchoolInformation && visibleSections.has(
            Array.from(section.classList).find((className) => className.startsWith('section-')) || ''
        );
        section.hidden = !isVisible;
        section.setAttribute('aria-hidden', isVisible ? 'false' : 'true');
    });
}

function initializeLearnerSegments() {
    const tabs = Array.from(document.querySelectorAll('[data-learner-segment]'));
    if (!tabs.length) return;

    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => setLearnerSegment(tab.dataset.learnerSegment));
        tab.addEventListener('keydown', (event) => {
            if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
            event.preventDefault();
            const direction = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1;
            const nextIndex = (index + direction + tabs.length) % tabs.length;
            tabs[nextIndex].focus();
            setLearnerSegment(tabs[nextIndex].dataset.learnerSegment);
        });
    });
}

function parseDateOnly(value) {
    const raw = String(value || '').trim();
    let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
        return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }

    match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) {
        return new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]));
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getSchoolYearStartYear(yearLabel) {
    const match = String(yearLabel || '').match(/\b(20\d{2}|19\d{2})\b/);
    return match ? Number(match[1]) : NaN;
}

function getFirstFridayOfJune(startYear) {
    const date = new Date(startYear, 5, 1);
    const daysUntilFriday = (5 - date.getDay() + 7) % 7;
    date.setDate(date.getDate() + daysUntilFriday);
    return date;
}

function getActiveSchoolYearLabel(formElement) {
    const schoolYearEl = formElement?.querySelector?.('#school_year_id');
    const activeOption = schoolYearEl?.querySelector?.('option[data-is-active="1"]');
    return activeOption?.textContent?.trim() || '';
}

function getAgeSchoolYearLabel(record, formElement, allowFutureSelected = false) {
    const selectedLabel = record?.year_label || formElement?.querySelector?.('#school_year_id')?.selectedOptions?.[0]?.textContent || '';
    const startYear = getSchoolYearStartYear(selectedLabel);
    const currentYear = new Date().getFullYear();

    if (Number.isFinite(startYear) && (allowFutureSelected || startYear <= currentYear + 1)) {
        return selectedLabel;
    }

    return getActiveSchoolYearLabel(formElement) || selectedLabel;
}

function computeAgeByJune(dob, yearLabel) {
    if (!dob) return '';
    const birth = parseDateOnly(dob);
    if (!birth) return '';
    const startYear = getSchoolYearStartYear(yearLabel);
    if (Number.isNaN(startYear)) return '';
    const cutoff = getFirstFridayOfJune(startYear);
    let age = cutoff.getFullYear() - birth.getFullYear();
    const m = cutoff.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && cutoff.getDate() < birth.getDate())) age--;
    return age;
}

function getRecordValue(record, fieldKey) {
    switch (fieldKey) {
        case 'religion_id':
            return record?.religion ?? record?.religion_id;
        case 'mother_tongue_id':
            return record?.mother_tongue ?? record?.mother_tongue_id;
        case 'birth_province_text':
            return record?.birth_province_text ?? record?.birth_province_name;
        default:
            return record?.[fieldKey];
    }
}

function populateForm(formElement, record) {
    for (const section of fieldSections) {
        for (const field of section.fields) {
            const input = formElement.querySelector(`#${CSS.escape(field.key)}`);
            if (!input) continue;

            if (field.key === 'age_by_june') {
                input.value = String(computeAgeByJune(record?.date_of_birth, getAgeSchoolYearLabel(record, formElement)) ?? '');
                continue;
            }

            if (field.type === 'checkbox') {
                input.checked = Number(record?.[field.key]) === 1;
                continue;
            }

            const value = getRecordValue(record, field.key);

            if (field.type === 'birthday-picker') {
                const raw = String(value || '').trim();
                if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
                    input.value = raw.slice(0, 10);
                } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
                    const [month, day, year] = raw.split('/');
                    input.value = `${year}-${month}-${day}`;
                } else {
                    input.value = '';
                }
                input.dispatchEvent(new Event('change', { bubbles: true }));
                continue;
            }

            if (input.tagName === 'SELECT') {
                syncChoicesValue(input, value);
                continue;
            }

            input.value = value === null || value === undefined ? '' : String(value);

            // If this input is enhanced by flatpickr, set it through flatpickr so UI matches.
            if (input.dataset?.enhanced === 'flatpickr' || input._flatpickr) {
                syncFlatpickrValue(input, value);
            }
        }
    }
}

function refreshAgeByJune(formElement, record = null) {
    const ageEl = formElement.querySelector('#age_by_june');
    const dobEl = formElement.querySelector('#date_of_birth');
    if (!ageEl || !dobEl) return;

    const schoolYearEl = formElement.querySelector('#school_year_id');
    const selectedYearLabel = schoolYearEl?.selectedOptions?.[0]?.textContent?.trim() || record?.year_label || '';
    const label = getAgeSchoolYearLabel({ ...record, year_label: selectedYearLabel }, formElement, true);
    ageEl.value = String(computeAgeByJune(dobEl.value || record?.date_of_birth, label) ?? '');
}

function wireAgeByJune(formElement) {
    const dobEl = formElement.querySelector('#date_of_birth');
    const schoolYearEl = formElement.querySelector('#school_year_id');
    if (dobEl) dobEl.addEventListener('input', () => refreshAgeByJune(formElement));
    if (dobEl) dobEl.addEventListener('change', () => refreshAgeByJune(formElement));
    if (schoolYearEl) schoolYearEl.addEventListener('change', () => refreshAgeByJune(formElement));
}


async function preloadSelectOptions() {
    const selectKeys = new Set();
    for (const section of fieldSections) {
        for (const field of section.fields) {
            if (field.type === 'select' && !field.staticOptions) {
                selectKeys.add(field.key);
            }
        }
    }

    const entries = Array.from(selectKeys).map(async (key) => {
        const loader = optionLoaders[key];
        if (!loader) return [key, []];

        try {
            const data = await loader();
            return [key, Array.isArray(data) ? data : []];
        } catch {
            return [key, []];
        }
    });

    const results = await Promise.all(entries);
    return Object.fromEntries(results);
}

document.addEventListener('DOMContentLoaded', async () => {
    const filterInput = document.getElementById('studentFilterInput');
    const fieldsContainer = document.getElementById('studentDetailsFields');
    const form = document.getElementById('studentDetailsForm');
    const saveBtn = document.getElementById('saveChangesBtn');

    if (!fieldsContainer || !form || !filterInput || !saveBtn) return;

    let allRows = [];
    let filteredRows = [];
    let currentLearnerId = null;
    const statusState = {
        enrollmentId: 0,
        schoolYearId: 0,
        status: '',
        canManage: false
    };
    let statusRequestToken = 0;
    let cleanFormSnapshot = '';
    let cleanFieldSnapshots = new Map();
    let isFormHydrating = false;

    const hasPrivilegedStatusRole = () => {
        const roleId = Number(window.CURRENT_ROLE_ID || 0);
        const roleName = String(window.CURRENT_ROLE_NAME || '').trim().toLowerCase();
        return roleId === 7 || roleId === 8 || roleId === 11 || /\b(admin|registrar)\b/.test(roleName);
    };

    const getStatusControl = () => form.querySelector('#enrollment_status');
    const getSchoolYearControl = () => form.querySelector('#school_year_id');

    const getCurrentFormSnapshot = () => {
        if (!currentLearnerId) return '';
        return JSON.stringify(getFormPayload(form, { includeStatus: statusState.canManage }));
    };

    const updateUnsavedIndicator = (isDirty) => {
        saveBtn.classList.toggle('is-unsaved', Boolean(isDirty));
        saveBtn.title = isDirty ? 'Unsaved learner changes' : '';
    };

    const trackedFieldKeys = fieldSections.flatMap((section) => section.fields.map((field) => field.key));
    const getFieldSnapshotValue = (input) => {
        if (!input) return '';
        if (input.type === 'checkbox') return input.checked ? '1' : '0';
        return String(input.value ?? '');
    };
    const captureFieldSnapshots = () => new Map(
        trackedFieldKeys.map((key) => {
            const input = form.querySelector(`#${CSS.escape(String(key))}`);
            return [key, getFieldSnapshotValue(input)];
        })
    );
    const syncFieldUnsavedIndicators = () => {
        const current = captureFieldSnapshots();
        trackedFieldKeys.forEach((key) => {
            const input = form.querySelector(`#${CSS.escape(String(key))}`);
            const group = input?.closest('.form-group');
            const dirty = Boolean(currentLearnerId)
                && cleanFieldSnapshots.has(key)
                && current.get(key) !== cleanFieldSnapshots.get(key);
            group?.classList.toggle('is-unsaved', dirty);
            input?.classList.toggle('is-unsaved', dirty);
            group?.querySelector('.choices')?.classList.toggle('is-unsaved', dirty);
            group?.querySelector('.academic-date-trigger')?.classList.toggle('is-unsaved', dirty);
        });
    };

    const hasUnsavedChanges = () => (
        !isFormHydrating
        && Boolean(currentLearnerId)
        && getCurrentFormSnapshot() !== cleanFormSnapshot
    );

    const markFormClean = () => {
        cleanFormSnapshot = getCurrentFormSnapshot();
        cleanFieldSnapshots = captureFieldSnapshots();
        syncFieldUnsavedIndicators();
        updateUnsavedIndicator(false);
    };

    const closeOpenChoicesForUnsavedPrompt = async () => {
        form.querySelectorAll('select').forEach((select) => {
            try {
                select._choicesInstance?.hideDropdown();
                select._choicesInstance?.containerOuter?.element?.classList.remove('is-open');
            } catch (_) {
                // ignore
            }
        });
        form.querySelectorAll('.choices.is-open').forEach((choices) => {
            choices.classList.remove('is-open', 'is-focused');
            choices.querySelector('.choices__list--dropdown.is-active, .choices__list[aria-expanded="true"]')?.classList.remove('is-active');
            choices.querySelector('.choices__list--dropdown, .choices__list[aria-expanded]')?.setAttribute('aria-expanded', 'false');
            choices.querySelector('.choices__input')?.blur();
        });
        const active = document.activeElement;
        if (active && form.contains(active) && typeof active.blur === 'function') active.blur();
        await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    };

    const confirmDiscardUnsavedChanges = async () => {
        if (!hasUnsavedChanges()) return true;
        const title = 'Unsaved learner changes';
        const message = 'Save the learner details before leaving? Unsaved changes will be lost.';
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
    };

    const resetUnsavedState = () => {
        markFormClean();
    };

    const updateStatusFeedback = (message = '') => {
        const feedback = form.querySelector('.field-enrollment-status .status-feedback');
        if (!feedback) return;
        feedback.textContent = String(message || '');
        feedback.hidden = !message;
    };

    const syncStatusControl = () => {
        const canEdit = statusState.canManage
            && Boolean(currentLearnerId)
            && Boolean(statusState.enrollmentId)
            && Boolean(statusState.schoolYearId);

        const statusGroup = form.querySelector('.field-enrollment-status');
        if (statusGroup) {
            const canViewStatus = hasPrivilegedStatusRole() || statusState.canManage;
            statusGroup.hidden = !canViewStatus;
            statusGroup.setAttribute('aria-hidden', canViewStatus ? 'false' : 'true');
        }

        const statusControl = getStatusControl();
        if (statusControl) {
            statusControl.disabled = !canEdit;
            syncChoicesDisabledState(statusControl);
        }
    };

    const setStatusState = ({ status = '', enrollmentId = 0, schoolYearId = 0, canManage = null, message = '' } = {}) => {
        statusState.enrollmentId = Number(enrollmentId || 0);
        statusState.schoolYearId = Number(schoolYearId || 0);
        statusState.status = String(status || '').trim();
        statusState.canManage = canManage === null ? hasPrivilegedStatusRole() : Boolean(canManage);

        const control = getStatusControl();
        if (control) syncChoicesValue(control, status);

        updateStatusFeedback(message);
        syncStatusControl();
    };

    const setFormEnabled = (enabled) => {
        const controls = Array.from(fieldsContainer.querySelectorAll('input, select, textarea, button.academic-date-trigger'));
        for (const el of controls) {
            const isStatusControl = el.id === 'enrollment_status';
            const isFixedGrade = el.id === 'grade_level_id' && el.dataset.fixedPlacement === 'true';
            el.disabled = !enabled || isFixedGrade || (isStatusControl && !statusState.canManage);
            if (el.tagName === 'SELECT') syncChoicesDisabledState(el);
        }
        syncStatusControl();
    };

    const selectOptionsByKey = await preloadSelectOptions();
    renderForm(fieldsContainer, selectOptionsByKey);
    initializeLearnerSegments();
    setLearnerSegment(activeLearnerSegment);
    wireGradeSectionCascade(form);
    wireAgeByJune(form);

    // Clear validation errors as the user edits
    const clearIfEditable = (target) => {
        if (!target) return;
        if (!target.classList?.contains('form-control')) return;
        if (target.disabled || target.readOnly) return;
        clearControlError(target);
    };
    form.addEventListener('input', (e) => clearIfEditable(e.target));
    form.addEventListener('change', (e) => clearIfEditable(e.target));
    form.addEventListener('input', () => {
        if (!isFormHydrating) {
            updateUnsavedIndicator(hasUnsavedChanges());
            syncFieldUnsavedIndicators();
        }
    });
    form.addEventListener('change', () => {
        if (!isFormHydrating) {
            updateUnsavedIndicator(hasUnsavedChanges());
            syncFieldUnsavedIndicators();
        }
    });

    const statusControl = getStatusControl();
    if (statusControl) statusControl.addEventListener('change', syncStatusControl);

    async function refreshStatusForSelectedSchoolYear() {
        const schoolYearId = Number(getSchoolYearControl()?.value || 0);
        const requestToken = ++statusRequestToken;
        setStatusState({ schoolYearId });

        if (!currentLearnerId || !schoolYearId) return;

        try {
            const response = await learnerRegistrationApi.getStatus(Number(currentLearnerId), schoolYearId);
            if (requestToken !== statusRequestToken) return;
            const row = response?.data || null;

            if (!row) {
                setStatusState({
                    schoolYearId,
                    message: 'Enrollment status is unavailable: no active enrollment exists for this school year.'
                });
                return;
            }

            setStatusState({
                status: row.enrollment_status || '',
                enrollmentId: row.enrollment_id,
                schoolYearId: row.school_year_id || schoolYearId,
                canManage: row.can_manage_status,
                message: row.status_permission_message || ''
            });
        } catch (err) {
            if (requestToken !== statusRequestToken) return;
            updateStatusFeedback(err?.response?.data?.message || 'Unable to verify enrollment-status access. Please try again.');
            syncStatusControl();
            notify('error', err?.response?.data?.message || 'Unable to load enrollment status.', 'Enrollment Status');
        }
    }

    if (getSchoolYearControl()) {
        getSchoolYearControl().addEventListener('change', () => {
            void refreshStatusForSelectedSchoolYear();
        });
    }

    // Default: no learner selected
    saveBtn.disabled = true;
    setFormEnabled(false);
    setFixedHeader(null);
    function applyFilter() {
        const term = (filterInput.value || '').trim().toLowerCase();
        if (!term) {
            filteredRows = allRows;
            return;
        }

        filteredRows = allRows.filter((row) => {
            const fullName = `${row.last_name || ''} ${row.first_name || ''} ${row.middle_name || ''}`.toLowerCase();
            const lrn = (row.lrn || '').toLowerCase();
            return fullName.includes(term) || lrn.includes(term);
        });
    }

    async function refreshRows() {
        try {
            const data = await learnerRegistrationApi.list();
            allRows = Array.isArray(data) ? data : [];
            allRows.sort(compareLearnersByName);
            filteredRows = allRows;
        } catch (err) {
            // Helpful diagnostics for 4xx/5xx (especially 422 validation responses)
            try {
                console.error('Learner registration list failed', {
                    status: err?.response?.status,
                    data: err?.response?.data,
                    url: err?.config?.url,
                    params: err?.config?.params
                });
            } catch {
                // ignore
            }
            notify('error', err?.response?.data?.message || err?.message || 'Failed to load learners.', 'Registered Details');
        }
    }

    async function selectLearnerById(learnerId) {
        statusRequestToken += 1;
        isFormHydrating = true;
        try {
            const record = allRows.find((r) => String(r.learner_id) === String(learnerId));
            currentLearnerId = record ? String(record.learner_id) : null;

            if (!record) {
                setFixedHeader(null);
                form.reset();
                form.querySelectorAll('.academic-date-value').forEach((input) => {
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                });
                saveBtn.disabled = true;
                setStatusState();
                setFormEnabled(false);
                return;
            }

            saveBtn.disabled = false;
            setFormEnabled(true);

            setFixedHeader(record);
            populateForm(form, record);
            restrictLearnerGradeLevelToRecord(form, record);

            // Section options depend on selected grade level
            await populateSections(form, record);
            setStatusState({
                status: record.enrollment_status || '',
                enrollmentId: record.enrollment_id,
                schoolYearId: record.school_year_id
            });
            await refreshStatusForSelectedSchoolYear();
            setLearnerSegment(activeLearnerSegment);
        } finally {
            isFormHydrating = false;
            markFormClean();
        }
    }

    // Enhanced search functionality
    const searchSuggestions = document.getElementById('searchSuggestions');
    let searchTimeout = null;
    let selectedIndex = -1;
    let currentSuggestions = [];

    function initializeSearch() {
        filterInput.addEventListener('input', handleSearchInput);
        filterInput.addEventListener('keydown', handleSearchKeydown);
        filterInput.addEventListener('focus', handleSearchFocus);
        filterInput.addEventListener('blur', handleSearchBlur);

        // Close suggestions when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.search-container')) {
                hideSuggestions();
            }
        });
    }

    function handleSearchInput(e) {
        const query = e.target.value.trim();

        // Clear previous timeout
        if (searchTimeout) {
            clearTimeout(searchTimeout);
        }

        if (query.length < 2) {
            hideSuggestions();
            applyFilter(); // Still apply filter for shorter queries
            return;
        }

        // Debounce search
        searchTimeout = setTimeout(() => {
            performSearch(query);
        }, 300);
    }

    function handleSearchKeydown(e) {
        if (!searchSuggestions.style.display || searchSuggestions.style.display === 'none') {
            return;
        }

        const items = searchSuggestions.querySelectorAll('.suggestion-item');

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
                updateSelection(items);
                break;
            case 'ArrowUp':
                e.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, -1);
                updateSelection(items);
                break;
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && items[selectedIndex]) {
                    selectSuggestion(currentSuggestions[selectedIndex]);
                }
                break;
            case 'Escape':
                hideSuggestions();
                filterInput.focus();
                break;
        }
    }

    function handleSearchFocus() {
        const query = filterInput.value.trim();
        if (query.length >= 2) {
            performSearch(query);
        }
    }

    function handleSearchBlur() {
        // Delay hiding to allow click on suggestion
        setTimeout(() => {
            hideSuggestions();
        }, 200);
    }

    function performSearch(query) {
        showLoadingSuggestions();

        // Direct search for faster response
        setTimeout(() => {
            const results = searchLearners(query);
            displaySuggestions(results, query);
        }, 100);
    }

    function searchLearners(query) {
        const lowerQuery = query.toLowerCase();

        return allRows.filter(learner => {
            // Search by LRN
            if (learner.lrn && learner.lrn.toLowerCase().includes(lowerQuery)) {
                return true;
            }

            // Search by last name
            if (learner.last_name && learner.last_name.toLowerCase().includes(lowerQuery)) {
                return true;
            }

            // Search by first name
            if (learner.first_name && learner.first_name.toLowerCase().includes(lowerQuery)) {
                return true;
            }

            // Search by full name
            if (learner.full_name_raw && learner.full_name_raw.toLowerCase().includes(lowerQuery)) {
                return true;
            }

            return false;
        }).slice(0, 10); // Limit to 10 results
    }

    function displaySuggestions(results, query) {
        currentSuggestions = results;
        selectedIndex = -1;

        if (results.length === 0) {
            showNoSuggestions();
            return;
        }

        const html = results.map((learner, index) => {
            const initials = getInitials(learner.first_name, learner.last_name);
            const fullName = learner.full_name_raw || `${learner.last_name}, ${learner.first_name}`;
            const highlightedName = highlightMatch(fullName, query);
            const highlightedLrn = highlightMatch(learner.lrn || '', query);

            return `
                <div class="suggestion-item" data-index="${index}" data-learner-id="${learner.learner_id}">
                    <div class="suggestion-avatar">${initials}</div>
                    <div class="suggestion-details">
                        <div class="suggestion-name">${highlightedName}</div>
                        <div class="suggestion-meta">
                            <span class="suggestion-lrn">${highlightedLrn}</span>
                            <span class="suggestion-grade">${learner.grade_name || 'N/A'}</span>
                            <span>${learner.section_name || 'No Section'}</span>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        searchSuggestions.innerHTML = html;
        searchSuggestions.style.display = 'block';

        // Add click handlers
        searchSuggestions.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.index);
                selectSuggestion(results[index]);
            });
        });
    }

    function getInitials(firstName, lastName) {
        const first = (firstName || '').charAt(0).toUpperCase();
        const last = (lastName || '').charAt(0).toUpperCase();
        return (first + last) || '?';
    }

    function highlightMatch(text, query) {
        if (!text || !query) return text || '';

        const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        return text.replace(regex, '<span class="highlight">$1</span>');
    }

    function updateSelection(items) {
        items.forEach((item, index) => {
            if (index === selectedIndex) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }

    async function selectSuggestion(learner) {
        if (!(await confirmDiscardUnsavedChanges())) return;
        resetUnsavedState();

        // Update search input and trigger selection
        filterInput.value = learner.full_name_raw || `${learner.last_name}, ${learner.first_name}`;

        // Trigger learner selection
        void selectLearnerById(learner.learner_id);

        hideSuggestions();
        filterInput.focus();
    }

    function showLoadingSuggestions() {
        searchSuggestions.innerHTML = '<div class="suggestions-loading"><i class="fas fa-spinner fa-spin"></i> Searching...</div>';
        searchSuggestions.style.display = 'block';
    }

    function showNoSuggestions() {
        searchSuggestions.innerHTML = '<div class="no-suggestions">No learners found</div>';
        searchSuggestions.style.display = 'block';
    }

    function hideSuggestions() {
        searchSuggestions.style.display = 'none';
        selectedIndex = -1;
        currentSuggestions = [];
    }

    // Initialize search
    initializeSearch();

    window.addEventListener('beforeunload', (event) => {
        if (!hasUnsavedChanges()) return;
        event.preventDefault();
        event.returnValue = '';
    });

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
        if (await confirmDiscardUnsavedChanges()) {
            resetUnsavedState();
            window.location.href = link.href;
        }
    }, true);

    filterInput.addEventListener('input', applyFilter);

    saveBtn.addEventListener('click', async () => {
        if (!currentLearnerId) {
            notify('info', 'Select a learner first.', 'Registered Details');
            return;
        }

        const invalidControls = validateRequiredFields(form);
        if (invalidControls.length) {
            const first = invalidControls[0];
            try {
                first.focus?.();
                first.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
            } catch {
                // ignore
            }
            notify('error', 'Please correct the highlighted fields.', 'Registered Details');
            return;
        }

        saveBtn.disabled = true;
        const oldHtml = saveBtn.innerHTML;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

        try {
            const includeStatus = statusState.canManage;
            const status = String(getStatusControl()?.value || '').trim();
            if (includeStatus
                && ['Dropped', 'Transferred Out'].includes(status)
                && status !== statusState.status) {
                const label = status === 'Dropped' ? 'Dropped' : 'Transferred Out';
                if (!window.confirm(
                    `Mark this learner as ${label} for the selected school year?\n\n`
                    + 'The learner will leave the active attendance roster, while historical records are preserved.'
                )) {
                    return;
                }
            }

            const payload = getFormPayload(form, { includeStatus });
            const res = await learnerRegistrationApi.update(Number(currentLearnerId), payload);

            if (!res?.success) {
                notify('error', res?.message || 'Update failed.', 'Registered Details');
                return;
            }

            notify('success', res?.message || 'Registration updated.', 'Registered Details');
            markFormClean();
            await refreshRows();
            await selectLearnerById(currentLearnerId);
        } catch (err) {
            const data = err?.response?.data;
            const serverMessage = (data && typeof data === 'object' && data.message)
                ? data.message
                : (typeof data === 'string' && data.trim() ? data : (err?.message || 'Server error.'));
            if (err?.response?.status === 403 && /enrollment status/i.test(serverMessage)) {
                updateStatusFeedback(serverMessage);
                syncStatusControl();
            }
            try {
                console.error('Learner registration update failed', {
                    status: err?.response?.status,
                    data: err?.response?.data,
                    url: err?.config?.url
                });
            } catch {
                // ignore
            }
            const byField = applyFieldErrors(form, (data && typeof data === 'object') ? data.field_errors : null);
            const highlighted = byField.length ? byField : highlightFieldsFromServerMessage(form, serverMessage);
            if (highlighted.length) {
                try {
                    highlighted[0].focus?.();
                    highlighted[0].scrollIntoView?.({ behavior: 'smooth', block: 'center' });
                } catch {
                    // ignore
                }
            }
            notify('error', serverMessage, 'Registered Details');
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerHTML = oldHtml;
        }
    });

    await refreshRows();

    // Keep the selection blank until the user chooses a learner.
    currentLearnerId = null;
    filterInput.value = '';
    setFixedHeader(null);
    saveBtn.disabled = true;
    setFormEnabled(false);
    setStatusState();
});
