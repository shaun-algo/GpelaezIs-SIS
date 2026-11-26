const API_BASE = window.API_BASE || `${window.location.protocol}//${window.location.host}/deped_capstone2/api`;

const state = {
    viewFilters: {
        population: { school_year_id: '', subject_id: '' },
        proficiency: { school_year_id: '', subject_id: '' },
        trends: { school_year_id: '', subject_id: '' }
    },
    refsLoaded: false,
    activeView: 'population',
    breakdownMode: 'grade_level',
    lastLearners: {},
    charts: {},
    requestSerial: 0,
    loading: false
};

const VIEW_FILTER_IDS = {
    population: { school_year_id: 'filterSchoolYearPopulation', subject_id: null },
    proficiency: { school_year_id: 'filterSchoolYearProficiency', subject_id: 'filterSubjectProficiency' },
    trends: { school_year_id: 'filterSchoolYearTrends', subject_id: null }
};

const PROFICIENCY_LEVELS = [
    { label: 'Advanced', range: '90-100', color: '#0F766E' },
    { label: 'Proficient', range: '85-89', color: '#0055A4' },
    { label: 'Approaching Proficiency', range: '80-84', color: '#F59E0B' },
    { label: 'Developing', range: '75-79', color: '#7C3AED' },
    { label: 'Beginning', range: '74 and below', color: '#DC2626' },
    { label: 'No Grade', range: 'No computed grade', color: '#94A3B8' }
];

document.addEventListener('DOMContentLoaded', () => {
    initCharts();
    bindFilters();
    bindLearnerBreakdownFilter();
    bindAnalyticsToggle();
    switchAnalyticsView(getInitialAnalyticsView());
    loadDashboardAnalytics();
});

function el(id) {
    return document.getElementById(id);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function analyticsEmptyMarkup(message) {
    return `<div class="analytics-empty-state" role="status">
        <video class="mp4-surface-blend analytics-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true">
            <source src="../assets/icons/search.mp4" type="video/mp4">
        </video>
        <span>${escapeHtml(message)}</span>
    </div>`;
}

function selectedFilters(view = state.activeView) {
    const ids = VIEW_FILTER_IDS[view] || VIEW_FILTER_IDS.population;
    const current = state.viewFilters[view] || { school_year_id: '', subject_id: '' };
    const valueOf = (id, fallback = '') => {
        const node = id ? el(id) : null;
        return node ? node.value : fallback;
    };

    return {
        school_year_id: valueOf(ids.school_year_id, current.school_year_id || ''),
        subject_id: valueOf(ids.subject_id, current.subject_id || '')
    };
}

function bindFilters() {
    Object.entries(VIEW_FILTER_IDS).forEach(([view, ids]) => {
        [ids.school_year_id, ids.subject_id].filter(Boolean).forEach((id) => {
            el(id)?.addEventListener('change', () => {
                state.viewFilters[view] = selectedFilters(view);
                if (id === ids.school_year_id && ids.subject_id) {
                    state.viewFilters[view].subject_id = '';
                    if (el(ids.subject_id)) el(ids.subject_id).value = '';
                }
                if (view === state.activeView) loadDashboardAnalytics();
            });
        });
    });
}

function bindLearnerBreakdownFilter() {
    el('learnerBreakdownMode')?.addEventListener('change', (event) => {
        state.breakdownMode = event.target.value === 'section' ? 'section' : 'grade_level';
        updateLearnerBreakdownChart(state.lastLearners);
    });
}

function bindAnalyticsToggle() {
    document.querySelectorAll('[data-analytics-view]').forEach((button) => {
        button.addEventListener('click', () => {
            const nextView = button.dataset.analyticsView || 'population';
            if (state.activeView === nextView) return;
            switchAnalyticsView(nextView);
            loadDashboardAnalytics();
        });
    });
}

function getInitialAnalyticsView() {
    const params = new URLSearchParams(window.location.search);
    const view = String(params.get('view') || 'population').toLowerCase();
    if (view === 'breakdowns') return 'proficiency';
    return ['population', 'proficiency', 'trends'].includes(view) ? view : 'population';
}

function switchAnalyticsView(view) {
    if (view === 'breakdowns') view = 'proficiency';
    state.activeView = view;
    document.querySelectorAll('[data-analytics-view]').forEach((button) => {
        const isActive = button.dataset.analyticsView === view;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    document.querySelectorAll('[data-analytics-panel]').forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.analyticsPanel === view);
    });
    requestAnimationFrame(resizeVisibleCharts);
}

