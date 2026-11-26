/**
 * Promotion & Rollover — compute learner promotions and roll enrollments forward.
 * Uses native confirm() for heavy operations and gov-toast / smToast for notifications.
 */

const API_BASE_URL = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;

function promoExtractData(res) {
    if (res && typeof res === 'object' && 'success' in res) {
        if (!res.success) throw new Error(res.message || 'Request failed');
        return res.data;
    }
    return res;
}

const promoApi = {
    schoolYears: () => axios.get(`${API_BASE_URL}/school_years/school_years.php?operation=getAllSchoolYears`).then(r => promoExtractData(r.data)),
    gradeLevels: () => axios.get(`${API_BASE_URL}/grade_levels/grade_levels.php?operation=getAllGradeLevels`).then(r => promoExtractData(r.data)),
    getPromotionSummary: (syId) => axios.get(`${API_BASE_URL}/promotions/promotions.php?operation=getPromotionSummary`, { params: { school_year_id: syId } }).then(r => promoExtractData(r.data)),
    getPromotionCandidates: (syId, status, search, processed) => {
        const params = { school_year_id: syId };
        if (status) params.status = status;
        if (search) params.search = search;
        if (processed !== '') params.processed = processed;
        return axios.get(`${API_BASE_URL}/promotions/promotions.php?operation=getPromotionCandidates`, { params }).then(r => promoExtractData(r.data));
    },
    computePromotions: (syId, payload) => axios.post(`${API_BASE_URL}/promotions/promotions.php?operation=computePromotions&school_year_id=${syId}`, payload).then(r => promoExtractData(r.data)),
    getReenrollmentPreview: (source, target) => axios.get(`${API_BASE_URL}/promotions/promotions.php?operation=getReenrollmentPreview`, { params: { source_school_year_id: source, target_school_year_id: target } }).then(r => promoExtractData(r.data)),
    executeReenrollment: (payload) => axios.post(`${API_BASE_URL}/promotions/promotions.php?operation=executeReenrollment`, payload).then(r => promoExtractData(r.data)),
    getLearnerPromotionHistory: (learnerId) => axios.get(`${API_BASE_URL}/promotions/promotions.php?operation=getLearnerPromotionHistory`, { params: { learner_id: learnerId } }).then(r => promoExtractData(r.data)),
    // Teacher re-enroll endpoints
    getTeacherSections: (syId) => axios.get(`${API_BASE_URL}/promotions/promotions.php?operation=getTeacherSections`, { params: syId ? { school_year_id: syId } : {} }).then(r => promoExtractData(r.data)),
    getTeacherLearners: (sectionId) => axios.get(`${API_BASE_URL}/promotions/promotions.php?operation=getTeacherLearners`, { params: { section_id: sectionId } }).then(r => promoExtractData(r.data)),
    getNextGradeSections: (sectionId, targetSY) => axios.get(`${API_BASE_URL}/promotions/promotions.php?operation=getNextGradeSections`, { params: { section_id: sectionId, target_school_year_id: targetSY } }).then(r => promoExtractData(r.data)),
    executeTeacherReenroll: (payload) => axios.post(`${API_BASE_URL}/promotions/promotions.php?operation=executeTeacherReenroll`, payload).then(r => promoExtractData(r.data))
};

let promoState = {
    schoolYears: [],
    gradeLevels: [],
    activeTab: 'compute',
    selectedSY: null,
    statusFilter: '',
    searchTerm: '',
    processedFilter: 'all',
    summary: null,
    candidates: [],
    sourceSY: null,
    targetSY: null,
    preview: [],
    previewCandidates: [],
    periodLockState: null,
    availableGradeLevels: [],
    availableSections: [],
    selectedAssignments: {},
    // Teacher view state
    isTeacher: false,
    teacherSections: [],
    teacherLearners: { Male: [], Female: [], Other: [], Unknown: [] },
    teacherSelectedLearners: [],
    teacherSourceSection: null,
    teacherTargetSY: null,
    teacherTargetSection: null,
    searchDebounce: null
};

/* ════════════════════════════════
   INIT
   ════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
    await promoLoadInitialData();
});

async function promoLoadInitialData() {
    try {
        // Determine role before rendering UI
        let roleName = '';
        let roleId = 0;
        if (window.CURRENT_ROLE_NAME) {
            roleName = String(window.CURRENT_ROLE_NAME).toLowerCase();
            roleId = Number(window.CURRENT_ROLE_ID || 0);
        } else {
            const me = await axios.get(`${API_BASE_URL}/auth/me.php`).then(r => r.data?.data || {});
            roleName = String(me.role_name || '').toLowerCase();
            roleId = Number(me.role_id || 0);
        }
        promoState.isTeacher = roleName.includes('teacher') || roleId === 9;

        const [syData, glData] = await Promise.all([promoApi.schoolYears(), promoApi.gradeLevels()]);
        promoState.schoolYears = Array.isArray(syData) ? syData.filter(s => !s.is_deleted) : [];
        promoState.gradeLevels = Array.isArray(glData) ? glData.filter(g => !g.is_deleted) : [];

        if (promoState.isTeacher) {
            await promoInitTeacherView();
            return;
        }

        promoPopulateSYSelects();

        // Compute tab: auto-select active school year
        const activeSY = promoState.schoolYears.find(s => s.is_active == 1);
        if (activeSY) {
            document.getElementById('promoSY').value = activeSY.school_year_id;
            promoState.selectedSY = activeSY;
            await promoLoadComputeData();
        } else {
            promoShowComputeEmpty();
        }

        // Rollover tab: default source = active, target = following year if found
        const source = activeSY || promoState.schoolYears[0] || null;
        if (source) {
            document.getElementById('rolloverSourceSY').value = source.school_year_id;
            promoState.sourceSY = source;
            promoAutoTarget(source);
        }

        promoRenderPreviewEmpty();
    } catch (e) {
        smToast('Failed to load initial data.', 'error');
        promoShowComputeEmpty();
        promoRenderPreviewEmpty();
    }
}

function promoPopulateSYSelects() {
    const opts = promoState.schoolYears.map(sy => {
        const badge = sy.is_active == 1 ? ' (Active)' : '';
        return `<option value="${sy.school_year_id}">${escHtml(sy.year_label)}${badge}</option>`;
    }).join('');
    const html = '<option value="">— Select School Year —</option>' + opts;

    document.getElementById('promoSY').innerHTML = html;
    document.getElementById('rolloverSourceSY').innerHTML = html;
    document.getElementById('rolloverTargetSY').innerHTML = html;
}

function promoAutoTarget(source) {
    if (!source) return;
    const target = promoState.schoolYears.find(s => Number(s.year_start) === Number(source.year_end) && s.school_year_id !== source.school_year_id);
    if (target) {
        document.getElementById('rolloverTargetSY').value = target.school_year_id;
        promoState.targetSY = target;
    } else {
        document.getElementById('rolloverTargetSY').value = '';
        promoState.targetSY = null;
    }
}

/* ════════════════════════════════
   TAB 1 — COMPUTE PROMOTIONS
   ════════════════════════════════ */
