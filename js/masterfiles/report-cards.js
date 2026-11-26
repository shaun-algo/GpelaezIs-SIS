const API_BASE_URL = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;
const noCache = () => Date.now();

const reportCardsApi = {
    list: async () => axios.get(`${API_BASE_URL}/report_cards/report_cards.php`, { params: { operation: 'getAllReportCards', _: noCache() } }).then(r => r.data),
    sf9: async (reportCardId) => axios.get(`${API_BASE_URL}/report_cards/report_cards.php`, { params: { operation: 'getSF9Data', report_card_id: reportCardId, _: noCache() } }).then(r => r.data),
    sf9ByEnrollment: async (enrollmentId) => axios.get(`${API_BASE_URL}/report_cards/report_cards.php`, { params: { operation: 'getSF9DataByEnrollment', enrollment_id: enrollmentId, _: noCache() } }).then(r => r.data),
    mySf9: async (schoolYearId = '') => axios.get(`${API_BASE_URL}/report_cards/report_cards.php`, {
        params: {
            operation: 'getMySF9Data',
            school_year_id: schoolYearId || undefined,
            _: noCache()
        }
    }).then(r => r.data),
    mySf9SchoolYears: async () => axios.get(`${API_BASE_URL}/report_cards/report_cards.php`, { params: { operation: 'getMySF9SchoolYears', _: noCache() } }).then(r => r.data),
    getSections: async (schoolYearId) => axios.get(`${API_BASE_URL}/report_cards/report_cards.php`, { params: { operation: 'getSF9Sections', school_year_id: schoolYearId, _: noCache() } }).then(r => r.data),
    getRoster: async (sectionId, schoolYearId) => axios.get(`${API_BASE_URL}/report_cards/report_cards.php`, { params: { operation: 'getSF9Roster', section_id: sectionId, school_year_id: schoolYearId, _: noCache() } }).then(r => r.data),
    saveTermComments: async (enrollmentId, comments) => axios.post(`${API_BASE_URL}/report_cards/report_cards.php?operation=saveSF9TermComments`, {
        enrollment_id: enrollmentId,
        comments,
    }).then(r => r.data),
    savePaceRatings: async (enrollmentId, ratings) => axios.post(`${API_BASE_URL}/report_cards/report_cards.php?operation=saveSF9PaceRatings`, {
        enrollment_id: enrollmentId,
        ratings,
    }).then(r => r.data),
    create: async (data) => axios.post(`${API_BASE_URL}/report_cards/report_cards.php?operation=createReportCard`, data).then(r => r.data),
    update: async (id, data) => axios.post(`${API_BASE_URL}/report_cards/report_cards.php?operation=updateReportCard`, { ...data, report_card_id: id }).then(r => r.data),
    remove: async (id) => axios.post(`${API_BASE_URL}/report_cards/report_cards.php?operation=deleteReportCard`, { report_card_id: id }).then(r => r.data)
};

// Report Cards UI State
let currentSectionId = null;
let currentSchoolYearId = null;
let currentGradeLevelId = null;
let currentStudents = [];
let selectedStudentId = null;
let reportCardSections = [];
let reportCardSchoolYears = [];
let learnerReportSchoolYears = [];
let selectedLearnerSchoolYearId = '';
let activeSf9EnrollmentId = null;
let activeSf9SupportsTermComments = false;
let activeSf9SupportsDescriptiveFields = false;
let activeSf9TermCommentsSnapshot = '';
let activeSf9TermCommentsDirty = false;
let activeSf9DescriptiveFieldsDirty = false;
let activeSf9DescriptiveFieldsSnapshot = '';
let activeSf9SupportsPaceRatings = false;
let activeSf9PaceRatingsSnapshot = '';
let activeSf9PaceRatingsDirty = false;
let mobilePreviewRequestId = 0;
let mobilePreviewReturnFocus = null;

function isLearnerRole() {
    const rname = String(window.CURRENT_ROLE_NAME || '').toLowerCase();
    const rid = Number(window.CURRENT_ROLE_ID || 0);
    return rname.includes('learner') || rname.includes('student') || rid === 10;
}

function isMobileReportCards() {
    return Boolean(window.matchMedia?.('(max-width: 1024px)').matches || (!window.matchMedia && window.innerWidth <= 1024));
}

function hideLearnerAdminControls() {
    document.body?.classList.add('rc-learner-mode');
    document.getElementById('mainContent')?.classList.add('rc-learner-mode');
    document.querySelector('.rc-page-intro')?.style.setProperty('display', 'none');
    document.querySelector('.rc-controls')?.style.setProperty('display', 'none');
    document.querySelector('.rc-student-list')?.style.setProperty('display', 'none');
    document.querySelector('.rc-main')?.classList.add('learner-view');
    document.querySelector('.rc-content')?.classList.add('learner-view');

    // Learners can view the coded grade values on this page, but the official
    // SF9 preview/print workflow remains available only to authorized staff.
    const previewModal = document.getElementById('sf9Modal');
    if (previewModal) {
        previewModal.hidden = true;
        previewModal.setAttribute('aria-hidden', 'true');
    }

    if (isLearnerRole()) {
        document.title = 'Grades - DepEd Academic Monitoring System';
    }

    ensureLearnerPageTitle();
}

function ensureLearnerPageTitle() {
    const content = document.querySelector('.rc-content');
    if (!content || content.querySelector('.rc-learner-page-title')) return;

    const title = document.createElement('h1');
    title.className = 'rc-page-title rc-learner-page-title';
    title.textContent = 'Grades';
    content.insertBefore(title, content.firstChild);
}