function resizeVisibleCharts() {
    Object.values(state.charts).forEach((chart) => {
        if (!chart || !chart.canvas || chart.canvas.offsetParent === null) return;
        chart.resize();
        chart.update();
    });
}

async function loadDashboardAnalytics() {
    const requestId = ++state.requestSerial;
    const activeFilters = state.viewFilters[state.activeView] || { school_year_id: '', subject_id: '' };
    const activePanel = document.querySelector(`[data-analytics-panel="${state.activeView}"]`);
    state.loading = true;
    activePanel?.setAttribute('aria-busy', 'true');
    try {
        const params = Object.fromEntries(Object.entries(activeFilters).filter(([, value]) => value !== ''));
        params._cb = Date.now();
        const analyticsRes = await axios.get(`${API_BASE}/dashboard/analytics.php`, { params });

        if (requestId !== state.requestSerial) return;

        if (!analyticsRes.data?.success) throw new Error(analyticsRes.data?.message || 'Failed to load dashboard analytics');

        const data = analyticsRes.data.data;
        state.viewFilters[state.activeView] = {
            school_year_id: String(data.filters?.school_year_id || ''),
            subject_id: String(data.filters?.subject_id || '')
        };
        renderFilterOptions(data.refs || {}, state.activeView);
        updateAnalytics(data);
        resizeVisibleCharts();
    } catch (error) {
        if (requestId !== state.requestSerial) return;
        console.error('Dashboard analytics failed:', error);
        updateAnalytics({
            learners: { total: 0, by_grade_level: [], by_section: [] },
            proficiency: {
                labels: PROFICIENCY_LEVELS.map((level) => level.label),
                data: PROFICIENCY_LEVELS.map(() => 0),
                by_grade_level: [],
                by_subject: []
            },
            trends: { labels: [], total_enrollment: [], change_percent: [], descriptors: [] }
        });
    } finally {
        if (requestId === state.requestSerial) {
            state.loading = false;
            activePanel?.setAttribute('aria-busy', 'false');
        }
    }
}

function optionHtml(rows, valueKey, labelKey, placeholder, selectedValue) {
    const selected = String(selectedValue || '');
    const orderedRows = valueKey === 'grade_level_id' && labelKey === 'grade_name'
        ? [...(rows || [])].sort((a, b) => Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0))
        : (rows || []);
    return `<option value="">${escapeHtml(placeholder)}</option>` + orderedRows.map((row) => {
        const value = String(row[valueKey] ?? '');
        return `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(row[labelKey] ?? '')}</option>`;
    }).join('');
}

function renderFilterOptions(refs, view = state.activeView) {
    const ids = VIEW_FILTER_IDS[view] || VIEW_FILTER_IDS.population;
    const filters = state.viewFilters[view] || { school_year_id: '', subject_id: '' };
    const schoolYear = el(ids.school_year_id);
    const subject = ids.subject_id ? el(ids.subject_id) : null;
    if (schoolYear) {
        schoolYear.innerHTML = optionHtml(refs.school_years, 'school_year_id', 'year_label', 'All school years', filters.school_year_id);
    }
    if (subject) {
        subject.innerHTML = optionHtml(refs.subjects, 'subject_id', 'subject_name', 'Overall Proficiency', filters.subject_id);
    }
}

function updateAnalytics(data) {
    const learners = data.learners || {};
    state.lastLearners = learners;
    updateLearnerBreakdownChart(learners);
    updateProficiencyChart(data.proficiency || {});
    updateProficiencyGradeChart(data.proficiency?.by_grade_level || []);
    updateProficiencySubjectChart(data.proficiency?.by_subject || []);
    updateEnrollmentTrendPanel(data.trends || {});
    renderProficiencySummary(data.proficiency || {});
    renderSubjectSummary(data.proficiency?.by_subject || []);
}

function initCharts() {
    state.charts.learnerBreakdown = makeBarChart('learnerBreakdownChart', 'Learners', '#0055A4');
    state.charts.proficiency = makeDoughnutChart('proficiencyChart');
    state.charts.proficiencyGrade = makeStackedChart('proficiencyGradeChart');
    state.charts.proficiencySubject = makeHorizontalStackedChart('proficiencySubjectChart');
    state.charts.yearlyTrend = makeLineChart('yearlyTrendChart');
}

