function coAppBase() {
    if (typeof window.APP_BASE === 'string' && window.APP_BASE !== '') return window.APP_BASE;

    const pathname = String(window.location.pathname || '/');
    let appPrefix = '';
    if (pathname.includes('/dashboard/')) appPrefix = pathname.split('/dashboard/')[0] || '';
    else if (pathname.includes('/pages/')) appPrefix = pathname.split('/pages/')[0] || '';
    else if (pathname.includes('/api/')) appPrefix = pathname.split('/api/')[0] || '';
    else {
        const parts = pathname.split('/').filter(Boolean);
        appPrefix = parts.length ? `/${parts[0]}` : '';
    }
    if (appPrefix === '/') appPrefix = '';

    window.APP_BASE = appPrefix;
    return appPrefix;
}

function coApiBase() {
    return window.API_BASE || `${window.location.origin}${coAppBase()}/api`;
}

function coEscapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function coEmployeeFullName(employee) {
    return [employee?.first_name, employee?.middle_name, employee?.last_name, employee?.name_extension]
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
}

function coNormalizeCode(value) {
    return String(value || '').trim().toUpperCase();
}

function isMapehComponentName(subjectName) {
    const name = String(subjectName || '').toLowerCase();
    if (!name || name.includes('mapeh')) return false;
    return /\b(music|arts|physical education|health|pe|p\.e\.)\b/i.test(name)
        || /\bmusic\s*(and|&)\s*arts?\b/i.test(name)
        || /\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/i.test(name);
}

function isMapehComponentRow(row) {
    const area = coNormalizeCode(row?.area_code);
    const code = coNormalizeCode(row?.subject_code);
    const name = String(row?.subject_name || '').toLowerCase();
    if (name.includes('mapeh') && !name.includes('component')) return false;
    if (name.includes('mapeh') && name.includes('component')) return true;
    if (code === 'MAPEH') return false;
    if (area === 'MAPEH') return code !== '' || isMapehComponentName(name);
    return isMapehComponentName(name);
}

function isMapehClusterRow(row) {
    const name = String(row?.subject_name || '').toLowerCase();
    if (isMapehComponentRow(row)) return false;
    return coNormalizeCode(row?.subject_code) === 'MAPEH'
        || coNormalizeCode(row?.area_code) === 'MAPEH'
        || name.includes('mapeh');
}

function isMapehComponentSubjectId(id, ids = []) {
    return ids.includes(Number(id));
}

function deriveMapehComponentSubjectIds(subjects = []) {
    return (subjects || [])
        .filter((subject) => {
            const name = String(subject?.subject_name || '').toLowerCase();
            if (!name) return false;
            if (name.includes('mapeh') && name.includes('component')) return true;
            return !name.includes('mapeh') && /\b(music|arts|physical education|health|pe)\b/i.test(name);
        })
        .map(subject => Number(subject.subject_id || 0))
        .filter(id => id > 0);
}

function coNotify(message, type = 'info') {
    if (typeof window.showNotification === 'function') {
        window.showNotification(String(message || ''), type);
        return;
    }
    if (typeof window.alert === 'function') {
        window.alert(String(message || ''));
    }
}

function coIsProtectedRemoval(result) {
    if (!result || result.action !== 'remove' || result.ok) return false;
    if (Number(result.status || 0) === 409) return true;
    return /already has related records|grades\/final grades\/schedules|one of its components already has grades/i.test(
        String(result.message || '')
    );
}

const CO_AXIOS = { withCredentials: true };

const classOfferingsApi = {
    getAllClassOfferings: async (params) => axios.get(
        `${coApiBase()}/class_offerings/class_offerings.php`,
        { ...CO_AXIOS, params: { operation: 'getAllClassOfferings', _: Date.now(), ...(params || {}) } }
    ).then(r => r.data),
    getClassOfferingRoster: async (classId) => axios.get(
        `${coApiBase()}/class_offerings/class_offerings.php`,
        { ...CO_AXIOS, params: { operation: 'getClassOfferingRoster', class_id: Number(classId) || 0, _: Date.now() } }
    ).then(r => r.data),
    createClassOffering: async (data) => axios.post(
        `${coApiBase()}/class_offerings/class_offerings.php?operation=createClassOffering`,
        data,
        CO_AXIOS
    ).then(r => r.data),
    deleteClassOffering: async (data) => axios.post(
        `${coApiBase()}/class_offerings/class_offerings.php?operation=deleteClassOffering`,
        data,
        CO_AXIOS
    ).then(r => r.data),
    updateClassOffering: async (data) => axios.post(
        `${coApiBase()}/class_offerings/class_offerings.php?operation=updateClassOffering`,
        data,
        CO_AXIOS
    ).then(r => r.data),
    syncMapehComponents: async (data) => axios.post(
        `${coApiBase()}/class_offerings/class_offerings.php?operation=syncMapehComponents`,
        data,
        CO_AXIOS
    ).then(r => r.data)
};

const subjectsApi = {
    list: async () => axios.get(
        `${coApiBase()}/subjects/subjects.php`,
        { ...CO_AXIOS, params: { operation: 'getAllSubjects', _: Date.now() } }
    ).then(r => r.data)
};

const gradeLevelsApi = {
    list: async () => axios.get(
        `${coApiBase()}/grade_levels/grade_levels.php`,
        { ...CO_AXIOS, params: { operation: 'getAllGradeLevels', _: Date.now() } }
    ).then(r => r.data)
};

const sectionsApi = {
    listAll: async () => axios.get(
        `${coApiBase()}/sections/sections.php`,
        { ...CO_AXIOS, params: { operation: 'getAllSections', include_all: 1, _: Date.now() } }
    ).then(r => r.data),
    listBySchoolYear: async (schoolYearId) => axios.get(
        `${coApiBase()}/sections/sections.php`,
        { ...CO_AXIOS, params: { operation: 'getAllSections', school_year_id: Number(schoolYearId) || 0, _: Date.now() } }
    ).then(r => r.data),
    updateSection: async (data) => axios.post(
        `${coApiBase()}/sections/sections.php?operation=updateSection`,
        data,
        CO_AXIOS
    ).then(r => r.data)
};

const employeesApi = {
    list: async () => axios.get(
        `${coApiBase()}/employees/employees.php`,
        { ...CO_AXIOS, params: { operation: 'getAllEmployees', _: Date.now() } }
    ).then(r => r.data),
    getMyEmployee: async () => axios.get(
        `${coApiBase()}/employees/employees.php`,
        { ...CO_AXIOS, params: { operation: 'getMyEmployee', _: Date.now() } }
    ).then(r => r.data),
    getActivePrincipal: async () => axios.get(
        `${coApiBase()}/employees/employees.php`,
        { ...CO_AXIOS, params: { operation: 'getActivePrincipal', _: Date.now() } }
    ).then(r => r.data)
};

const schoolYearsApi = {
    list: async () => axios.get(
        `${coApiBase()}/school_years/school_years.php`,
        { ...CO_AXIOS, params: { operation: 'getAllSchoolYears', _: Date.now() } }
    ).then(r => r.data)
};

const curriculaApi = {
    list: async () => axios.get(
        `${coApiBase()}/curricula/curricula.php`,
        { ...CO_AXIOS, params: { operation: 'getAllCurricula', _: Date.now() } }
    ).then(r => r.data),
    getPrimaryForSchoolYear: async (schoolYearId) => axios.get(
        `${coApiBase()}/curricula/curricula.php`,
        { ...CO_AXIOS, params: { operation: 'getPrimaryCurriculumForSchoolYear', school_year_id: Number(schoolYearId) || 0, _: Date.now() } }
    ).then(r => r.data),
    getSubjects: async (curriculumId) => axios.get(
        `${coApiBase()}/curricula/curricula.php`,
        { ...CO_AXIOS, params: { operation: 'getCurriculumSubjects', curriculum_id: Number(curriculumId) || 0, _: Date.now() } }
    ).then(r => r.data)
};

const authApi = {
    me: async () => axios.get(
        `${coApiBase()}/auth/me.php`,
        { ...CO_AXIOS, params: { _: Date.now() } }
    ).then(r => r.data)
};

document.addEventListener('DOMContentLoaded', () => {
    initTeacherAssignment();
});

