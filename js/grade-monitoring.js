const GM_API = `${window.API_BASE}/grade_monitoring/grade_monitoring.php`;
const gmUrlParams = new URLSearchParams(window.location.search);
const gmInitialContext = {
    schoolYearId: Number(gmUrlParams.get('school_year_id') || 0),
    gradeLevelId: Number(gmUrlParams.get('grade_level_id') || 0),
    periodId: Number(gmUrlParams.get('grading_period_id') || 0),
    teacherId: Number(gmUrlParams.get('teacher_id') || 0),
    sectionId: Number(gmUrlParams.get('section_id') || 0),
    status: String(gmUrlParams.get('status') || '').trim(),
    search: String(gmUrlParams.get('search') || '').trim(),
};

const gmState = {
    schoolYearId: gmInitialContext.schoolYearId,
    gradeLevelId: gmInitialContext.gradeLevelId,
    periodId: gmInitialContext.periodId,
    teacherId: gmInitialContext.teacherId,
    sectionId: gmInitialContext.sectionId,
    rows: [],
    auditRows: [],
    auditLimit: 10,
    auditOffset: 0,
    auditHasMore: false,
    auditContext: null,
    periods: [],
    gradeLevels: [],
    sections: [],
    schoolYears: []
};

document.addEventListener('DOMContentLoaded', () => {
    if (gmInitialContext.status && gmEl('gmStatus')) gmEl('gmStatus').value = gmInitialContext.status;
    if (gmInitialContext.search && gmEl('gmSearch')) gmEl('gmSearch').value = gmInitialContext.search;
    wireGradeMonitoring();
    loadGradeMonitoring();
});

function gmEl(id) {
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

function wireGradeMonitoring() {
    gmEl('gmPeriodToggle')?.addEventListener('click', () => togglePeriodMenu());
    gmEl('gmAuditBtn')?.addEventListener('click', () => toggleAuditPeriodMenu());
    gmEl('gmReloadAuditBtn')?.addEventListener('click', () => loadAuditTrail({ reset: true }));
    gmEl('gmAuditApplyDatesBtn')?.addEventListener('click', () => loadAuditTrail({ reset: true }));
    gmEl('gmAuditSeeMoreBtn')?.addEventListener('click', () => loadAuditTrail({ append: true }));
    gmEl('gmBackToMonitorBtn')?.addEventListener('click', () => showMonitoringView());

    gmEl('gmSchoolYear')?.addEventListener('change', () => {
        gmState.gradeLevelId = 0;
        gmState.periodId = 0;
        gmState.teacherId = 0;
        gmState.sectionId = 0;
        if (gmEl('gmGradeLevel')) gmEl('gmGradeLevel').value = '';
        if (gmEl('gmSection')) gmEl('gmSection').value = '';
        loadGradeMonitoring();
    });

    gmEl('gmGradeLevel')?.addEventListener('change', () => {
        gmState.gradeLevelId = Number(gmEl('gmGradeLevel')?.value || 0);
        gmState.sectionId = 0;
        gmState.teacherId = 0;
        if (gmEl('gmSection')) gmEl('gmSection').value = '';
        loadGradeMonitoring();
    });

    ['gmSection', 'gmStatus'].forEach((id) => {
        gmEl(id)?.addEventListener('change', () => loadGradeMonitoring());
    });

    let searchTimer = null;
    gmEl('gmSearch')?.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => loadGradeMonitoring(), 350);
    });

    document.addEventListener('click', (event) => {
        const closeBtn = event.target.closest('[data-gm-close]');
        if (closeBtn) {
            closeModal(closeBtn.dataset.gmClose);
            return;
        }

        const monitorRow = event.target.closest('[data-gm-monitor-row]');
        if (monitorRow) {
            openMissingModal(Number(monitorRow.dataset.gmMonitorRow));
            return;
        }

        const auditPeriodBtn = event.target.closest('[data-gm-audit-period-id]');
        if (auditPeriodBtn) {
            closeAuditPeriodMenu();
            closePeriodMenu();
            openAuditWizard(Number(auditPeriodBtn.dataset.gmAuditPeriodId || 0));
            return;
        }

        const periodBtn = event.target.closest('[data-gm-period-id]');
        if (periodBtn) {
            closeAuditPeriodMenu();
            closePeriodMenu();
            gmState.periodId = Number(periodBtn.dataset.gmPeriodId || 0);
            gmState.auditContext = null;
            loadGradeMonitoring();
            return;
        }

        if (!event.target.closest('.gm-audit-toggle')) {
            closeAuditPeriodMenu();
        }
        if (!event.target.closest('.gm-period-picker')) {
            closePeriodMenu();
        }
    });

    document.addEventListener('keydown', (event) => {
        const monitorRow = event.target.closest('[data-gm-monitor-row]');
        if (monitorRow && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            openMissingModal(Number(monitorRow.dataset.gmMonitorRow));
            return;
        }
        if (event.key === 'Escape') {
            closeAuditPeriodMenu();
            closePeriodMenu();
        }
    });

    document.querySelectorAll('.gm-modal').forEach((modal) => {
        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeModal(modal.id);
        });
    });
}

