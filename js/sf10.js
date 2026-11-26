const SF10_API_BASE = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;
axios.defaults.withCredentials = true;

const sf10State = {
    sections: [],
    schoolYears: [],
    yearLevels: [],
    learners: [],
    selectedLearnerId: null,
    selectedEnrollmentId: null,
    history: [],
    historyAvailable: false,
    historySubjectOptions: [],
    historySubjectLoadPromise: null,
    historyStep: 1,
    historyGeneralAverageManual: false,
    selectedHtml: '',
    previewDirty: false,
    previewLoadSequence: 0,
    previewRenderToken: 0,
    previewSavePromises: Object.create(null),
};

function sf10Escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[ch]));
}

function sf10Toast(icon, title) {
    if (typeof window.showNotification === 'function') {
        window.showNotification(title, icon === 'error' ? 'error' : 'info');
        return;
    }
    if (typeof Swal !== 'undefined') {
        Swal.fire({ toast: true, position: 'bottom-end', timer: 2400, showConfirmButton: false, icon, title });
        return;
    }
    window.alert(title);
}

function sf10AppBase() {
    if (window.APP_BASE) return window.APP_BASE;
    const pathname = window.location.pathname || '';
    let appPrefix = '';
    if (pathname.includes('/pages/')) {
        appPrefix = pathname.split('/pages/')[0] || '';
    } else {
        const parts = pathname.split('/').filter(Boolean);
        appPrefix = parts.length ? `/${parts[0]}` : '';
    }
    if (appPrefix === '/') appPrefix = '';
    window.APP_BASE = appPrefix;
    return appPrefix;
}

function sf10AssetUrl(path) {
    const cleanPath = String(path || '').replace(/^\/+/, '');
    return `${window.location.origin}${sf10AppBase()}/${cleanPath}`;
}

function sf10ApiGet(params) {
    return axios.get(`${SF10_API_BASE}/sf10/sf10.php`, { params: { ...params, _: Date.now() } }).then((r) => r.data);
}

function sf10ApiPost(operation, payload) {
    return axios.post(`${SF10_API_BASE}/sf10/sf10.php?operation=${encodeURIComponent(operation)}`, payload).then((r) => r.data);
}

function sf10HistoryField(id) {
    return document.getElementById(id);
}

function sf10HistoryValue(id) {
    return String(sf10HistoryField(id)?.value || '').trim();
}

function sf10HistorySetValue(id, value) {
    const field = sf10HistoryField(id);
    if (field) field.value = value === null || value === undefined ? '' : String(value);
}

function sf10HistorySetStatus(message, type = '') {
    const status = sf10HistoryField('sf10HistoryStatus');
    if (!status) return;
    status.className = `sf10-history-status${type ? ` sf10-history-status--${type}` : ''}`;
    status.textContent = message;
    status.hidden = !message;
}

function sf10HistorySetStep(step, focus = true) {
    const nextStep = Math.min(3, Math.max(1, Number(step) || 1));
    sf10State.historyStep = nextStep;
    document.querySelectorAll('[data-history-step]').forEach((panel) => {
        const isActive = Number(panel.dataset.historyStep) === nextStep;
        panel.hidden = !isActive;
        panel.classList.toggle('is-active', isActive);
        panel.setAttribute('aria-hidden', String(!isActive));
    });
    sf10HistorySetStatus('', '');
    if (nextStep === 3 && sf10State.selectedLearnerId && !sf10State.historySubjectOptions.length) {
        window.setTimeout(() => sf10HistoryLoadCurriculumSubjects({ silent: true }), 0);
    }
    if (focus) {
        const activePanel = document.querySelector(`[data-history-step="${nextStep}"]`);
        window.setTimeout(() => activePanel?.querySelector('input:not([type="hidden"]), select, textarea, button')?.focus(), 0);
    }
}

function sf10HistoryValidateStep(step) {
    const panel = document.querySelector(`[data-history-step="${Number(step)}"]`);
    if (!panel) return true;
    const invalid = Array.from(panel.querySelectorAll('input, select, textarea')).find((field) => !field.checkValidity());
    if (invalid) {
        invalid.reportValidity?.();
        return false;
    }
    if (Number(step) === 1) {
        const schoolYear = sf10HistoryValue('sf10HistorySchoolYear');
        if (!/^(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}$/.test(schoolYear)) {
            sf10HistorySetStatus('Use the school year format YYYY-YYYY.', 'error');
            sf10HistoryField('sf10HistorySchoolYear')?.focus();
            return false;
        }
    }
    return true;
}

function sf10HistoryRecordLabel(record) {
    return `${record?.school_year || 'School year'} · ${record?.grade_level || 'Grade'}${record?.school?.school_name ? ` · ${record.school.school_name}` : ''}`;
}

function sf10HistoryReadGradeRows() {
    return Array.from(sf10HistoryField('sf10HistoryGradeRows')?.querySelectorAll('.sf10-history-grade-row') || [])
        .map((row) => {
            const read = (key) => row.querySelector(`[data-history-grade-field="${key}"]`)?.value ?? '';
            const subjectField = row.querySelector('[data-history-grade-field="subject"]');
            return {
                subject: String(read('subject')).trim(),
                subject_code: String(subjectField?.dataset.historySubjectCode || '').trim(),
                q1: read('q1'),
                q2: read('q2'),
                q3: read('q3'),
                q4: read('q4'),
                final_rating: read('final_rating'),
                remarks: read('remarks'),
            };
        });
}

function sf10HistoryReplaceGradeRows(rows) {
    const container = sf10HistoryField('sf10HistoryGradeRows');
    if (!container) return;
    container.replaceChildren();
    const sourceRows = Array.isArray(rows) && rows.length ? rows : [{}];
    sourceRows.forEach((row) => sf10HistoryAddGradeRow(row));
    sf10HistoryApplyGradingSystem();
}