function initTeacherAssignment() {
    const pageHeader = document.querySelector('.page-header');
    const pageTitle = document.getElementById('pageTitle');
    const pageSubtitle = document.getElementById('pageSubtitle');
    if (pageSubtitle) pageSubtitle.textContent = '';

    const overviewPanel = document.getElementById('coOverviewPanel');
    const assignmentPanel = document.getElementById('coManagePanel');

    const mgrSY = document.getElementById('co-mgr-school-year');
    const mgrGradeLevel = document.getElementById('co-mgr-grade-level');
    const mgrSection = document.getElementById('co-mgr-section');
    const mgrAdviser = document.getElementById('co-mgr-adviser');
    const adviserField = mgrAdviser?.closest('.co-header-field');
    const mgrFinalize = document.getElementById('co-mgr-finalize');

    // Redesigned panel elements
    const bulkBlock = document.getElementById('co-bulk-block');
    const bulkTeacher = document.getElementById('co-bulk-teacher');
    const bulkApply = document.getElementById('co-bulk-apply');
    const assignTableWrap = document.getElementById('co-assign-table-wrap');
    const assignSubjectsBody = document.getElementById('co-assign-subjects-body');
    const assignEmpty = document.getElementById('co-assign-empty');
    const assignEmptyText = document.getElementById('co-assign-empty-text');
    const unsavedBadge = document.getElementById('co-unsaved-badge');
    const subjectSearch = document.getElementById('coSubjectSearch');
    const subjectSearchToolbar = subjectSearch?.closest('.co-subject-search-toolbar');
    const teacherPanel = document.getElementById('coTeacherViewPanel');
    const teacherSchoolYear = document.getElementById('coTeacherSchoolYear');
    const teacherSection = document.getElementById('coTeacherSection');
    const teacherPrint = document.getElementById('coTeacherPrint');
    const teacherViewTitle = document.getElementById('coTeacherViewTitle');
    const teacherRows = document.getElementById('coTeacherRows');
    const teacherEmpty = document.getElementById('coTeacherEmpty');
    const teacherEmptyText = document.getElementById('coTeacherEmptyText');
    const teacherPrintModal = document.getElementById('coTeacherPrintModal');
    const teacherPrintFrame = document.getElementById('coTeacherPrintFrame');

    if (!mgrSY || !mgrGradeLevel || !mgrSection || !mgrFinalize || !assignSubjectsBody || !assignEmpty) return;

    const state = {
        isAdmin: false,
        isTeacher: false,
        schoolYears: [],
        sectionsById: new Map(),
        sectionsAllById: new Map(),
        gradeLevelsById: new Map(),
        teachers: [],
        allSubjects: [],
        curricula: [],
        activeCurriculumId: null,
        curriculumSubjects: [],
        subjectOptions: [],
        mapehClusterSubjectId: 0,
        mapehComponentSubjectIds: [],

        overviewOfferings: [], // Loaded database offerings for section assignment lookup
        teacherOfferings: [],
        teacherRoster: [],
        teacherSelectedSectionId: 0,
        teacherClassLoading: false,
        teacherClassRequestSerial: 0,
        teacherClassError: '',
        teacherLiveLoading: false,
        teacherLiveTimer: null,
        teacherCurrentUserName: '',
        teacherSchoolHeadName: '',

        // Unified assignment state
        assignSubjects: [], // curriculum subjects for selected section grade
        assignTeachersBySubject: {}, // { [subject_id]: teacher_id }
        assignExistingOfferings: {}, // { [subject_id]: class_offering row }
        assignDirty: false,
        adviserDraftSectionId: 0,
        assignAdviserId: 0,
        assignOriginalAdviserId: 0,
        openDropdownSubjectId: null, // Selected subject ID for floating teacher dropdown
        subjectSearch: ''
    };

    const DESCRIPTIVE_ASSIGNMENT_ID = 0;

    const gradeNumberForSection = (section) => {
        const gradeName = String(section?.grade_name || '').trim();
        const match = gradeName.match(/\b(?:grade|g)\s*0*(\d+)\b/i);
        if (match) return Number(match[1]);
        const gradeId = Number(section?.grade_level_id || 0);
        return gradeId >= 1 && gradeId <= 10 ? gradeId : 0;
    };

    const gradingPolicyForSection = (section) => {
        const schoolYearId = Number(section?.school_year_id || mgrSY?.value || 0);
        const gradeNo = gradeNumberForSection(section);
        const schoolYear = state.schoolYears.find((row) => Number(row?.school_year_id || 0) === schoolYearId) || {};
        const modes = schoolYear?.elementary_grading_modes || {};
        const configuredMode = modes[gradeNo]
            || modes[String(gradeNo)]
            || schoolYear?.[`grade_${gradeNo}_grading_mode`]
            || '';
        const mode = String(configuredMode).trim().toLowerCase() === 'descriptive'
            ? 'Descriptive'
            : gradeNo === 1 ? 'Descriptive' : 'Numeric';
        const sf9TemplateVariant = gradeNo === 1 ? 'G1'
            : gradeNo === 2 ? 'G2'
                : gradeNo === 3 ? 'G3'
                    : gradeNo >= 4 && gradeNo <= 10 ? 'G4_10' : 'LEGACY';
        return {
            gradeNo,
            gradingMode: mode,
            sf9TemplateVariant,
            isGradeOneDescriptive: gradeNo === 1 && mode === 'Descriptive'
        };
    };

    const descriptiveOriginalTeacherId = () => {
        const teacherIds = state.assignSubjects
            .map((subject) => Number(state.assignExistingOfferings[subject.subject_id]?.teacher_id || 0))
            .filter((teacherId) => teacherId > 0);
        const uniqueTeacherIds = Array.from(new Set(teacherIds));
        return uniqueTeacherIds.length === 1 ? uniqueTeacherIds[0] : 0;
    };

    const resetAssignmentState = () => {
        state.assignSubjects = [];
        state.assignTeachersBySubject = {};
        state.assignExistingOfferings = {};
        state.assignDirty = false;
        state.adviserDraftSectionId = 0;
        state.assignAdviserId = 0;
        state.assignOriginalAdviserId = 0;
        state.openDropdownSubjectId = null;
    };

    const hasAdviserChanges = () => Number(state.assignAdviserId || 0) !== Number(state.assignOriginalAdviserId || 0);
    const hasUnsavedChanges = () => Boolean(state.assignDirty || hasAdviserChanges());

    const setView = () => {
        if (overviewPanel) overviewPanel.style.display = 'none';
        if (assignmentPanel) assignmentPanel.style.display = '';
    };

    const teacherRowsFromState = () => (Array.isArray(state.teacherOfferings) ? state.teacherOfferings : [])
        .filter(row => Number(row?.is_deleted || 0) !== 1);

    const teacherRowsForSelectedYear = () => {
        const selectedYear = String(teacherSchoolYear?.value || '');
        return teacherRowsFromState().filter(row => String(row?.school_year_id || row?.year_label || '') === selectedYear);
    };

    const populateTeacherSchoolYears = () => {
        if (!teacherSchoolYear) return;
        const yearMap = new Map();
        // Only expose years represented by this teacher's own active offerings.
        const availableYears = teacherRowsFromState();
        availableYears.forEach((row) => {
            const key = String(row?.school_year_id || row?.value || row?.year_label || '');
            if (!key || yearMap.has(key)) return;
            yearMap.set(key, {
                value: key,
                label: row?.year_label || 'School year not specified',
                start: String(row?.year_start || row?.date_start || '')
            });
        });
        const years = Array.from(yearMap.values()).sort((a, b) => {
            const byStart = String(b.start).localeCompare(String(a.start));
            return byStart || String(b.label).localeCompare(String(a.label));
        });
        const selected = years.some(year => year.value === String(teacherSchoolYear.value || ''))
            ? String(teacherSchoolYear.value)
            : String(years[0]?.value || '');
        teacherSchoolYear.innerHTML = years.length
            ? years.map(year => `<option value="${coEscapeHtml(year.value)}">${coEscapeHtml(year.label)}</option>`).join('')
            : '<option value="">No school years</option>';
        teacherSchoolYear.value = selected;
        populateTeacherSections();
    };

    const populateTeacherSections = () => {
        if (!teacherSection) return;
        const sectionMap = new Map();
        teacherRowsForSelectedYear().forEach((row) => {
            const sectionId = Number(row?.section_id || 0);
            if (!sectionId) return;
            if (!sectionMap.has(sectionId)) {
                sectionMap.set(sectionId, {
                    sectionId,
                    name: row?.section_name || 'Unnamed section',
                    grade: row?.grade_name || 'Grade level not specified',
                });
            }
        });
        const sections = Array.from(sectionMap.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        const current = String(teacherSection.value || '');
        const selected = sections.some(section => String(section.sectionId) === current)
            ? current
            : String(sections[0]?.sectionId || '');
        teacherSection.innerHTML = sections.length
            ? `<option value="">— select section —</option>${sections.map(section => `<option value="${section.sectionId}">${coEscapeHtml(section.name)} · ${coEscapeHtml(section.grade)}</option>`).join('')}`
            : '<option value="">No assigned sections</option>';
        teacherSection.value = selected;
    };

    const selectedTeacherSectionMeta = () => {
        const sectionId = Number(teacherSection?.value || 0);
        if (!sectionId) return null;
        const row = teacherRowsForSelectedYear().find(item => Number(item?.section_id || 0) === sectionId);
        if (!row) return null;
        return {
            sectionId,
            sectionName: row?.section_name || 'Unnamed section',
            gradeName: row?.grade_name || 'Grade level not specified',
            schoolYear: row?.year_label || 'School year not specified',
            adviserName: row?.adviser_name || '',
            offering: row,
        };
    };

    const teacherGenderKey = (value) => {
        const raw = String(value || '').trim().toLowerCase();
        if (raw === 'm' || raw === 'male') return 'male';
        if (raw === 'f' || raw === 'female') return 'female';
        return 'other';
    };

    const teacherEnrollmentStatus = (value) => {
        const status = String(value || '').trim();
        return status || 'Not set';
    };

    const teacherEnrollmentStatusKey = (value) => teacherEnrollmentStatus(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');

    const teacherPrintableRoster = (roster) => (Array.isArray(roster) ? roster : [])
        .filter((learner) => ['enrolled', 'completed'].includes(
            teacherEnrollmentStatus(learner?.enrollment_status).toLowerCase()
        ));

    const teacherRosterGroups = (roster) => {
        const groups = new Map([
            ['male', { label: 'MALE', rows: [] }],
            ['female', { label: 'FEMALE', rows: [] }],
            ['other', { label: 'OTHER / NOT SPECIFIED', rows: [] }],
        ]);
        (Array.isArray(roster) ? roster : []).forEach((learner) => {
            groups.get(teacherGenderKey(learner?.gender)).rows.push(learner);
        });
        groups.forEach(group => group.rows.sort((a, b) => String(a?.learner_name || '').localeCompare(String(b?.learner_name || ''))));
        return Array.from(groups.values()).filter(group => group.rows.length);
    };

    const renderTeacherTable = () => {
        if (!teacherRows) return;
        const section = selectedTeacherSectionMeta();
        const roster = Array.isArray(state.teacherRoster) ? state.teacherRoster : [];
        if (teacherViewTitle) teacherViewTitle.textContent = section?.sectionName || 'Select a section';
        if (teacherPrint) teacherPrint.disabled = !(section && teacherPrintableRoster(roster).length);
        let number = 0;
        teacherRows.innerHTML = teacherRosterGroups(roster).map(group => `
            <tr class="co-teacher-gender-row"><td colspan="4">${group.label}</td></tr>
            ${group.rows.map((learner) => {
                number += 1;
                return `<tr>
                    <td>${number}</td>
                    <td>${coEscapeHtml(learner?.learner_name || 'Unnamed learner')}</td>
                    <td>${coEscapeHtml(learner?.lrn || '—')}</td>
                    <td><span class="co-enrollment-status co-enrollment-status-${teacherEnrollmentStatusKey(learner?.enrollment_status)}">${coEscapeHtml(teacherEnrollmentStatus(learner?.enrollment_status))}</span></td>
                </tr>`;
            }).join('')}
        `).join('');

        if (teacherEmpty) teacherEmpty.hidden = Boolean(section && roster.length);
        if (teacherEmptyText) teacherEmptyText.textContent = state.teacherClassLoading
            ? 'Loading learners…'
            : state.teacherClassError
                ? state.teacherClassError
            : section
                ? 'No learners found for this assigned section.'
                : (teacherRowsFromState().length ? 'Select an assigned section to load its class list.' : 'No assigned class list found for this school year.');
    };

    const teacherPrintLogoUrls = () => {
        const base = String(coAppBase() || '').replace(/\/$/, '');
        return {
            left: `${base}/assets/img/logo/Seal_of_the_Department_of_Education_of_the_Philippines.png`,
            right: `${base}/assets/img/logo/logo.png`,
        };
    };

    const buildTeacherPrintDocument = () => {
        const section = selectedTeacherSectionMeta();
        const roster = Array.isArray(state.teacherRoster) ? state.teacherRoster : [];
        const printableRoster = teacherPrintableRoster(roster);
        if (!section || !printableRoster.length) return '';
        const logos = teacherPrintLogoUrls();
        let number = 0;
        const printMinimumLearnerRows = 20;
        const groupRows = teacherRosterGroups(printableRoster).map(group => `
            <tr class="gender-row"><td colspan="3">${group.label}</td></tr>
            ${group.rows.map((learner) => {
                number += 1;
                return `<tr>
                    <td class="number">${number}</td>
                    <td>${coEscapeHtml(learner?.learner_name || 'Unnamed learner')}</td>
                    <td class="lrn">${coEscapeHtml(learner?.lrn || '—')}</td>
                </tr>`;
            }).join('')}
        `).join('');
        const blankRows = Array.from({
            length: Math.max(0, printMinimumLearnerRows - printableRoster.length)
        }, () => '<tr class="blank-row" aria-hidden="true"><td class="number">&nbsp;</td><td>&nbsp;</td><td class="lrn">&nbsp;</td></tr>').join('');
        const schoolName = 'G.Pelaez Integrated School';
        const title = coEscapeHtml(section.sectionName);
        const context = `${coEscapeHtml(section.gradeName)} · School Year ${coEscapeHtml(section.schoolYear)}`;
        const style = `
            :root { color-scheme: light; }
            * { box-sizing: border-box; }
            html, body { margin: 0; padding: 0; background: #fff; color: #111827; font-family: Arial, Helvetica, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            body { padding: 10mm; }
            img { display: block; }
            .co-teacher-print-page { width: 794px; height: 1123px; max-width: 794px; max-height: 1123px; margin: 0 auto; }
            .co-teacher-print-sheet { width: 794px; height: 1123px; min-height: 1123px; max-height: 1123px; padding: 34px; border: 1px solid #263746; background: #fff; display: flex; flex-direction: column; overflow: hidden; break-inside: avoid; break-after: page; page-break-inside: avoid; page-break-after: always; }
            .co-teacher-print-sheet:last-child { break-after: auto; page-break-after: auto; }
            .letterhead { display: grid; grid-template-columns: 94px 1fr 94px; align-items: start; gap: 19px; margin-bottom: 27px; text-align: center; }
            .letterhead img { width: 83px; height: 83px; object-fit: contain; }
            .letterhead .right-logo { justify-self: end; }
            .republic { font-size: 8pt; letter-spacing: .04em; }
            .department { margin-top: 4px; font-size: 11px; font-weight: 700; }
            .school-name { margin-top: 8px; font-size: 15px; font-weight: 800; text-transform: uppercase; }
            h1 { margin: 12px 0 4px; font-size: 21px; line-height: 1.1; text-transform: uppercase; letter-spacing: .04em; }
            .context { margin: 0; font-size: 12px; color: #374151; }
            table { width: 100%; border: 1px solid #263746; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
            th, td { padding: 9px 10px; border: 1px solid #263746; vertical-align: middle; overflow-wrap: anywhere; }
            th { background: #e8edf2; color: #172b3b; font-size: 10px; letter-spacing: .06em; text-align: left; text-transform: uppercase; }
            th:first-child, td.number { width: 54px; text-align: center; }
            th:last-child, td.lrn { width: 170px; }
            .gender-row td { padding: 7px 10px; border-top: 2px solid #263746; background: #dce5ed; color: #1e3a5f; font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
            .co-teacher-print-table { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
            .co-teacher-print-table thead { display: block; flex: 0 0 auto; }
            .co-teacher-print-table thead tr,
            .co-teacher-print-table tbody tr { display: grid; grid-template-columns: 54px minmax(0, 1fr) 170px; min-width: 0; }
            .co-teacher-print-table thead tr { min-height: 36px; }
            .co-teacher-print-table tbody { display: flex; flex: 1 1 auto; min-height: 0; flex-direction: column; overflow: hidden; }
            .co-teacher-print-table tbody tr:not(.gender-row) { flex: 1 1 0; min-height: 0; }
            .co-teacher-print-table tbody tr:not(.gender-row) td { min-height: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
            .co-teacher-print-table tbody tr.gender-row { flex: 0 0 28px; min-height: 28px; }
            .co-teacher-print-table tbody tr.gender-row td { grid-column: 1 / -1; min-width: 0; }
            .co-teacher-print-table tbody tr.blank-row td { color: transparent; }
            .teacher-signatures { flex: 0 0 auto; padding-top: 34px; display: grid; grid-template-columns: 1fr 1fr; column-gap: 67px; }
            .teacher-signature-name { min-height: 45px; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 3px; text-align: center; font-size: 11pt; font-weight: 800; letter-spacing: .03em; text-transform: uppercase; }
            .teacher-signature-line { border-top: 1.3px solid #263746; }
            .teacher-signature-title { margin-top: 4px; text-align: center; font-size: 10pt; font-weight: 700; }
            @media screen { body { background: #e3e8ee; } .co-teacher-print-sheet { margin: 0 auto; box-shadow: 0 2px 14px rgba(23,39,58,.22); } }
            @media print { @page { size: A4 portrait; margin: 0; } body { padding: 0; } .co-teacher-print-page { width: 8.27in; height: 11.69in; max-width: none; max-height: 11.69in; } .co-teacher-print-sheet { width: 8.27in; height: 11.69in; min-height: 11.69in; max-height: 11.69in; border: 1px solid #263746; box-shadow: none; } }
        `;
        const adviserName = String(state.teacherCurrentUserName || section.adviserName || '').trim() || '—';
        const schoolHeadName = String(state.teacherSchoolHeadName || '').trim() || '—';
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Class list - ${title}</title><style>${style}</style></head><body>
            <main class="co-teacher-print-page"><section class="co-teacher-print-sheet" aria-label="Class list">
                <header class="letterhead">
                    <img src="${coEscapeHtml(logos.left)}" alt="DepEd Seal">
                    <div><div class="republic">Republic of the Philippines</div><div class="department">Department of Education</div><div class="school-name">${coEscapeHtml(schoolName)}</div><h1>${title}</h1><p class="context">${context}</p></div>
                    <img class="right-logo" src="${coEscapeHtml(logos.right)}" alt="School logo">
                </header>
                <table class="co-teacher-print-table"><thead><tr><th>No.</th><th>Learner</th><th>LRN</th></tr></thead><tbody>${groupRows}${blankRows}</tbody></table>
                <div class="teacher-signatures">
                    <div><div class="teacher-signature-name">${coEscapeHtml(adviserName)}</div><div class="teacher-signature-line"></div><div class="teacher-signature-title">Adviser</div></div>
                    <div><div class="teacher-signature-name">${coEscapeHtml(schoolHeadName)}</div><div class="teacher-signature-line"></div><div class="teacher-signature-title">School Head</div></div>
                </div>
            </section></main>
        </body></html>`;
    };

    const openTeacherPrintPreview = () => {
        if (!teacherPrintModal || !teacherPrintFrame || teacherPrint?.disabled) return;
        const documentHtml = buildTeacherPrintDocument();
        if (!documentHtml) return;
        teacherPrintFrame.srcdoc = documentHtml;
        teacherPrintModal.classList.add('show');
        teacherPrintModal.style.display = 'flex';
        teacherPrintModal.setAttribute('aria-hidden', 'false');
        window.refitPrintPreviewFrame?.(teacherPrintFrame, teacherPrintFrame.dataset.printPreviewItems);
    };

    const closeTeacherPrintPreview = () => {
        teacherPrintModal?.classList.remove('active', 'show');
        if (teacherPrintModal) teacherPrintModal.style.display = '';
        teacherPrintModal?.setAttribute('aria-hidden', 'true');
        if (teacherPrintFrame) {
            teacherPrintFrame.onload = null;
            teacherPrintFrame.srcdoc = '';
        }
    };

    const printTeacherPreview = () => {
        if (!teacherPrintFrame?.contentWindow) return;
        teacherPrintFrame.contentWindow.focus();
        teacherPrintFrame.contentWindow.print();
    };

    const loadTeacherView = async ({ silent = false } = {}) => {
        if (state.teacherLiveLoading) return;
        state.teacherLiveLoading = true;
        if (!silent && teacherRows) teacherRows.innerHTML = '<tr><td colspan="4">Loading class list…</td></tr>';
        if (!silent && teacherEmpty) teacherEmpty.hidden = true;
        try {
            const rows = await classOfferingsApi.getAllClassOfferings();
            state.teacherOfferings = Array.isArray(rows) ? rows : [];
            state.schoolYears = [];
            populateTeacherSchoolYears();
            await loadTeacherClassList();
        } catch (e) {
            if (silent) return;
            state.teacherOfferings = [];
            state.teacherRoster = [];
            if (teacherSchoolYear) teacherSchoolYear.innerHTML = '<option value="">Unavailable</option>';
            if (teacherSection) teacherSection.innerHTML = '<option value="">Unavailable</option>';
            if (teacherRows) teacherRows.innerHTML = '';
            if (teacherEmpty) teacherEmpty.hidden = false;
            if (teacherEmptyText) teacherEmptyText.textContent = e?.response?.data?.message || 'Unable to load your class list.';
        } finally {
            state.teacherLiveLoading = false;
        }
    };

    const loadTeacherClassList = async () => {
        const section = selectedTeacherSectionMeta();
        if (!section?.offering?.class_id) {
            state.teacherClassRequestSerial += 1;
            state.teacherClassLoading = false;
            state.teacherClassError = '';
            state.teacherRoster = [];
            state.teacherSelectedSectionId = 0;
            renderTeacherTable();
            return;
        }
        const requestSerial = ++state.teacherClassRequestSerial;
        state.teacherClassLoading = true;
        if (teacherPrint) teacherPrint.disabled = true;
        if (teacherEmpty) teacherEmpty.hidden = true;
        if (teacherRows) teacherRows.innerHTML = '<tr><td colspan="4">Loading learners…</td></tr>';
        try {
            const response = await classOfferingsApi.getClassOfferingRoster(section.offering.class_id);
            if (requestSerial !== state.teacherClassRequestSerial) return;
            state.teacherRoster = Array.isArray(response?.roster)
                ? response.roster
                : Array.isArray(response) ? response : [];
            state.teacherSelectedSectionId = section.sectionId;
            state.teacherClassError = '';
        } catch (e) {
            if (requestSerial !== state.teacherClassRequestSerial) return;
            state.teacherRoster = [];
            state.teacherClassError = e?.response?.data?.message || 'Unable to load this class list.';
        } finally {
            if (requestSerial !== state.teacherClassRequestSerial) return;
            state.teacherClassLoading = false;
            renderTeacherTable();
        }
    };

    const startTeacherLiveUpdates = () => {
        if (state.teacherLiveTimer) return;
        state.teacherLiveTimer = window.setInterval(() => {
            if (document.visibilityState === 'visible') void loadTeacherView({ silent: true });
        }, 30000);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') void loadTeacherView({ silent: true });
        });
    };

    const getSectionMeta = (sectionId) => {
        const sid = Number(sectionId || 0);
        if (!sid) return null;
        return state.sectionsAllById.get(sid) || state.sectionsById.get(sid) || null;
    };

    const pickActiveCurriculumId = () => {
        const active = (state.curricula || []).find(c => Number(c.is_active) === 1);
        return Number((active || state.curricula[0] || {}).curriculum_id || 0) || null;
    };

    const isTeacherRoleName = (roleName) => String(roleName || '').trim().toLowerCase().includes('teacher');

    const teacherNameFromRecord = (teacher) => `${teacher?.last_name || ''}, ${teacher?.first_name || ''}`
        .replace(/^,\s*/, '')
        .trim() || `Teacher #${Number(teacher?.employee_id || 0)}`;

    const syncHeaderSelect = (select, value) => {
        if (!select) return;
        if (value !== undefined) select.value = String(value ?? '');
        const choices = select._choicesInstance;
        if (!choices) return;
        try {
            choices.refresh();
            if (value !== undefined) choices.setChoiceByValue(String(value ?? ''));
        } catch {
            // Keep the native select usable while Choices.js is initializing.
        }
    };

    const adviserConflictsForSection = (section) => {
        const schoolYearId = Number(section?.school_year_id || mgrSY.value || 0);
        const sectionId = Number(section?.section_id || mgrSection.value || 0);
        const rows = state.sectionsAllById.size
            ? Array.from(state.sectionsAllById.values())
            : Array.from(state.sectionsById.values());
        const conflicts = new Map();
        rows
            .filter(row => Number(row?.is_deleted || 0) !== 1)
            .filter(row => Number(row?.school_year_id || 0) === schoolYearId)
            .filter(row => Number(row?.section_id || 0) !== sectionId)
            .forEach(row => {
                const adviserId = Number(row?.adviser_id || 0);
                if (adviserId > 0 && !conflicts.has(adviserId)) conflicts.set(adviserId, row);
            });
        return conflicts;
    };

    const populateAdviserSelect = (section, selectedAdviserId = null) => {
        if (!mgrAdviser) return;
        const currentId = selectedAdviserId === null
            ? Number(section?.adviser_id || 0)
            : Number(selectedAdviserId || 0);
        const conflicts = adviserConflictsForSection(section);
        const teacherOptions = (state.teachers || [])
            .map((teacher) => {
                const teacherId = Number(teacher?.employee_id || 0);
                if (!teacherId) return '';
                const conflict = conflicts.get(teacherId);
                if (conflict && teacherId !== currentId) return '';
                const selected = teacherId === currentId ? ' selected' : '';
                return `<option value="${teacherId}"${selected}>${coEscapeHtml(teacherNameFromRecord(teacher))}</option>`;
            })
            .filter(Boolean)
            .join('');

        mgrAdviser.innerHTML = (section
            ? '<option value="">— No homeroom adviser —</option>'
            : '<option value="">— select section first —</option>') + teacherOptions;
        syncHeaderSelect(mgrAdviser, currentId > 0 ? String(currentId) : '');
        setEnhancedSelectDisabled(mgrAdviser, !state.isAdmin || !section);
    };

    const sectionAdviserOption = (section, selectedAdviserId = null) => {
        const persistedAdviserId = Number(section?.adviser_id || 0);
        const adviserId = selectedAdviserId === null
            ? persistedAdviserId
            : Number(selectedAdviserId || 0);
        if (!adviserId) return null;
        const teacher = (state.teachers || []).find(row => Number(row.employee_id || 0) === adviserId);
        const adviserName = teacher
            ? teacherNameFromRecord(teacher)
            : adviserId === persistedAdviserId
                ? String(section?.adviser_name || section?.section_adviser || '').trim()
                : '';
        return {
            employee_id: adviserId,
            first_name: '',
            last_name: adviserName || `Teacher #${adviserId}`,
            position_name: 'Adviser'
        };
    };

    const teacherOptionsHtml = (section, selectedTeacherId = '') => {
        const adviserId = Number(section?.adviser_id || 0);
        const selectedId = Number(selectedTeacherId || adviserId || 0);
        const options = (state.teachers || []).map((teacher) => {
            const teacherId = Number(teacher.employee_id || 0);
            const name = `${teacher.last_name || ''}, ${teacher.first_name || ''}`.replace(/^,\s*/, '').trim();
            const role = teacherId === adviserId ? 'Adviser' : 'Teacher';
            const label = name || `Teacher #${teacherId}`;
            const searchText = `${label} ${role}`.toLowerCase();
            return `
                <button type="button" class="co-teacher-option${teacherId === selectedId ? ' is-current' : ''}"
                    data-action="select-assignment-teacher" data-teacher-id="${teacherId}"
                    data-search-text="${coEscapeHtml(searchText)}" aria-pressed="${teacherId === selectedId ? 'true' : 'false'}">
                    <span>${coEscapeHtml(label)} <span class="co-teacher-option-role">(${role})</span></span>
                    ${teacherId === selectedId ? '<i class="fas fa-check" aria-hidden="true"></i>' : ''}
                </button>
            `;
        }).join('');
        return options;
    };

    const adviserOnlyOptionsHtml = (section, selectedAdviserId = null) => {
        const adviser = sectionAdviserOption(section, selectedAdviserId);
        if (!adviser) return '<option value="">— No adviser assigned —</option>';

        const adviserId = Number(adviser.employee_id || 0);
        const teacher = (state.teachers || []).find(row => Number(row.employee_id || 0) === adviserId);
        const name = teacher
            ? `${teacher.last_name || ''}, ${teacher.first_name || ''}`.replace(/^,\s*/, '').trim()
            : String(section?.adviser_name || section?.section_adviser || `Teacher #${adviserId}`).trim();
        return `<option value="${adviserId}" selected>${coEscapeHtml(name)} (Adviser)</option>`;
    };

    const resetBulkTeacherDefault = () => {
        if (bulkTeacher) bulkTeacher.value = '';
    };

    const setEnhancedSelectDisabled = (select, disabled) => {
        if (!select) return;
        select.disabled = Boolean(disabled);
        const choices = select._choicesInstance;
        if (!choices) return;
        if (select.disabled) choices.disable();
        else choices.enable();
    };

    const setContextEmpty = (msg) => {
        state.adviserDraftSectionId = 0;
        state.assignAdviserId = 0;
        state.assignOriginalAdviserId = 0;
        if (mgrAdviser) {
            mgrAdviser.innerHTML = '<option value="">— select section first —</option>';
            syncHeaderSelect(mgrAdviser, '');
            setEnhancedSelectDisabled(mgrAdviser, true);
        }
        state.subjectOptions = [];
    };

    const refreshSectionContext = () => {
        const sectionId = Number(mgrSection.value || 0);
        const section = state.sectionsById.get(sectionId) || null;
        if (state.adviserDraftSectionId !== sectionId) {
            state.adviserDraftSectionId = sectionId;
            state.assignAdviserId = Number(section?.adviser_id || 0);
            state.assignOriginalAdviserId = Number(section?.adviser_id || 0);
        }
        populateAdviserSelect(section, state.assignAdviserId);

        return section;
    };

    const ensureCurriculumForSchoolYear = async (schoolYearId) => {
        const syId = Number(schoolYearId || 0);
        if (!syId) {
            state.activeCurriculumId = null;
            return;
        }

        try {
            const res = await curriculaApi.getPrimaryForSchoolYear(syId);
            const mapped = Number(res?.data?.curriculum_id || 0);
            state.activeCurriculumId = mapped > 0 ? mapped : null;
        } catch {
            state.activeCurriculumId = null;
        }
    };

    const loadSections = async () => {
        const syId = Number(mgrSY.value || 0);
        const gradeLevelId = Number(mgrGradeLevel.value || 0);

        if (!syId) {
            state.sectionsAllById = new Map();
            mgrSection.innerHTML = '<option value="">— select school year first —</option>';
            syncHeaderSelect(mgrSection, '');
            setContextEmpty('Select school year first.');
            return;
        }
        if (!gradeLevelId) {
            state.sectionsAllById = new Map();
            mgrSection.innerHTML = '<option value="">— select grade level first —</option>';
            syncHeaderSelect(mgrSection, '');
            setContextEmpty('Select grade level first.');
            return;
        }

        mgrSection.innerHTML = '<option value="">Loading sections...</option>';
        syncHeaderSelect(mgrSection, '');
        try {
            const rows = await sectionsApi.listBySchoolYear(syId);
            const allRows = (Array.isArray(rows) ? rows : [])
                .filter(r => Number(r.is_deleted) !== 1 && Number(r.grade_level_id) === gradeLevelId);
            state.sectionsAllById = new Map((Array.isArray(rows) ? rows : [])
                .filter(r => Number(r.is_deleted) !== 1)
                .map(r => [Number(r.section_id), r]));

            const list = allRows
                .sort((a, b) => String(a.section_name || '').localeCompare(String(b.section_name || '')));

            state.sectionsById = new Map();
            list.forEach((r) => state.sectionsById.set(Number(r.section_id), r));

            if (!list.length) {
                mgrSection.innerHTML = '<option value="">No sections found</option>';
                syncHeaderSelect(mgrSection, '');
                setContextEmpty('No sections found for this grade level.');
                return;
            }

            mgrSection.innerHTML = '<option value="">— select section —</option>' + list
                .map(r => `<option value="${Number(r.section_id)}">${coEscapeHtml(r.section_name || '')}</option>`)
                .join('');
            syncHeaderSelect(mgrSection, '');

            setContextEmpty('Select section to load subjects.');
            resetAssignmentState();
            renderAssignmentPanel();
        } catch {
            mgrSection.innerHTML = '<option value="">Unable to load sections</option>';
            syncHeaderSelect(mgrSection, '');
            setContextEmpty('Unable to load sections.');
            resetAssignmentState();
            renderAssignmentPanel();
        }
    };

    const isElementaryGrade = (gradeName = '') => {
        const g = String(gradeName).toLowerCase();
        return g.includes('grade 1') || g.includes('grade 2') || g.includes('grade 3') || g.includes('grade 4') || g.includes('grade 5') || g.includes('grade 6') || g.includes('elem');
    };

    const loadExistingOfferingsForSection = async (sectionId, schoolYearId) => {
        const sid = Number(sectionId || 0);
        const syId = Number(schoolYearId || 0);
        state.assignExistingOfferings = {};
        if (!sid || !syId) return;

        try {
            let list = Array.isArray(state.overviewOfferings) ? state.overviewOfferings : [];
            if (!list.length) {
                const rows = await classOfferingsApi.getAllClassOfferings();
                list = Array.isArray(rows) ? rows : [];
            }
            const components = [];
            list.forEach((o) => {
                if (Number(o.is_deleted) === 1) return;
                if (Number(o.section_id || 0) !== sid || Number(o.school_year_id || 0) !== syId) return;
                const subjId = Number(o.subject_id || 0);
                if (!subjId) return;
                if (isMapehComponentSubjectId(subjId, state.mapehComponentSubjectIds)) {
                    components.push(o);
                    return;
                }
                state.assignExistingOfferings[subjId] = o;
            });

            // If no cluster offering exists but components do, pre-fill the cluster teacher from the components.
            if (state.mapehClusterSubjectId && !state.assignExistingOfferings[state.mapehClusterSubjectId] && components.length > 0) {
                const first = components[0];
                state.assignExistingOfferings[state.mapehClusterSubjectId] = {
                    ...first,
                    subject_id: state.mapehClusterSubjectId,
                    subject_name: 'MAPEH',
                    is_cluster_placeholder: true
                };
            }
        } catch {
            // ignore load errors
        }
    };

    const buildAssignmentSubjects = async () => {
        resetAssignmentState();
        const section = refreshSectionContext();
        const gradeId = Number(section?.grade_level_id || 0);
        if (!gradeId) {
            renderAssignmentPanel();
            return;
        }

        try {
            const curriculumId = Number(state.activeCurriculumId || 0);
            let curriculumRows = [];
            if (curriculumId > 0) {
                const rows = await curriculaApi.getSubjects(curriculumId);
                curriculumRows = Array.isArray(rows) ? rows : [];
            }

            state.curriculumSubjects = curriculumRows;
            const gradeCurriculumRows = curriculumRows
                .filter(r => Number(r.grade_level_id) === gradeId);

            const clusterRow = gradeCurriculumRows.find(isMapehClusterRow);
            state.mapehClusterSubjectId = clusterRow ? Number(clusterRow.subject_id || 0) : 0;
            state.mapehComponentSubjectIds = gradeCurriculumRows
                .filter(isMapehComponentRow)
                .map(r => Number(r.subject_id || 0))
                .filter(id => id > 0);
            if (!state.mapehClusterSubjectId && state.mapehComponentSubjectIds.length > 0) {
                const catalogParent = state.allSubjects.find(isMapehClusterRow);
                state.mapehClusterSubjectId = Number(catalogParent?.subject_id || 0);
            }
            if (state.mapehClusterSubjectId > 0 && state.mapehComponentSubjectIds.length === 0) {
                state.mapehComponentSubjectIds = deriveMapehComponentSubjectIds(state.allSubjects);
            }

            const subjectIds = gradeCurriculumRows
                .map(r => Number(r.subject_id))
                .filter(id => Number.isFinite(id) && id > 0);

            const subjectById = new Map((state.allSubjects || []).map(s => [Number(s.subject_id), s]));
            const unique = Array.from(new Set(subjectIds));

            // Display one MAPEH parent in the assignment table. The backend still
            // creates/syncs the component offerings used by grade input.
            const hasComponents = unique.some(id => isMapehComponentSubjectId(id, state.mapehComponentSubjectIds));
            let filteredIds = unique;
            if (hasComponents && state.mapehClusterSubjectId > 0) {
                filteredIds = unique.filter(id => !isMapehComponentSubjectId(id, state.mapehComponentSubjectIds));
                if (!filteredIds.includes(state.mapehClusterSubjectId)) {
                    filteredIds.push(state.mapehClusterSubjectId);
                }
            }

            state.assignSubjects = filteredIds
                .map((sid) => {
                    const s = subjectById.get(Number(sid)) || {};
                    return {
                        subject_id: Number(sid),
                        subject_name: s.subject_name || `Subject #${sid}`,
                    };
                })
                .sort((a, b) => String(a.subject_name || '').localeCompare(String(b.subject_name || '')));

            const syId = Number(mgrSY.value || 0);
            await loadExistingOfferingsForSection(section?.section_id, syId);

            // Pre-fill existing teachers
            state.assignSubjects.forEach((s) => {
                const existing = state.assignExistingOfferings[s.subject_id];
                if (existing) {
                    state.assignTeachersBySubject[s.subject_id] = Number(existing.teacher_id || 0);
                }
            });

            if (gradingPolicyForSection(section).isGradeOneDescriptive) {
                const teacherId = descriptiveOriginalTeacherId();
                if (teacherId > 0) {
                    state.assignTeachersBySubject[DESCRIPTIVE_ASSIGNMENT_ID] = teacherId;
                }
            }

            renderAssignmentPanel();
        } catch (e) {
            const msg = e?.response?.data?.message || e?.message || 'Unable to load subjects for this section.';
            coNotify(msg, 'error');
            resetAssignmentState();
            renderAssignmentPanel();
        }
    };

    const teacherLabel = (teacherId) => {
        const id = Number(teacherId || 0);
        if (!id) return '';
        const t = (state.teachers || []).find(e => Number(e.employee_id || 0) === id);
        if (!t) return `Teacher #${id}`;
        const name = `${t.last_name || ''}, ${t.first_name || ''}`.replace(/^,\s*/, '').trim();
        return name;
    };

    const renderAssignmentPanel = () => {
        const hasSection = Number(mgrSection.value || 0) > 0;
        const hasSubjects = state.assignSubjects.length > 0;

        if (hasSection) refreshSectionContext();
        const adviserDirty = hasAdviserChanges();
        adviserField?.classList.toggle('co-header-field--unsaved', state.isAdmin && adviserDirty);

        if (!hasSection || !hasSubjects) {
            if (assignEmpty) assignEmpty.style.display = '';
            if (assignTableWrap) assignTableWrap.style.display = 'none';
            if (bulkBlock) bulkBlock.style.display = 'none';
            if (subjectSearchToolbar) subjectSearchToolbar.style.display = '';
            if (assignSubjectsBody) assignSubjectsBody.innerHTML = '';
            if (unsavedBadge) unsavedBadge.style.display = (hasUnsavedChanges() && state.isAdmin) ? '' : 'none';
            if (assignEmptyText) {
                assignEmptyText.textContent = hasSection && !hasSubjects
                    ? (state.activeCurriculumId
                        ? 'No curriculum subjects found for this section grade. Add subjects to the curriculum first.'
                        : 'No curriculum is mapped to this school year. Assign a primary curriculum before managing subjects.')
                    : 'Select a school year and section to load subjects from the curriculum.';
            }
            return;
        }

        if (assignEmpty) assignEmpty.style.display = 'none';
        if (assignTableWrap) assignTableWrap.style.display = '';

        const section = state.sectionsById.get(Number(mgrSection.value || 0)) || null;
        const gradingPolicy = gradingPolicyForSection(section);
        const isGradeOneDescriptive = gradingPolicy.isGradeOneDescriptive;
        const searchTerm = state.subjectSearch.trim().toLowerCase();
        const displaySubjects = isGradeOneDescriptive
            ? [{
                subject_id: DESCRIPTIVE_ASSIGNMENT_ID,
                subject_name: 'Descriptive',
                is_descriptive_summary: true,
            }]
            : state.assignSubjects;
        const visibleSubjects = searchTerm
            ? displaySubjects.filter(subject => String(subject.subject_name || '').toLowerCase().includes(searchTerm))
            : displaySubjects;

        if (bulkBlock) {
            bulkBlock.style.display = state.isAdmin && !isGradeOneDescriptive ? 'flex' : 'none';
        }
        if (subjectSearchToolbar) {
            subjectSearchToolbar.style.display = isGradeOneDescriptive ? 'none' : '';
        }
        if (bulkTeacher && state.isAdmin) {
            const adviser = sectionAdviserOption(section, state.assignAdviserId);
            bulkTeacher.innerHTML = adviserOnlyOptionsHtml(section, state.assignAdviserId);
            bulkTeacher.value = adviser?.employee_id ? String(adviser.employee_id) : '';
            bulkTeacher._choicesInstance?.refresh();
            bulkTeacher._choicesInstance?.setChoiceByValue(bulkTeacher.value || '');
            setEnhancedSelectDisabled(bulkTeacher, !adviser);
            if (bulkApply) bulkApply.disabled = !adviser;
        }

        if (unsavedBadge) unsavedBadge.style.display = (hasUnsavedChanges() && state.isAdmin) ? '' : 'none';

        if (assignSubjectsBody) {
            assignSubjectsBody.innerHTML = visibleSubjects.length ? visibleSubjects.map((s) => {
                const teacherId = Number(state.assignTeachersBySubject[s.subject_id] || 0);
                const originalTeacherId = s.is_descriptive_summary
                    ? descriptiveOriginalTeacherId()
                    : Number(state.assignExistingOfferings[s.subject_id]?.teacher_id || 0);
                const isUnsaved = state.isAdmin && teacherId !== originalTeacherId;

                let teacherHtml = '';

                if (teacherId) {
                    const name = teacherLabel(teacherId);

                    if (state.isAdmin) {
                        teacherHtml = `
                            <button type="button" class="co-chip co-chip-toggle" data-action="toggle-dropdown-custom" data-subject-id="${s.subject_id}" aria-expanded="${state.openDropdownSubjectId === s.subject_id ? 'true' : 'false'}" aria-label="Change assigned teacher for ${coEscapeHtml(s.subject_name)}">
                                <span class="load-dot"></span>
                                <span>${coEscapeHtml(name)}</span>
                                <i class="fas fa-chevron-down co-chip-chevron" aria-hidden="true"></i>
                            </button>
                            <button type="button" class="btn-remove-teacher" data-action="remove-teacher" data-subject-id="${s.subject_id}" title="Remove teacher" aria-label="Remove ${coEscapeHtml(name)} from ${coEscapeHtml(s.subject_name)}">×</button>
                        `;
                    } else {
                        teacherHtml = `
                            <span class="co-chip">
                                <span class="load-dot"></span>
                                <span>${coEscapeHtml(name)}</span>
                            </span>
                        `;
                    }
                } else {
                    if (state.isAdmin) {
                        teacherHtml = `
                            <button type="button" class="co-btn-action" data-action="toggle-dropdown-custom" data-subject-id="${s.subject_id}">
                                <i class="fas fa-plus"></i> Assign Teacher
                            </button>
                        `;
                    } else {
                        teacherHtml = `<span style="font-style:italic;color:var(--gray-500);">Unassigned</span>`;
                    }
                }

                // Searchable teacher options open directly from the assigned-teacher value.
                let dropdownHtml = '';
                if (state.isAdmin && state.openDropdownSubjectId === s.subject_id) {
                    const hasTeachers = (state.teachers || []).length > 0;
                    dropdownHtml = `
                        <div class="co-dropdown-panel">
                            <input id="co-teacher-search-${s.subject_id}" class="co-teacher-search" type="search" placeholder="Search teachers..." autocomplete="off" aria-label="Search teachers for ${coEscapeHtml(s.subject_name)}" data-action="search-assignment-teachers">
                            <div class="co-teacher-options" role="group" aria-label="Available teachers">
                                ${teacherOptionsHtml(section, teacherId)}
                                <p class="co-teacher-option-empty" ${hasTeachers ? 'hidden' : ''}>${hasTeachers ? 'No matching teachers.' : 'No teachers available.'}</p>
                            </div>
                        </div>
                    `;
                }

                return `
                    <div class="co-grid-row${isUnsaved ? ' co-grid-row--unsaved' : ''}" data-subject-id="${s.subject_id}">
                        <div class="co-subject-cell">
                            <span class="co-subject-name">${coEscapeHtml(s.subject_name)}</span>
                            ${isUnsaved ? '<span class="co-unsaved-note">Unsaved</span>' : ''}
                        </div>
                        <div class="co-teacher-cell">
                            ${teacherHtml}
                            ${dropdownHtml}
                        </div>
                    </div>
                `;
            }).join('') : '<div class="co-filter-empty">No subjects match this search.</div>';
        }
        window.enhanceControls?.();
    };

    const stageSectionAdviser = () => {
        if (!state.isAdmin || !mgrAdviser) return;
        const sectionId = Number(mgrSection.value || 0);
        if (!sectionId || !state.sectionsById.has(sectionId)) return;

        state.assignAdviserId = Number(mgrAdviser.value || 0);
        renderAssignmentPanel();
    };

    const persistSectionAdviser = async (sectionId, schoolYearId, section) => {
        const adviserId = Number(state.assignAdviserId || 0);
        if (adviserId === Number(state.assignOriginalAdviserId || 0)) return false;

        const response = await sectionsApi.updateSection({
            section_id: sectionId,
            section_name: section.section_name,
            grade_level_id: Number(section.grade_level_id || 0),
            school_year_id: schoolYearId,
            max_capacity: Number(section.max_capacity || 45),
            adviser_id: adviserId > 0 ? adviserId : null
        });
        if (response?.success === false) throw new Error(response?.message || 'Homeroom adviser could not be updated.');

        const teacher = (state.teachers || []).find(row => Number(row.employee_id || 0) === adviserId);
        const updatedSection = {
            ...section,
            adviser_id: adviserId > 0 ? adviserId : null,
            adviser_name: teacher ? teacherNameFromRecord(teacher) : ''
        };
        state.sectionsById.set(sectionId, updatedSection);
        if (state.sectionsAllById.has(sectionId)) state.sectionsAllById.set(sectionId, updatedSection);
        state.assignOriginalAdviserId = adviserId;
        return true;
    };

    const focusTeacherSearch = (subjectId) => {
        document.getElementById(`co-teacher-search-${subjectId}`)?.focus({ preventScroll: true });
    };

    const applyBulkTeacher = () => {
        const teacherId = Number(bulkTeacher?.value || 0);
        if (!teacherId) {
            coNotify('Select a teacher before using quick-fill.', 'error');
            return;
        }
        state.assignSubjects.forEach((s) => {
            state.assignTeachersBySubject[s.subject_id] = teacherId;
        });
        if (gradingPolicyForSection(state.sectionsById.get(Number(mgrSection.value || 0))).isGradeOneDescriptive) {
            state.assignTeachersBySubject[DESCRIPTIVE_ASSIGNMENT_ID] = teacherId;
        }
        state.assignDirty = true;
        renderAssignmentPanel();
        coNotify('Selected teacher applied to all subjects.', 'success');
    };

    const saveAssignments = async () => {
        const sectionId = Number(mgrSection.value || 0);
        const schoolYearId = Number(mgrSY.value || 0);
        const section = state.sectionsById.get(sectionId) || null;
        if (!schoolYearId || !sectionId || !section) {
            coNotify('Select school year and section first.', 'error');
            return;
        }

        const desiredMap = {};
        const isGradeOneDescriptive = gradingPolicyForSection(section).isGradeOneDescriptive;
        if (isGradeOneDescriptive) {
            const teacherId = Number(state.assignTeachersBySubject[DESCRIPTIVE_ASSIGNMENT_ID] || 0);
            if (teacherId) {
                state.assignSubjects.forEach((subject) => {
                    desiredMap[subject.subject_id] = teacherId;
                });
            }
        } else {
            state.assignSubjects.forEach((s) => {
                const teacherId = Number(state.assignTeachersBySubject[s.subject_id] || 0);
                if (teacherId) desiredMap[s.subject_id] = teacherId;
            });
        }
        const desired = Object.entries(desiredMap).map(([subject_id, teacher_id]) => ({ subject_id: Number(subject_id), teacher_id }));
        const subjectChangesPending = Boolean(state.assignDirty);

        if (mgrFinalize) mgrFinalize.disabled = true;
        setEnhancedSelectDisabled(mgrAdviser, true);
        try {
            const adviserChanged = await persistSectionAdviser(sectionId, schoolYearId, section);
            const results = [];

            if (subjectChangesPending) {
                // Delete offerings where teacher was removed. Adviser-only saves must
                // never reconcile or delete subject offerings.
                for (const subjectId of Object.keys(state.assignExistingOfferings).map(Number)) {
                    if (desiredMap[subjectId]) continue;
                    const existing = state.assignExistingOfferings[subjectId];
                    try {
                        const deletePayload = { class_id: Number(existing.class_id || 0) };
                        if (existing.is_cluster_placeholder && state.mapehClusterSubjectId > 0) {
                            deletePayload.mapeh_parent_subject_id = state.mapehClusterSubjectId;
                        }
                        const res = await classOfferingsApi.deleteClassOffering(deletePayload);
                        results.push({
                            ok: res?.success !== false,
                            action: 'remove',
                            message: res?.message || 'Deleted',
                            subject_id: subjectId
                        });
                    } catch (e) {
                        const msg = e?.response?.data?.message || e?.message || 'Failed';
                        results.push({
                            ok: false,
                            action: 'remove',
                            status: e?.response?.status || 0,
                            message: msg,
                            subject_id: subjectId
                        });
                    }
                }

                // Create or update
                for (const row of desired) {
                    let existing = state.assignExistingOfferings[row.subject_id];
                    // A placeholder cluster entry derived from an existing component is not the real cluster offering.
                    if (existing?.is_cluster_placeholder) {
                        existing = null;
                    }
                    try {
                        if (existing) {
                            if (Number(existing.teacher_id || 0) !== row.teacher_id) {
                                const res = await classOfferingsApi.updateClassOffering({
                                    class_id: Number(existing.class_id || 0),
                                    subject_id: row.subject_id,
                                    section_id: sectionId,
                                    school_year_id: schoolYearId,
                                    teacher_id: row.teacher_id,
                                });
                                results.push({
                                    ok: res?.success !== false,
                                    action: 'update',
                                    message: res?.message || 'Updated',
                                    subject_id: row.subject_id
                                });
                            } else {
                                results.push({ ok: true, action: 'update', message: 'No change', subject_id: row.subject_id });
                            }
                        } else {
                            const res = await classOfferingsApi.createClassOffering({
                                section_id: sectionId,
                                school_year_id: schoolYearId,
                                subject_id: row.subject_id,
                                teacher_id: row.teacher_id,
                            });
                            results.push({
                                ok: res?.success !== false,
                                action: 'create',
                                message: res?.message || 'Created',
                                subject_id: row.subject_id
                            });
                        }
                    } catch (e) {
                        const msg = e?.response?.data?.message || e?.message || 'Failed';
                        results.push({
                            ok: false,
                            action: existing ? 'update' : 'create',
                            status: e?.response?.status || 0,
                            message: msg,
                            subject_id: row.subject_id
                        });
                    }
                }
            }

            const failures = results.filter(r => !r.ok);
            const protectedRemovals = failures.filter(coIsProtectedRemoval);
            const otherFailures = failures.filter(r => !coIsProtectedRemoval(r));
            const savedAssignments = results.filter(r => r.ok && r.action !== 'remove');
            const failCount = failures.length;
            if (!subjectChangesPending) {
                coNotify(adviserChanged ? 'Homeroom adviser saved.' : 'No changes to save.', adviserChanged ? 'success' : 'info');
            } else if (otherFailures.length === 0 && protectedRemovals.length > 0) {
                coNotify(
                    savedAssignments.length > 0
                        ? 'Subject assignment saved. Existing offerings with related records were kept.'
                        : 'No offerings were removed. Existing offerings with related records were kept.',
                    'info'
                );
            } else if (failCount === 0) {
                coNotify('Class offering changes saved.', 'success');
            } else {
                coNotify('Some subject assignment changes could not be saved. Existing records were kept safely.', 'error');
                console.warn('Class offering assignment results:', results);
            }

            if (subjectChangesPending && state.mapehClusterSubjectId > 0 && desiredMap[state.mapehClusterSubjectId]) {
                try {
                    await classOfferingsApi.syncMapehComponents({
                        section_id: sectionId,
                        school_year_id: schoolYearId
                    });
                } catch {
                    // The listing refresh also attempts to heal MAPEH components.
                }
            }

            if (!subjectChangesPending || failCount === 0) state.assignDirty = false;

            if (!subjectChangesPending || failCount === 0) {
                // Refresh DB listings so the section assignments reflect saved rows.
                try {
                    const rows = await classOfferingsApi.getAllClassOfferings();
                    state.overviewOfferings = Array.isArray(rows) ? rows : [];
                } catch {
                    // ignore errors
                }

                await buildAssignmentSubjects();
            }
        } catch (e) {
            coNotify(e?.message || 'Failed to save assignments.', 'error');
        } finally {
            if (mgrFinalize) mgrFinalize.disabled = false;
            if (mgrSection.value) setEnhancedSelectDisabled(mgrAdviser, !state.isAdmin);
            renderAssignmentPanel();
        }
    };

    const populateGradeLevelSelect = (grades) => {
        const gradeOpts = [...grades]
            .sort((a, b) => Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0))
            .map((gl) => `<option value="${Number(gl.grade_level_id)}">${coEscapeHtml(gl.grade_name || '')}</option>`)
            .join('');
        mgrGradeLevel.innerHTML = '<option value="">— select grade level —</option>' + gradeOpts;
        syncHeaderSelect(mgrGradeLevel, '');
    };

    const loadGradeLevelsFromMaster = () => {
        populateGradeLevelSelect(Array.from(state.gradeLevelsById.values()));
    };

    const loadInitialData = async () => {
        try {
            try {
                const me = await authApi.me();
                const roleId = Number(me?.data?.role_id || 0);
                state.isAdmin = roleId === 8;
                const roleName = String(me?.data?.role_key || me?.data?.role_name || '').toLowerCase();
                state.isTeacher = roleId === 9 || roleName.includes('teacher');
                state.teacherCurrentUserName = String(
                    me?.data?.full_name
                    || `${me?.data?.first_name || ''} ${me?.data?.last_name || ''}`.trim()
                    || me?.data?.username
                    || ''
                ).trim();
            } catch {
                state.isAdmin = false;
                state.isTeacher = false;
            }

            if (state.isTeacher && !state.isAdmin) {
                if (assignmentPanel) assignmentPanel.style.display = 'none';
                if (teacherPanel) teacherPanel.hidden = false;
                if (pageHeader) pageHeader.hidden = true;
                document.title = 'My Class List - DepEd Academic Monitoring System';
                try {
                    const employeeResponse = await employeesApi.getMyEmployee();
                    const employee = employeeResponse?.data || {};
                    const fullName = [employee.first_name, employee.middle_name, employee.last_name, employee.name_extension]
                        .map(value => String(value || '').trim())
                        .filter(Boolean)
                        .join(' ');
                    if (fullName) state.teacherCurrentUserName = fullName;
                } catch {
                    // The auth profile name remains the safe fallback for the signature.
                }
                try {
                    const principalResponse = await employeesApi.getActivePrincipal();
                    const principal = principalResponse?.data && typeof principalResponse.data === 'object'
                        ? principalResponse.data
                        : principalResponse;
                    state.teacherSchoolHeadName = coEmployeeFullName(principal);
                } catch {
                    state.teacherSchoolHeadName = '';
                }
                await loadTeacherView();
                startTeacherLiveUpdates();
                return;
            }

            if (pageHeader) pageHeader.hidden = false;
            if (pageTitle) pageTitle.textContent = 'Class Offerings';
            document.title = 'Class Offerings - DepEd Academic Monitoring System';
            if (!state.isAdmin) {
                if (mgrFinalize) mgrFinalize.style.display = 'none';
                if (bulkBlock) bulkBlock.style.display = 'none';
            }
            document.querySelectorAll('[data-co-admin]').forEach((item) => { item.hidden = !state.isAdmin; });

            mgrSY.innerHTML = '<option value="">Loading...</option>';

            const [schoolYears, gradeLevels, teachers, subjects, curricula] = await Promise.all([
                schoolYearsApi.list(),
                gradeLevelsApi.list(),
                employeesApi.list(),
                subjectsApi.list(),
                curriculaApi.list()
            ]);

            state.schoolYears = Array.isArray(schoolYears) ? schoolYears : [];
            state.gradeLevelsById = new Map((Array.isArray(gradeLevels) ? gradeLevels : []).map(gl => [Number(gl.grade_level_id), gl]));
            state.teachers = Array.isArray(teachers)
                ? teachers.filter(e => Number(e.is_deleted || 0) !== 1 && isTeacherRoleName(e.role_name))
                : [];
            state.allSubjects = Array.isArray(subjects) ? subjects : [];
            state.curricula = Array.isArray(curricula) ? curricula : [];
            state.activeCurriculumId = null;

            const syOpts = state.schoolYears.map((sy) => {
                const label = `${sy.year_label || ''}${Number(sy.is_active) === 1 ? ' (active)' : ''}`.trim();
                return `<option value="${Number(sy.school_year_id)}">${coEscapeHtml(label)}</option>`;
            }).join('');
            mgrSY.innerHTML = '<option value="">— select school year —</option>' + syOpts;

            const activeSY = state.schoolYears.find(sy => Number(sy.is_active) === 1);
            syncHeaderSelect(mgrSY, activeSY ? String(activeSY.school_year_id) : '');

            setContextEmpty('Select school year and section first.');
            resetAssignmentState();
            renderAssignmentPanel();

            await ensureCurriculumForSchoolYear(Number(mgrSY.value || 0));
            loadGradeLevelsFromMaster();
            await loadSections();

            // Load global offerings for load counts
            try {
                const [rows, allSections] = await Promise.all([
                    classOfferingsApi.getAllClassOfferings(),
                    sectionsApi.listAll()
                ]);
                state.overviewOfferings = Array.isArray(rows) ? rows : [];
                state.sectionsAllById = new Map((Array.isArray(allSections) ? allSections : [])
                    .filter(r => Number(r.is_deleted) !== 1)
                    .map(r => [Number(r.section_id), r]));
            } catch {
                // ignore initial load errors
            }
        } catch (e) {
            const msg = e?.response?.data?.message || e?.message || 'Unable to load teacher assignment data.';
            coNotify(msg, 'error');
        }
    };

    mgrSY.addEventListener('change', async () => {
        state.subjectSearch = '';
        if (subjectSearch) subjectSearch.value = '';
        mgrGradeLevel.value = '';
        await ensureCurriculumForSchoolYear(Number(mgrSY.value || 0));
        loadGradeLevelsFromMaster();
        await loadSections();
    });

    mgrGradeLevel.addEventListener('change', () => {
        state.subjectSearch = '';
        if (subjectSearch) subjectSearch.value = '';
        void loadSections();
    });

    mgrSection.addEventListener('change', () => {
        state.subjectSearch = '';
        if (subjectSearch) subjectSearch.value = '';
        resetBulkTeacherDefault();
        refreshSectionContext();
        void buildAssignmentSubjects();
    });

    mgrAdviser?.addEventListener('change', () => {
        stageSectionAdviser();
    });

    mgrFinalize.addEventListener('click', () => {
        void saveAssignments();
    });

    if (bulkApply) {
        bulkApply.addEventListener('click', applyBulkTeacher);
    }

    const applyChangedTeacher = (subjectId, teacherId) => {
        subjectId = Number(subjectId || 0);
        teacherId = Number(teacherId || 0);
        if (subjectId < 0 || !teacherId) return false;

        state.assignTeachersBySubject[subjectId] = teacherId;
        state.assignDirty = true;
        state.openDropdownSubjectId = null;
        renderAssignmentPanel();
        return true;
    };

    const confirmLeaveWithUnsavedAssignments = async () => {
        if (!hasUnsavedChanges()) return true;

        if (state.openDropdownSubjectId !== null) {
            state.openDropdownSubjectId = null;
            renderAssignmentPanel();
        }

        const message = 'Save teacher assignment changes first. Unsaved changes will be lost if you leave this page.';
        const title = 'Unsaved class offering changes';
        if (typeof window.confirmUnsavedChanges === 'function') {
            return window.confirmUnsavedChanges({
                title,
                message,
                confirmLabel: 'Leave without saving',
                cancelLabel: 'Stay'
            });
        }
        return window.confirm(`${title}\n\n${message}\n\nLeave without saving?`);
    };

    window.addEventListener('beforeunload', (event) => {
        if (!hasUnsavedChanges()) return;
        event.preventDefault();
        event.returnValue = '';
    });

    document.addEventListener('click', async (event) => {
        if (!hasUnsavedChanges() || event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const link = event.target?.closest?.('a[href]');
        if (!link || link.hasAttribute('download') || link.target === '_blank') return;
        const href = String(link.getAttribute('href') || '');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

        const destination = new URL(link.href, window.location.href);
        if (destination.href === window.location.href) return;

        event.preventDefault();
        event.stopPropagation();
        if (await confirmLeaveWithUnsavedAssignments()) {
            state.assignDirty = false;
            window.location.assign(destination.href);
        }
    }, true);

    document.addEventListener('input', (e) => {
        const searchInput = e.target.closest('[data-action="search-assignment-teachers"]');
        if (!searchInput) return;
        const query = searchInput.value.trim().toLowerCase();
        const options = searchInput.closest('.co-dropdown-panel')?.querySelectorAll('.co-teacher-option') || [];
        let visibleCount = 0;
        options.forEach(option => {
            const matches = String(option.dataset.searchText || '').includes(query);
            option.hidden = !matches;
            if (matches) visibleCount += 1;
        });
        const empty = searchInput.closest('.co-dropdown-panel')?.querySelector('.co-teacher-option-empty');
        if (empty) empty.hidden = visibleCount > 0;
    });

    document.addEventListener('click', (e) => {
        const teacherOption = e.target.closest('[data-action="select-assignment-teacher"]');
        if (!teacherOption) return;
        const subjectId = Number(teacherOption.closest('.co-grid-row')?.dataset.subjectId || 0);
        applyChangedTeacher(subjectId, teacherOption.dataset.teacherId);
    });

    subjectSearch?.addEventListener('input', () => {
        state.subjectSearch = subjectSearch.value;
        renderAssignmentPanel();
    });

    teacherSchoolYear?.addEventListener('change', () => {
        populateTeacherSections();
        void loadTeacherClassList();
    });
    teacherSection?.addEventListener('change', () => {
        void loadTeacherClassList();
    });
    teacherPrint?.addEventListener('click', openTeacherPrintPreview);
    document.getElementById('btnCloseCoTeacherPrintPreview')?.addEventListener('click', closeTeacherPrintPreview);
    document.getElementById('btnCloseCoTeacherPrintPreviewFooter')?.addEventListener('click', closeTeacherPrintPreview);
    document.getElementById('btnPrintCoTeacherPreview')?.addEventListener('click', printTeacherPreview);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && teacherPrintModal?.getAttribute('aria-hidden') === 'false') closeTeacherPrintPreview();
    });

    // REDESIGNED: Handle custom dropdown panel clicks, remove button, change buttons, and clicks outside
    document.addEventListener('click', (e) => {
        if (e.target === teacherPrintModal) {
            closeTeacherPrintPreview();
            return;
        }

        // 1. Check if click is on "Assign Teacher" or "Change" button
        const btnToggle = e.target.closest('[data-action="toggle-dropdown-custom"]');
        if (btnToggle) {
            const subjectId = Number(btnToggle.dataset.subjectId || 0);
            if (state.openDropdownSubjectId === subjectId) {
                state.openDropdownSubjectId = null;
            } else {
                state.openDropdownSubjectId = subjectId;
            }
            renderAssignmentPanel();
            if (state.openDropdownSubjectId === subjectId) {
                window.requestAnimationFrame(() => focusTeacherSearch(subjectId));
            }
            return;
        }

        // 2. Check if click is on "remove teacher" button
        const btnRemove = e.target.closest('[data-action="remove-teacher"]');
        if (btnRemove) {
            const subjectId = Number(btnRemove.dataset.subjectId || 0);
            if (subjectId >= 0) {
                delete state.assignTeachersBySubject[subjectId];
                state.assignDirty = true;
            }
            state.openDropdownSubjectId = null;
            renderAssignmentPanel();
            return;
        }

        // 3. Clicked outside dropdown
        if (state.openDropdownSubjectId !== null && !e.target.closest('.co-teacher-cell')) {
            state.openDropdownSubjectId = null;
            renderAssignmentPanel();
        }
    });

    setView();
    void loadInitialData();
}