function getParams() {
    const params = { operation: 'getGradeMonitoring' };
    const sy = Number(gmEl('gmSchoolYear')?.value || gmState.schoolYearId || 0);
    const gradeLevel = Number(gmEl('gmGradeLevel')?.value || gmState.gradeLevelId || 0);
    const gp = Number(gmState.periodId || 0);
    const section = Number(gmEl('gmSection')?.value || gmState.sectionId || 0);
    const teacher = Number(gmState.teacherId || 0);
    const status = gmEl('gmStatus')?.value || '';
    const search = gmEl('gmSearch')?.value?.trim() || '';

    if (sy > 0) params.school_year_id = sy;
    if (gradeLevel > 0) params.grade_level_id = gradeLevel;
    if (gp > 0) params.grading_period_id = gp;
    if (teacher > 0) params.teacher_id = teacher;
    if (section > 0) params.section_id = section;
    if (status) params.status = status;
    if (search) params.search = search;
    return params;
}

async function loadGradeMonitoring() {
    setTableLoading();
    try {
        const res = await axios.get(GM_API, { params: getParams() });
        const data = res.data || {};
        if (!data.success) throw new Error(data.message || 'Unable to load monitoring data.');

        gmState.schoolYearId = Number(data.school_year_id || 0);
        gmState.gradeLevelId = Number(data.grade_level_id || 0);
        gmState.periodId = Number(data.grading_period_id || 0);
        gmState.schoolYears = Array.isArray(data.school_years) ? data.school_years : [];
        gmState.periods = Array.isArray(data.periods) ? data.periods : [];
        gmState.gradeLevels = Array.isArray(data.grade_levels) ? data.grade_levels : [];
        gmState.sections = Array.isArray(data.sections) ? data.sections : [];
        gmState.rows = Array.isArray(data.rows) ? data.rows : [];

        renderSchoolYearOptions();
        const periodStillAvailable = gmState.periods.some((period) => Number(period.grading_period_id) === Number(gmState.periodId));
        if ((!periodStillAvailable || gmState.periodId <= 0) && gmState.periods.length) {
            gmState.periodId = Number(gmState.periods[0].grading_period_id || 0);
            await loadGradeMonitoring();
            return;
        }
        renderGradeLevelOptions();
        renderPeriodButtons();
        renderSectionOptions();
        renderRows(gmState.rows);
    } catch (err) {
        const msg = err?.response?.data?.message || err.message || 'Unable to load monitoring data.';
        gmEl('gmTableBody').innerHTML = `<tr><td colspan="2" class="text-center">${escapeHtml(msg)}</td></tr>`;
    }
}