async function promoOnSYChange() {
    const syId = parseInt(document.getElementById('promoSY').value, 10);
    promoState.selectedSY = promoState.schoolYears.find(s => s.school_year_id === syId) || null;
    await promoLoadComputeData();
}

async function promoLoadComputeData() {
    if (!promoState.selectedSY) {
        promoShowComputeEmpty();
        return;
    }

    promoRenderSummaryLoading();
    promoRenderCandidatesLoading();

    try {
        const [summary, candidates] = await Promise.all([
            promoApi.getPromotionSummary(promoState.selectedSY.school_year_id),
            promoApi.getPromotionCandidates(
                promoState.selectedSY.school_year_id,
                promoState.statusFilter,
                promoState.searchTerm,
                promoState.processedFilter
            )
        ]);

        promoState.summary = summary || {};
        promoState.candidates = Array.isArray(candidates) ? candidates : [];

        promoRenderSummary();
        promoRenderCandidates();
    } catch (e) {
        smToast(e?.message || 'Failed to load promotion data.', 'error');
        promoShowComputeEmpty();
    }
}

async function promoLoadCandidates() {
    if (!promoState.selectedSY) return;

    promoRenderCandidatesLoading();

    try {
        const candidates = await promoApi.getPromotionCandidates(
            promoState.selectedSY.school_year_id,
            promoState.statusFilter,
            promoState.searchTerm,
            promoState.processedFilter
        );
        promoState.candidates = Array.isArray(candidates) ? candidates : [];
        promoRenderCandidates();
    } catch (e) {
        smToast(e?.message || 'Failed to load candidates.', 'error');
        promoRenderCandidatesEmpty();
    }
}

function promoOnFilterChange() {
    promoState.statusFilter = document.getElementById('promoStatus').value;
    promoState.processedFilter = document.getElementById('promoProcessed').value;
    promoLoadCandidates();
}

function promoOnSearch(value) {
    promoState.searchTerm = value.trim();
    if (promoState.searchDebounce) clearTimeout(promoState.searchDebounce);
    promoState.searchDebounce = setTimeout(() => {
        promoLoadCandidates();
    }, 300);
}

async function promoComputeAll() {
    if (!promoState.selectedSY) {
        smToast('Please select a school year first.', 'warning');
        return;
    }

    if (!confirm(`Refresh promotion records for ${promoState.selectedSY.year_label}? This may take a moment.`)) {
        return;
    }

    try {
        const res = await promoApi.computePromotions(promoState.selectedSY.school_year_id, {});
        smToast(`Refreshed ${res.computed || 0} progression record(s); skipped ${res.skipped || 0}; failed ${res.failed || 0}.`, 'success');
        await promoLoadComputeData();
    } catch (e) {
        smToast(e?.message || 'Failed to compute promotions.', 'error');
    }
}

async function promoRefreshCompute() {
    await promoLoadComputeData();
}

function promoRenderSummary() {
    const summary = promoState.summary || {};
    const items = [
        { label: 'Total', value: summary.total || 0, color: 'var(--gray-900)' },
        { label: 'Computed', value: summary.computed || 0, color: 'var(--deped-blue)' },
        { label: 'Promoted', value: summary.promoted || 0, color: 'var(--color-success)' },
        { label: 'Conditionally', value: summary.conditionally_promoted || 0, color: 'var(--color-warning)' },
        { label: 'Retained', value: summary.retained || 0, color: 'var(--color-danger)' },
        { label: 'Completed', value: summary.completed || 0, color: 'var(--color-info)' },
        { label: 'Processed', value: summary.processed || 0, color: 'var(--purple)' }
    ];

    document.getElementById('promoSummary').innerHTML = items.map(item => `
        <div class="promo-card">
            <div class="value" style="color:${item.color}">${item.value}</div>
            <div class="label">${escHtml(item.label)}</div>
        </div>
    `).join('');
}

function promoRenderSummaryLoading() {
    document.getElementById('promoSummary').innerHTML = `
        <div class="promo-card"><div class="value">—</div><div class="label">Loading...</div></div>
        <div class="promo-card"><div class="value">—</div><div class="label">Loading...</div></div>
        <div class="promo-card"><div class="value">—</div><div class="label">Loading...</div></div>
        <div class="promo-card"><div class="value">—</div><div class="label">Loading...</div></div>
        <div class="promo-card"><div class="value">—</div><div class="label">Loading...</div></div>
        <div class="promo-card"><div class="value">—</div><div class="label">Loading...</div></div>
        <div class="promo-card"><div class="value">—</div><div class="label">Loading...</div></div>
    `;
}

