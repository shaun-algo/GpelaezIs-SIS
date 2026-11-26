const API_BASE_URL = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;

function isLearnerRole() {
    const rname = String(window.CURRENT_ROLE_NAME || '').toLowerCase();
    const rid = Number(window.CURRENT_ROLE_ID || 0);
    return rname.includes('learner') || rname.includes('student') || rid === 10;
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

const gradesApi = {
    list: async (params = {}) => axios.get(`${API_BASE_URL}/grades/grades.php`, { params: { ...params, operation: isLearnerRole() ? 'getMyGrades' : 'getAllGrades' } }).then(r => r.data),
    create: async (data) => axios.post(`${API_BASE_URL}/grades/grades.php?operation=createGrade`, data).then(r => r.data),
    update: async (id, data) => axios.post(`${API_BASE_URL}/grades/grades.php?operation=updateGrade`, { ...data, grade_id: id }).then(r => r.data),
    remove: async (id) => axios.post(`${API_BASE_URL}/grades/grades.php?operation=deleteGrade`, { grade_id: id }).then(r => r.data)
};

const enrollmentsApi = {
    list: async () => {
        const enrollments = await axios.get(`${API_BASE_URL}/enrollments/enrollments.php`, { params: { operation: 'getAllEnrollments' } }).then(r => r.data);
        return enrollments.map(e => ({ ...e, display_name: `${e.learner_name} - ${e.year_label}` }));
    }
};

const classOfferingsApi = {
    list: async () => {
        const offerings = await axios.get(`${API_BASE_URL}/class_offerings/class_offerings.php`, { params: { operation: 'getAllClassOfferings' } }).then(r => r.data);
        return filterGradeEncodingOfferings(offerings)
            .map(o => ({ ...o, display_name: `${o.subject_name} - ${o.section_name}` }));
    }
};

const gradingPeriodsApi = {
    list: async () => axios.get(`${API_BASE_URL}/grading_periods/grading_periods.php`, { params: { operation: 'getAllGradingPeriods' } }).then(r => r.data)
};

const schoolYearsApi = {
    list: async () => axios.get(`${API_BASE_URL}/school_years/school_years.php`, { params: { operation: 'getAllSchoolYears' } }).then(r => r.data)
};

function buildFields() {
    if (isLearnerRole()) return [];
    return [
        {
            key: 'enrollment_id',
            label: 'Enrollment',
            type: 'select',
            required: true,
            valueKey: 'enrollment_id',
            labelKey: 'display_name',
            loadOptions: enrollmentsApi.list
        },
        {
            key: 'class_id',
            label: 'Class Offering',
            type: 'select',
            required: true,
            valueKey: 'class_id',
            labelKey: 'display_name',
            loadOptions: classOfferingsApi.list
        },
        {
            key: 'grading_period_id',
            label: 'Grading Period',
            type: 'select',
            required: true,
            valueKey: 'grading_period_id',
            labelKey: 'period_name',
            loadOptions: gradingPeriodsApi.list
        },
        { key: 'quarterly_grade', label: 'Period Grade', type: 'number', step: '0.01', min: 60, max: 100, required: false }
    ];
}

// ═══════════════════════════════════════════════════════════════
// LEARNER GRADES VIEW
// ═══════════════════════════════════════════════════════════════
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function normalizeSubject(name) {
    return String(name || '').toLowerCase().trim();
}

function getMapehSubjectRole(subject) {
    const s = normalizeSubject(subject);
    if (!s) return { type: 'other', key: '' };
    if (s.includes('mapeh') && !s.includes('component')) return { type: 'parent', key: 'mapeh' };
    if (/\bmusic\s*(and|&)\s*arts?\b/.test(s)) return { type: 'component', key: 'music_arts' };
    if (/\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/.test(s)) return { type: 'component', key: 'pe_health' };
    if (/\bmusic\b|\bmusika\b/.test(s)) return { type: 'component', key: 'music' };
    if (/\barts?\b|\bsining\b/.test(s)) return { type: 'component', key: 'arts' };
    if (/\bpe\b|\bphysical education\b|\bpagpapalakas\b/.test(s)) return { type: 'component', key: 'pe' };
    if (/\bhealth\b|\bkalusugan\b/.test(s)) return { type: 'component', key: 'health' };
    return { type: 'other', key: '' };
}

function isMapehComponent(subject) {
    return getMapehSubjectRole(subject).type === 'component';
}

function isMapehParent(subject) {
    return getMapehSubjectRole(subject).type === 'parent';
}

function filterGradeEncodingOfferings(offerings) {
    const rows = Array.isArray(offerings) ? offerings : [];
    const groups = new Map();

    rows.forEach((row) => {
        if (Number(row.is_deleted || 0) === 1) return;
        const role = getMapehSubjectRole(row.subject_name);
        if (role.type === 'other') return;
        const contextKey = `${Number(row.section_id || 0)}-${Number(row.school_year_id || 0)}`;
        if (!groups.has(contextKey)) {
            groups.set(contextKey, { parent: [], byKey: new Map() });
        }
        const group = groups.get(contextKey);
        if (role.type === 'parent') {
            group.parent.push(row);
            return;
        }
        if (!group.byKey.has(role.key)) group.byKey.set(role.key, []);
        group.byKey.get(role.key).push(row);
    });

    const allowedMapehClassIds = new Set();
    groups.forEach((group) => {
        const byKey = group.byKey;
        const hasGrouped = byKey.has('music_arts') && byKey.has('pe_health');
        const hasClassic = byKey.has('music') && byKey.has('arts') && byKey.has('pe') && byKey.has('health');

        const keepKeys = hasClassic
            ? ['music', 'arts', 'pe', 'health']
            : (hasGrouped ? ['music_arts', 'pe_health'] : []);

        if (keepKeys.length) {
            keepKeys.forEach((key) => {
                (byKey.get(key) || []).forEach((row) => allowedMapehClassIds.add(Number(row.class_id || 0)));
            });
            return;
        }

        group.parent.forEach((row) => allowedMapehClassIds.add(Number(row.class_id || 0)));
    });

    return rows.filter((row) => {
        if (Number(row.is_deleted || 0) === 1) return false;
        const role = getMapehSubjectRole(row.subject_name);
        if (role.type === 'other') return true;
        return allowedMapehClassIds.has(Number(row.class_id || 0));
    });
}

function computeMapehPeriodValues(componentMap, syPeriods) {
    return syPeriods.map(p => {
        const vals = [];
        componentMap.forEach((gradesByPeriod, subject) => {
            const v = toNum(gradesByPeriod[p.period_no]);
            if (v !== null) vals.push(v);
        });
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    });
}

function computeFinal(periodValues) {
    const valid = periodValues.filter(v => v !== null);
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

function formatGrade(value) {
    const n = toNum(value);
    if (n === null) return '—';
    return n % 1 === 0 ? String(n) : n.toFixed(2);
}

function getGradeToneClass(value) {
    const n = toNum(value);
    if (n === null) return '';
    return n >= 75 ? 'grade-pass' : 'grade-fail';
}

function renderLearnerGradesView() {
    const mgmtCard = document.getElementById('gradesManagementCard');
    if (mgmtCard) mgmtCard.style.display = 'none';

    const learnerView = document.getElementById('learnerGradesView');
    if (learnerView) learnerView.style.display = 'block';

    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle) pageTitle.textContent = 'My Grades';

    loadSchoolYearsForLearner();
}

async function loadSchoolYearsForLearner() {
    const select = document.getElementById('lgSchoolYear');
    if (!select) return;

    try {
        const [years, grades] = await Promise.all([
            schoolYearsApi.list(),
            gradesApi.list({})
        ]);

        const gradeList = Array.isArray(grades) ? grades : [];
        const yearIdsWithGrades = new Set(gradeList.map(g => Number(g.school_year_id || 0)).filter(id => id > 0));

        const yearsWithRecords = (years || [])
            .filter(y => Number(y.is_deleted) !== 1 && yearIdsWithGrades.has(Number(y.school_year_id || 0)))
            .sort((a, b) => Number(a.year_start || 0) - Number(b.year_start || 0));

        const opts = yearsWithRecords
            .map(y => `<option value="${Number(y.school_year_id)}">${escapeHtml(y.year_label || '')}</option>`)
            .join('');
        select.innerHTML = opts || '<option value="">No grades on record</option>';

        // Latest year at the bottom; select it by default.
        if (yearsWithRecords.length) {
            const latest = yearsWithRecords[yearsWithRecords.length - 1];
            select.value = String(latest.school_year_id);
        }

        select.addEventListener('change', () => loadLearnerGradesSummary(Number(select.value || 0)));

        if (select.value) {
            await loadLearnerGradesSummary(Number(select.value));
        }
    } catch (error) {
        console.error('Failed to load school years:', error);
        if (select) select.innerHTML = '<option value="">Error loading years</option>';
    }
}

async function loadLearnerGradesSummary(schoolYearId) {
    const tableHead = document.getElementById('lgTableHead');
    const tableBody = document.getElementById('lgTableBody');
    const tableContainer = document.getElementById('lgTableContainer');
    const emptyMsg = document.getElementById('lgEmpty');
    const summary = document.getElementById('lgSummary');

    if (!tableBody) return;

    tableBody.innerHTML = '<tr><td colspan="10" class="text-center"><i class="fas fa-spinner fa-spin"></i> Loading grades...</td></tr>';
    if (emptyMsg) emptyMsg.style.display = 'none';
    if (tableContainer) tableContainer.style.display = 'block';

    try {
        const [periods, grades] = await Promise.all([
            gradingPeriodsApi.list(),
            schoolYearId > 0 ? gradesApi.list({ school_year_id: schoolYearId }) : Promise.resolve([])
        ]);

        const syPeriods = (periods || [])
            .filter(p => Number(p.school_year_id) === schoolYearId && Number(p.is_deleted) !== 1)
            .sort((a, b) => Number(a.period_no || 0) - Number(b.period_no || 0));

        const gradeList = Array.isArray(grades) ? grades : [];

        if (!syPeriods.length) {
            tableHead.innerHTML = '';
            tableBody.innerHTML = '<tr><td colspan="10" class="text-center">No grading periods found for this school year.</td></tr>';
            if (summary) summary.innerHTML = '';
            return;
        }

        // Build subject -> { period_no -> grade }
        const bySubject = new Map();
        gradeList.forEach(g => {
            const subject = String(g.subject_name || '').trim() || '—';
            const pno = Number(g.period_no || 0);
            const grade = toNum(g.quarterly_grade);
            if (!bySubject.has(subject)) bySubject.set(subject, {});
            const current = bySubject.get(subject)[pno];
            if (grade !== null && (current === undefined || grade > current)) {
                bySubject.get(subject)[pno] = grade;
            }
        });

        const allSubjects = Array.from(bySubject.keys());
        const mapehComponents = allSubjects.filter(s => isMapehComponent(s)).sort();
        const hasMapeh = mapehComponents.length > 0;
        const regularSubjects = allSubjects
            .filter(s => !isMapehComponent(s) && !(hasMapeh && isMapehParent(s)))
            .sort();

        const mapehComponentMap = new Map();
        mapehComponents.forEach(c => mapehComponentMap.set(c, bySubject.get(c)));

        let mapehPeriodValues = [];
        let mapehFinal = null;
        if (hasMapeh) {
            mapehPeriodValues = computeMapehPeriodValues(mapehComponentMap, syPeriods);
            mapehFinal = computeFinal(mapehPeriodValues);
        }

        // Table header
        const thHtml = `
            <tr>
                <th style="text-align:left;">Subject</th>
                ${syPeriods.map(p => `<th style="text-align:center; min-width:90px;">${escapeHtml(p.period_name || `P${p.period_no}`)}</th>`).join('')}
                <th style="text-align:center; min-width:80px;">Final</th>
                <th style="text-align:center; min-width:80px;">Remarks</th>
            </tr>
        `;
        tableHead.innerHTML = thHtml;

        const displaySubjects = regularSubjects.length + (hasMapeh ? 1 : 0);

        if (!displaySubjects) {
            tableBody.innerHTML = '<tr><td colspan="10" class="text-center">No grades found for this school year.</td></tr>';
            if (tableContainer) tableContainer.style.display = 'none';
            if (emptyMsg) emptyMsg.style.display = 'block';
            if (summary) summary.innerHTML = '';
            return;
        }

        let totalFinal = 0;
        let passedCount = 0;
        let failedCount = 0;

        function makeRow(subject, periodValues, final, isComponent = false) {
            let remark = '';
            let remarkClass = '';
            let rowClass = '';

            if (final !== null) {
                if (final >= 75) {
                    remark = 'Passed';
                    remarkClass = 'grade-pass';
                    rowClass = 'grade-row-pass';
                } else {
                    remark = 'Failed';
                    remarkClass = 'grade-fail';
                    rowClass = 'grade-row-fail';
                }
            } else {
                rowClass = 'grade-row-partial';
            }

            if (isComponent) {
                rowClass += ' mapeh-component-row';
            }

            const indentStyle = isComponent ? 'padding-left: 2.5rem; font-weight: 500;' : 'font-weight: 600;';
            const rowStyle = isComponent ? 'display: none;' : '';

            return `
                <tr class="${rowClass}" style="${rowStyle}">
                    <td style="text-align:left; ${indentStyle}">${escapeHtml(subject)}</td>
                    ${periodValues.map(v => `<td style="text-align:center;" class="${getGradeToneClass(v)}">${formatGrade(v)}</td>`).join('')}
                    <td style="text-align:center; font-weight:700;" class="${getGradeToneClass(final)}">${formatGrade(final)}</td>
                    <td style="text-align:center;" class="${remarkClass}">${remark}</td>
                </tr>
            `;
        }

        let rowHtml = '';

        if (hasMapeh) {
            let mapehRemark = '';
            let mapehRemarkClass = '';
            let mapehRowClass = '';

            if (mapehFinal !== null) {
                totalFinal += mapehFinal;
                if (mapehFinal >= 75) {
                    mapehRemark = 'Passed';
                    mapehRemarkClass = 'grade-pass';
                    mapehRowClass = 'grade-row-pass';
                    passedCount++;
                } else {
                    mapehRemark = 'Failed';
                    mapehRemarkClass = 'grade-fail';
                    mapehRowClass = 'grade-row-fail';
                    failedCount++;
                }
            } else {
                mapehRowClass = 'grade-row-partial';
            }

            rowHtml += `
                <tr class="mapeh-row ${mapehRowClass}" data-mapeh-toggle="1" style="cursor: pointer;">
                    <td style="text-align:left; font-weight:600;">
                        <i class="fas fa-chevron-right mapeh-toggle-icon" style="margin-right: 8px; transition: transform 0.2s;"></i>
                        MAPEH
                    </td>
                    ${mapehPeriodValues.map(v => `<td style="text-align:center;" class="${getGradeToneClass(v)}">${formatGrade(v)}</td>`).join('')}
                    <td style="text-align:center; font-weight:700;" class="${getGradeToneClass(mapehFinal)}">${formatGrade(mapehFinal)}</td>
                    <td style="text-align:center;" class="${mapehRemarkClass}">${mapehRemark}</td>
                </tr>
            `;

            mapehComponents.forEach(component => {
                const componentPeriodValues = syPeriods.map(p => mapehComponentMap.get(component)[p.period_no] ?? null);
                const componentFinal = computeFinal(componentPeriodValues);
                rowHtml += makeRow(component, componentPeriodValues, componentFinal, true);
            });
        }

        regularSubjects.forEach(subject => {
            const gradesByPeriod = bySubject.get(subject);
            const periodValues = syPeriods.map(p => gradesByPeriod[p.period_no] ?? null);
            const final = computeFinal(periodValues);

            let remark = '';
            let remarkClass = '';
            let rowClass = '';

            if (final !== null) {
                totalFinal += final;
                if (final >= 75) {
                    remark = 'Passed';
                    remarkClass = 'grade-pass';
                    rowClass = 'grade-row-pass';
                    passedCount++;
                } else {
                    remark = 'Failed';
                    remarkClass = 'grade-fail';
                    rowClass = 'grade-row-fail';
                    failedCount++;
                }
            } else {
                rowClass = 'grade-row-partial';
            }

            rowHtml += makeRow(subject, periodValues, final, false);
        });

        tableBody.innerHTML = rowHtml;

        // Attach MAPEH toggle behaviour
        tableBody.querySelectorAll('[data-mapeh-toggle]').forEach(toggleRow => {
            toggleRow.addEventListener('click', () => {
                const isOpen = toggleRow.dataset.mapehOpen === '1';
                const icon = toggleRow.querySelector('.mapeh-toggle-icon');
                const componentRows = tableBody.querySelectorAll('.mapeh-component-row');
                componentRows.forEach(r => r.style.display = isOpen ? 'none' : 'table-row');
                toggleRow.dataset.mapehOpen = isOpen ? '' : '1';
                if (icon) icon.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
            });
        });

        const gwa = displaySubjects > 0 && totalFinal > 0
            ? totalFinal / displaySubjects
            : null;

        if (summary) {
            summary.innerHTML = `
                <div class="lg-pill lg-pill-present"><span class="lg-pill-dot"></span> Passed: ${passedCount}</div>
                <div class="lg-pill lg-pill-absent"><span class="lg-pill-dot"></span> Failed: ${failedCount}</div>
                <div class="lg-pill lg-pill-info"><span class="lg-pill-dot"></span> Subjects: ${displaySubjects}</div>
                <div class="lg-pill lg-pill-warn"><span class="lg-pill-dot"></span> GWA: ${gwa !== null ? formatGrade(gwa) : '—'}</div>
            `;
        }

        if (tableContainer) tableContainer.style.display = 'block';
    } catch (error) {
        console.error('Failed to load learner grades:', error);
        tableBody.innerHTML = '<tr><td colspan="10" class="text-center" style="color:var(--color-danger);">Unable to load grades. Please try again.</td></tr>';
        if (summary) summary.innerHTML = '';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    waitForRole(() => {
        if (isLearnerRole()) {
            renderLearnerGradesView();
        } else {
            initializeMasterfile({
                key: 'grades',
                navKey: 'grades',
                entity: 'Grade',
                pageTitle: 'Grades',
                subtitle: '',
                breadcrumb: 'Grades',
                addLabel: 'Add Grade',
                primaryKey: 'grade_id',
                readOnly: false,
                hideActions: false,
                columns: [
                    { key: 'learner_name', label: 'Learner' },
                    { key: 'subject_name', label: 'Subject' },
                    { key: 'period_name', label: 'Period' },
                    { key: 'quarterly_grade', label: 'Period Grade' }
                ],
                fields: buildFields(),
                api: gradesApi
            });
        }
    });
});