function chartOptions(extra = {}) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                callbacks: {
                    label: (ctx) => `${ctx.dataset.label || ctx.label}: ${ctx.formattedValue}`
                }
            }
        },
        scales: { y: { beginAtZero: true } },
        ...extra
    };
}

function makeBarChart(id, label, color) {
    const ctx = el(id);
    if (!ctx) return null;
    return new Chart(ctx, {
        type: 'bar',
        data: { labels: [], datasets: [{ label, data: [], backgroundColor: color, borderRadius: 6 }] },
        options: chartOptions()
    });
}

function makeDoughnutChart(id) {
    const ctx = el(id);
    if (!ctx) return null;
    return new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: [],
            datasets: [{
                data: [],
                backgroundColor: PROFICIENCY_LEVELS.map((level) => level.color)
            }]
        },
        options: chartOptions({ plugins: { legend: { display: true, position: 'bottom' } } })
    });
}

function makeStackedChart(id) {
    const ctx = el(id);
    if (!ctx) return null;
    return new Chart(ctx, {
        type: 'bar',
        data: { labels: [], datasets: [] },
        options: chartOptions({
            plugins: { legend: { display: true, position: 'bottom' } },
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }
        })
    });
}

function makeHorizontalStackedChart(id) {
    const ctx = el(id);
    if (!ctx) return null;
    return new Chart(ctx, {
        type: 'bar',
        data: { labels: [], datasets: [] },
        options: chartOptions({
            indexAxis: 'y',
            plugins: { legend: { display: true, position: 'bottom' } },
            scales: { x: { stacked: true, beginAtZero: true }, y: { stacked: true } }
        })
    });
}

function makeLineChart(id) {
    const ctx = el(id);
    if (!ctx) return null;
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Total Enrollment',
                data: [],
                borderColor: '#0055A4',
                backgroundColor: 'rgba(0, 85, 164, 0.12)',
                borderWidth: 2,
                fill: true,
                tension: 0.28,
                pointRadius: 4
            }]
        },
        options: chartOptions({
            plugins: {
                legend: { display: true, position: 'top' },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const change = ctx.chart.$enrollmentChanges?.[ctx.dataIndex];
                            const descriptor = ctx.chart.$enrollmentDescriptors?.[ctx.dataIndex] || '';
                            const changeText = change === null || change === undefined
                                ? 'No prior comparison'
                                : `${Number(change) >= 0 ? '+' : ''}${Number(change).toFixed(2)}% vs last SY`;
                            return [
                                `Total Enrollment: ${ctx.formattedValue}`,
                                changeText,
                                descriptor
                            ];
                        }
                    }
                }
            },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
        })
    });
}

function updateLearnerBreakdownChart(learners) {
    const chart = state.charts.learnerBreakdown;
    if (!chart) return;
    const isSectionView = state.breakdownMode === 'section';
    const showSchoolYearLabels = !String(state.viewFilters.population?.school_year_id || '');
    const rows = isSectionView ? (learners.by_section || []) : (learners.by_grade_level || []);
    chart.data.labels = rows.map((row) => isSectionView
        ? `${showSchoolYearLabels && row.year_label ? `${row.year_label} · ` : ''}${row.grade_name || ''} ${row.section_name || ''}`.trim()
        : `${showSchoolYearLabels && row.year_label ? `${row.year_label} · ` : ''}${row.grade_name || ''}`.trim()
    );
    chart.data.datasets[0].data = rows.map((row) => Number(row.total || 0));
    chart.data.datasets[0].backgroundColor = isSectionView ? '#0F766E' : '#0055A4';
    chart.data.datasets[0].label = 'Learners';
    chart.canvas.setAttribute('aria-label', isSectionView ? 'Learners by Section chart' : 'Learners by Year Level chart');
    if (el('learnerBreakdownTitle')) {
        el('learnerBreakdownTitle').textContent = isSectionView ? 'Learners by Section' : 'Learners by Year Level';
    }
    chart.update();
}

function updateProficiencyChart(proficiency) {
    const chart = state.charts.proficiency;
    if (!chart) return;
    chart.data.labels = proficiency.labels || [];
    chart.data.datasets[0].data = proficiency.data || [];
    chart.data.datasets[0].backgroundColor = chart.data.labels.map((label) => {
        const level = PROFICIENCY_LEVELS.find((item) => item.label === label);
        return level?.color || '#94A3B8';
    });
    chart.update();
}