function promoRenderCandidates() {
    const area = document.getElementById('promoCandidatesArea');
    const candidates = promoState.candidates;

    if (!candidates.length) {
        promoRenderCandidatesEmpty();
        return;
    }

    area.innerHTML = `
    <div class="table-container">
        <table class="data-table">
            <thead>
                <tr>
                    <th>Learner</th>
                    <th>LRN</th>
                    <th>Grade</th>
                    <th>Section</th>
                    <th>General Avg</th>
                    <th>Final Status</th>
                    <th>Next Grade</th>
                    <th>Processed</th>
                    <th>Ready</th>
                    <th class="text-center">Actions</th>
                </tr>
            </thead>
            <tbody>
                ${candidates.map(c => promoRenderCandidateRow(c)).join('')}
            </tbody>
        </table>
    </div>`;
}

function promoRenderCandidateRow(c) {
    const status = c.final_status || '';
    const statusBadge = promoStatusBadge(status);

    const generalAvg = c.general_average != null ? Number(c.general_average).toFixed(2) : '—';

    const processedBadge = c.is_processed == 1
        ? `<span class="promo-badge yes">Yes</span>`
        : `<span class="promo-badge no">No</span>`;

    const readyBadge = c.is_ready == 1
        ? `<span class="promo-badge yes">Yes</span>`
        : `<span class="promo-badge no">No</span>`;

    return `<tr>
        <td><strong>${escHtml(c.learner_name || '—')}</strong></td>
        <td>${escHtml(c.lrn || '—')}</td>
        <td>${escHtml(c.grade_name || '—')}</td>
        <td>${escHtml(c.section_name || '—')}</td>
        <td>${generalAvg}</td>
        <td>${statusBadge}</td>
        <td>${escHtml(c.next_grade_name || '—')}</td>
        <td>${processedBadge}</td>
        <td>${readyBadge}</td>
        <td class="text-center">
            <div class="action-buttons">
                <button class="action-btn view" title="View promotion history" onclick="promoViewHistory(${c.learner_id})">
                    <i class="fas fa-history"></i>
                </button>
            </div>
        </td>
    </tr>`;
}

function promoRenderCandidatesLoading() {
    document.getElementById('promoCandidatesArea').innerHTML = `
        <div class="loading"><i class="fas fa-spinner fa-spin"></i><p>Loading candidates...</p></div>`;
}

function promoRenderCandidatesEmpty() {
    document.getElementById('promoCandidatesArea').innerHTML = `
        <div class="sm-empty-prompt">
            <i class="fas fa-inbox"></i>
            <h3>No candidates found</h3>
            <p>Adjust filters or check whether learner grades are complete for the selected school year.</p>
        </div>`;
}

function promoShowComputeEmpty() {
    document.getElementById('promoSummary').innerHTML = '';
    promoRenderCandidatesEmpty();
}

function promoStatusBadge(status) {
    if (!status) return `<span class="promo-badge uncomputed">Not computed</span>`;
    const map = {
        'Promoted': 'promoted',
        'Conditionally Promoted': 'conditional',
        'Retained': 'retained',
        'Completed': 'completed'
    };
    const cls = map[status] || 'uncomputed';
    return `<span class="promo-badge ${cls}">${escHtml(status)}</span>`;
}