function sf10HistorySubjectRole(subject) {
    const name = String(subject?.subject_name || subject?.subject || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const code = String(subject?.subject_code || '').toUpperCase().trim();
    if (code === 'MAPEH' || (name.includes('mapeh') && !name.includes('component'))) return 'parent';
    if (/\bmusic\s*(and|&)\s*arts?\b/.test(name)) return 'grouped_music_arts';
    if (/\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/.test(name)) return 'grouped_pe_health';
    if (/\b(music|arts|physical education|health|pe|p\.e\.)\b/.test(name)) return 'component';
    return null;
}

function sf10HistoryOrderSubjectOptions(subjects, mapehSetup = {}) {
    const rows = Array.isArray(subjects) ? subjects.slice() : [];
    if (!mapehSetup?.fixed_group) return rows;
    const related = rows.filter((row) => sf10HistorySubjectRole(row));
    if (related.length < 3) return rows;
    const firstRelatedIndex = rows.findIndex((row) => sf10HistorySubjectRole(row));
    const parent = related.find((row) => sf10HistorySubjectRole(row) === 'parent');
    const musicArts = related.find((row) => sf10HistorySubjectRole(row) === 'grouped_music_arts');
    const peHealth = related.find((row) => sf10HistorySubjectRole(row) === 'grouped_pe_health');
    if (!parent || !musicArts || !peHealth) return rows;
    const before = rows.slice(0, firstRelatedIndex).filter((row) => !sf10HistorySubjectRole(row));
    const after = rows.slice(firstRelatedIndex).filter((row) => !sf10HistorySubjectRole(row));
    return [...before, parent, musicArts, peHealth, ...after];
}

function sf10HistoryRenderList() {
    const list = sf10HistoryField('sf10HistoryLoadList');
    if (!list) return;
    const records = Array.isArray(sf10State.history) ? sf10State.history : [];
    if (!records.length) {
        list.innerHTML = '<div class="sf10-history-empty context-empty-state" role="status"><video class="mp4-surface-blend context-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="../assets/icons/learners.mp4" type="video/mp4"></video><span>No saved previous-school records.</span></div>';
        return;
    }
    list.innerHTML = records.map((record) => `
        <div class="sf10-history-item${Number(record.history_id) === Number(sf10HistoryField('sf10HistoryId')?.value || 0) ? ' is-active' : ''}">
            <button type="button" class="sf10-history-item-main" data-history-edit="${Number(record.history_id)}">
                <strong>${sf10Escape(record.school_year || '')} · ${sf10Escape(record.grade_level || '')}</strong>
                <span>${sf10Escape(record.school?.school_name || '')} · ${sf10Escape(sf10HistoryRatingLabel(record.grading_system || record.grading_system_type))}</span>
            </button>
            <button type="button" class="sf10-history-remove-record" data-history-delete="${Number(record.history_id)}">Archive record</button>
        </div>
    `).join('');
    list.querySelectorAll('[data-history-edit]').forEach((button) => {
        button.addEventListener('click', () => {
            const record = records.find((row) => Number(row.history_id) === Number(button.dataset.historyEdit));
            if (record) {
                sf10HistoryPopulateForm(record);
                sf10HistoryCloseLoad();
            }
        });
    });
    list.querySelectorAll('[data-history-delete]').forEach((button) => {
        button.addEventListener('click', () => sf10HistoryDelete(Number(button.dataset.historyDelete || 0)));
    });
}

function sf10HistoryAddGradeRow(row = {}) {
    const container = sf10HistoryField('sf10HistoryGradeRows');
    if (!container) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'sf10-history-grade-row';
    const fields = [
        ['subject', 'Learning area', row.subject || row.subject_name || '', 'text'],
        ['q1', 'Q1', row.q1 ?? '', 'number'],
        ['q2', 'Q2', row.q2 ?? '', 'number'],
        ['q3', 'Q3', row.q3 ?? '', 'number'],
        ['q4', 'Q4', row.q4 ?? '', 'number'],
        ['final_rating', 'Final', row.final_rating ?? '', 'number'],
        ['remarks', 'Remarks', row.remarks || '', 'text'],
    ];
    fields.forEach(([key, placeholder, value, type]) => {
        const field = document.createElement('div');
        field.className = `sf10-history-grade-field sf10-history-grade-field--${key}`;
        const label = document.createElement('label');
        label.textContent = placeholder;
        const input = key === 'subject' ? document.createElement('select') : document.createElement('input');
        input.dataset.historyGradeField = key;
        input.setAttribute('aria-label', placeholder);
        if (key === 'subject') {
            input.className = 'sf10-history-subject-select';
            // Keep modal selectors native. Choices renders an absolute dropdown
            // inside the scrollable modal body, where ancestor overflow can clip
            // the options beneath the dialog content.
            input.dataset.native = 'true';
            const empty = document.createElement('option');
            empty.value = '';
            empty.textContent = sf10State.historySubjectOptions.length
                ? 'Select learning area'
                : 'Select learning area';
            input.appendChild(empty);
            sf10State.historySubjectOptions.forEach((option) => {
                const subjectName = String(option?.subject_name || '').trim();
                if (!subjectName) return;
                const optionElement = document.createElement('option');
                optionElement.value = subjectName;
                optionElement.textContent = subjectName;
                optionElement.dataset.subjectCode = String(option?.subject_code || '');
                input.appendChild(optionElement);
            });
            const selectedValue = value === null || value === undefined ? '' : String(value);
            if (selectedValue && !Array.from(input.options).some((option) => option.value === selectedValue)) {
                const custom = document.createElement('option');
                custom.value = selectedValue;
                custom.textContent = `${selectedValue} (manual)`;
                input.appendChild(custom);
            }
            input.value = selectedValue;
            input.dataset.historySubjectCode = String(row.subject_code || '');
            input.addEventListener('change', () => {
                input.dataset.historySubjectCode = input.selectedOptions[0]?.dataset.subjectCode || '';
            });
        } else {
            input.type = type;
            input.placeholder = placeholder;
            input.value = value === null || value === undefined ? '' : String(value);
            if (type === 'number') {
                input.min = '0';
                input.max = '100';
                input.step = '0.01';
            }
        }
        if (key === 'final_rating' || key === 'remarks') {
            input.readOnly = true;
            input.tabIndex = -1;
        }
        if (['q1', 'q2', 'q3', 'q4'].includes(key)) {
            input.addEventListener('input', () => sf10HistorySyncGradeRow(wrapper));
        }
        field.append(label, input);
        wrapper.appendChild(field);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'sf10-history-remove-grade';
    remove.setAttribute('aria-label', 'Remove learning area');
    remove.innerHTML = '<i class="fas fa-times"></i>';
    remove.addEventListener('click', () => {
        wrapper.remove();
        if (!container.children.length) sf10HistoryAddGradeRow();
        sf10HistoryUpdateGeneralAverage();
    });
    wrapper.appendChild(remove);
    container.appendChild(wrapper);
    sf10HistoryApplyGradingSystem();
}

async function sf10HistoryLoadCurriculumSubjects({ silent = false } = {}) {
    if (sf10State.historySubjectLoadPromise) return sf10State.historySubjectLoadPromise;
    sf10State.historySubjectLoadPromise = (async () => {
    const gradeLevel = sf10HistoryValue('sf10HistoryGrade');
    if (!gradeLevel) {
        if (!silent) {
            sf10HistorySetStatus('Enter the grade level first.', 'error');
            sf10HistorySetStep(1);
        }
        return false;
    }
    try {
        const response = await sf10ApiGet({
            operation: 'getHistorySubjectOptions',
            learner_id: Number(sf10State.selectedLearnerId || 0),
            grade_level: gradeLevel,
        });
        if (!response?.success) throw new Error(response?.message || 'Curriculum subjects could not be loaded.');
        const data = response.data || {};
        const options = sf10HistoryOrderSubjectOptions(data.subjects || [], data.mapeh_setup || {});
        if (!options.length) {
            sf10HistorySetStatus('No active curriculum subjects were found for this grade level.', 'error');
            sf10State.historySubjectOptions = [];
            sf10HistoryReplaceGradeRows(sf10HistoryReadGradeRows());
            return false;
        }
        sf10State.historySubjectOptions = options;
        const existingRows = sf10HistoryReadGradeRows().filter((row) => row.subject || row.q1 || row.q2 || row.q3 || row.q4);
        // Populate the selector values without creating one row per subject.
        // The registrar chooses the exact learning area for each rating row.
        sf10HistoryReplaceGradeRows(existingRows.length ? existingRows : [{}]);
        // Subject options are loaded automatically when the ratings step opens.
        // Keep that implementation detail out of the SF10 data-entry surface.
        sf10HistorySetStatus('', '');
        return true;
    } catch (error) {
        sf10HistorySetStatus(error?.response?.data?.message || error.message || 'Curriculum subjects could not be loaded.', 'error');
        return false;
    }
    })();
    try {
        return await sf10State.historySubjectLoadPromise;
    } finally {
        sf10State.historySubjectLoadPromise = null;
    }
}

function sf10HistoryUpdateGeneralAverage() {
    const input = sf10HistoryField('sf10HistoryGeneralAverage');
    const useCalculated = sf10HistoryField('sf10HistoryUseCalculatedAverage');
    const rows = Array.from(sf10HistoryField('sf10HistoryGradeRows')?.querySelectorAll('.sf10-history-grade-row') || []);
    const finals = rows
        .map((row) => Number(row.querySelector('[data-history-grade-field="final_rating"]')?.value))
        .filter(Number.isFinite);
    const calculated = sf10Average(finals);
    if (calculated === '') {
        if (useCalculated) useCalculated.hidden = true;
        if (input && !sf10State.historyGeneralAverageManual) input.value = '';
        return;
    }
    if (input && !sf10State.historyGeneralAverageManual) input.value = String(calculated);
    if (useCalculated) useCalculated.hidden = !sf10State.historyGeneralAverageManual;
    if (useCalculated) useCalculated.dataset.calculatedValue = String(calculated);
}

function sf10HistoryGradingSystem() {
    const value = String(sf10HistoryValue('sf10HistoryGradingSystem') || '').toLowerCase().trim();
    return ['three-term', 'three term', 'trimester', 'term', 'terms', 't'].includes(value) ? 'Three-Term' : 'Quarterly';
}

function sf10HistoryRatingLabel(gradingSystem) {
    const value = String(gradingSystem || '').toLowerCase().trim();
    return ['three-term', 'three term', 'trimester', 'term', 'terms', 't'].includes(value) ? 'Term Rating' : 'Quarterly Rating';
}

function sf10HistoryPeriodKeys() {
    return sf10HistoryGradingSystem() === 'Three-Term' ? ['q1', 'q2', 'q3'] : ['q1', 'q2', 'q3', 'q4'];
}

function sf10HistorySyncGradeRow(row, preserveExisting = false) {
    if (!row) return;
    const values = sf10HistoryPeriodKeys()
        .map((key) => Number(row.querySelector(`[data-history-grade-field="${key}"]`)?.value))
        .filter(Number.isFinite);
    const finalField = row.querySelector('[data-history-grade-field="final_rating"]');
    const remarksField = row.querySelector('[data-history-grade-field="remarks"]');
    if (!values.length && preserveExisting) return;
    if (!values.length) {
        if (finalField) finalField.value = '';
        if (remarksField) remarksField.value = '';
        sf10HistoryUpdateGeneralAverage();
        return;
    }
    const finalRating = sf10Average(values);
    if (finalField) finalField.value = finalRating === '' ? '' : String(finalRating);
    if (remarksField) remarksField.value = finalRating === '' ? '' : sf10RemarksFor(finalRating);
    sf10HistoryUpdateGeneralAverage();
}

function sf10HistoryApplyGradingSystem() {
    const threeTerm = sf10HistoryGradingSystem() === 'Three-Term';
    const labels = threeTerm ? ['T1', 'T2', 'T3', ''] : ['Q1', 'Q2', 'Q3', 'Q4'];
    sf10HistoryField('sf10HistoryGradeRows')?.classList.toggle('is-three-term', threeTerm);
    document.querySelector('.sf10-history-grade-head')?.classList.toggle('is-three-term', threeTerm);
    ['q1', 'q2', 'q3', 'q4'].forEach((key, index) => {
        document.querySelectorAll(`[data-history-grade-field="${key}"]`).forEach((input) => {
            const wrapper = input.closest('.sf10-history-grade-field');
            const label = wrapper?.querySelector('label');
            const visible = !threeTerm || key !== 'q4';
            if (label) label.textContent = labels[index] || 'Q4';
            input.placeholder = labels[index] || 'Q4';
            if (wrapper) wrapper.hidden = !visible;
            input.disabled = !visible;
            if (!visible) input.value = '';
        });
        document.querySelectorAll(`[data-history-grade-head="${key}"]`).forEach((head) => {
            head.textContent = labels[index] || 'Q4';
            head.hidden = threeTerm && key === 'q4';
        });
    });
    document.querySelectorAll('.sf10-history-grade-row').forEach((row) => sf10HistorySyncGradeRow(row, true));
    sf10HistoryUpdateGeneralAverage();
}

function sf10HistoryResetForm() {
    const form = sf10HistoryField('sf10HistoryForm');
    if (form) form.reset();
    sf10State.historyGeneralAverageManual = false;
    sf10State.historySubjectOptions = [];
    sf10State.historySubjectLoadPromise = null;
    sf10HistorySetValue('sf10HistoryId', '');
    sf10HistorySetValue('sf10HistoryLearnerId', sf10State.selectedLearnerId || '');
    const rows = sf10HistoryField('sf10HistoryGradeRows');
    if (rows) rows.innerHTML = '';
    sf10HistoryAddGradeRow();
    sf10HistoryApplyGradingSystem();
    const save = sf10HistoryField('sf10HistorySaveBtn');
    if (save) save.innerHTML = '<i class="fas fa-save"></i> Save record';
    sf10HistorySetStep(1, false);
    sf10HistoryRenderList();
}

function sf10HistoryPopulateForm(record) {
    sf10HistorySetValue('sf10HistoryId', record?.history_id || '');
    sf10HistorySetValue('sf10HistoryLearnerId', sf10State.selectedLearnerId || '');
    sf10HistorySetValue('sf10HistorySchoolName', record?.school?.school_name || '');
    sf10HistorySetValue('sf10HistorySchoolId', record?.school?.school_id || '');
    sf10HistorySetValue('sf10HistorySchoolYear', record?.school_year || '');
    sf10HistorySetValue('sf10HistoryGrade', record?.grade_level || '');
    sf10HistorySetValue('sf10HistoryGeneralAverage', record?.general_average ?? '');
    // General average follows the live calculation by default. A registrar
    // can still type an official override, which reveals the Use calculated
    // action for returning to the computed value.
    sf10State.historyGeneralAverageManual = false;
    sf10HistorySetValue('sf10HistorySourceType', record?.source_type || 'Previous School SF10');
    const grades = Array.isArray(record?.grades) ? record.grades : [];
    const hasQ4Values = grades.some((grade) => grade?.q4 !== null && grade?.q4 !== undefined && grade?.q4 !== '');
    const inferredSystem = record?.grading_system || record?.grading_system_type
        || (hasQ4Values ? 'Quarterly' : 'Three-Term');
    sf10HistorySetValue('sf10HistoryGradingSystem', ['three-term', 'three term', 'trimester', 'term'].includes(String(inferredSystem || '').toLowerCase()) ? 'Three-Term' : 'Quarterly');
    sf10HistorySetValue('sf10HistorySourceReference', record?.source_reference || '');
    sf10HistorySetValue('sf10HistoryDistrict', record?.school?.district || '');
    sf10HistorySetValue('sf10HistoryDivision', record?.school?.division || '');
    sf10HistorySetValue('sf10HistoryRegion', record?.school?.region || '');
    sf10HistorySetValue('sf10HistorySection', record?.section || '');
    sf10HistorySetValue('sf10HistoryAdviser', record?.adviser || '');
    const verified = sf10HistoryField('sf10HistoryVerified');
    if (verified) verified.checked = Number(record?.verified || 0) === 1;
    const rows = sf10HistoryField('sf10HistoryGradeRows');
    if (rows) rows.innerHTML = '';
    (grades.length ? grades : [{}]).forEach((grade) => sf10HistoryAddGradeRow(grade));
    sf10HistoryApplyGradingSystem();
    const save = sf10HistoryField('sf10HistorySaveBtn');
    if (save) save.innerHTML = '<i class="fas fa-save"></i> Update record';
    sf10HistoryRenderList();
}

async function sf10HistoryLoad() {
    const learnerId = Number(sf10State.selectedLearnerId || 0);
    if (!learnerId) return;
    try {
        const response = await sf10ApiGet({ operation: 'getAcademicHistory', learner_id: learnerId });
        if (!response?.success) throw new Error(response?.message || 'Failed to load previous-school records.');
        sf10State.history = Array.isArray(response.data) ? response.data : [];
        sf10State.historyAvailable = true;
        sf10HistoryRenderList();
    } catch (error) {
        sf10State.history = [];
        sf10HistoryRenderList();
        sf10Toast('error', error?.response?.data?.message || error.message || 'Failed to load previous-school records.');
    }
}

async function sf10HistoryOpen() {
    if (!sf10State.selectedLearnerId) {
        sf10Toast('info', 'Select a learner first.');
        return;
    }
    const modal = sf10HistoryField('sf10HistoryModal');
    if (!modal) return;
    const learnerName = String(document.getElementById('sf10SelectedLabel')?.textContent || 'Selected learner').trim();
    const title = sf10HistoryField('sf10HistoryTitle');
    if (title) title.textContent = `Previous-school academic records for ${learnerName}`;
    modal.hidden = false;
    sf10HistoryResetForm();
    await sf10HistoryLoad();
}

function sf10HistoryClose() {
    const modal = sf10HistoryField('sf10HistoryModal');
    if (modal) modal.hidden = true;
    sf10HistoryCloseLoad();
}

function sf10HistoryCloseLoad() {
    const modal = sf10HistoryField('sf10HistoryLoadModal');
    if (modal) modal.hidden = true;
}

function sf10HistoryCollect() {
    const rows = Array.from(sf10HistoryField('sf10HistoryGradeRows')?.querySelectorAll('.sf10-history-grade-row') || []);
    return {
        history_id: Number(sf10HistoryValue('sf10HistoryId') || 0),
        learner_id: Number(sf10State.selectedLearnerId || sf10HistoryValue('sf10HistoryLearnerId') || 0),
        enrollment_id: Number(sf10State.selectedEnrollmentId || 0),
        school_name: sf10HistoryValue('sf10HistorySchoolName'),
        school_id: sf10HistoryValue('sf10HistorySchoolId'),
        school_year: sf10HistoryValue('sf10HistorySchoolYear'),
        grade_level: sf10HistoryValue('sf10HistoryGrade'),
        general_average: sf10HistoryValue('sf10HistoryGeneralAverage'),
        grading_system: sf10HistoryGradingSystem(),
        source_type: sf10HistoryValue('sf10HistorySourceType'),
        source_reference: sf10HistoryValue('sf10HistorySourceReference'),
        district: sf10HistoryValue('sf10HistoryDistrict'),
        division: sf10HistoryValue('sf10HistoryDivision'),
        region: sf10HistoryValue('sf10HistoryRegion'),
        section: sf10HistoryValue('sf10HistorySection'),
        adviser: sf10HistoryValue('sf10HistoryAdviser'),
        verified: 1,
        grades: rows.map((row) => {
            const read = (key) => String(row.querySelector(`[data-history-grade-field="${key}"]`)?.value || '').trim();
            const subjectField = row.querySelector('[data-history-grade-field="subject"]');
            return {
                subject: read('subject'),
                subject_code: String(subjectField?.dataset.historySubjectCode || '').trim(),
                q1: read('q1'), q2: read('q2'), q3: read('q3'), q4: read('q4'),
                final_rating: read('final_rating'),
                remarks: read('remarks'),
            };
        }),
    };
}

async function sf10HistorySave(event) {
    event.preventDefault();
    if (!sf10HistoryValidateStep(1)) {
        sf10HistorySetStep(1);
        return;
    }
    const form = sf10HistoryField('sf10HistoryForm');
    if (form && !form.reportValidity()) return;
    const payload = sf10HistoryCollect();
    if (!/^(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}$/.test(payload.school_year)) {
        sf10Toast('error', 'School Year must use the format YYYY-YYYY.');
        sf10HistoryField('sf10HistorySchoolYear')?.focus();
        return;
    }
    const save = sf10HistoryField('sf10HistorySaveBtn');
    const oldHtml = save?.innerHTML || '';
    if (save) {
        save.disabled = true;
        save.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    }
    try {
        const response = await sf10ApiPost('saveAcademicHistory', payload);
        if (!response?.success) throw new Error(response?.message || 'Failed to save previous-school record.');
        sf10Toast('success', response.message || 'Previous-school record saved.');
        await sf10LoadLearner(Number(sf10State.selectedLearnerId), Number(sf10State.selectedEnrollmentId || 0));
        sf10HistoryResetForm();
        await sf10HistoryLoad();
    } catch (error) {
        sf10Toast('error', error?.response?.data?.message || error.message || 'Failed to save previous-school record.');
    } finally {
        if (save) {
            save.disabled = false;
            save.innerHTML = oldHtml || '<i class="fas fa-save"></i> Save record';
        }
    }
}

async function sf10HistoryDelete(historyId) {
    if (!historyId) return;
    const confirmed = typeof Swal !== 'undefined'
        ? (await Swal.fire({ title: 'Archive this record?', text: 'It will no longer appear in the SF10 preview.', icon: 'warning', showCancelButton: true, confirmButtonText: 'Archive', cancelButtonText: 'Cancel' })).isConfirmed
        : window.confirm('Archive this previous-school record?');
    if (!confirmed) return;
    try {
        const response = await sf10ApiPost('deleteAcademicHistory', { history_id: historyId });
        if (!response?.success) throw new Error(response?.message || 'Failed to archive previous-school record.');
        sf10Toast('success', response.message || 'Previous-school record archived.');
        await sf10LoadLearner(Number(sf10State.selectedLearnerId), Number(sf10State.selectedEnrollmentId || 0));
        sf10HistoryResetForm();
        await sf10HistoryLoad();
    } catch (error) {
        sf10Toast('error', error?.response?.data?.message || error.message || 'Failed to archive previous-school record.');
    }
}

function sf10HistoryWire() {
    sf10HistoryField('sf10HistoryBtn')?.addEventListener('click', () => sf10HistoryOpen());
    sf10HistoryField('sf10HistoryCloseBtn')?.addEventListener('click', sf10HistoryClose);
    sf10HistoryField('sf10HistoryLoadBtn')?.addEventListener('click', () => {
        sf10HistoryRenderList();
        const modal = sf10HistoryField('sf10HistoryLoadModal');
        if (modal) modal.hidden = false;
    });
    sf10HistoryField('sf10HistoryLoadCloseBtn')?.addEventListener('click', sf10HistoryCloseLoad);
    sf10HistoryField('sf10HistoryCancelBtn')?.addEventListener('click', sf10HistoryResetForm);
    sf10HistoryField('sf10HistoryAddGradeBtn')?.addEventListener('click', () => {
        sf10HistoryAddGradeRow();
        sf10HistoryField('sf10HistoryGradeRows')?.lastElementChild?.querySelector('[data-history-grade-field="subject"]')?.focus();
    });
    sf10HistoryField('sf10HistoryGradingSystem')?.addEventListener('change', sf10HistoryApplyGradingSystem);
    sf10HistoryField('sf10HistoryGeneralAverage')?.addEventListener('input', () => {
        sf10State.historyGeneralAverageManual = true;
        sf10HistoryUpdateGeneralAverage();
    });
    sf10HistoryField('sf10HistoryUseCalculatedAverage')?.addEventListener('click', () => {
        const button = sf10HistoryField('sf10HistoryUseCalculatedAverage');
        const input = sf10HistoryField('sf10HistoryGeneralAverage');
        if (!button || !input) return;
        input.value = button.dataset.calculatedValue || '';
        sf10State.historyGeneralAverageManual = false;
        sf10HistoryUpdateGeneralAverage();
        input.focus();
    });
    document.querySelectorAll('[data-history-next]').forEach((button) => {
        button.addEventListener('click', () => {
            const currentStep = Number(button.closest('[data-history-step]')?.dataset.historyStep || sf10State.historyStep);
            if (sf10HistoryValidateStep(currentStep)) sf10HistorySetStep(Number(button.dataset.historyNext));
        });
    });
    document.querySelectorAll('[data-history-back]').forEach((button) => {
        button.addEventListener('click', () => sf10HistorySetStep(Number(button.dataset.historyBack)));
    });
    sf10HistoryField('sf10HistoryForm')?.addEventListener('submit', sf10HistorySave);
    sf10HistoryField('sf10HistoryModal')?.addEventListener('click', (event) => {
        if (event.target?.id === 'sf10HistoryModal') sf10HistoryClose();
    });
    sf10HistoryField('sf10HistoryLoadModal')?.addEventListener('click', (event) => {
        if (event.target?.id === 'sf10HistoryLoadModal') sf10HistoryCloseLoad();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!sf10HistoryField('sf10HistoryLoadModal')?.hidden) sf10HistoryCloseLoad();
        else if (!sf10HistoryField('sf10HistoryModal')?.hidden) sf10HistoryClose();
    });
}

function sf10Grade(value) {
    if (value === null || value === undefined || value === '') return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return sf10Escape(value);
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.00$/, '');
}

function sf10WholeGrade(value) {
    if (value === null || value === undefined || value === '') return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return sf10Escape(value);
    return String(Math.round(n));
}

function sf10HasGrade(value) {
    if (value === null || value === undefined || value === '') return false;
    return Number.isFinite(Number(value));
}

function sf10Average(values) {
    const nums = (values || []).map(Number).filter(Number.isFinite);
    if (!nums.length) return '';
    return Math.round((nums.reduce((sum, value) => sum + value, 0) / nums.length) * 100) / 100;
}

function sf10RemarksFor(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return n >= 75 ? 'Passed' : 'Failed';
}

function sf10BuildSchoolYears(sections) {
    const byId = new Map();
    sections.forEach((section) => {
        const id = String(section.school_year_id || '');
        if (!id || byId.has(id)) return;
        byId.set(id, {
            school_year_id: section.school_year_id,
            year_label: section.year_label || 'School Year',
            is_active: Number(section.is_active || 0),
        });
    });
    return Array.from(byId.values()).sort((a, b) => {
        if (Number(a.is_active) !== Number(b.is_active)) return Number(b.is_active) - Number(a.is_active);
        return String(b.year_label || '').localeCompare(String(a.year_label || ''), undefined, { numeric: true });
    });
}

function sf10SyncSelectTitle(select) {
    if (!select) return;
    const selected = select.options?.[select.selectedIndex];
    select.title = selected?.textContent?.trim() || '';
}

function sf10PopulateSchoolYears() {
    const select = document.getElementById('sf10SchoolYearSelect');
    if (!select) return;
    if (!sf10State.schoolYears.length) {
        select.innerHTML = '<option value="">No school years found</option>';
        select.disabled = true;
        sf10SyncSelectTitle(select);
        return;
    }
    select.disabled = false;
    select.innerHTML = sf10State.schoolYears.map((year, index) => (
        `<option value="${sf10Escape(year.school_year_id)}"${index === 0 ? ' selected' : ''}>${sf10Escape(year.year_label)}${Number(year.is_active || 0) === 1 ? ' (Active)' : ''}</option>`
    )).join('');
    sf10SyncSelectTitle(select);
}

function sf10SectionGradeKey(section) {
    return String(section?.grade_level_id || section?.grade_name || '').trim();
}

function sf10BuildYearLevels(sections) {
    const schoolYearId = String(document.getElementById('sf10SchoolYearSelect')?.value || '');
    const byKey = new Map();
    (sections || [])
        .filter((section) => String(section.school_year_id || '') === schoolYearId)
        .forEach((section) => {
            const key = sf10SectionGradeKey(section);
            if (!key || byKey.has(key)) return;
            const gradeName = String(section.grade_name || 'Year Level').trim();
            const gradeNumber = Number(gradeName.match(/\d+/)?.[0] || 999);
            byKey.set(key, {
                grade_level_id: section.grade_level_id || key,
                grade_name: gradeName,
                grade_number: gradeNumber,
            });
        });
    return Array.from(byKey.values()).sort((a, b) => (
        Number(a.grade_number) - Number(b.grade_number)
        || String(a.grade_name).localeCompare(String(b.grade_name), undefined, { numeric: true })
    ));
}

function sf10PopulateYearLevels() {
    const select = document.getElementById('sf10YearLevelSelect');
    if (!select) return [];
    sf10State.yearLevels = sf10BuildYearLevels(sf10State.sections);
    if (!sf10State.yearLevels.length) {
        select.innerHTML = '<option value="">No year levels found</option>';
        select.disabled = true;
        sf10SyncSelectTitle(select);
        return [];
    }
    select.disabled = false;
    select.innerHTML = sf10State.yearLevels.map((level, index) => (
        `<option value="${sf10Escape(level.grade_level_id)}"${index === 0 ? ' selected' : ''}>${sf10Escape(level.grade_name)}</option>`
    )).join('');
    sf10SyncSelectTitle(select);
    return sf10State.yearLevels;
}

function sf10PopulateSections() {
    const select = document.getElementById('sf10SectionSelect');
    const syId = String(document.getElementById('sf10SchoolYearSelect')?.value || '');
    const yearLevelId = String(document.getElementById('sf10YearLevelSelect')?.value || '');
    if (!select) return [];
    const sections = sf10State.sections.filter((section) => (
        String(section.school_year_id || '') === syId
        && sf10SectionGradeKey(section) === yearLevelId
    ));
    if (!sections.length) {
        select.innerHTML = '<option value="">No sections found</option>';
        select.disabled = true;
        sf10SyncSelectTitle(select);
        return [];
    }
    select.disabled = false;
    select.innerHTML = sections.map((section, index) => (
        `<option value="${sf10Escape(section.section_id)}"${index === 0 ? ' selected' : ''}>${sf10Escape(section.section_name || 'Section')}</option>`
    )).join('');
    sf10SyncSelectTitle(select);
    return sections;
}

function sf10FilterLearners() {
    const term = String(document.getElementById('sf10Search')?.value || '').toLowerCase().trim();
    if (!term) return sf10State.learners;
    return sf10State.learners.filter((learner) => {
        const text = `${learner.learner_name || ''} ${learner.lrn || ''} ${learner.grade_name || ''} ${learner.section_name || ''}`.toLowerCase();
        return text.includes(term);
    });
}

function sf10RenderLearnerList() {
    const list = document.getElementById('sf10LearnerList');
    if (!list) return;
    const learners = sf10FilterLearners();
    if (!learners.length) {
        list.innerHTML = '<div class="context-empty-state" role="status"><video class="mp4-surface-blend context-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="../assets/icons/learners.mp4" type="video/mp4"></video><span>No learners found</span></div>';
        return;
    }
    list.innerHTML = learners.map((learner) => `
        <button class="sf10-student-item${Number(learner.learner_id) === Number(sf10State.selectedLearnerId) ? ' active' : ''}" type="button" data-learner-id="${Number(learner.learner_id)}" data-enrollment-id="${Number(learner.enrollment_id)}">
            <strong>${sf10Escape(learner.learner_name || '')}</strong>
            <span>${sf10Escape(learner.lrn || '')} · ${sf10Escape(learner.grade_name || '')} ${sf10Escape(learner.section_name || '')}</span>
        </button>
    `).join('');
    list.querySelectorAll('[data-learner-id]').forEach((btn) => {
        btn.addEventListener('click', () => sf10LoadLearner(Number(btn.dataset.learnerId || 0), Number(btn.dataset.enrollmentId || 0)));
    });
}

function sf10SubjectRows(grades) {
    return (grades || []).filter((row) => String(row?.subject || '').trim() !== '');
}

function sf10DefaultSubjectsForGrade(record) {
    const gradeNumber = Number(record?.grade_number || 0) || Number(String(record?.grade_level || '').match(/\d+/)?.[0] || 0);
    if (gradeNumber === 1) {
        return ['Language', 'Reading and Literacy', 'Mathematics', 'Makabansa', 'Good Manners and Right Conduct (GMRC)'];
    }
    if (gradeNumber === 2) {
        return ['Filipino', 'English', 'Mathematics', 'Makabansa', 'Good Manners and Right Conduct (GMRC)'];
    }
    if (gradeNumber === 3) {
        return ['Filipino', 'English', 'Mathematics', 'Science', 'Makabansa', 'Good Manners and Right Conduct (GMRC)'];
    }
    if (gradeNumber >= 4 && gradeNumber <= 6) {
        return ['Filipino', 'English', 'Mathematics', 'Science', 'Araling Panlipunan (AP)', 'Technology and Livelihood Education (TLE)', 'MAPEH', 'Good Manners and Right Conduct (GMRC)'];
    }
    if (gradeNumber >= 7 && gradeNumber <= 10) {
        return ['English', 'Filipino', 'Mathematics', 'Science', 'Araling Panlipunan (AP)', gradeNumber === 10 ? 'Edukasyon sa Pagpapakatao (EsP)' : 'Values Education', 'MAPEH', 'Technology and Livelihood Education (TLE)'];
    }
    return [];
}

function sf10BlankSubjectRow(subject = '') {
    return {
        subject,
        q1: '',
        q2: '',
        q3: '',
        q4: '',
        final_rating: '',
        remarks: '',
    };
}

function sf10DefaultMapehComponentRows(record = null) {
    const gradeNumber = Number(record?.grade_number || 0) || Number(String(record?.grade_level || '').match(/\d+/)?.[0] || 0);
    const labels = gradeNumber >= 4 && gradeNumber <= 10
        ? ['Music & Arts', 'Physical Education & Health']
        : ['Music', 'Arts', 'Physical Education', 'Health'];
    return labels.map(sf10BlankSubjectRow);
}

function sf10DefaultRecordRows(record) {
    const sourceRows = sf10SubjectRows(record?.grades || []);
    if (sourceRows.length) {
        const hasMapehParent = sourceRows.some((row) => sf10ClassifyMapeh(row).type === 'parent');
        const hasMapehComponents = sourceRows.some((row) => sf10ClassifyMapeh(row).type === 'component');
        // A curriculum that supplies the MAPEH parent without component rows
        // still receives the complete blank component scaffold. Existing
        // dynamic component rows remain untouched and in their own order.
        return hasMapehParent && !hasMapehComponents
            ? sourceRows.concat(sf10DefaultMapehComponentRows(record))
            : sourceRows;
    }

    // Fixed rows are only a blank-template fallback. Once the API supplies
    // curriculum rows, their names and order remain authoritative.
    const defaults = sf10DefaultSubjectsForGrade(record);
    const rows = (defaults.length ? defaults : Array.from({ length: 8 }, () => '')).map(sf10BlankSubjectRow);
    return rows.some((row) => sf10TemplateSubjectIsMapeh(row.subject))
        ? rows.concat(sf10DefaultMapehComponentRows(record))
        : rows;
}

function sf10TemplateSubjectIsMapeh(subject) {
    return String(subject || '').toLowerCase().includes('mapeh');
}

function sf10ClassifyMapeh(row) {
    const name = String(row?.subject || '').toLowerCase();
    if ((name.includes('mapeh') && !name.includes('component')) || name.includes('music, arts') || name.includes('music, art')) {
        return { type: 'parent', key: 'mapeh' };
    }
    if (/\bmusic\s*(and|&)\s*arts?\b/.test(name)) return { type: 'component', key: 'music_arts', label: 'Music and Arts' };
    if (/\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/.test(name)) return { type: 'component', key: 'pe_health', label: 'Physical Education and Health' };
    if (/\bmusic\b|\bmusika\b/.test(name)) return { type: 'component', key: 'music', label: 'Music' };
    if (/\barts?\b|\bsining\b/.test(name)) return { type: 'component', key: 'art', label: 'Arts' };
    if (/\bpe\b|\bphysical education\b|\bpagpapalakas\b/.test(name)) return { type: 'component', key: 'pe', label: 'Physical Education' };
    if (/\bhealth\b|\bkalusugan\b/.test(name)) return { type: 'component', key: 'health', label: 'Health' };
    return { type: 'other', key: name };
}

function sf10BuildMapehModel(grades, periodKeys = ['q1', 'q2', 'q3', 'q4']) {
    const periods = Array.isArray(periodKeys) && periodKeys.length ? periodKeys : ['q1', 'q2', 'q3', 'q4'];
    const sourceRows = sf10SubjectRows(grades);
    const components = [];
    const componentByKey = {};
    let parentRow = null;

    sourceRows.forEach((row) => {
        const info = sf10ClassifyMapeh(row);
        if (info.type === 'parent') {
            parentRow = parentRow || row;
            return;
        }
        if (info.type === 'component') {
            if (!componentByKey[info.key]) {
                componentByKey[info.key] = { key: info.key, label: info.label, row: null };
                components.push(componentByKey[info.key]);
            }
            const current = componentByKey[info.key].row;
            const currentCount = periods.filter((period) => sf10HasGrade(current?.[period])).length;
            const nextCount = periods.filter((period) => sf10HasGrade(row?.[period])).length;
            if (!current || nextCount >= currentCount) componentByKey[info.key].row = row;
            return;
        }
    });

    const assignedComponents = components.filter((item) => item.row);
    // A dynamic curriculum may supply only MAPEH components. Keep those rows
    // and add the parent row so the SF10 remains complete and recognizable.
    if (!parentRow && !assignedComponents.length) {
        return { displayRows: sourceRows, averageRows: sourceRows };
    }

    const displayParent = {
        ...(parentRow || { subject: 'MAPEH', subject_name: 'MAPEH' }),
        subject: 'MAPEH',
        subject_name: 'MAPEH',
    };
    if (assignedComponents.length) {
        periods.forEach((period) => {
            const values = assignedComponents.map((item) => item.row?.[period]).filter(sf10HasGrade);
            displayParent[period] = values.length ? sf10Average(values) : (parentRow?.[period] ?? '');
        });
        const periodValues = periods.map((period) => displayParent[period]);
        const allPeriodsPresent = periodValues.every(sf10HasGrade);
        displayParent.final_rating = allPeriodsPresent ? sf10Average(periodValues) : '';
        displayParent.remarks = allPeriodsPresent ? sf10RemarksFor(displayParent.final_rating) : '';
    }

    const componentRows = assignedComponents.map((item) => ({
        ...(item.row || {}),
        subject: item.row?.subject || item.label,
        _isMapehComponentDisplay: true,
    }));
    const mapehParentRow = { ...displayParent, _isMapehParentDisplay: true };

    // Keep the MAPEH group at the first MAPEH position from the curriculum
    // instead of moving it after every other learning area.
    const displayRows = [];
    const averageRows = [];
    let mapehInserted = false;
    sourceRows.forEach((row) => {
        const type = sf10ClassifyMapeh(row).type;
        if (type === 'other') {
            displayRows.push(row);
            averageRows.push(row);
            return;
        }
        if (!mapehInserted) {
            displayRows.push(mapehParentRow, ...componentRows);
            averageRows.push(displayParent);
            mapehInserted = true;
        }
    });

    return {
        displayRows,
        averageRows,
    };
}

function sf10FormMeta(data) {
    const form = data?.form || {};
    const level = String(form.level || '').toLowerCase();
    const isJhs = level === 'jhs' || String(form.code || '').toUpperCase() === 'SF10-JHS';
    return {
        code: isJhs ? 'SF10-JHS' : 'SF10-ES',
        level: isJhs ? 'jhs' : 'elementary',
        title: form.title || (isJhs
            ? "Learner's Permanent Academic Record for Junior High School (SF10-JHS)"
            : "Learner's Permanent Academic Record for Elementary School (SF10-ES)"),
        certificationTitle: form.certification_title || (isJhs
            ? 'For Transfer Out / Junior High School Completer Only'
            : 'For Transfer Out / Elementary School Completer Only'),
    };
}

function sf10BlankRecordRows(record) {
    // Keep a descriptive year the same visual height as a normal SF10
    // scholastic block without inventing numeric learning-area data.
    return sf10DefaultRecordRows(record);
}

function sf10RecordPreviewKey(record) {
    const gradeNumber = Number(record?.grade_number || 0) || Number(String(record?.grade_level || '').match(/\d+/)?.[0] || 0);
    if (record?.layout_slot) return `template:slot:${String(record.layout_slot)}`;
    if (Number(record?.history_id || 0) > 0) return `history:${Number(record.history_id)}`;
    if (Number(record?.enrollment_id || 0) > 0) return `enrollment:${Number(record.enrollment_id)}`;
    return `template:grade:${gradeNumber}`;
}

function sf10RecordGradingSystem(record) {
    const value = String(record?.grading_system_type || record?.grading_system || '').toLowerCase().trim();
    return ['three-term', 'three term', 'trimester', 'term', 'terms', 't'].includes(value) ? 'Three-Term' : 'Quarterly';
}

function sf10RecordPeriodKeys(record) {
    return sf10RecordGradingSystem(record) === 'Three-Term'
        ? ['q1', 'q2', 'q3']
        : ['q1', 'q2', 'q3', 'q4'];
}

function sf10RecordPeriodLabel(record) {
    return sf10RecordGradingSystem(record) === 'Three-Term' ? 'Term Rating' : 'Quarterly Rating';
}

function sf10RecordBlock(record, index) {
    const school = record?.school || {};
    const recordKey = sf10RecordPreviewKey(record);
    const isDescriptiveGap = record?.is_descriptive_gap === true || Number(record?.is_descriptive_gap || 0) === 1;
    const periodKeys = sf10RecordPeriodKeys(record);
    const gradingSystemType = sf10RecordGradingSystem(record);
    const allPeriodKeys = ['q1', 'q2', 'q3', 'q4'];
    const periodColumns = allPeriodKeys.map((key, periodIndex) => {
        const visible = periodKeys.includes(key);
        const label = visible
            ? (gradingSystemType === 'Three-Term' ? `T${periodIndex + 1}` : `Q${periodIndex + 1}`)
            : '';
        return `<th data-sf10-period-col="${key}"${visible ? '' : ' hidden'}>${label}</th>`;
    }).join('');
    const mapehModel = isDescriptiveGap
        ? { displayRows: sf10BlankRecordRows(record), averageRows: [] }
        : sf10BuildMapehModel(sf10DefaultRecordRows(record), periodKeys);
    const grades = mapehModel.displayRows;
    const generalValues = mapehModel.averageRows
        .map((row) => Number(row.final_rating))
        .filter((n) => Number.isFinite(n));
    const storedAverage = Number(record?.general_average);
    const generalAverage = isDescriptiveGap
        ? ''
        : Number.isFinite(storedAverage)
        ? storedAverage
        : (generalValues.length ? Math.round((generalValues.reduce((a, b) => a + b, 0) / generalValues.length) * 100) / 100 : '');
    return `
        <section class="record-block${isDescriptiveGap ? ' descriptive-gap' : ''}" data-sf10-record-key="${sf10Escape(recordKey)}" data-sf10-period-count="${periodKeys.length}" data-sf10-grading-system="${sf10Escape(gradingSystemType)}">
            <div class="record-meta">
                <div class="record-meta-row row-school">
                    <div>School: <span>${sf10Escape(school.school_name || '')}</span></div>
                    <div>School ID: <span>${sf10Escape(school.school_id || '')}</span></div>
                </div>
                <div class="record-meta-row row-location">
                    <div>District: <span>${sf10Escape(school.district || '')}</span></div>
                    <div>Division: <span>${sf10Escape(school.division || '')}</span></div>
                    <div>Region: <span>${sf10Escape(school.region || '')}</span></div>
                </div>
                <div class="record-meta-row row-class">
                    <div>Classified as Grade: <span>${sf10Escape(record?.grade_level || '')}</span></div>
                    <div>Section: <span>${sf10Escape(record?.section || '')}</span></div>
                    <div>School Year: <span>${sf10Escape(record?.school_year || '')}</span></div>
                </div>
                <div class="record-meta-row row-adviser">
                    <div>Name of Adviser/Teacher: <span>${sf10Escape(record?.adviser || '')}</span></div>
                    <div>Signature: <span></span></div>
                </div>
            </div>
            <table class="grades-table">
                <thead>
                    <tr>
                        <th rowspan="2" class="learning-area">Learning Areas</th>
                        <th colspan="${periodKeys.length}" data-sf10-period-label>
                            <select class="sf10-period-type-select" data-sf10-period-select aria-label="Period rating type">
                                <option value="Quarterly"${gradingSystemType === 'Quarterly' ? ' selected' : ''}>Quarterly Rating</option>
                                <option value="Three-Term"${gradingSystemType === 'Three-Term' ? ' selected' : ''}>Term Rating</option>
                            </select>
                        </th>
                        <th rowspan="2">Final Rating</th>
                        <th rowspan="2">Remarks</th>
                    </tr>
                    <tr>${periodColumns}</tr>
                </thead>
                <tbody>
                    ${grades.map((row) => `
                        <tr>
                            <td class="learning-area${row._isMapehComponentDisplay ? ' mapeh-component' : ''}${row._isMapehParentDisplay ? ' mapeh-parent' : ''}">${row._isMapehParentDisplay ? `<strong>${sf10Escape(row.subject || 'MAPEH')}</strong>` : sf10Escape(row.subject || '')}</td>
                            ${allPeriodKeys.map((key) => {
                                const visible = periodKeys.includes(key);
                                const value = visible ? (row._isMapehParentDisplay ? sf10WholeGrade(row[key]) : sf10Grade(row[key])) : '';
                                return `<td data-sf10-period-col="${key}"${visible ? '' : ' hidden'}>${value}</td>`;
                            }).join('')}
                            <td class="final-grade">${row._isMapehComponentDisplay ? '' : sf10WholeGrade(row.final_rating)}</td>
                            <td class="remarks">${row._isMapehComponentDisplay ? '' : sf10Escape(row.remarks || '')}</td>
                        </tr>
                    `).join('')}
                    <tr class="general-average">
                        <td class="general-average-label" colspan="${periodKeys.length + 1}">General Average</td>
                        <td class="final-grade">${sf10WholeGrade(generalAverage)}</td>
                        <td class="remarks"></td>
                    </tr>
                </tbody>
            </table>
            <table class="remedial-table">
                <thead>
                    <tr><th colspan="5">Remedial Classes <span>Conducted from: __________ to __________</span></th></tr>
                    <tr><th>Learning Areas</th><th>Final Rating</th><th>Remedial Class Mark</th><th>Recomputed Final Grade</th><th>Remarks</th></tr>
                </thead>
                <tbody>
                    <tr><td></td><td></td><td></td><td></td><td></td></tr>
                    <tr><td></td><td></td><td></td><td></td><td></td></tr>
                </tbody>
            </table>
        </section>
    `;
}

function sf10CertificationSection(data) {
    const learner = data?.learner || {};
    const school = data?.school || {};
    const form = sf10FormMeta(data);
    const lastRecord = [...(data?.records || [])].reverse()[0] || {};
    return `
        <div class="certification-section">
            <div class="transfer-title">${sf10Escape(form.certificationTitle)}</div>
            ${[1, 2, 3].map(() => `
                <div class="cert-block">
                    <h3>CERTIFICATION</h3>
                    <p>I CERTIFY that this is a true record of <span class="cert-learner-name">${sf10Escape(learner.full_name || '')}</span> with LRN <span class="cert-lrn">${sf10Escape(learner.lrn || '')}</span> and that he/she is eligible for admission to Grade <span class="cert-grade-field"></span>.</p>
                    <p>School Name: <span class="cert-school-name">${sf10Escape(school.school_name || '')}</span> School ID <span class="cert-school-id">${sf10Escape(school.school_id || '')}</span> Division: <span class="cert-division">${sf10Escape(school.division || '')}</span> Last School Year Attended: <span class="cert-year">${sf10Escape(lastRecord.school_year || '')}</span></p>
                    <div class="cert-signatures">
                        <div class="cert-date"><span></span><label>Date</label></div>
                        <div class="cert-principal"><span>${sf10Escape(school.school_head || '')}</span><label>Signature of Principal/School Head over Printed Name</label></div>
                        <div class="seal-box">(Affix School Seal here)</div>
                    </div>
                </div>
            `).join('')}
            <div class="cert-footer">
                <span>May add Certification Box if needed</span>
                <span>Revised 2025 based on DepEd Order No. 10, s. 2024</span>
            </div>
        </div>
    `;
}

function sf10CertificationPage(data, pageNo) {
    const form = sf10FormMeta(data);
    return `
        <section class="sf10-page sf10-cert-page">
            <div class="sf10-page-content">
                <div class="page-code">${sf10Escape(form.code)} <span>Page ${pageNo}</span></div>
                ${sf10CertificationSection(data)}
            </div>
        </section>
    `;
}

function sf10TemplateGradeRange(data) {
    const form = sf10FormMeta(data);
    return form.level === 'jhs'
        ? [7, 8, 9, 10]
        : [1, 2, 3, 4, 5, 6];
}

function sf10BlankTemplateRecord(gradeNumber, gradingSystemType = 'Quarterly') {
    const normalizedValue = String(gradingSystemType || '').toLowerCase().trim();
    const normalizedGradingSystem = ['three-term', 'three term', 'trimester', 'term', 'terms', 't'].includes(normalizedValue)
        ? 'Three-Term'
        : 'Quarterly';
    return {
        enrollment_id: null,
        school_year_id: null,
        grade_level_id: null,
        school_year: '',
        grade_level: `Grade ${gradeNumber}`,
        grade_number: gradeNumber,
        section: '',
        school: {},
        adviser: '',
        status: '',
        source_type: 'template_gap',
        source_label: 'Blank SF10 template block',
        general_average: null,
        grades: [],
        grading_mode: 'Numeric',
        grading_system_type: normalizedGradingSystem,
        sf9_template_variant: gradeNumber === 1 ? 'G1' : gradeNumber === 2 ? 'G2' : gradeNumber === 3 ? 'G3' : 'G4_10',
        is_template_gap: true,
    };
}

function sf10CompleteTemplateRecords(data) {
    const sourceRecords = Array.isArray(data?.records) ? data.records : [];
    const firstTypedRecord = sourceRecords.find((record) => record?.grading_system_type || record?.grading_system);
    const defaultGradingSystem = firstTypedRecord?.grading_system_type || firstTypedRecord?.grading_system || 'Quarterly';
    const recordsByGrade = new Map();
    sourceRecords.forEach((record) => {
        const gradeNumber = Number(record?.grade_number || 0) || Number(String(record?.grade_level || '').match(/\d+/)?.[0] || 0);
        if (!recordsByGrade.has(gradeNumber)) recordsByGrade.set(gradeNumber, []);
        recordsByGrade.get(gradeNumber).push(record);
    });

    return sf10TemplateGradeRange(data).flatMap((gradeNumber) => {
        const records = recordsByGrade.get(gradeNumber) || [];
        return records.length ? records : [sf10BlankTemplateRecord(gradeNumber, defaultGradingSystem)];
    });
}

function sf10PreviewPeriodOverride(fields, record) {
    const key = `${sf10RecordPreviewKey(record)}:period_type`;
    const value = fields?.[key];
    if (value === undefined || value === null || String(value).trim() === '') return '';
    const normalized = String(value).toLowerCase().trim();
    return ['three-term', 'three term', 'trimester', 'term', 'terms', 't'].includes(normalized) ? 'Three-Term' : 'Quarterly';
}

function sf10BuildJhsEligibilitySection() {
    return `
        <h2>ELIGIBILITY FOR JHS ENROLLMENT</h2>
        <div class="eligibility-grid eligibility-grid-jhs">
            <div class="eligibility-label">Credential Presented for JHS:</div>
            <div class="eligibility-checkline"><span class="checkline">Elementary School Completer</span></div>
            <div class="eligibility-field">General Average: <span></span></div>
            <div class="eligibility-field">Citation (if Any): <span></span></div>
            <div class="eligibility-field">Name of Elementary School: <span></span></div>
            <div class="eligibility-field">School ID: <span></span></div>
            <div class="eligibility-field eligibility-field-wide">Address of School: <span></span></div>
            <div class="eligibility-label eligibility-label-other">Other Credential Presented</div>
            <div class="eligibility-field eligibility-field-check">PEPT Passer <span></span></div>
            <div class="eligibility-field">Rating: <span></span></div>
            <div class="eligibility-field eligibility-field-check">ALS A &amp; E Passer <span></span></div>
            <div class="eligibility-field">Rating: <span></span></div>
            <div class="eligibility-field eligibility-field-wide">Others (Pls. Specify): <span></span></div>
            <div class="eligibility-field eligibility-field-wide">Date of Examination/Assessment (mm/dd/yyyy): <span></span></div>
            <div class="eligibility-field eligibility-field-full">Name and Address of Testing Center: <span></span></div>
        </div>`;
}

function sf10ElementaryDefaultSubjects(gradeNumber) {
    if (gradeNumber === 1) {
        return ['Language', 'Reading and Literacy', 'Mathematics', 'GMRC (Good Manners and Right Conduct)', 'Makabansa'];
    }
    if (gradeNumber === 2) {
        return ['Filipino', 'English', 'Mathematics', 'GMRC (Good Manners and Right Conduct)', 'Makabansa'];
    }
    if (gradeNumber === 3) {
        return ['Filipino', 'English', 'Mathematics', 'Science', 'GMRC (Good Manners and Right Conduct)', 'Makabansa'];
    }
    if (gradeNumber === 4) {
        return ['Filipino', 'English', 'Mathematics', 'Science', 'GMRC (Good Manners and Right Conduct)', 'Araling Panlipunan', 'EPP', 'MAPEH'];
    }
    return ['Filipino', 'English', 'Mathematics', 'Science', 'GMRC (Good Manners and Right Conduct)', 'Araling Panlipunan', 'EPP / TLE', 'MAPEH'];
}

function sf10ElementaryBlankRow() {
    // Word joiner keeps the reference row visible without displaying a filler glyph.
    return sf10BlankSubjectRow('\u2060');
}

function sf10ElementaryRecordRows(record) {
    const gradeNumber = Number(record?.grade_number || 0) || Number(String(record?.grade_level || '').match(/\d+/)?.[0] || 6);
    const sourceRows = sf10SubjectRows(record?.grades || []);
    let rows = sourceRows.length
        ? sf10DefaultRecordRows(record)
        : sf10ElementaryDefaultSubjects(gradeNumber).map(sf10BlankSubjectRow);
    if (rows.some((row) => sf10ClassifyMapeh(row).type === 'parent') && !rows.some((row) => sf10ClassifyMapeh(row).type === 'component')) {
        rows = rows.concat(sf10DefaultMapehComponentRows({ ...record, grade_number: gradeNumber }));
    }
    const names = new Set(rows.map((row) => String(row?.subject || '').trim().toLowerCase()));
    if (!names.has('arabic language')) rows.push(sf10BlankSubjectRow('*Arabic Language'));
    if (!names.has('islamic values education')) rows.push(sf10BlankSubjectRow('*Islamic Values Education'));
    const targetRows = gradeNumber >= 4 ? 15 : 13;
    while (rows.length < targetRows) rows.push(sf10ElementaryBlankRow());
    return rows;
}

function sf10ElementaryRecordBlock(record, index) {
    return sf10RecordBlock({
        ...record,
        grades: sf10ElementaryRecordRows(record),
    }, index);
}

function sf10ElementaryBlankSlotRecord(slot) {
    return {
        layout_slot: `elementary-${slot}`,
        enrollment_id: null,
        school_year_id: null,
        grade_level_id: null,
        school_year: '',
        grade_level: '',
        grade_number: 6,
        section: '',
        school: {},
        adviser: '',
        status: '',
        source_type: 'template_gap',
        source_label: 'Blank SF10-ES template block',
        general_average: null,
        grades: [],
        grading_mode: 'Numeric',
        grading_system_type: 'Quarterly',
        sf9_template_variant: 'G4_10',
        is_template_gap: true,
    };
}

function sf10BuildElementaryEligibilitySection() {
    return `
        <div class="sf10-es-section">ELIGIBILITY FOR ELEMENTARY SCHOOL ENROLLMENT</div>
        <div class="eligibility-grid sf10-es-eligibility">
            <div class="sf10-es-eligibility-line">Name of School: <span></span></div>
            <div class="sf10-es-eligibility-line">School ID: <span></span></div>
            <div class="sf10-es-eligibility-line sf10-es-eligibility-address">Address of School: <span></span></div>
            <div class="sf10-es-eligibility-line sf10-es-eligibility-other"><strong>Other Credential Presented</strong></div>
            <div class="sf10-es-eligibility-line sf10-es-eligibility-wide">□ PEPT Passer&nbsp;&nbsp; Rating: <span></span></div>
            <div class="sf10-es-eligibility-line">Date of Examination/Assessment (mm/dd/yyyy): <span></span></div>
            <div class="sf10-es-eligibility-line sf10-es-eligibility-wide">□ Others (Pls. Specify): <span></span></div>
            <div class="sf10-es-eligibility-line sf10-es-eligibility-full">Name and Address of Testing Center: <span></span></div>
            <div class="sf10-es-eligibility-line">Remark: <span></span></div>
        </div>`;
}

function sf10BuildJhsPrintHtml(data, renderToken = 0) {
    const learner = data?.learner || {};
    const form = sf10FormMeta(data);
    const previewRenderToken = String(Number(renderToken || 0) || 0);
    const previewOverrides = data?.preview_overrides?.fields && typeof data.preview_overrides.fields === 'object'
        ? data.preview_overrides.fields
        : {};
    const records = sf10CompleteTemplateRecords(data).map((record) => {
        const periodOverride = sf10PreviewPeriodOverride(previewOverrides, record);
        return periodOverride
            ? { ...record, grading_system_type: periodOverride, grading_system: periodOverride }
            : record;
    });
    const previewOverridesJson = JSON.stringify(previewOverrides)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
    const leftLogoUrl = sf10AssetUrl('assets/img/logo/logo.png');
    const rightLogoUrl = sf10AssetUrl('assets/img/logo/Seal_of_the_Department_of_Education_of_the_Philippines.png');
    const frontRecords = records.slice(0, 2);
    const backRecords = records.slice(2);
    const backChunks = [];
    for (let index = 0; index < backRecords.length; index += 3) {
        backChunks.push(backRecords.slice(index, index + 3));
    }
    if (!backChunks.length) backChunks.push([]);
    const totalPages = 1 + backChunks.length;
    const pageLabel = (pageNumber, side) => pageNumber === 1
        ? `Page 1 – Front · 8.5 × 13 in`
        : `Page ${pageNumber} – ${side === 'front' ? 'Front' : 'Back'}${pageNumber > 2 ? ' continuation' : ''} · 8.5 × 13 in`;
    const buildPage = (pageNumber, side, pageRecords, includeFrontMatter, includeCertification) => `
        <div class="sf10-preview-slot" data-s="${side}">
            <p class="sf10-preview-page-label">${pageLabel(pageNumber, side)}</p>
            <section class="sf10-page">
                <div class="sf10-page-content">
                    <div class="page-code">${sf10Escape(form.code)}${pageNumber > 1 ? ` <span>Page ${pageNumber} of ${totalPages}</span>` : ''}</div>
                    ${includeFrontMatter ? `
                        <header class="sf10-header">
                            <img class="sf10-logo sf10-logo-left" src="${sf10Escape(leftLogoUrl)}" alt="School Logo">
                            <div class="sf10-header-text">
                                <div>Republic of the Philippines</div>
                                <div>Department of Education</div>
                                <h1>${sf10Escape(form.title)}</h1>
                                <div>(Formerly Form 137)</div>
                            </div>
                            <img class="sf10-logo sf10-logo-right" src="${sf10Escape(rightLogoUrl)}" alt="DepEd Logo">
                        </header>
                        <h2>LEARNER'S INFORMATION</h2>
                        <div class="personal-grid">
                            <div>LAST NAME: <span>${sf10Escape(learner.last_name || '')}</span></div>
                            <div>FIRST NAME: <span>${sf10Escape(learner.first_name || '')}</span></div>
                            <div>NAME EXT. (Jr,I,II): <span>${sf10Escape(learner.name_extension || '')}</span></div>
                            <div>MIDDLE NAME: <span>${sf10Escape(learner.middle_name || '')}</span></div>
                            <div class="personal-lrn-row">
                                <div class="personal-lrn-field">Learner Reference Number (LRN): <span>${sf10Escape(learner.lrn || '')}</span></div>
                                <div>Birthdate (mm/dd/yyyy): <span>${sf10Escape(learner.date_of_birth || '')}</span></div>
                                <div>Sex: <span>${sf10Escape(learner.sex || learner.gender || '')}</span></div>
                            </div>
                        </div>
                        ${sf10BuildJhsEligibilitySection()}
                    ` : ''}
                    <h2>SCHOLASTIC RECORD</h2>
                    <div class="record-grid">${pageRecords.map(sf10RecordBlock).join('') || sf10RecordBlock(sf10BlankTemplateRecord(7), 0)}</div>
                    ${includeCertification ? sf10CertificationSection(data) : ''}
                </div>
            </section>
        </div>`;

    const pages = [buildPage(1, 'front', frontRecords, true, false)];
    backChunks.forEach((chunk, index) => {
        const pageNumber = index + 2;
        pages.push(buildPage(pageNumber, 'back', chunk, false, index === backChunks.length - 1));
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>SF10-JHS - ${sf10Escape(learner.full_name || '')}</title>
<style>
:root { box-sizing: border-box; --preview-bg: #e9ebee; --preview-fg: #1d2430; --preview-muted: #667085; }
html { scroll-padding-top: env(safe-area-inset-top, 0px); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--preview-bg); color: var(--preview-fg); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.sf10-preview-stage { display: flex; flex-direction: column; align-items: center; gap: 22px; overflow-x: auto; padding: 18px 8px 40px; }
.sf10-preview-slot { position: relative; flex: none; }
.sf10-preview-page-label { margin: 0 0 6px; color: var(--preview-muted); font-size: 12px; text-align: center; }
.sf10-page { position: relative; width: 8.5in; height: 13in; margin: 0 auto; overflow: hidden; padding: .28in .31in .31in; background: #fff; color: #000; box-shadow: 0 2px 14px rgba(0, 0, 0, .28); break-after: page; page-break-after: always; font-family: Arial, Helvetica, sans-serif; }
.sf10-page:last-child { break-after: auto; page-break-after: auto; }
.sf10-page-content { position: relative; z-index: 1; width: 100%; transform-origin: top left; }
.page-code { display: flex; justify-content: space-between; margin-bottom: 3px; font-size: 9px; font-weight: 700; }
.sf10-header { position: relative; display: flex; min-height: .58in; align-items: center; justify-content: center; margin-bottom: 4px; padding: 0 .78in; text-align: center; font-size: 10px; line-height: 1.18; }
.sf10-header-text { width: 100%; }
.sf10-header h1 { margin: 3px 0 0; font-size: 13px; }
.sf10-logo { position: absolute; top: 0; width: .55in; height: .55in; object-fit: contain; }
.sf10-logo-left { left: 0; }
.sf10-logo-right { right: 0; }
.sf10-page h2 { margin: 4px 0 3px; padding: 2px 4px; border: 1px solid #000; background: #d9d9d9; font-size: 10px; text-align: center; }
.personal-grid { display: grid; grid-template-columns: 1fr 1fr .65fr 1fr; gap: 2px 8px; margin-bottom: 4px; font-size: 9px; }
.personal-lrn-row { grid-column: span 4; display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(0, 1.05fr) minmax(0, .42fr); gap: 8px; align-items: end; }
.personal-lrn-row div, .eligibility-grid > div { display: flex; min-width: 0; align-items: flex-end; gap: 4px; white-space: nowrap; }
.personal-grid span, .eligibility-grid span, .record-meta span, .cert-block span { display: inline-block; min-width: 42px; padding: 0 2px; border-bottom: 1px solid #000; font-weight: 700; }
.personal-grid .personal-lrn-row span { width: 100%; min-width: 0; height: 1em; padding: 0; line-height: 1; }
.personal-grid .personal-lrn-field span { width: 50%; flex: 0 0 50%; }
.eligibility-grid { display: grid; grid-template-columns: 1.35fr 1.1fr .95fr 1.25fr; gap: 2px 7px; margin-bottom: 5px; font-size: 8.5px; }
.eligibility-grid > div { min-height: 14px; }
.eligibility-grid .eligibility-label { font-weight: 700; }
.eligibility-grid .eligibility-label-other { grid-column: span 4; padding-top: 2px; }
.eligibility-grid .eligibility-field-wide { grid-column: span 2; }
.eligibility-grid .eligibility-field-full { grid-column: span 4; }
.eligibility-grid .eligibility-checkline { display: block; }
.eligibility-grid .eligibility-checkline span { min-width: 0; padding: 0; border-bottom: 0; font-weight: 400; }
.checkline:before { content: "□ "; font-weight: 700; }
.record-grid { display: grid; grid-template-columns: 1fr; gap: 5px; }
.record-block { break-inside: avoid; page-break-inside: avoid; }
.record-meta { display: grid; gap: 1px; margin-bottom: -1px; padding: 2px 4px 3px; border: 1px solid #000; font-size: 7.5px; line-height: 1.18; }
.record-meta-row { display: grid; gap: 5px; min-height: 12px; align-items: end; }
.record-meta-row > div { display: flex; min-width: 0; align-items: flex-end; gap: 3px; white-space: nowrap; }
.record-meta-row span { width: auto; height: 1em; min-width: 0; flex: 1 1 auto; overflow: hidden; padding: 0 2px; border-bottom: 1px solid #000; line-height: 1; text-overflow: ellipsis; }
.record-meta .row-school { grid-template-columns: minmax(0, 1.45fr) minmax(0, .52fr); }
.record-meta .row-location { grid-template-columns: minmax(0, .9fr) minmax(0, 1.42fr) minmax(0, .52fr); }
.record-meta .row-class { grid-template-columns: minmax(0, .9fr) minmax(0, .9fr) minmax(0, .65fr); }
.record-meta .row-adviser { grid-template-columns: minmax(0, 1.35fr) minmax(0, .65fr); }
.sf10-page table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.sf10-page th, .sf10-page td { height: 13px; padding: 1px 2px; border: 1px solid #000; font-size: 7.2px; line-height: 1.05; text-align: center; vertical-align: middle; }
.sf10-page th { background: #e8e8e8; font-weight: 700; }
.learning-area { width: 38%; text-align: left; }
.learning-area.mapeh-parent { font-weight: 700; }
.learning-area.mapeh-component { padding-left: 12px; font-style: italic; }
.grades-table td.learning-area, .grades-table th.learning-area { text-align: left; }
.grades-table th:not(.learning-area), .grades-table td:not(.learning-area) { width: 10.3%; }
.grades-table th[data-sf10-period-label][colspan="3"] { width: 30.9% !important; }
.grades-table th[data-sf10-period-label][colspan="4"] { width: 41.2% !important; }
.grades-table .final-grade, .grades-table .remarks, .grades-table .general-average td:not(.general-average-label) { text-align: center; }
.grades-table .general-average-label { text-align: left; }
.general-average td { font-weight: 700; }
.remedial-table { margin-top: 2px; }
.remedial-table th, .remedial-table td { text-align: center; }
.remedial-table th:first-child, .remedial-table td:first-child { text-align: left; }
.remedial-table th { font-size: 6.6px; }
.remedial-table span { float: right; font-weight: 400; }
.sf10-period-type-select { display: block; width: 100%; min-width: 0; height: 1.15em; padding: 0 2px; border: 0; border-radius: 3px; background: transparent; color: inherit; font: inherit; font-weight: inherit; text-align: center; text-align-last: center; cursor: pointer; }
.sf10-period-type-select:hover, .sf10-period-type-select:focus { outline: 1px solid #6b7280; outline-offset: -1px; background: rgba(107, 114, 128, .13); }
.certification-section { margin-top: 8px; break-inside: avoid; page-break-inside: avoid; }
.transfer-title { margin: 8px 0 4px; font-size: 9.6px; font-weight: 700; text-align: left; }
.cert-block { margin: 5px 18px; padding: 5px 8px 6px; border: 1px solid #000; font-size: 8.9px; line-height: 1.3; break-inside: avoid; page-break-inside: avoid; }
.cert-block h3 { margin: 0 0 3px; font-size: 10px; line-height: 1.1; text-align: center; }
.cert-block p { margin: 2px 0; }
.cert-block .cert-learner-name { min-width: 2.3in; }
.cert-block .cert-lrn { min-width: 1.05in; }
.cert-block .cert-grade-field { min-width: .72in; }
.cert-block .cert-school-name { min-width: 1.55in; }
.cert-block .cert-school-id { min-width: .75in; }
.cert-block .cert-division { min-width: 1.05in; }
.cert-block .cert-year { min-width: 1.35in; }
.cert-signatures { display: grid; grid-template-columns: 1.15fr 2.75fr 1.08fr; gap: 14px; align-items: end; margin-top: 8px; text-align: center; }
.cert-signatures span { display: block; min-height: 15px; border-bottom: 1px solid #000; }
.cert-signatures label { display: block; margin-top: 2px; font-size: 7.5px; line-height: 1.1; }
.seal-box { display: flex; min-height: 42px; align-items: center; justify-content: center; padding: 3px; border: 1px solid #000; font-size: 8px; }
.cert-footer { display: flex; justify-content: space-between; gap: 8px; margin: 4px 18px 0; font-size: 8px; line-height: 1.1; }
@media screen { [contenteditable="true"] { outline: none; } [contenteditable="true"]:hover { background: rgba(229, 231, 235, .75); } [contenteditable="true"]:focus { outline: 1px solid #6b7280; outline-offset: -1px; background: rgba(229, 231, 235, .55); } }
@media print {
    @page { size: 8.5in 13in; margin: 0; }
    html, body { width: 8.5in; background: #fff; }
    .sf10-preview-page-label { display: none !important; }
    .sf10-preview-stage { display: block; gap: 0; overflow: visible; padding: 0; }
    .sf10-preview-slot { width: 8.5in !important; height: 13in !important; break-after: page; page-break-after: always; }
    .sf10-preview-slot:last-child { break-after: auto; page-break-after: auto; }
    .sf10-page { width: 8.5in; height: 13in; margin: 0; box-shadow: none; }
    .sf10-period-type-select { appearance: none; -webkit-appearance: none; pointer-events: none; background: transparent !important; box-shadow: none !important; color: #000; }
}
</style>
</head>
<body data-sf10-preview-token="${sf10Escape(previewRenderToken)}">
    <div class="sf10-preview-stage" id="sf10PreviewStage">${pages.join('')}</div>
<script>
(function sf10PreviewScript() {
const sf10SavedOverrides = ${previewOverridesJson};
const sf10PreviewRenderToken = ${JSON.stringify(previewRenderToken)};

function sf10IsCurrentPreview() {
  try { return !window.parent || String(window.parent.sf10ActivePreviewToken || '') === sf10PreviewRenderToken; } catch (error) { return true; }
}

function sf10MarkEditable(field, key) {
  if (!field) return;
  field.dataset.sf10Field = key;
  field.contentEditable = 'true';
  field.spellcheck = false;
}

function sf10PrepareEditableFields() {
  const personalKeys = ['last_name', 'first_name', 'name_extension', 'middle_name', 'lrn', 'birthdate', 'sex'];
  document.querySelectorAll('.personal-grid span:not(.sf10-label-colon)').forEach((field, index) => sf10MarkEditable(field, 'personal:' + (personalKeys[index] || index)));
  document.querySelectorAll('.eligibility-grid span').forEach((field, index) => sf10MarkEditable(field, 'eligibility:' + index));
  document.querySelectorAll('.record-block').forEach((recordBlock) => {
    const recordKey = recordBlock.dataset.sf10RecordKey || 'record';
    const metaKeys = ['school_name', 'school_id', 'district', 'division', 'region', 'grade_level', 'section', 'school_year', 'adviser', 'signature'];
    recordBlock.querySelectorAll('.record-meta span').forEach((field, index) => sf10MarkEditable(field, recordKey + ':meta:' + (metaKeys[index] || index)));
    const rowKeys = ['subject', 'q1', 'q2', 'q3', 'q4', 'final_rating', 'remarks'];
    recordBlock.querySelectorAll('.grades-table tbody tr:not(.general-average)').forEach((row, rowIndex) => row.querySelectorAll('td').forEach((field, columnIndex) => sf10MarkEditable(field, recordKey + ':row:' + rowIndex + ':' + (rowKeys[columnIndex] || columnIndex))));
    recordBlock.querySelector('.grades-table tbody tr.general-average')?.querySelectorAll('td').forEach((field, index) => sf10MarkEditable(field, recordKey + ':general_average:' + index));
    recordBlock.querySelectorAll('.remedial-table thead span, .remedial-table tbody td').forEach((field, index) => sf10MarkEditable(field, recordKey + ':remedial:' + index));
  });
  document.querySelectorAll('.certification-section .cert-block').forEach((block, blockIndex) => {
    const keys = ['learner_name', 'lrn', 'grade', 'school_name', 'school_id', 'division', 'school_year', 'date', 'school_head'];
    block.querySelectorAll('span').forEach((field, index) => sf10MarkEditable(field, 'certification:' + blockIndex + ':' + (keys[index] || index)));
  });
  document.querySelectorAll('.cert-footer span').forEach((field, index) => sf10MarkEditable(field, 'certification:footer:' + index));
}

function sf10ApplySavedOverrides() {
  if (!sf10SavedOverrides || typeof sf10SavedOverrides !== 'object') return;
  document.querySelectorAll('[data-sf10-field]').forEach((field) => {
    const key = field.dataset.sf10Field || '';
    if (Object.prototype.hasOwnProperty.call(sf10SavedOverrides, key)) field.textContent = String(sf10SavedOverrides[key] ?? '');
  });
}

function sf10NormalizePeriodType(value) {
  const normalized = String(value || '').toLowerCase().trim();
  return ['three-term', 'three term', 'trimester', 'term', 'terms', 't'].includes(normalized) ? 'Three-Term' : 'Quarterly';
}

function sf10ApplyPeriodSelection(recordBlock, value) {
  if (!recordBlock) return;
  const system = sf10NormalizePeriodType(value);
  const isTerm = system === 'Three-Term';
  const periodCount = isTerm ? 3 : 4;
  recordBlock.dataset.sf10GradingSystem = system;
  recordBlock.dataset.sf10PeriodCount = String(periodCount);
  const table = recordBlock.querySelector('.grades-table');
  if (!table) return;
  const select = table.querySelector('[data-sf10-period-select]');
  if (select) select.value = system;
  const labelCell = table.querySelector('[data-sf10-period-label]');
  if (labelCell) labelCell.colSpan = periodCount;
  table.querySelectorAll('[data-sf10-period-col]').forEach((cell) => {
    const key = cell.dataset.sf10PeriodCol || '';
    const index = Number(key.replace('q', '')) || 0;
    cell.hidden = isTerm && key === 'q4';
    if (cell.tagName === 'TH') cell.textContent = (isTerm ? 'T' : 'Q') + index;
  });
  const averageCell = table.querySelector('.general-average td:first-child');
  if (averageCell) averageCell.colSpan = periodCount + 1;
}

function sf10WirePeriodSelectors() {
  document.querySelectorAll('[data-sf10-period-select]').forEach((select) => {
    if (select.dataset.sf10PeriodWired === 'true') return;
    const recordBlock = select.closest('.record-block');
    const recordKey = recordBlock?.dataset.sf10RecordKey || 'record';
    select.dataset.sf10Field = recordKey + ':period_type';
    select.dataset.sf10PeriodWired = 'true';
    select.addEventListener('change', () => sf10ApplyPeriodSelection(recordBlock, select.value));
    sf10ApplyPeriodSelection(recordBlock, select.value);
  });
}

function sf10FitPages() {
  document.querySelectorAll('.sf10-page').forEach((page) => {
    const content = page.querySelector('.sf10-page-content');
    if (!content) return;
    content.style.transform = '';
    content.style.width = '100%';
    const pageStyle = getComputedStyle(page);
    const availableWidth = page.clientWidth - parseFloat(pageStyle.paddingLeft) - parseFloat(pageStyle.paddingRight);
    const availableHeight = page.clientHeight - parseFloat(pageStyle.paddingTop) - parseFloat(pageStyle.paddingBottom);
    const scale = Math.min(1, availableWidth / Math.max(1, content.scrollWidth), availableHeight / Math.max(1, content.scrollHeight));
    content.dataset.scale = String(scale);
    if (scale < 1) { content.style.width = (100 / scale) + '%'; content.style.transform = 'scale(' + scale + ')'; }
  });
}

(function setupAutomaticPreviewFit() {
  const pageWidth = 816;
  const pageHeight = 1248;
  const apply = () => {
    const availableWidth = Math.max(280, document.documentElement.clientWidth - 16);
    const scale = Math.min(1, availableWidth / pageWidth);
    document.querySelectorAll('.sf10-preview-slot').forEach((slot) => {
      const page = slot.querySelector('.sf10-page');
      if (page) page.style.transform = 'scale(' + scale + ')';
      const label = slot.querySelector('.sf10-preview-page-label');
      const labelHeight = (label?.offsetHeight || 0) + 6;
      slot.style.width = (pageWidth * scale) + 'px';
      slot.style.height = (pageHeight * scale + labelHeight) + 'px';
    });
  };
  window.addEventListener('resize', apply);
  window.sf10ApplyReferencePreview = apply;
  window.sf10ApplyReferencePreview();
})();

window.addEventListener('load', () => {
  if (!sf10IsCurrentPreview()) return;
  sf10PrepareEditableFields();
  sf10ApplySavedOverrides();
  sf10WirePeriodSelectors();
  sf10FitPages();
  window.sf10ApplyReferencePreview?.();
});
window.addEventListener('resize', sf10FitPages);
window.addEventListener('beforeprint', sf10FitPages);
setTimeout(() => { sf10FitPages(); window.sf10ApplyReferencePreview?.(); }, 100);
})();
</script>
</body>
</html>`;
}

function sf10EmbeddedPreviewScript(previewOverridesJson, previewRenderToken) {
    return `
(function sf10PreviewScript() {
const sf10SavedOverrides = ${previewOverridesJson};
const sf10PreviewRenderToken = ${JSON.stringify(previewRenderToken)};

function sf10IsCurrentPreview() {
  try { return !window.parent || String(window.parent.sf10ActivePreviewToken || '') === sf10PreviewRenderToken; } catch (error) { return true; }
}

function sf10MarkEditable(field, key) {
  if (!field) return;
  field.dataset.sf10Field = key;
  field.contentEditable = 'true';
  field.spellcheck = false;
}

function sf10PrepareEditableFields() {
  const personalKeys = ['last_name', 'first_name', 'name_extension', 'middle_name', 'lrn', 'birthdate', 'sex'];
  document.querySelectorAll('.personal-grid span:not(.sf10-label-colon)').forEach((field, index) => sf10MarkEditable(field, 'personal:' + (personalKeys[index] || index)));
  document.querySelectorAll('.eligibility-grid span').forEach((field, index) => sf10MarkEditable(field, 'eligibility:' + index));
  document.querySelectorAll('.record-block').forEach((recordBlock) => {
    const recordKey = recordBlock.dataset.sf10RecordKey || 'record';
    const metaKeys = ['school_name', 'school_id', 'district', 'division', 'region', 'grade_level', 'section', 'school_year', 'adviser', 'signature'];
    recordBlock.querySelectorAll('.record-meta span').forEach((field, index) => sf10MarkEditable(field, recordKey + ':meta:' + (metaKeys[index] || index)));
    const rowKeys = ['subject', 'q1', 'q2', 'q3', 'q4', 'final_rating', 'remarks'];
    recordBlock.querySelectorAll('.grades-table tbody tr:not(.general-average)').forEach((row, rowIndex) => row.querySelectorAll('td').forEach((field, columnIndex) => sf10MarkEditable(field, recordKey + ':row:' + rowIndex + ':' + (rowKeys[columnIndex] || columnIndex))));
    recordBlock.querySelector('.grades-table tbody tr.general-average')?.querySelectorAll('td').forEach((field, index) => sf10MarkEditable(field, recordKey + ':general_average:' + index));
    recordBlock.querySelectorAll('.remedial-table thead span, .remedial-table tbody td').forEach((field, index) => sf10MarkEditable(field, recordKey + ':remedial:' + index));
  });
  document.querySelectorAll('.certification-section .cert-block').forEach((block, blockIndex) => {
    const keys = ['learner_name', 'lrn', 'grade', 'school_name', 'school_id', 'division', 'school_year', 'date', 'school_head'];
    block.querySelectorAll('span').forEach((field, index) => sf10MarkEditable(field, 'certification:' + blockIndex + ':' + (keys[index] || index)));
  });
  document.querySelectorAll('.cert-footer span').forEach((field, index) => sf10MarkEditable(field, 'certification:footer:' + index));
}

function sf10ApplySavedOverrides() {
  if (!sf10SavedOverrides || typeof sf10SavedOverrides !== 'object') return;
  document.querySelectorAll('[data-sf10-field]').forEach((field) => {
    const key = field.dataset.sf10Field || '';
    if (Object.prototype.hasOwnProperty.call(sf10SavedOverrides, key)) field.textContent = String(sf10SavedOverrides[key] ?? '');
  });
}

function sf10NormalizePeriodType(value) {
  const normalized = String(value || '').toLowerCase().trim();
  return ['three-term', 'three term', 'trimester', 'term', 'terms', 't'].includes(normalized) ? 'Three-Term' : 'Quarterly';
}

function sf10ApplyPeriodSelection(recordBlock, value) {
  if (!recordBlock) return;
  const system = sf10NormalizePeriodType(value);
  const isTerm = system === 'Three-Term';
  const periodCount = isTerm ? 3 : 4;
  recordBlock.dataset.sf10GradingSystem = system;
  recordBlock.dataset.sf10PeriodCount = String(periodCount);
  const table = recordBlock.querySelector('.grades-table');
  if (!table) return;
  const select = table.querySelector('[data-sf10-period-select]');
  if (select) select.value = system;
  const labelCell = table.querySelector('[data-sf10-period-label]');
  if (labelCell) labelCell.colSpan = periodCount;
  table.querySelectorAll('[data-sf10-period-col]').forEach((cell) => {
    const key = cell.dataset.sf10PeriodCol || '';
    const index = Number(key.replace('q', '')) || 0;
    cell.hidden = isTerm && key === 'q4';
    if (cell.tagName === 'TH') cell.textContent = (isTerm ? 'T' : 'Q') + index;
  });
  const averageCell = table.querySelector('.general-average td:first-child');
  if (averageCell) averageCell.colSpan = periodCount + 1;
}

function sf10WirePeriodSelectors() {
  document.querySelectorAll('[data-sf10-period-select]').forEach((select) => {
    if (select.dataset.sf10PeriodWired === 'true') return;
    const recordBlock = select.closest('.record-block');
    const recordKey = recordBlock?.dataset.sf10RecordKey || 'record';
    select.dataset.sf10Field = recordKey + ':period_type';
    select.dataset.sf10PeriodWired = 'true';
    select.addEventListener('change', () => sf10ApplyPeriodSelection(recordBlock, select.value));
    sf10ApplyPeriodSelection(recordBlock, select.value);
  });
}

function sf10FitPages() {
  document.querySelectorAll('.sf10-page').forEach((page) => {
    const content = page.querySelector('.sf10-page-content');
    if (!content) return;
    content.style.transform = '';
    content.style.width = '100%';
    const pageStyle = getComputedStyle(page);
    const availableWidth = page.clientWidth - parseFloat(pageStyle.paddingLeft) - parseFloat(pageStyle.paddingRight);
    const availableHeight = page.clientHeight - parseFloat(pageStyle.paddingTop) - parseFloat(pageStyle.paddingBottom);
    const scale = Math.min(1, availableWidth / Math.max(1, content.scrollWidth), availableHeight / Math.max(1, content.scrollHeight));
    content.dataset.scale = String(scale);
    if (scale < 1) { content.style.width = (100 / scale) + '%'; content.style.transform = 'scale(' + scale + ')'; }
  });
}

(function setupAutomaticPreviewFit() {
  const pageWidth = 816;
  const pageHeight = 1248;
  const apply = () => {
    const availableWidth = Math.max(280, document.documentElement.clientWidth - 16);
    const scale = Math.min(1, availableWidth / pageWidth);
    document.querySelectorAll('.sf10-preview-slot').forEach((slot) => {
      const page = slot.querySelector('.sf10-page');
      if (page) page.style.transform = 'scale(' + scale + ')';
      const label = slot.querySelector('.sf10-preview-page-label');
      const labelHeight = (label?.offsetHeight || 0) + 6;
      slot.style.width = (pageWidth * scale) + 'px';
      slot.style.height = (pageHeight * scale + labelHeight) + 'px';
    });
  };
  window.addEventListener('resize', apply);
  window.sf10ApplyReferencePreview = apply;
  window.sf10ApplyReferencePreview();
})();

window.addEventListener('load', () => {
  if (!sf10IsCurrentPreview()) return;
  sf10PrepareEditableFields();
  sf10ApplySavedOverrides();
  sf10WirePeriodSelectors();
  sf10FitPages();
  window.sf10ApplyReferencePreview?.();
});
window.addEventListener('resize', sf10FitPages);
window.addEventListener('beforeprint', sf10FitPages);
setTimeout(() => { sf10FitPages(); window.sf10ApplyReferencePreview?.(); }, 100);
})();
`;
}

function sf10BuildElementaryPrintHtml(data, renderToken = 0) {
    const learner = data?.learner || {};
    const form = sf10FormMeta(data);
    const previewRenderToken = String(Number(renderToken || 0) || 0);
    const previewOverrides = data?.preview_overrides?.fields && typeof data.preview_overrides.fields === 'object'
        ? data.preview_overrides.fields
        : {};
    const previewOverridesJson = JSON.stringify(previewOverrides)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
    const leftLogoUrl = sf10AssetUrl('assets/img/logo/Seal_of_the_Department_of_Education_of_the_Philippines.png');
    const rightLogoUrl = sf10AssetUrl('assets/img/logo/logo.png');
    const records = sf10CompleteTemplateRecords(data).map((record) => {
        const periodOverride = sf10PreviewPeriodOverride(previewOverrides, record);
        return periodOverride
            ? { ...record, grading_system_type: periodOverride, grading_system: periodOverride }
            : record;
    });
    while (records.length < 8) records.push(sf10ElementaryBlankSlotRecord(records.length + 1));
    const frontRecords = records.slice(0, 4);
    const backRecords = records.slice(4);
    const backChunks = [];
    for (let index = 0; index < backRecords.length; index += 4) backChunks.push(backRecords.slice(index, index + 4));
    if (!backChunks.length) backChunks.push([]);
    const totalPages = 1 + backChunks.length;
    const pageLabel = (pageNumber, side) => pageNumber === 1
        ? 'Page 1 – Front · 8.5 × 13 in'
        : `Page ${pageNumber} – ${side === 'front' ? 'Front' : 'Back'}${pageNumber > 2 ? ' continuation' : ''} · 8.5 × 13 in`;
    const buildPage = (pageNumber, side, pageRecords, includeFrontMatter, includeCertification) => `
        <div class="sf10-preview-slot" data-s="${side}">
            <p class="sf10-preview-page-label">${pageLabel(pageNumber, side)}</p>
            <section class="sf10-page sf10-es-page">
                <div class="sf10-page-content">
                    <div class="sf10-es-page-code">${pageNumber > 1 ? `<span>${sf10Escape(form.code)}</span><span>Page ${pageNumber} of ${totalPages}</span>` : ''}</div>
                    ${includeFrontMatter ? `
                        <header class="sf10-es-header">
                            <div class="sf10-es-header-code">${sf10Escape(form.code)}</div>
                            <img class="sf10-es-seal" src="${sf10Escape(leftLogoUrl)}" alt="DepEd Seal">
                            <div class="sf10-es-header-copy">
                                <p>Republic of the Philippines</p>
                                <p class="sf10-es-header-title">Department of Education</p>
                                <p class="sf10-es-header-title">${sf10Escape(form.title)}</p>
                                <p>(Formerly Form 137)</p>
                            </div>
                            <img class="sf10-es-seal" src="${sf10Escape(rightLogoUrl)}" alt="School Logo">
                            <div class="sf10-es-header-spacer" aria-hidden="true"></div>
                        </header>
                        <div class="sf10-es-section">LEARNER'S PERSONAL INFORMATION</div>
                        <div class="personal-grid sf10-es-personal-grid">
                            <div>LAST NAME: <span>${sf10Escape(learner.last_name || '')}</span></div>
                            <div>FIRST NAME: <span>${sf10Escape(learner.first_name || '')}</span></div>
                            <div>NAME EXTN. (Jr,I,II): <span>${sf10Escape(learner.name_extension || '')}</span></div>
                            <div>MIDDLE NAME: <span>${sf10Escape(learner.middle_name || '')}</span></div>
                            <div class="personal-lrn-row">
                                <div class="personal-lrn-field">Learner Reference Number (LRN): <span>${sf10Escape(learner.lrn || '')}</span></div>
                                <div>Birthdate (mm/dd/yyyy): <span>${sf10Escape(learner.date_of_birth || '')}</span></div>
                                <div>Sex: <span>${sf10Escape(learner.sex || learner.gender || '')}</span></div>
                            </div>
                        </div>
                        ${sf10BuildElementaryEligibilitySection()}
                    ` : ''}
                    <div class="sf10-es-section">SCHOLASTIC RECORD</div>
                    <div class="sf10-es-record-grid">${pageRecords.map(sf10ElementaryRecordBlock).join('')}</div>
                    ${includeCertification ? sf10CertificationSection(data) : ''}
                    <div class="sf10-es-foot"><span></span><span>Revised 2025 based on DepEd Order No. 10, s. 2024</span><span></span></div>
                </div>
            </section>
        </div>`;
    const pages = [buildPage(1, 'front', frontRecords, true, false)];
    backChunks.forEach((chunk, index) => pages.push(buildPage(index + 2, 'back', chunk, false, index === backChunks.length - 1)));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>SF10-ES - ${sf10Escape(learner.full_name || '')}</title>
<style>
:root { box-sizing: border-box; --preview-bg: #e9ebee; --preview-fg: #1c2430; --preview-muted: #667085; }
html { scroll-padding-top: env(safe-area-inset-top, 0px); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--preview-bg); color: var(--preview-fg); font: 14px system-ui, sans-serif; }
.sf10-preview-stage { display: flex; flex-direction: column; align-items: center; gap: 20px; overflow-x: auto; padding: 16px; }
.sf10-preview-slot { position: relative; flex: none; }
.sf10-preview-page-label { display: flex; justify-content: space-between; margin: 0 0 4px; padding-bottom: 2px; border-bottom: 2px solid var(--preview-muted); color: var(--preview-muted); font-size: 12px; }
.sf10-page { position: relative; width: 8.5in; height: 13in; margin: 0 auto; overflow: hidden; padding: .3in .35in .2in; background: #fff; color: #000; box-shadow: 0 2px 14px rgba(0, 0, 0, .35); break-after: page; page-break-after: always; font: 7pt/1.15 Arial, Helvetica, sans-serif; }
.sf10-page-content { position: relative; z-index: 1; width: 100%; transform-origin: top left; }
.sf10-es-page * { color: #000; }
.sf10-es-page-code { display: flex; justify-content: space-between; min-height: 1px; font-size: 8pt; font-weight: 700; }
.sf10-es-header { display: flex; height: .85in; align-items: center; justify-content: space-between; gap: 8px; }
.sf10-es-header-code { width: 1in; font-size: 9pt; font-weight: 700; }
.sf10-es-header-copy { flex: 1; text-align: center; }
.sf10-es-header-copy p { margin: 0; }
.sf10-es-header-title { font-size: 9.5pt; font-weight: 700; }
.sf10-es-seal { width: .6in; height: .6in; border: 1px solid #000; border-radius: 50%; object-fit: contain; }
.sf10-es-header-spacer { width: .4in; }
.sf10-es-section { margin-top: 4px; padding: 1.5px 0; border: 0; border-bottom: 1px solid #000; background: transparent; color: #000 !important; font-size: 7.5pt; font-weight: 700; letter-spacing: .2px; text-align: center; }
.sf10-es-personal-grid { display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-end; margin: 3px 0; font-size: 6.5pt; }
.sf10-es-personal-grid > div { display: flex; min-width: 0; flex: 1 1 0; align-items: flex-end; gap: 3px; }
.sf10-es-personal-grid .personal-lrn-row { flex-basis: 100%; display: flex; gap: 6px; }
.sf10-es-personal-grid span, .sf10-es-eligibility span, .sf10-es-page .record-meta span, .sf10-es-page .cert-block span { display: inline-block; min-width: 42px; min-height: 11px; flex: 1 1 auto; padding: 0 2px; border-bottom: 1px solid #000; font-weight: 700; }
.sf10-es-personal-grid .personal-lrn-field span { flex-basis: 50%; }
.sf10-es-eligibility { display: grid; grid-template-columns: 1.15fr .72fr 1.35fr .75fr; gap: 3px 6px; margin: 3px 0; font-size: 6.3pt; }
.sf10-es-eligibility-line { display: flex; min-width: 0; align-items: flex-end; gap: 3px; white-space: nowrap; }
.sf10-es-eligibility-credential, .sf10-es-eligibility-other, .sf10-es-eligibility-full { grid-column: 1 / -1; }
.sf10-es-eligibility-address, .sf10-es-eligibility-wide { grid-column: span 2; }
.sf10-es-eligibility span { min-width: 0; min-height: 10px; }
.sf10-es-eligibility-credential span { flex: 0 0 auto; border-bottom: 0; font-weight: 400; }
.sf10-es-eligibility-other { padding-top: 1px; }
.sf10-es-record-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.sf10-es-page .record-block { min-width: 0; padding: 2px 3px; border: 1px solid #000; break-inside: avoid; page-break-inside: avoid; }
.sf10-es-page .record-meta { display: grid; gap: 1px; margin-bottom: 1px; padding: 0; border: 0; font-size: 6.1pt; line-height: 1.1; }
.sf10-es-page .record-meta-row { display: grid; gap: 4px; min-height: 11px; align-items: end; }
.sf10-es-page .record-meta-row > div { display: flex; min-width: 0; align-items: flex-end; gap: 2px; white-space: nowrap; }
.sf10-es-page .record-meta-row span { width: auto; height: 10px; min-width: 0; flex: 1 1 auto; overflow: hidden; padding: 0 1px; text-overflow: ellipsis; }
.sf10-es-page .record-meta .row-school { grid-template-columns: 1fr .55fr; }
.sf10-es-page .record-meta .row-location { grid-template-columns: .9fr 1.4fr .55fr; }
.sf10-es-page .record-meta .row-class { grid-template-columns: .9fr .9fr .65fr; }
.sf10-es-page .record-meta .row-adviser { grid-template-columns: 1.35fr .65fr; }
.sf10-es-page table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.sf10-es-page th, .sf10-es-page td { height: 12.2px; overflow: hidden; padding: 0 2px; border: 1px solid #000; font-size: 6.3pt; line-height: 1.05; white-space: nowrap; }
.sf10-es-page th { background: #fff; font-weight: 700; text-align: center; }
.sf10-es-page td.learning-area, .sf10-es-page th.learning-area { text-align: left; }
.sf10-es-page td.learning-area.mapeh-component { padding-left: 10px; }
.sf10-es-page td.general-average-label { text-align: left; }
.sf10-es-page .general-average td { font-weight: 700; }
.sf10-es-page .grades-table th:not(.learning-area), .sf10-es-page .grades-table td:not(.learning-area) { width: 8%; }
.sf10-es-page .grades-table th[data-sf10-period-label][colspan="3"] { width: 24% !important; }
.sf10-es-page .grades-table th[data-sf10-period-label][colspan="4"] { width: 32% !important; }
.sf10-es-page .grades-table th.final-grade, .sf10-es-page .grades-table td.final-grade { width: 12%; }
.sf10-es-page .grades-table th.remarks, .sf10-es-page .grades-table td.remarks { width: 16%; }
.sf10-es-page .remedial-table { margin-top: 2px; }
.sf10-es-page .remedial-table th, .sf10-es-page .remedial-table td { font-size: 6pt; }
.sf10-es-page .remedial-table th:first-child, .sf10-es-page .remedial-table td:first-child { text-align: left; }
.sf10-es-page .remedial-table span { float: right; font-weight: 400; }
.sf10-period-type-select { display: block; width: 100%; min-width: 0; height: 1.15em; padding: 0 2px; border: 0; background: transparent; color: inherit; font: inherit; font-weight: inherit; text-align: center; text-align-last: center; cursor: pointer; }
.sf10-period-type-select:hover, .sf10-period-type-select:focus { outline: 1px solid #6b7280; outline-offset: -1px; background: rgba(107, 114, 128, .13); }
.sf10-es-page .certification-section { margin-top: 5px; break-inside: avoid; page-break-inside: avoid; }
.sf10-es-page .transfer-title { margin: 5px 0 2px; padding: 1.5px 4px; border: 0; border-bottom: 1px solid #000; background: transparent; color: #000 !important; font-size: 6.4pt; font-weight: 700; text-align: left; }
.sf10-es-page .cert-block { margin: 3px 10px; padding: 3px 5px; border: 1px solid #000; font-size: 6.1pt; line-height: 1.1; break-inside: avoid; page-break-inside: avoid; }
.sf10-es-page .cert-block h3 { margin: 0 0 2px; font-size: 7.5pt; text-align: center; }
.sf10-es-page .cert-block p { margin: 1px 0; }
.sf10-es-page .cert-block span { min-height: 9px; }
.sf10-es-page .cert-signatures { gap: 6px; margin-top: 4px; }
.sf10-es-page .cert-signatures span { min-height: 10px; }
.sf10-es-page .cert-signatures label { margin-top: 1px; font-size: 5.3pt; }
.sf10-es-page .seal-box { min-height: 27px; padding: 2px; font-size: 5.5pt; }
.sf10-es-page .cert-footer { margin: 2px 10px 0; font-size: 5.5pt; }
.sf10-es-foot { position: absolute; right: .35in; bottom: .12in; left: .35in; display: flex; justify-content: space-between; font-size: 6pt; }
@media screen { [contenteditable="true"] { outline: none; } [contenteditable="true"]:hover { background: rgba(229, 231, 235, .75); } [contenteditable="true"]:focus { outline: 1px solid #6b7280; outline-offset: -1px; background: rgba(229, 231, 235, .55); } }
@media print {
    @page { size: 8.5in 13in; margin: 0; }
    html, body { width: 8.5in; background: #fff; }
    .sf10-preview-page-label { display: none !important; }
    .sf10-preview-stage { display: block; gap: 0; overflow: visible; padding: 0; }
    .sf10-preview-slot { width: 8.5in !important; height: 13in !important; break-after: page; page-break-after: always; }
    .sf10-preview-slot:last-child { break-after: auto; page-break-after: auto; }
    .sf10-page { width: 8.5in; height: 13in; margin: 0; box-shadow: none; }
    .sf10-period-type-select { appearance: none; -webkit-appearance: none; pointer-events: none; background: transparent !important; box-shadow: none !important; color: #000; }
}
</style>
</head>
<body data-sf10-preview-token="${sf10Escape(previewRenderToken)}">
    <div class="sf10-preview-stage" id="sf10PreviewStage">${pages.join('')}</div>
<script>${sf10EmbeddedPreviewScript(previewOverridesJson, previewRenderToken)}</script>
</body>
</html>`;
}

function sf10BuildPrintHtml(data, renderToken = 0) {
    if (sf10FormMeta(data).level === 'jhs') return sf10BuildJhsPrintHtml(data, renderToken);
    if (sf10FormMeta(data).level === 'elementary') return sf10BuildElementaryPrintHtml(data, renderToken);
    const learner = data?.learner || {};
    const form = sf10FormMeta(data);
    const previewRenderToken = String(Number(renderToken || 0) || 0);
    const previewOverrides = data?.preview_overrides?.fields && typeof data.preview_overrides.fields === 'object'
        ? data.preview_overrides.fields
        : {};
    const records = sf10CompleteTemplateRecords(data).map((record) => {
        const periodOverride = sf10PreviewPeriodOverride(previewOverrides, record);
        return periodOverride
            ? { ...record, grading_system_type: periodOverride, grading_system: periodOverride }
            : record;
    });
    const previewOverridesJson = JSON.stringify(previewOverrides)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
    const pages = [];
    const frontRecords = records.slice(0, 4);
    const restRecords = records.slice(4);
    const canAttachCertificationToFirstPage = records.length <= 4;
    const canAttachCertificationToLastRecordPage = records.length > 4 && (restRecords.length % 4) > 0 && (restRecords.length % 4) <= 2;
    const shouldAppendCertificationPage = !canAttachCertificationToFirstPage && !canAttachCertificationToLastRecordPage;
    const leftLogoUrl = sf10AssetUrl('assets/img/logo/logo.png');
    const rightLogoUrl = sf10AssetUrl('assets/img/logo/Seal_of_the_Department_of_Education_of_the_Philippines.png');
    const eligibilitySection = form.level === 'elementary' ? `
                <h2>ELIGIBILITY FOR ELEMENTARY SCHOOL ENROLMENT</h2>
                <div class="eligibility-grid">
                    <div class="eligibility-grade1-box">
                        <div class="eligibility-credential">
                            <label>Credential Presented for Grade 1:</label>
                        </div>
                        <div class="eligibility-school-fields">
                            <div>Name of School: <span></span></div>
                            <div>School ID: <span></span></div>
                            <div>Address of School: <span></span></div>
                        </div>
                    </div>
                    <div class="eligibility-other-block">
                        <div class="eligibility-other-title">Other Credential Presented</div>
                        <div class="eligibility-pept-row">
                            <div class="checkline">PEPT Passer</div>
                            <div>Rating: <span></span></div>
                            <div>Date of Examination/Assessment (mm/dd/yyyy): <span></span></div>
                            <div>Others (Pls. Specify): <span></span></div>
                        </div>
                        <div class="eligibility-testing-row">
                            <div>Name and Address of Testing Center: <span></span></div>
                            <div>Remark: <span></span></div>
                        </div>
                    </div>
                </div>` : '';

    pages.push(`
        <section class="sf10-page">
            <div class="sf10-page-content">
                <div class="page-code">${sf10Escape(form.code)}</div>
                <header class="sf10-header">
                    <img class="sf10-logo sf10-logo-left" src="${sf10Escape(leftLogoUrl)}" alt="School Logo">
                    <div class="sf10-header-text">
                        <div>Republic of the Philippines</div>
                        <div>Department of Education</div>
                        <h1>${sf10Escape(form.title)}</h1>
                        <div>(Formerly Form 137)</div>
                    </div>
                    <img class="sf10-logo sf10-logo-right" src="${sf10Escape(rightLogoUrl)}" alt="DepEd Logo">
                </header>
                <h2>LEARNER'S PERSONAL INFORMATION</h2>
                <div class="personal-grid">
                    <div>LAST NAME: <span>${sf10Escape(learner.last_name || '')}</span></div>
                    <div>FIRST NAME: <span>${sf10Escape(learner.first_name || '')}</span></div>
                    <div>NAME EXTN. (Jr,I,II)<span class="sf10-label-colon">:</span> <span>${sf10Escape(learner.name_extension || '')}</span></div>
                    <div>MIDDLE NAME: <span>${sf10Escape(learner.middle_name || '')}</span></div>
                    <div class="personal-lrn-row">
                        <div class="personal-lrn-field">Learner Reference Number (LRN): <span>${sf10Escape(learner.lrn || '')}</span></div>
                        <div>Birthdate (mm/dd/yyyy): <span>${sf10Escape(learner.date_of_birth || '')}</span></div>
                        <div>Sex: <span>${sf10Escape(learner.sex || learner.gender || '')}</span></div>
                    </div>
                </div>
                ${eligibilitySection}
                <h2>SCHOLASTIC RECORD</h2>
                <div class="record-grid">${frontRecords.map(sf10RecordBlock).join('') || sf10RecordBlock(null, 0)}</div>
                ${canAttachCertificationToFirstPage ? sf10CertificationSection(data) : ''}
            </div>
        </section>
    `);

    for (let i = 0; i < restRecords.length; i += 4) {
        const chunk = restRecords.slice(i, i + 4);
        const isLastRecordPage = i + 4 >= restRecords.length;
        pages.push(`
            <section class="sf10-page">
                <div class="sf10-page-content">
                    <div class="page-code">${sf10Escape(form.code)} <span>Page ${pages.length + 1}</span></div>
                    <h2>SCHOLASTIC RECORD</h2>
                    <div class="record-grid">${chunk.map(sf10RecordBlock).join('')}</div>
                    ${canAttachCertificationToLastRecordPage && isLastRecordPage ? sf10CertificationSection(data) : ''}
                </div>
            </section>
        `);
    }

    if (shouldAppendCertificationPage) {
        pages.push(sf10CertificationPage(data, pages.length + 1));
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>SF10 - ${sf10Escape(learner.full_name || '')}</title>
<style>
	@page { size: 8.5in 14in; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; background: #7b8794; font-family: Arial, Helvetica, sans-serif; color: #000; }
.toolbar { position: sticky; top: 0; z-index: 10; display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 14px; background: #1f2937; color: #fff; }
.toolbar strong { font-size: 13px; }
.toolbar-note { margin-left: 10px; font-size: 10px; font-weight: 400; opacity: .78; }
.toolbar button { border: 0; border-radius: 6px; padding: 7px 12px; font-weight: 700; background: #2563eb; color: #fff; cursor: pointer; }

@media screen {
  [contenteditable="true"] { outline: none; }
  [contenteditable="true"]:hover { background: rgba(255, 235, 120, .35); }
  [contenteditable="true"]:focus { background: rgba(120, 190, 255, .25); outline: 1px solid #6b9fd3; outline-offset: -1px; }
}
	:root { --sf10-page-width: 8.5in; --sf10-page-height: 14in; --sf10-border-inset: .22in; }
	.sf10-page { position: relative; width: var(--sf10-page-width); height: var(--sf10-page-height); margin: 16px auto; padding: .28in .31in .31in; background: #fff; break-after: page; page-break-after: always; overflow: hidden; }
.sf10-page:before { content: ""; position: absolute; inset: var(--sf10-border-inset); border: 1px solid #000; pointer-events: none; }
.sf10-page:last-child { page-break-after: auto; }
.sf10-page-content { position: relative; z-index: 1; width: 100%; transform-origin: top left; }
.page-code { display: flex; justify-content: space-between; font-size: 9px; font-weight: 700; margin-bottom: 3px; }
.sf10-header { position: relative; min-height: .58in; text-align: center; font-size: 10px; line-height: 1.18; margin-bottom: 4px; padding: 0 .78in; display: flex; align-items: center; justify-content: center; }
.sf10-header-text { width: 100%; }
.sf10-header h1 { margin: 3px 0 0; font-size: 13px; }
.sf10-logo { position: absolute; top: 0; width: .55in; height: .55in; object-fit: contain; }
.sf10-logo-left { left: 0; }
.sf10-logo-right { right: 0; }
h2 { background: #d9d9d9; border: 1px solid #000; margin: 4px 0 3px; padding: 2px 4px; font-size: 10px; text-align: center; }
.compact-title { text-align: center; margin-top: 18px; }
	.certification-section { break-inside: avoid; page-break-inside: avoid; margin-top: 8px; }
	.sf10-cert-page .certification-section { margin-top: 22px; }
	.transfer-title { margin: 8px 0 4px; font-size: 9.6px; font-weight: 700; text-align: left; }
.personal-grid { display: grid; grid-template-columns: 1fr 1fr .65fr 1fr; gap: 2px 8px; font-size: 9px; margin-bottom: 4px; }
.sf10-label-colon { border-bottom: 0 !important; min-width: 0 !important; padding: 0 !important; font-weight: 400 !important; }
.personal-lrn-row { grid-column: span 4; display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(0, 1.05fr) minmax(0, .42fr); gap: 8px; align-items: end; }
.personal-lrn-row div { display: flex; align-items: flex-end; gap: 4px; white-space: nowrap; min-width: 0; }
	.personal-grid span, .eligibility-grid span, .record-meta span, .cert-block span { display: inline-block; min-width: 42px; border-bottom: 1px solid #000; font-weight: 700; padding: 0 2px; }
.personal-grid .personal-lrn-row span { min-width: 0; width: 100%; height: 1em; line-height: 1; padding: 0; }
.personal-grid .personal-lrn-field span { flex: 0 0 50%; width: 50%; }
.eligibility-grid { display: grid; grid-template-columns: 1.25fr .8fr .75fr 1.35fr; gap: 2px 7px; font-size: 8.5px; margin-bottom: 5px; }
.eligibility-grade1-box { grid-column: span 4; border: 1px solid #000; padding: 4px 6px; display: grid; gap: 4px; }
.eligibility-credential { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.eligibility-credential label { white-space: nowrap; font-weight: 700; }
.credential-checks { flex: 1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; }
.credential-checks .checkline { border-bottom: 0; font-weight: 400; padding: 0; white-space: nowrap; }
.eligibility-school-fields { display: flex; gap: 8px; align-items: center; flex-wrap: nowrap; width: 100%; }
.eligibility-school-fields div { display: flex; align-items: flex-end; gap: 4px; white-space: nowrap; min-width: 0; }
.eligibility-school-fields div:nth-child(1) { flex: 1.45 1 0; }
.eligibility-school-fields div:nth-child(2) { flex: .72 1 0; }
.eligibility-school-fields div:nth-child(3) { flex: 1.55 1 0; }
.eligibility-school-fields span { min-width: 0; width: 100%; height: 1em; line-height: 1; padding: 0; }
.eligibility-other-block { grid-column: span 4; display: grid; gap: 3px; padding-top: 1px; }
.eligibility-other-title { display: flex; align-items: flex-end; gap: 5px; white-space: nowrap; }
.eligibility-pept-row { display: grid; grid-template-columns: .75fr .62fr 2fr 1.35fr; gap: 8px; align-items: end; }
.eligibility-testing-row { display: grid; grid-template-columns: 1.65fr 1fr; gap: 12px; align-items: end; }
.eligibility-pept-row div, .eligibility-testing-row div { display: flex; align-items: flex-end; gap: 4px; white-space: nowrap; min-width: 0; }
.eligibility-other-block span { min-width: 0; width: 100%; height: 1em; line-height: 1; padding: 0; }
.checkline:before { content: "□ "; font-weight: 700; }
.record-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 8px; }
.record-block { break-inside: avoid; }
.record-meta {
  display: grid;
  gap: 1px;
  font-size: 7.5px;
  line-height: 1.18;
  margin-bottom: -1px;
  border: 1px solid #000;
  padding: 2px 4px 3px;
}
.record-meta-row { display: grid; gap: 5px; align-items: end; min-height: 12px; }
.record-meta-row > div { display: flex; align-items: flex-end; gap: 3px; white-space: nowrap; min-width: 0; }
.record-meta-row span {
  display: inline-block;
  flex: 1 1 auto;
  min-width: 0;
  height: 1em;
  line-height: 1;
  border-bottom: 1px solid #000;
  font-weight: 700;
  padding: 0 2px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.record-meta .row-school { grid-template-columns: minmax(0, 1.45fr) minmax(0, .52fr); }
.record-meta .row-location { grid-template-columns: minmax(0, .9fr) minmax(0, 1.42fr) minmax(0, .52fr); }
.record-meta .row-class { grid-template-columns: minmax(0, .9fr) minmax(0, .9fr) minmax(0, .65fr); }
.record-meta .row-adviser { grid-template-columns: minmax(0, 1.35fr) minmax(0, .65fr); }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { border: 1px solid #000; padding: 1px 2px; text-align: center; vertical-align: middle; font-size: 7.2px; line-height: 1.05; height: 13px; }
th { background: #e8e8e8; font-weight: 700; }
.learning-area { text-align: left; width: 38%; }
.learning-area.mapeh-parent { font-weight: 700; }
.learning-area.mapeh-component { padding-left: 12px; font-style: italic; }
.grades-table th:not(.learning-area), .grades-table td:not(.learning-area) { width: 10.3%; }
.grades-table th[data-sf10-period-label][colspan="3"] { width: 30.9% !important; }
.grades-table th[data-sf10-period-label][colspan="4"] { width: 41.2% !important; }
.grades-table .final-grade,
.grades-table .remarks,
.grades-table .general-average td:not(.general-average-label) { text-align: center; }
.grades-table .general-average-label { text-align: left; }
.general-average td { font-weight: 700; }
.remedial-table th,
.remedial-table td { text-align: center; }
.remedial-table th:first-child,
.remedial-table td:first-child { text-align: left; }
.sf10-period-type-select {
  display: block;
  width: 100%;
  min-width: 0;
  height: 1.15em;
  border: 0;
  border-radius: 3px;
  padding: 0 2px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: inherit;
  text-align: center;
  text-align-last: center;
  cursor: pointer;
}
.sf10-period-type-select:hover,
.sf10-period-type-select:focus {
  background: rgba(255, 235, 120, .45);
  outline: 1px solid #6b9fd3;
  outline-offset: -1px;
}
.remedial-table { margin-top: 2px; }
.remedial-table th { font-size: 6.6px; }
.remedial-table span { float: right; font-weight: 400; }
	.cert-block { border: 1px solid #000; padding: 5px 8px 6px; margin: 5px 18px; font-size: 8.9px; line-height: 1.3; break-inside: avoid; page-break-inside: avoid; }
	.cert-block h3 { margin: 0 0 3px; text-align: center; font-size: 10px; line-height: 1.1; }
	.cert-block p { margin: 2px 0; }
	.cert-block .cert-learner-name { min-width: 2.3in; }
	.cert-block .cert-lrn { min-width: 1.05in; }
	.cert-block .cert-grade-field { min-width: .72in; }
	.cert-block .cert-school-name { min-width: 1.55in; }
	.cert-block .cert-school-id { min-width: .75in; }
	.cert-block .cert-division { min-width: 1.05in; }
	.cert-block .cert-year { min-width: 1.35in; }
	.cert-signatures { display: grid; grid-template-columns: 1.15fr 2.75fr 1.08fr; gap: 14px; align-items: end; margin-top: 8px; text-align: center; }
	.cert-signatures span { display: block; min-height: 15px; border-bottom: 1px solid #000; }
	.cert-signatures label { display: block; font-size: 7.5px; margin-top: 2px; line-height: 1.1; }
	.seal-box { min-height: 42px; border: 1px solid #000; display: flex; align-items: center; justify-content: center; font-size: 8px; padding: 3px; }
	.cert-footer { display: flex; justify-content: space-between; gap: 8px; margin: 4px 18px 0; font-size: 8px; line-height: 1.1; }
@media print {
  html, body { width: 8.5in; }
  body { background: #fff; }
  .toolbar { display: none; }
  .sf10-page { margin: 0; width: var(--sf10-page-width); height: var(--sf10-page-height); box-shadow: none; break-after: page; page-break-after: always; page-break-inside: avoid; }
  .sf10-page:last-child { break-after: auto; page-break-after: auto; }
  .sf10-period-type-select { appearance: none; -webkit-appearance: none; pointer-events: none; background: transparent; }
}
</style>
</head>
<body data-sf10-preview-token="${sf10Escape(previewRenderToken)}">
	<div class="toolbar"><strong>${sf10Escape(form.code)} Legal Preview <span class="toolbar-note">Click fields to edit; use Save Preview Edits to retain manual fields for this learner.</span></strong><button onclick="window.print()">Print / Save PDF</button></div>
${pages.join('')}
<script>
(function sf10PreviewScript() {
const sf10SavedOverrides = ${previewOverridesJson};
const sf10PreviewRenderToken = ${JSON.stringify(previewRenderToken)};

function sf10IsCurrentPreview() {
  try {
    return !window.parent || String(window.parent.sf10ActivePreviewToken || '') === sf10PreviewRenderToken;
  } catch (error) {
    return true;
  }
}

function sf10MarkEditable(field, key) {
  if (!field) return;
  field.dataset.sf10Field = key;
  field.contentEditable = 'true';
  field.spellcheck = false;
}

function sf10PrepareEditableFields() {
  const personalKeys = ['last_name', 'first_name', 'name_extension', 'middle_name', 'lrn', 'birthdate', 'sex'];
  document.querySelectorAll('.personal-grid span:not(.sf10-label-colon)').forEach((field, index) => {
    sf10MarkEditable(field, 'personal:' + (personalKeys[index] || index));
  });
  document.querySelectorAll('.eligibility-grid span').forEach((field, index) => {
    sf10MarkEditable(field, 'eligibility:' + index);
  });

  document.querySelectorAll('.record-block').forEach((recordBlock) => {
    const recordKey = recordBlock.dataset.sf10RecordKey || 'record';
    const metaKeys = ['school_name', 'school_id', 'district', 'division', 'region', 'grade_level', 'section', 'school_year', 'adviser', 'signature'];
    recordBlock.querySelectorAll('.record-meta span').forEach((field, index) => {
      sf10MarkEditable(field, recordKey + ':meta:' + (metaKeys[index] || index));
    });
    const rowKeys = ['subject', 'q1', 'q2', 'q3', 'q4', 'final_rating', 'remarks'];
    recordBlock.querySelectorAll('.grades-table tbody tr:not(.general-average)').forEach((row, rowIndex) => {
      row.querySelectorAll('td').forEach((field, columnIndex) => {
        sf10MarkEditable(field, recordKey + ':row:' + rowIndex + ':' + (rowKeys[columnIndex] || columnIndex));
      });
    });
    const averageRow = recordBlock.querySelector('.grades-table tbody tr.general-average');
    averageRow?.querySelectorAll('td').forEach((field, index) => {
      sf10MarkEditable(field, recordKey + ':general_average:' + index);
    });
    recordBlock.querySelectorAll('.remedial-table thead span, .remedial-table tbody td').forEach((field, index) => {
      sf10MarkEditable(field, recordKey + ':remedial:' + index);
    });
  });

  document.querySelectorAll('.certification-section .cert-block').forEach((block, blockIndex) => {
    const keys = ['learner_name', 'lrn', 'grade', 'school_name', 'school_id', 'division', 'school_year', 'date', 'school_head'];
    block.querySelectorAll('span').forEach((field, index) => {
      sf10MarkEditable(field, 'certification:' + blockIndex + ':' + (keys[index] || index));
    });
  });
  document.querySelectorAll('.cert-footer span').forEach((field, index) => {
    sf10MarkEditable(field, 'certification:footer:' + index);
  });
}

function sf10ApplySavedOverrides() {
  if (!sf10SavedOverrides || typeof sf10SavedOverrides !== 'object') return;
  document.querySelectorAll('[data-sf10-field]').forEach((field) => {
    const key = field.dataset.sf10Field || '';
    if (Object.prototype.hasOwnProperty.call(sf10SavedOverrides, key)) {
      field.textContent = String(sf10SavedOverrides[key] ?? '');
    }
  });
}

function sf10NormalizePeriodType(value) {
  const normalized = String(value || '').toLowerCase().trim();
  return ['three-term', 'three term', 'trimester', 'term', 'terms', 't'].includes(normalized) ? 'Three-Term' : 'Quarterly';
}

function sf10ApplyPeriodSelection(recordBlock, value) {
  if (!recordBlock) return;
  const system = sf10NormalizePeriodType(value);
  const isTerm = system === 'Three-Term';
  const periodCount = isTerm ? 3 : 4;
  recordBlock.dataset.sf10GradingSystem = system;
  recordBlock.dataset.sf10PeriodCount = String(periodCount);

  const table = recordBlock.querySelector('.grades-table');
  if (!table) return;
  const select = table.querySelector('[data-sf10-period-select]');
  if (select) select.value = system;
  const labelCell = table.querySelector('[data-sf10-period-label]');
  if (labelCell) labelCell.colSpan = periodCount;
  table.querySelectorAll('[data-sf10-period-col]').forEach((cell) => {
    const key = cell.dataset.sf10PeriodCol || '';
    const index = Number(key.replace('q', '')) || 0;
    cell.hidden = isTerm && key === 'q4';
    if (cell.tagName === 'TH') {
      cell.textContent = (isTerm ? 'T' : 'Q') + index;
    }
  });
  const averageCell = table.querySelector('.general-average td:first-child');
  if (averageCell) averageCell.colSpan = periodCount + 1;
  sf10FitPages();
}

function sf10WirePeriodSelectors() {
  document.querySelectorAll('[data-sf10-period-select]').forEach((select) => {
    if (select.dataset.sf10PeriodWired === 'true') return;
    const recordBlock = select.closest('.record-block');
    const recordKey = recordBlock?.dataset.sf10RecordKey || 'record';
    select.dataset.sf10Field = recordKey + ':period_type';
    select.dataset.sf10PeriodWired = 'true';
    select.addEventListener('change', () => sf10ApplyPeriodSelection(recordBlock, select.value));
    sf10ApplyPeriodSelection(recordBlock, select.value);
  });
}

function sf10FitPages() {
  document.querySelectorAll('.sf10-page').forEach((page) => {
    const content = page.querySelector('.sf10-page-content');
    if (!content) return;
    content.style.transform = '';
    content.style.width = '100%';
    const pageStyle = getComputedStyle(page);
    const availableWidth = page.clientWidth - parseFloat(pageStyle.paddingLeft) - parseFloat(pageStyle.paddingRight);
    const availableHeight = page.clientHeight - parseFloat(pageStyle.paddingTop) - parseFloat(pageStyle.paddingBottom);
    const contentWidth = content.scrollWidth;
    const contentHeight = content.scrollHeight;
    const scale = Math.min(1, availableWidth / Math.max(1, contentWidth), availableHeight / Math.max(1, contentHeight));
    content.dataset.scale = String(scale);
    if (scale < 1) {
      content.style.width = (100 / scale) + '%';
      content.style.transform = 'scale(' + scale + ')';
    }
  });
}
window.addEventListener('load', () => {
  if (!sf10IsCurrentPreview()) return;
  sf10PrepareEditableFields();
  sf10ApplySavedOverrides();
  sf10WirePeriodSelectors();
  sf10FitPages();
});
window.addEventListener('resize', sf10FitPages);
window.addEventListener('beforeprint', sf10FitPages);
setTimeout(sf10FitPages, 100);
})();
</script>
</body>
</html>`;
}

function sf10ApplyParentPreviewOverrides(fields, renderToken) {
    const frame = document.getElementById('sf10Frame');
    const doc = frame?.contentDocument;
    if (!doc || String(sf10State.previewRenderToken) !== String(renderToken)) return false;
    if (!fields || typeof fields !== 'object') return false;

    let applied = 0;
    doc.querySelectorAll('[data-sf10-field]').forEach((field) => {
        const key = String(field.dataset.sf10Field || '');
        if (!Object.prototype.hasOwnProperty.call(fields, key)) return;
        if (field.matches('[data-sf10-period-select]')) {
            const normalized = String(fields[key] || '').toLowerCase().trim();
            const value = ['three-term', 'three term', 'trimester', 'term', 'terms', 't'].includes(normalized) ? 'Three-Term' : 'Quarterly';
            field.value = value;
        } else {
            field.textContent = String(fields[key] ?? '');
        }
        applied += 1;
    });

    const applyPeriodSelection = frame.contentWindow?.sf10ApplyPeriodSelection;
    if (typeof applyPeriodSelection === 'function') {
        doc.querySelectorAll('[data-sf10-period-select]').forEach((select) => {
            applyPeriodSelection(select.closest('.record-block'), select.value);
        });
    }
    return applied > 0;
}

function sf10RefreshPreviewDocument(fields, renderToken) {
    const frame = document.getElementById('sf10Frame');
    const childWindow = frame?.contentWindow;
    const childDocument = frame?.contentDocument;
    if (!childWindow || !childDocument) return false;
    if (String(sf10State.previewRenderToken) !== String(renderToken)) return false;
    if (String(childDocument.body?.dataset?.sf10PreviewToken || '') !== String(renderToken)) return false;

    // Re-rendering an iframe while switching learners can finish after the
    // parent has already moved on. Call the iframe's own setup functions again
    // once its document is available so saved values are applied deterministically.
    if (typeof childWindow.sf10PrepareEditableFields !== 'function') return false;
    childWindow.sf10PrepareEditableFields();
    childWindow.sf10WirePeriodSelectors?.();
    sf10ApplyParentPreviewOverrides(fields, renderToken);
    childWindow.sf10FitPages?.();
    return childDocument.querySelectorAll('[data-sf10-field]').length > 0;
}

function sf10WritePreview(html, previewFields = {}, renderToken = 0) {
    const frame = document.getElementById('sf10Frame');
    if (!frame) return;
    sf10State.previewRenderToken = Number(renderToken || 0);
    window.sf10ActivePreviewToken = String(sf10State.previewRenderToken);
    sf10State.selectedHtml = html;
    sf10State.previewDirty = false;
    const saveButton = document.getElementById('sf10SavePreviewBtn');
    if (saveButton) saveButton.disabled = true;
    const doc = frame.contentDocument || frame.contentWindow?.document;
    if (!doc) return;

    const refreshPreview = () => {
        if (!sf10RefreshPreviewDocument(previewFields, renderToken)) {
            setTimeout(() => sf10RefreshPreviewDocument(previewFields, renderToken), 40);
        }
    };
    // Register before doc.open() so Safari cannot miss the iframe load event
    // during rapid learner navigation.
    frame.addEventListener('load', refreshPreview, { once: true });
    doc.open();
    doc.write(html);
    doc.close();
    refreshPreview();
    setTimeout(refreshPreview, 60);
    doc.addEventListener('input', (event) => {
        const field = event.target?.closest?.('[data-sf10-field]');
        if (field) field.dataset.sf10Dirty = 'true';
        sf10State.previewDirty = true;
        if (saveButton) saveButton.disabled = false;
    });
    doc.addEventListener('change', (event) => {
        const field = event.target?.closest?.('[data-sf10-period-select][data-sf10-field]');
        if (!field) return;
        field.dataset.sf10Dirty = 'true';
        sf10State.previewDirty = true;
        if (saveButton) saveButton.disabled = false;
    });
}

function sf10PreviewText(field) {
    return String(field?.innerText || field?.textContent || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
}

function sf10CollectPreviewOverrides() {
    const frame = document.getElementById('sf10Frame');
    const doc = frame?.contentDocument;
    const fields = {};
    const collectField = (field) => {
        const key = String(field.dataset.sf10Field || '').trim();
        if (!key) return;
        fields[key] = field.matches('[data-sf10-period-select]')
            ? String(field.value || '').trim()
            : sf10PreviewText(field);
    };
    // Period type is configuration for the whole record block. Capture the
    // current value on every preview save, even when the user only edited a
    // grade cell, so it cannot silently fall back to the active year's type.
    doc?.querySelectorAll('[data-sf10-period-select][data-sf10-field]').forEach(collectField);
    doc?.querySelectorAll('[data-sf10-field][data-sf10-dirty="true"]:not([data-sf10-period-select])').forEach(collectField);
    return fields;
}

async function sf10SavePreview() {
    const learnerId = Number(sf10State.selectedLearnerId || 0);
    const fields = sf10CollectPreviewOverrides();
    if (!learnerId || !Object.keys(fields).length) {
        sf10Toast('info', 'Edit a preview field before saving.');
        return;
    }
    const saveButton = document.getElementById('sf10SavePreviewBtn');
    const oldHtml = saveButton?.innerHTML || '';
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    }
    const saveKey = String(learnerId);
    const saveCompletion = (async () => {
        const response = await sf10ApiPost('saveSF10Preview', { learner_id: learnerId, fields });
        if (!response?.success) throw new Error(response?.message || 'Failed to save SF10 preview fields.');
        return response;
    })();
    sf10State.previewSavePromises[saveKey] = saveCompletion;
    try {
        const response = await saveCompletion;
        const frame = document.getElementById('sf10Frame');
        const isStillCurrentLearner = Number(sf10State.selectedLearnerId || 0) === learnerId;
        if (isStillCurrentLearner) {
            frame?.contentDocument?.querySelectorAll('[data-sf10-dirty]').forEach((field) => delete field.dataset.sf10Dirty);
            sf10State.previewDirty = false;
        }
        sf10Toast('success', response.message || 'SF10 preview fields saved.');
    } catch (error) {
        sf10Toast('error', error?.response?.data?.message || error.message || 'Failed to save SF10 preview fields.');
    } finally {
        if (sf10State.previewSavePromises[saveKey] === saveCompletion) {
            delete sf10State.previewSavePromises[saveKey];
        }
        if (saveButton && Number(sf10State.selectedLearnerId || 0) === learnerId) {
            saveButton.disabled = !sf10State.previewDirty;
            saveButton.innerHTML = oldHtml || '<i class="fas fa-save"></i> Save Preview Edits';
        }
    }
}

async function sf10LoadLearner(learnerId, enrollmentId = 0) {
    if (!learnerId && !enrollmentId) return;
    const requestedLearnerId = Number(learnerId || 0);
    const saveKey = String(requestedLearnerId);
    const pendingSave = sf10State.previewSavePromises[saveKey];
    const loadSequence = ++sf10State.previewLoadSequence;
    if (pendingSave) {
        try {
            await pendingSave;
        } catch (error) {
            // The save path already reports the error. Continue loading the
            // learner so navigation is not left stuck on a spinner.
        }
    }
    try {
        const resp = await sf10ApiGet({ operation: 'getSF10Data', learner_id: learnerId || undefined, enrollment_id: enrollmentId || undefined });
        if (!resp?.success) throw new Error(resp?.message || 'Failed to load SF10');
        if (loadSequence !== sf10State.previewLoadSequence) return false;
        const data = resp.data;
        sf10State.selectedLearnerId = Number(data?.learner?.learner_id || learnerId);
        sf10State.selectedEnrollmentId = Number(enrollmentId || 0);
        sf10State.history = Array.isArray(data?.academic_history) ? data.academic_history : [];
        sf10State.historyAvailable = data?.history_available !== false;
        sf10RenderLearnerList();
        const label = document.getElementById('sf10SelectedLabel');
        if (label) label.textContent = data?.learner?.full_name || 'SF10 Preview';
        const printBtn = document.getElementById('sf10PrintBtn');
        if (printBtn) printBtn.disabled = false;
        const historyBtn = document.getElementById('sf10HistoryBtn');
        if (historyBtn) {
            historyBtn.disabled = data?.history_available === false;
            historyBtn.title = data?.history_available === false
                ? 'Previous-school history storage is unavailable.'
                : 'Add or edit structured previous-school academic records.';
        }
        const renderToken = sf10State.previewRenderToken + 1;
        const previewFields = data?.preview_overrides?.fields && typeof data.preview_overrides.fields === 'object'
            ? data.preview_overrides.fields
            : {};
        sf10WritePreview(sf10BuildPrintHtml(data, renderToken), previewFields, renderToken);
        return true;
    } catch (error) {
        console.error(error);
        sf10Toast('error', error?.response?.data?.message || error.message || 'Failed to load SF10');
        return false;
    }
}

async function sf10LoadRoster() {
    const sectionId = Number(document.getElementById('sf10SectionSelect')?.value || 0);
    const schoolYearId = Number(document.getElementById('sf10SchoolYearSelect')?.value || 0);
    if (!sectionId || !schoolYearId) {
        sf10State.learners = [];
        sf10RenderLearnerList();
        return;
    }
    const resp = await sf10ApiGet({ operation: 'getRoster', section_id: sectionId, school_year_id: schoolYearId });
    if (!resp?.success) throw new Error(resp?.message || 'Failed to load learners');
    sf10State.learners = Array.isArray(resp.data) ? resp.data : [];
    sf10RenderLearnerList();
}

async function sf10Init() {
    const sectionsResp = await sf10ApiGet({ operation: 'getSections' });
    if (!sectionsResp?.success) throw new Error(sectionsResp?.message || 'Failed to load sections');
    sf10State.sections = Array.isArray(sectionsResp.data) ? sectionsResp.data : [];
    sf10State.schoolYears = sf10BuildSchoolYears(sf10State.sections);
    sf10PopulateSchoolYears();
    sf10PopulateYearLevels();
    sf10PopulateSections();
    await sf10LoadRoster();

    document.getElementById('sf10SchoolYearSelect')?.addEventListener('change', async () => {
        sf10SyncSelectTitle(document.getElementById('sf10SchoolYearSelect'));
        sf10PopulateYearLevels();
        sf10PopulateSections();
        await sf10LoadRoster().catch((e) => sf10Toast('error', e.message || 'Failed to load learners'));
    });
    document.getElementById('sf10YearLevelSelect')?.addEventListener('change', async () => {
        sf10SyncSelectTitle(document.getElementById('sf10YearLevelSelect'));
        sf10PopulateSections();
        await sf10LoadRoster().catch((e) => sf10Toast('error', e.message || 'Failed to load learners'));
    });
    document.getElementById('sf10SectionSelect')?.addEventListener('change', () => {
        sf10SyncSelectTitle(document.getElementById('sf10SectionSelect'));
        sf10LoadRoster().catch((e) => sf10Toast('error', e.message || 'Failed to load learners'));
    });
    document.getElementById('sf10Search')?.addEventListener('input', () => sf10RenderLearnerList());
    sf10HistoryWire();
    document.getElementById('sf10SavePreviewBtn')?.addEventListener('click', sf10SavePreview);
    document.getElementById('sf10PrintBtn')?.addEventListener('click', async () => {
        const learnerId = Number(sf10State.selectedLearnerId || 0);
        const enrollmentId = Number(sf10State.selectedEnrollmentId || 0);
        if (!learnerId && !enrollmentId) return;
        const printBtn = document.getElementById('sf10PrintBtn');
        if (printBtn) printBtn.disabled = true;
        const refreshed = sf10State.previewDirty
            ? true
            : await sf10LoadLearner(learnerId, enrollmentId);
        if (printBtn) printBtn.disabled = !refreshed;
        if (!refreshed) return;
        const frame = document.getElementById('sf10Frame');
        frame?.contentWindow?.focus();
        frame?.contentWindow?.print();
    });
}

document.addEventListener('DOMContentLoaded', () => {
    sf10Init().catch((error) => {
        console.error(error);
        sf10Toast('error', error.message || 'Failed to initialize SF10');
    });
});