function renderSchoolYearOptions() {
    const select = gmEl('gmSchoolYear');
    if (!select) return;
    const current = String(select.value || gmState.schoolYearId || '');
    select.innerHTML = gmState.schoolYears.map((sy) => {
        const id = String(sy.school_year_id);
        const active = Number(sy.is_active) === 1 ? ' (Active)' : '';
        return `<option value="${escapeHtml(id)}">${escapeHtml(sy.year_label || id)}${active}</option>`;
    }).join('');
    select.value = current && gmState.schoolYears.some((sy) => String(sy.school_year_id) === current)
        ? current
        : String(gmState.schoolYearId || '');
}

function renderGradeLevelOptions() {
    const select = gmEl('gmGradeLevel');
    if (!select) return;
    const current = String(gmState.gradeLevelId || select.value || '');
    const orderedGradeLevels = [...gmState.gradeLevels].sort((a, b) =>
        Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0)
    );
    select.innerHTML = '<option value="">All year levels</option>' + orderedGradeLevels.map((grade) => {
        const id = String(grade.grade_level_id);
        return `<option value="${escapeHtml(id)}">${escapeHtml(grade.grade_name || id)}</option>`;
    }).join('');
    select.value = current && orderedGradeLevels.some((grade) => String(grade.grade_level_id) === current)
        ? current
        : '';
}

function renderPeriodButtons() {
    const container = gmEl('gmPeriodButtons');
    const toggle = gmEl('gmPeriodToggle');
    const currentLabel = gmEl('gmPeriodCurrent');
    if (!container) return;
    if (!gmState.periods.length) {
        container.innerHTML = '<div class="gm-period-options-empty">No terms / periods configured.</div>';
        container.hidden = true;
        if (toggle) toggle.disabled = true;
        if (currentLabel) currentLabel.textContent = 'No periods available';
        renderAuditPeriodMenu();
        return;
    }

    const selectedIndex = gmState.periods.findIndex((period) => Number(period.grading_period_id || 0) === Number(gmState.periodId || 0));
    const selectedPeriod = gmState.periods[selectedIndex >= 0 ? selectedIndex : 0];
    const selectedLabel = getPeriodLabel(selectedPeriod, selectedIndex >= 0 ? selectedIndex : 0);
    const selectedStatus = selectedPeriod?.status ? ` · ${selectedPeriod.status}` : '';
    if (currentLabel) currentLabel.textContent = `${selectedLabel}${selectedStatus}`;
    if (toggle) {
        toggle.disabled = false;
        toggle.setAttribute('aria-expanded', 'false');
    }
    container.hidden = true;
    container.innerHTML = gmState.periods.map((period) => {
        const id = Number(period.grading_period_id || 0);
        const label = getPeriodLabel(period, gmState.periods.indexOf(period));
        const status = period.status ? ` · ${period.status}` : '';
        const active = id === Number(gmState.periodId || 0);
        return `
            <button class="gm-period-tab${active ? ' active' : ''}" type="button" role="option" aria-selected="${active}" data-gm-period-id="${id}">
                <span>${escapeHtml(label)}</span><span class="gm-period-status">${escapeHtml(status)}</span>
            </button>
        `;
    }).join('');
    renderAuditPeriodMenu();
    updateAuditHeading();
}

function getPeriodLabel(period, index = 0) {
    return String(period?.period_name || '').trim() || `Term ${index + 1}`;
}

function renderAuditPeriodMenu() {
    const menu = gmEl('gmAuditMenu');
    if (!menu) return;
    if (!gmState.periods.length) {
        menu.innerHTML = '<div class="gm-audit-menu-empty">No terms or quarters available.</div>';
        return;
    }

    menu.innerHTML = gmState.periods.map((period, index) => {
        const id = Number(period.grading_period_id || 0);
        const active = id === Number(gmState.periodId || 0);
        return `
            <button class="gm-audit-option${active ? ' active' : ''}" type="button" role="menuitemradio" aria-checked="${active}" data-gm-audit-period-id="${id}">
                <span>${escapeHtml(getPeriodLabel(period, index))}</span>
                ${active ? '<i class="fas fa-check" aria-hidden="true"></i>' : ''}
            </button>
        `;
    }).join('');
}