async function promoViewHistory(learnerId) {
    const learner = promoState.candidates.find(c => c.learner_id === learnerId);

    try {
        const rows = await promoApi.getLearnerPromotionHistory(learnerId);

        document.getElementById('historyModalTitle').textContent =
            `Promotion History: ${escHtml(learner?.learner_name || 'Learner #' + learnerId)}`;

        const body = document.getElementById('historyModalBody');

        if (!Array.isArray(rows) || !rows.length) {
            body.innerHTML = `
                <div class="sm-empty-prompt">
                    <i class="fas fa-history"></i>
                    <h3>No promotion history</h3>
                    <p>This learner has no recorded promotion history yet.</p>
                </div>`;
        } else {
            body.innerHTML = `
                <div class="table-container">
                    <table class="history-table">
                        <thead>
                            <tr>
                                <th>School Year</th>
                                <th>Grade</th>
                                <th>Next Grade</th>
                                <th>General Avg</th>
                                <th>Final Status</th>
                                <th>Processed</th>
                                <th>Remarks</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map(r => `
                                <tr>
                                    <td>${escHtml(r.year_label || '—')}</td>
                                    <td>${escHtml(r.current_grade_name || '—')}</td>
                                    <td>${escHtml(r.next_grade_name || '—')}</td>
                                    <td>${r.general_average != null ? Number(r.general_average).toFixed(2) : '—'}</td>
                                    <td>${promoStatusBadge(r.final_status)}</td>
                                    <td>${r.is_processed == 1 ? 'Yes' : 'No'}</td>
                                    <td>${escHtml(r.remarks || '—')}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>`;
        }

        promoOpenModal('historyModal');
    } catch (e) {
        smToast(e?.message || 'Failed to load promotion history.', 'error');
    }
}

/* ════════════════════════════════
   TAB 2 — ROLLOVER / RE-ENROLL
   ════════════════════════════════ */
function promoResetRolloverState() {
    promoState.preview = [];
    promoState.previewCandidates = [];
    promoState.periodLockState = null;
    promoState.availableGradeLevels = [];
    promoState.availableSections = [];
    promoState.selectedAssignments = {};
}

function promoOnRolloverSourceChange() {
    const syId = parseInt(document.getElementById('rolloverSourceSY').value, 10);
    promoState.sourceSY = promoState.schoolYears.find(s => s.school_year_id === syId) || null;
    if (promoState.sourceSY) promoAutoTarget(promoState.sourceSY);
    promoResetRolloverState();
    promoRenderPreviewEmpty();
    document.getElementById('rolloverExecuteBtn').disabled = true;
}

function promoOnRolloverTargetChange() {
    const syId = parseInt(document.getElementById('rolloverTargetSY').value, 10);
    promoState.targetSY = promoState.schoolYears.find(s => s.school_year_id === syId) || null;
    promoResetRolloverState();
    promoRenderPreviewEmpty();
    document.getElementById('rolloverExecuteBtn').disabled = true;
}

async function promoPreviewRollover() {
    if (!promoState.sourceSY || !promoState.targetSY) {
        smToast('Please select source and target school years.', 'warning');
        return;
    }
    if (promoState.sourceSY.school_year_id === promoState.targetSY.school_year_id) {
        smToast('Source and target school years must be different.', 'warning');
        return;
    }

    document.getElementById('rolloverPreviewArea').innerHTML = `
        <div class="loading"><i class="fas fa-spinner fa-spin"></i><p>Building rollover preview...</p></div>`;

    try {
        const preview = await promoApi.getReenrollmentPreview(
            promoState.sourceSY.school_year_id,
            promoState.targetSY.school_year_id
        );

        if (preview && typeof preview === 'object' && !Array.isArray(preview) && 'candidates' in preview) {
            promoState.previewCandidates = Array.isArray(preview.candidates) ? preview.candidates : [];
            promoState.availableGradeLevels = Array.isArray(preview.available_grade_levels) ? preview.available_grade_levels : [];
            promoState.availableSections = Array.isArray(preview.available_sections) ? preview.available_sections : [];
            promoState.periodLockState = preview.period_lock_state || null;
        } else {
            // Backward compatibility: plain array of candidates
            promoState.previewCandidates = Array.isArray(preview) ? preview : [];
            promoState.availableGradeLevels = [];
            promoState.availableSections = [];
            promoState.periodLockState = null;
        }

        // Seed selected assignments from defaults
        promoState.selectedAssignments = {};
        promoState.previewCandidates.forEach(r => {
            if (promoIsNonActionableRolloverStatus(r.status)) return;
            promoState.selectedAssignments[r.learner_id] = {
                grade_level_id: Number(r.target_grade_level_id),
                section_id: r.target_section_id ? Number(r.target_section_id) : null
            };
        });

        promoRenderPreview();
    } catch (e) {
        smToast(e?.message || 'Failed to load rollover preview.', 'error');
        promoRenderPreviewEmpty();
    }
}

function promoRenderPreview() {
    const area = document.getElementById('rolloverPreviewArea');
    const preview = promoState.previewCandidates;
    const lockState = promoState.periodLockState;
    const lockedForRollover = !lockState || lockState.is_ready_for_rollover;

    const actionable = preview.filter(r => !promoIsNonActionableRolloverStatus(r.status));
    const hasNoSection = actionable.some(r => !promoState.selectedAssignments[r.learner_id]?.section_id);
    document.getElementById('rolloverExecuteBtn').disabled = actionable.length === 0 || hasNoSection || !lockedForRollover;
    const lockBanner = lockState && !lockedForRollover
        ? `<div class="alert alert-warning" style="margin-bottom:12px;">
                <i class="fas fa-lock-open"></i>
                Rollover is held until all required grading periods are locked. Locked ${Number(lockState.locked || 0)} of ${Number(lockState.expected || 0)}; open ${Number(lockState.open || 0)}.
           </div>`
        : '';

    if (!preview.length) {
        area.innerHTML = `
            ${lockBanner}
            <div class="sm-empty-prompt">
                <i class="fas fa-check-circle"></i>
                <h3>No rollover candidates</h3>
                <p>There are no unprocessed promotions ready to roll over for the selected school years.</p>
            </div>`;
        return;
    }

    area.innerHTML = `
    ${lockBanner}
    <div class="table-container">
        <table class="data-table">
            <thead>
                <tr>
                    <th>Learner</th>
                    <th>Current Grade</th>
                    <th>Final Status</th>
                    <th style="min-width:150px">Target Grade</th>
                    <th style="min-width:200px">Target Section</th>
                    <th>Status</th>
                    <th style="min-width:220px">Message</th>
                </tr>
            </thead>
            <tbody>
                ${preview.map(r => promoRenderPreviewRow(r)).join('')}
            </tbody>
        </table>
    </div>`;
}

function promoRenderPreviewRow(r) {
    const sel = promoState.selectedAssignments[r.learner_id] || {};
    const currentGrade = sel.grade_level_id ?? r.target_grade_level_id;
    const currentSection = sel.section_id ?? (r.target_section_id ? Number(r.target_section_id) : null);

    if (promoIsNonActionableRolloverStatus(r.status)) {
        return `
            <tr data-learner-id="${r.learner_id}">
                <td><strong>${escHtml(r.learner_name || '—')}</strong><br><span style="font-size:0.78rem;color:var(--gray-500)">${escHtml(r.lrn || '—')}</span></td>
                <td>${escHtml(r.current_grade_name || '—')}</td>
                <td>${promoStatusBadge(r.final_status)}</td>
                <td>${escHtml(r.next_grade_name || '—')}</td>
                <td>${escHtml(r.target_section_name || '—')}</td>
                <td>${promoRolloverStatusBadge(r.status)}</td>
                <td>${escHtml(r.message || '—')}</td>
            </tr>`;
    }

    const orderedGradeLevels = [...promoState.availableGradeLevels]
        .sort((a, b) => Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0));
    const gradeOptions = orderedGradeLevels.length
        ? orderedGradeLevels.map(g => `<option value="${g.grade_level_id}" ${Number(g.grade_level_id) === Number(currentGrade) ? 'selected' : ''}>${escHtml(g.grade_name)}</option>`).join('')
        : `<option value="${r.target_grade_level_id}" selected>${escHtml(r.next_grade_name || '—')}</option>`;

    const gradeSelect = `
        <select data-native="true" onchange="promoOnRolloverGradeChange(${r.learner_id}, this.value)"
                style="min-width:140px;max-width:100%;">
            ${gradeOptions}
        </select>`;

    const sectionSelect = promoBuildSectionSelect(currentGrade, currentSection, r.learner_id);
    const status = promoComputePreviewStatus(r, currentSection);
    const message = currentSection
        ? (r.existing_enrollment_id ? 'Will restore enrollment with selected grade/section.' : 'Will create enrollment with selected grade/section.')
        : (r.message || 'Select a target grade and section.');

    return `
        <tr data-learner-id="${r.learner_id}">
            <td><strong>${escHtml(r.learner_name || '—')}</strong><br><span style="font-size:0.78rem;color:var(--gray-500)">${escHtml(r.lrn || '—')}</span></td>
            <td>${escHtml(r.current_grade_name || '—')}</td>
            <td>${promoStatusBadge(r.final_status)}</td>
            <td>${gradeSelect}</td>
            <td>${sectionSelect}</td>
            <td id="promoStatus_${r.learner_id}">${promoRolloverStatusBadge(status)}</td>
            <td id="promoMsg_${r.learner_id}">${escHtml(message)}</td>
        </tr>`;
}

function promoBuildSectionSelect(gradeLevelId, selectedSectionId, learnerId) {
    const sections = promoState.availableSections.filter(s => Number(s.grade_level_id) === Number(gradeLevelId));
    const selected = selectedSectionId ? Number(selectedSectionId) : null;

    if (!sections.length) {
        return `<select disabled style="min-width:180px;max-width:100%;"><option>No sections for this grade</option></select>`;
    }

    const options = [
        `<option value="" ${selected === null ? 'selected' : ''}>— Select Section —</option>`
    ];
    sections.forEach(s => {
        const full = Number(s.current_count) >= Number(s.max_capacity);
        const label = `${escHtml(s.section_name)} (${s.current_count}/${s.max_capacity})${full ? ' — FULL' : ''}`;
        const disabled = full ? 'disabled' : '';
        const isSelected = selected === Number(s.section_id);
        options.push(`<option value="${s.section_id}" ${disabled} ${isSelected ? 'selected' : ''}>${label}</option>`);
    });

    return `
        <select data-native="true" onchange="promoOnRolloverSectionChange(${learnerId}, this.value)"
                style="min-width:180px;max-width:100%;">
            ${options.join('')}
        </select>`;
}

function promoComputePreviewStatus(candidate, selectedSectionId) {
    if (promoIsNonActionableRolloverStatus(candidate.status)) return candidate.status;
    if (!selectedSectionId) return 'no_section';
    if (candidate.existing_enrollment_id) return 'will_restore';
    return 'will_create';
}

function promoOnRolloverGradeChange(learnerId, gradeLevelId) {
    gradeLevelId = Number(gradeLevelId);
    const candidate = promoState.previewCandidates.find(c => c.learner_id === learnerId);
    if (!candidate) return;

    const sections = promoState.availableSections.filter(s => Number(s.grade_level_id) === gradeLevelId);
    const firstAvailable = sections.find(s => Number(s.current_count) < Number(s.max_capacity));
    const defaultSectionId = firstAvailable ? Number(firstAvailable.section_id) : null;

    // Keep current section if it still matches the new grade, otherwise use first available
    const current = promoState.selectedAssignments[learnerId] || {};
    const currentSectionId = current.section_id ? Number(current.section_id) : null;
    const keepSection = currentSectionId && sections.some(s => Number(s.section_id) === currentSectionId && Number(s.current_count) < Number(s.max_capacity));
    const sectionId = keepSection ? currentSectionId : defaultSectionId;

    promoState.selectedAssignments[learnerId] = {
        grade_level_id: gradeLevelId,
        section_id: sectionId
    };

    // Re-render the row in place
    const tr = document.querySelector(`#rolloverPreviewArea tr[data-learner-id="${learnerId}"]`);
    if (tr) tr.outerHTML = promoRenderPreviewRow(candidate);

    promoUpdateExecuteButton();
}

function promoOnRolloverSectionChange(learnerId, sectionId) {
    sectionId = sectionId ? Number(sectionId) : null;
    const current = promoState.selectedAssignments[learnerId] || {};
    promoState.selectedAssignments[learnerId] = {
        grade_level_id: current.grade_level_id,
        section_id: sectionId
    };

    const candidate = promoState.previewCandidates.find(c => c.learner_id === learnerId);
    if (!candidate) return;

    const status = promoComputePreviewStatus(candidate, sectionId);
    const statusCell = document.getElementById(`promoStatus_${learnerId}`);
    const msgCell = document.getElementById(`promoMsg_${learnerId}`);
    if (statusCell) statusCell.innerHTML = promoRolloverStatusBadge(status);
    if (msgCell) {
        msgCell.textContent = sectionId
            ? (candidate.existing_enrollment_id ? 'Will restore enrollment with selected grade/section.' : 'Will create enrollment with selected grade/section.')
            : 'Select a target grade and section.';
    }

    promoUpdateExecuteButton();
}

function promoUpdateExecuteButton() {
    const actionable = promoState.previewCandidates.filter(r => !promoIsNonActionableRolloverStatus(r.status));
    const hasNoSection = actionable.some(r => !promoState.selectedAssignments[r.learner_id]?.section_id);
    document.getElementById('rolloverExecuteBtn').disabled = actionable.length === 0 || hasNoSection;
}

function promoRenderPreviewEmpty() {
    document.getElementById('rolloverPreviewArea').innerHTML = `
        <div class="sm-empty-prompt">
            <i class="fas fa-filter"></i>
            <h3>Preview a Rollover</h3>
            <p>Select a source and target school year, then click “Preview Rollover”.</p>
        </div>`;
    document.getElementById('rolloverExecuteBtn').disabled = true;
}

function promoRolloverStatusBadge(status) {
    return `<span class="promo-badge ${escHtml(status || '')}">${escHtml(status || '').replace(/_/g, ' ')}</span>`;
}

function promoIsNonActionableRolloverStatus(status) {
    return ['already_enrolled', 'already_promoted'].includes(status);
}

async function promoExecuteRollover() {
    if (!promoState.sourceSY || !promoState.targetSY || !promoState.previewCandidates.length) return;

    const actionable = promoState.previewCandidates.filter(r => !promoIsNonActionableRolloverStatus(r.status));
    const hasNoSection = actionable.some(r => !promoState.selectedAssignments[r.learner_id]?.section_id);
    if (!actionable.length) {
        smToast('There are no learners ready for rollover.', 'warning');
        return;
    }
    if (hasNoSection) {
        smToast('Please select a target section for every learner before executing.', 'warning');
        return;
    }

    if (!confirm(`Execute rollover from ${promoState.sourceSY.year_label} to ${promoState.targetSY.year_label}? This will create or restore enrollments using the selected grades and sections.`)) {
        return;
    }

    try {
        const learnerIds = actionable.map(r => r.learner_id);
        const res = await promoApi.executeReenrollment({
            source_school_year_id: promoState.sourceSY.school_year_id,
            target_school_year_id: promoState.targetSY.school_year_id,
            learner_ids: learnerIds,
            selected_assignments: promoState.selectedAssignments
        });

        smToast(`Rollover completed: created ${res.created || 0}, restored ${res.restored || 0}, already enrolled ${res.already_enrolled || 0}, already promoted ${res.already_promoted || 0}, no section ${res.no_section || 0}, failed ${res.failed || 0}.`, 'success');

        await promoPreviewRollover();
    } catch (e) {
        smToast(e?.message || 'Failed to execute rollover.', 'error');
    }
}

/* ════════════════════════════════
   TABS
   ════════════════════════════════ */
function promoSwitchTab(tab) {
    promoState.activeTab = tab;
    document.querySelectorAll('.promo-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.getElementById('computePanel').classList.toggle('active', tab === 'compute');
    document.getElementById('rolloverPanel').classList.toggle('active', tab === 'rollover');
}

/* ════════════════════════════════
   MODALS
   ════════════════════════════════ */
function promoOpenModal(id) {
    const m = document.getElementById(id);
    if (m) { m.classList.add('show'); document.body.style.overflow = 'hidden'; }
}

function promoCloseHistoryModal() {
    const m = document.getElementById('historyModal');
    if (m) { m.classList.remove('show'); document.body.style.overflow = ''; }
}

window.addEventListener('click', e => {
    const m = document.getElementById('historyModal');
    if (e.target === m) { m.classList.remove('show'); document.body.style.overflow = ''; }
});

/* ════════════════════════════════
   HELPERS
   ════════════════════════════════ */
function escHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function smToast(message, type = 'success') {
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
            .gov-toast--warning{border:0}
            .gov-toast--warning .gov-toast__icon{color:var(--color-warning)}
            .gov-toast--info{border:0}
            .gov-toast--info .gov-toast__icon{color:var(--gray-500)}
        `;
        document.head.appendChild(style);
    };

    ensureGovToastStyles();
    document.querySelectorAll('.gov-toast').forEach((el) => el.remove());

    const validTypes = ['success', 'error', 'warning', 'info'];
    const normalizedType = validTypes.includes(type) ? type : 'info';
    const title = normalizedType === 'success' ? 'Completed'
        : normalizedType === 'error' ? 'Action Required'
        : normalizedType === 'warning' ? 'Heads Up'
        : 'Notice';
    const iconClass = normalizedType === 'success' ? 'fa-circle-check'
        : normalizedType === 'error' ? 'fa-triangle-exclamation'
        : normalizedType === 'warning' ? 'fa-circle-exclamation'
        : 'fa-circle-info';

    const toast = document.createElement('div');
    toast.className = `gov-toast gov-toast--${normalizedType}`;
    toast.innerHTML = `
        <div class="gov-toast__content">
            <i class="fas ${iconClass} gov-toast__icon"></i>
            <div class="gov-toast__text">
                <div class="gov-toast__title">${title}</div>
                <div class="gov-toast__message">${escHtml(message)}</div>
            </div>
            <button type="button" class="gov-toast__dismiss" aria-label="Dismiss">&times;</button>
        </div>
    `;

    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    const timeoutMs = normalizedType === 'error' || normalizedType === 'warning' ? 9000 : 4500;
    let timer = setTimeout(dismiss, timeoutMs);

    function dismiss() {
        if (timer) { clearTimeout(timer); timer = null; }
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 250);
    }

    const dismissBtn = toast.querySelector('button[aria-label="Dismiss"]');
    if (dismissBtn) dismissBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); dismiss(); });
    toast.addEventListener('mouseenter', () => { if (timer) { clearTimeout(timer); timer = null; } });
    toast.addEventListener('mouseleave', () => { if (!timer) timer = setTimeout(dismiss, timeoutMs); });
}

/* ════════════════════════════════
   TEACHER SIMPLIFIED RE-ENROLL
   ════════════════════════════════ */

async function promoInitTeacherView() {
    // Hide admin tabs, show teacher panel
    document.querySelector('.promo-tabs').style.display = 'none';
    document.getElementById('computePanel').classList.remove('active');
    document.getElementById('rolloverPanel').classList.remove('active');
    document.getElementById('teacherPanel').classList.add('active');

    // Update page title
    const title = document.querySelector('.page-title');
    const subtitle = document.querySelector('.page-subtitle');
    if (title) title.textContent = 'Re-enroll My Learners';
    if (subtitle) subtitle.textContent = 'Select learners from your section and assign them to the next school year and section.';

    await teacherPopulateSchoolYearSelects();

    const activeSY = promoState.schoolYears.find(s => s.is_active == 1);
    if (activeSY) {
        document.getElementById('teacherSchoolYear').value = activeSY.school_year_id;
        await teacherLoadSections(activeSY.school_year_id);
    }
}

async function teacherPopulateSchoolYearSelects() {
    const opts = promoState.schoolYears.map(sy =>
        `<option value="${sy.school_year_id}">${escHtml(sy.year_label)}${sy.is_active == 1 ? ' (Active)' : ''}</option>`
    ).join('');
    const html = '<option value="">— Select School Year —</option>' + opts;
    document.getElementById('teacherSchoolYear').innerHTML = html;
    document.getElementById('teacherTargetSY').innerHTML = html;
}

async function teacherOnSchoolYearChange() {
    const syId = parseInt(document.getElementById('teacherSchoolYear').value, 10);
    promoState.teacherSourceSection = null;
    promoState.teacherLearners = { Male: [], Female: [], Other: [], Unknown: [] };
    promoState.teacherSelectedLearners = [];
    teacherResetTarget();
    await teacherLoadSections(syId || null);
    teacherRenderLearners();
    teacherUpdateActionBar();
}

async function teacherLoadSections(schoolYearId) {
    const select = document.getElementById('teacherSection');
    select.innerHTML = '<option value="">— Loading —</option>';
    try {
        const sections = await promoApi.getTeacherSections(schoolYearId);
        promoState.teacherSections = Array.isArray(sections) ? sections : [];
        const opts = promoState.teacherSections.map(s =>
            `<option value="${s.section_id}">${escHtml(s.section_name)} — ${escHtml(s.grade_name)} (${escHtml(s.year_label)})</option>`
        ).join('');
        select.innerHTML = '<option value="">— Select Section —</option>' + opts;
    } catch (e) {
        select.innerHTML = '<option value="">— Select Section —</option>';
        smToast(e?.message || 'Failed to load sections.', 'error');
    }
}

async function teacherOnSectionChange() {
    const sectionId = parseInt(document.getElementById('teacherSection').value, 10);
    const section = promoState.teacherSections.find(s => s.section_id === sectionId) || null;
    promoState.teacherSourceSection = section;
    promoState.teacherSelectedLearners = [];
    teacherResetTarget();

    if (!section) {
        promoState.teacherLearners = { Male: [], Female: [], Other: [], Unknown: [] };
        teacherRenderLearners();
        teacherUpdateActionBar();
        return;
    }

    try {
        const byGender = await promoApi.getTeacherLearners(sectionId);
        promoState.teacherLearners = byGender || { Male: [], Female: [], Other: [], Unknown: [] };
    } catch (e) {
        promoState.teacherLearners = { Male: [], Female: [], Other: [], Unknown: [] };
        smToast(e?.message || 'Failed to load learners.', 'error');
    }

    teacherRenderLearners();
    teacherUpdateActionBar();
}

function teacherRenderLearners() {
    const area = document.getElementById('teacherLearnersArea');
    const genders = ['Male', 'Female', 'Other', 'Unknown'];
    const hasAny = genders.some(g => promoState.teacherLearners[g]?.length);

    if (!hasAny) {
        const hasSection = Boolean(promoState.teacherSourceSection);
        area.innerHTML = `
            <div class="sm-empty-prompt" style="margin-top:1rem;">
                <i class="fas fa-inbox"></i>
                <h3>${hasSection ? 'No eligible learners' : 'No learners'}</h3>
                <p>${hasSection ? 'Only learners with complete passing final grades are shown for promotion.' : 'Select a school year and section to view learners.'}</p>
            </div>`;
        return;
    }

    const renderList = (gender) => {
        const list = promoState.teacherLearners[gender] || [];
        const allChecked = list.length && list.every(l => promoState.teacherSelectedLearners.includes(l.learner_id));
        return `
            <div class="teacher-gender-box">
                <h3>
                    <span>${escHtml(gender)} (${list.length})</span>
                    ${list.length ? `<label style="font-size:0.85rem;font-weight:500;cursor:pointer;user-select:none;">
                        <input type="checkbox" ${allChecked ? 'checked' : ''} onchange="teacherToggleGender('${gender}', this.checked)" style="margin-right:0.4rem;"> Select All
                    </label>` : ''}
                </h3>
                <div class="teacher-learner-list">
                    ${list.map(l => `
                        <label class="teacher-learner-item">
                            <input type="checkbox" value="${l.learner_id}" onchange="teacherToggleLearner(${l.learner_id}, this.checked)"
                                ${promoState.teacherSelectedLearners.includes(l.learner_id) ? 'checked' : ''}>
                            <div class="teacher-learner-name">
                                <div>${escHtml(l.learner_name)}</div>
                                <div class="teacher-learner-lrn">
                                    ${escHtml(l.lrn || '—')}
                                    ${l.general_average ? ` · GA ${escHtml(Number(l.general_average).toFixed(2))}` : ''}
                                </div>
                            </div>
                        </label>
                    `).join('')}
                </div>
            </div>`;
    };

    area.innerHTML = `
        <div class="teacher-gender-grid">
            ${renderList('Male')}
            ${renderList('Female')}
        </div>
        ${(promoState.teacherLearners.Other?.length || promoState.teacherLearners.Unknown?.length) ? `
            <div class="teacher-gender-grid" style="margin-top:1rem;">
                ${renderList('Other')}
                ${renderList('Unknown')}
            </div>` : ''}`;
}

function teacherToggleLearner(learnerId, checked) {
    if (checked) {
        if (!promoState.teacherSelectedLearners.includes(learnerId)) {
            promoState.teacherSelectedLearners.push(learnerId);
        }
    } else {
        promoState.teacherSelectedLearners = promoState.teacherSelectedLearners.filter(id => id !== learnerId);
    }
    teacherRenderLearners();
    teacherUpdateActionBar();
}

function teacherToggleGender(gender, checked) {
    const list = promoState.teacherLearners[gender] || [];
    const ids = list.map(l => l.learner_id);
    if (checked) {
        ids.forEach(id => {
            if (!promoState.teacherSelectedLearners.includes(id)) {
                promoState.teacherSelectedLearners.push(id);
            }
        });
    } else {
        promoState.teacherSelectedLearners = promoState.teacherSelectedLearners.filter(id => !ids.includes(id));
    }
    teacherRenderLearners();
    teacherUpdateActionBar();
}

function teacherUpdateActionBar() {
    const count = promoState.teacherSelectedLearners.length;
    const summary = document.getElementById('teacherSelectionSummary');
    const btn = document.getElementById('teacherReenrollBtn');

    if (summary) summary.textContent = count === 0 ? 'No learners selected.' : `${count} learner${count > 1 ? 's' : ''} selected.`;
    if (btn) btn.disabled = count === 0 || !promoState.teacherTargetSection;
}

function teacherResetTarget() {
    promoState.teacherTargetSY = null;
    promoState.teacherTargetSection = null;
    document.getElementById('teacherTargetSY').value = '';
    document.getElementById('teacherTargetSection').innerHTML = '<option value="">— Select Section —</option>';
    document.getElementById('teacherActionBar').style.display = promoState.teacherSourceSection ? 'block' : 'none';
    teacherUpdateActionBar();
}

async function teacherOnTargetSYChange() {
    const syId = parseInt(document.getElementById('teacherTargetSY').value, 10);
    promoState.teacherTargetSY = promoState.schoolYears.find(s => s.school_year_id === syId) || null;
    promoState.teacherTargetSection = null;
    document.getElementById('teacherTargetSection').innerHTML = '<option value="">— Loading —</option>';
    await teacherLoadTargetSections();
    teacherUpdateActionBar();
}

async function teacherLoadTargetSections() {
    const select = document.getElementById('teacherTargetSection');
    const section = promoState.teacherSourceSection;
    const targetSY = promoState.teacherTargetSY;

    if (!section || !targetSY) {
        select.innerHTML = '<option value="">— Select Section —</option>';
        return;
    }

    try {
        const sections = await promoApi.getNextGradeSections(section.section_id, targetSY.school_year_id);
        const list = Array.isArray(sections) ? sections : [];
        const opts = list.map(s =>
            `<option value="${s.section_id}">${escHtml(s.section_name)} — ${escHtml(s.grade_name)} (${s.current_count}/${s.max_capacity})</option>`
        ).join('');
        select.innerHTML = '<option value="">— Select Section —</option>' + opts;
    } catch (e) {
        select.innerHTML = '<option value="">— Select Section —</option>';
        smToast(e?.message || 'Failed to load target sections.', 'error');
    }
}

function teacherOnTargetSectionChange() {
    const sectionId = parseInt(document.getElementById('teacherTargetSection').value, 10);
    const sections = document.getElementById('teacherTargetSection').options;
    // Find selected option text to parse? Not needed, we keep id.
    promoState.teacherTargetSection = sectionId || null;
    teacherUpdateActionBar();
}

async function teacherReenrollSelected() {
    const sourceSection = promoState.teacherSourceSection;
    const targetSY = promoState.teacherTargetSY;
    const targetSectionId = promoState.teacherTargetSection;
    const learnerIds = promoState.teacherSelectedLearners;

    if (!sourceSection || !targetSY || !targetSectionId || !learnerIds.length) {
        smToast('Please select learners, target school year, and target section.', 'warning');
        return;
    }

    if (!confirm(`Re-enroll ${learnerIds.length} learner(s) to ${targetSY.year_label}, target section? This will create or restore enrollments.`)) {
        return;
    }

    try {
        const res = await promoApi.executeTeacherReenroll({
            source_section_id: sourceSection.section_id,
            target_school_year_id: targetSY.school_year_id,
            target_section_id: targetSectionId,
            learner_ids: learnerIds
        });

        smToast(`${res.message}`, 'success');

        // Refresh learners and target sections
        promoState.teacherSelectedLearners = [];
        await teacherOnSectionChange();
        await teacherLoadTargetSections();
    } catch (e) {
        smToast(e?.message || 'Failed to re-enroll learners.', 'error');
    }
}

// Window bindings for inline HTML handlers
window.promoSwitchTab = promoSwitchTab;
window.promoOnSYChange = promoOnSYChange;
window.promoOnFilterChange = promoOnFilterChange;
window.promoOnSearch = promoOnSearch;
window.promoComputeAll = promoComputeAll;
window.promoRefreshCompute = promoRefreshCompute;
window.promoViewHistory = promoViewHistory;
window.promoOnRolloverSourceChange = promoOnRolloverSourceChange;
window.promoOnRolloverTargetChange = promoOnRolloverTargetChange;
window.promoPreviewRollover = promoPreviewRollover;
window.promoExecuteRollover = promoExecuteRollover;
window.promoCloseHistoryModal = promoCloseHistoryModal;

window.teacherOnSchoolYearChange = teacherOnSchoolYearChange;
window.teacherOnSectionChange = teacherOnSectionChange;
window.teacherToggleLearner = teacherToggleLearner;
window.teacherToggleGender = teacherToggleGender;
window.teacherOnTargetSYChange = teacherOnTargetSYChange;
window.teacherOnTargetSectionChange = teacherOnTargetSectionChange;
window.teacherReenrollSelected = teacherReenrollSelected;
