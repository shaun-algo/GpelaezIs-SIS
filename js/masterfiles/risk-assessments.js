const API_BASE_URL = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;
const DANGER_RISK_BAND_FILTER = '__danger_risk_band__';
const HIGH_RISK_BAND_FILTER = '__high_risk_band__';

function isTeacherRole() {
    const rname = String(window.CURRENT_ROLE_NAME || '').toLowerCase();
    const rid = Number(window.CURRENT_ROLE_ID || 0);
    return rname.includes('teacher') || rid === 9;
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

const riskState = {
    schoolYears: [],
    gradingPeriods: [],
    gradeLevels: [],
    riskLevels: [],
    schoolName: '',
    sections: [],
    selectedSchoolYearId: null,
    selectedGradingPeriodId: null,
    selectedScope: 'school_year',
    selectedGradeLevelId: null,
    selectedSectionId: null,
    selectedRiskLevelId: DANGER_RISK_BAND_FILTER,
    lastLoadedRows: [],
    lastSummary: {
        total_records: 0,
        high: 0,
        medium: 0,
        low: 0
    },
    lastPeriodMode: 'latest',
    // Teacher scoped view: advisory sections plus assigned subject offerings.
    isTeacher: false,
    myAdvisorySections: [],
    selectedMySectionId: null,
    mobileReady: false,
    mobileMode: null
};

function isRiskMobileViewport() {
    return Boolean(window.matchMedia && window.matchMedia('(max-width: 720px)').matches);
}

function syncRiskMobileMode() {
    const mobile = isRiskMobileViewport();
    if (riskState.mobileMode !== mobile) {
        riskState.mobileMode = mobile;
        riskState.mobileReady = !mobile;
    }

    document.body?.classList.toggle('risk-mobile-flow', mobile);
    document.body?.classList.toggle('risk-mobile-ready', mobile && riskState.mobileReady);
    const proceedButton = document.getElementById('btnRiskProceed');
    if (proceedButton) {
        const hasSchoolYear = Boolean(document.getElementById('filterSchoolYear')?.value);
        const hasGradingPeriod = Boolean(document.getElementById('filterPeriod')?.value);
        proceedButton.disabled = !hasSchoolYear || !hasGradingPeriod;
    }
    return mobile;
}

function shouldDeferRiskResults() {
    return isRiskMobileViewport() && !riskState.mobileReady;
}

async function refreshRiskResults() {
    syncRiskMobileMode();
    renderRiskDashboard();
    if (shouldDeferRiskResults()) return;
    await reloadRecords();
}

const riskAssessmentsApi = {
    list: async () => {
        const pendingFocusId = getPendingRiskFocusId();
        const dangerRiskBand = riskState.selectedRiskLevelId === DANGER_RISK_BAND_FILTER;
        const highRiskBand = riskState.selectedRiskLevelId === HIGH_RISK_BAND_FILTER;
        const selectedRiskLevelId = dangerRiskBand
            ? null
            : (Number(riskState.selectedRiskLevelId || 0) || null);
        const params = {
            operation: 'getAtRiskLearners',
            // The default danger view is Medium-to-High; the explicit
            // "Show all" option sends include_low=1.
            include_low: dangerRiskBand || highRiskBand || selectedRiskLevelId ? 0 : 1
        };
        if (pendingFocusId) {
            params.risk_assessment_id = pendingFocusId;
        }
        if (riskState.selectedSchoolYearId) {
            params.school_year_id = riskState.selectedSchoolYearId;
        }
        if (riskState.selectedGradingPeriodId && riskState.selectedGradingPeriodId !== 'latest') {
            params.grading_period_id = riskState.selectedGradingPeriodId;
        }
        if (dangerRiskBand) {
            params.risk_band = 'danger';
        } else if (highRiskBand) {
            params.risk_band = 'high';
        } else if (selectedRiskLevelId) {
            params.risk_level_id = selectedRiskLevelId;
        }

        if (riskState.isTeacher) {
            // Teachers are scoped to advisory sections plus assigned subject offerings;
            // server also enforces this and restricts results to at-risk records only.
            if (riskState.selectedMySectionId) {
                params.section_id = riskState.selectedMySectionId;
            }
        } else {
            if (riskState.selectedScope === 'year_level' && riskState.selectedGradeLevelId) {
                params.grade_level_id = riskState.selectedGradeLevelId;
            }
            if (riskState.selectedScope === 'section' && riskState.selectedSectionId) {
                params.section_id = riskState.selectedSectionId;
            }
        }

        const res = await axios.get(`${API_BASE_URL}/risk_assessments/risk_assessments.php`, { params });
        const payload = res.data;
        if (!payload?.success) {
            throw new Error(payload?.message || 'Failed to load at-risk learners');
        }

        const apiData = payload?.data || {};
        const rows = Array.isArray(apiData?.records) ? apiData.records : [];
        riskState.lastLoadedRows = rows;
        riskState.lastSummary = normalizeSummary(apiData?.summary, rows);
        riskState.lastPeriodMode = String(apiData?.period_mode || 'selected');
        renderRiskDashboard();
        return rows;
    },
    automate: async () => {
        const params = { operation: 'computeAutomatedAssessments' };
        if (riskState.selectedSchoolYearId) {
            params.school_year_id = riskState.selectedSchoolYearId;
        }
        if (riskState.selectedGradingPeriodId && riskState.selectedGradingPeriodId !== 'latest') {
            params.grading_period_id = riskState.selectedGradingPeriodId;
        }
        const res = await axios.post(`${API_BASE_URL}/risk_assessments/risk_assessments.php`, {}, { params });
        return res.data;
    }
};

const riskSchoolSettingsApi = {
    all: async () => {
        const response = await axios.get(`${API_BASE_URL}/school_settings/school_settings.php`, {
            params: { operation: 'getAllSettings' }
        });
        return response.data?.map || {};
    }
};

function emptySummary() {
    return {
        total_records: 0,
        high: 0,
        medium: 0,
        low: 0
    };
}

function normalizeSummary(summary, rows = []) {
    const src = summary && typeof summary === 'object' ? summary : {};
    const normalized = {
        total_records: Number(src.total_records || 0),
        high: Number(src.high || 0),
        medium: Number(src.medium || src.moderate || 0),
        low: Number(src.low || 0)
    };

    const invalid = Object.values(normalized).some((v) => Number.isNaN(v));
    if (!invalid && normalized.total_records > 0) {
        return normalized;
    }

    const inferred = emptySummary();
    const items = Array.isArray(rows) ? rows : [];
    inferred.total_records = items.length;
    items.forEach((row) => {
        const label = String(row?.risk_name || '').toLowerCase();
        if (label.includes('critical') || label.includes('high')) inferred.high += 1;
        else if (label.includes('medium') || label.includes('moderate')) inferred.medium += 1;
        else inferred.low += 1;
    });
    return inferred;
}

const schoolYearsApi = {
    list: async () => axios.get(`${API_BASE_URL}/school_years/school_years.php`, { params: { operation: 'getAllSchoolYears' } }).then((r) => r.data)
};

const gradingPeriodsApi = {
    list: async () => axios.get(`${API_BASE_URL}/grading_periods/grading_periods.php`, { params: { operation: 'getAllGradingPeriods' } }).then((r) => r.data)
};

const gradeLevelsApi = {
    list: async () => axios.get(`${API_BASE_URL}/grade_levels/grade_levels.php`, { params: { operation: 'getAllGradeLevels' } }).then((r) => r.data)
};

const riskLevelsApi = {
    list: async () => axios.get(`${API_BASE_URL}/risk_levels/risk_levels.php`, { params: { operation: 'getAllRiskLevels' } }).then((r) => r.data)
};

const sectionsApi = {
    list: async (schoolYearId) => axios.get(`${API_BASE_URL}/sections/sections.php`, {
        params: {
            operation: 'getAllSections',
            ...(schoolYearId ? { school_year_id: schoolYearId } : {})
        }
    }).then((r) => r.data)
};

const myAdvisorySectionsApi = {
    list: async (schoolYearId) => axios.get(`${API_BASE_URL}/risk_assessments/risk_assessments.php`, {
        params: {
            operation: 'getMyAdvisorySections',
            ...(schoolYearId ? { school_year_id: schoolYearId } : {})
        }
    }).then((r) => {
        const payload = r.data;
        if (!payload?.success) throw new Error(payload?.message || 'Failed to load advisory sections');
        return Array.isArray(payload.data) ? payload.data : [];
    })
};

function notify(type, message) {
    const normalized = (type === 'success' || type === 'error' || type === 'info') ? type : 'info';
    if (typeof window.showNotification === 'function') {
        window.showNotification(message, normalized);
        return;
    }
    if (typeof Swal !== 'undefined' && typeof Swal.fire === 'function') {
        Swal.fire({
            toast: true,
            position: 'bottom-end',
            showConfirmButton: false,
            timer: normalized === 'error' ? 4500 : 2600,
            timerProgressBar: true,
            icon: normalized,
            title: message,
            customClass: {
                popup: `deped-toast deped-toast--${normalized}`
            }
        });
        return;
    }
    if (typeof window.alert === 'function') {
        window.alert(message);
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatRiskLevelCell(value, row) {
    const color = row?.color_code || '#4B5563';
    const text = escapeHtml(value || 'Unknown');
    return `<span class="risk-level-text" style="color:${escapeHtml(color)};">${text}</span>`;
}

function formatRiskLearnerCell(value, row) {
    return `<span class="risk-cell-primary">${escapeHtml(value || 'Unnamed Learner')}</span>
        <span class="risk-cell-meta">LRN: ${escapeHtml(row?.lrn || '—')}</span>`;
}

function formatRiskSectionCell(value, row) {
    const gradeName = String(row?.grade_name || '—');
    const gradeMeta = row?.grade_risk_assessed === false
        ? `${gradeName} · academic grade risk not assessed`
        : gradeName;
    return `<span class="risk-cell-primary">${escapeHtml(value || '—')}</span>
        <span class="risk-cell-meta">${escapeHtml(gradeMeta)}</span>`;
}

function fmt2(value) {
    if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '—';
    return Number(value).toFixed(2);
}

function fmtPercent(value) {
    if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '—';
    return `${Number(value).toFixed(2)}%`;
}

function getCurrentSchoolYearLabel() {
    const syId = Number(riskState.selectedSchoolYearId || 0);
    const row = riskState.schoolYears.find((x) => Number(x.school_year_id) === syId);
    return row?.year_label || '';
}

function getCurrentPeriodLabel() {
    if (riskState.selectedGradingPeriodId === 'latest') return 'First available period';
    const gpId = Number(riskState.selectedGradingPeriodId || 0);
    const row = riskState.gradingPeriods.find((x) => Number(x.grading_period_id) === gpId);
    return row?.period_name || '';
}

function getScopeLabel() {
    if (riskState.isTeacher) {
        if (riskState.selectedMySectionId) {
            const sec = riskState.myAdvisorySections.find((s) => Number(s.section_id) === Number(riskState.selectedMySectionId));
            return sec?.section_name ? `Teaching Load: ${compactContextValue(sec.section_name)}` : 'Teaching Load';
        }
        return riskState.myAdvisorySections.length > 1 ? 'All Teaching Loads' : 'Teaching Load';
    }

    if (riskState.selectedScope === 'year_level') {
        const gl = riskState.gradeLevels.find((g) => Number(g.grade_level_id) === Number(riskState.selectedGradeLevelId));
        return gl?.grade_name ? `Year Level: ${gl.grade_name}` : 'Year Level';
    }
    if (riskState.selectedScope === 'section') {
        const sec = riskState.sections.find((s) => Number(s.section_id) === Number(riskState.selectedSectionId));
        return sec?.section_name ? `Section: ${sec.section_name}` : 'Section';
    }
    return 'Whole School Year';
}

function compactContextValue(value) {
    return String(value || '')
        .replace(/\s*[|/]\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getTeacherPrintScopeValue() {
    if (riskState.selectedMySectionId) {
        const sec = riskState.myAdvisorySections.find((s) => Number(s.section_id) === Number(riskState.selectedMySectionId));
        const grade = compactContextValue(sec?.grade_name || '');
        const section = compactContextValue(sec?.section_name || '');
        const assignedSubjects = compactContextValue(sec?.assigned_subjects || '');
        const isAdvisory = Number(sec?.is_advisory || 0) === 1;
        const classLabel = compactContextValue([grade, section].filter(Boolean).join(' ')) || compactContextValue(sec?.display_name || '');
        const loadParts = [];

        if (classLabel) loadParts.push(classLabel);
        if (assignedSubjects) loadParts.push(`Subject Offering: ${assignedSubjects}`);
        else if (isAdvisory) loadParts.push('Advisory Section');

        return loadParts.join(' - ') || 'Selected Teaching Load';
    }

    return riskState.myAdvisorySections.length > 1 ? 'All Teaching Loads' : 'Teaching Load';
}

function getAdminPrintScopeContext() {
    if (riskState.selectedScope === 'year_level') {
        const gl = riskState.gradeLevels.find((g) => Number(g.grade_level_id) === Number(riskState.selectedGradeLevelId));
        return {
            label: 'Year Level',
            value: compactContextValue(gl?.grade_name || 'All Year Levels')
        };
    }

    if (riskState.selectedScope === 'section') {
        const sec = riskState.sections.find((s) => Number(s.section_id) === Number(riskState.selectedSectionId));
        const grade = compactContextValue(sec?.grade_name || '');
        const section = compactContextValue(sec?.section_name || '');
        return {
            label: 'Section',
            value: compactContextValue([grade, section].filter(Boolean).join(' ')) || 'All Sections'
        };
    }

    return {
        label: 'Scope',
        value: 'Whole School Year'
    };
}

function getPrintContextItems() {
    const items = [];

    if (riskState.isTeacher) {
        items.push({
            label: 'Teaching Load',
            value: getTeacherPrintScopeValue()
        });
    } else {
        items.push(getAdminPrintScopeContext());
    }

    items.push({ label: 'Grading Period', value: getCurrentPeriodLabel() || 'First available period' });
    items.push({ label: 'School Year', value: getCurrentSchoolYearLabel() || 'N/A' });

    return items.map((item) => ({
        label: compactContextValue(item.label),
        value: compactContextValue(item.value) || 'N/A'
    }));
}

function formatRiskIndicatorText(value) {
    const text = String(value || '').trim();
    if (!text || /^No encoded indicator details$/i.test(text)) return 'Stable Record';

    const readable = text
        .replace(/\b1 Failing Subject:\s*Failing subject:\s*/gi, 'One failing subject: ')
        .replace(/\b2 or More Failing Subjects:\s*Failing subjects:\s*/gi, 'Two or more failing subjects: ')
        .replace(/\b2 or More Failing Subjects\b/g, 'Two or more failing subjects')
        .replace(/\b1 Failing Subject\b/g, 'One failing subject')
        .replace(/\bLowest Grade Below Passing\b/g, 'Lowest grade is below passing')
        .replace(/\bPeriod Average Below Passing\b/g, 'Period average is below passing')
        .replace(/\bLow General Average\b/g, 'General average is below passing')
        .replace(/\bFailed Subject Final Grade\b/g, 'Final grade failed in subject')
        .replace(/\bSudden Grade Drop\b/g, 'Grade trend declined')
        .replace(/\bChronic Absence\b/g, 'Chronic absence')
        .replace(/\bFrequent Absence\b/g, 'Frequent absence')
        .replace(/\bAttendance Rate Below Threshold\b/g, 'Attendance needs monitoring')
        .replace(/\bRepeated Tardiness\b/g, 'Repeated tardiness')
        .replace(/\bNo Encoded Grades\b/g, 'No grades encoded')
        .replace(/\bIncomplete Grades\b/g, 'Incomplete grades')
        .replace(/\bFailing subjects:\s*/g, '')
        .replace(/\bFailing subject:\s*/g, '')
        .replace(/\bFinal failing subject\(s\):\s*/gi, 'Final subject below passing: ')
        .replace(/\bTrend score \+\d+:\s*/gi, '')
        .replace(/\bLatest drop:\s*/gi, 'Dropped by ')
        .replace(/\bpoints vs previous period\b/gi, 'points from the previous period')
        .replace(/\bperiod average dropped by\b/gi, 'Period average dropped by')
        .replace(/\bperiod average declined for\b/gi, 'Period average declined for')
        .replace(/\bDeclining performance for\b/gi, 'Grades declined for')
        .replace(/\bconsecutive period\(s\)\.?\s*/gi, 'consecutive grading periods ')
        .replace(/\bLate\/Cutting instances:\s*/gi, 'Late or cutting class records: ');

    return readable
        .replace(/\s*[|;]\s*/g, ' / ')
        .replace(/\(([^()]*)\)/g, ' ($1)')
        .replace(/\s+/g, ' ')
        .replace(/\s+\/\s+/g, ' / ')
        .trim();
}

function renderRiskIndicatorDetails(value) {
    const readable = formatRiskIndicatorText(value);
    if (!readable || readable === 'Stable Record') {
        return `<p class="risk-indicator-empty">${escapeHtml(readable || 'Stable Record')}</p>`;
    }

    const labels = [
        'Two or more failing subjects', 'One failing subject', 'Chronic absence',
        'Frequent absence', 'Attendance needs monitoring', 'Repeated tardiness',
        'No grades encoded', 'Incomplete grades', 'Lowest grade is below passing',
        'Period average is below passing', 'General average is below passing',
        'Final grade failed in subject', 'Grade trend declined'
    ];
    const orderedLabels = labels.sort((a, b) => b.length - a.length);
    const entries = [];

    readable.split(/\s*\/\s*/).map((part) => part.trim()).filter(Boolean).forEach((part) => {
        const label = orderedLabels.find((candidate) => part.toLowerCase().startsWith(candidate.toLowerCase()));
        if (label) {
            const remainder = part.slice(label.length).replace(/^\s*:\s*/, '').trim();
            const entry = { label, detail: '', subitems: [] };
            if (/failing subject|grade trend declined/i.test(label) && remainder) entry.subitems.push(remainder);
            else entry.detail = remainder;
            entries.push(entry);
        } else if (entries.length && /failing subject|grade trend declined/i.test(entries[entries.length - 1].label)) {
            entries[entries.length - 1].subitems.push(part);
        } else if (entries.length) {
            entries[entries.length - 1].detail = [entries[entries.length - 1].detail, part].filter(Boolean).join(' ');
        } else {
            entries.push({ label: 'Risk indicator', detail: part, subitems: [] });
        }
    });

    return `<ul class="risk-indicator-list">${entries.map((entry) => `
        <li class="risk-indicator-item">
            <strong>${escapeHtml(entry.label)}</strong>
            ${entry.detail ? `<span class="risk-indicator-note">${escapeHtml(entry.detail)}</span>` : ''}
            ${entry.subitems.length ? `<ul class="risk-indicator-subitems">${entry.subitems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
        </li>`).join('')}
    </ul>`;
}

function renderRiskRecommendedAction(value) {
    const action = String(value || '').trim() || 'Continue routine monitoring and support.';
    const parts = action.split(/\s*\/\s*/).map(part => part.trim()).filter(Boolean);
    const rendered = parts.map(part => {
        const urgent = part.match(/^(.*?)\s*:\s*urgent\s*:\s*(.*)$/i)
            || part.match(/^urgent\s*:\s*(.*)$/i);
        if (urgent) {
            const indicator = urgent.length === 3 ? urgent[1].trim() : '';
            const detail = urgent.length === 3 ? urgent[2] : urgent[1];
            return `<div class="risk-action-content">${indicator ? `<strong>${escapeHtml(indicator)}</strong>` : ''}<span class="risk-action-priority">Urgent</span><span>${escapeHtml(detail)}</span></div>`;
        }
        return `<div class="risk-action-content">${escapeHtml(part)}</div>`;
    });
    return rendered.join('') || `<span>${escapeHtml(action)}</span>`;
}

function getRiskIndicatorSummary(value) {
    const fullText = formatRiskIndicatorText(value);
    const rules = [
        [/two or more failing subjects/i, '2+ failing subjects'],
        [/one failing subject/i, '1 failing subject'],
        [/no grades encoded/i, 'No grades encoded'],
        [/incomplete grades/i, 'Incomplete grades'],
        [/chronic absence/i, 'Chronic absence'],
        [/frequent absence/i, 'Frequent absence'],
        [/repeated tardiness/i, 'Repeated tardiness'],
        [/attendance needs monitoring/i, 'Attendance needs monitoring'],
        [/grade trend declined/i, 'Grade trend declined'],
        [/general average is below passing/i, 'Low general average'],
        [/period average is below passing/i, 'Low period average'],
        [/lowest grade is below passing/i, 'Low subject grade']
    ];
    const match = rules.find(([pattern]) => pattern.test(fullText));
    if (match) return match[1];

    const firstSignal = fullText.split(/\s*\/\s*/)[0].trim();
    if (!firstSignal || firstSignal === 'Stable Record') return 'Stable Record';
    return firstSignal.length > 44 ? `${firstSignal.slice(0, 44).trimEnd()}…` : firstSignal;
}

function getRiskActionSummary(value) {
    const fullText = String(value || '').trim();
    if (!fullText) return 'Continue routine support';
    if (/(?:^|\/)\s*(?:[^:]+\s*:\s*)?urgent\s*:/i.test(fullText)) return 'Urgent intervention';
    if (/routine monitoring|routine support|no immediate intervention/i.test(fullText)) return 'Continue routine support';
    if (/targeted support/i.test(fullText)) return 'Continue targeted support';
    if (/immediate intervention/i.test(fullText)) return 'Provide focused support';
    if (/monitor/i.test(fullText)) return 'Continue monitoring';
    return fullText.length > 42 ? `${fullText.slice(0, 42).trimEnd()}…` : fullText;
}

function renderRiskDashboard() {
    const summary = normalizeSummary(riskState.lastSummary, riskState.lastLoadedRows);
    riskState.lastSummary = summary;

    const contextEl = document.getElementById('riskContextLine');
    if (contextEl) {
        // Context summary removed — filters are self-explanatory and readable.
        contextEl.textContent = '';
    }

}

let riskTableObserver = null;
let riskFocusApplied = false;
let riskFocusJumpAttempted = false;
const RISK_FOCUS_STORAGE_KEY = 'focusRiskAssessmentId';
const RISK_FOCUS_CONTEXT_STORAGE_KEY = 'focusRiskAssessmentContext';

function getPendingRiskFocusId() {
    try {
        const raw = sessionStorage.getItem(RISK_FOCUS_STORAGE_KEY);
        const id = Number(raw || 0);
        return Number.isFinite(id) && id > 0 ? id : null;
    } catch (_) {
        return null;
    }
}

function clearPendingRiskFocusId() {
    try {
        sessionStorage.removeItem(RISK_FOCUS_STORAGE_KEY);
    } catch (_) {
        // ignore
    }

    riskFocusJumpAttempted = false;
}

function getPendingRiskFocusContext() {
    try {
        const raw = sessionStorage.getItem(RISK_FOCUS_CONTEXT_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
        return null;
    }
}

function clearPendingRiskFocusContext() {
    try {
        sessionStorage.removeItem(RISK_FOCUS_CONTEXT_STORAGE_KEY);
    } catch (_) {
        // ignore
    }
}

function normalizeMatchText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function extractLearnerHintFromContext(context) {
    const msg = String(context?.message || '').trim();
    const title = String(context?.title || '').trim();
    const src = msg || title;
    if (!src) return '';

    // Example message pattern: "Lastname, Firstname (Grade Section) flagged as High ..."
    const match = src.match(/^(.+?)(?:\s*\(|\s+flagged\s+as\b)/i);
    const candidate = (match && match[1]) ? match[1] : src;
    return String(candidate)
        .replace(/\s+(?:grade\s+\d+)(?:\s*\([^)]*\))?\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getRiskColumnsFromNotification(rowData, context) {
    const fallback = ['learner_name', 'risk_name', 'indicators'];
    if (!rowData || typeof rowData !== 'object') return fallback;

    const sourceText = normalizeMatchText(`${context?.title || ''} ${context?.message || ''}`);
    const candidates = [
        'learner_name',
        'lrn',
        'section_name',
        'grade_name',
        'period_name',
        'risk_name',
        'indicators'
    ];

    const matched = candidates.filter((key) => {
        const val = normalizeMatchText(rowData[key]);
        return val !== '' && sourceText.includes(val);
    });

    if (!matched.includes('learner_name')) matched.unshift('learner_name');
    if (!matched.includes('risk_name')) matched.push('risk_name');

    const unique = Array.from(new Set(matched));
    return unique.length ? unique : fallback;
}

function highlightRiskRowCells(rowEl, columnKeys, outlineColor) {
    if (!rowEl) return;

    rowEl.classList.add('notif-focus-row');
    rowEl.style.outline = `3px solid ${outlineColor}`;
    rowEl.style.outlineOffset = '-2px';

    const keys = Array.isArray(columnKeys) ? columnKeys : [];
    keys.forEach((key) => {
        const td = rowEl.querySelector(`td[data-col-key="${String(key)}"]`);
        if (!td) return;
        td.classList.add('notif-focus-cell');
    });
}

function clearRiskRowCellHighlight(rowEl) {
    if (!rowEl) return;
    rowEl.classList.remove('notif-focus-row');
    rowEl.style.outline = '';
    rowEl.style.outlineOffset = '';
    rowEl.querySelectorAll('td.notif-focus-cell').forEach((td) => td.classList.remove('notif-focus-cell'));
}

function applyPendingRiskNotificationFocus() {
    if (riskFocusApplied) return;

    const focusId = getPendingRiskFocusId();
    if (!focusId) return;

    const tbody = document.getElementById('dataTableBody');
    if (!tbody) return;

    let rowEl = tbody.querySelector(`tr[data-row-id="${String(focusId)}"]`);
    const context = getPendingRiskFocusContext();

    if (!rowEl && !riskFocusJumpAttempted) {
        let jumped = false;

        if (typeof window.masterfileGoToRowById === 'function') {
            jumped = Boolean(window.masterfileGoToRowById(focusId));
        }

        if (!jumped && typeof window.masterfileFindRowIdByPredicate === 'function' && typeof window.masterfileGoToRowById === 'function') {
            const learnerHint = extractLearnerHintFromContext(context);
            if (learnerHint) {
                const resolvedId = window.masterfileFindRowIdByPredicate((row) => normalizeMatchText(row?.learner_name).includes(normalizeMatchText(learnerHint)));
                if (resolvedId !== null && resolvedId !== undefined && resolvedId !== '') {
                    jumped = Boolean(window.masterfileGoToRowById(resolvedId));
                }
            }
        }

        riskFocusJumpAttempted = true;
        if (jumped) {
            rowEl = tbody.querySelector(`tr[data-row-id="${String(focusId)}"]`)
                || tbody.querySelector('tr[data-row-id]');
        }
        if (!rowEl) return;
    }

    if (!rowEl) {
        if (riskFocusJumpAttempted) {
            const hasRenderedRows = tbody.querySelectorAll('tr[data-row-id]').length > 0;
            const hasEmptyState = Boolean(tbody.querySelector('.empty-state'));
            if (hasRenderedRows || hasEmptyState) {
                clearPendingRiskFocusId();
                clearPendingRiskFocusContext();
                riskFocusApplied = true;
            }
        }
        return;
    }

    const rowData = riskState.lastLoadedRows.find((r) => Number(r?.risk_assessment_id) === focusId) || null;
    const outlineColor = String(rowData?.color_code || '#2563eb');
    const resolvedRowId = Number(rowEl?.getAttribute('data-row-id') || 0);
    const effectiveRowData = riskState.lastLoadedRows.find((r) => Number(r?.risk_assessment_id) === resolvedRowId)
        || rowData
        || null;
    const columnKeys = getRiskColumnsFromNotification(effectiveRowData, context);

    highlightRiskRowCells(rowEl, columnKeys, outlineColor);

    try {
        rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) {
        rowEl.scrollIntoView(true);
    }

    window.setTimeout(() => {
        clearRiskRowCellHighlight(rowEl);
    }, 7000);

    riskFocusApplied = true;
    clearPendingRiskFocusId();
    clearPendingRiskFocusContext();
}

function animateRiskTableRows() {
    // Animations intentionally disabled to avoid interference with notification focus highlighting.
}

function decorateRiskRowsForMobile() {
    const tbody = document.getElementById('dataTableBody');
    if (!tbody) return;
    const emptyState = tbody.querySelector('.mf-state-row .empty-state');
    if (emptyState && !emptyState.querySelector('.risk-empty-learners-video')) {
        const existingIcon = emptyState.querySelector('i');
        if (existingIcon) {
            const video = document.createElement('video');
            video.className = 'mp4-surface-blend risk-empty-learners-video';
            video.setAttribute('autoplay', '');
            video.setAttribute('muted', '');
            video.setAttribute('loop', '');
            video.setAttribute('playsinline', '');
            video.setAttribute('preload', 'auto');
            video.setAttribute('aria-hidden', 'true');
            video.tabIndex = -1;
            video.innerHTML = '<source src="../assets/icons/learners.mp4" type="video/mp4">';
            existingIcon.replaceWith(video);
        }
    }

    const enabled = isRiskMobileViewport();

    tbody.querySelectorAll('tr.mf-record-row[data-row-id]').forEach((rowEl) => {
        const learnerName = rowEl.querySelector('.risk-cell-primary')?.textContent?.trim() || 'learner';
        if (enabled) {
            rowEl.classList.add('risk-detail-row');
            rowEl.setAttribute('role', 'button');
            rowEl.setAttribute('tabindex', '0');
            rowEl.setAttribute('aria-label', `Show risk details for ${learnerName}`);
            rowEl.querySelectorAll('.mf-record-value').forEach((valueEl) => {
                valueEl.removeAttribute('tabindex');
                valueEl.removeAttribute('aria-label');
            });
        } else {
            rowEl.classList.remove('risk-detail-row');
            rowEl.removeAttribute('role');
            rowEl.removeAttribute('tabindex');
            rowEl.removeAttribute('aria-label');
        }
    });
}

function openRiskRowDetails(row) {
    const dialog = document.getElementById('riskRowDetailsDialog');
    const content = document.getElementById('riskRowDetailsContent');
    if (!dialog || !content || !row) return;

    const detail = (label, value, className = '') => `<div class="risk-row-detail-item ${className}"><dt>${escapeHtml(label)}</dt><dd>${value || '—'}</dd></div>`;
    const actionText = String(row.recommended_action || '').trim() || 'Continue routine monitoring and support.';
    const title = document.getElementById('riskRowDetailsTitle');
    if (title) title.textContent = String(row.learner_name || 'Learner details');
    content.innerHTML = [
        detail('Section', escapeHtml(row.section_name || '—'), 'risk-row-detail-section'),
        detail(
            'Academic grade assessment',
            escapeHtml(row.grade_risk_assessed === false
                ? (row.grade_risk_note || 'Not assessed for this grading policy; attendance risk remains active.')
                : 'Numeric grade-based checks apply.'),
            'risk-row-detail-academic-assessment'
        ),
        detail('Risk level', formatRiskLevelCell(row.risk_name || 'Unknown', row), 'risk-row-detail-risk-level'),
        detail('Risk indicators', renderRiskIndicatorDetails(row.indicators), 'risk-row-detail-indicators'),
        detail('Recommended action', renderRiskRecommendedAction(actionText), 'risk-row-detail-action')
    ].join('');

    if (!dialog.open) dialog.showModal();
    document.getElementById('btnCloseRiskRowDetails')?.focus();
}

function wireRiskRowDetails() {
    const tbody = document.getElementById('dataTableBody');
    const dialog = document.getElementById('riskRowDetailsDialog');
    if (!tbody || !dialog) return;

    tbody.addEventListener('click', (event) => {
        const rowEl = event.target.closest('tr.mf-record-row[data-row-id]');
        if (!isRiskMobileViewport() || !rowEl) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const rowData = riskState.lastLoadedRows.find((row) => String(row?.risk_assessment_id) === rowEl.dataset.rowId);
        openRiskRowDetails(rowData);
    }, true);

    tbody.addEventListener('keydown', (event) => {
        const rowEl = event.target.closest('tr.risk-detail-row[data-row-id]');
        if (!rowEl || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const rowData = riskState.lastLoadedRows.find((row) => String(row?.risk_assessment_id) === rowEl.dataset.rowId);
        openRiskRowDetails(rowData);
    }, true);

    document.getElementById('btnCloseRiskRowDetails')?.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
    });
}

function installRiskTableAnimationObserver() {
    const tbody = document.getElementById('dataTableBody');
    if (!tbody || riskTableObserver) return;

    riskTableObserver = new MutationObserver(() => {
        decorateRiskRowsForMobile();
        animateRiskTableRows();
        applyPendingRiskNotificationFocus();
    });

    riskTableObserver.observe(tbody, { childList: true });
    decorateRiskRowsForMobile();
    animateRiskTableRows();
    applyPendingRiskNotificationFocus();
}

const RISK_PRINT_ROWS_PER_SHEET = 12;

function chunkRiskPrintRows(rows, chunkSize = RISK_PRINT_ROWS_PER_SHEET) {
    const safeRows = Array.isArray(rows) ? rows : [];
    if (!safeRows.length) return [[]];

    const chunks = [];
    for (let index = 0; index < safeRows.length; index += chunkSize) {
        chunks.push(safeRows.slice(index, index + chunkSize));
    }
    return chunks;
}

function buildRiskPrintTable(rows) {
    if (!rows.length) {
        return '<div class="empty-note">No at-risk learners found for the selected filters.</div>';
    }

    const body = rows.map((row) => {
        const riskClass = String(row.risk_name || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return `
            <tr>
                <td>
                    <div class="learner-name">${escapeHtml(row.learner_name || 'Unnamed Learner')}</div>
                    <div class="muted">LRN: ${escapeHtml(row.lrn || '—')}</div>
                </td>
                <td>
                    <div>${escapeHtml(row.section_name || '—')}</div>
                    <div class="muted">${escapeHtml(row.grade_name || '—')} · ${escapeHtml(row.period_name || 'Latest')}</div>
                </td>
                <td class="ta-center">
                    <span class="risk-pill risk-pill--${riskClass}">${escapeHtml(row.risk_name || '—')}</span>
                </td>
                <td>${escapeHtml(formatRiskIndicatorText(row.indicators))}</td>
                <td>${escapeHtml(row.recommended_action || 'Continue routine monitoring and support.')}</td>
            </tr>`;
    }).join('');

    return `
        <table class="risk-table">
            <thead>
                <tr>
                    <th class="w-learner">Learner / LRN</th>
                    <th class="w-class">Class Context</th>
                    <th class="w-risk">Risk Level</th>
                    <th>Risk Indicators</th>
                    <th>Recommended Action</th>
                </tr>
            </thead>
            <tbody>${body}</tbody>
        </table>`;
}

function buildRiskPrintContextLine(contextItems) {
    return `<div class="context-line" aria-label="Report details">
        ${contextItems.map((item) => `
            <strong class="context-value">${escapeHtml(item.value)}</strong>
        `).join('')}
    </div>`;
}

function buildRiskTemplateContent(rows, options = {}) {
    const contextItems = getPrintContextItems();
    const sheets = chunkRiskPrintRows(rows);

    const appBase = (typeof window !== 'undefined' && window.APP_BASE) ? String(window.APP_BASE) : '';
    const leftLogoUrl = options.leftLogoUrl || `${appBase}/assets/img/logo/Seal_of_the_Department_of_Education_of_the_Philippines.png`;
    const rightLogoUrl = options.rightLogoUrl || `${appBase}/assets/img/logo/logo.png`;

    return `
        <main class="risk-print-page">
            ${sheets.map((sheetRows, index) => `
                <section class="risk-print-sheet${index ? ' risk-print-sheet--continuation' : ''}">
                    <div class="sheet-body">
                        <header class="deped-head">
                            <div class="deped-seal"><img src="${escapeHtml(leftLogoUrl)}" alt="DepEd Seal" /></div>
                        <div class="deped-text">
                            <div class="school-name">${escapeHtml(riskState.schoolName || 'School Name')}</div>
                            <h1>Risk Assessment Monitoring Report</h1>
                            <div class="subtitle">Learner Intervention and Support List</div>
                        </div>
                            <div class="deped-seal deped-seal-right"><img src="${escapeHtml(rightLogoUrl)}" alt="School logo" /></div>
                        </header>

                        ${buildRiskPrintContextLine(contextItems)}

                        <section class="table-section">
                            <div class="section-title">Learners Requiring Monitoring / Intervention</div>
                            ${buildRiskPrintTable(sheetRows)}
                        </section>
                    </div>

                    <footer class="sheet-foot">
                        <span>Generated by G.Pelaez Integrated School</span>
                        <span>Page ${index + 1} of ${sheets.length}</span>
                    </footer>
                </section>
            `).join('')}
        </main>`;
}

function getRiskTemplateCss() {
    return `
:root{--ink:#000;--muted:#374151;--soft:#f6f8fb;--critical:#991b1b;--high:#991b1b;--medium:#92400e;--moderate:#92400e;--low:#166534}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;color:var(--ink);font-family:Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{padding:10mm}
img{display:block}
.risk-print-page{width:100%;max-width:none;margin:0 auto;background:#fff}
.risk-print-sheet{width:100%;height:auto;min-height:0;border:0.75pt solid var(--ink);padding:4mm;display:flex;flex-direction:column;break-inside:avoid;break-after:page;page-break-inside:avoid;page-break-after:always;overflow:visible;background:#fff}
.risk-print-sheet:last-child{break-after:auto;page-break-after:auto}
.sheet-body{min-height:0;display:flex;flex-direction:column}
.deped-head{position:relative;min-height:30mm;margin-bottom:2.5mm;padding-bottom:2mm}
.deped-seal{position:absolute;left:0;top:0;width:27mm;height:27mm;display:flex;align-items:flex-start;justify-content:flex-start}
.deped-seal-right{left:auto;right:0;justify-content:flex-end}
.deped-seal img{width:27mm;height:27mm;object-fit:contain}
.deped-text{width:calc(100% - 64mm);margin:0 auto;text-align:center;line-height:1.22}
.school-name{font-size:10pt;font-weight:700;line-height:1.15;margin:0 0 1.2mm;text-transform:uppercase;overflow-wrap:anywhere}
 h1{font-size:12pt;line-height:1.1;margin:1.2mm 0 0;text-transform:uppercase;letter-spacing:0}
.subtitle{font-size:8pt;margin-top:1mm}
.context-line{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:1.5mm 6mm;margin:0 0 3mm;padding:1.6mm 0;text-align:center;font-size:8.5pt;line-height:1.25}
.context-line strong{font-weight:700;overflow-wrap:anywhere}
.table-section{padding:0;margin:0;min-height:0;display:block}
.section-title{font-size:8pt;font-weight:700;color:#000;text-transform:uppercase;text-align:center;margin:0 0 1.8mm;padding:0;border:0;background:transparent}
.risk-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:7pt;line-height:1.2;color:var(--ink)}
.risk-table th,.risk-table td{border:0.5pt solid #000;color:#000;padding:1.25mm;vertical-align:top;overflow-wrap:anywhere}
.risk-table th{font-weight:700;text-align:center;background:transparent}
.risk-table thead tr:first-child th{border-top:0.5pt solid #000}
.w-learner{width:34mm}
.w-class{width:32mm}
.w-risk{width:22mm}
.learner-name{font-weight:700;margin-bottom:0.6mm}
.ta-center{text-align:center}
.fw-700{font-weight:700}
.muted{color:var(--muted);font-size:7pt}
.risk-pill{display:inline-block;border:0.5pt solid #334155;padding:0.7mm 1.2mm;font-size:6.6pt;font-weight:700;text-transform:uppercase;white-space:nowrap}
.risk-pill--critical{border-color:var(--high);color:var(--high)}
.risk-pill--high{border-color:var(--high);color:var(--high)}
.risk-pill--medium{border-color:var(--medium);color:var(--medium)}
.risk-pill--moderate{border-color:var(--medium);color:var(--medium)}
.risk-pill--low{border-color:var(--low);color:var(--low)}
.empty-note{text-align:center;font-style:italic;padding:8mm 4mm;font-size:9pt}
.sheet-foot{margin-top:2.5mm;padding-top:1.8mm;display:flex;justify-content:space-between;gap:4mm;font-size:7pt;line-height:1.2;color:var(--muted);break-inside:avoid;page-break-inside:avoid}
thead{display:table-header-group}
tr{break-inside:avoid;page-break-inside:avoid}
@media screen and (max-width:900px){
  body{padding:12px}
  .risk-print-sheet{height:auto;min-height:0}
  .deped-head{min-height:112px}
  .deped-seal,.deped-seal img{width:72px;height:72px}
  .deped-text{width:calc(100% - 152px)}
  .context-line{font-size:11px}
  .risk-table{font-size:10px}
}
@media print{
  @page{size:landscape;margin:8mm}
  html,body{width:auto;height:auto}
  body{padding:0}
  .risk-print-page{max-width:none;margin:0}
  .risk-print-sheet{height:auto;min-height:0;border:0.75pt solid var(--ink);overflow:visible;break-inside:avoid;break-after:page;page-break-inside:avoid;page-break-after:always}
  .risk-print-sheet:last-child{break-after:auto;page-break-after:auto}
  a[href]::after{content:""}
}
`;
}

function getTemplateLogoUrls() {
    const appBase = (typeof window !== 'undefined' && window.APP_BASE) ? String(window.APP_BASE) : '';
    const leftPath = `${appBase}/assets/img/logo/Seal_of_the_Department_of_Education_of_the_Philippines.png`;
    const rightPath = `${appBase}/assets/img/logo/logo.png`;

    return {
        leftLogoUrl: new URL(leftPath, window.location.origin).toString(),
        rightLogoUrl: new URL(rightPath, window.location.origin).toString()
    };
}

function buildRiskPreviewDocument(rows, logos = {}) {
    const style = `${getRiskTemplateCss()}
@media screen {
    html, body { background:#e3e8ee; }
    body { padding:18px; }
    .risk-print-page { width:100%; max-width:11in; margin:0 auto; }
    .risk-print-sheet { width:11in; min-height:8.5in; margin:0 auto 18px; box-shadow:0 2px 14px rgba(23,39,58,.22); }
}
@media print {
    html, body { background:#fff; }
    body { padding:0; }
    .risk-print-page { width:100%; max-width:none; }
    .risk-print-sheet { width:100%; min-height:0; margin:0; box-shadow:none; }
}`;

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.5, maximum-scale=5, user-scalable=yes">
    <title>Risk assessment preview</title>
    <style>${style}</style>
</head>
<body>${buildRiskTemplateContent(rows, logos)}</body>
</html>`;
}

function openRiskPrintPreview() {
    const modal = document.getElementById('riskPrintModal');
    if (!modal) return;
    modal.classList.add('show');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    const frame = document.getElementById('riskPrintFrame');
    window.refitPrintPreviewFrame?.(frame, frame?.dataset?.printPreviewItems);
}

function closeRiskPrintPreview() {
    const modal = document.getElementById('riskPrintModal');
    const frame = document.getElementById('riskPrintFrame');
    modal?.classList.remove('active', 'show');
    if (modal) modal.style.display = '';
    modal?.setAttribute('aria-hidden', 'true');
    if (frame) {
        frame.onload = null;
        frame.srcdoc = '';
    }
}

function printRiskPreview() {
    const frame = document.getElementById('riskPrintFrame');
    if (!frame?.contentWindow) return;
    frame.contentWindow.focus();
    frame.contentWindow.print();
}

async function generateRiskPreview() {
    const rows = Array.isArray(riskState.lastLoadedRows) ? riskState.lastLoadedRows : [];
    if (!rows.length) {
        notify('info', 'No records to preview');
        return;
    }

    const button = document.getElementById('btnRiskPrint');
    const originalButtonHtml = button?.innerHTML || '';
    if (button) {
        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>Loading preview</span>';
    }

    try {
        const frame = document.getElementById('riskPrintFrame');
        if (!frame) throw new Error('Risk assessment preview frame is missing');
        frame.srcdoc = buildRiskPreviewDocument(rows, getTemplateLogoUrls());
        openRiskPrintPreview();
    } finally {
        if (button) {
            button.disabled = false;
            button.innerHTML = originalButtonHtml || '<i class="fas fa-file-alt" aria-hidden="true"></i><span>Generate preview</span>';
        }
    }
}

async function reloadRecords() {
    if (typeof window.reloadMasterfileRecords === 'function') {
        await window.reloadMasterfileRecords();
        return;
    }
    window.location.reload();
}

async function runAutomation(options = {}) {
    const silent = Boolean(options.silent);
    const payload = await riskAssessmentsApi.automate();
    if (!payload?.success) {
        throw new Error(payload?.message || 'Automation failed');
    }

    if (!silent) {
        const d = payload.data || {};
        notify('success', `Automation complete: ${d.risk_assessments_upserted || 0} assessments, ${d.risk_indicators_upserted || 0} indicators.`);
    }
}

function fillSchoolYearFilter() {
    const sel = document.getElementById('filterSchoolYear');
    if (!sel) return;

    sel.innerHTML = '';
    riskState.schoolYears.forEach((row) => {
        const opt = document.createElement('option');
        opt.value = String(row.school_year_id);
        opt.textContent = row.year_label || `${row.year_start}-${row.year_end}`;
        if (Number(row.school_year_id) === Number(riskState.selectedSchoolYearId)) {
            opt.selected = true;
        }
        sel.appendChild(opt);
    });
}

function fillPeriodFilter() {
    const sel = document.getElementById('filterPeriod');
    if (!sel) return;

    const syId = Number(riskState.selectedSchoolYearId || 0);
    const periods = riskState.gradingPeriods
        .filter((p) => Number(p.school_year_id) === syId)
        .sort((a, b) => Number(a.grading_period_id) - Number(b.grading_period_id));

    sel.innerHTML = '';

    periods.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = String(p.grading_period_id);
        opt.textContent = p.period_name;
        sel.appendChild(opt);
    });

    const stillExists = Array.from(sel.options).some((o) => o.value === String(riskState.selectedGradingPeriodId));
    if (!stillExists) {
        riskState.selectedGradingPeriodId = periods.length ? String(periods[0].grading_period_id) : null;
    }
    sel.value = riskState.selectedGradingPeriodId ? String(riskState.selectedGradingPeriodId) : '';
}

function populateFilterSelect(selectEl, items, valueKey, labelKey, placeholder) {
    if (!selectEl) return;

    selectEl.innerHTML = '';
    if (placeholder) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = placeholder;
        selectEl.appendChild(opt);
    }

    items.forEach((item) => {
        const opt = document.createElement('option');
        opt.value = String(item[valueKey]);
        opt.textContent = String(item[labelKey] || '');
        selectEl.appendChild(opt);
    });
}

function fillGradeLevelFilter() {
    const sel = document.getElementById('filterGradeLevel');
    if (!sel) return;

    const items = [...riskState.gradeLevels].sort((a, b) =>
        Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0)
    );
    populateFilterSelect(sel, items, 'grade_level_id', 'grade_name', 'All Year Levels');

    if (riskState.selectedGradeLevelId) {
        sel.value = String(riskState.selectedGradeLevelId);
    } else {
        sel.value = '';
    }
}

function fillRiskLevelFilter() {
    const sel = document.getElementById('filterRiskLevel');
    if (!sel) return;

    const items = [...riskState.riskLevels].sort((a, b) => Number(a.risk_level_id) - Number(b.risk_level_id));
    const filterItems = buildRiskBandFilterItems(items);
    populateFilterSelect(sel, filterItems, 'risk_level_id', 'risk_filter_name');

    const dangerRiskOption = document.createElement('option');
    dangerRiskOption.value = DANGER_RISK_BAND_FILTER;
    dangerRiskOption.textContent = 'Show in danger';
    sel.insertBefore(dangerRiskOption, sel.firstChild || null);

    const includeLowOption = document.createElement('option');
    includeLowOption.value = '';
    includeLowOption.textContent = 'Show all';
    sel.insertBefore(includeLowOption, sel.options[1] || null);

    const isDangerRiskBand = riskState.selectedRiskLevelId === DANGER_RISK_BAND_FILTER;
    const isHighRiskBand = riskState.selectedRiskLevelId === HIGH_RISK_BAND_FILTER;
    const exists = isDangerRiskBand
        || isHighRiskBand
        || filterItems.some((level) => String(level.risk_level_id) === String(riskState.selectedRiskLevelId));
    if (!exists) {
        riskState.selectedRiskLevelId = DANGER_RISK_BAND_FILTER;
    }

    sel.value = String(riskState.selectedRiskLevelId);
}

function buildRiskBandFilterItems(items) {
    const bands = [];
    const addBand = (bandName, item, filterValue = null) => {
        if (!item || bands.some((band) => band.risk_filter_name === bandName)) return;
        bands.push({
            ...item,
            risk_level_id: filterValue || item.risk_level_id,
            risk_filter_name: bandName
        });
    };

    items.forEach((item) => {
        const normalized = String(item.risk_name || '').trim().toLowerCase();
        if (normalized.includes('low')) {
            addBand('Low', item);
        } else if (normalized.includes('moderate') || normalized.includes('medium')) {
            addBand('Medium', item);
        } else if (normalized.includes('high') || normalized.includes('critical')) {
            addBand('High', item, HIGH_RISK_BAND_FILTER);
        }
    });

    return bands;
}

function fillSectionFilter() {
    const sel = document.getElementById('filterSection');
    if (!sel) return;

    const items = [...riskState.sections].sort(compareSectionOptions);
    const selectorItems = items.map((item) => ({
        ...item,
        section_selector_name: getSectionSelectorLabel(item)
    }));
    populateFilterSelect(sel, selectorItems, 'section_id', 'section_selector_name', 'All Sections');

    const exists = items.some((s) => Number(s.section_id) === Number(riskState.selectedSectionId));
    if (!exists) {
        riskState.selectedSectionId = null;
    }

    sel.value = riskState.selectedSectionId ? String(riskState.selectedSectionId) : '';
}

function updateScopeUI() {
    const scope = riskState.selectedScope || 'school_year';
    const glWrap = document.getElementById('filterGradeLevelWrap');
    const secWrap = document.getElementById('filterSectionWrap');
    if (glWrap) glWrap.style.display = scope === 'year_level' ? 'block' : 'none';
    if (secWrap) secWrap.style.display = scope === 'section' ? 'block' : 'none';
}

function applyRoleUI() {
    const isTeacher = riskState.isTeacher;

    const scopeGroup = document.getElementById('filterScope')?.closest('.form-group');
    const glWrap = document.getElementById('filterGradeLevelWrap');
    const secWrap = document.getElementById('filterSectionWrap');
    const riskLevelWrap = document.getElementById('filterRiskLevelWrap');
    const mySecWrap = document.getElementById('filterMySectionWrap');

    if (scopeGroup) scopeGroup.style.display = isTeacher ? 'none' : '';
    if (glWrap) glWrap.style.display = (!isTeacher && riskState.selectedScope === 'year_level') ? 'block' : 'none';
    if (secWrap) secWrap.style.display = (!isTeacher && riskState.selectedScope === 'section') ? 'block' : 'none';
    if (riskLevelWrap) riskLevelWrap.style.display = '';
    if (mySecWrap) mySecWrap.style.display = isTeacher ? 'block' : 'none';
}

function fillMySectionFilter() {
    const sel = document.getElementById('filterMySection');
    if (!sel) return;

    const items = [...riskState.myAdvisorySections].sort(compareSectionOptions);
    const selectorItems = items.map((item) => ({
        ...item,
        section_selector_name: getSectionSelectorLabel(item)
    }));
    const placeholder = items.length > 1 ? 'All Sections' : 'Section';
    populateFilterSelect(sel, selectorItems, 'section_id', 'section_selector_name', placeholder);

    const exists = items.some((s) => Number(s.section_id) === Number(riskState.selectedMySectionId));
    if (!exists) {
        riskState.selectedMySectionId = null;
    }

    sel.value = riskState.selectedMySectionId ? String(riskState.selectedMySectionId) : '';
}

function getSectionSelectorLabel(section) {
    const grade = compactContextValue(section?.grade_name || '');
    const name = compactContextValue(section?.section_name || '');
    if (grade && name) return `${grade} · ${name}`;
    return name || grade || 'Unnamed Section';
}

function getGradeLevelSortValue(section) {
    const gradeName = String(section?.grade_name || '').trim().toLowerCase();
    if (gradeName.includes('kindergarten')) return 0;

    const numericGrade = gradeName.match(/\d+/);
    if (numericGrade) return Number(numericGrade[0]);

    const gradeId = Number(section?.grade_level_id);
    return Number.isFinite(gradeId) ? gradeId : Number.MAX_SAFE_INTEGER;
}

function compareSectionOptions(a, b) {
    const gradeOrder = getGradeLevelSortValue(a) - getGradeLevelSortValue(b);
    if (gradeOrder !== 0) return gradeOrder;

    return String(a?.section_name || '').localeCompare(
        String(b?.section_name || ''),
        undefined,
        { numeric: true, sensitivity: 'base' }
    );
}

async function loadSectionsForSelectedSchoolYear() {
    const rows = await sectionsApi.list(riskState.selectedSchoolYearId);
    riskState.sections = Array.isArray(rows) ? rows : [];
    fillSectionFilter();
}

async function loadMyAdvisorySections() {
    const rows = await myAdvisorySectionsApi.list(riskState.selectedSchoolYearId);
    riskState.myAdvisorySections = Array.isArray(rows) ? rows : [];
    fillMySectionFilter();
}

async function loadFilters() {
    riskState.isTeacher = isTeacherRole();

    const [schoolYears, periods, gradeLevels, riskLevels, schoolSettings] = await Promise.all([
        schoolYearsApi.list(),
        gradingPeriodsApi.list(),
        gradeLevelsApi.list(),
        riskLevelsApi.list(),
        riskSchoolSettingsApi.all().catch(() => ({}))
    ]);

    riskState.schoolYears = Array.isArray(schoolYears) ? schoolYears : [];
    riskState.gradingPeriods = Array.isArray(periods) ? periods : [];
    riskState.gradeLevels = Array.isArray(gradeLevels) ? gradeLevels : [];
    riskState.riskLevels = Array.isArray(riskLevels) ? riskLevels : [];
    riskState.schoolName = String(schoolSettings?.school_name || schoolSettings?.schoolName || '').trim();

    const active = riskState.schoolYears.find((x) => Number(x.is_active) === 1);
    if (active) {
        riskState.selectedSchoolYearId = Number(active.school_year_id);
    } else if (riskState.schoolYears.length > 0) {
        riskState.selectedSchoolYearId = Number(riskState.schoolYears[0].school_year_id);
    }

    if (riskState.isTeacher) {
        await loadMyAdvisorySections();
    } else {
        await loadSectionsForSelectedSchoolYear();
    }

    fillSchoolYearFilter();
    fillPeriodFilter();
    fillGradeLevelFilter();
    fillRiskLevelFilter();
    fillSectionFilter();
    applyRoleUI();

    const scopeSel = document.getElementById('filterScope');
    if (scopeSel) {
        scopeSel.value = riskState.selectedScope;
    }

    syncRiskMobileMode();
    renderRiskDashboard();
}

function wireFilters() {
    const sySel = document.getElementById('filterSchoolYear');
    const gpSel = document.getElementById('filterPeriod');
    const scopeSel = document.getElementById('filterScope');
    const gradeSel = document.getElementById('filterGradeLevel');
    const sectionSel = document.getElementById('filterSection');
    const mySectionSel = document.getElementById('filterMySection');
    const riskLevelSel = document.getElementById('filterRiskLevel');

    mySectionSel?.addEventListener('change', async () => {
        riskState.selectedMySectionId = Number(mySectionSel.value || 0) || null;
        await refreshRiskResults();
    });

    sySel?.addEventListener('change', async () => {
        riskState.selectedSchoolYearId = Number(sySel.value || 0) || null;
        fillPeriodFilter();
        if (riskState.isTeacher) {
            await loadMyAdvisorySections();
        } else {
            await loadSectionsForSelectedSchoolYear();
        }
        syncRiskMobileMode();
        renderRiskDashboard();
        if (!shouldDeferRiskResults()) {
            try {
                await runAutomation({ silent: true });
            } catch (e) {
                console.error(e);
                notify('error', e.message || 'Automatic refresh failed');
            }
            await reloadRecords();
        }
    });

    gpSel?.addEventListener('change', async () => {
        riskState.selectedGradingPeriodId = gpSel.value || null;
        try {
            await runAutomation({ silent: true });
        } catch (error) {
            console.error('Automatic refresh failed:', error);
            notify('error', error.message || 'Automatic refresh failed');
        }
        await refreshRiskResults();
    });

    scopeSel?.addEventListener('change', async () => {
        riskState.selectedScope = scopeSel.value || 'school_year';
        updateScopeUI();
        await refreshRiskResults();
    });

    gradeSel?.addEventListener('change', async () => {
        riskState.selectedGradeLevelId = Number(gradeSel.value || 0) || null;
        if (riskState.selectedScope === 'year_level') {
            await refreshRiskResults();
        } else {
            renderRiskDashboard();
        }
    });

    sectionSel?.addEventListener('change', async () => {
        riskState.selectedSectionId = Number(sectionSel.value || 0) || null;
        if (riskState.selectedScope === 'section') {
            await refreshRiskResults();
        } else {
            renderRiskDashboard();
        }
    });

    riskLevelSel?.addEventListener('change', async () => {
        if (riskLevelSel.value === DANGER_RISK_BAND_FILTER) {
            riskState.selectedRiskLevelId = DANGER_RISK_BAND_FILTER;
        } else if (riskLevelSel.value === HIGH_RISK_BAND_FILTER) {
            riskState.selectedRiskLevelId = HIGH_RISK_BAND_FILTER;
        } else {
            riskState.selectedRiskLevelId = Number(riskLevelSel.value || 0) || null;
        }
        await refreshRiskResults();
    });
}

function wireMobileRiskFlow() {
    const proceedButton = document.getElementById('btnRiskProceed');
    const changeButton = document.getElementById('btnRiskChangeFilters');

    proceedButton?.addEventListener('click', async () => {
        if (!isRiskMobileViewport()) return;

        proceedButton.disabled = true;
        proceedButton.setAttribute('aria-busy', 'true');
        try {
            try {
                await runAutomation({ silent: true });
            } catch (error) {
                console.error('Automatic refresh failed:', error);
                notify('error', error.message || 'Automatic refresh failed');
            }
            riskState.mobileReady = true;
            syncRiskMobileMode();
            await reloadRecords();
            document.querySelector('.risk-assessment-card .table-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (error) {
            notify('error', error.message || 'Unable to load risk assessments');
        } finally {
            proceedButton.removeAttribute('aria-busy');
            syncRiskMobileMode();
        }
    });

    changeButton?.addEventListener('click', () => {
        if (!isRiskMobileViewport()) return;
        riskState.mobileReady = false;
        syncRiskMobileMode();
        document.getElementById('riskFilters')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    syncRiskMobileMode();
    window.addEventListener('resize', () => {
        const wasMobile = riskState.mobileMode;
        const isMobile = syncRiskMobileMode();
        if (wasMobile !== null && wasMobile !== isMobile && !isMobile) {
            reloadRecords().catch((error) => notify('error', error.message || 'Unable to load risk assessments'));
        }
    }, { passive: true });
}

function wireActionButtons() {
    const printBtn = document.getElementById('btnRiskPrint');
    printBtn?.addEventListener('click', () => {
        generateRiskPreview().catch((error) => {
            console.error(error);
            notify('error', 'Unable to render print template');
        });
    });

    const closeRiskPreview = () => closeRiskPrintPreview();
    document.getElementById('btnCloseRiskPrintPreview')?.addEventListener('click', closeRiskPreview);
    document.getElementById('btnCloseRiskPrintPreviewFooter')?.addEventListener('click', closeRiskPreview);
    document.getElementById('btnPrintRiskPreview')?.addEventListener('click', printRiskPreview);
    document.getElementById('riskPrintModal')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) closeRiskPreview();
    });

    const mechanicsBtn = document.getElementById('btnRiskMechanics');
    const mechanicsModal = document.getElementById('riskMechanicsModal');
    const closeMechanics = () => {
        mechanicsModal?.classList.remove('active', 'show');
        mechanicsModal?.setAttribute('aria-hidden', 'true');
    };
    const openMechanics = () => {
        mechanicsModal?.classList.add('active', 'show');
        mechanicsModal?.setAttribute('aria-hidden', 'false');
    };

    mechanicsBtn?.addEventListener('click', openMechanics);
    document.getElementById('btnCloseRiskMechanics')?.addEventListener('click', closeMechanics);
    document.getElementById('btnDoneRiskMechanics')?.addEventListener('click', closeMechanics);
    mechanicsModal?.addEventListener('click', (event) => {
        if (event.target === mechanicsModal) {
            closeMechanics();
        }
    });
}

function buildMasterfileConfig() {
    return {
        key: 'risk_assessments',
        navKey: 'risk_assessment',
        entity: 'At-Risk Learner',
        pageTitle: riskState.isTeacher ? 'My At-Risk Learners' : 'Risk Assessments',
        subtitle: riskState.isTeacher
            ? ''
            : '',
        breadcrumb: 'Risk Assessments',
        addLabel: 'Run Auto Flag',
        primaryKey: 'risk_assessment_id',
        readOnly: true,
        columns: [
            { key: 'learner_name', label: 'Learner', formatter: formatRiskLearnerCell },
            { key: 'section_name', label: 'Section', mobileHidden: true, formatter: formatRiskSectionCell },
            {
                key: 'risk_name',
                label: 'Risk Level',
                mobileHidden: true,
                formatter: formatRiskLevelCell
            },
            {
                key: 'indicators',
                label: 'Risk Indicators',
                mobileHidden: true,
                formatter: (v) => {
                    const text = formatRiskIndicatorText(v);
                    const short = getRiskIndicatorSummary(v);
                    return `<span title="${escapeHtml(text)}">${escapeHtml(short)}</span>`;
                }
            },
            {
                key: 'recommended_action',
                label: 'Recommended Action',
                mobileHidden: true,
                formatter: (v) => {
                    const text = String(v || '').trim() || 'Continue routine monitoring and support.';
                    return `<span title="${escapeHtml(text)}">${escapeHtml(getRiskActionSummary(text))}</span>`;
                }
            }
        ],
        fields: [],
        api: {
            list: async () => {
                if (shouldDeferRiskResults()) return [];
                return riskAssessmentsApi.list();
            },
            create: async () => ({ success: false, message: 'Manual edit is disabled for automated risk module.' }),
            update: async () => ({ success: false, message: 'Manual edit is disabled for automated risk module.' }),
            remove: async () => ({ success: false, message: 'Manual edit is disabled for automated risk module.' })
        }
    };
}

document.addEventListener('DOMContentLoaded', () => {
    waitForRole(async () => {
    try {
        // Keep a pending notification target until the table has rendered it.
        // The focus helpers clear the target after the matching row is shown.

        installRiskTableAnimationObserver();

        await loadFilters();

        if (!isRiskMobileViewport()) {
            try {
                await runAutomation({ silent: true });
            } catch (e) {
                // Keep module usable even if automation call fails.
                console.error('Initial automation failed:', e);
            }
        }

        initializeMasterfile(buildMasterfileConfig());
        wireRiskRowDetails();
        wireActionButtons();
        wireFilters();
        wireMobileRiskFlow();
    } catch (error) {
        console.error(error);
        notify('error', error?.message || 'Failed to initialize risk module');
    }
    });
});