function updateProficiencyGradeChart(rows) {
    const chart = state.charts.proficiencyGrade;
    if (!chart) return;
    updateStackedProficiencyChart(chart, rows, 'grade_name');
}

function updateProficiencySubjectChart(rows) {
    const chart = state.charts.proficiencySubject;
    if (!chart) return;
    updateStackedProficiencyChart(chart, rows, 'subject_name');
}

function updateStackedProficiencyChart(chart, rows, groupKey) {
    const levels = PROFICIENCY_LEVELS.map((level) => level.label);
    const colors = PROFICIENCY_LEVELS.map((level) => level.color);
    const groupNames = [...new Set(rows.map((r) => r[groupKey]).filter(Boolean))];
    chart.data.labels = groupNames;
    chart.data.datasets = levels.map((level, index) => ({
        label: level,
        data: groupNames.map((name) => {
            const row = rows.find((item) => item[groupKey] === name && item.label === level);
            return Number(row?.total || 0);
        }),
        backgroundColor: colors[index],
        borderRadius: 4
    }));
    chart.update();
}

function proficiencyCountMap(proficiency) {
    const labels = proficiency.labels || [];
    const values = proficiency.data || [];
    return labels.reduce((map, label, index) => {
        map[label] = Number(values[index] || 0);
        return map;
    }, {});
}

function pct(value, total) {
    if (!total) return '0%';
    return `${((Number(value || 0) / total) * 100).toFixed(1)}%`;
}

function renderProficiencySummary(proficiency) {
    const body = el('proficiencySummaryBody');
    if (!body) return;
    const counts = proficiencyCountMap(proficiency);
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    if (el('proficiencySummaryCount')) {
        el('proficiencySummaryCount').textContent = `${total} learner${total === 1 ? '' : 's'}`;
    }
    if (!total) {
        body.innerHTML = `<tr><td colspan="4">${analyticsEmptyMarkup('No proficiency data found.')}</td></tr>`;
        return;
    }
    body.innerHTML = PROFICIENCY_LEVELS.map((level) => {
        const count = Number(counts[level.label] || 0);
        return `
            <tr>
                <td><span class="analytics-prof-pill" style="border-color:${level.color}; color:${level.color};">${escapeHtml(level.label)}</span></td>
                <td>${escapeHtml(level.range)}</td>
                <td>${count}</td>
                <td>${pct(count, total)}</td>
            </tr>
        `;
    }).join('');
}

function groupedSubjectRows(rows) {
    const grouped = new Map();
    rows.forEach((row) => {
        const key = row.subject_name || 'Subject';
        if (!grouped.has(key)) {
            grouped.set(key, { subject_name: key, counts: {}, total: 0 });
        }
        const item = grouped.get(key);
        const count = Number(row.total || 0);
        item.counts[row.label] = (item.counts[row.label] || 0) + count;
        item.total += count;
    });
    return [...grouped.values()].sort((a, b) => a.subject_name.localeCompare(b.subject_name));
}

function renderSubjectSummary(rows) {
    const body = el('subjectSummaryBody');
    if (!body) return;
    const subjects = groupedSubjectRows(rows);
    if (!subjects.length) {
        body.innerHTML = `<tr><td colspan="5">${analyticsEmptyMarkup('No subject data found.')}</td></tr>`;
        return;
    }
    body.innerHTML = subjects.map((subject) => {
        const proficientPlus = Number(subject.counts.Advanced || 0) + Number(subject.counts.Proficient || 0);
        const beginning = Number(subject.counts.Beginning || 0);
        const developing = Number(subject.counts.Developing || 0);
        return `
            <tr>
                <td>${escapeHtml(subject.subject_name)}</td>
                <td>${subject.total}</td>
                <td>${pct(proficientPlus, subject.total)}</td>
                <td>${beginning} (${pct(beginning, subject.total)})</td>
                <td>${developing} (${pct(developing, subject.total)})</td>
            </tr>
        `;
    }).join('');
}

function updateEnrollmentTrendPanel(trends) {
    const chart = state.charts.yearlyTrend;
    if (!chart) return;
    chart.data.labels = trends.labels || [];
    chart.data.datasets[0].data = trends.total_enrollment || [];
    chart.$enrollmentChanges = trends.change_percent || [];
    chart.$enrollmentDescriptors = trends.descriptors || [];
    chart.update();
}