function renderLearnerFilterBar() {
    const detailContainer = document.getElementById('rcStudentDetail');
    if (!detailContainer) return;

    const existing = document.getElementById('rcLearnerFilterBar');
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.id = 'rcLearnerFilterBar';
    bar.className = 'rc-learner-filter-bar';

    const options = learnerReportSchoolYears.map((year) => {
        const id = String(year.school_year_id || '');
        const label = `${year.year_label || 'School Year'}${Number(year.is_active || 0) === 1 ? ' (Current)' : ''}`;
        return `<option value="${escapeHtml(id)}"${id === String(selectedLearnerSchoolYearId) ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');

    bar.innerHTML = `
        <div class="rc-learner-filter-label">
            <i class="fas fa-filter" aria-hidden="true"></i>
            <span>School Year</span>
        </div>
        <select id="rcLearnerSchoolYearFilter" class="rc-learner-filter-select" aria-label="Filter grades by school year">
            ${options || '<option value="">No school years found</option>'}
        </select>
    `;

    detailContainer.parentElement?.insertBefore(bar, detailContainer);

    const select = document.getElementById('rcLearnerSchoolYearFilter');
    if (select) {
        select.addEventListener('change', () => {
            selectedLearnerSchoolYearId = select.value;
            loadLearnerReportCard(selectedLearnerSchoolYearId);
        });
    }
}

function updatePeriodSelect(gradingSystemType) {
    const select = document.getElementById('rcQuarterSelect');
    if (!select) return;
    const type = String(gradingSystemType || 'Quarterly').toLowerCase();
    const threeTerm = ['three-term', 'three term', 'trimester', 'term'].includes(type);
    const count = threeTerm ? 3 : type === 'semester' ? 2 : 4;
    const prefix = threeTerm ? 'T' : type === 'semester' ? 'S' : 'Q';
    const label = threeTerm ? 'Term' : type === 'semester' ? 'Semester' : 'Quarter';
    select.innerHTML = `<option value="all" selected>All ${label}s</option>${Array.from({ length: count }, (_, index) => `<option value="${prefix}${index + 1}">${prefix}${index + 1}</option>`).join('')}`;
}

function buildReportCardSchoolYears(sections) {
    const byId = new Map();
    (Array.isArray(sections) ? sections : []).forEach((section) => {
        const id = String(section.school_year_id || '');
        if (!id || byId.has(id)) return;
        byId.set(id, {
            school_year_id: section.school_year_id,
            year_label: section.year_label || 'School Year',
            is_active: Number(section.is_active || section.is_current || 0),
            grading_system_type: section.grading_system_type || 'Quarterly'
        });
    });
    return Array.from(byId.values()).sort((a, b) => {
        const labelCompare = String(b.year_label || '').localeCompare(String(a.year_label || ''), undefined, { numeric: true });
        if (labelCompare !== 0) return labelCompare;
        return Number(b.school_year_id || 0) - Number(a.school_year_id || 0);
    });
}

function populateReportCardSchoolYearSelect() {
    const select = document.getElementById('rcSchoolYearSelect');
    if (!select) return;

    if (!reportCardSchoolYears.length) {
        select.innerHTML = '<option value="">No school years found</option>';
        select.disabled = true;
        return;
    }

    select.disabled = false;
    select.innerHTML = reportCardSchoolYears.map((year) => {
        const id = String(year.school_year_id || '');
        const selected = id === String(currentSchoolYearId || '') ? ' selected' : '';
        const currentLabel = Number(year.is_active || 0) === 1 ? ' (Current)' : '';
        return `<option value="${escapeHtml(id)}"${selected}>${escapeHtml((year.year_label || 'School Year') + currentLabel)}</option>`;
    }).join('');
}

function getReportCardGradeLevelsForCurrentSchoolYear() {
    const byId = new Map();
    reportCardSections
        .filter(section => String(section.school_year_id || '') === String(currentSchoolYearId || ''))
        .forEach((section) => {
            const gradeLevelId = Number(section.grade_level_id || 0);
            if (!gradeLevelId || byId.has(String(gradeLevelId))) return;
            byId.set(String(gradeLevelId), {
                grade_level_id: gradeLevelId,
                label: section.grade_name || `Grade ${gradeLevelId}`,
            });
        });

    return Array.from(byId.values()).sort((a, b) =>
        String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' })
    );
}

function populateReportCardGradeLevelSelect(preferredGradeLevelId = null) {
    const select = document.getElementById('rcGradeLevelSelect');
    if (!select) return [];

    const gradeLevels = getReportCardGradeLevelsForCurrentSchoolYear();
    if (!gradeLevels.length) {
        currentGradeLevelId = null;
        select.innerHTML = '<option value="">No year levels found</option>';
        select.disabled = true;
        return [];
    }

    const preferred = preferredGradeLevelId ? String(preferredGradeLevelId) : '';
    const current = currentGradeLevelId ? String(currentGradeLevelId) : '';
    const selectedId = gradeLevels.some(level => String(level.grade_level_id) === preferred)
        ? preferred
        : gradeLevels.some(level => String(level.grade_level_id) === current)
            ? current
            : String(gradeLevels[0].grade_level_id);

    currentGradeLevelId = selectedId;
    select.disabled = false;
    select.innerHTML = gradeLevels.map(level => {
        const id = String(level.grade_level_id);
        return `<option value="${escapeHtml(id)}"${id === selectedId ? ' selected' : ''}>${escapeHtml(level.label)}</option>`;
    }).join('');
    return gradeLevels;
}

function populateReportCardSectionSelect() {
    const sectionSelect = document.getElementById('rcSectionSelect');
    if (!sectionSelect) {
        console.error('Section select element not found');
        return [];
    }

    const filteredSections = reportCardSections
        .filter(section => String(section.school_year_id || '') === String(currentSchoolYearId || ''))
        .filter(section => Number(section.grade_level_id || 0) === Number(currentGradeLevelId || 0));
    sectionSelect.innerHTML = currentGradeLevelId
        ? '<option value="">Select Section</option>'
        : '<option value="">Select year level first</option>';
    filteredSections.forEach(section => {
        const grade = section.grade_name || 'Grade';
        const label = `${grade} - ${section.section_name || 'Section'}`;
        sectionSelect.innerHTML += `<option value="${escapeHtml(String(section.section_id || ''))}">${escapeHtml(label)}</option>`;
    });

    if (!filteredSections.length) {
        sectionSelect.innerHTML = currentGradeLevelId
            ? '<option value="">No sections found</option>'
            : '<option value="">Select year level first</option>';
    }
    sectionSelect.disabled = !filteredSections.length;
    return filteredSections;
}

function setReportCardSchoolYear(schoolYearId) {
    currentSchoolYearId = schoolYearId ? String(schoolYearId) : null;
    const selectedYear = reportCardSchoolYears.find(year => String(year.school_year_id || '') === String(currentSchoolYearId || ''));
    updatePeriodSelect(selectedYear?.grading_system_type || 'Quarterly');
    populateReportCardSchoolYearSelect();
    populateReportCardGradeLevelSelect();
    return populateReportCardSectionSelect();
}

async function handleSchoolYearChange() {
    const schoolYearSelect = document.getElementById('rcSchoolYearSelect');
    const sections = setReportCardSchoolYear(schoolYearSelect?.value || '');
    currentSectionId = null;
    const sectionSelect = document.getElementById('rcSectionSelect');
    if (sections.length && sectionSelect) {
        sectionSelect.value = String(sections[0].section_id || '');
        await handleSectionChange();
    } else {
        clearStudentList();
    }
}

async function handleGradeLevelChange() {
    const gradeLevelSelect = document.getElementById('rcGradeLevelSelect');
    currentGradeLevelId = gradeLevelSelect?.value || null;
    currentSectionId = null;

    const sections = populateReportCardSectionSelect();
    const sectionSelect = document.getElementById('rcSectionSelect');
    if (sections.length && sectionSelect) {
        sectionSelect.value = String(sections[0].section_id || '');
        await handleSectionChange();
    } else {
        clearStudentList();
    }
}

// Initialize Report Cards Interface
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

document.addEventListener('DOMContentLoaded', async () => {
    const previewFrame = document.getElementById('sf9Frame');
    previewFrame?.addEventListener('load', () => fitPreviewDocumentToViewport(previewFrame));
    window.addEventListener('resize', () => fitPreviewDocumentToViewport(previewFrame));
    document.getElementById('rcMobilePreviewClose')?.addEventListener('click', closeMobileLearnerPreview);
    document.querySelector('[data-mobile-preview-close]')?.addEventListener('click', closeMobileLearnerPreview);
    document.getElementById('rcMobileGenerateSf9')?.addEventListener('click', () => {
        const button = document.getElementById('rcMobileGenerateSf9');
        if (button?.disabled) return;
        const enrollmentId = Number(document.getElementById('rcMobileLearnerPreview')?.dataset.enrollmentId || 0);
        if (!enrollmentId) return;
        if (button) button.disabled = true;
        openSf9Modal(enrollmentId);
    });
    document.getElementById('rcMobileGenerateGradeSlip')?.addEventListener('click', () => {
        const button = document.getElementById('rcMobileGenerateGradeSlip');
        if (button?.disabled) return;
        const enrollmentId = Number(document.getElementById('rcMobileLearnerPreview')?.dataset.enrollmentId || 0);
        if (!enrollmentId) return;
        if (button) button.disabled = true;
        openGradeSlipModal(enrollmentId);
    });
    document.addEventListener('keydown', (event) => {
        const preview = document.getElementById('rcMobileLearnerPreview');
        const officialPreview = document.getElementById('sf9Modal');
        const officialPreviewOpen = officialPreview?.classList.contains('show')
            || officialPreview?.classList.contains('active');
        if (event.key !== 'Escape') return;
        if (officialPreviewOpen) {
            event.preventDefault();
            closeSf9Modal();
            return;
        }
        if (preview?.classList.contains('is-open')) closeMobileLearnerPreview();
    });
    installSf9TermCommentsLeaveGuard();
    waitForRole(() => initializeReportCards());
});

async function initializeReportCards() {
    try {
        console.log('Initializing report cards...');

        if (isLearnerRole()) {
            hideLearnerAdminControls();
            await loadLearnerSchoolYearOptions();
            await loadLearnerReportCard(selectedLearnerSchoolYearId);
            return;
        }

        reportCardSections = await reportCardsApi.getSections('').catch(err => {
            console.error('Failed to load report-card sections:', err);
            return [];
        });
        reportCardSchoolYears = buildReportCardSchoolYears(reportCardSections);
        const currentYear = reportCardSchoolYears.find(sy => Number(sy.is_active || 0) === 1) || reportCardSchoolYears[0];
        currentSchoolYearId = currentYear?.school_year_id ? String(currentYear.school_year_id) : null;

        const schoolYearSelect = document.getElementById('rcSchoolYearSelect');
        if (schoolYearSelect) {
            schoolYearSelect.addEventListener('change', handleSchoolYearChange);
        }

        const gradeLevelSelect = document.getElementById('rcGradeLevelSelect');
        if (gradeLevelSelect) {
            gradeLevelSelect.addEventListener('change', handleGradeLevelChange);
        }

        const sections = setReportCardSchoolYear(currentSchoolYearId);
        const sectionSelect = document.getElementById('rcSectionSelect');
        if (sectionSelect) {
            sectionSelect.addEventListener('change', handleSectionChange);
        } else {
            console.error('Section select element not found');
        }

        // Initialize event listeners
        const searchInput = document.getElementById('rcSearch');
        if (searchInput) {
            searchInput.addEventListener('input', handleStudentSearch);
        }

        // Load initial data if section is selected
        if (sections.length > 0 && currentSchoolYearId && sectionSelect) {
            sectionSelect.value = String(sections[0].section_id || '');
            await handleSectionChange();
        } else {
            clearStudentList();
        }

    } catch (error) {
        console.error('Failed to initialize report cards:', error);
        const detailContainer = document.getElementById('rcStudentDetail');
        if (detailContainer) {
            detailContainer.innerHTML = '<div class="rc-error">Failed to initialize: ' + escapeHtml(error.message) + '</div>';
        }
        if (window.Swal) {
            Swal.fire('Error', 'Failed to load report cards interface', 'error');
        }
    }
}

async function loadLearnerSchoolYearOptions() {
    try {
        const years = await reportCardsApi.mySf9SchoolYears();
        const seen = new Set();
        learnerReportSchoolYears = (Array.isArray(years) ? years : []).filter((year) => {
            const id = String(year.school_year_id || '');
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
        });
        const current = learnerReportSchoolYears.find((year) => Number(year.is_active || 0) === 1) || learnerReportSchoolYears[0];
        selectedLearnerSchoolYearId = current?.school_year_id ? String(current.school_year_id) : '';
        renderLearnerFilterBar();
    } catch (error) {
        console.error('Failed to load learner report-card school years:', error);
        learnerReportSchoolYears = [];
        selectedLearnerSchoolYearId = '';
        renderLearnerFilterBar();
    }
}

async function loadLearnerReportCard(schoolYearId = '') {
    hideLearnerAdminControls();
    renderLearnerFilterBar();
    const detailContainer = document.getElementById('rcStudentDetail');
    if (detailContainer) {
        detailContainer.innerHTML = '<div class="rc-empty"><i class="fas fa-spinner fa-spin"></i> Loading your grades...</div>';
    }

    try {
        const sf9Data = await reportCardsApi.mySf9(schoolYearId);
        await renderLearnerReportCard(sf9Data);
    } catch (error) {
        console.error('Failed to load learner report card:', error);
        if (detailContainer) {
            detailContainer.innerHTML = '<div class="rc-error">Failed to load your grades: ' + escapeHtml(error?.response?.data?.message || error.message) + '</div>';
        }
    }
}

function renderLearnerPacePreview() {
    return `
        <section class="rc-learner-pace-preview" aria-labelledby="rc-learner-pace-preview-title">
            <div class="rc-learner-pace-preview__header">
                <div>
                    <p class="rc-learner-pace-preview__eyebrow">Grade 1 descriptive record</p>
                    <h2 id="rc-learner-pace-preview-title">PACE Form Preview</h2>
                    <p class="rc-learner-pace-preview__intro">This is a view-only preview of your completed PACE form. Ratings and form fields cannot be edited from the learner account.</p>
                </div>
                <span class="rc-learner-pace-preview__badge"><i class="fas fa-eye" aria-hidden="true"></i> View only</span>
            </div>
            <div class="rc-learner-pace-preview__frame-wrap">
                <iframe id="rcLearnerPaceFrame" class="rc-learner-pace-preview__frame" title="Grade 1 PACE form view-only preview"></iframe>
            </div>
        </section>
    `;
}

function formatLearnerPaceCatalogKey(value) {
    const key = String(value || '').replace(/^g1_pace_/i, '');
    return key
        .split('_')
        .filter(Boolean)
        .map((part) => part.toUpperCase())
        .join(' · ');
}

function renderLearnerPaceRatings(data) {
    const ratings = Array.isArray(data?.pace_ratings) ? data.pace_ratings.filter((row) => row?.rating_code) : [];
    if (!ratings.length) return '';

    const periods = getReportPeriods(data);
    const periodMap = new Map(periods.map((period) => [Number(period.grading_period_id), period]));
    const groups = new Map();
    ratings.forEach((rating) => {
        const periodId = Number(rating.grading_period_id || 0);
        if (!groups.has(periodId)) groups.set(periodId, []);
        groups.get(periodId).push(rating);
    });

    const sections = Array.from(groups.entries()).map(([periodId, rows]) => {
        const period = periodMap.get(periodId);
        const periodLabel = period?.name || period?.label || 'Term';
        return `
            <section class="rc-descriptive-values__period" aria-labelledby="rc-pace-period-${periodId}">
                <h4 id="rc-pace-period-${periodId}">${escapeHtml(periodLabel)}</h4>
                <div class="rc-descriptive-values__grid">
                    ${rows.map((rating) => `
                        <div class="rc-descriptive-values__item">
                            <span class="rc-descriptive-values__label">${escapeHtml(formatLearnerPaceCatalogKey(rating.catalog_key))}</span>
                            <strong class="rc-descriptive-values__code">${escapeHtml(String(rating.rating_code).toUpperCase())}</strong>
                        </div>
                    `).join('')}
                </div>
            </section>
        `;
    }).join('');

    return `
        <section class="rc-descriptive-values" aria-labelledby="rc-descriptive-values-title">
            <div class="rc-descriptive-values__heading">
                <div>
                    <p class="rc-descriptive-values__eyebrow">Saved coded values</p>
                    <h3 id="rc-descriptive-values-title">Competency ratings</h3>
                </div>
                <span class="rc-descriptive-values__legend">A–E</span>
            </div>
            <p class="rc-descriptive-values__intro">These are the coded ratings saved for your enrollment. Official narrative and print fields remain staff-managed.</p>
            ${sections}
        </section>
    `;
}

async function renderLearnerReportCard(sf9Data) {
    const detailContainer = document.getElementById('rcStudentDetail');
    if (!detailContainer) return;
    hideLearnerAdminControls();
    detailContainer.classList.add('learner-report-card-detail');

    const learner = sf9Data?.learner || {};
    const enrollment = sf9Data?.enrollment || {};
    const isGradeOnePace = isGradeOneDescriptiveSf9(sf9Data);
    const isHandwrittenDescriptive = isHandwrittenDescriptiveSf9(sf9Data);
    const grades = isHandwrittenDescriptive ? [] : (sf9Data?.grades || []);
    const periods = getReportPeriods(sf9Data);
    const sanitizedGrades = grades.map((row) => sanitizeGradeRow(row, periods));
    const gwa = computeGeneralAverage(buildMapehAveragedGrades(sanitizedGrades, periods), sf9Data?.general_average, periods);
    const summaryGrades = flattenGradeSummaryRows(sanitizedGrades, periods);
    const learnerPlacement = [enrollment.section, enrollment.school_year].filter(Boolean).join(' ');

    const headerHtml = `
        <div class="rc-student-header">
            <div class="rc-student-avatar-large ${getAvatarColor(0)}">${getInitials(learner.name || 'Learner')}</div>
            <div class="rc-student-info">
                <div class="rc-student-name-large">${escapeHtml(learner.name || 'Learner')}</div>
                <div class="rc-student-section">${escapeHtml(learnerPlacement)}</div>
            </div>
        </div>
    `;

    let gradesHtml = '';
    if (isGradeOnePace) {
        await ensureDescriptiveSf9Template();
        gradesHtml = renderLearnerPacePreview();
    } else if (isHandwrittenDescriptive) {
        const paceRatingsHtml = renderLearnerPaceRatings(sf9Data);
        const learnerDescriptiveNote = 'Term narratives and competency details are left blank for handwritten completion on the printed SF9.';
        gradesHtml = paceRatingsHtml || `
            <div class="rc-descriptive-note">
                <h3>Descriptive SF9</h3>
                <p>${learnerDescriptiveNote}</p>
            </div>
        `;
    } else if (grades.length > 0) {
        gradesHtml = `
            <div class="rc-grades-section">
                <div class="rc-grades-table-wrap" role="region" tabindex="0" aria-label="Subject grades table">
                    <table class="rc-grades-table">
                        <thead>
                            <tr>
                                <th>Subject</th>
                                ${periods.map((period) => `<th title="${escapeHtml(period.name)}">${escapeHtml(period.label)}</th>`).join('')}
                                <th>Final</th>
                                <th>Remarks</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${summaryGrades.map((grade) => renderGradeSummaryRow(grade, periods)).join('')}
                        </tbody>
                    </table>
                </div>
                ${renderMobileGradeAccordion(summaryGrades, periods)}
                ${renderGeneralAverageSummary(gwa)}
            </div>
        `;
    } else {
        gradesHtml = '<div class="rc-error">No grades available for your report card.</div>';
    }

    detailContainer.innerHTML = `<div class="rc-learner-card-shell">${headerHtml + gradesHtml}</div>`;

    if (isGradeOnePace) {
        const paceFrame = document.getElementById('rcLearnerPaceFrame');
        if (paceFrame && window.Sf9PaceTemplate) {
            paceFrame.addEventListener('load', () => fitPreviewDocumentToViewport(paceFrame), { once: true });
            paceFrame.srcdoc = window.Sf9PaceTemplate.createPaceDocument(sf9Data, { editable: false });
        }
    }

    // Cache the loaded SF9 data for the modal viewer.
    window.__learnerSf9Data = sf9Data;
}

function flattenGradeSummaryRows(grades, periods = []) {
    return buildCurriculumSubjectDisplayRows(grades, periods);
}

function buildCurriculumSubjectDisplayRows(grades, periods = []) {
    const sourceRows = Array.isArray(grades) ? grades : [];
    const mapehModel = getMapehModel(sourceRows, periods);
    // MAPEH component offerings are displayed as the two grouped report-card
    // rows beneath their parent, while still remaining excluded from the
    // general-average subject list.
    if (!mapehModel.hasMapeh || !mapehModel.shouldGroup) return sourceRows;
    const parentRow = {
        ...(mapehModel.parentRow || {}),
        subject: 'MAPEH',
        subject_name: 'MAPEH',
        _isMapehParentDisplay: true
    };
    return mapehModel.nonMapehRows
        .concat([parentRow])
        .concat(mapehModel.components.map((item) => ({
            ...item.row,
            subject: item.label,
            subject_name: item.label,
            _isComponentBreakdown: true
        })));
}

function getGradeSummaryPresentation(grade, periods) {
    const periodValues = periods.map((period) => toReportCardGrade(grade[period.key] ?? grade[`${period.key}_grade`] ?? ''));
    const periodsComplete = periodValues.every(hasQuarterGrade);
    const explicitFinal = toReportCardGrade(grade.final_grade ?? grade.final_rating ?? grade.finalRating ?? '');

    let finalDisplay = '';
    let remarkDisplay = '';
    let remarkClass = '';
    let rowOutcomeClass = grade._isComponentBreakdown ? 'grade-row-component' : '';

    const partialPeriods = periodValues.filter((value) => hasQuarterGrade(value)).map((value) => Number(value));
    const partialWorst = partialPeriods.length ? Math.min(...partialPeriods) : null;

    if (periodsComplete) {
        const finalNum = computeReportCardAverage(periodValues);

        if (Number.isFinite(finalNum)) {
            finalDisplay = grade._isComponentBreakdown ? '' : String(finalNum);
            remarkDisplay = grade._isComponentBreakdown ? '' : (finalNum >= 75 ? 'Passed' : 'Failed');
            remarkClass = finalNum >= 75 ? 'pass' : 'fail';
            if (!grade._isComponentBreakdown) {
                rowOutcomeClass = finalNum >= 75 ? 'grade-row-pass' : 'grade-row-fail';
            }
        }
    } else if (explicitFinal !== null && !grade._isComponentBreakdown) {
        finalDisplay = String(explicitFinal);
        const explicitRemark = String(grade.remarks || grade.remark || '').trim();
        remarkDisplay = explicitRemark || (explicitFinal >= 75 ? 'Passed' : 'Failed');
        remarkClass = explicitFinal >= 75 ? 'pass' : 'fail';
        rowOutcomeClass = explicitFinal >= 75 ? 'grade-row-pass' : 'grade-row-fail';
    } else if (partialWorst !== null && !grade._isComponentBreakdown) {
        rowOutcomeClass = partialWorst >= 75 ? 'grade-row-pass-partial' : 'grade-row-fail-partial';
    }

    return {
        periodValues,
        finalDisplay,
        remarkDisplay,
        remarkClass,
        rowOutcomeClass,
        subjectLabel: grade.subject_name || grade.subject || '',
        subjectClass: grade._isComponentBreakdown ? 'subject-name subject-name--component' : 'subject-name',
        isComponent: Boolean(grade._isComponentBreakdown),
    };
}

function renderGradeSummaryRow(grade, periods) {
    const {
        periodValues,
        finalDisplay,
        remarkDisplay,
        remarkClass,
        rowOutcomeClass,
        subjectLabel,
        subjectClass,
    } = getGradeSummaryPresentation(grade, periods);
    return `
        <tr class="${rowOutcomeClass}">
            <td class="${subjectClass}" data-label="Subject">${grade._isComponentBreakdown ? '&bull; ' : ''}${escapeHtml(subjectLabel)}</td>
            ${periodValues.map((value, index) => `<td class="grade-cell" data-label="${escapeHtml(periods[index]?.label || periods[index]?.name || `Period ${index + 1}`)}">${formatUiGradeCell(value)}</td>`).join('')}
            <td class="grade-cell final" data-label="Final">${finalDisplay ? formatUiGradeCell(finalDisplay) : ''}</td>
            <td class="remark-cell ${remarkClass}" data-label="Remarks">${remarkDisplay ? `<span class="rc-remark-badge">${escapeHtml(remarkDisplay)}</span>` : ''}</td>
        </tr>
    `;
}

function getMobileSubjectLabel(subjectLabel, grade = {}) {
    const label = String(subjectLabel || '').trim();
    const normalized = label.toLowerCase().replace(/\s+/g, ' ');
    const code = String(grade?.subject_code || '').trim();
    const aliases = [
        [/good manners.*right conduct|\bgmrc\b/i, 'GMRC'],
        [/edukasyong pantahanan.*pangkabuhayan|\bepp\b/i, 'EPP'],
        [/edukasyon sa pagpapakatao|\besp\b/i, 'EsP'],
        [/araling panlipunan|\bap\b/i, 'AP'],
        [/technology and livelihood education|\btle\b/i, 'TLE'],
        [/mother tongue.*based|mother tongue|\bmtb(?:-?mle)?\b/i, 'MTB-MLE'],
        [/^music\s*(and|&)\s*arts?$/i, 'MUSIC&ARTS'],
        [/^music$/i, 'MUSIC'],
        [/^arts?$/i, 'ARTS'],
        [/^health$/i, 'HEALTH'],
        [/music.*arts.*physical.*education.*health|\bmapeh\b/i, 'MAPEH'],
        [/^physical education(?:\s*\(pe\))?$/i, 'PE'],
        [/physical education.*health|\bpeh\b/i, 'PEH'],
    ];

    const alias = aliases.find(([pattern]) => pattern.test(normalized));
    if (alias) return alias[1];

    if (code && code.length <= 8 && /^[a-z0-9-]+$/i.test(code) && !/^\d+$/.test(code)) {
        return code.toUpperCase();
    }

    if (label.length <= 16) return label;

    const stopWords = new Set(['and', 'at', 'of', 'the', 'in', 'sa', 'ng', 'na', 'a']);
    const initials = normalized
        .replace(/[^a-z0-9\s-]/gi, ' ')
        .split(/[\s-]+/)
        .filter((word) => word && !stopWords.has(word))
        .map((word) => word[0])
        .join('')
        .toUpperCase();

    return initials.length >= 2 && initials.length <= 7
        ? initials
        : `${label.slice(0, 12).trimEnd()}…`;
}

function groupMobileGradeRows(rows) {
    const groups = [];
    let mapehGroup = null;

    rows.forEach((grade) => {
        if (grade?._isMapehParentDisplay) {
            mapehGroup = { type: 'mapeh', parent: grade, components: [] };
            groups.push(mapehGroup);
            return;
        }

        if (grade?._isComponentBreakdown && mapehGroup) {
            mapehGroup.components.push(grade);
            return;
        }

        groups.push({ type: 'subject', grade });
    });

    return groups;
}

function renderMobileGradeDetails(presentation, periods, subjectLabel, nestedMarkup = '') {
    const periodCards = presentation.periodValues.map((value, index) => {
        const period = periods[index] || {};
        const label = period.label || period.name || `Period ${index + 1}`;
        return `
            <div class="rc-mobile-term-card" role="listitem">
                <span class="rc-mobile-term-label">${escapeHtml(label)}</span>
                <strong>${formatUiGradeCell(value)}</strong>
            </div>
        `;
    }).join('');
    const termCount = Math.max(1, periods.length);
    const remarkMarkup = presentation.remarkDisplay
        ? `<div class="rc-mobile-grade-remark"><span>Remarks</span><span class="rc-remark-badge ${presentation.remarkClass}">${escapeHtml(presentation.remarkDisplay)}</span></div>`
        : '';

    return `
        <div class="rc-mobile-grade-details">
            <div class="rc-mobile-term-grid" style="--rc-term-count:${termCount}" role="list" aria-label="Term grades for ${escapeHtml(subjectLabel)}">
                ${periodCards || '<div class="rc-mobile-term-empty">No term grades available</div>'}
            </div>
            ${remarkMarkup}
            ${nestedMarkup}
        </div>
    `;
}

function renderGeneralAverageSummary(value) {
    const average = toReportCardGrade(value);
    if (average === null) return '';

    const remark = remarksFor(average);
    const remarkClass = average >= 75 ? 'pass' : 'fail';
    return `
        <section class="rc-gwa" aria-label="General average">
            <div class="rc-gwa-copy">
                <strong class="rc-gwa-label">General Average</strong>
            </div>
            <strong class="rc-gwa-value">${escapeHtml(String(average))}</strong>
            <span class="rc-remark-badge ${remarkClass}">${escapeHtml(remark)}</span>
        </section>
    `;
}

function renderMobileGradeItem(grade, periods, options = {}) {
    const presentation = getGradeSummaryPresentation(grade, periods);
    const isComponent = Boolean(options.isComponent || presentation.isComponent);
    const subjectLabel = getMobileSubjectLabel(presentation.subjectLabel, grade);
    const subjectPrefix = isComponent ? '&bull; ' : '';
    const finalMarkup = presentation.finalDisplay
        ? formatUiGradeCell(presentation.finalDisplay)
        : '<span class="grade-text-empty">--</span>';
    const summaryRemarkMarkup = presentation.remarkDisplay
        ? `<span class="rc-mobile-grade-summary-remark ${presentation.remarkClass}">${escapeHtml(presentation.remarkDisplay)}</span>`
        : '<span class="rc-mobile-grade-summary-remark is-empty">--</span>';

    return `
        <details class="rc-mobile-grade-item ${isComponent ? 'rc-mobile-mapeh-component' : ''} ${presentation.rowOutcomeClass}" role="listitem">
            <summary class="rc-mobile-grade-summary">
                <span class="rc-mobile-grade-subject">
                    <span class="rc-mobile-grade-subject-name ${isComponent ? 'is-component' : ''}" title="${escapeHtml(presentation.subjectLabel)}" aria-label="${escapeHtml(presentation.subjectLabel)}">${subjectPrefix}${escapeHtml(subjectLabel)}</span>
                </span>
                <span class="rc-mobile-grade-final">${finalMarkup}</span>
                <span class="rc-mobile-grade-summary-remark-cell">${summaryRemarkMarkup}</span>
                <span class="rc-mobile-grade-chevron" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>
                </span>
            </summary>
            ${renderMobileGradeDetails(presentation, periods, presentation.subjectLabel)}
        </details>
    `;
}

function renderMobileMapehItem(parent, components, periods) {
    const presentation = getGradeSummaryPresentation(parent, periods);
    const componentMarkup = components.length
        ? `<div class="rc-mobile-mapeh-components" role="list" aria-label="MAPEH components">
                ${components.map((component) => renderMobileGradeItem(component, periods, { isComponent: true })).join('')}
           </div>`
        : '';
    const finalMarkup = presentation.finalDisplay
        ? formatUiGradeCell(presentation.finalDisplay)
        : '<span class="grade-text-empty">--</span>';
    const summaryRemarkMarkup = presentation.remarkDisplay
        ? `<span class="rc-mobile-grade-summary-remark ${presentation.remarkClass}">${escapeHtml(presentation.remarkDisplay)}</span>`
        : '<span class="rc-mobile-grade-summary-remark is-empty">--</span>';

    return `
        <details class="rc-mobile-grade-item rc-mobile-mapeh-parent ${presentation.rowOutcomeClass}" role="listitem">
            <summary class="rc-mobile-grade-summary">
                <span class="rc-mobile-grade-subject">
                    <span class="rc-mobile-grade-subject-name" title="MAPEH" aria-label="MAPEH, expandable component grades">MAPEH</span>
                </span>
                <span class="rc-mobile-grade-final">${finalMarkup}</span>
                <span class="rc-mobile-grade-summary-remark-cell">${summaryRemarkMarkup}</span>
                <span class="rc-mobile-grade-chevron" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>
                </span>
            </summary>
            ${renderMobileGradeDetails(presentation, periods, 'MAPEH', componentMarkup)}
        </details>
    `;
}

function renderMobileGradeAccordion(grades, periods) {
    const rows = Array.isArray(grades) ? grades : [];
    if (!rows.length) {
        return '<div class="rc-mobile-grades"><div class="rc-mobile-grades-empty">No grades available</div></div>';
    }

    return `
        <div class="rc-mobile-grades" aria-label="Subject grades">
            <div class="rc-mobile-grade-list-heading" aria-hidden="true">
                <span>Subject</span>
                <span>Final</span>
                <span>Remarks</span>
                <span></span>
            </div>
            <div class="rc-mobile-grade-list" role="list">
                ${groupMobileGradeRows(rows).map((group) => group.type === 'mapeh'
                    ? renderMobileMapehItem(group.parent, group.components, periods)
                    : renderMobileGradeItem(group.grade, periods)).join('')}
            </div>
        </div>
    `;
}

async function openMySf9Modal() {
    // Learner accounts are intentionally limited to the on-screen grade
    // values. Keep this guard in addition to removing the visible action so a
    // stale page or direct caller cannot reopen the print workflow.
    if (isLearnerRole()) return;

    let data = window.__learnerSf9Data;
    if (!data) return;

    // Refresh the learner's SF9 every time the preview opens so curriculum
    // subject changes made after the page loaded are reflected immediately.
    try {
        const refreshedData = await reportCardsApi.mySf9(selectedLearnerSchoolYearId);
        if (!refreshedData || refreshedData.success === false) {
            throw new Error(refreshedData?.message || 'Unable to refresh SF9 data.');
        }
        data = refreshedData;
        await renderLearnerReportCard(data);
    } catch (error) {
        if (window.Swal) {
            Swal.fire({ icon: 'error', title: 'SF9 Document', text: error?.response?.data?.message || error?.message || 'Unable to refresh SF9 data.' });
        }
        return;
    }

    if (isLearnerRole() && isHandwrittenDescriptiveSf9(data)) {
        if (window.Swal) {
            Swal.fire({
                icon: 'info',
                title: 'Descriptive Report Card',
                text: 'Learner accounts cannot generate or print descriptive-grade report cards.'
            });
        }
        return;
    }

    const iframe = document.getElementById('sf9Frame');
    if (!iframe) return;

    try {
        if (isGradeOneDescriptiveSf9(data)) await ensureDescriptiveSf9Template();
    } catch (error) {
        if (window.Swal) Swal.fire({ icon: 'error', title: 'SF9 Document', text: error?.message || 'Unable to load the Grade 1 PACE form.' });
        return;
    }

    setPrintModalTitle('SF9 Report Card (Preview)');
    const isDescriptive = isHandwrittenDescriptiveSf9(data);
    activeSf9EnrollmentId = null;
    activeSf9SupportsTermComments = !isLearnerRole() && !isDescriptive
        && Boolean(data?.enrollment?.supports_term_comments);
    activeSf9SupportsDescriptiveFields = !isLearnerRole() && isDescriptive && !isGradeOneDescriptiveSf9(data);
    activeSf9SupportsPaceRatings = false;
    activeSf9TermCommentsSnapshot = '';
    activeSf9TermCommentsDirty = false;
    activeSf9DescriptiveFieldsDirty = false;
    activeSf9DescriptiveFieldsSnapshot = '';
    activeSf9PaceRatingsSnapshot = '';
    activeSf9PaceRatingsDirty = false;
    updateSf9RemarksUi([]);
    iframe.onload = initializeSf9TermCommentsPreview;
    iframe.srcdoc = buildSf9DocumentHtml(ensureSf9Defaults(data));
    showSf9Modal();
}

function isHandwrittenDescriptiveSf9(data) {
    const enrollment = data?.enrollment || data || {};
    return String(enrollment.grading_mode || '').toLowerCase() === 'descriptive'
        && ['G1', 'G2', 'G3'].includes(String(enrollment.sf9_template_variant || '').toUpperCase());
}

async function handleSectionChange() {
    const sectionSelect = document.getElementById('rcSectionSelect');
    currentSectionId = sectionSelect?.value || '';

    if (!currentSectionId) {
        clearStudentList();
        return;
    }

    try {
        const selectedSection = reportCardSections.find(section => String(section.section_id || '') === String(currentSectionId));
        if (selectedSection?.school_year_id) {
            currentSchoolYearId = String(selectedSection.school_year_id);
            const schoolYearSelect = document.getElementById('rcSchoolYearSelect');
            if (schoolYearSelect && schoolYearSelect.value !== currentSchoolYearId) {
                schoolYearSelect.value = currentSchoolYearId;
            }
        }

        // Load roster for selected section
        const roster = await reportCardsApi.getRoster(currentSectionId, currentSchoolYearId);
        console.log('Roster data:', roster); // Debug log

        // The API returns the array directly, not wrapped in a students property
        currentStudents = Array.isArray(roster) ? roster : (roster.students || []);

        // Map the data structure to match what the UI expects
        currentStudents = currentStudents.map(student => ({
            enrollment_id: student.enrollment_id,
            name: student.learner_name,
            lrn: student.lrn,
            gender: student.gender,
            grade_level: student.grade_name,
            section: student.section_name,
            school_year: student.year_label,
            general_average: student.general_average,
            grading_mode: student.grading_mode,
            sf9_template_variant: student.sf9_template_variant,
            supports_term_comments: student.supports_term_comments
        }));

        updateBatchExportButton();
        renderStudentList();

    } catch (error) {
        console.error('Failed to load section roster:', error);
        currentStudents = [];
        updateBatchExportButton();
        renderStudentList();
    }
}

function handleStudentSearch() {
    const searchTerm = document.getElementById('rcSearch').value.toLowerCase();
    const filteredStudents = currentStudents.filter(student =>
        student.name.toLowerCase().includes(searchTerm) ||
        student.lrn.toLowerCase().includes(searchTerm)
    );
    renderStudentList(filteredStudents);
}

function updateBatchExportButton(isExporting = false) {
    const printButton = document.getElementById('rcBatchPrint');
    const slipButton = document.getElementById('rcBatchSlipPrint');
    const exportButton = document.getElementById('rcBatchExport');
    const disabled = isExporting || currentStudents.length === 0;
    const handwrittenDescriptive = currentStudents.length > 0
        && currentStudents.every((student) => isHandwrittenDescriptiveSf9({ enrollment: student }));
    if (printButton) {
        printButton.disabled = disabled;
        printButton.innerHTML = isExporting
            ? '<i class="fas fa-spinner fa-spin"></i> Preparing report cards...'
            : `<i class="fas fa-print"></i> Print Section${currentStudents.length ? ` (${currentStudents.length})` : ''}`;
    }
    if (slipButton) {
        slipButton.hidden = handwrittenDescriptive;
        slipButton.disabled = disabled || handwrittenDescriptive;
        slipButton.innerHTML = isExporting
            ? '<i class="fas fa-spinner fa-spin"></i> Preparing grade slips...'
            : `<i class="fas fa-receipt"></i> Print Grade Slips${currentStudents.length ? ` (${currentStudents.length})` : ''}`;
    }
    if (!exportButton) return;
    exportButton.disabled = disabled;
    exportButton.innerHTML = isExporting
        ? '<i class="fas fa-spinner fa-spin"></i> Preparing section PDF...'
        : `<i class="fas fa-file-pdf"></i> Export Section PDFs${currentStudents.length ? ` (${currentStudents.length})` : ''}`;
}

function renderMobileLearnerGradePreview(sf9Data) {
    const isHandwrittenDescriptive = isHandwrittenDescriptiveSf9(sf9Data);
    if (isHandwrittenDescriptive) {
        const paceRatings = renderLearnerPaceRatings(sf9Data);
        return paceRatings || `
            <div class="rc-mobile-preview-note">
                <strong>Descriptive SF9</strong>
                <span>Competency ratings and narrative fields are completed in the official SF9 form.</span>
            </div>
        `;
    }

    const periods = getReportPeriods(sf9Data);
    const grades = Array.isArray(sf9Data?.grades) ? sf9Data.grades : [];
    const sanitizedGrades = grades.map((row) => sanitizeGradeRow(row, periods));
    const summaryGrades = flattenGradeSummaryRows(sanitizedGrades, periods);
    const gwa = computeGeneralAverage(
        buildMapehAveragedGrades(sanitizedGrades, periods),
        sf9Data?.general_average,
        periods
    );
    if (!summaryGrades.length) {
        return `<div class="rc-mobile-preview-note">No grades are available for this learner.</div>${renderGeneralAverageSummary(gwa)}`;
    }

    return `
        <section class="rc-mobile-preview-grades" aria-label="Learner grades">
            ${renderMobileGradeAccordion(summaryGrades, periods)}
            ${renderGeneralAverageSummary(gwa)}
        </section>
    `;
}

function closeMobileLearnerPreview() {
    const preview = document.getElementById('rcMobileLearnerPreview');
    if (!preview || !preview.classList.contains('is-open')) return;

    mobilePreviewRequestId += 1;
    preview.classList.remove('is-open');
    preview.setAttribute('aria-hidden', 'true');
    preview.setAttribute('aria-busy', 'false');
    document.body.classList.remove('rc-mobile-preview-open');

    if (mobilePreviewReturnFocus && document.contains(mobilePreviewReturnFocus)) {
        mobilePreviewReturnFocus.focus();
    }
    mobilePreviewReturnFocus = null;
}

async function openMobileLearnerPreview(student, trigger = document.activeElement) {
    if (!student || !isMobileReportCards()) return;

    const preview = document.getElementById('rcMobileLearnerPreview');
    const avatar = document.getElementById('rcMobilePreviewAvatar');
    const title = document.getElementById('rcMobilePreviewTitle');
    const section = document.getElementById('rcMobilePreviewSection');
    const body = document.getElementById('rcMobilePreviewBody');
    const generateSf9 = document.getElementById('rcMobileGenerateSf9');
    const generateGradeSlip = document.getElementById('rcMobileGenerateGradeSlip');
    if (!preview || !avatar || !title || !section || !body) return;

    const enrollmentId = String(student.enrollment_id || '');
    if (preview.classList.contains('is-open') && preview.dataset.enrollmentId === enrollmentId) return;

    const requestId = ++mobilePreviewRequestId;
    mobilePreviewReturnFocus = trigger instanceof HTMLElement ? trigger : null;
    preview.dataset.enrollmentId = enrollmentId;
    avatar.className = `rc-student-avatar-large ${getAvatarColor(student.enrollment_id || 0)}`;
    avatar.textContent = getInitials(student.name || 'Learner');
    title.textContent = student.name || 'Learner';
    section.textContent = student.section || 'Section not assigned';
    body.innerHTML = '<div class="rc-mobile-preview-loading" role="status"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Loading…</div>';
    if (generateSf9) generateSf9.disabled = true;
    if (generateGradeSlip) {
        generateGradeSlip.disabled = true;
        generateGradeSlip.hidden = false;
    }

    preview.classList.add('is-open');
    preview.setAttribute('aria-hidden', 'false');
    preview.setAttribute('aria-busy', 'true');
    document.body.classList.add('rc-mobile-preview-open');

    try {
        const sf9Data = await reportCardsApi.sf9ByEnrollment(student.enrollment_id);
        if (requestId !== mobilePreviewRequestId || !preview.classList.contains('is-open')) return;
        if (!sf9Data || sf9Data.success === false) {
            throw new Error(sf9Data?.message || 'Unable to load this learner\'s grades.');
        }

        const learnerName = sf9Data?.learner?.name || student.name || 'Learner';
        title.textContent = learnerName;
        body.innerHTML = renderMobileLearnerGradePreview(sf9Data);
        preview.setAttribute('aria-busy', 'false');
        if (generateSf9) generateSf9.disabled = false;
        if (generateGradeSlip) {
            generateGradeSlip.hidden = isHandwrittenDescriptiveSf9(sf9Data);
            generateGradeSlip.disabled = false;
        }
    } catch (error) {
        if (requestId !== mobilePreviewRequestId || !preview.classList.contains('is-open')) return;
        preview.setAttribute('aria-busy', 'false');
        body.innerHTML = `<div class="rc-mobile-preview-error" role="alert">${escapeHtml(error?.response?.data?.message || error?.message || 'Unable to load this learner\'s grades.')}</div>`;
    }
}

function renderStudentList(students = currentStudents) {
    const studentListContainer = document.getElementById('rcStudentList');
    if (!studentListContainer) return;

    if (students.length === 0) {
        studentListContainer.innerHTML = `
            <div class="rc-empty-message">
                <video class="mp4-surface-blend rc-empty-video" autoplay loop muted playsinline preload="auto" aria-hidden="true">
                    <source src="../assets/icons/learners.mp4" type="video/mp4">
                </video>
                <p>No learners found</p>
            </div>
        `;
        return;
    }

    const studentItems = students.map(student => {
        const isActive = student.enrollment_id === selectedStudentId;

        return `
            <div class="rc-student-item ${isActive ? 'active' : ''}" data-enrollment-id="${student.enrollment_id}" role="button" tabindex="0" aria-label="Select ${escapeHtml(student.name)}">
                <div class="rc-student-avatar ${getAvatarColor(student.enrollment_id)}">${getInitials(student.name)}</div>
                <div class="rc-student-info">
                    <div class="rc-student-name">${escapeHtml(student.name)}</div>
                    <div class="rc-stu-section">${escapeHtml(student.section || 'Section not assigned')}</div>
                </div>
                <span class="rc-student-item-chevron" aria-hidden="true"><i class="fas fa-chevron-right"></i></span>
            </div>
        `;
    }).join('');

    studentListContainer.innerHTML = studentItems;

    // Add click handlers
    studentListContainer.querySelectorAll('.rc-student-item').forEach(item => {
        item.addEventListener('click', () => {
            const enrollmentId = parseInt(item.dataset.enrollmentId);
            selectStudent(enrollmentId);
        });
        item.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            const enrollmentId = parseInt(item.dataset.enrollmentId);
            selectStudent(enrollmentId);
        });
    });
}

function selectStudent(enrollmentId) {
    selectedStudentId = enrollmentId;

    // Update active state in list
    document.querySelectorAll('.rc-student-item').forEach(item => {
        const itemEnrollmentId = parseInt(item.dataset.enrollmentId);
        item.classList.toggle('active', itemEnrollmentId === enrollmentId);
    });

    // Load and display student details
    const student = currentStudents.find(s => s.enrollment_id === enrollmentId);
    if (student) {
        if (isMobileReportCards()) {
            openMobileLearnerPreview(student);
        } else {
            renderStudentDetail(student);
        }
    }
}

async function renderStudentDetail(student) {
    const detailContainer = document.getElementById('rcStudentDetail');
    if (!detailContainer) return;

    try {
        // Load SF9 data for this student
        const sf9Data = await reportCardsApi.sf9ByEnrollment(student.enrollment_id);
        console.log('SF9 Data:', sf9Data); // Debug log

        // Handle grades data
        const grades = sf9Data.grades || [];
        const isHandwrittenDescriptive = isHandwrittenDescriptiveSf9(sf9Data);
        const periods = getReportPeriods(sf9Data);
        const sanitizedGrades = grades.map((row) => sanitizeGradeRow(row, periods));
        const summaryGrades = flattenGradeSummaryRows(sanitizedGrades, periods);
        const gwa = computeGeneralAverage(
            buildMapehAveragedGrades(sanitizedGrades, periods),
            sf9Data?.general_average,
            periods
        );
        const descriptiveWorkflowNote = isGradeOneDescriptiveSf9(sf9Data)
            ? 'For Grade 1, enter A–E PACE ratings in Grade Input. Narrative fields and parent/guardian signatures remain print-only.'
            : 'For Grades 2–3, term narratives and parent signatures can be handwritten on the printed SF9 or encoded directly in the preview before printing.';
        console.log('Grades:', grades); // Debug log

        detailContainer.innerHTML = `
            <div class="rc-student-header">
                <div class="rc-student-avatar-large ${getAvatarColor(student.enrollment_id)}">${getInitials(student.name)}</div>
                <div class="rc-student-info">
                    <div class="rc-student-name-large">${escapeHtml(student.name)}</div>
                    <div class="rc-student-section">${escapeHtml(student.section || '')}</div>
                </div>
                <div class="rc-student-actions">
                    <button class="btn btn-primary" onclick="openSf9Modal(${student.enrollment_id})">
                        <i class="fas fa-file-alt"></i> Generate SF9
                    </button>
                    ${isHandwrittenDescriptive ? '' : `<button class="btn btn-outline" onclick="openGradeSlipModal(${student.enrollment_id})">
                        <i class="fas fa-receipt"></i> Grade Slip
                    </button>`}
                </div>
            </div>
            ${isHandwrittenDescriptive ? `
            <div class="rc-descriptive-note">
                <h3>Descriptive SF9</h3>
                <p>${descriptiveWorkflowNote}</p>
            </div>
            ` : `<div class="rc-grades-section">
                <div class="rc-grades-table-wrap" role="region" tabindex="0" aria-label="Subject grades table">
                    <table class="rc-grades-table">
                        <thead>
                            <tr>
                                <th>Subject</th>
                                ${periods.map((period) => `<th title="${escapeHtml(period.name)}">${escapeHtml(period.label)}</th>`).join('')}
                                <th>Final</th>
                                <th>Remarks</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${summaryGrades.length > 0 ? summaryGrades.map((grade) => renderGradeSummaryRow(grade, periods)).join('') : `<tr><td colspan="${periods.length + 3}" class="rc-error">No grades available for this student</td></tr>`}
                        </tbody>
                    </table>
                </div>
                ${renderMobileGradeAccordion(summaryGrades, periods)}
                ${renderGeneralAverageSummary(gwa)}
            </div>`}
        `;

    } catch (error) {
        console.error('Failed to load student details:', error);
        detailContainer.innerHTML = '<div class="rc-error">Failed to load student details: ' + escapeHtml(error.message) + '</div>';
    }
}

function clearStudentList() {
    currentStudents = [];
    selectedStudentId = null;
    closeMobileLearnerPreview();
    updateBatchExportButton();
    const studentListContainer = document.getElementById('rcStudentList');
    if (studentListContainer) {
        studentListContainer.innerHTML = '<div class="rc-empty-message">Select a section to view students</div>';
    }

    const detailContainer = document.getElementById('rcStudentDetail');
    if (detailContainer) {
        detailContainer.innerHTML = '<div class="rc-empty">Select a learner from the list to view grades and generate SF9.</div>';
    }
}

function gradeTextToneClass(value) {
    if (!hasQuarterGrade(value)) return '';
    const num = Number(value);
    if (!Number.isFinite(num)) return '';
    return num >= 75 ? 'grade-text-pass' : 'grade-text-fail';
}

function toReportCardGrade(value) {
    if (value === null || value === undefined || value === '' || value === '--') return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.max(60, Math.min(100, Math.round(num)));
}

function computeReportCardAverage(values) {
    const nums = values
        .map((value) => toReportCardGrade(value))
        .filter((value) => Number.isFinite(value));
    if (!nums.length) return null;
    return Math.max(60, Math.min(100, Math.round(nums.reduce((sum, value) => sum + value, 0) / nums.length)));
}

function formatUiGradeCell(rawValue) {
    const grade = toReportCardGrade(rawValue);
    if (grade === null) {
        return '<span class="grade-text-empty">--</span>';
    }
    const text = String(grade);
    const tone = gradeTextToneClass(grade);
    const cls = tone ? `grade-text ${tone}` : 'grade-text';
    return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

// Utility functions
function getInitials(name) {
    const parts = name.replace(/,/g, '').split(' ');
    return parts.slice(0, 2).map(part => part.charAt(0).toUpperCase()).join('');
}

function getAvatarColor(id) {
    const colors = ['av-blue', 'av-green', 'av-amber', 'av-rose', 'av-purple', 'av-teal'];
    return colors[id % colors.length];
}

function getGWAClass(gwa) {
    const num = parseFloat(gwa);
    if (num >= 90) return 'gwa-outstanding';
    if (num >= 85) return 'gwa-very-satisfactory';
    if (num >= 80) return 'gwa-satisfactory';
    if (num >= 75) return 'gwa-fairly-satisfactory';
    return 'gwa-did-not-meet';
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getActiveSf9TermCommentFields() {
    const iframe = document.getElementById('sf9Frame');
    return Array.from(iframe?.contentDocument?.querySelectorAll('[data-term-comment]') || []);
}

function getActiveSf9DescriptiveFields() {
    const iframe = document.getElementById('sf9Frame');
    return Array.from(iframe?.contentDocument?.querySelectorAll('[data-descriptive-field]') || []);
}

function getActiveSf9PaceRatingFields() {
    const iframe = document.getElementById('sf9Frame');
    return Array.from(iframe?.contentDocument?.querySelectorAll('[data-pace-rating="true"]') || []);
}

function getActiveSf9EditableFields() {
    return [...getActiveSf9TermCommentFields(), ...getActiveSf9DescriptiveFields(), ...getActiveSf9PaceRatingFields()];
}

function normalizeSf9TermCommentText(value) {
    return String(value ?? '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r\n/g, '\n')
        .trim();
}

function serializeSf9EditableFields(fields = getActiveSf9EditableFields()) {
    return fields.map((field) => {
        let key = '';
        if (field.dataset.termComment === 'true') {
            key = `comment:${String(field.dataset.gradingPeriodId || '')}`;
        } else if (field.dataset.paceRating === 'true') {
            key = `pace:${String(field.dataset.gradingPeriodId || '')}:${String(field.dataset.catalogKey || '')}`;
        } else {
            key = `descriptive:${String(field.dataset.descriptiveField || '')}:${String(field.dataset.termNumber || '')}`;
        }
        return [key, normalizeSf9TermCommentText(field.innerText)].join(':');
    }).join('|');
}

function updateSf9RemarksUi(fields = getActiveSf9TermCommentFields()) {
    const saveButton = document.getElementById('saveSf9Remarks');
    const hint = document.getElementById('sf9RemarksHint');
    const hintText = hint?.querySelector('[data-sf9-hint-text]');

    if (hint) {
        const supportsEditableFields = activeSf9SupportsTermComments || activeSf9SupportsDescriptiveFields || activeSf9SupportsPaceRatings;
        hint.hidden = !supportsEditableFields;
        if (hintText) {
            hintText.textContent = activeSf9SupportsPaceRatings
                ? 'Grade 1: enter A–E in the colored PACE skill cells or rating column, then choose Save PACE Ratings. Narrative boxes and signatures remain print-only.'
                : activeSf9SupportsDescriptiveFields
                    ? 'Descriptive SF9 narrative fields are editable in this preview for printing; those narrative entries are not stored in the system.'
                : 'Teacher\'s Comments / Remarks fields are editable in this SF9 preview. Click a term field to encode remarks; Save Remarks appears after you make changes.';
        }
    }
    if (saveButton) {
        const canSave = (activeSf9SupportsTermComments && activeSf9TermCommentsDirty)
            || (activeSf9SupportsPaceRatings && activeSf9PaceRatingsDirty);
        saveButton.hidden = !canSave;
        saveButton.style.display = canSave ? '' : 'none';
        if (!saveButton.disabled) {
            saveButton.innerHTML = activeSf9PaceRatingsDirty
                ? '<i class="fas fa-save"></i> Save PACE Ratings'
                : '<i class="fas fa-save"></i> Save Remarks';
        }
    }
}

function initializeSf9TermCommentsPreview() {
    const commentFields = getActiveSf9TermCommentFields();
    const descriptiveFields = getActiveSf9DescriptiveFields();
    const paceFields = getActiveSf9PaceRatingFields();
    const fields = [...commentFields, ...descriptiveFields, ...paceFields];
    activeSf9TermCommentsSnapshot = serializeSf9EditableFields(commentFields);
    activeSf9DescriptiveFieldsSnapshot = serializeSf9EditableFields(descriptiveFields);
    activeSf9PaceRatingsSnapshot = serializeSf9EditableFields(paceFields);
    activeSf9TermCommentsDirty = false;
    activeSf9DescriptiveFieldsDirty = false;
    activeSf9PaceRatingsDirty = false;
    fields.forEach((field) => {
        if (field.dataset.sf9CommentBound === 'true') return;
        field.dataset.sf9CommentBound = 'true';
        if (field.dataset.paceRating === 'true') {
            field.addEventListener('keydown', handleSf9PaceRatingKeydown);
            field.addEventListener('paste', handleSf9PaceRatingPaste);
            field.addEventListener('input', sanitizeSf9PaceRatingInput);
        }
        field.addEventListener('input', updateSf9TermCommentsDirty);
    });
    updateSf9RemarksUi(fields);
}

function updateSf9TermCommentsDirty() {
    const commentFields = getActiveSf9TermCommentFields();
    const descriptiveFields = getActiveSf9DescriptiveFields();
    const paceFields = getActiveSf9PaceRatingFields();
    activeSf9TermCommentsDirty = activeSf9SupportsTermComments
        && serializeSf9EditableFields(commentFields) !== activeSf9TermCommentsSnapshot;
    activeSf9DescriptiveFieldsDirty = activeSf9SupportsDescriptiveFields
        && serializeSf9EditableFields(descriptiveFields) !== activeSf9DescriptiveFieldsSnapshot;
    activeSf9PaceRatingsDirty = activeSf9SupportsPaceRatings
        && serializeSf9EditableFields(paceFields) !== activeSf9PaceRatingsSnapshot;
    updateSf9RemarksUi([...commentFields, ...descriptiveFields, ...paceFields]);
}

function dispatchSf9PaceRatingInput(field, inputType = 'insertText') {
    const InputEventType = field.ownerDocument.defaultView?.InputEvent || InputEvent;
    field.dispatchEvent(new InputEventType('input', { bubbles: true, inputType }));
}

function setSf9PaceRating(field, value, inputType = 'insertText') {
    const normalized = String(value || '').trim().toUpperCase();
    field.textContent = /^[A-E]$/.test(normalized) ? normalized : '';
    dispatchSf9PaceRatingInput(field, inputType);
}

function handleSf9PaceRatingKeydown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.key === 'Tab'
        || event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') return;
    if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        setSf9PaceRating(event.currentTarget, '', 'deleteContentBackward');
        return;
    }
    if (/^[a-e]$/i.test(event.key)) {
        event.preventDefault();
        setSf9PaceRating(event.currentTarget, event.key);
        return;
    }
    event.preventDefault();
}

function handleSf9PaceRatingPaste(event) {
    event.preventDefault();
    const pasted = event.clipboardData?.getData('text') || '';
    const match = pasted.toUpperCase().match(/[A-E]/);
    setSf9PaceRating(event.currentTarget, match?.[0] || '');
}

function sanitizeSf9PaceRatingInput(event) {
    const field = event.currentTarget;
    const normalized = String(field.innerText || '').trim().toUpperCase();
    if (normalized !== field.textContent) {
        field.textContent = /^[A-E]$/.test(normalized) ? normalized : '';
    }
}

async function confirmDiscardUnsavedSf9TermComments() {
    if (!activeSf9TermCommentsDirty && !activeSf9DescriptiveFieldsDirty && !activeSf9PaceRatingsDirty) return true;

    const hasUnsavedPace = activeSf9PaceRatingsDirty;
    const isDescriptive = activeSf9DescriptiveFieldsDirty;
    const title = hasUnsavedPace
        ? 'Unsaved Grade 1 PACE ratings'
        : (isDescriptive ? 'Unprinted descriptive SF9 entries' : 'Unsaved teacher remarks');
    const message = hasUnsavedPace
        ? 'Save PACE Ratings before closing. Unsaved A–E entries will be lost.'
        : (isDescriptive
            ? 'Print the SF9 preview first. Descriptive narrative entries are only held in this preview and will be lost when it closes.'
            : 'Save your comments/remarks first. Unsaved entries will be lost.');
    if (typeof window.confirmUnsavedChanges === 'function') {
        return window.confirmUnsavedChanges({
            title,
            message,
            confirmLabel: 'Leave without saving',
            cancelLabel: 'Stay',
        });
    }

    if (typeof window.confirm === 'function') {
        return window.confirm(`${title}\n\n${message}\n\nLeave without saving?`);
    }
    return true;
}

function resetSf9TermCommentsState() {
    activeSf9EnrollmentId = null;
    activeSf9SupportsTermComments = false;
    activeSf9SupportsDescriptiveFields = false;
    activeSf9TermCommentsSnapshot = '';
    activeSf9TermCommentsDirty = false;
    activeSf9DescriptiveFieldsDirty = false;
    activeSf9DescriptiveFieldsSnapshot = '';
    activeSf9SupportsPaceRatings = false;
    activeSf9PaceRatingsSnapshot = '';
    activeSf9PaceRatingsDirty = false;
    updateSf9RemarksUi([]);
}

function installSf9TermCommentsLeaveGuard() {
    window.addEventListener('beforeunload', (event) => {
        if (!activeSf9TermCommentsDirty && !activeSf9DescriptiveFieldsDirty && !activeSf9PaceRatingsDirty) return;
        event.preventDefault();
        event.returnValue = '';
    });

    document.addEventListener('click', async (event) => {
        if (!activeSf9TermCommentsDirty && !activeSf9DescriptiveFieldsDirty && !activeSf9PaceRatingsDirty) return;
        const link = event.target?.closest?.('a[href]');
        if (!link) return;
        const href = String(link.getAttribute('href') || '');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        event.preventDefault();
        event.stopPropagation();
        if (await confirmDiscardUnsavedSf9TermComments()) {
            resetSf9TermCommentsState();
            window.location.href = link.href;
        }
    }, true);
}

function isGradeOneDescriptiveSf9(data) {
    const enrollment = data?.enrollment || data || {};
    return String(enrollment.grading_mode || '').toLowerCase() === 'descriptive'
        && String(enrollment.sf9_template_variant || '').toUpperCase() === 'G1';
}

function ensureDescriptiveSf9Template() {
    if (!window.Sf9PaceTemplate) throw new Error('The shared Grade 1 PACE template is unavailable.');
    return window.Sf9PaceTemplate.load();
}

function appendDescriptivePacePages(documentHtml, data) {
    if (!window.Sf9PaceTemplate) return documentHtml;
    return window.Sf9PaceTemplate.appendPages(documentHtml, data, { editable: false });
}

async function openSf9Modal(enrollmentId) {
    if (!(await confirmDiscardUnsavedSf9TermComments())) {
        resetMobilePreviewActionButtons();
        return;
    }

    try {
        const data = await reportCardsApi.sf9ByEnrollment(enrollmentId);
        if (!data || data.success === false) throw new Error(data?.message || 'Unable to load SF9 data.');
        if (isGradeOneDescriptiveSf9(data)) await ensureDescriptiveSf9Template();

        const iframe = document.getElementById('sf9Frame');
        if (!iframe) throw new Error('SF9 preview frame is missing.');

        const html = buildSf9DocumentHtml(ensureSf9Defaults(data));
        activeSf9EnrollmentId = Number(enrollmentId || 0);
        const isDescriptive = isHandwrittenDescriptiveSf9(data);
        activeSf9SupportsTermComments = !isDescriptive
            && Boolean(data?.enrollment?.supports_term_comments);
        activeSf9SupportsDescriptiveFields = isDescriptive && !isGradeOneDescriptiveSf9(data);
        activeSf9SupportsPaceRatings = false;
        activeSf9TermCommentsSnapshot = '';
        activeSf9TermCommentsDirty = false;
        activeSf9DescriptiveFieldsDirty = false;
        activeSf9DescriptiveFieldsSnapshot = '';
        activeSf9PaceRatingsSnapshot = '';
        activeSf9PaceRatingsDirty = false;
        const saveRemarksButton = document.getElementById('saveSf9Remarks');
        if (saveRemarksButton) {
            saveRemarksButton.hidden = true;
            saveRemarksButton.style.display = 'none';
            saveRemarksButton.disabled = false;
            saveRemarksButton.innerHTML = '<i class="fas fa-save"></i> Save Remarks';
        }
        updateSf9RemarksUi([]);
        setPrintModalTitle('SF9 Report Card (Preview)');
        iframe.onload = initializeSf9TermCommentsPreview;
        iframe.srcdoc = html;
        showSf9Modal();
    } catch (err) {
        resetMobilePreviewActionButtons();
        if (window.Swal) {
            Swal.fire({ icon: 'error', title: 'SF9 Document', text: err?.response?.data?.message || err?.message || 'Unable to load SF9 data.' });
        }
    }
}

async function saveSf9TermComments() {
    if (activeSf9SupportsPaceRatings && activeSf9PaceRatingsDirty) {
        await saveSf9PaceRatings();
        return;
    }
    const commentFields = getActiveSf9TermCommentFields();
    if (!activeSf9EnrollmentId || !commentFields.length) return;

    const saveButton = document.getElementById('saveSf9Remarks');
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving';
    }
    try {
        const comments = commentFields
            .map((field) => ({
                grading_period_id: Number(field.dataset.gradingPeriodId || 0),
                comment_text: normalizeSf9TermCommentText(field.innerText),
            }))
            .filter((comment) => comment.grading_period_id > 0);
        await reportCardsApi.saveTermComments(activeSf9EnrollmentId, comments);
        activeSf9TermCommentsSnapshot = serializeSf9EditableFields(commentFields);
        activeSf9TermCommentsDirty = false;
        if (window.Swal) {
            await Swal.fire({ icon: 'success', title: 'Remarks saved', text: 'Teacher comments were saved for this learner.', timer: 1500, showConfirmButton: false });
        }
    } catch (error) {
        if (window.Swal) {
            await Swal.fire({ icon: 'error', title: 'Unable to save remarks', text: error?.response?.data?.message || error?.message || 'Please try again.' });
        }
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.innerHTML = '<i class="fas fa-save"></i> Save Remarks';
        }
        updateSf9RemarksUi(commentFields);
    }
}

async function saveSf9PaceRatings() {
    const fields = getActiveSf9PaceRatingFields();
    if (!activeSf9EnrollmentId || !fields.length) return;

    const saveButton = document.getElementById('saveSf9Remarks');
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving';
    }
    try {
        const ratings = fields.map((field) => ({
            grading_period_id: Number(field.dataset.gradingPeriodId || 0),
            catalog_key: String(field.dataset.catalogKey || ''),
            rating_code: normalizeSf9TermCommentText(field.innerText).toUpperCase(),
        }));
        await reportCardsApi.savePaceRatings(activeSf9EnrollmentId, ratings);
        activeSf9PaceRatingsSnapshot = serializeSf9EditableFields(fields);
        activeSf9PaceRatingsDirty = false;
        if (window.Swal) {
            await Swal.fire({ icon: 'success', title: 'PACE ratings saved', text: 'Grade 1 ratings were saved for this learner.', timer: 1500, showConfirmButton: false });
        }
    } catch (error) {
        if (window.Swal) {
            await Swal.fire({ icon: 'error', title: 'Unable to save PACE ratings', text: error?.response?.data?.message || error?.message || 'Please try again.' });
        }
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.innerHTML = '<i class="fas fa-save"></i> Save PACE Ratings';
        }
        updateSf9RemarksUi([...getActiveSf9TermCommentFields(), ...getActiveSf9DescriptiveFields(), ...fields]);
    }
}

function fitPreviewDocumentToViewport(iframe) {
    const documentRoot = iframe?.contentDocument?.documentElement;
    const previewDocument = iframe?.contentDocument;
    if (!documentRoot || !previewDocument?.body) return;

    const previewItems = Array.from(previewDocument.querySelectorAll('.page, .grade-slip, .sf9-reference-sheet'));
    if (!previewItems.length) return;

    let fitStyle = previewDocument.getElementById('previewFitStyle');
    if (!fitStyle) {
        fitStyle = previewDocument.createElement('style');
        fitStyle.id = 'previewFitStyle';
        fitStyle.textContent = `
            @media screen {
                html.preview-fit-mode {
                    min-height: 100%;
                    overflow: auto;
                    background: #e6e9ee;
                }
                html.preview-fit-mode.sf9-reference-preview {
                    background: #e5e7eb;
                }
                html.preview-fit-mode body {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: flex-start;
                    width: 100%;
                    height: auto;
                    min-width: 0;
                    min-height: 100%;
                    margin: 0;
                    padding: 14px 10px 24px;
                    gap: 0;
                    background: #e6e9ee;
                    overflow: auto;
                }
                html.preview-fit-mode body.sf9-reference-preview {
                    background: #e5e7eb;
                }
                html.preview-fit-mode .preview-fit-shell {
                    flex: 0 0 auto;
                    position: relative;
                    width: calc(var(--preview-page-width) * var(--preview-page-scale));
                    height: calc(var(--preview-page-height) * var(--preview-page-scale));
                    margin: 0 auto;
                    overflow: visible;
                    background: transparent;
                }
                html.preview-fit-mode body.sf9-reference-preview .preview-fit-shell {
                    background: transparent;
                    box-shadow: none;
                    overflow: visible;
                }
                html.preview-fit-mode .preview-fit-shell > .page,
                html.preview-fit-mode .preview-fit-shell > .sf9-reference-sheet,
                html.preview-fit-mode .preview-fit-shell > .grade-slip {
                    position: absolute;
                    top: 0;
                    left: 0;
                    margin: 0;
                    transform: scale(var(--preview-page-scale));
                    transform-origin: top left;
                    border: 1px solid #d2d8e0;
                    box-shadow: 0 12px 28px rgba(35, 48, 63, .18), 0 2px 6px rgba(35, 48, 63, .1);
                }
                html.preview-fit-mode .preview-fit-shell > .grade-slip {
                    width: 190mm;
                    max-width: 190mm;
                }
            }
            @media print {
                html.preview-fit-mode { background: #fff; }
                html.preview-fit-mode body {
                    display: block;
                    height: auto;
                    min-height: 0;
                    padding: 0;
                    overflow: visible;
                    background: #fff;
                }
                html.preview-fit-mode .preview-fit-shell { display: contents; }
                html.preview-fit-mode .preview-fit-shell > .page,
                html.preview-fit-mode .preview-fit-shell > .sf9-reference-sheet,
                html.preview-fit-mode .preview-fit-shell > .grade-slip {
                    position: static;
                    margin: 0;
                    transform: none;
                    border: 0;
                    box-shadow: none;
                    page-break-after: always;
                    break-after: page;
                }
                html.preview-fit-mode .preview-fit-shell > .grade-slip {
                    width: 100%;
                    max-width: none;
                }
                html.preview-fit-mode .preview-fit-shell:last-child > .page,
                html.preview-fit-mode .preview-fit-shell:last-child > .sf9-reference-sheet,
                html.preview-fit-mode .preview-fit-shell:last-child > .grade-slip {
                    page-break-after: auto;
                    break-after: auto;
                }
            }
        `;
        previewDocument.head?.appendChild(fitStyle);
    }

    documentRoot.classList.add('preview-fit-mode');
    documentRoot.classList.toggle('preview-fit-single', previewItems.length === 1);
    documentRoot.classList.toggle('preview-fit-multi', previewItems.length > 1);
    previewItems.forEach((item) => {
        let shell = item.parentElement?.classList.contains('preview-fit-shell') ? item.parentElement : null;
        if (!shell) {
            shell = previewDocument.createElement('div');
            shell.className = 'preview-fit-shell';
            item.parentNode?.insertBefore(shell, item);
            shell.appendChild(item);
        }

        const sourceWidth = Number(item.offsetWidth || item.scrollWidth || shell.dataset.previewWidth || 0);
        const sourceHeight = Number(item.offsetHeight || item.scrollHeight || shell.dataset.previewHeight || 0);
        if (!sourceWidth || !sourceHeight) return;

        shell.dataset.previewWidth = String(sourceWidth);
        shell.dataset.previewHeight = String(sourceHeight);
        const viewportWidth = Math.max(240, iframe.clientWidth || documentRoot.clientWidth || sourceWidth);
        const viewportHeight = Math.max(320, iframe.clientHeight || documentRoot.clientHeight || sourceHeight);
        const widthScale = (viewportWidth - 16) / sourceWidth;
        const heightScale = (viewportHeight - 16) / sourceHeight;
        const scale = Math.min(1, Math.max(0.12, Math.min(widthScale, heightScale)));
        shell.style.setProperty('--preview-page-width', `${sourceWidth}px`);
        shell.style.setProperty('--preview-page-height', `${sourceHeight}px`);
        shell.style.setProperty('--preview-page-scale', String(scale));
    });
}

function showSf9Modal() {
    const modal = document.getElementById('sf9Modal');
    if (modal) {
        modal.classList.add('show');
        modal.style.display = 'flex';
        const iframe = document.getElementById('sf9Frame');
        window.requestAnimationFrame(() => fitPreviewDocumentToViewport(iframe));
    }
}

function resetMobilePreviewActionButtons() {
    const preview = document.getElementById('rcMobileLearnerPreview');
    if (!preview || !preview.classList.contains('is-open')) return;
    const sf9Button = document.getElementById('rcMobileGenerateSf9');
    const gradeSlipButton = document.getElementById('rcMobileGenerateGradeSlip');
    if (sf9Button) sf9Button.disabled = false;
    if (gradeSlipButton && !gradeSlipButton.hidden) gradeSlipButton.disabled = false;
}

async function closeSf9Modal() {
    if (!(await confirmDiscardUnsavedSf9TermComments())) return;

    const modal = document.getElementById('sf9Modal');
    if (modal) {
        modal.classList.remove('show');
        modal.style.display = '';
        setPrintModalTitle('SF9 Report Card (Preview)');
        const iframe = document.getElementById('sf9Frame');
        if (iframe) {
            iframe.onload = null;
            iframe.srcdoc = '';
        }
    }
    resetSf9TermCommentsState();
    resetMobilePreviewActionButtons();
}

function setPrintModalTitle(title) {
    const modalTitle = document.getElementById('sf9ModalTitle') || document.querySelector('#sf9Modal .modal-title');
    if (modalTitle) modalTitle.textContent = title || 'SF9 Report Card (Preview)';
}

function printSf9() {
    const iframe = document.getElementById('sf9Frame');
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
}

function getGradeSlipPeriodValue(grade, period) {
    return grade?.[period.key] ?? grade?.[`${period.key}_grade`] ?? '';
}

function renderGradeSlipRows(grades, periods) {
    const rows = Array.isArray(grades) ? grades : [];
    if (!rows.length) {
        return `<tr><td colspan="${periods.length + 3}" class="empty">No grades available.</td></tr>`;
    }

    return rows.map((grade) => {
        const periodValues = periods.map((period) => toReportCardGrade(getGradeSlipPeriodValue(grade, period)));
        const complete = periodValues.every(hasQuarterGrade);
        const explicitFinal = toReportCardGrade(grade?.final_grade ?? grade?.final_rating ?? grade?.finalRating);
        const finalGrade = explicitFinal ?? (complete ? computeReportCardAverage(periodValues) : null);
        const subject = grade.subject_name || grade.subject || '';
        const isComponent = !!grade._isComponentBreakdown;
        const isMapehParent = !!grade._isMapehParentDisplay;
        const rowClass = [isMapehParent ? 'parent-row' : '', isComponent ? 'component-row' : ''].filter(Boolean).join(' ');
        const showFinal = Number.isFinite(finalGrade) && !isComponent;
        const finalClass = showFinal ? (Number(finalGrade) < 75 ? 'fail' : 'pass') : '';

        return `
            <tr class="${rowClass}">
                <td class="subject">${isComponent ? '<span class="component-dot">•</span>' : ''}${isMapehParent ? `<strong>${escapeHtml(subject)}</strong>` : escapeHtml(subject)}</td>
                ${periodValues.map((value) => `<td class="grade">${formatRating(value)}</td>`).join('')}
                <td class="grade final ${finalClass}">${showFinal ? escapeHtml(String(finalGrade)) : ''}</td>
                <td class="remarks">${showFinal ? escapeHtml(remarksFor(finalGrade)) : ''}</td>
            </tr>
        `;
    }).join('');
}

function buildGradeSlipCommentsMarkup(termComments, periods, enrollment = {}) {
    const supportsTermComments = enrollment.grading_mode !== 'Descriptive'
        && Boolean(enrollment.supports_term_comments);
    if (!supportsTermComments || !periods.length) return '';

    const commentsByPeriod = new Map((Array.isArray(termComments) ? termComments : [])
        .map((comment) => [String(comment?.grading_period_id || ''), String(comment?.comment_text || '')]));

    return `
        <section class="slip-comments" aria-label="Teacher's Comments / Remarks">
            <h2>Teacher's Comments / Remarks</h2>
            <table class="slip-comments-table">
                <thead>
                    <tr><th>Term</th><th>Teacher's Comments / Remarks</th></tr>
                </thead>
                <tbody>
                    ${periods.map((period) => `
                        <tr>
                            <th scope="row" class="slip-comment-period">${escapeHtml(period.name || period.label)}</th>
                            <td class="slip-comment-text">${escapeHtml(commentsByPeriod.get(String(period.grading_period_id || '')) || '')}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </section>
    `;
}

function buildGradeSlipHtml(data, { index = 0 } = {}) {
    const sf9Data = ensureSf9Defaults(data);
    const learner = sf9Data?.learner || {};
    const enrollment = sf9Data?.enrollment || {};
    const school = sf9Data?.school || {};
    const periods = getReportPeriods(sf9Data);
    const grades = Array.isArray(sf9Data?.grades) ? sf9Data.grades : [];
    const termComments = sf9Data?.term_comments || [];
    const sanitizedGrades = grades.map((row) => sanitizeGradeRow(row, periods));
    // Keep grade-slip subjects aligned with the report-card display, including
    // dynamic curriculum subjects and the MAPEH parent/component rows.
    const displayGrades = flattenGradeSummaryRows(sanitizedGrades, periods);
    const schoolName = school.name || school.school_name || 'School';
    const schoolLogo = blankIfInvalid(school.logo_url);
    const gradeSection = [enrollment.grade_level, enrollment.section].filter(Boolean).join(' - ');

    return `
        <section class="grade-slip" aria-label="Grade slip ${index + 1}">
            <header class="slip-header">
                <div class="slip-school-block">
                    ${schoolLogo ? `<img class="slip-school-logo" src="${escapeHtml(schoolLogo)}" alt="G.Pelaez Integrated School logo">` : ''}
                    <div class="school-lines">
                        <div class="school-name">${escapeHtml(schoolName)}</div>
                    </div>
                </div>
                <div class="slip-title">
                    <strong>Grade Slip</strong>
                </div>
            </header>

            <div class="learner-grid">
                <div class="learner-identity">
                    <span class="slip-school-year">${escapeHtml(enrollment.school_year || '')}</span>
                    <strong>${escapeHtml(learner.name || '')}</strong>
                    ${learner.lrn ? `<small class="slip-learner-lrn">${escapeHtml(learner.lrn)}</small>` : ''}
                </div>
                <div class="slip-placement" aria-label="Grade and section">
                    <strong>${escapeHtml(gradeSection)}</strong>
                </div>
            </div>

            <table class="slip-grade-table">
                <thead>
                    <tr>
                        <th>Subject</th>
                        ${periods.map((period) => `<th>${escapeHtml(period.label)}</th>`).join('')}
                        <th>Final</th>
                        <th>Remarks</th>
                    </tr>
                </thead>
                <tbody>
                    ${renderGradeSlipRows(displayGrades, periods)}
                </tbody>
            </table>

            ${buildGradeSlipCommentsMarkup(termComments, periods, enrollment)}

            <footer class="slip-footer">
                <div class="signature-box">
                    <span>Parent/Guardian Signature</span>
                    <strong></strong>
                </div>
            </footer>
            <p class="slip-note">This slip is for parent/guardian information. Return to adviser is optional unless requested.</p>
        </section>
    `;
}

function buildGradeSlipDocumentHtml(sf9DataList, { section = '', schoolYear = '' } = {}) {
    const list = (Array.isArray(sf9DataList) ? sf9DataList : [sf9DataList]).filter(Boolean);
    const firstData = list[0] || {};
    const title = list.length > 1
        ? ['Grade Slips', section].filter(Boolean).join(' - ')
        : ['Grade Slip', firstData?.learner?.name].filter(Boolean).join(' - ');
    const slips = list.map((data, index) => buildGradeSlipHtml(data, { index })).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title || 'Grade Slip')}</title>
<style>
@page { size: auto; margin: 6mm; }
* { box-sizing: border-box; }
html, body { width: 100%; min-width: 0; margin: 0; padding: 0; background: #f3f4f6; color: #111827; font-family: Arial, Helvetica, sans-serif; }
body { padding: clamp(8px, 2vw, 24px); }
.grade-slip { width: 100%; max-width: 190mm; margin: 0 auto clamp(12px, 2vw, 24px); background: #fff; border: 1px solid #111827; break-inside: avoid; page-break-inside: avoid; padding: clamp(12px, 1.8vw, 30px); }
.slip-header { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding-bottom: 0; }
.slip-school-block { display: flex; align-items: center; gap: 8px; flex: 1 1 22rem; min-width: 0; }
.slip-school-logo { width: clamp(52px, 7vw, 72px); height: clamp(52px, 7vw, 72px); object-fit: contain; flex: 0 0 auto; padding: 1px; }
.school-lines { min-width: 0; overflow-wrap: anywhere; font-size: 10px; line-height: 1.35; color: #374151; }
.school-name { font-size: 13px; font-weight: 700; color: #111827; text-transform: uppercase; }
.slip-title { flex: 0 1 auto; min-width: 9rem; text-align: right; font-size: 11px; color: #4b5563; }
.slip-title strong { display: block; font-size: 18px; color: #111827; text-transform: uppercase; letter-spacing: 0; }
.learner-grid { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(12rem, .9fr); align-items: end; gap: 1.25rem; margin: 16px 0 14px; padding: 0; }
.learner-grid div { min-width: 0; padding: 0; min-height: 0; overflow-wrap: anywhere; }
.learner-grid span, .signature-box span { display: block; font-size: 8px; color: #6b7280; text-transform: uppercase; font-weight: 700; }
.learner-grid span { margin-bottom: 5px; letter-spacing: .05em; }
.learner-grid strong { display: block; margin-top: 0; font-size: clamp(14px, 1.25vw, 17px); line-height: 1.2; color: #111827; overflow-wrap: anywhere; }
.slip-school-year { color: #374151 !important; font-size: 10px !important; letter-spacing: .08em; }
.slip-learner-lrn { display: block; margin-top: 4px; color: #4b5563; font-size: 11px; font-weight: 700; letter-spacing: .06em; }
.slip-placement { display: flex; align-items: flex-end; justify-content: flex-end; min-width: 0; text-align: right; }
.slip-placement strong { margin-top: 0; }
.slip-grade-table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; font-size: clamp(8px, .75vw, 10px); }
.slip-grade-table th, .slip-grade-table td { border: 1px solid #d1d5db; padding: clamp(3px, .4vw, 5px); vertical-align: middle; overflow-wrap: anywhere; word-break: break-word; }
.slip-grade-table th { background: #f9fafb; font-size: 8px; text-transform: uppercase; color: #374151; }
.slip-grade-table th:first-child { text-align: left; width: 35%; }
.slip-grade-table th:last-child { width: 13%; }
.subject { font-weight: 600; text-align: left; }
.component-row .subject { padding-left: 14px; font-style: italic; font-weight: 500; }
.component-dot { margin-right: 4px; }
.grade, .remarks { text-align: center; font-weight: 700; }
.final.pass { color: #166534; }
.final.fail { color: #991b1b; }
.empty { text-align: center; color: #6b7280; padding: 14px !important; }
.slip-comments { margin-top: 10px; break-inside: avoid; page-break-inside: avoid; }
.slip-comments h2 { margin: 0 0 4px; font-size: 10px; text-transform: uppercase; letter-spacing: .02em; }
.slip-comments-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9px; }
.slip-comments-table th, .slip-comments-table td { border: 1px solid #d1d5db; padding: 4px 5px; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
.slip-comments-table thead th { background: #f9fafb; font-size: 8px; text-transform: uppercase; color: #374151; text-align: left; }
.slip-comments-table thead th:first-child { width: 23%; }
.slip-comment-period { font-weight: 700; text-align: left; }
.slip-comment-text { min-height: 18px; white-space: pre-wrap; text-align: left; }
.slip-footer { display: flex; justify-content: flex-end; margin-top: 10px; }
.signature-box { width: min(100%, 220px); padding-top: 14px; }
.signature-box strong { display: block; border-bottom: 1px solid #111827; height: 20px; }
.signature-box span { text-align: center; margin-top: 3px; }
.slip-note { margin: 8px 0 0; font-size: 9px; color: #4b5563; }
@media screen {
    .grade-slip { box-shadow: 0 12px 30px rgba(15, 23, 42, 0.12); }
}
@media (max-width: 640px) {
    body { padding: 8px; }
    .grade-slip { padding: 12px; }
    .slip-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 10px; }
    .slip-school-block { flex: none; min-width: 0; }
    .slip-title { width: auto; min-width: 0; text-align: right; }
    .learner-grid { grid-template-columns: minmax(0, 1.35fr) minmax(7.5rem, .9fr); gap: 10px; margin: 16px 0 12px; }
    .slip-placement { justify-content: flex-end; text-align: right; }
    .slip-grade-table { font-size: 8px; }
}
@media print {
    html, body { background: #fff !important; padding: 0; }
    .grade-slip { width: 100%; max-width: none; box-shadow: none !important; margin: 0; padding: 6mm; break-after: page; page-break-after: always; }
    .grade-slip:last-child { break-after: auto; page-break-after: auto; }
}
</style>
</head>
<body>
${slips}
</body>
</html>`;
}

async function openGradeSlipModal(enrollmentId) {
    if (!(await confirmDiscardUnsavedSf9TermComments())) {
        resetMobilePreviewActionButtons();
        return;
    }

    reportCardsApi.sf9ByEnrollment(enrollmentId)
        .then((data) => {
            if (!data || data.success === false) throw new Error(data?.message || 'Unable to load grade slip data.');
            if (isHandwrittenDescriptiveSf9(data)) {
                throw new Error('Descriptive Grades 1-3 use the handwritten SF9 and do not have digital grade slips.');
            }
            const iframe = document.getElementById('sf9Frame');
            if (!iframe) throw new Error('Grade slip preview frame is missing.');
            iframe.onload = null;
            resetSf9TermCommentsState();
            setPrintModalTitle('Grade Slip (Preview)');
            iframe.srcdoc = buildGradeSlipDocumentHtml(data);
            showSf9Modal();
        })
        .catch((err) => {
            resetMobilePreviewActionButtons();
            if (window.Swal) Swal.fire({ icon: 'error', title: 'Grade Slip', text: err?.response?.data?.message || err?.message || 'Unable to load grade slip data.' });
        });
}

async function openMyGradeSlipModal() {
    if (isLearnerRole()) return;
    if (!(await confirmDiscardUnsavedSf9TermComments())) return;

    const data = window.__learnerSf9Data;
    if (!data) return;
    const iframe = document.getElementById('sf9Frame');
    if (!iframe) return;
    iframe.onload = null;
    resetSf9TermCommentsState();
    setPrintModalTitle('Grade Slip (Preview)');
    iframe.srcdoc = buildGradeSlipDocumentHtml(data);
    showSf9Modal();
}

async function waitForContainerImages(container, timeoutMs = 8000) {
    const images = Array.from(container?.querySelectorAll?.('img') || []);
    if (!images.length) return;

    const start = Date.now();
    await Promise.all(images.map((image) => {
        if (image.complete && image.naturalWidth > 0) return Promise.resolve();
        return new Promise((resolve) => {
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                resolve();
            };
            image.addEventListener('load', done, { once: true });
            image.addEventListener('error', done, { once: true });
            const poll = () => {
                if (settled) return;
                if ((image.complete && image.naturalWidth > 0) || Date.now() - start > timeoutMs) done();
                else setTimeout(poll, 150);
            };
            poll();
        });
    }));
}

async function ensureHtml2Pdf() {
    if (window.html2pdf) return window.html2pdf;

    await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-sf9-html2pdf="1"]');
        if (existing) {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', () => reject(new Error('Failed to load PDF library')), { once: true });
            return;
        }

        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
        script.async = true;
        script.dataset.sf9Html2pdf = '1';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load PDF library'));
        document.head.appendChild(script);
    });

    if (!window.html2pdf) throw new Error('PDF library is unavailable');
    return window.html2pdf;
}

function fileSafe(value) {
    return String(value ?? '')
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, '_')
        .slice(0, 90);
}

function exportFileName(value, fallback = 'Export') {
    const cleaned = String(value ?? fallback)
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/\s+-\s+/g, ' - ')
        .replace(/^[. ]+|[. ]+$/g, '')
        .slice(0, 140)
        .trim();
    return cleaned || fallback;
}

async function exportSf9Pdf() {
    const iframe = document.getElementById('sf9Frame');
    const srcdoc = String(iframe?.srcdoc || '').trim();
    if (!srcdoc) {
        if (window.Swal) Swal.fire('SF9 Export', 'Nothing to export yet. Open SF9 preview first.', 'info');
        return;
    }

    let mountInnerHtml = srcdoc;
    let titleText = '';
    try {
        const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
        const inlineStyle = doc.querySelector('style')?.textContent || '';
        const bodyHtml = doc.body?.innerHTML || '';
        titleText = doc.querySelector('title')?.textContent || '';
        mountInnerHtml = `${inlineStyle ? `<style>${inlineStyle}</style>` : ''}${bodyHtml}`;
    } catch (_) {
        // fallback
    }

    const html2pdfLib = await ensureHtml2Pdf();
    const mount = document.createElement('div');
    mount.style.position = 'absolute';
    mount.style.left = '0';
    mount.style.top = '0';
    mount.style.transform = 'translateX(120vw)';
    mount.style.opacity = '1';
    mount.style.pointerEvents = 'none';
    mount.style.zIndex = '2147483647';
    mount.style.width = '1200px';
    mount.style.background = '#ffffff';
    mount.innerHTML = mountInnerHtml;
    document.body.appendChild(mount);

    const waitForImages = async (container, timeoutMs = 6000) => {
        const imgs = Array.from(container.querySelectorAll('img'));
        if (!imgs.length) return;
        const start = Date.now();
        await Promise.all(imgs.map((img) => {
            if (img.complete && img.naturalWidth > 0) return Promise.resolve();
            return new Promise((resolve) => {
                const done = () => resolve();
                img.addEventListener('load', done, { once: true });
                img.addEventListener('error', done, { once: true });
                const poll = () => {
                    if ((img.complete && img.naturalWidth > 0) || (Date.now() - start) > timeoutMs) resolve();
                    else setTimeout(poll, 150);
                };
                poll();
            });
        }));
    };

    const filename = `${exportFileName(titleText, 'SF9 Report Card')}.pdf`;
    try {
        await waitForImages(mount);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        await html2pdfLib()
            .set({
                filename,
                margin: [0, 0, 0, 0],
                image: { type: 'jpeg', quality: 1 },
                html2canvas: { scale: 2, useCORS: true, allowTaint: true, backgroundColor: '#ffffff', scrollX: 0, scrollY: 0 },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
            })
            .from(mount)
            .save();
    } finally {
        mount.remove();
    }
}

function sf9MountMarkup(srcdoc) {
    try {
        const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
        const inlineStyle = doc.querySelector('style')?.textContent || '';
        const bodyHtml = doc.body?.innerHTML || '';
        const titleText = doc.querySelector('title')?.textContent || '';
        return { html: `${inlineStyle ? `<style>${inlineStyle}</style>` : ''}${bodyHtml}`, title: titleText };
    } catch (_) {
        return { html: srcdoc, title: '' };
    }
}

function sf9DocumentParts(srcdoc) {
    try {
        const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
        const styles = Array.from(doc.querySelectorAll('style')).map((style) => style.textContent || '').filter(Boolean);
        doc.querySelectorAll('.toolbar, .note, .page-tag, .no-print, script').forEach((node) => node.remove());
        const bodyHtml = doc.body?.innerHTML || '';
        const titleText = doc.querySelector('title')?.textContent || '';
        return { styles, bodyHtml, title: titleText };
    } catch (_) {
        return { styles: [], bodyHtml: srcdoc, title: '' };
    }
}

function buildSectionSf9PrintHtml(sf9DataList, { section = '', schoolYear = '' } = {}) {
    const styleSet = new Set();
    const learnerBlocks = sf9DataList.map((data, index) => {
        const documentHtml = buildSf9DocumentHtml(ensureSf9Defaults(data));
        const parts = sf9DocumentParts(documentHtml);
        parts.styles.forEach((style) => styleSet.add(style));
        const learner = data?.learner?.name || `Learner ${index + 1}`;
        return `
            <article class="sf9-batch-learner" aria-label="${escapeHtml(learner)}">
                ${parts.bodyHtml}
            </article>
        `;
    }).join('');

    const title = ['SF9 Report Cards', section, schoolYear].filter(Boolean).join(' - ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title || 'SF9 Section Print')}</title>
<style>
${Array.from(styleSet).join('\n\n')}

html, body {
    margin: 0;
    padding: 0;
    background: #fff;
}
.sf9-batch-learner {
    background: #fff;
}
.toolbar, .note, .page-tag, .no-print {
    display: none !important;
}
@media screen {
    body {
        background: #6b7280;
    }
    .sf9-batch-learner {
        margin: 0 auto;
    }
}
@media print {
    html, body {
        width: 100%;
        background: #fff !important;
        display: block !important;
        gap: 0 !important;
        padding: 0 !important;
    }
    .stage {
        padding: 0 !important;
    }
    .sf9-batch-learner {
        break-after: auto;
        page-break-after: auto;
    }
    .page {
        break-after: page;
        page-break-after: always;
        box-shadow: none !important;
    }
    .sf9-batch-learner:not(:last-child) .page:last-child {
        break-after: page;
        page-break-after: always;
    }
    .sf9-batch-learner:last-child .page:last-child {
        break-after: auto;
        page-break-after: auto;
    }
}
</style>
</head>
<body>
${learnerBlocks}
</body>
</html>`;
}

async function loadSectionSf9Data(students) {
    const results = new Array(students.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(4, students.length) }, async () => {
        while (nextIndex < students.length) {
            const index = nextIndex++;
            const data = await reportCardsApi.sf9ByEnrollment(students[index].enrollment_id);
            if (!data || data.success === false) throw new Error(data?.message || `Unable to load ${students[index].name}'s SF9 data.`);
            results[index] = data;
        }
    });
    await Promise.all(workers);
    return results;
}

async function printSectionSf9() {
    if (!currentSectionId || !currentStudents.length) {
        if (window.Swal) Swal.fire('Section Print', 'Choose a section with enrolled learners first.', 'info');
        return;
    }

    updateBatchExportButton(true);
    try {
        const sf9Data = await loadSectionSf9Data(currentStudents);
        if (sf9Data.some((data) => isGradeOneDescriptiveSf9(data))) await ensureDescriptiveSf9Template();
        const printFrame = document.createElement('iframe');
        printFrame.title = 'Section SF9 Print';
        printFrame.style.position = 'fixed';
        printFrame.style.right = '0';
        printFrame.style.bottom = '0';
        printFrame.style.width = '0';
        printFrame.style.height = '0';
        printFrame.style.border = '0';
        printFrame.style.opacity = '0';
        printFrame.setAttribute('aria-hidden', 'true');
        document.body.appendChild(printFrame);

        const html = buildSectionSf9PrintHtml(sf9Data, {
            section: currentStudents[0]?.section || '',
            schoolYear: currentStudents[0]?.school_year || ''
        });

        try {
            const doc = printFrame.contentDocument || printFrame.contentWindow?.document;
            if (!doc) throw new Error('Print frame is unavailable.');
            doc.open();
            doc.write(html);
            doc.close();

            await waitForContainerImages(doc.body, 8000);
            await new Promise((resolve) => setTimeout(resolve, 250));
            printFrame.contentWindow?.focus();
            printFrame.contentWindow?.print();
            setTimeout(() => printFrame.remove(), 30000);
        } catch (error) {
            printFrame.remove();
            throw error;
        }
    } catch (error) {
        if (window.Swal) Swal.fire('Section Print', error?.response?.data?.message || error?.message || 'Unable to print section report cards.', 'error');
        else console.error('Unable to print section report cards:', error);
    } finally {
        updateBatchExportButton();
    }
}

async function printSectionGradeSlips() {
    if (!currentSectionId || !currentStudents.length) {
        if (window.Swal) Swal.fire('Grade Slips', 'Choose a section with enrolled learners first.', 'info');
        return;
    }

    updateBatchExportButton(true);
    try {
        const sf9Data = await loadSectionSf9Data(currentStudents);
        const printFrame = document.createElement('iframe');
        printFrame.title = 'Section Grade Slips';
        printFrame.style.position = 'fixed';
        printFrame.style.right = '0';
        printFrame.style.bottom = '0';
        printFrame.style.width = '0';
        printFrame.style.height = '0';
        printFrame.style.border = '0';
        printFrame.style.opacity = '0';
        printFrame.setAttribute('aria-hidden', 'true');
        document.body.appendChild(printFrame);

        const html = buildGradeSlipDocumentHtml(sf9Data, {
            section: currentStudents[0]?.section || '',
            schoolYear: currentStudents[0]?.school_year || ''
        });

        try {
            const doc = printFrame.contentDocument || printFrame.contentWindow?.document;
            if (!doc) throw new Error('Print frame is unavailable.');
            doc.open();
            doc.write(html);
            doc.close();

            await waitForContainerImages(doc.body, 8000);
            await new Promise((resolve) => setTimeout(resolve, 250));
            printFrame.contentWindow?.focus();
            printFrame.contentWindow?.print();
            setTimeout(() => printFrame.remove(), 30000);
        } catch (error) {
            printFrame.remove();
            throw error;
        }
    } catch (error) {
        if (window.Swal) Swal.fire('Grade Slips', error?.response?.data?.message || error?.message || 'Unable to print section grade slips.', 'error');
        else console.error('Unable to print section grade slips:', error);
    } finally {
        updateBatchExportButton();
    }
}

async function exportSectionSf9Pdf() {
    if (!currentSectionId || !currentStudents.length) {
        if (window.Swal) Swal.fire('Section Export', 'Choose a section with enrolled learners first.', 'info');
        return;
    }

    updateBatchExportButton(true);
    try {
        const [sf9Data, html2pdfLib] = await Promise.all([
            loadSectionSf9Data(currentStudents),
            ensureHtml2Pdf()
        ]);
        if (sf9Data.some((data) => isGradeOneDescriptiveSf9(data))) await ensureDescriptiveSf9Template();
        const mount = document.createElement('div');
        mount.style.position = 'absolute';
        mount.style.left = '0';
        mount.style.top = '0';
        mount.style.transform = 'translateX(120vw)';
        mount.style.pointerEvents = 'none';
        mount.style.zIndex = '2147483647';
        mount.style.width = '1200px';
        mount.style.background = '#ffffff';
        mount.innerHTML = sf9Data.map((data) => {
            const documentHtml = buildSf9DocumentHtml(ensureSf9Defaults(data));
            return `<section style="break-after:page; page-break-after:always; background:#fff;">${sf9MountMarkup(documentHtml).html}</section>`;
        }).join('');
        document.body.appendChild(mount);

        try {
            await waitForContainerImages(mount, 8000);
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            await html2pdfLib()
                .set({
                    filename: `${exportFileName([
                        'SF9 Report Cards',
                        currentStudents[0]?.section,
                        currentStudents[0]?.school_year,
                    ].filter(Boolean).join(' - '), 'SF9 Report Cards')}.pdf`,
                    margin: [0, 0, 0, 0],
                    image: { type: 'jpeg', quality: 1 },
                    html2canvas: { scale: 2, useCORS: true, allowTaint: true, backgroundColor: '#ffffff', scrollX: 0, scrollY: 0 },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
                    pagebreak: { mode: ['css', 'legacy'] }
                })
                .from(mount)
                .save();
        } finally {
            mount.remove();
        }
    } catch (error) {
        if (window.Swal) Swal.fire('Section Export', error?.response?.data?.message || error?.message || 'Unable to export section report cards.', 'error');
        else console.error('Unable to export section report cards:', error);
    } finally {
        updateBatchExportButton();
    }
}

function getSf9AppBase() {
    // Use existing APP_BASE if available
    if (typeof window.APP_BASE === 'string' && window.APP_BASE !== '') return window.APP_BASE;

    // Detect app base from current path (works for both localhost and Live Server)
    const pathname = String(window.location.pathname || '/');
    let appPrefix = '';

    if (pathname.includes('/dashboard/')) {
        appPrefix = pathname.split('/dashboard/')[0] || '';
    } else if (pathname.includes('/pages/')) {
        appPrefix = pathname.split('/pages/')[0] || '';
    } else if (pathname.includes('/api/')) {
        appPrefix = pathname.split('/api/')[0] || '';
    } else {
        const parts = pathname.split('/').filter(Boolean);
        appPrefix = parts.length ? `/${parts[0]}` : '';
    }

    if (appPrefix === '/') appPrefix = '';

    // Cache for future use
    window.APP_BASE = appPrefix;
    return appPrefix;
}

function getSf9LogoAssetUrl(filename) {
    const appBase = getSf9AppBase();
    return `${window.location.origin}${appBase}/assets/img/logo/${encodeURIComponent(filename)}`;
}

function normalizeSf9LogoUrl(value, fallbackFilename) {
    const text = blankIfInvalid(value);
    if (!text) return getSf9LogoAssetUrl(fallbackFilename);

    // The API may return a path from a different deployment mount, such as
    // /deped_capstone2/assets/... . Rebuild known in-project logo paths from
    // the current page origin and detected application base instead of
    // allowing the browser to request a stale 404 URL.
    const marker = 'assets/img/logo/';
    const markerIndex = text.toLowerCase().indexOf(marker);
    if (markerIndex >= 0) {
        const filename = text.slice(markerIndex + marker.length).split(/[?#]/, 1)[0];
        if (/^[a-z0-9._-]+$/i.test(filename)) return getSf9LogoAssetUrl(filename);
    }

    return text;
}

function ensureSf9Defaults(data) {
    const out = { ...(data || {}) };
    out.school = { ...(out.school || {}) };

    out.school.logo_url = normalizeSf9LogoUrl(out.school.logo_url, 'logo.png');
    out.school.deped_logo_url = normalizeSf9LogoUrl(
        out.school.deped_logo_url,
        'Seal_of_the_Department_of_Education_of_the_Philippines.png'
    );

    // Ensure core values exist (the API already provides a template for enrollment-based calls,
    // but keep this resilient).
    if (!out.core_values) {
        out.core_values = {};
    }

    return out;
}

function blankIfInvalid(value) {
    if (value === null || value === undefined) return '';
    const text = String(value).trim();
    if (!text || text.toLowerCase() === 'null' || text.toLowerCase() === 'undefined') return '';
    return text;
}

function normalizeCurriculumLevel(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return '';
    if (text.includes('senior') || text === 'shs') return 'shs';
    if (text.includes('junior') || text === 'jhs') return 'jhs';
    if (text.includes('elementary') || text === 'elem') return 'elementary';
    return '';
}

function inferCurriculumLevel(school, enrollment) {
    const direct = normalizeCurriculumLevel(school?.curriculum_level);
    if (direct) return direct;

    const education = normalizeCurriculumLevel(enrollment?.education_level);
    if (education) return education;

    const gradeText = String(enrollment?.grade_level || '');
    const gradeMatch = gradeText.match(/(\d+)/);
    const gradeNo = gradeMatch ? Number(gradeMatch[1]) : 0;
    if (gradeNo >= 11) return 'shs';
    if (gradeNo >= 7) return 'jhs';
    return 'elementary';
}

function parseLearnerName(fullName) {
    const name = blankIfInvalid(fullName);
    if (!name) return { lastName: '', firstName: '', middleName: '' };
    const [lastPart = '', givenPart = ''] = name.split(',');
    const tokens = givenPart.trim().split(/\s+/).filter(Boolean);
    return {
        lastName: lastPart.trim(),
        firstName: tokens[0] || '',
        middleName: tokens.slice(1).join(' ')
    };
}

function roundTo2(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.round(num * 100) / 100;
}

function computeAverage(values) {
    const nums = values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));
    if (!nums.length) return null;
    return roundTo2(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function formatRating(value) {
    if (value === null || value === undefined || value === '') return '';
    if (value === '--') return '&ndash;';
    const grade = toReportCardGrade(value);
    if (grade === null) return escapeHtml(String(value));
    return escapeHtml(String(grade));
}

function descriptorFor(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '';
    if (num >= 90) return 'Outstanding';
    if (num >= 85) return 'Very Satisfactory';
    if (num >= 80) return 'Satisfactory';
    if (num >= 75) return 'Fairly Satisfactory';
    return 'Did Not Meet Expectations';
}

function remarksFor(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '';
    return num >= 75 ? 'Passed' : 'Failed';
}

function getFormCode(curriculumLevel) {
    if (curriculumLevel === 'shs') return 'SF9-SHS';
    if (curriculumLevel === 'jhs') return 'SF9-JHS';
    return 'SF9-Elem';
}

function getLogoMarkup(logoUrl) {
    const src = blankIfInvalid(logoUrl);
    if (src) {
        return `<img src="${escapeHtml(src)}" alt="DepEd Seal" class="seal-image">`;
    }
    return `<div class="seal-fallback">DepEd<br>Seal</div>`;
}

function getRightLogoMarkup(logoUrl) {
    const src = blankIfInvalid(logoUrl);
    if (src) {
        return `<img src="${escapeHtml(src)}" alt="School Logo" class="seal-image">`;
    }
    return `<div class="seal-fallback">School<br>Logo</div>`;
}

function buildLrnBoxes(lrn) {
    const digits = blankIfInvalid(lrn).replace(/\D/g, '').slice(0, 12).split('');
    const boxes = [];
    for (let index = 0; index < 12; index += 1) {
        boxes.push(`<span class="lrn-box">${escapeHtml(digits[index] || '')}</span>`);
    }
    return boxes.join('');
}

const FULL_MONTH_NAMES = {
    'jun': 'June', 'june': 'June',
    'jul': 'July', 'july': 'July',
    'aug': 'August', 'august': 'August',
    'sep': 'September', 'sept': 'September', 'september': 'September',
    'oct': 'October', 'october': 'October',
    'nov': 'November', 'november': 'November',
    'dec': 'December', 'december': 'December',
    'jan': 'January', 'january': 'January',
    'feb': 'February', 'february': 'February',
    'mar': 'March', 'march': 'March',
    'apr': 'April', 'april': 'April',
    'may': 'May'
};

const MONTH_ABBREVIATIONS = {
    'january': 'Jan',
    'february': 'Feb',
    'march': 'Mar',
    'april': 'Apr',
    'may': 'May',
    'june': 'Jun',
    'july': 'Jul',
    'august': 'Aug',
    'september': 'Sep',
    'october': 'Oct',
    'november': 'Nov',
    'december': 'Dec'
};

function formatFullMonthName(label) {
    if (!label) return '';
    const key = String(label).trim().toLowerCase();
    return FULL_MONTH_NAMES[key] || label;
}

function formatMonthAbbreviation(label) {
    const rawLabel = String(label || '').trim();
    if (!rawLabel) return '';
    // SF9.html uses fixed three-letter month headers. Normalize labels such as
    // "September 2026" or "September (2026)" to the same "Sep" output.
    const monthToken = rawLabel.match(/^[A-Za-z]+/)?.[0] || rawLabel;
    const fullName = formatFullMonthName(monthToken);
    if (!fullName) return '';
    return MONTH_ABBREVIATIONS[String(fullName).trim().toLowerCase()] || fullName;
}

function buildAttendanceData(attendance) {
    const months = Array.isArray(attendance?.months) ? attendance.months : [];
    const defaultMonths = ['June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March', 'April'];

    let mapped = [];
    if (months.length > 0) {
        mapped = months.map((item) => {
            const schoolDays = Number(item?.total_school_days) || 0;

            let presentRaw = item?.days_present;
            let absentRaw = item?.days_absent;

            let present = (presentRaw === null || presentRaw === undefined || presentRaw === '') ? null : Number(presentRaw);
            let absent = (absentRaw === null || absentRaw === undefined || absentRaw === '') ? null : Number(absentRaw);

            if (!(present >= 0)) present = null;
            if (!(absent >= 0)) absent = null;

            // Prefer server-provided absent (computed from daily records) to avoid drift.
            if (absent === null && present !== null) absent = Math.max(0, schoolDays - present);
            if (present === null && absent !== null) present = Math.max(0, schoolDays - absent);

            return {
                label: formatFullMonthName(blankIfInvalid(item?.label)),
                schoolDays,
                present,
                absent
            };
        });
    } else {
        mapped = defaultMonths.map((m) => ({
            label: m,
            schoolDays: 0,
            present: null,
            absent: null
        }));
    }

    return {
        months: mapped,
        totals: {
            schoolDays: mapped.reduce((sum, item) => sum + (item.schoolDays || 0), 0),
            present: mapped.reduce((sum, item) => sum + (item.present || 0), 0),
            absent: mapped.reduce((sum, item) => sum + (item.absent || 0), 0)
        }
    };
}

function defaultObservedValues() {
    return [
        {
            coreValue: 'Maka-Diyos',
            statements: [
                "Expresses one's spiritual beliefs while respecting the spiritual beliefs of others",
                'Shows adherence to ethical principles by upholding truth in all undertakings'
            ]
        },
        {
            coreValue: 'Makatao',
            statements: [
                'Is sensitive to individual, social and cultural differences; resists stereotyping people',
                'Demonstrates contributions toward solidarity'
            ]
        },
        {
            coreValue: 'Makakalikasan',
            statements: [
                'Cares for the environment and utilizes resources wisely, judiciously and economically'
            ]
        },
        {
            coreValue: 'Makabansa',
            statements: [
                'Demonstrates pride in being a Filipino; exercises the rights and responsibilities of a Filipino citizen',
                'Demonstrates appropriate behavior in carrying out activities in the school, community and country'
            ]
        }
    ];
}

function buildObservedValuesRows(coreValues) {
    const values = coreValues && typeof coreValues === 'object' ? Object.entries(coreValues) : [];
    if (!values.length) {
        return defaultObservedValues().flatMap((group) => group.statements.map((statement, index) => ({
            coreValue: group.coreValue,
            behavior_statement: statement,
            q1: '', q2: '', q3: '', q4: '',
            rowspan: group.statements.length,
            showCoreValue: index === 0
        })));
    }

    const grouped = [];
    values.forEach(([, item]) => {
        const coreValue = blankIfInvalid(item?.core_value);
        const statement = blankIfInvalid(item?.behavior_statement);
        if (!coreValue || !statement) return;
        let group = grouped.find((entry) => entry.coreValue === coreValue);
        if (!group) {
            group = { coreValue, items: [] };
            grouped.push(group);
        }
        group.items.push(item);
    });

    return grouped.flatMap((group) => group.items.map((item, index) => ({
        coreValue: group.coreValue,
        behavior_statement: blankIfInvalid(item.behavior_statement),
        q1: blankIfInvalid(item.q1),
        q2: blankIfInvalid(item.q2),
        q3: blankIfInvalid(item.q3),
        q4: blankIfInvalid(item.q4),
        rowspan: group.items.length,
        showCoreValue: index === 0
    })));
}

function getReportPeriods(data) {
    const type = String(data?.enrollment?.grading_system_type || 'Quarterly').toLowerCase();
    const threeTerm = ['three-term', 'three term', 'trimester', 'term'].includes(type);
    const count = threeTerm ? 3 : type === 'semester' ? 2 : 4;
    const prefix = threeTerm ? 'T' : type === 'semester' ? 'S' : 'Q';
    const name = threeTerm ? 'Term' : type === 'semester' ? 'Semester' : 'Quarter';
    const configured = Array.isArray(data?.quarters) ? data.quarters : [];
    return Array.from({ length: count }, (_, index) => {
        const number = index + 1;
        const configuredPeriod = configured.find((period) => Number(period?.quarter) === number) || {};
        return {
            key: `q${number}`,
            label: `${prefix}${number}`,
            name: configuredPeriod.period_name || `${number}${number === 1 ? 'st' : number === 2 ? 'nd' : number === 3 ? 'rd' : 'th'} ${name}`,
            grading_period_id: Number(configuredPeriod.grading_period_id || 0),
            period_no: Number(configuredPeriod.period_no || configuredPeriod.quarter || number),
        };
    });
}

function hasAllPeriods(row, periods) {
    return periods.every((period) => hasQuarterGrade(row?.[period.key]));
}

function sanitizeGradeRow(row, periods) {
    const q1 = toReportCardGrade(row?.q1);
    const q2 = toReportCardGrade(row?.q2);
    const q3 = toReportCardGrade(row?.q3);
    const q4 = toReportCardGrade(row?.q4);
    const periodValues = periods.map((period) => toReportCardGrade(row?.[period.key]));
    const allPeriodsPresent = hasAllPeriods({ q1, q2, q3, q4 }, periods);
    const explicitFinalRating = toReportCardGrade(row?.final_grade ?? row?.final_rating ?? row?.finalRating);
    const finalRating = explicitFinalRating ?? (allPeriodsPresent ? computeReportCardAverage(periodValues) : null);
    const explicitRemarks = allPeriodsPresent ? blankIfInvalid(row?.remarks || row?.remark) : '';
    const sanitized = {
        subject: blankIfInvalid(row?.subject_name || row?.name || row?.subject),
        subject_code: blankIfInvalid(row?.subject_code),
        category: blankIfInvalid(row?.category) || 'Learning Areas',
        q1,
        q2,
        q3,
        q4,
        finalRating,
        remarks: explicitRemarks || (allPeriodsPresent ? remarksFor(finalRating) : '')
    };
    if (Object.prototype.hasOwnProperty.call(row || {}, 'is_curriculum_subject')) {
        sanitized.isCurriculumSubject = row.is_curriculum_subject !== false && Number(row.is_curriculum_subject) !== 0;
    }
    if (Array.isArray(row?.component_grades) && row.component_grades.length) {
        sanitized.component_grades = row.component_grades.map((component) => sanitizeGradeRow(component, periods));
    }
    return sanitized;
}

function computeGeneralAverage(grades, suppliedAverage, periods) {
    const supplied = toReportCardGrade(suppliedAverage);
    if (!grades.length || !periods) return supplied;
    const allComplete = grades.every((row) => hasAllPeriods(row, periods));
    // A stored general average is an official persisted result. Keep showing
    // it when a later period is still blank, while computed averages continue
    // to require complete period coverage.
    if (!allComplete) return supplied;
    const computed = computeReportCardAverage(grades.map((row) => row.finalRating));
    if (computed !== null) return computed;
    return supplied;
}

function hasQuarterGrade(value) {
    const text = String(value ?? '').trim();
    if (!text || text === '--') return false;
    const num = Number(text);
    return Number.isFinite(num);
}

function hasAllQuarters(row) {
    return hasQuarterGrade(row?.q1) && hasQuarterGrade(row?.q2) && hasQuarterGrade(row?.q3) && hasQuarterGrade(row?.q4);
}

function isMapehComponentSubject(subjectName) {
    const name = String(subjectName || '').toLowerCase();
    if (name.includes('mapeh') && !name.includes('component')) return false;
    return /\bmusic\s*(and|&)\s*arts?\b/.test(name)
        || /\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/.test(name)
        || ['music', 'musika', 'art', 'sining', 'physical education', 'edukasyon sa pagpapalakas', 'health', 'kalusugan'].some((kw) => name.includes(kw));
}

function findGradeRowExactFirst(grades, nameKeywords) {
    const keywords = nameKeywords.map((kw) => String(kw).toLowerCase().trim());
    // 1) exact match, 2) shortest name that contains a keyword (avoids matching
    // a combined parent like "Music, Arts..." when a dedicated component exists).
    const matches = [];
    grades.forEach((g) => {
        const name = String(g.subject || '').toLowerCase().trim();
        if (keywords.some((kw) => name === kw)) {
            matches.push({ grade: g, name, order: 0 });
        } else if (keywords.some((kw) => name.includes(kw))) {
            matches.push({ grade: g, name, order: name.length });
        }
    });
    if (!matches.length) return null;
    matches.sort((a, b) => a.order - b.order || a.name.length - b.name.length);
    return matches[0].grade;
}

function pickBestGradeByCoverage(candidates, periods) {
    if (!candidates || !candidates.length) return null;
    let best = candidates[0];
    let bestCount = -1;
    candidates.forEach((c) => {
        const count = periods.filter((p) => hasQuarterGrade(c[p.key])).length;
        if (count > bestCount) {
            bestCount = count;
            best = c;
        }
    });
    return best;
}

function getMapehModel(grades, periods) {
    const classified = {};
    const parentComponentRows = [];
    const componentOrder = [];
    (grades || []).forEach((grade) => {
        const subjectName = grade.subject || grade.subject_name || grade.name || '';
        const info = classifyElementarySubject(subjectName, grade.subject_code);
        grade._classifiedInfo = info;
        const key = info.key || info.type;
        if (!classified[key]) classified[key] = [];
        classified[key].push(grade);
        if (info.type === 'mapeh_component' && !componentOrder.some((item) => item.key === key)) {
            componentOrder.push({ key, label: info.defaultLabel || subjectName || key });
        }
        if (info.key === 'mapeh' && Array.isArray(grade.component_grades)) {
            grade.component_grades.forEach((component) => {
                const componentName = component.subject || component.subject_name || component.name || '';
                const componentInfo = classifyElementarySubject(componentName, component.subject_code);
                component._classifiedInfo = componentInfo;
                parentComponentRows.push(component);
                const componentKey = componentInfo.key || componentInfo.type;
                if (!classified[componentKey]) classified[componentKey] = [];
                classified[componentKey].push(component);
                if (componentInfo.type === 'mapeh_component' && !componentOrder.some((item) => item.key === componentKey)) {
                    componentOrder.push({ key: componentKey, label: componentInfo.defaultLabel || componentName || componentKey });
                }
            });
        }
    });

    const componentDefs = [
        { key: 'music', label: 'Music' },
        { key: 'art', label: 'Art' },
        { key: 'pe', label: 'Physical Education (PE)' },
        { key: 'health', label: 'Health' },
    ];
    const groupedComponentDefs = [
        { key: 'music_arts', label: 'Music and Arts', memberKeys: ['music_arts', 'music', 'art'] },
        { key: 'pe_health', label: 'Physical Education and Health', memberKeys: ['pe_health', 'pe', 'health'] },
    ];
    const componentLabelsByKey = {
        music_arts: 'Music and Arts',
        pe_health: 'Physical Education and Health',
        music: 'Music',
        art: 'Art',
        pe: 'Physical Education (PE)',
        health: 'Health',
    };
    const hasExplicitParent = (classified.mapeh || []).length > 0;
    const useStandaloneComponents = !hasExplicitParent || parentComponentRows.length > 0 || componentOrder.length > 0;
    const rawComponents = parentComponentRows.length
        ? parentComponentRows.map((row, index) => {
            const rawLabel = row.subject || row.subject_name || row.name || '';
            const infoKey = row._classifiedInfo?.key || '';
            const fallback = componentDefs[index] || { key: `component_${index}`, label: `Component ${index + 1}` };
            const isGenericLabel = !rawLabel || /mapeh/i.test(rawLabel) || row._classifiedInfo?.type === 'mapeh_parent';
            const key = componentLabelsByKey[infoKey] ? infoKey : (isGenericLabel ? fallback.key : (infoKey || fallback.key));
            const label = componentLabelsByKey[key] || (isGenericLabel ? fallback.label : rawLabel);
            return { key, label, row };
        })
        : (useStandaloneComponents ? (componentOrder.length ? componentOrder : componentDefs) : [])
            .map((def) => ({
                ...def,
                row: pickBestGradeByCoverage(classified[def.key] || [], periods)
            }))
            .filter((item) => item.row);
    const assignedComponents = rawComponents.filter((item) => item.row);
    const parentRow = pickBestGradeByCoverage(classified.mapeh || [], periods);
    const hasMapeh = Boolean(parentRow || assignedComponents.length);
    const explicitParent = Boolean(parentRow);

    const buildBlankGroupedComponent = (definition) => ({
        key: definition.key,
        label: definition.label,
        row: {
            subject: definition.label,
            subject_name: definition.label,
            category: 'MAPEH',
            q1: '', q2: '', q3: '', q4: '',
            finalRating: '',
            remarks: '',
            isCurriculumSubject: true,
        },
    });

    const buildGroupedComponent = (definition) => {
        const matchingItems = assignedComponents.filter((item) => definition.memberKeys.includes(item.key));
        // If standalone Music/Arts or PE/Health rows are available, aggregate
        // those rows into the two official grouped report-card components.
        // Otherwise preserve an already-grouped curriculum row.
        const standaloneItems = matchingItems.filter((item) => item.key !== definition.key);
        const sourceItems = standaloneItems.length ? standaloneItems : matchingItems;
        if (!sourceItems.length) {
            return explicitParent ? buildBlankGroupedComponent(definition) : null;
        }

        const sourceRows = sourceItems.map((item) => item.row).filter(Boolean);
        const baseRow = pickBestGradeByCoverage(sourceRows, periods) || {};
        const groupedRow = {
            ...baseRow,
            subject: definition.label,
            subject_name: definition.label,
            category: baseRow.category || 'MAPEH',
            isCurriculumSubject: sourceItems.some((item) => item.row?.isCurriculumSubject !== false),
        };
        periods.forEach((period) => {
            const values = sourceRows
                .map((row) => row?.[period.key])
                .filter(hasQuarterGrade);
            groupedRow[period.key] = values.length
                ? computeReportCardAverage(values)
                : (baseRow?.[period.key] ?? '');
        });
        const periodValues = periods.map((period) => groupedRow[period.key]);
        const complete = periodValues.length > 0 && periodValues.every(hasQuarterGrade);
        groupedRow.finalRating = complete ? computeReportCardAverage(periodValues) : '';
        groupedRow.remarks = complete ? remarksFor(groupedRow.finalRating) : '';
        return { key: definition.key, label: definition.label, row: groupedRow };
    };

    const components = hasMapeh
        ? groupedComponentDefs.map(buildGroupedComponent).filter(Boolean)
        : [];
    const displayComponents = components.filter((item) => item.row?.isCurriculumSubject !== false);

    let displayParent = parentRow
        ? { ...parentRow, subject: 'MAPEH', subject_name: 'MAPEH' }
        : null;
    if (assignedComponents.length) {
        displayParent = { subject: 'MAPEH', subject_name: 'MAPEH', category: parentRow?.category || 'MAPEH' };
        periods.forEach((period) => {
            const values = assignedComponents.map((item) => item.row?.[period.key]).filter((value) => hasQuarterGrade(value));
            displayParent[period.key] = values.length ? computeReportCardAverage(values) : (parentRow ? parentRow[period.key] : '');
        });
        const periodValues = periods.map((period) => displayParent[period.key]);
        const allPeriodsPresent = periodValues.every(hasQuarterGrade);
        displayParent.finalRating = allPeriodsPresent ? computeReportCardAverage(periodValues) : '';
        displayParent.remarks = allPeriodsPresent ? remarksFor(displayParent.finalRating) : '';
    }

    const mapehRows = new Set();
    (classified.mapeh || []).forEach((row) => mapehRows.add(row));
    componentDefs.forEach((def) => (classified[def.key] || []).forEach((row) => mapehRows.add(row)));
    componentOrder.forEach((def) => (classified[def.key] || []).forEach((row) => mapehRows.add(row)));
    parentComponentRows.forEach((row) => mapehRows.add(row));

    return {
        classified,
        hasMapeh,
        explicitParent,
        shouldGroup: Boolean(displayParent),
        parentRow: displayParent,
        components: displayComponents,
        allComponents: assignedComponents,
        mapehRows,
        nonMapehRows: (grades || []).filter((row) => !mapehRows.has(row))
    };
}

// Rebuild the grades list so that the MAPEH parent row carries the
// per-quarter average of its components. This keeps the general average
// accurate when components are stored as separate subject rows.
function buildMapehAveragedGrades(grades, periods) {
    const model = getMapehModel(grades, periods);
    if (!model.hasMapeh || !model.shouldGroup) return grades;
    const result = model.nonMapehRows.slice();
    if (model.parentRow) result.push(model.parentRow);
    return result;
}

function buildElementaryGradesTable(grades, generalAverage, motherTongue, periods) {
    const subjectLabel = motherTongue ? `Learning Areas / MTB-MLE (${escapeHtml(motherTongue)})` : 'Learning Areas';
    const mapehModel = getMapehModel(grades, periods);
    const displayRows = mapehModel.shouldGroup ? mapehModel.nonMapehRows.slice() : (grades || []).slice();
    if (mapehModel.shouldGroup) {
        displayRows.push(mapehModel.parentRow);
        mapehModel.components.forEach((item) => displayRows.push({
            ...item.row,
            subject: item.label,
            subject_name: item.label,
            _isMapehComponentDisplay: true
        }));
    }
    const averageRows = buildMapehAveragedGrades(grades, periods);
    const allComplete = averageRows.length > 0 && averageRows.every((row) => hasAllPeriods(row, periods));
    const rows = displayRows.length ? displayRows.map((row) => `
        <tr>
            <td class="subject-col text-left">${row._isMapehComponentDisplay ? '&nbsp;&nbsp;&nbsp;' : ''}${escapeHtml(row.subject)}</td>
            ${periods.map((period) => `<td>${formatRating(row[period.key])}</td>`).join('')}
            <td>${!row._isMapehComponentDisplay && hasAllPeriods(row, periods) ? formatRating(row.finalRating) : ''}</td>
            <td>${!row._isMapehComponentDisplay && hasAllPeriods(row, periods) ? escapeHtml(row.remarks) : ''}</td>
        </tr>
    `).join('') : `<tr><td colspan="${periods.length + 3}">&nbsp;</td></tr>`;

    return `
        <table class="sf9-table grades-table">
            <thead>
                <tr>
                    <th class="subject-col text-left">${subjectLabel}</th>
                    ${periods.map((period) => `<th title="${escapeHtml(period.name)}">${escapeHtml(period.label)}</th>`).join('')}
                    <th>Final Rating</th>
                    <th>Remarks</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
                <tr>
                    <td class="text-left footer-label">General Average</td>
                    ${periods.map(() => '<td></td>').join('')}
                    <td>${allComplete ? formatRating(generalAverage) : ''}</td>
                    <td>${allComplete ? escapeHtml(remarksFor(generalAverage)) : ''}</td>
                </tr>
            </tfoot>
        </table>
    `;
}

function buildPeriodColGroup(periodCount, { subjectWidth = '47%', finalWidth = '14%', remarksWidth = '14%' } = {}) {
    const safePeriodCount = Math.max(1, Number(periodCount) || 1);
    const remainingWidth = Math.max(12, 100 - parseFloat(subjectWidth) - parseFloat(finalWidth) - parseFloat(remarksWidth));
    const periodWidth = `${remainingWidth / safePeriodCount}%`;
    return `
        <colgroup>
            <col class="subject-col" style="width:${subjectWidth};">
            ${Array.from({ length: safePeriodCount }, () => `<col class="period-col" style="width:${periodWidth};">`).join('')}
            <col class="final-col" style="width:${finalWidth};">
            <col class="remarks-col" style="width:${remarksWidth};">
        </colgroup>
    `;
}

function normalizeSf9GroupLabel(value) {
    return String(value || '')
        .replace(/\([^)]*\)/g, '')
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/gi, ' ')
        .trim()
        .toLowerCase();
}

function shouldShowSf9CategoryRow(category, items) {
    const normalizedCategory = normalizeSf9GroupLabel(category);
    if (!normalizedCategory || normalizedCategory === 'learning areas') return false;
    if (normalizedCategory === 'mapeh') return false;

    const subjects = (items || [])
        .map((row) => normalizeSf9GroupLabel(row?.subject))
        .filter(Boolean);

    if (subjects.length === 1) {
        const subject = subjects[0];
        if (subject === normalizedCategory) return false;
        if (normalizedCategory.includes(subject) || subject.includes(normalizedCategory)) return false;
        const aliases = [
            ['social studies', 'araling panlipunan'],
            ['values education', 'edukasyon sa pagpapakatao', 'esp'],
            ['languages', 'filipino', 'english', 'mother tongue', 'mtb mle'],
            ['mathematics', 'math'],
            ['technology and livelihood', 'technology and livelihood education', 'tle', 'epp'],
            ['science'],
        ];
        if (aliases.some((group) => group.some((term) => normalizedCategory.includes(term)) && group.some((term) => subject.includes(term)))) {
            return false;
        }
    }

    return true;
}

function buildJhsGradesTable(grades, generalAverage, periods) {
    const mapehModel = getMapehModel(grades, periods);
    const averageRows = buildMapehAveragedGrades(grades, periods);
    const allComplete = averageRows.length > 0 && averageRows.every((row) => hasAllPeriods(row, periods));
    const groups = (mapehModel.shouldGroup ? mapehModel.nonMapehRows : (grades || [])).reduce((map, row) => {
        const category = blankIfInvalid(row.category) || 'Learning Areas';
        if (!map[category]) map[category] = [];
        map[category].push(row);
        return map;
    }, {});

    if (mapehModel.shouldGroup) {
        groups.MAPEH = [
            { ...mapehModel.parentRow, _isMapehParentDisplay: true },
            ...mapehModel.components.map((item) => ({
                ...(item.row || {}),
                subject: item.label,
                subject_name: item.label,
                _isMapehComponentDisplay: true
            }))
        ];
    }

    const body = Object.entries(groups).map(([category, items]) => `
        ${shouldShowSf9CategoryRow(category, items) ? `<tr class="category-row"><td colspan="${periods.length + 3}">${escapeHtml(category)}</td></tr>` : ''}
        ${items.map((row) => `
            <tr>
                <td class="subject-col text-left">${row._isMapehComponentDisplay ? '&nbsp;&nbsp;&nbsp;' : ''}${row._isMapehParentDisplay ? `<strong>${escapeHtml(row.subject || 'MAPEH')}</strong>` : escapeHtml(row.subject)}</td>
                ${periods.map((period) => `<td>${formatRating(row[period.key])}</td>`).join('')}
                <td>${!row._isMapehComponentDisplay && hasAllPeriods(row, periods) ? formatRating(row.finalRating) : ''}</td>
                <td>${!row._isMapehComponentDisplay && hasAllPeriods(row, periods) ? escapeHtml(row.remarks) : ''}</td>
            </tr>
        `).join('')}
    `).join('') || `<tr><td colspan="${periods.length + 3}">&nbsp;</td></tr>`;

    return `
        <table class="sf9-table grades-table">
            ${buildPeriodColGroup(periods.length)}
            <thead>
                <tr>
                    <th class="subject-col text-left">Subjects</th>
                    ${periods.map((period) => `<th title="${escapeHtml(period.name)}">${escapeHtml(period.label)}</th>`).join('')}
                    <th>Final Rating</th>
                    <th>Remarks</th>
                </tr>
            </thead>
            <tbody>${body}</tbody>
            <tfoot>
                <tr>
                    <td class="text-left footer-label">General Average for the Year</td>
                    ${periods.map(() => '<td></td>').join('')}
                    <td>${allComplete ? formatRating(generalAverage) : ''}</td>
                    <td>${allComplete ? escapeHtml(remarksFor(generalAverage)) : ''}</td>
                </tr>
            </tfoot>
        </table>
    `;
}

function buildShsSemesterTable(title, grades, qAKey, qBKey) {
    const semesterPeriods = [{ key: qAKey }, { key: qBKey }];
    const mapehModel = getMapehModel(grades, semesterPeriods);
    const groups = (mapehModel.shouldGroup ? mapehModel.nonMapehRows : (grades || [])).reduce((map, row) => {
        const category = blankIfInvalid(row.category) || 'Learning Areas';
        if (!map[category]) map[category] = [];
        map[category].push(row);
        return map;
    }, {});

    if (mapehModel.shouldGroup) {
        groups.MAPEH = [
            { ...mapehModel.parentRow, _isMapehParentDisplay: true },
            ...mapehModel.components.map((item) => ({
                ...(item.row || {}),
                subject: item.label,
                subject_name: item.label,
                _isMapehComponentDisplay: true
            }))
        ];
    }

    const semesterAverages = [];
    const body = Object.entries(groups).map(([category, items]) => `
        ${shouldShowSf9CategoryRow(category, items) ? `<tr class="category-row"><td colspan="4">${escapeHtml(category)}</td></tr>` : ''}
        ${items.map((row) => {
            const hasBoth = hasQuarterGrade(row[qAKey]) && hasQuarterGrade(row[qBKey]);
            const semesterAverage = hasBoth ? computeAverage([row[qAKey], row[qBKey]]) : null;
            if (!row._isMapehComponentDisplay && hasBoth && semesterAverage !== null) semesterAverages.push(semesterAverage);
            return `
                <tr>
                    <td class="subject-col text-left">${row._isMapehComponentDisplay ? '&nbsp;&nbsp;&nbsp;' : ''}${row._isMapehParentDisplay ? `<strong>${escapeHtml(row.subject || 'MAPEH')}</strong>` : escapeHtml(row.subject)}</td>
                    <td>${formatRating(row[qAKey])}</td>
                    <td>${formatRating(row[qBKey])}</td>
                    <td>${!row._isMapehComponentDisplay && hasBoth ? formatRating(semesterAverage) : ''}</td>
                </tr>
            `;
        }).join('')}
    `).join('') || '<tr><td colspan="4">&nbsp;</td></tr>';

    const averageRows = buildMapehAveragedGrades(grades, semesterPeriods);
    const allComplete = averageRows.length > 0 && averageRows.every((row) => hasQuarterGrade(row[qAKey]) && hasQuarterGrade(row[qBKey]));
    return `
        <div class="semester-block">
            <div class="subsection-title">${escapeHtml(title)}</div>
            <table class="sf9-table grades-table shs-table">
                <colgroup>
                    <col class="subject-col" style="width:52%;">
                    <col class="period-col" style="width:13%;">
                    <col class="period-col" style="width:13%;">
                    <col class="final-col" style="width:22%;">
                </colgroup>
                <thead>
                    <tr>
                        <th class="subject-col text-left">Subjects</th>
                        <th>${escapeHtml(qAKey.toUpperCase())}</th>
                        <th>${escapeHtml(qBKey.toUpperCase())}</th>
                        <th>Semester Final Grade</th>
                    </tr>
                </thead>
                <tbody>${body}</tbody>
                <tfoot>
                    <tr>
                        <td class="text-left footer-label">General Average for the Semester</td>
                        <td></td>
                        <td></td>
                        <td>${allComplete ? formatRating(computeAverage(semesterAverages)) : ''}</td>
                    </tr>
                </tfoot>
            </table>
        </div>
    `;
}

function buildGradesSection(curriculumLevel, grades, generalAverage, motherTongue, periods) {
    if (curriculumLevel === 'shs' && periods.length === 4) {
        return `
            ${buildShsSemesterTable('FIRST SEMESTER', grades, 'q1', 'q2')}
            ${buildShsSemesterTable('SECOND SEMESTER', grades, 'q3', 'q4')}
            <div class="corrected-line">Iniwasto ni: ____________________</div>
        `;
    }
    if (curriculumLevel === 'jhs' || curriculumLevel === 'shs') {
        return buildJhsGradesTable(grades, generalAverage, periods);
    }
    return buildElementaryGradesTable(grades, generalAverage, motherTongue, periods);
}

function buildObservedValuesTable(rows, periods) {
    const body = rows.map((row) => `
        <tr>
            ${row.showCoreValue ? `<td class="core-value-col" rowspan="${row.rowspan}">${escapeHtml(row.coreValue)}</td>` : ''}
            <td class="text-left behavior-col">${escapeHtml(row.behavior_statement)}</td>
            ${periods.map((period) => `<td>${escapeHtml(row[period.key])}</td>`).join('')}
        </tr>
    `).join('');

    return `
        <table class="sf9-table values-table">
            <thead>
                <tr>
                    <th class="core-value-col">Core Values</th>
                    <th class="behavior-col">Behavior Statements</th>
                    ${periods.map((period) => `<th title="${escapeHtml(period.name)}">${escapeHtml(period.label)}</th>`).join('')}
                </tr>
            </thead>
            <tbody>${body}</tbody>
        </table>
    `;
}

function buildTermCommentsTable(comments, periods) {
    const items = Array.isArray(comments) ? comments : [];
    const byPeriod = new Map(items.map((item) => [String(item?.grading_period_id || ''), item?.comment_text || '']));
    const rows = periods.map((period) => `
        <tr>
            <td class="text-left comment-period">${escapeHtml(period.name || period.label)}</td>
            <td class="text-left comment-text">${escapeHtml(byPeriod.get(String(period.grading_period_id || '')) || '')}</td>
        </tr>
    `).join('');
    return `
        <table class="sf9-table comments-table">
            <thead><tr><th style="width:28%;">Term</th><th>Teacher's Comments / Remarks</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="2">&nbsp;</td></tr>'}</tbody>
        </table>
    `;
}

function buildNumericDescriptorLegend() {
    return `
        <div class="legend-box numeric-descriptor-legend">
            <div class="subsection-title">Learner Progress and Achievement</div>
            <table class="sf9-table legend-table">
                <thead><tr><th>Descriptors</th><th>Grading Scale</th><th>Remarks</th></tr></thead>
                <tbody>
                    <tr><td class="text-left">Advancing</td><td>90-100</td><td>Passed</td></tr>
                    <tr><td class="text-left">Benchmarking</td><td>80-89</td><td>Passed</td></tr>
                    <tr><td class="text-left">Connecting</td><td>75-79</td><td>Passed</td></tr>
                    <tr><td class="text-left">Developing</td><td>65-74</td><td>Failed</td></tr>
                    <tr><td class="text-left">Emerging</td><td>0-64</td><td>Failed</td></tr>
                </tbody>
            </table>
        </div>
    `;
}

function buildLegends() {
    return `
        <div class="legend-row">
            <div class="legend-box">
                <div class="subsection-title">Observed Values</div>
                <table class="sf9-table legend-table">
                    <thead>
                        <tr>
                            <th>Marking</th>
                            <th>Non-numerical Rating</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr><td>AO</td><td class="text-left">Always Observed</td></tr>
                        <tr><td>SO</td><td class="text-left">Sometimes Observed</td></tr>
                        <tr><td>RO</td><td class="text-left">Rarely Observed</td></tr>
                        <tr><td>NO</td><td class="text-left">Not Observed</td></tr>
                    </tbody>
                </table>
            </div>
            <div class="legend-box">
                <div class="subsection-title">Learner Progress and Achievement</div>
                <table class="sf9-table legend-table">
                    <thead>
                        <tr>
                            <th>Descriptors</th>
                            <th>Grading Scale</th>
                            <th>Remarks</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr><td class="text-left">Outstanding</td><td>90-100</td><td>Passed</td></tr>
                        <tr><td class="text-left">Very Satisfactory</td><td>85-89</td><td>Passed</td></tr>
                        <tr><td class="text-left">Satisfactory</td><td>80-84</td><td>Passed</td></tr>
                        <tr><td class="text-left">Fairly Satisfactory</td><td>75-79</td><td>Passed</td></tr>
                        <tr><td class="text-left">Did Not Meet Expectation</td><td>Below 75</td><td>Failed</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function classifyElementarySubject(subjectName, subjectCode) {
    const name = String(subjectName || '').trim();
    const code = String(subjectCode || '').trim();
    const s = (name + ' ' + code).toLowerCase();

    // A named MAPEH parent is distinct from the official grouped component
    // rows "Music and Arts" and "Physical Education and Health".
    if ((/\bmapeh\b/.test(s) && !s.includes('component'))
        || /music,\s*arts?,\s*physical education.*health/.test(s)) {
        return { type: 'mapeh_parent', key: 'mapeh' };
    }

    if (/\bmusic\s*(and|&)\s*arts?\b/.test(s)) return { type: 'mapeh_component', key: 'music_arts', defaultLabel: 'Music and Arts' };
    if (/\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/.test(s)) return { type: 'mapeh_component', key: 'pe_health', defaultLabel: 'Physical Education and Health' };
    if (/\bmusic\b|\bmusika\b/.test(s)) return { type: 'mapeh_component', key: 'music', defaultLabel: 'Music' };
    if (/\barts?\b|\bsining\b/.test(s)) return { type: 'mapeh_component', key: 'art', defaultLabel: 'Art' };
    if (/\bpe\b|\bphysical education\b|\bpagpapalakas\b/.test(s)) return { type: 'mapeh_component', key: 'pe', defaultLabel: 'Physical Education (PE)' };
    if (/\bhealth\b|\bkalusugan\b/.test(s)) return { type: 'mapeh_component', key: 'health', defaultLabel: 'Health' };

    if (/\bfilipino\b/.test(s)) return { type: 'standard', key: 'filipino', defaultLabel: 'Filipino' };
    if (/\benglish\b/.test(s)) return { type: 'standard', key: 'english', defaultLabel: 'English' };
    if (/\bmath\b|\bmathematics\b/.test(s)) return { type: 'standard', key: 'math', defaultLabel: 'Mathematics' };
    if (/\bscience\b/.test(s)) return { type: 'standard', key: 'science', defaultLabel: 'Science' };
    if (/\baraling panlipunan\b|\bap\b/.test(s)) return { type: 'standard', key: 'ap', defaultLabel: 'Araling Panlipunan (AP)' };
    if (/\bedukasyon sa pagpapakatao\b|\besp\b/.test(s)) return { type: 'standard', key: 'esp', defaultLabel: 'Edukasyon sa Pagpapakatao (EsP)' };
    if (/\bedukasyong pantahanan\b|\bepp\b|\btle\b/.test(s)) return { type: 'standard', key: 'epp', defaultLabel: 'Edukasyong Pantahanan at Pangkabuhayan (EPP)' };

    return { type: 'other', key: s, defaultLabel: name };
}

function buildElementaryProgressRows(grades, periods) {
    const renderTdCells = (row, isComponent = false) => {
        if (!row) {
            return `${periods.map(() => '<td></td>').join('')}<td></td><td></td>`;
        }
        const allPeriodsPresent = hasAllPeriods(row, periods);
        const periodVals = periods.map((p) => row[p.key]);
        const finalVal = !isComponent && allPeriodsPresent ? computeReportCardAverage(periodVals) : null;
        const finalDisp = finalVal !== null && finalVal !== undefined && finalVal !== '' ? formatRating(finalVal) : '';
        const remarkDisp = (!isComponent && finalVal !== null && finalVal !== undefined && finalVal !== '') ? escapeHtml(remarksFor(finalVal)) : '';
        return `
            ${periods.map((p) => `<td>${formatRating(row[p.key])}</td>`).join('')}
            <td>${finalDisp}</td>
            <td>${remarkDisp}</td>
        `;
    };

    let html = '';

    buildCurriculumSubjectDisplayRows(grades, periods).forEach((row) => {
        const isComponent = Boolean(row._isComponentBreakdown);
        const isMapehParent = Boolean(row._isMapehParentDisplay);
        const labelClass = isComponent ? 'indent' : isMapehParent ? 'mapeh' : 'label';
        const label = isMapehParent ? 'MAPEH' : row.subject;
        html += `
            <tr>
                <td class="${labelClass}">${isMapehParent ? '<strong>MAPEH</strong>' : escapeHtml(label)}</td>
                ${renderTdCells(row, isComponent)}
            </tr>
        `;
    });

    return html || `
        <tr>
            <td class="label"></td>
            ${renderTdCells(null, false)}
        </tr>
    `;
}

function buildElementarySf9DocumentHtml(data) {
    const school = data?.school || {};
    const enrollment = data?.enrollment || {};
    const learner = data?.learner || {};
    const adviser = data?.adviser || {};
    const periods = getReportPeriods(data);
    const templateVariant = String(enrollment?.sf9_template_variant || '').toUpperCase();
    const isNumericDepEdTemplate = enrollment?.grading_mode !== 'Descriptive'
        && ['G2', 'G3'].includes(templateVariant);
    const grades = (Array.isArray(data?.grades) ? data.grades : []).map((row) => sanitizeGradeRow(row, periods));
    // When a curriculum assigns a MAPEH parent, calculate the parent from its
    // component offerings and exclude those implementation rows from the
    // general average. Component-only curricula remain unchanged.
    const gradesForAverage = buildMapehAveragedGrades(grades, periods);
    const generalAverage = computeGeneralAverage(gradesForAverage, data?.general_average, periods);
    const attendance = buildAttendanceData(data?.attendance);
    const observedValuesRows = isNumericDepEdTemplate ? [] : buildObservedValuesRows(data?.core_values);
    const termComments = Array.isArray(data?.term_comments) ? data.term_comments : [];
    const schoolName = blankIfInvalid(school?.name || school?.school_name);
    const principalTitle = blankIfInvalid(school?.principal_title || 'Head Teacher / Principal');
    const principalName = blankIfInvalid(school?.school_head || school?.principal_name);
    const schoolYear = blankIfInvalid(enrollment?.school_year);
    const region = blankIfInvalid(school?.region);
    const division = blankIfInvalid(school?.division);
    const district = blankIfInvalid(school?.district);
    const section = blankIfInvalid(enrollment?.section);
    const gradeLevel = blankIfInvalid(enrollment?.grade_level);
    const adviserName = blankIfInvalid(adviser?.name);
    const age = blankIfInvalid(learner?.age);
    const sex = blankIfInvalid(learner?.sex || learner?.gender);
    const lrn = blankIfInvalid(learner?.lrn);
    const depedLogoUrl = blankIfInvalid(school?.deped_logo_url);
    const schoolLogoUrl = blankIfInvalid(school?.logo_url);
    const documentTitle = ['SF9 Report Card', learner?.name].filter(Boolean).join(' - ') || 'SF9 Report Card';

    const attMonths = attendance.months || [];
    const activeAttMonths = attMonths
        .map((m) => ({ ...m, label: formatMonthAbbreviation(m.label) }))
        .filter((m) => Boolean(m.label));

    const attHead = activeAttMonths.map((item) =>
        `<th class="v-month-cell"><div class="v-month-text">${escapeHtml(item.label)}</div></th>`
    ).join('');
    const attDays = activeAttMonths.map((item) => `<td>${item.schoolDays !== '' && item.schoolDays !== null && item.schoolDays !== undefined ? item.schoolDays : ''}</td>`).join('');
    const attPresent = activeAttMonths.map((item) => `<td>${item.present !== '' && item.present !== null && item.present !== undefined ? item.present : ''}</td>`).join('');
    const attAbsent = activeAttMonths.map((item) => `<td>${item.absent !== '' && item.absent !== null && item.absent !== undefined ? item.absent : ''}</td>`).join('');

    const attTotDays = attendance.totals?.schoolDays || '';
    const attTotPresent = attendance.totals?.present !== null && attendance.totals?.present !== undefined ? attendance.totals.present : '';
    const attTotAbsent = attendance.totals?.absent !== null && attendance.totals?.absent !== undefined ? attendance.totals.absent : '';

    const periodSystemType = String(enrollment?.grading_system_type || 'Quarterly').toLowerCase();
    const periodHeaderTitle = ['three-term', 'three term', 'trimester', 'term'].includes(periodSystemType) ? 'Term' : 'Quarter';

    const parentSignaturesHtml = periods.map((p, index) => {
        const numOrdinal = index === 0 ? '1<sup>st</sup>' : index === 1 ? '2<sup>nd</sup>' : index === 2 ? '3<sup>rd</sup>' : `${index + 1}<sup>th</sup>`;
        return `<div class="quarter-row"><span class="q-label">${numOrdinal} ${periodHeaderTitle}</span><div class="fill-val"></div></div>`;
    }).join('');

    const progressBodyHtml = buildElementaryProgressRows(grades, periods);

    const observedBodyHtml = observedValuesRows.map((row) => `
        <tr>
            ${row.showCoreValue ? `<td class="cv" rowspan="${row.rowspan}">${escapeHtml(row.coreValue)}</td>` : ''}
            <td class="bs">${escapeHtml(row.behavior_statement)}</td>
            ${periods.map((p) => `<td>${escapeHtml(row[p.key] || '')}</td>`).join('')}
        </tr>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(documentTitle)}</title>
<style>
  :root{
    --ink:#000;
    --hdr-bg:#dbe4f0;
    --paper:#ffffff;
  }
  *{box-sizing:border-box;}
  body{
    margin:0;
    font-family:"Times New Roman", Georgia, "Liberation Serif", serif;
    background:#fff;
    color:var(--ink);
  }

  .toolbar{
    position:sticky; top:0; z-index:50;
    display:flex; align-items:center; gap:12px; flex-wrap:wrap;
    background:#1f2430; color:#fff;
    padding:12px 20px;
    font-family:Arial, Helvetica, sans-serif;
  }
  .toolbar h1{font-size:15px; margin:0; font-weight:600; letter-spacing:.2px;}
  .toolbar p{margin:0; font-size:12px; color:#c7cbd6;}
  .toolbar .spacer{flex:1;}
  .btn{
    font-family:Arial, Helvetica, sans-serif;
    font-size:13px; font-weight:600;
    padding:8px 16px; border-radius:6px; border:1px solid transparent;
    cursor:pointer;
  }
  .btn-primary{background:#3b82f6; color:#fff;}
  .btn-primary:hover{background:#2563eb;}
  .btn-ghost{background:transparent; color:#fff; border-color:#4b5563;}
  .btn-ghost:hover{background:#2f3542;}
  .note{
    max-width:1050px; margin:14px auto 0; padding:10px 16px;
    background:#fff7e6; border:1px solid #f0c36d; border-radius:6px;
    font-family:Arial, Helvetica, sans-serif; font-size:12.5px; color:#5a4400; line-height:1.55;
  }
  .note b{display:block; margin-bottom:2px;}
  .page-tag{
    max-width:297mm; margin:18px auto 0; font-family:Arial, Helvetica, sans-serif;
    font-size:11px; color:#e5e7eb; text-align:center; letter-spacing:.4px; text-transform:uppercase;
  }
  .stage{padding:0;}

  .page{
    width:297mm; height:210mm;
    margin:6px auto 30px;
    background:var(--paper);
    box-shadow:none;
    padding:8mm;
  }
  .sheet{
    width:100%; height:100%;
    border:1.4px solid var(--ink);
    display:flex;
    padding:4mm;
  }
  .half{
    width:50%;
    padding:2.5mm 5mm;
    display:flex;
    flex-direction:column;
  }
  .half + .half{margin-left:4mm;}

  h2.section-title{
    text-align:center; font-size:13.5px; font-weight:bold;
    margin:0 0 7px; letter-spacing:.3px; text-transform:uppercase;
  }

  table{width:100%; border-collapse:collapse; font-size:8.6px;}
  th,td{border:1px solid var(--ink); padding:2px 2px; text-align:center; vertical-align:middle;}
  th{background:var(--hdr-bg); font-weight:bold;}
  td.label, th.label{text-align:left; font-weight:normal;}

  table.attendance{font-size:9px; table-layout:fixed;}
  table.attendance td, table.attendance th{padding:2px 1px;}
  .v-month-cell{height:25mm; padding:1.5mm 0.5mm !important; vertical-align:bottom !important; text-align:center !important;}
  .v-month-text{writing-mode:vertical-rl; -webkit-writing-mode:vertical-rl; transform:rotate(180deg); -webkit-transform:rotate(180deg); white-space:nowrap; font-weight:bold; font-size:7.5pt; display:inline-block; margin:0 auto; line-height:1;}
  .row-label{text-align:left; width:32mm; font-weight:bold; line-height:1.15;}

  .signature-block{margin-top:16px;}
  .signature-block h2{font-size:12.5px; margin-bottom:10px;}
  .quarter-row{display:flex; align-items:flex-end; margin-bottom:12px; font-size:10.5px;}
  .quarter-row .q-label{width:68px; flex:none;}
  .quarter-row .fill-val{flex:1; border-bottom:1px solid var(--ink); min-height:14px; text-align:center; font-weight:bold;}

  .cover-head{position:relative; display:flex; align-items:center; justify-content:center; min-height:52px;}
  .seal{position:absolute; left:0; top:50%; transform:translateY(-50%); width:48px; height:48px; object-fit:contain;}
  .cover-head .school-logo{position:absolute; right:0; top:50%; transform:translateY(-50%); width:48px; height:48px; object-fit:contain;}
  .cover-head .titles{text-align:center; width:100%;}
  .form-code{font-size:9.5px; margin:0 0 2px;}
  .cover-head h1{font-size:13.5px; margin:0; line-height:1.25; text-align:center; font-weight:bold;}

  .field-row{display:flex; align-items:baseline; gap:5px; margin:4px 0; font-size:10.5px;}
  .field-row label{flex:none; width:54px;}
  .field-row .fill-val{flex:1; border-bottom:1px solid var(--ink); padding:0 4px; font-weight:bold;}

  .rpt-title{text-align:center; margin:9px 0 2px;}
  .rpt-title .t1{font-size:13px; font-weight:bold; letter-spacing:.3px;}
  .rpt-title .t2{font-size:10px; margin-top:2px;}
  .rpt-title .t2 .sy-val{display:inline-block; min-width:80px; border-bottom:1px solid var(--ink); text-align:center; font-size:10px; font-weight:bold;}

  .learner-fields{margin:8px 0 6px; font-size:10.5px;}
  .learner-fields .lf-row{display:flex; gap:12px; margin-bottom:4px;}
  .learner-fields .lf-item{display:flex; align-items:baseline; gap:4px;}
  .learner-fields .lf-item label{flex:none;}
  .learner-fields .lf-item .val{border-bottom:1px solid var(--ink); text-align:center; font-weight:bold;}
  .lf-name .val{width:100%; text-align:left; padding-left:4px;}
  .lf-age .val{width:56px;}
  .lf-sex .val{width:72px;}
  .lf-grade .val{width:44px;}
  .lf-section .val{width:60px;}
  .lf-lrn .val{width:96px;}

  .dear-parent{font-size:9.4px; line-height:1.4; margin:7px 0;}
  .dear-parent p{margin:0 0 6px; text-indent:18px;}

  .sig-line-row{display:flex; justify-content:space-between; margin-top:3px;}
  .sig-line{width:44%; text-align:center; font-size:9.4px;}
  .sig-line .val{width:100%; border-bottom:1px solid var(--ink); text-align:center; margin-bottom:2px; min-height:16px; font-weight:bold;}

  .cert-title{text-align:center; font-weight:bold; font-size:11px; margin:11px 0 6px;}
  .cert-fields{font-size:9.6px; line-height:1.7;}
  .cert-fields .cf-row{display:flex; flex-wrap:wrap; gap:4px; align-items:baseline;}
  .cert-fields .fill-inline{border-bottom:1px solid var(--ink); text-align:center; font-weight:bold;}

  .approved-row{display:flex; justify-content:space-between; margin-top:12px; font-size:9.4px;}
  .approved-row .sig-line{width:46%;}

  .cancel-title{text-align:center; font-weight:bold; font-size:10.5px; margin:13px 0 5px;}
  .principal-sig{margin-top:16px; display:flex; flex-direction:column; align-items:flex-end; font-size:9.4px;}
  .principal-sig .sig-wrap{width:170px; text-align:center;}
  .principal-sig .val{width:100%; border-bottom:1px solid var(--ink); text-align:center; margin-bottom:2px; font-weight:bold; min-height:14px;}

  .grade-head{font-size:13.5px; font-weight:bold; margin-bottom:5px;}
  .grade-head .grade-val{border-bottom:1px solid var(--ink); font-weight:bold; font-size:13.5px; text-align:center; padding:0 6px;}

  table.progress td.label{padding-left:4px;}
  table.progress td.indent{padding-left:13px; font-style:italic; text-align:left;}
  table.progress td.mapeh{text-align:left; font-weight:bold;}
  table.progress tr.gen-avg td{font-weight:bold; background:#f2f4f8;}
  table.progress tr.gen-avg td:not(:first-child){text-align:center;}
  table.progress tr.gen-avg td:first-child{text-align:left;}

  .legend{margin-top:8px; font-size:8.4px;}
  .legend-title{font-weight:bold; margin-bottom:3px; font-size:9px;}

  table.values th.bs, table.values td.bs{text-align:left; width:44%;}
  table.values th.cv, table.values td.cv{width:20%; text-align:left;}
  table.comments-table td.comment-text{min-height:18mm; white-space:pre-wrap; vertical-align:top;}
  .numeric-legend{margin-top:5mm;}

  .marking-legend{margin-top:12px; font-size:9.6px;}
  .marking-legend h4{margin:0 0 5px; font-size:10px;}
  .marking-legend table{width:auto;}
  .marking-legend td{border:none; padding:1px 10px 1px 0; text-align:left;}

  .inner-report .sheet{padding:4mm; align-items:stretch;}
  .inner-report .half{padding:1.8mm 3.6mm; min-height:0;}
  .inner-report .half + .half{margin-left:4mm;}
  .inner-report h2.section-title{font-size:13.2px; margin-bottom:6px;}
  .inner-report .grade-head{font-size:14px; margin-bottom:5px;}
  .inner-report .grade-head .grade-val{font-size:14px; min-width:42px; display:inline-block;}
  .inner-report table{font-size:9.5px; line-height:1.15;}
  .inner-report th,
  .inner-report td{padding:3px 2.4px;}
  .inner-report table.progress{height:122mm;}
  .inner-report table.progress th,
  .inner-report table.progress td{font-size:9.5px;}
  .inner-report table.progress td.indent{padding-left:16px;}
  .inner-report .legend{margin-top:5mm;}
  .inner-report .legend table{font-size:9.3px;}
  .inner-report .legend th,
  .inner-report .legend td{padding:3px 4px;}
  .inner-report table.values{height:123mm;}
  .inner-report table.values th,
  .inner-report table.values td{font-size:9.2px; padding:3px 3px;}
  .inner-report table.values th.bs,
  .inner-report table.values td.bs{width:48%; line-height:1.15;}
  .inner-report table.values th.cv,
  .inner-report table.values td.cv{width:18%; text-align:left;}
  .inner-report .marking-legend{
    margin-top:5mm;
    padding:2.8mm 4mm;
    border:1px solid var(--ink);
    background:#f7f9fc;
    font-size:9.5px;
  }
  .inner-report .marking-legend h4{font-size:9.8px;}
  .inner-report .marking-legend table{width:100%;}
  .inner-report .marking-legend td{padding:1.5px 10px 1.5px 0;}

  @media print{
    body{background:#fff;}
    .toolbar, .note, .page-tag{display:none !important;}
    .stage{padding:0;}
    .page{
      box-shadow:none; margin:0; width:100%; height:100%;
      page-break-after:always;
    }
    .page:last-child{page-break-after:auto;}
    @page{ size: A4 landscape; margin:0; }
  }
</style>
</head>
<body>

<div class="stage">

  <div class="page-tag">Page 1 of 2 &mdash; Outer covers</div>
  <!-- ============ PAGE 1 : OUTER COVERS ============ -->
  <div class="page">
    <div class="sheet">

      <!-- LEFT HALF : back cover -->
      <div class="half">
        <div class="attendance-block">
          <h2 class="section-title">REPORT ON ATTENDANCE</h2>
          <table class="attendance">
            <thead>
              <tr>
                <th class="row-label"></th>
                ${attHead}
                <th class="v-month-cell"><div class="v-month-text">Total</div></th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="row-label">No. of school days</td>
                ${attDays}
                <td><strong>${attTotDays}</strong></td>
              </tr>
              <tr>
                <td class="row-label">No. of days present</td>
                ${attPresent}
                <td><strong>${attTotPresent}</strong></td>
              </tr>
              <tr>
                <td class="row-label">No. of days absent</td>
                ${attAbsent}
                <td><strong>${attTotAbsent}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="signature-block">
          <h2 class="section-title">Parent/Guardian's Signature</h2>
          ${parentSignaturesHtml}
        </div>
      </div>

      <!-- RIGHT HALF : front cover -->
      <div class="half">
        <p class="form-code">SF 9 - ES</p>
        <div class="cover-head" style="margin-top:-10px;">
          <img src="${escapeHtml(depedLogoUrl || '../assets/img/logo/Seal_of_the_Department_of_Education_of_the_Philippines.png')}" alt="DepEd Seal" class="seal">
          <img src="${escapeHtml(schoolLogoUrl || '../assets/img/logo/logo.png')}" alt="School logo" class="school-logo">
          <div class="titles">
            <h1>Republic of the Philippines<br>DEPARTMENT OF EDUCATION</h1>
          </div>
        </div>

        <div style="margin-top:7px;">
          <div class="field-row"><label>Region</label><div class="fill-val">${escapeHtml(region)}</div></div>
          <div class="field-row"><label>Division</label><div class="fill-val">${escapeHtml(division)}</div></div>
          <div class="field-row"><label>District</label><div class="fill-val">${escapeHtml(district)}</div></div>
          <div class="field-row"><label>School</label><div class="fill-val">${escapeHtml(schoolName)}</div></div>
        </div>

        <div class="rpt-title">
          <div class="t1">LEARNER'S PROGRESS REPORT CARD</div>
          <div class="t2">School Year <span class="sy-val">${escapeHtml(schoolYear)}</span></div>
        </div>

        <div class="learner-fields">
          <div class="lf-row lf-name"><label>Name:</label><div class="val">${escapeHtml(learner?.name || '')}</div></div>
          <div class="lf-row">
            <div class="lf-item lf-age"><label>Age:</label><div class="val">${escapeHtml(age)}</div></div>
            <div class="lf-item lf-sex"><label>Sex:</label><div class="val">${escapeHtml(sex)}</div></div>
          </div>
          <div class="lf-row">
            <div class="lf-item lf-grade"><label>Grade:</label><div class="val">${escapeHtml(gradeLevel)}</div></div>
            <div class="lf-item lf-section"><label>Section:</label><div class="val">${escapeHtml(section)}</div></div>
            <div class="lf-item lf-lrn"><label>LRN:</label><div class="val">${escapeHtml(lrn)}</div></div>
          </div>
        </div>

        <div class="dear-parent">
          <p style="text-indent:0;">Dear Parent,</p>
          <p>This report card shows the ability and the progress your child has made in the different learning areas as well as his/her progress in core values.</p>
          <p>The school welcomes you should you desire to know more about your child's progress.</p>
        </div>

        <div class="sig-line-row">
          <div class="sig-line"></div>
          <div class="sig-line"><div class="val">${escapeHtml(adviserName)}</div><span>Teacher</span></div>
        </div>
        <div class="sig-line-row" style="margin-top:3px;">
          <div class="sig-line"><div class="val">${escapeHtml(principalName)}</div><span>${escapeHtml(principalTitle)}</span></div>
          <div class="sig-line"></div>
        </div>

        <div class="cert-title">Certificate of Transfer</div>
        <div class="cert-fields">
          <div class="cf-row">Admitted to Grade <span class="fill-inline" style="width:46px;">&nbsp;</span> Section <span class="fill-inline" style="width:56px;">&nbsp;</span> Room <span class="fill-inline" style="width:46px;">&nbsp;</span></div>
          <div class="cf-row">Eligible for Admission to Grade <span class="fill-inline" style="width:170px;">&nbsp;</span></div>
          <div class="cf-row">Approved:</div>
        </div>
        <div class="approved-row">
          <div class="sig-line"><div class="val">&nbsp;</div><span>Head Teacher/ Principal</span></div>
          <div class="sig-line"><div class="val">&nbsp;</div><span>Teacher</span></div>
        </div>

        <div class="cancel-title">Cancellation of Eligibility to Transfer</div>
        <div class="cert-fields">
          <div class="cf-row">Admitted in <span class="fill-inline" style="flex:1; min-width:150px;">&nbsp;</span></div>
          <div class="cf-row">Date: <span class="fill-inline" style="width:120px;">&nbsp;</span></div>
        </div>
        <div class="principal-sig">
          <div class="sig-wrap">
            <div class="val">&nbsp;</div>
            <span>Principal</span>
          </div>
        </div>
      </div>

    </div>
  </div>

  <div class="page-tag">Page 2 of 2 &mdash; Inner report</div>
  <!-- ============ PAGE 2 : INNER REPORT ============ -->
  <div class="page inner-report">
    <div class="sheet inner-sheet">

      <!-- LEFT HALF : Learning progress -->
      <div class="half">
        <div class="grade-head">GRADE <span class="grade-val">${escapeHtml(gradeLevel)}</span></div>
        <h2 class="section-title">Report on Learning Progress and Achievement</h2>

        <table class="progress">
          <thead>
            <tr>
              <th rowspan="2" style="width:34%;">Learning Areas</th>
              <th colspan="${periods.length}">${escapeHtml(periodHeaderTitle)}</th>
              <th rowspan="2">Final<br>Rating</th>
              <th rowspan="2">Remarks</th>
            </tr>
            <tr>${periods.map((p, i) => `<th>${i + 1}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${progressBodyHtml}
            <tr class="gen-avg">
              <td style="border:none; background:transparent;"></td>
              <td colspan="${periods.length}" style="text-align:center; font-weight:bold;">General Average</td>
              <td>${generalAverage !== null && generalAverage !== undefined && generalAverage !== '' ? formatRating(generalAverage) : ''}</td>
            </tr>
          </tbody>
        </table>

        <div class="legend">
          <table>
            <thead>
              <tr>
                <th>Descriptors</th>
                <th>Grading Scale</th>
                <th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              <tr><td class="label">Outstanding</td><td>90-100</td><td>Passed</td></tr>
              <tr><td class="label">Very Satisfactory</td><td>85-89</td><td>Passed</td></tr>
              <tr><td class="label">Satisfactory</td><td>80-84</td><td>Passed</td></tr>
              <tr><td class="label">Fairly Satisfactory</td><td>75-79</td><td>Passed</td></tr>
              <tr><td class="label">Did Not Meet Expectations</td><td>Below 75</td><td>Failed</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- RIGHT HALF : Observed values or term comments -->
      <div class="half">
        ${isNumericDepEdTemplate ? `
        <h2 class="section-title">Teacher's Comments / Remarks</h2>
        ${buildTermCommentsTable(termComments, periods)}
        <div class="numeric-legend">${buildNumericDescriptorLegend()}</div>
        ` : `
        <h2 class="section-title">Report on Learner's Observed Values</h2>
        <table class="values">
          <thead>
            <tr>
              <th class="cv">Core Values</th>
              <th class="bs">Behavior Statements</th>
              <th colspan="${periods.length}">${escapeHtml(periodHeaderTitle)}</th>
            </tr>
            <tr><th></th><th></th>${periods.map((p, i) => `<th>${i + 1}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${observedBodyHtml}
          </tbody>
        </table>

        <div class="marking-legend">
          <div style="display:flex; gap:50px;">
            <h4>Marking</h4>
            <h4>Non-numerical Rating</h4>
          </div>
          <table>
            <tbody>
              <tr><td>AO</td><td>Always Observed</td></tr>
              <tr><td>SO</td><td>Sometimes Observed</td></tr>
              <tr><td>RO</td><td>Rarely Observed</td></tr>
              <tr><td>NO</td><td>Not Observed</td></tr>
            </tbody>
          </table>
        </div>
        `}
      </div>

    </div>
  </div>

</div>

</body>
</html>`;
}

function findSchemaTemplateGradeRow(grades, rowDefinition) {
    const binding = String(rowDefinition?.binding || '').trim();
    const label = String(rowDefinition?.label || '').trim();
    const keywords = [binding, label].filter(Boolean);
    if (!keywords.length) return null;
    return findGradeRowExactFirst(grades, keywords);
}

function expandTemplateColumns(columns, periods) {
    const expanded = [];
    (Array.isArray(columns) ? columns : []).forEach((column) => {
        if (!column || typeof column !== 'object') return;
        if (column.type === 'period' || column.source === 'grading_periods') {
            (Array.isArray(periods) ? periods : []).forEach((period) => {
                expanded.push({
                    ...column,
                    key: period.key,
                    label: period.label || period.name || 'Term',
                    source: 'grading_period',
                    period,
                });
            });
            return;
        }
        expanded.push(column);
    });
    return expanded;
}

function buildSchemaDrivenLearningTable(grades, generalAverage, periods, templateSchema) {
    const schema = templateSchema && typeof templateSchema === 'object' ? templateSchema : null;
    const columns = expandTemplateColumns(schema?.columns, periods);
    const rowDefinitions = Array.isArray(schema?.rows) ? schema.rows : [];
    if (!columns.length || !rowDefinitions.length) return '';

    // A published template may contain a fixed row layout from an older
    // curriculum. Do not render its missing/extra rows. Only use the schema
    // when its learning-area definitions map one-to-one to the current
    // curriculum-resolved rows; otherwise the caller uses the same dynamic
    // subject projection as the report-card preview.
    const subjectDefinitions = rowDefinitions.filter((definition) => String(definition?.type || 'learning_area') !== 'group');
    const currentRows = Array.isArray(grades) ? grades : [];
    if (subjectDefinitions.length !== currentRows.length) return '';
    const unmatchedRows = currentRows.filter((gradeRow) => !subjectDefinitions.some((definition) => {
        const keywords = [definition?.binding, definition?.label].filter(Boolean).map((value) => String(value));
        return keywords.length && findGradeRowExactFirst([gradeRow], keywords) === gradeRow;
    }));
    if (unmatchedRows.length) return '';

    const rows = rowDefinitions.map((definition, rowIndex) => {
        const definitionType = String(definition?.type || 'learning_area');
        const label = String(definition?.label || definition?.key || 'Learning Area');
        if (definitionType === 'group') {
            return `<tr class="category-row"><td colspan="${columns.length + 1}">${escapeHtml(label)}</td></tr>`;
        }

        const gradeRow = findSchemaTemplateGradeRow(grades, definition) || {};
        const hasPeriods = periods.length > 0 && hasAllPeriods(gradeRow, periods);
        const finalGrade = hasPeriods ? computeReportCardAverage(periods.map((period) => gradeRow[period.key])) : null;
        const cells = columns.map((column, columnIndex) => {
            let value = '';
            if (column.source === 'grading_period' && column.period) {
                value = gradeRow[column.period.key] ?? '';
            } else if (column.source === 'final_grade' || column.key === 'final_grade') {
                value = hasPeriods ? finalGrade : '';
            } else if (column.source === 'remarks' || column.key === 'remarks') {
                value = hasPeriods && finalGrade !== null ? (gradeRow.remarks || remarksFor(finalGrade)) : '';
            } else {
                // A custom column has no legacy grade source yet. Leave it
                // blank rather than deriving a value from an unrelated term.
                value = gradeRow[column.key] ?? '';
            }
            const display = column.type === 'text' || column.source === 'remarks'
                ? escapeHtml(value)
                : formatRating(value);
            const customClass = column.type === 'computed' ? ' computed-cell' : '';
            return `<td class="${customClass.trim()}">${display}</td>`;
        }).join('');
        return `<tr class="lp"><td class="l">${escapeHtml(label)}</td>${cells}</tr>`;
    }).join('');

    const finalColumnIndex = columns.findIndex((column) => column.source === 'final_grade' || column.key === 'final_grade');
    const remarksColumnIndex = columns.findIndex((column) => column.source === 'remarks' || column.key === 'remarks');
    const averageIndex = finalColumnIndex >= 0 ? finalColumnIndex : Math.max(0, columns.length - 1);
    const leadingSpan = Math.max(1, averageIndex + 1);
    const trailingCells = columns.length - leadingSpan;
    const averageRow = schema?.options?.show_general_average !== false
        ? `<tr class="general-average-row"><td colspan="${leadingSpan}">General Average</td><td>${formatRating(generalAverage)}</td>${'<td></td>'.repeat(Math.max(0, trailingCells))}</tr>`
        : '';

    const header = columns.map((column) => `<th${column.type === 'computed' ? ' class="computed-cell"' : ''}>${escapeHtml(column.label || '')}</th>`).join('');
    return `
        <table class="sf9-numeric-grades schema-driven-template">
            <thead><tr><th class="learning-area">Learning Areas</th>${header}</tr></thead>
            <tbody>${rows || `<tr><td colspan="${columns.length + 1}">&nbsp;</td></tr>`}${averageRow}</tbody>
        </table>
    `;
}

function buildNumericTemplateLearningTable(grades, generalAverage, periods, templateVariant, templateSchema = null) {
    const displayRows = buildNumericTemplateRows(grades, periods, templateVariant);
    const schemaTable = buildSchemaDrivenLearningTable(displayRows, generalAverage, periods, templateSchema);
    if (schemaTable) return schemaTable;

    const averageRows = displayRows.filter((row) => !row._isMapehComponentDisplay);
    const allComplete = averageRows.length > 0 && averageRows.every((row) => hasAllPeriods(row, periods));
    const rows = displayRows.length ? displayRows.map((row) => `
        <tr class="lp">
            <td class="l ${row._isMapehComponentDisplay ? 'sub' : ''}">${row._isMapehComponentDisplay ? '&nbsp;&nbsp;&nbsp;' : ''}${escapeHtml(row.subject || row.subject_name || '')}</td>
            ${periods.map((period) => `<td>${formatRating(row[period.key])}</td>`).join('')}
            <td>${!row._isMapehComponentDisplay && hasAllPeriods(row, periods) ? formatRating(row.finalRating) : ''}</td>
            <td>${!row._isMapehComponentDisplay && hasAllPeriods(row, periods) ? escapeHtml(row.remarks || remarksFor(row.finalRating)) : ''}</td>
        </tr>
    `).join('') : `<tr><td colspan="${periods.length + 3}">&nbsp;</td></tr>`;

    return `
        <table class="sf9-numeric-grades">
            <thead>
                <tr>
                    <th rowspan="2" class="learning-area" style="width:38%">Learning Areas</th>
                    <th colspan="${periods.length}">TERM</th>
                    <th rowspan="2">Final<br>Grade</th>
                    <th rowspan="2" class="remarks-column" style="width:22%">Remarks</th>
                </tr>
                <tr>${periods.map((period) => `<th title="${escapeHtml(period.name)}">${escapeHtml(period.label)}</th>`).join('')}</tr>
            </thead>
            <tbody>
                ${rows}
                <tr class="general-average-row">
                    <td colspan="${periods.length + 1}">General Average</td>
                    <td>${allComplete ? formatRating(generalAverage) : ''}</td>
                    <td>${allComplete ? escapeHtml(remarksFor(generalAverage)) : ''}</td>
                </tr>
            </tbody>
        </table>
    `;
}

function buildNumericTemplateRows(grades, periods, templateVariant) {
    const rows = Array.isArray(grades) ? grades : [];
    // Use the same curriculum-resolved projection as the on-page report-card
    // summary so subject names and row counts cannot diverge in SF9.
    return buildCurriculumSubjectDisplayRows(rows, periods).map((row) => (
        row._isComponentBreakdown
            ? { ...row, _isMapehComponentDisplay: true }
            : row
    ));
}

function buildNumericTemplateCommentFields(termComments, periods) {
    const commentMap = new Map((Array.isArray(termComments) ? termComments : [])
        .map((comment) => [String(comment?.grading_period_id || ''), String(comment?.comment_text || '')]));
    const isLearner = isLearnerRole();
    return periods.map((period, index) => {
        const value = escapeHtml(commentMap.get(String(period.grading_period_id || '')) || '').replace(/\r?\n/g, '<br>');
        const termLabel = `Term ${period.period_no || index + 1}`;
        const editAttrs = isLearner
            ? ''
            : `contenteditable="true" spellcheck="true" data-term-comment="true" data-grading-period-id="${escapeHtml(String(period.grading_period_id || ''))}"`;
        return `
            <div class="term-comment-row">
                <b>${escapeHtml(termLabel)}</b><br>
                <span class="term-comment-editor" ${editAttrs}>${value}</span>
            </div>
        `;
    }).join('');
}

function buildNumericTemplateSf9DocumentHtml(data) {
    const school = data?.school || {};
    const enrollment = data?.enrollment || {};
    const learner = data?.learner || {};
    const periods = getReportPeriods(data);
    const templateVariant = String(enrollment?.sf9_template_variant || '').toUpperCase();
    // The API supplies a fallback schema when no published template exists.
    // Its default rows are only a layout fallback; they must not override the
    // curriculum/class-offering subject rows returned for this learner.
    const templateStatus = String(data?.template?.status || '').toLowerCase();
    const templateSchema = templateStatus === 'published' ? (data?.template?.schema || null) : null;
    const grades = (Array.isArray(data?.grades) ? data.grades : []).map((row) => sanitizeGradeRow(row, periods));
    const templateGrades = buildNumericTemplateRows(grades, periods, templateVariant);
    const generalAverage = computeGeneralAverage(templateGrades.filter((row) => !row._isMapehComponentDisplay), data?.general_average, periods);
    const attendance = buildAttendanceData(data?.attendance);
    const termComments = Array.isArray(data?.term_comments) ? data.term_comments : [];
    const learnerName = parseLearnerName(learner?.name);
    const schoolName = blankIfInvalid(school?.name || school?.school_name);
    const schoolYear = blankIfInvalid(enrollment?.school_year);
    const gradeLevel = blankIfInvalid(enrollment?.grade_level);
    const section = blankIfInvalid(enrollment?.section);
    const region = blankIfInvalid(school?.region);
    const division = blankIfInvalid(school?.division);
    const district = blankIfInvalid(school?.district);
    const logoMarkup = getLogoMarkup(school?.deped_logo_url);
    const rightLogoMarkup = getRightLogoMarkup(school?.logo_url);
    const documentTitle = ['SF9 Learner\'s Performance Report', learner?.name].filter(Boolean).join(' - ') || 'SF9 Learner\'s Performance Report';
    const isLowerElementaryTemplate = ['G2', 'G3'].includes(templateVariant);
    const municipalityProvince = [school?.municipality, school?.province]
        .map((value) => blankIfInvalid(value))
        .filter(Boolean)
        .join(', ') || 'Municipality/City, Province';
    const regionHeaderValue = region.replace(/^region\s*/i, '').trim();
    const divisionHeaderValue = division
        .replace(/^department of education\s*\(deped\)\s*/i, '')
        .replace(/^schools division\s+(of|office)\s*/i, '')
        .trim();
    const districtHeaderValue = district
        .replace(/^district\s*/i, '')
        .replace(/\s*district$/i, '')
        .trim();
    const gradeDisplay = gradeLevel.replace(/^grade\s*/i, '').trim() || gradeLevel;
    const activeMonthLabels = ['June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March', 'April'];
    const monthByLabel = new Map((attendance.months || []).map((month) => [formatFullMonthName(month?.label), month]));
    const activeMonths = activeMonthLabels.map((label) => monthByLabel.get(label) || ({ label, schoolDays: 0, present: null, absent: null }));
    const monthColumnWidth = (75 / activeMonths.length).toFixed(4);
    const monthHeaders = activeMonths.map((month) => `<th style="width:${monthColumnWidth}%">${escapeHtml(formatMonthAbbreviation(month.label))}</th>`).join('');
    const schoolDays = activeMonths.map((month) => `<td>${month.schoolDays ?? ''}</td>`).join('');
    const daysPresent = activeMonths.map((month) => `<td>${month.present ?? ''}</td>`).join('');
    const daysAbsent = activeMonths.map((month) => `<td>${month.absent ?? ''}</td>`).join('');
    const attendanceTotals = {
        schoolDays: activeMonths.reduce((sum, month) => sum + (Number(month.schoolDays) || 0), 0),
        present: activeMonths.reduce((sum, month) => sum + (Number(month.present) || 0), 0),
        absent: activeMonths.reduce((sum, month) => sum + (Number(month.absent) || 0), 0),
    };
    const termSignatures = periods.map((period, index) => `<div class="sg"><b>Term ${period.period_no || index + 1}</b><span class="f"></span></div>`).join('');
    const field = (value, width = '20mm') => `<span class="f" style="min-width:${width}">${escapeHtml(value || '')}</span>`;
    const regionLine = `${isLowerElementaryTemplate ? 'Region' : 'REGION'} ${field(regionHeaderValue, '14mm')}`;
    const divisionLine = isLowerElementaryTemplate ? 'SCHOOLS DIVISION OFFICE' : 'SCHOOLS DIVISION OF';
    const learnerFullName = [learnerName.lastName, learnerName.firstName, learnerName.middleName].filter(Boolean).join(' ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(documentTitle)}</title>
<style>
  :root{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);--bg:#e5e7eb;--bar:#fff;--fg:#111;--btn:#1f4e8c}
  *{box-sizing:border-box}
  html{scroll-padding-top:env(safe-area-inset-top,0px)}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,Segoe UI,sans-serif}
  .wrap{overflow-x:auto;padding:16px}
  .sheet{display:none;width:297mm;height:210mm;box-sizing:border-box;padding:7mm;gap:7mm;background:#fff;color:#000;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,.3);overflow:hidden}
  .sheet.show{display:flex}
  .pg{flex:1;min-width:0;border:1px solid #000;padding:5mm 6mm;display:flex;flex-direction:column;font:7.6pt/1.25 "Palatino Linotype",Palatino,Georgia,serif}
  .c{text-align:center}.b{font-weight:bold}
  .f{display:inline-block;border-bottom:1px solid #000;min-height:1.1em;vertical-align:bottom;outline:none}
  .hd{display:flex;align-items:center;gap:3mm;margin-bottom:2mm}
  .hd .t{flex:1;text-align:center}
  .school-name{text-transform:uppercase}
  .logo{width:21mm;height:21mm;border-radius:0;background:transparent;border:0;display:flex;align-items:center;justify-content:center;font-style:italic;font-size:8pt;text-align:center;overflow:hidden;flex:none}
  .logo img{width:100%;height:100%;object-fit:contain;background:transparent;border:0;display:block}
  .logo .seal-fallback{border:0;background:transparent;font-size:7pt;line-height:1.05;text-align:center}
  .fl{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1mm 3mm;margin:2mm 0}
  .fl>div{display:flex;gap:1mm;align-items:flex-end}.fl .f{flex:1}
  .sig{display:flex;gap:10mm;margin:7mm 0 2mm}.sig div{flex:1;border-top:1px solid #000;text-align:center;padding-top:.5mm}
  h4{margin:2.5mm 0 1mm;text-align:center;font-size:7.6pt}
  table{border-collapse:collapse;width:100%}
  td,th{border:1px solid #000;padding:0 1.2mm;height:5mm;font-size:7.4pt;outline:none}
  th{font-weight:bold;text-align:center}
  .sf9-numeric-grades .lp td{height:5.2mm}.sf9-numeric-grades td.l{text-align:left}.sf9-numeric-grades td.sub{font-style:italic}
  .sf9-numeric-grades td:nth-last-child(2), .sf9-numeric-grades td:last-child{text-align:center}
  .general-average-row td{font-weight:bold;font-style:italic}
  .general-average-row td:not(:first-child){text-align:center}
  .general-average-row td:first-child{text-align:left}
  .at{table-layout:fixed}.at td,.at th{height:5.6mm;text-align:center;font-size:6.6pt;padding:0;overflow:hidden}.at td.l{text-align:left;font-weight:bold;padding-left:1mm}
  .cm{border:1px solid #000;margin:0}.cm>div{height:15mm;border-bottom:1px solid #000;padding:.5mm 1mm;overflow:hidden}.cm>div:last-child{border:0}
  .term-comment-editor{display:block;min-height:9mm;outline:none;white-space:pre-wrap}
  .pd{margin-top:auto}.pd table{width:62%;margin:1mm auto 0}.pd td{border:0;height:auto;text-align:center;font-size:7.4pt}
  .sg{display:flex;align-items:flex-end;gap:2mm;margin:1.3mm 0 0 14mm}.sg .f{flex:1}
  .ln{display:flex;justify-content:space-between;gap:6mm;align-items:flex-end;margin-top:3mm}.ln div{border-top:1px solid #000;text-align:center;padding-top:.5mm;min-width:38mm}
  @media screen{[contenteditable]:hover{background:rgba(255,235,120,.35)}}
  @media print{
    @page{size:A4 landscape;margin:0}
    html,body{background:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .wrap{padding:0;overflow:visible}
    .sheet{box-shadow:none;margin:0;page-break-after:avoid;break-inside:avoid}
  }
</style>
</head>
<body class="sf9-reference-preview">
  <div class="wrap">
    <div class="sheet sf9-reference-sheet show">
      <div class="pg">
        <div class="hd">
          <div class="logo">${logoMarkup}</div>
          <div class="t">Republic of the Philippines<br>Department of Education<br>${regionLine}<br><span class="b">${divisionLine}</span> ${field(divisionHeaderValue, '14mm')}<br>District ${field(districtHeaderValue, '16mm')}<br>${escapeHtml(municipalityProvince)}<br><span class="b school-name">${escapeHtml(schoolName)}</span></div>
          <div class="logo">${rightLogoMarkup}</div>
        </div>
        <div class="c"><span class="b">LEARNER'S PERFORMANCE REPORT</span><br>School Year ${field(schoolYear, '30mm')}</div>
        <div class="fl">
          <div style="grid-column:span 2">Name: ${field(learnerFullName)}</div><div>Age: ${field(learner.age, '10mm')} Sex: ${field(learner.sex || learner.gender, '12mm')}</div>
          <div style="grid-column:span 2">LRN: ${field(learner.lrn)}</div><div>Grade: ${field(gradeDisplay, '8mm')} Section: ${field(section, '14mm')}</div>
          <div style="grid-column:span 3">Track (SHS only): ${field(school.track_strand || '', '40mm')}</div>
        </div>
        <div style="margin-top:2mm">Dear Parents,<br><span style="padding-left:10mm">This Performance Report presents your child's progress and achievement</span> in the different learning areas.<br><span style="padding-left:10mm">The school welcomes you to reach out should you wish to know more about your</span> child's learning and performance.</div>
        <div class="sig"><div>School Head</div><div>Adviser</div></div>
        <h4>LEARNING PROGRESS AND ACHIEVEMENT</h4>
        ${buildNumericTemplateLearningTable(grades, generalAverage, periods, templateVariant, templateSchema)}
        <div class="pd"><div class="b">PERFORMANCE DESCRIPTORS</div>
          <table><tr class="bold"><td>Grading Scale</td><td>Descriptors</td><td>Remarks</td></tr>
            <tr><td>90-100</td><td>Advancing</td><td>Passed</td></tr>
            <tr><td>80-89</td><td>Benchmarking</td><td>Passed</td></tr>
            <tr><td>75-79</td><td>Connecting</td><td>Passed</td></tr>
            <tr><td>65-74</td><td>Developing</td><td>Failed</td></tr>
            <tr><td>0-64</td><td>Emerging</td><td>Failed</td></tr>
          </table>
        </div>
      </div>
      <div class="pg">
        <table class="at">
          <tr><th style="width:17%;text-align:left">Month</th>${monthHeaders}<th style="width:8%">Total</th></tr>
          <tr><td class="l">No. of Class Days</td>${schoolDays}<td class="b">${attendanceTotals.schoolDays}</td></tr>
          <tr><td class="l">No. of Days Present</td>${daysPresent}<td class="b">${attendanceTotals.present}</td></tr>
          <tr><td class="l">No. of Days Absent</td>${daysAbsent}<td class="b">${attendanceTotals.absent}</td></tr>
        </table>
        <h4 style="margin-top:5mm">TEACHER'S COMMENTS / REMARKS</h4><div class="cm">${buildNumericTemplateCommentFields(termComments, periods)}</div>
        <h4 style="margin-top:5mm">PARENT/S GUARDIAN'S SIGNATURE</h4>${termSignatures}
        <h4 style="margin-top:6mm">CERTIFICATE OF TRANSFER</h4><div>This is to certify that the above-named learner has satisfactorily completed the requirements for the grade level indicated.</div>
        <div style="margin-top:5mm">Admitted to Grade: ${field('', '18mm')}</div><div style="margin-top:1.5mm">Eligible for Admission to Grade: ${field('', '30mm')}</div>
        <div style="margin-top:5mm">Approved:</div><div class="ln"><div>School Head</div><div>Adviser</div></div>
        <h4 style="margin-top:5mm">CANCELLATION OF ELIGIBILITY TO TRANSFER</h4><div>Admitted in: ${field('', '50mm')} &nbsp;Date: ${field('', '32mm')}</div><div class="ln" style="justify-content:flex-start"><div>School Head</div></div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function buildDescriptiveElementarySf9DocumentHtml(data) {
    const school = data?.school || {};
    const enrollment = data?.enrollment || {};
    const learner = data?.learner || {};
    const adviser = data?.adviser || {};
    const schoolName = blankIfInvalid(school?.name || school?.school_name);
    const region = blankIfInvalid(school?.region);
    const division = blankIfInvalid(school?.division);
    const district = blankIfInvalid(school?.district);
    const regionValue = region.replace(/^Region\s*/i, '').trim();
    const divisionValue = division
        .replace(/^Department of Education\s*\(DepEd\)\s*/i, '')
        .replace(/^SCHOOLS DIVISION OFFICE OF\s*/i, '')
        .replace(/^SCHOOLS DIVISION OF\s*/i, '')
        .trim();
    const schoolYear = blankIfInvalid(enrollment?.school_year);
    const section = blankIfInvalid(enrollment?.section);
    const adviserName = blankIfInvalid(adviser?.name);
    const learnerName = parseLearnerName(learner?.name);
    const learnerFullName = [learnerName.lastName, learnerName.firstName, learnerName.middleName]
        .filter(Boolean)
        .join(', ');
    const isGradeOneTemplate = isGradeOneDescriptiveSf9(data);
    const canEditTransferCancellation = isGradeOneTemplate && !isLearnerRole();
    const descriptiveFieldAttrs = (field, termNumber, label, spellcheck = 'true') => isGradeOneTemplate || isLearnerRole()
        ? ''
        : `contenteditable="true" spellcheck="${spellcheck}" aria-label="${escapeHtml(label)}" data-descriptive-field="${field}" data-term-number="${termNumber}"`;
    const transferFieldAttrs = (field, label) => canEditTransferCancellation
        ? `contenteditable="true" spellcheck="false" tabindex="0" role="textbox" aria-label="${escapeHtml(label)}" data-transfer-cancellation-field="${field}"`
        : '';
    const birthdate = blankIfInvalid(learner?.date_of_birth);
    const lrn = blankIfInvalid(learner?.lrn);
    const depedLogo = getLogoMarkup(school?.deped_logo_url);
    const rightLogoMarkup = getRightLogoMarkup(school?.logo_url);
    const attendance = buildAttendanceData(data?.attendance);
    const attendanceSource = Array.isArray(data?.attendance?.months) ? data.attendance.months : [];
    const hasAttendanceData = attendanceSource.some((item) =>
        item && [item.total_school_days, item.days_present, item.days_absent].some((value) => value !== null && value !== undefined && value !== '')
    );
    const attendanceByMonth = new Map(attendance.months.map((item) => [formatFullMonthName(item.label), item]));
    const attendanceRowSpecs = [
        { term: '1', month: 'June' },
        { term: '', month: 'July' },
        { term: '', month: 'August' },
        { term: '', month: 'September' },
        { term: '2', month: 'September' },
        { term: '', month: 'October' },
        { term: '', month: 'November' },
        { term: '', month: 'December' },
        { term: '3', month: 'January' },
        { term: '', month: 'February' },
        { term: '', month: 'March' },
        { term: '', month: 'April' },
    ];
    const attendanceRows = attendanceRowSpecs.map(({ term, month }) => {
        const item = attendanceByMonth.get(month) || { schoolDays: '', present: '', absent: '' };
        const value = (field) => hasAttendanceData && item[field] !== null && item[field] !== undefined && item[field] !== ''
            ? escapeHtml(String(item[field]))
            : '';
        return `<tr><td>${term}</td><td class="month">${month}</td><td>${value('schoolDays')}</td><td>${value('present')}</td><td>${value('absent')}</td></tr>`;
    }).join('');
    const totalValue = (field) => hasAttendanceData && attendance.totals?.[field] !== null && attendance.totals?.[field] !== undefined
        ? escapeHtml(String(attendance.totals[field]))
        : '';
    const termCards = [
        'TERM 1 (UNANG TERMINO)',
        'TERM 2 (IKALAWANG TERMINO)',
        'TERM 3 (IKATLONG TERMINO)',
    ].map((title, index) => `
        <div class="termbox"><div class="th">${title}</div>
        <div class="tb"><div class="tl"><b>What Your Child Can Do</b><br><b>(Mga Nagagawa)</b></div><div class="ta" ${descriptiveFieldAttrs('can-do', index + 1, `Term ${index + 1} What Your Child Can Do`)}></div></div>
        <div class="tb"><div class="tl"><b>What Your Child Is<br>Learning To Improve</b><br><b>(Dapat Linangin)</b></div><div class="ta" ${descriptiveFieldAttrs('learning-to-improve', index + 1, `Term ${index + 1} What Your Child Is Learning To Improve`)}></div></div>
        <div class="sig">Parent's/Guardian's Signature:<span class="sigline" ${descriptiveFieldAttrs('parent-signature', index + 1, `Term ${index + 1} Parent's or Guardian's Signature`, 'false')}></span></div></div>
    `).join('');
    const legendRows = [
        ['A', 'Advancing', 'Namumukod-tangi', 'Consistently demonstrates advanced skills, understanding, and values beyond expectations; applies learning independently, confidently, and with initiative across tasks and situations.'],
        ['B', 'Benchmarking', 'Naipamamalas', 'Demonstrates expected skills, understanding, and values at grade level with consistency; performs tasks accurately and independently in most situations.'],
        ['C', 'Connecting', 'Natutungo', 'Shows developing skills, understanding, and values; able to apply learning in familiar tasks with minimal guidance and support.'],
        ['D', 'Developing', 'Nagpapaunlad', 'Demonstrates emerging skills, understanding, and values; requires regular guidance, practice, and support to improve performance.'],
        ['E', 'Emerging', 'Nagsisimula', 'Beginning to demonstrate basic skills, understanding, and values; requires close supervision, structured support, and targeted intervention.'],
    ].map((row) => `<tr><td><strong>${row[0]}</strong></td><td><strong>${row[1]}</strong><br>(${row[2]})</td><td>${row[3]}</td></tr>`).join('');
    const documentTitle = ['SF9 Descriptive Report Card', learner?.name].filter(Boolean).join(' - ') || 'SF9 Descriptive Report Card';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(documentTitle)}</title>
<style>
@page portrait { size: 8.5in 13in; margin: 0; }
* { box-sizing: border-box; }
html { background: #d9dce1; }
body { margin: 0; padding: 18px 0 40px; color: #111; font-family: "Bookman Old Style", "Bookman", "Book Antiqua", Palatino, Georgia, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { position: relative; width: 8.5in; height: 13in; margin: 0 auto; padding: .3in .4in; overflow: hidden; background: #fff; page: portrait; }
.rc { font-size: 8pt; }
.rc-head { position: relative; text-align: center; font-size: 8.5pt; line-height: 1.3; }
.rc-head .seal { position: absolute; left: .55in; top: .2in; width: 1in; height: 1in; }
.rc-head .school-logo { position: absolute; right: .55in; top: .2in; width: 1in; height: 1in; }
.seal-image { width: 1in; height: 1in; object-fit: contain; }
.seal-fallback { width: 1in; height: 1in; display: flex; align-items: center; justify-content: center; text-align: center; font: 7pt Arial, sans-serif; }
.rc-head .sp { height: .04in; }
.rc-head .rt { font-size: 10pt; }
.rc-info { margin-top: .12in; font-size: 8pt; }
.rc-info .r { display: flex; align-items: flex-end; gap: 6px; margin: 3px 0; }
.rc-info .gap { margin-left: 18px; }
.ln { display: inline-block; border-bottom: 1px solid #000; min-width: .5in; height: 1.15em; vertical-align: bottom; }
.ln.s { min-width: .55in; } .ln.m { min-width: 1.3in; } .ln.wide { min-width: 2.2in; } .ln.grow { min-width: 1in; flex: 1; }
.rc-p { font: 7.3pt/1.3 Arial, Helvetica, sans-serif; margin: .08in 0 0; border-top: 1px solid #999; padding-top: .05in; }
.rc-cols { display: grid; grid-template-columns: 4.1in 1fr; gap: .16in; margin-top: .12in; }
.termbox { margin-bottom: .12in; } .th { margin-bottom: 3px; text-align: center; font-size: 8pt; font-weight: 700; }
.tb { display: grid; grid-template-columns: 1.15in 1fr; height: 1.3in; border: 1.5px solid #000; }
.tb + .tb { border-top: 1px solid #000; }
.tl { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 4px; border-right: 1px solid #000; text-align: center; font-size: 7.5pt; }
.ta { padding: 5px; font: 8.5pt Arial, sans-serif; background: #fff; outline: none; white-space: pre-wrap; overflow-wrap: anywhere; }
.sig { display: flex; align-items: flex-end; gap: 4px; margin-top: 3px; font: 7.5pt Arial, sans-serif; }
.sigline { flex: 1; height: 1em; border-bottom: 1px solid #000; outline: none; }
.bt { margin: .07in 0 3px; text-align: center; font-size: 8pt; font-weight: 700; }
.att { width: 100%; border-collapse: collapse; font: 7pt Arial, sans-serif; }
.att th, .att td { height: .163in; padding: 1px 3px; border: 1px solid #000; text-align: center; }
.att th { font-size: 6.5pt; } .att .mo { text-align: left; } .att .tn, .att .tot td { font-weight: 700; }
.note { margin: 3px 0; font: 7.3pt/1.3 Arial, sans-serif; } .note.c { text-align: center; }
.lvl { width: 100%; border-collapse: collapse; font: 6.8pt Arial, sans-serif; }
.lvl th, .lvl td { padding: 2px 4px; border: 1px solid #000; }
.lvl th { font-size: 7pt; } .lvl .lg { width: .65in; text-align: center; font-weight: 700; } .lvl .ds { width: 1.05in; text-align: center; } .lvl .dc { text-align: center; line-height: 1.25; }
.fl { display: flex; align-items: flex-end; gap: 5px; margin: 3px 0; font: 7.5pt Arial, sans-serif; }
.sg { width: 2.4in; margin: .12in auto 0; text-align: center; font: 7.5pt Arial, sans-serif; } .sg .sgl { height: .2in; border-bottom: 1px solid #000; }
@media screen { [contenteditable]:hover { background: rgba(255,235,120,.35); } [contenteditable]:focus { background: rgba(120,190,255,.25); outline: 1px solid #6b9fd3; outline-offset: -1px; } }
@media print { html { background: #fff; } body { padding: 0; } .page { margin: 0; } [contenteditable]:hover, [contenteditable]:focus { background: transparent; outline: none; } }
</style>
</head>
<body>
<main><section class="page portrait rc" id="rc">
<div class="rc-head"><div class="seal">${depedLogo}</div><div class="school-logo">${rightLogoMarkup}</div>
<div>Republic of the Philippines</div><div>Department of Education</div>
<div>Region <span class="ln s">${escapeHtml(regionValue)}</span></div><div><b>SCHOOLS DIVISION OFFICE OF</b> <span class="ln m">${escapeHtml(divisionValue)}</span></div>
<div>District</div><div>${escapeHtml(district || 'Sta. Maria, Bulacan')}</div><div class="sp"></div><div><b>${escapeHtml(schoolName || 'NAME OF SCHOOL')}</b></div>
<div class="sp"></div><div class="rt"><b>LEARNER'S PROGRESS REPORT CARD</b></div><div>School Year ${escapeHtml(schoolYear || '2026-2027')}</div></div>
<div class="rc-info">
<div class="r"><span>Name:</span><span class="ln grow">${escapeHtml(learnerFullName)}</span><span>LRN:</span><span class="ln m">${escapeHtml(lrn)}</span></div>
<div class="r"><span>Section:</span><span class="ln grow">${escapeHtml(section)}</span><span>Teacher:</span><span class="ln grow">${escapeHtml(adviserName)}</span><span>Birthdate:</span><span class="ln m">${escapeHtml(birthdate)}</span></div>
<div class="r"><span>Age of the Child (Beginning of SY): Years:</span><span class="ln s"></span><span>Months:</span><span class="ln s"></span><span class="gap">Age of the Child (End of SY): Years:</span><span class="ln s"></span><span>Months:</span><span class="ln s"></span></div></div>
<p class="rc-p">This report provides a descriptive account of your child’s learning progress for each term. It highlights what your child can already do, what they are currently developing, and how they can be further supported.</p>
<p class="rc-p">This report is based on varied evidence of learning, including classroom activities, observations, learner outputs, and assessments. It is designed to give a clearer and more meaningful understanding of your child’s development rather than relying on numerical or letter grades.</p>
<div class="rc-cols"><div class="rc-left">${termCards}</div><div class="rc-right">
<div class="bt">ATTENDANCE RECORD</div>
<table class="att"><thead><tr><th>Term</th><th>Month</th><th>No. of Class Days</th><th>No. of Days Present</th><th>No. of Times Absent</th></tr></thead><tbody>${attendanceRows}<tr class="tot"><td colspan="2">TOTAL</td><td>${totalValue('schoolDays')}</td><td>${totalValue('present')}</td><td>${totalValue('absent')}</td></tr></tbody></table>
<div class="bt">IMPORTANT NOTE TO PARENTS/GUARDIANS</div>
<p class="note">A detailed record of your child’s progress across specific learning competencies is attached in the succeeding pages. This includes the monitoring of skills in Reading and Literacy, Language, Mathematics, Good Manners and Right Conduct, and Makabansa.</p>
<p class="note c">Performance levels used in monitoring:</p>
<table class="lvl"><thead><tr><th>Letter Grade</th><th>Descriptor</th><th>Description</th></tr></thead><tbody>${legendRows}</tbody></table>
<div class="bt">CERTIFICATE OF TRANSFER</div>
<p class="note c">This is to certify that the above-named learner has satisfactorily completed the requirements for the grade level indicated.</p>
<div class="fl">Admitted to Grade: <span class="ln grow"></span></div>
<div class="fl">Eligible for Admission to Grade: <span class="ln grow"></span></div>
<div class="fl">Approved:</div>
<div class="sg"><div class="sgl"></div><i>Adviser</i></div><div class="sg"><div class="sgl"></div><i>School Head</i></div>
<div class="bt">CANCELLATION OF ELIGIBILITY TO TRANSFER</div>
<div class="fl">Admitted in: <span class="ln m" ${transferFieldAttrs('admitted-in', 'Admitted in')}></span> Date: <span class="ln s" ${transferFieldAttrs('date', 'Transfer cancellation date')}></span></div>
<div class="sg"><div class="sgl" ${transferFieldAttrs('school-head-signature', 'School Head signature')}></div><span>School Head</span></div>
</div></div></section></main>
</body>
</html>`;
    return isGradeOneDescriptiveSf9(data) ? appendDescriptivePacePages(html, data) : html;
}

function buildSf9DocumentHtml(data) {
    const school = data?.school || {};
    const enrollment = data?.enrollment || {};
    const learner = data?.learner || {};
    const adviser = data?.adviser || {};
    const curriculumLevel = inferCurriculumLevel(school, enrollment);
    const templateVariant = String(enrollment?.sf9_template_variant || '').toUpperCase();
    const isNumericDepEdTemplate = enrollment?.grading_mode !== 'Descriptive'
        && ['G2', 'G3', 'G4_10'].includes(templateVariant);

    if (isHandwrittenDescriptiveSf9(data)) {
        return buildDescriptiveElementarySf9DocumentHtml(data);
    }

    if (isNumericDepEdTemplate) {
        return buildNumericTemplateSf9DocumentHtml(data);
    }

    if (curriculumLevel === 'elementary' && !isNumericDepEdTemplate) {
        return buildElementarySf9DocumentHtml(data);
    }

    const formCode = getFormCode(curriculumLevel);
    const formTitle = 'LEARNER\'S PROGRESS REPORT CARD';
    const learnerName = parseLearnerName(learner?.name);
    const periods = getReportPeriods(data);
    const grades = (Array.isArray(data?.grades) ? data.grades : []).map((row) => sanitizeGradeRow(row, periods));
    const gradesForAverage = buildMapehAveragedGrades(grades, periods);
    const generalAverage = computeGeneralAverage(gradesForAverage, data?.general_average, periods);
    const attendance = buildAttendanceData(data?.attendance);
    const observedValuesRows = isNumericDepEdTemplate ? [] : buildObservedValuesRows(data?.core_values);
    const termComments = Array.isArray(data?.term_comments) ? data.term_comments : [];
    const schoolName = blankIfInvalid(school?.name || school?.school_name);
    const principalTitle = blankIfInvalid(school?.principal_title || 'Principal');
    const trackStrand = blankIfInvalid(school?.track_strand);
    const schoolYear = blankIfInvalid(enrollment?.school_year);
    const region = blankIfInvalid(school?.region);
    const division = blankIfInvalid(school?.division);
    const section = blankIfInvalid(enrollment?.section);
    const gradeLevel = blankIfInvalid(enrollment?.grade_level);
    const adviserName = blankIfInvalid(adviser?.name);
    const age = blankIfInvalid(learner?.age);
    const sex = blankIfInvalid(learner?.sex || learner?.gender);
    const motherTongue = blankIfInvalid(learner?.mother_tongue);
    const logoMarkup = getLogoMarkup(school?.deped_logo_url);
    const rightLogoMarkup = getRightLogoMarkup(school?.logo_url);
    const documentTitle = ['SF9 Report Card', learner?.name].filter(Boolean).join(' - ') || 'SF9 Report Card';

    const rawAttMonths = attendance.months || [];
    const activeAttMonths = rawAttMonths
        .map((m) => ({ ...m, label: formatMonthAbbreviation(m.label) }))
        .filter((m) => Boolean(m.label));

    const attendanceHeader = activeAttMonths.map((item) =>
        `<th class="v-month-cell"><div class="v-month-text">${escapeHtml(item.label)}</div></th>`
    ).join('');
    const attendanceSchoolDays = activeAttMonths.map((item) => `<td>${item.schoolDays !== '' && item.schoolDays !== null && item.schoolDays !== undefined ? item.schoolDays : ''}</td>`).join('');
    const attendancePresent = activeAttMonths.map((item) => `<td>${item.present !== '' && item.present !== null && item.present !== undefined ? item.present : ''}</td>`).join('');
    const attendanceAbsent = activeAttMonths.map((item) => `<td>${item.absent !== '' && item.absent !== null && item.absent !== undefined ? item.absent : ''}</td>`).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(documentTitle)}</title>
    <style>
        @page { size: A4 landscape; margin: 0; }
        :root { --sf9-page-width: 296mm; --sf9-page-height: 209mm; --sf9-page-pad: 6mm; --sf9-frame-pad: 3mm; --sf9-panel-gap: 4mm; }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; background: #fff; color: #000; font-family: "Times New Roman", serif; }
        body { padding: 8mm; display: flex; flex-wrap: wrap; justify-content: center; gap: 8mm; }
        .no-print { position: fixed; top: 10px; right: 10px; z-index: 10; background: #fff; color: #000; border: 0.5pt solid #000; padding: 6px 10px; font: 8pt "Times New Roman", serif; cursor: pointer; }
        .page { width: var(--sf9-page-width); height: var(--sf9-page-height); padding: var(--sf9-page-pad); overflow: hidden; page-break-after: always; break-after: page; break-inside: avoid; background: #fff; }
        .page:last-of-type { page-break-after: auto; break-after: auto; }
        .content-frame { width: 100%; height: 100%; border: 0.75pt solid #000; padding: var(--sf9-frame-pad); overflow: hidden; }
        .two-col { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--sf9-panel-gap); width: 100%; height: 100%; min-height: 0; }
        .panel { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
        .sf9-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        .sf9-table th, .sf9-table td { border: 0.5pt solid #000; padding: 1.2mm 1mm; font-size: 7.3pt; vertical-align: middle; text-align: center; }
        .sf9-table th { font-weight: 700; background: #f6f8fb; }
        .text-left { text-align: left !important; }
        .center { text-align: center; }
        .small { font-size: 7pt; }
        .tiny { font-size: 6.7pt; }
        .title { font-size: 9.2pt; font-weight: 700; letter-spacing: 0.15px; text-align: center; text-transform: uppercase; }
        .subsection-title { font-size: 8pt; font-weight: 700; text-align: center; margin-bottom: 1.2mm; text-transform: uppercase; }
        .top-id { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2mm; font-size: 8pt; font-weight: 700; }
        .lrn-wrap { display: flex; align-items: center; gap: 1.2mm; }
        .lrn-boxes { display: flex; gap: 0.7mm; }
        .lrn-box { width: 5.5mm; height: 5.8mm; border: 0.5pt solid #000; display: inline-flex; align-items: center; justify-content: center; font-size: 7.5pt; }
        .header-block { border: 0.5pt solid #000; padding: 2.2mm; height: calc(100% - 7mm); }
        /* Keep logo at top-left, but center the header text on the full page width */
        .deped-head { position: relative; min-height: 28mm; margin-bottom: 3mm; }
        .deped-seal { position: absolute; left: 0; top: 0; width: 19mm; }
        .deped-seal-right { position: absolute; right: 0; top: 0; width: 24mm; display: flex; justify-content: flex-end; }
        .seal-image, .seal-fallback { width: 18mm; height: 18mm; }
        .deped-seal-right .seal-image, .deped-seal-right .seal-fallback { width: 23mm; height: 23mm; }
        .seal-image { object-fit: contain; display: block; background: transparent; border: 0; }
        .seal-fallback { border: 0; border-radius: 0; background: transparent; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 6.8pt; line-height: 1.05; }
        .deped-text { position: absolute; left: 50%; top: 0; transform: translateX(-50%); width: calc(100% - 50mm); text-align: center; line-height: 1.2; }
        .deped-text .gov { font-size: 8pt; }
        .deped-text .dept { font-size: 9.5pt; font-weight: 700; text-transform: uppercase; }
        .deped-text .region-line, .deped-text .division-line, .deped-text .school-line { font-size: 7.7pt; }
        .school-name { font-size: 9.5pt; font-weight: 700; text-decoration: underline; text-transform: uppercase; margin-top: 1mm; }
        .student-info { margin-top: 1.4mm; font-size: 8pt; }
        .student-row { display: flex; align-items: flex-end; gap: 2mm; margin-bottom: 1.4mm; }
        .field-group { display: flex; align-items: flex-end; gap: 1.2mm; flex: 1; }
        .field-group.fixed { flex: 0 0 auto; }
        .field-label { font-size: 8pt; white-space: nowrap; }
        .field-line { flex: 1; min-width: 0; border-bottom: 0.5pt solid #000; min-height: 4.5mm; padding: 0 1mm 0.4mm; display: flex; align-items: flex-end; justify-content: center; text-align: center; }
        .field-caption { display: flex; gap: 2mm; margin: -0.7mm 0 1.1mm 12mm; font-size: 6.8pt; text-align: center; }
        .field-caption span { flex: 1; }
        .message-block { margin: 3mm 0 4mm; font-size: 7.7pt; line-height: 1.3; }
        .message-block p { margin: 0 0 1.4mm; text-indent: 5mm; font-style: italic; }
        .signature-stack { margin-top: 3mm; }
        .signature-name { text-align: center; font-size: 8pt; font-weight: 700; }
        .signature-role { text-align: center; font-size: 7pt; }
        .signature-line { border-top: 0.5pt solid #000; width: 55mm; margin: 4.5mm auto 0.8mm; }
        .attendance-box, .transfer-box { border: 0.5pt solid #000; padding: 2mm; }
        .attendance-box { margin-bottom: 3mm; }
        .attendance-table th, .attendance-table td { height: 6mm; padding: 1mm 0.5mm; }
        .attendance-table th.v-month-cell { height: 25mm; padding: 1.5mm 0.5mm !important; vertical-align: bottom !important; text-align: center !important; }
        .v-month-text { writing-mode: vertical-rl; -webkit-writing-mode: vertical-rl; transform: rotate(180deg); -webkit-transform: rotate(180deg); white-space: nowrap; font-weight: bold; font-size: 7.5pt; display: inline-block; margin: 0 auto; line-height: 1; }
        .attendance-table .label-cell { width: 33mm; text-align: left; font-weight: 700; line-height: 1.15; }
        .quarter-signatures { margin-top: 3mm; font-size: 7pt; }
        .quarter-signatures .row { display: flex; align-items: center; gap: 2mm; margin-bottom: 2.5mm; }
        .quarter-signatures .line { flex: 1; border-bottom: 0.5pt solid #000; height: 4mm; }
        .transfer-section-title { font-size: 8pt; font-weight: 700; text-align: center; margin: 1mm 0 2mm; }
        .transfer-line { display: flex; align-items: flex-end; gap: 2mm; margin-bottom: 2mm; font-size: 7.4pt; }
        .transfer-fill { flex: 1; border-bottom: 0.5pt solid #000; min-height: 4mm; }
        .transfer-signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-top: 3mm; }
        .transfer-signatures .sig { text-align: center; font-size: 7pt; }
        .transfer-signatures .sig .line, .cancel-line { border-bottom: 0.5pt solid #000; height: 5mm; margin-bottom: 1mm; }
        /* Back page: locked 50/50 split (no responsive reflow) */
        .back-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--sf9-panel-gap); width: 100%; height: 100%; min-height: 0; overflow: hidden; }
        .back-grid.numeric-template { grid-template-columns: minmax(0, 1fr); }
        .grades-panel, .values-panel { height: 100%; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
        .comments-panel { height: 100%; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
        .grades-panel .title, .values-panel .title { margin-bottom: 1.2mm; }
        .table-block { flex: 1 1 auto; min-height: 0; max-height: 100%; overflow: hidden; }
        .grades-panel .table-block { flex: 1 1 auto; max-height: calc(var(--sf9-page-height) - (var(--sf9-page-pad) * 2) - (var(--sf9-frame-pad) * 2) - 9mm); }
        .values-panel .table-block { flex: 1 1 auto; max-height: calc(var(--sf9-page-height) - (var(--sf9-page-pad) * 2) - (var(--sf9-frame-pad) * 2) - 43mm); }
        .table-block > table { height: auto; max-height: 100%; }
        .subject-col { width: auto; }
        .grades-table td, .grades-table th { font-size: 7.45pt; padding-top: 1.35mm; padding-bottom: 1.35mm; }
        .grades-table td.subject-col, .grades-table th.subject-col { overflow-wrap: anywhere; }
        .sf9-table td:nth-last-child(2), .sf9-table td:last-child { text-align: center; }
        .sf9-table tr.general-average-row td:not(:first-child) { text-align: center; }
        .sf9-table tr.general-average-row td:first-child { text-align: left; }
        .sf9-table tfoot td:not(.footer-label) { text-align: center; }
        .sf9-table tfoot td.footer-label { text-align: left; }
        .category-row td { font-weight: 700; text-align: left; background: #fafbfc; }
        .footer-label { font-weight: 700; }
        .semester-block { margin-bottom: 3mm; }
        .corrected-line { margin-top: 4mm; font-size: 7.4pt; text-align: left; }
        .values-panel .title { margin-bottom: 2mm; }
        .comments-table td.comment-text { min-height: 16mm; white-space: pre-wrap; vertical-align: top; text-align: left; }
        .numeric-template .grades-panel .table-block { max-height: calc(var(--sf9-page-height) - (var(--sf9-page-pad) * 2) - (var(--sf9-frame-pad) * 2) - 9mm); }
        .numeric-template .comments-panel .table-block { max-height: 58mm; }
        .numeric-template .numeric-legend { margin-top: 4mm; max-width: 110mm; }
        .core-value-col { width: 22mm; font-weight: 700; }
        .behavior-col { width: auto; }
        /* Legends live under Observed Values (right panel) */
        .legend-row { display: grid; grid-template-columns: 1fr 1fr; gap: 2mm; margin-top: 1.2mm; align-items: start; }
        .legend-box { width: 100%; }
        .legend-box .subsection-title { font-size: 7.1pt; margin-bottom: 0.6mm; line-height: 1.05; }
        .legend-table th, .legend-table td { font-size: 6.45pt; padding: 0.65mm 0.7mm; line-height: 1.05; }
        .summary-note { margin-top: 2mm; font-size: 7pt; text-align: left; }
        @media print {
            body { padding: 0; display: block; gap: 0; }
            .no-print { display: none; }
            .page { margin: 0; width: var(--sf9-page-width); height: var(--sf9-page-height); }
            .content-frame, .two-col, .back-grid, .panel, .grades-panel, .values-panel, .comments-panel, .table-block { break-inside: avoid; page-break-inside: avoid; }
        }
    </style>
</head>
<body>
    <div class="page">
        <div class="content-frame">
            <div class="two-col">
                <div class="panel">
                    <div class="attendance-box">
                        <div class="subsection-title">REPORT ON ATTENDANCE</div>
                        <table class="sf9-table attendance-table">
                        <thead>
                            <tr>
                                <th class="label-cell"></th>
                                ${attendanceHeader}
                                <th class="v-month-cell"><div class="v-month-text">Total</div></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td class="label-cell">No. of school days</td>
                                ${attendanceSchoolDays}
                                <td><strong>${attendance.totals.schoolDays || ''}</strong></td>
                            </tr>
                            <tr>
                                <td class="label-cell">No. of days present</td>
                                ${attendancePresent}
                                <td><strong>${attendance.totals.present !== null && attendance.totals.present !== undefined ? attendance.totals.present : ''}</strong></td>
                            </tr>
                            <tr>
                                <td class="label-cell">No. of days absent</td>
                                ${attendanceAbsent}
                                <td><strong>${attendance.totals.absent !== null && attendance.totals.absent !== undefined ? attendance.totals.absent : ''}</strong></td>
                            </tr>
                        </tbody>
                        </table>
                        <div class="quarter-signatures">
                            <div class="small" style="font-weight:700;">PARENT / GUARDIAN'S SIGNATURE</div>
                            ${periods.map((period) => `<div class="row"><span>${escapeHtml(period.name)}</span><span class="line"></span></div>`).join('')}
                        </div>
                    </div>
                    <div class="transfer-box">
                        <div class="transfer-section-title">Certificate of Transfer</div>
                        <div class="transfer-line"><span>Admitted to Grade:</span><span class="transfer-fill"></span><span>Section:</span><span class="transfer-fill"></span></div>
                        <div class="transfer-line"><span>Eligibility for Admission to Grade:</span><span class="transfer-fill"></span></div>
                        <div class="transfer-signatures">
                            <div class="sig">
                                <div class="line"></div>
                                <div>School Head</div>
                            </div>
                            <div class="sig">
                                <div class="line"></div>
                                <div>Adviser</div>
                            </div>
                        </div>
                        <div class="transfer-section-title" style="margin-top:4mm;">Cancellation of Eligibility to Transfer</div>
                        <div class="transfer-line"><span>Admitted in:</span><span class="transfer-fill"></span></div>
                        <div class="transfer-line"><span>Date:</span><span class="transfer-fill"></span><span style="width:26mm;"></span></div>
                        <div class="cancel-line" style="width:54mm; margin:5mm auto 1mm;"></div>
                        <div class="center small">School Head</div>
                    </div>
                </div>
                <div class="panel">
                    <div class="top-id">
                        <div>${escapeHtml(formCode)}</div>
                        <div class="lrn-wrap">
                            <span>LRN</span>
                            <span class="lrn-boxes">${buildLrnBoxes(learner?.lrn)}</span>
                        </div>
                    </div>
                    <div class="header-block">
                        <div class="deped-head">
                            <div class="deped-seal">${logoMarkup}</div>
                            <div class="deped-seal-right">${rightLogoMarkup}</div>
                            <div class="deped-text">
                                <div class="gov">Republic of the Philippines</div>
                                <div class="dept">DEPARTMENT OF EDUCATION</div>
                                <div class="region-line">${escapeHtml(region)}</div>
                                <div class="region-line">Region</div>
                                <div class="division-line" style="margin-top:1.2mm;">DIVISION OF ${escapeHtml(division)}</div>
                                <div class="division-line">Division</div>
                                <div class="school-name" style="margin-top:1.5mm;">${escapeHtml(schoolName)}</div>
                                <div class="school-line">School</div>
                            </div>
                        </div>
                        <div class="student-info">
                            <div class="student-row">
                                <div class="field-group"><span class="field-label">Name:</span><span class="field-line">${escapeHtml(learnerName.lastName)}</span><span class="field-line">${escapeHtml(learnerName.firstName)}</span><span class="field-line">${escapeHtml(learnerName.middleName)}</span></div>
                            </div>
                            <div class="field-caption"><span>Last Name</span><span>First Name</span><span>Middle Name</span></div>
                            <div class="student-row">
                                <div class="field-group fixed" style="width:40%;">
                                    <span class="field-label">Age:</span><span class="field-line">${escapeHtml(age)}</span>
                                </div>
                                <div class="field-group fixed" style="width:40%;">
                                    <span class="field-label">Sex:</span><span class="field-line">${escapeHtml(sex)}</span>
                                </div>
                            </div>
                            <div class="student-row">
                                <div class="field-group"><span class="field-label">Grade:</span><span class="field-line">${escapeHtml(gradeLevel)}</span></div>
                                <div class="field-group"><span class="field-label">Section:</span><span class="field-line">${escapeHtml(section)}</span></div>
                            </div>
                            <div class="student-row">
                                <div class="field-group"><span class="field-label">Curriculum:</span><span class="field-line">K to 12 Basic Education Curriculum</span></div>
                            </div>
                            <div class="student-row">
                                <div class="field-group"><span class="field-label">School Year:</span><span class="field-line">${escapeHtml(schoolYear)}</span></div>
                            </div>
                            ${curriculumLevel === 'shs' ? `<div class="student-row"><div class="field-group"><span class="field-label">Track/Strand:</span><span class="field-line">${escapeHtml(trackStrand)}</span></div></div>` : ''}
                        </div>
                        <div class="message-block">
                            <p>Dear Parent/Guardian,</p>
                            <p>This report card shows the ability and progress your child has made in the different learning areas${isNumericDepEdTemplate ? '' : ' as well as his/her core values'}.</p>
                            <p>The school welcomes you should you desire to know more about your child's progress.</p>
                        </div>
                        <div class="signature-stack">
                            <div class="signature-name">${escapeHtml(adviserName)}</div>
                            <div class="signature-role">Adviser</div>
                            <div class="signature-line"></div>
                            <div class="signature-role">Principal ${escapeHtml(principalTitle)}</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <div class="page">
        <div class="content-frame">
            <div class="back-grid${isNumericDepEdTemplate ? ' numeric-template' : ''}">
                <div class="grades-panel">
                    <div class="title">${formTitle}</div>
                    <div class="table-block">
                        ${buildGradesSection(curriculumLevel, grades, generalAverage, motherTongue, periods)}
                    </div>
                </div>
                ${isNumericDepEdTemplate ? `
                <div class="comments-panel">
                    <div class="title">TEACHER'S COMMENTS / REMARKS</div>
                    <div class="table-block">
                        ${buildTermCommentsTable(termComments, periods)}
                    </div>
                    <div class="numeric-legend">${buildNumericDescriptorLegend()}</div>
                </div>
                ` : `<div class="values-panel">
                    <div class="title">REPORT ON LEARNER'S OBSERVED VALUES</div>
                    <div class="table-block">
                        ${buildObservedValuesTable(observedValuesRows, periods)}
                    </div>
                    ${buildLegends()}
                </div>`}
            </div>
        </div>
    </div>
</body>
</html>`;
}