function toggleAuditPeriodMenu() {
    const menu = gmEl('gmAuditMenu');
    const button = gmEl('gmAuditBtn');
    if (!menu || !button) return;
    closePeriodMenu();
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    button.setAttribute('aria-expanded', String(willOpen));
}

function closeAuditPeriodMenu() {
    const menu = gmEl('gmAuditMenu');
    const button = gmEl('gmAuditBtn');
    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
}

function togglePeriodMenu() {
    const menu = gmEl('gmPeriodButtons');
    const button = gmEl('gmPeriodToggle');
    if (!menu || !button || button.disabled) return;
    closeAuditPeriodMenu();
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    button.setAttribute('aria-expanded', String(willOpen));
}

function closePeriodMenu() {
    const menu = gmEl('gmPeriodButtons');
    const button = gmEl('gmPeriodToggle');
    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
}

function updateAuditHeading() {
    const title = gmEl('gmAuditTitle');
    if (!title) return;
    const periodId = Number(gmState.auditContext?.gradingPeriodId || gmState.periodId || 0);
    const periodIndex = gmState.periods.findIndex((period) => Number(period.grading_period_id || 0) === periodId);
    const period = periodIndex >= 0 ? gmState.periods[periodIndex] : null;
    title.textContent = period
        ? `Grade Audit Report · ${getPeriodLabel(period, periodIndex)}`
        : 'Grade Audit Report';
}

function renderSectionOptions() {
    const select = gmEl('gmSection');
    if (!select) return;
    const current = String(select.value || '');
    select.innerHTML = '<option value="">All sections</option>' + gmState.sections.map((section) => {
        const id = String(section.section_id);
        const label = [section.grade_name, section.section_name].filter(Boolean).join(' - ');
        return `<option value="${escapeHtml(id)}">${escapeHtml(label || id)}</option>`;
    }).join('');
    select.value = current && gmState.sections.some((s) => String(s.section_id) === current)
        ? current
        : (gmState.sectionId && gmState.sections.some((s) => Number(s.section_id) === Number(gmState.sectionId))
            ? String(gmState.sectionId)
            : '');
}

function setTableLoading() {
    gmEl('gmTableBody').innerHTML = '<tr><td colspan="2" class="text-center"><i class="fas fa-spinner fa-spin"></i> Loading monitoring data...</td></tr>';
}

function gradeMonitoringEmptyMarkup() {
    return `<div class="context-empty-state" role="status">
        <video class="mp4-surface-blend context-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true">
            <source src="../assets/icons/search.mp4" type="video/mp4">
        </video>
        <span>No grade input monitoring records found.</span>
    </div>`;
}

function renderRows(rows) {
    const tbody = gmEl('gmTableBody');
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="2" class="text-center">${gradeMonitoringEmptyMarkup()}</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map((row, index) => {
        const encoded = Number(row.encoded_count || 0);
        const expected = Number(row.expected_count || 0);

        return `
            <tr class="gm-monitor-row" data-gm-monitor-row="${index}" tabindex="0" role="button" aria-label="View missing learners for ${escapeHtml(row.teacher_name || 'Unassigned')}">
                <td class="gm-teacher-cell">
                    <strong>${escapeHtml(row.teacher_name || 'Unassigned')}</strong>
                    <span class="gm-row-meta">${escapeHtml(row.section_name || 'Section')}</span>
                </td>
                <td>
                    <strong>${encoded.toLocaleString()} out of ${expected.toLocaleString()} students</strong>
                </td>
            </tr>
        `;
    }).join('');
}

function openModal(id) {
    const modal = gmEl(id);
    if (!modal) return;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
}

function closeModal(id) {
    const modal = gmEl(id);
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
}

