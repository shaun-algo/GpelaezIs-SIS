const API_BASE = window.API_BASE || `${window.location.protocol}//${window.location.host}/deped_capstone2/api`;

const state = {
    schoolYears: [],
    periods: [],
    schoolYearId: null,
    session: null,
    riskLevelChart: null,
    reasonChart: null,
    riskByGradeChart: null,
    riskBySectionChart: null,
    requestSerial: 0
};

const palette = {
    high: '#b91c1c',
    medium: '#d97706',
    low: '#166534',
    trend: '#2563eb',
    academic: '#7c3aed',
    attendance: '#0f766e',
    incomplete: '#64748b'
};

function riskKey(row) {
    const name = String(row?.risk_name || '').toLowerCase();
    if (name.includes('high') || name.includes('critical')) return 'high';
    if (name.includes('medium') || name.includes('moderate')) return 'medium';
    return 'low';
}

function splitIndicators(value) {
    return String(value || '')
        .split(/\s+(?:\/|\|)\s+|;\s+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function reasonBucket(indicator) {
    const text = String(indicator || '').toLowerCase();
    if (text.includes('grade trend') || text.includes('sudden grade drop') || text.includes('dropped by') || text.includes('declined')) {
        return 'Subject grade trend';
    }
    if (text.includes('failing') || text.includes('below passing') || text.includes('general average') || text.includes('period average')) {
        return 'Academic performance';
    }
    if (text.includes('absence') || text.includes('attendance') || text.includes('tardiness') || text.includes('late')) {
        return 'Attendance behavior';
    }
    if (text.includes('incomplete') || text.includes('no grades encoded')) {
        return 'Incomplete records';
    }
    return 'Other signals';
}

async function getJson(path, params = {}) {
    const response = await axios.get(`${API_BASE}/${path}`, { params });
    return response.data;
}

async function loadSession() {
    try {
        const payload = await getJson('auth/me.php');
        state.session = payload?.success ? (payload.data || null) : null;
    } catch (_) {
        state.session = null;
    }
}

function fillSelect(select, rows, valueKey, labelKey, placeholder) {
    if (!select) return;
    select.innerHTML = '';
    if (placeholder) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = placeholder;
        select.appendChild(opt);
    }
    const orderedRows = valueKey === 'grade_level_id' && labelKey === 'grade_name'
        ? [...(rows || [])].sort((a, b) => Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0))
        : (rows || []);
    orderedRows.forEach((row) => {
        const opt = document.createElement('option');
        opt.value = String(row[valueKey]);
        opt.textContent = String(row[labelKey] || '');
        select.appendChild(opt);
    });
}

function sortPeriods(a, b) {
    const dateA = String(a.date_start || '9999-12-31');
    const dateB = String(b.date_start || '9999-12-31');
    return dateA.localeCompare(dateB)
        || Number(a.grading_period_id) - Number(b.grading_period_id);
}

function periodsForSelectedYear() {
    return state.periods
        .filter((period) => Number(period.school_year_id) === Number(state.schoolYearId))
        .sort(sortPeriods);
}

async function loadFilters() {
    await loadSession();
    const [schoolYears, periods] = await Promise.all([
        getJson('school_years/school_years.php', { operation: 'getAllSchoolYears' }),
        getJson('grading_periods/grading_periods.php', { operation: 'getAllGradingPeriods' })
    ]);

    state.schoolYears = Array.isArray(schoolYears) ? schoolYears : [];
    state.periods = Array.isArray(periods) ? periods : [];

    const activeYear = state.schoolYears.find((item) => Number(item.is_active) === 1) || state.schoolYears[0] || null;
    state.schoolYearId = activeYear ? Number(activeYear.school_year_id) : null;

    renderFilters();
}

function renderFilters() {
    fillSelect(document.getElementById('filterSchoolYear'), state.schoolYears, 'school_year_id', 'year_label', '');
    const sy = document.getElementById('filterSchoolYear');
    if (sy) sy.value = state.schoolYearId ? String(state.schoolYearId) : '';
}

function chartConfig(type, labels, data, colors) {
    return {
        type,
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: colors,
                borderColor: '#ffffff',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom'
                }
            },
            scales: type === 'bar' ? {
                y: {
                    beginAtZero: true,
                    ticks: { precision: 0 }
                }
            } : {}
        }
    };
}

function riskByGradeChartConfig(rows) {
    const labels = rows.length ? rows.map((row) => row.label) : ['No assessed learners'];
    const values = (key) => rows.length ? rows.map((row) => row[key]) : [0];
    return {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'High', data: values('high'), backgroundColor: palette.high, borderRadius: 4 },
                { label: 'Medium', data: values('medium'), backgroundColor: palette.medium, borderRadius: 4 },
                { label: 'Low', data: values('low'), backgroundColor: palette.low, borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom' } },
            scales: {
                x: { stacked: true },
                y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }
            }
        }
    };
}

