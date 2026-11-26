const ACADEMIC_STATUS_API_BASE = window.API_BASE || `${window.location.protocol}//${window.location.host}/deped_capstone2/api`;

const academicStatusState = {
    data: null,
    selectedPeriodId: 0,
};

const academicStatusRequestedRiskAssessmentId = Number(
    new URLSearchParams(window.location.search).get('risk_assessment_id') || 0
);

function academicStatusEscape(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function academicStatusFormatMonthRange(startValue, endValue) {
    const startRaw = String(startValue || '').slice(0, 10);
    const endRaw = String(endValue || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startRaw) || !/^\d{4}-\d{2}-\d{2}$/.test(endRaw)) {
        return 'Dates not set';
    }

    const start = new Date(`${startRaw}T00:00:00`);
    const end = new Date(`${endRaw}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 'Dates not set';

    const startMonth = start.toLocaleDateString('en-PH', { month: 'short' });
    const endMonth = end.toLocaleDateString('en-PH', { month: 'short' });
    const startYear = start.getFullYear();
    const endYear = end.getFullYear();
    if (startMonth === endMonth && startYear === endYear) return `${startMonth} ${startYear}`;
    return startYear === endYear
        ? `${startMonth}–${endMonth} ${endYear}`
        : `${startMonth} ${startYear}–${endMonth} ${endYear}`;
}

function academicStatusRiskClass(name) {
    const value = String(name || '').toLowerCase();
    if (value.includes('high') || value.includes('critical')) return 'is-high';
    if (value.includes('medium') || value.includes('moderate')) return 'is-medium';
    if (value.includes('low')) return 'is-low';
    return 'is-not-assessed';
}

function academicStatusDisplayName(name) {
    const value = String(name || '').toLowerCase();
    if (value.includes('high') || value.includes('critical')) return 'High Risk of Failing';
    if (value.includes('medium') || value.includes('moderate')) return 'Medium Risk of Failing';
    if (value.includes('low')) return 'Stable Record';
    return String(name || 'Not assessed');
}

function academicStatusSelectedPeriod() {
    const records = Array.isArray(academicStatusState.data?.periods)
        ? academicStatusState.data.periods
        : [];
    return records.find((period) => Number(period.grading_period_id) === academicStatusState.selectedPeriodId) || null;
}

function renderAcademicStatusPeriods() {
    const container = document.getElementById('academicStatusPeriods');
    const periods = Array.isArray(academicStatusState.data?.periods)
        ? academicStatusState.data.periods
        : [];
    if (!container) return;

    container.innerHTML = '';
    periods.forEach((period) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'academic-status-period-button';
        button.dataset.periodId = String(period.grading_period_id);
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', 'false');
        button.innerHTML = `${academicStatusEscape(period.period_name || 'Term')}<small>${academicStatusEscape(academicStatusFormatMonthRange(period.date_start, period.date_end))}</small>`;
        button.addEventListener('click', () => {
            academicStatusState.selectedPeriodId = Number(period.grading_period_id);
            renderAcademicStatusPeriods();
            renderAcademicStatusPeriod();
        });
        container.appendChild(button);
    });
}

function renderAcademicStatusPeriod() {
    const period = academicStatusSelectedPeriod();
    const periodLabel = document.getElementById('academicStatusPeriodLabel');
    const badge = document.getElementById('academicStatusBadge');
    const indicators = document.getElementById('academicStatusIndicators');
    if (!period || !periodLabel || !badge || !indicators) return;

    const riskName = String(period.risk_name || 'Not assessed');
    const riskClass = academicStatusRiskClass(riskName);
    const periodIndicators = Array.isArray(period.indicators) ? period.indicators : [];

    document.querySelectorAll('.academic-status-period-button').forEach((button) => {
        const isActive = Number(button.dataset.periodId) === academicStatusState.selectedPeriodId;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    periodLabel.textContent = period.period_name || 'Term';
    badge.textContent = academicStatusDisplayName(riskName);
    badge.className = `academic-status-badge ${riskClass}`;

    indicators.innerHTML = periodIndicators.length
        ? periodIndicators.map((item) => {
            const indicator = academicStatusHumanizeIndicator(item);
            return `
            <li class="academic-status-indicator">
                <strong>${academicStatusEscape(indicator.label)}</strong>
                <span>${academicStatusEscape(indicator.details)}</span>
            </li>
            `;
        }).join('')
        : `<li class="academic-status-empty">${period.status === 'assessed'
            ? 'No active risk indicators for this period.'
            : 'This period has not been assessed yet.'}</li>`;
}

function academicStatusHumanizeIndicator(item = {}) {
    const type = String(item.indicator_type || '').trim();
    const key = type.toLowerCase();
    const details = String(item.details || '').trim();
    const labels = {
        'chronic absence': 'Frequent absences',
        'frequent absence': 'Frequent absences',
        'attendance rate below threshold': 'Attendance needs attention',
        'repeated tardiness': 'Repeated late arrivals',
        'no encoded grades': 'Grades are not posted yet',
        'incomplete grades': 'Some grades are still missing',
        '2 or more failing subjects': 'Several subjects need support',
        '1 failing subject': 'One subject needs support',
        'lowest grade below passing': 'A grade is below the passing mark',
        'period average below passing': 'The period average needs support',
        'low general average': 'The overall average needs support',
        'failed subject final grade': 'A final subject grade needs support',
        'sudden grade drop': 'Recent grades have gone down',
    };
    const label = labels[key] || type || 'Status indicator';

    if (/absence rate:/i.test(details)) {
        const rate = details.match(/Absence rate:\s*([\d.]+)%/i)?.[1];
        return { label, details: rate ? `You were absent on about ${rate}% of the recorded school days in this period.` : 'Your attendance needs attention during this period.' };
    }
    if (/late\/cutting instances:/i.test(details)) {
        const count = details.match(/Late\/Cutting instances:\s*(\d+)/i)?.[1];
        return { label, details: count ? `There were ${count} late or cutting-class records in this period.` : 'There were several late or cutting-class records in this period.' };
    }
    if (/^Encoded \d+\/\d+ subjects$/i.test(details)) {
        const counts = details.match(/Encoded (\d+)\/(\d+) subjects/i);
        return { label, details: counts ? `Grades are available for ${counts[1]} of ${counts[2]} subjects.` : 'Some subject grades are still missing.' };
    }
    if (/^Failing subjects?:/i.test(details)) {
        return { label, details: details.replace(/^Failing subjects?:\s*/i, 'Subjects needing support: ') };
    }
    if (/^Final failing subject\(s\):/i.test(details)) {
        return { label, details: details.replace(/^Final failing subject\(s\):\s*/i, 'Subjects needing support: ') };
    }
    if (key === 'sudden grade drop') {
        const periods = details.match(/declined for (\d+) consecutive grading periods?/i)?.[1];
        if (periods) return { label, details: `Your grades have gone down across ${periods} consecutive grading periods.` };
        return { label, details: 'Your grades have gone down compared with the previous period.' };
    }
    if (details) return { label, details };
    return { label, details: 'This area may need additional attention during the period.' };
}

function renderAcademicStatus(data) {
    academicStatusState.data = data || {};
    const periods = Array.isArray(data?.periods) ? data.periods : [];
    const app = document.getElementById('academicStatusApp');
    const loading = document.getElementById('academicStatusLoading');

    if (loading) loading.hidden = true;
    if (app) app.hidden = false;

    if (!periods.length) {
        const periodContainer = document.getElementById('academicStatusPeriods');
        const panel = document.getElementById('academicStatusPanel');
        if (periodContainer) periodContainer.innerHTML = '';
        if (panel) panel.innerHTML = `<div class="academic-status-message">${academicStatusEscape(data?.message || 'No term status is available yet.')}</div>`;
        return;
    }

    const requested = academicStatusRequestedRiskAssessmentId > 0
        ? periods.find((period) => Number(period.risk_assessment_id) === academicStatusRequestedRiskAssessmentId)
        : null;
    const current = requested || periods.find((period) => period.is_current) || periods[periods.length - 1];
    academicStatusState.selectedPeriodId = Number(current.grading_period_id);
    renderAcademicStatusPeriods();
    renderAcademicStatusPeriod();
}

async function loadAcademicStatus() {
    const loading = document.getElementById('academicStatusLoading');
    try {
        const response = await axios.get(`${ACADEMIC_STATUS_API_BASE}/risk_assessments/risk_assessments.php`, {
            params: { operation: 'getMyAcademicStatus' }
        });
        const payload = response.data || {};
        if (!payload.success) throw new Error(payload.message || 'Unable to load academic status.');
        renderAcademicStatus(payload.data || {});
    } catch (error) {
        if (loading) {
            loading.innerHTML = `<i class="fas fa-circle-exclamation" aria-hidden="true"></i> ${academicStatusEscape(error?.response?.data?.message || error.message || 'Unable to load academic status.')}`;
        }
    }
}

document.addEventListener('DOMContentLoaded', loadAcademicStatus);