function showMonitoringView() {
    gmEl('gmMonitorView')?.removeAttribute('hidden');
    gmEl('gmAuditView')?.setAttribute('hidden', '');
    gmState.auditContext = null;
}

function showAuditWizardView() {
    gmEl('gmMonitorView')?.setAttribute('hidden', '');
    gmEl('gmAuditView')?.removeAttribute('hidden');
}

function openMissingModal(index) {
    const row = gmState.rows[index];
    if (!row) return;
    const learners = Array.isArray(row.missing_learners) ? row.missing_learners : [];

    gmEl('gmMissingTitle').textContent = `${learners.length} Incomplete Learner${learners.length === 1 ? '' : 's'}`;
    gmEl('gmMissingContext').textContent = '';
    gmEl('gmMissingBody').innerHTML = learners.length
        ? learners.map((learner) => {
            const name = typeof learner === 'string' ? learner : learner.name;
            const missingSubjects = typeof learner === 'string'
                ? []
                : (Array.isArray(learner.missing_subjects) ? learner.missing_subjects : []);
            return `
            <tr>
                <td data-label="Learner">${escapeHtml(formatLearnerNameForTable(name))}</td>
                <td data-label="Missing subjects">${missingSubjects.length ? escapeHtml(missingSubjects.join(', ')) : '<span class="gm-muted">Not specified</span>'}</td>
            </tr>
        `;
        }).join('')
        : '<tr><td colspan="2" class="text-center">No incomplete learners for this section and period.</td></tr>';
    openModal('gmMissingModal');
}

async function openAuditWizard(gradingPeriodId = 0) {
    gmState.auditContext = {
        schoolYearId: Number(gmEl('gmSchoolYear')?.value || gmState.schoolYearId || 0),
        gradeLevelId: Number(gmEl('gmGradeLevel')?.value || gmState.gradeLevelId || 0),
        gradingPeriodId: Number(gradingPeriodId || gmState.periodId || 0),
        sectionId: Number(gmEl('gmSection')?.value || 0)
    };
    updateAuditHeading();
    showAuditWizardView();
    await loadAuditTrail({ reset: true });
}

async function loadAuditTrail(options = {}) {
    const append = Boolean(options.append);
    if (options.reset || !append) {
        gmState.auditOffset = 0;
        gmState.auditRows = [];
    }
    if (!append) {
        gmEl('gmAuditBody').innerHTML = '<tr><td colspan="5" class="text-center"><i class="fas fa-spinner fa-spin"></i> Loading audit trail...</td></tr>';
    }
    setAuditSeeMoreLoading(append);
    try {
        const params = {
            operation: 'getGradeMonitoringAudit',
            school_year_id: Number(gmState.auditContext?.schoolYearId || gmEl('gmSchoolYear')?.value || gmState.schoolYearId || 0),
            limit: gmState.auditLimit,
            offset: gmState.auditOffset
        };
        const gp = Number(gmState.auditContext?.gradingPeriodId || gmState.periodId || 0);
        const gradeLevel = Number(gmState.auditContext?.gradeLevelId || gmEl('gmGradeLevel')?.value || gmState.gradeLevelId || 0);
        const section = Number(gmState.auditContext?.sectionId || gmEl('gmSection')?.value || 0);
        const dateFrom = gmEl('gmAuditDateFrom')?.value || '';
        const dateTo = gmEl('gmAuditDateTo')?.value || '';
        if (gp > 0) params.grading_period_id = gp;
        if (gradeLevel > 0) params.grade_level_id = gradeLevel;
        if (section > 0) params.section_id = section;
        if (dateFrom) params.date_from = dateFrom;
        if (dateTo) params.date_to = dateTo;

        const res = await axios.get(GM_API, { params });
        const rows = Array.isArray(res.data?.rows) ? res.data.rows : [];
        gmState.auditRows = append ? gmState.auditRows.concat(rows) : rows;
        gmState.auditOffset = gmState.auditRows.length;
        gmState.auditHasMore = rows.length > 0 && Boolean(res.data?.has_more);
        renderAuditTrail(gmState.auditRows);
    } catch {
        gmEl('gmAuditBody').innerHTML = '<tr><td colspan="5" class="text-center">Audit trail could not be loaded.</td></tr>';
        gmState.auditHasMore = false;
    } finally {
        renderAuditSeeMore();
    }
}