function riskBySectionChartConfig(rows) {
    const labels = rows.length ? rows.map((row) => row.label) : ['No assessed learners'];
    const values = (key) => rows.length ? rows.map((row) => row[key]) : [0];
    return {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'High', data: values('high'), backgroundColor: palette.high, borderRadius: 4 },
                { label: 'Medium', data: values('medium'), backgroundColor: palette.medium, borderRadius: 4 },
                { label: 'Low', data: values('low'), backgroundColor: palette.low, borderRadius: 4 }
            ]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom' } },
            scales: {
                x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
                y: { stacked: true }
            }
        }
    };
}

function renderChart(existing, canvasId, config) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return null;
    if (existing) existing.destroy();
    return new Chart(canvas, config);
}

function analyze(records) {
    // Each API request has already applied one selected grading period and role scope.
    // Include every returned level so Low assessments are not silently
    // removed from the distribution.
    const scored = records;
    const levels = { high: 0, medium: 0, low: 0 };
    const reasonCounts = new Map();
    const gradeCounts = new Map();
    const sectionCounts = new Map();

    scored.forEach((row) => {
        const level = riskKey(row);
        levels[level] += 1;
        const yearPrefix = !state.schoolYearId && row.year_label ? `${row.year_label} · ` : '';
        const label = `${yearPrefix}${row.grade_name || 'Unknown year level'}`;
        if (!gradeCounts.has(label)) {
            gradeCounts.set(label, { label, high: 0, medium: 0, low: 0 });
        }
        gradeCounts.get(label)[level] += 1;
        const sectionLabel = `${yearPrefix}${row.grade_name || 'Unknown year level'} · ${row.section_name || 'Unassigned section'}`;
        if (!sectionCounts.has(sectionLabel)) {
            sectionCounts.set(sectionLabel, { label: sectionLabel, high: 0, medium: 0, low: 0 });
        }
        sectionCounts.get(sectionLabel)[level] += 1;
        splitIndicators(row.indicators).forEach((indicator) => {
            const bucket = reasonBucket(indicator);
            reasonCounts.set(bucket, (reasonCounts.get(bucket) || 0) + 1);
        });
    });

    const sortedReasons = Array.from(reasonCounts.entries())
        .sort((a, b) => b[1] - a[1]);
    const byGrade = [...gradeCounts.values()]
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    const bySection = [...sectionCounts.values()]
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

    return { scored, levels, sortedReasons, byGrade, bySection };
}

function renderAnalytics(records) {
    const analysis = analyze(records);

    state.riskLevelChart = renderChart(state.riskLevelChart, 'riskLevelChart', chartConfig(
        'doughnut',
        ['High', 'Medium', 'Low with points'],
        [analysis.levels.high, analysis.levels.medium, analysis.levels.low],
        [palette.high, palette.medium, palette.low]
    ));

    const reasonLabels = analysis.sortedReasons.slice(0, 6).map(([label]) => label);
    const reasonValues = analysis.sortedReasons.slice(0, 6).map(([, count]) => count);
    state.reasonChart = renderChart(state.reasonChart, 'riskReasonChart', chartConfig(
        'bar',
        reasonLabels.length ? reasonLabels : ['No active signals'],
        reasonValues.length ? reasonValues : [0],
        [palette.trend, palette.academic, palette.attendance, palette.incomplete, '#9333ea', '#475569']
    ));

    state.riskByGradeChart = renderChart(state.riskByGradeChart, 'riskByGradeChart', riskByGradeChartConfig(analysis.byGrade));
    state.riskBySectionChart = renderChart(state.riskBySectionChart, 'riskBySectionChart', riskBySectionChartConfig(analysis.bySection));
}

function setRiskPeriodNote(message) {
    const note = document.getElementById('riskPeriodNote');
    if (note) note.textContent = message;
}

async function loadRiskAnalytics() {
    const requestId = ++state.requestSerial;
    const schoolYear = state.schoolYears.find((year) => Number(year.school_year_id) === Number(state.schoolYearId));
        const periods = periodsForSelectedYear();
        if (!schoolYear || !periods.length) {
            setRiskPeriodNote('No grading periods are configured for the selected school year.');
            renderAnalytics([]);
            return;
        }

    const batches = await Promise.all(periods.map(async (period) => {
        const params = {
            operation: 'getAtRiskLearners',
            analytics: 1,
            include_low: 1,
            school_year_id: Number(schoolYear.school_year_id),
            grading_period_id: Number(period.grading_period_id)
        };
        const payload = await getJson('risk_assessments/risk_assessments.php', params);
        return payload?.success && Array.isArray(payload?.data?.records) ? payload.data.records : [];
    }));
    if (requestId !== state.requestSerial) return;
    const seen = new Set();
    const records = batches.flat().filter((row) => {
        const key = row.risk_assessment_id
            ? `assessment:${row.risk_assessment_id}`
            : `learner:${row.enrollment_id}:${row.grading_period_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    setRiskPeriodNote(`${schoolYear.year_label || 'Selected school year'}: all ${periods.length} grading periods are displayed.`);
    renderAnalytics(records);
}

function wireFilters() {
    document.getElementById('filterSchoolYear')?.addEventListener('change', async (event) => {
        state.schoolYearId = Number(event.target.value || 0) || null;
        renderFilters();
        await loadRiskAnalytics();
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadFilters();
        wireFilters();
        await loadRiskAnalytics();
    } catch (error) {
        console.error(error);
        renderAnalytics([]);
    }
});