function renderAuditTrail(rows) {
    const list = gmEl('gmAuditBody');
    if (!rows.length) {
        list.innerHTML = '<tr><td colspan="5" class="text-center">No recent grade input activity for this filter.</td></tr>';
        return;
    }

    list.innerHTML = rows.map((row) => {
        const time = row.audit_time || row.updated_at || row.encoded_at;
        const context = [
            row.subject_name || 'Subject',
            row.section_name || 'Section'
        ].join(' · ');
        const changeSummary = summarizeGradeAudit(row);
        const actor = row.audit_user_name || row.encoded_by_name || row.teacher_name || 'Unknown user';
        return `
            <tr>
                <td data-label="Recorded by"><strong class="gm-recorded-by">${escapeHtml(actor)}</strong></td>
                <td data-label="Report entry">
                    <strong>${escapeHtml(changeSummary)}</strong>
                </td>
                <td data-label="Learner">${escapeHtml(formatLearnerNameForTable(row.learner_name || 'Learner'))}</td>
                <td data-label="Class context">${escapeHtml(context)}</td>
                <td data-label="Date / time"><time class="gm-audit-time" datetime="${escapeHtml(String(time || ''))}">${escapeHtml(formatRelativeAuditTime(time))}</time></td>
            </tr>
        `;
    }).join('');
}

function formatRelativeAuditTime(value) {
    if (!value) return 'No date';
    const date = new Date(String(value).replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return String(value);

    const delta = Math.max(0, Date.now() - date.getTime());
    const minutes = Math.floor(delta / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;

    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;

    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;

    const years = Math.floor(days / 365);
    return `${years} year${years === 1 ? '' : 's'} ago`;
}

function setAuditSeeMoreLoading(isLoading) {
    const btn = gmEl('gmAuditSeeMoreBtn');
    if (!btn) return;
    if (isLoading) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
    }
}

function renderAuditSeeMore() {
    const btn = gmEl('gmAuditSeeMoreBtn');
    if (!btn) return;
    btn.hidden = !gmState.auditHasMore;
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-chevron-down"></i> See More';
}

function parseAuditJson(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
}

function normalizeGradeValue(value) {
    if (value === null || value === undefined || value === '') return 'blank';
    const num = Number(value);
    return Number.isFinite(num) ? num.toString() : String(value);
}

function summarizeGradeAudit(row) {
    const action = String(row.audit_action || '').toUpperCase();
    const oldValues = parseAuditJson(row.old_values);
    const newValues = parseAuditJson(row.new_values);
    const oldGrade = oldValues.quarterly_grade ?? oldValues.grade ?? oldValues.grade_value;
    const newGrade = newValues.quarterly_grade ?? newValues.grade ?? newValues.grade_value ?? row.quarterly_grade;

    if (action === 'UPDATE' && oldGrade !== undefined && newGrade !== undefined && String(oldGrade) !== String(newGrade)) {
        return `Updated grade from ${normalizeGradeValue(oldGrade)} to ${normalizeGradeValue(newGrade)}`;
    }
    if (action === 'INSERT' && newGrade !== undefined) {
        return `Added grade ${normalizeGradeValue(newGrade)}`;
    }
    if (action === 'DELETE' && oldGrade !== undefined) {
        return `Removed grade ${normalizeGradeValue(oldGrade)}`;
    }
    if (newGrade !== undefined && newGrade !== null) {
        return `Updated grade to ${normalizeGradeValue(newGrade)}`;
    }
    return 'Grade updated';
}
