/**
 * Sections Masterfile — unified single-page with cascading dropdowns
 * Uses native HTML modals for forms and the shared Masterfiles dialog/toast
 * pattern for CRUD feedback and archive confirmations.
 */

const API_BASE_URL = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;

const smApi = {
    schoolYears:  () => axios.get(`${API_BASE_URL}/school_years/school_years.php`,   { params: { operation: 'getAllSchoolYears' } }).then(r => r.data),
    gradeLevels:  () => axios.get(`${API_BASE_URL}/grade_levels/grade_levels.php`,    { params: { operation: 'getAllGradeLevels' } }).then(r => r.data),
    sections:     (syId) => axios.get(`${API_BASE_URL}/sections/sections.php`,        { params: { operation: 'getAllSections', school_year_id: syId } }).then(r => r.data),
    employees:    () => axios.get(`${API_BASE_URL}/employees/employees.php`,          { params: { operation: 'getAllEmployees' } }).then(r => r.data),
    createSection:(data) => axios.post(`${API_BASE_URL}/sections/sections.php?operation=createSection`, data).then(r => r.data),
    updateSection:(data) => axios.post(`${API_BASE_URL}/sections/sections.php?operation=updateSection`, data).then(r => r.data),
    deleteSection:(id)   => axios.post(`${API_BASE_URL}/sections/sections.php?operation=archiveSection`, { section_id: id }).then(r => r.data),
};

let smState = {
    schoolYears: [],
    gradeLevels: [],
    sections: [],
    employees: [],
    selectedSY: null,
    selectedGL: null,
    filteredSections: [],
    editingId: null
};

let smLongPressTimer = null;
let smRowClickTimer = null;
let smLastRowClick = null;
const smSelectedIds = new Set();

function smSyncSelectPresentation(id, value, disabled) {
    const select = document.getElementById(id);
    if (!select) return;

    if (value !== undefined) {
        select.value = value == null ? '' : String(value);
    }
    if (typeof disabled === 'boolean') {
        select.disabled = disabled;
    }

    const choices = select._choicesInstance;
    if (!choices) return;

    try {
        choices.refresh();
        if (typeof disabled === 'boolean') {
            disabled ? choices.disable() : choices.enable();
        }
        if (value !== undefined) {
            choices.setChoiceByValue(value == null ? '' : String(value));
        }
    } catch (_) {
        // Keep the native select value as a safe fallback if the enhancement
        // is still initializing or is unavailable.
    }
}

/* ════════════════════════════════
   INIT
   ════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
    smSetupOptions();
    smSetupSelectionInteractions();
    await smLoadInitialData();
});

function smSetupOptions() {
    const toggle = document.getElementById('smOptionsButton');
    const menu = document.getElementById('smOptionsMenu');
    if (!toggle || !menu) return;

    ['smSectionName', 'smModalGradeId', 'smMaxCapacity', 'smAdviserId'].forEach(id => {
        const input = document.getElementById(id);
        const eventName = input?.tagName === 'SELECT' ? 'change' : 'input';
        input?.addEventListener(eventName, () => smClearFieldError(id));
    });

    document.getElementById('sectionSearch')?.addEventListener('input', (event) => {
        smFilterTable(event.target.value);
    });

    const setOpen = (open) => {
        menu.classList.toggle('is-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        if (window.matchMedia?.('(max-width: 768px)').matches) {
            document.body.classList.toggle('mf-mobile-sheet-open', open);
        }
    };

    toggle.addEventListener('click', () => setOpen(!menu.classList.contains('is-open')));
    menu.addEventListener('click', (event) => {
        const option = event.target.closest('button[role="menuitem"]');
        if (!option) return;
        setOpen(false);
        if (option.dataset.mfOption === 'add') smOpenAddModal();
    });
    document.addEventListener('pointerdown', (event) => {
        if (!menu.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
    });
    toggle.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setOpen(false);
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            menu.querySelector('button:not([disabled])')?.focus();
        }
    });
    menu.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            toggle.focus();
        }
    });
}

async function smLoadInitialData() {
    try {
        const [syData, glData, empData] = await Promise.all([
            smApi.schoolYears(),
            smApi.gradeLevels(),
            smApi.employees()
        ]);

        smState.schoolYears = Array.isArray(syData)
            ? syData.filter(s => Number(s.is_deleted || 0) !== 1)
            : [];
        smState.gradeLevels = Array.isArray(glData)
            ? glData.filter(g => Number(g.is_deleted || 0) !== 1)
            : [];
        smState.employees   = Array.isArray(empData)
            ? empData.filter(e => Number(e.is_deleted || 0) !== 1 && String(e.role_name || '').toLowerCase().includes('teacher'))
            : [];

        smPopulateSYSelect();
        smPopulateModalGradeSelect();
        smPopulateAdviserSelect();

        // Auto-select active SY if exists
        const activeSY = smState.schoolYears.find(s => s.is_active == 1);
        if (activeSY) {
            smSyncSelectPresentation('filterSY', activeSY.school_year_id);
            await smOnSYChange();
        }
    } catch (e) {
        smToast('Failed to load initial masterfile data.', 'error');
    }
}

function smPopulateSYSelect() {
    const sel = document.getElementById('filterSY');
    if (!smState.schoolYears.length) {
        sel.innerHTML = '<option value="">— No school years found —</option>';
        smSyncSelectPresentation('filterSY', '');
        return;
    }
    sel.innerHTML = '<option value="">— Select School Year —</option>' +
        smState.schoolYears.map(sy => {
            const badge = sy.is_active == 1 ? ' (Active)' : '';
            return `<option value="${sy.school_year_id}">${escHtml(sy.year_label)}${badge}</option>`;
        }).join('');
    smSyncSelectPresentation('filterSY', '');
}

function smPopulateModalGradeSelect() {
    const sel = document.getElementById('smModalGradeId');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Select Grade Level —</option>' +
        [...smState.gradeLevels]
            .sort((a, b) => Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0))
            .map(gl => `<option value="${gl.grade_level_id}">${escHtml(gl.grade_name)}</option>`).join('');
    smSyncSelectPresentation('smModalGradeId', '');
}

function smPopulateAdviserSelect() {
    const sel = document.getElementById('smAdviserId');
    if (!sel) return;
    const currentSectionId = smState.editingId ? Number(smState.editingId) : null;
    const opts = smState.employees
        .filter(e => !smFindAdviserAssignment(e.employee_id, currentSectionId))
        .map(e => {
            const name = [e.last_name, e.first_name].filter(Boolean).join(', ');
            return `<option value="${e.employee_id}">${escHtml(name)}</option>`;
        }).join('');
    sel.innerHTML = '<option value="">— No adviser assigned —</option>' + opts;
    smSyncSelectPresentation('smAdviserId', '');
}

function smFindAdviserAssignment(employeeId, exceptSectionId = null) {
    if (!employeeId || !smState.selectedSY) return null;
    return smState.sections.find(s =>
        Number(s.adviser_id) === Number(employeeId) &&
        Number(s.school_year_id) === Number(smState.selectedSY.school_year_id) &&
        (!exceptSectionId || Number(s.section_id) !== Number(exceptSectionId))
    ) || null;
}

/* ════════════════════════════════
   CASCADING FILTERS
   ════════════════════════════════ */
async function smOnSYChange() {
    const syId = parseInt(document.getElementById('filterSY').value, 10);
    const glSel = document.getElementById('filterGL');

    if (!syId) {
        glSel.innerHTML = '<option value="">— Select School Year First —</option>';
        smSyncSelectPresentation('filterGL', '', true);
        smState.selectedSY = null;
        smState.selectedGL = null;
        smShowEmptyState();
        return;
    }

    smState.selectedSY = smState.schoolYears.find(s => Number(s.school_year_id) === syId);
    glSel.innerHTML = '<option value="all">— All Grade Levels —</option>' +
        [...smState.gradeLevels]
            .sort((a, b) => Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0))
            .map(gl => `<option value="${gl.grade_level_id}">${escHtml(gl.grade_name)}</option>`).join('');

    // Default to "All Grade Levels" or keep current if valid
    smSyncSelectPresentation('filterGL', 'all', false);
    smState.selectedGL = null;

    await smLoadSections();
}

async function smOnGLChange() {
    const glValue = document.getElementById('filterGL').value;
    if (glValue === 'all' || !glValue) {
        smState.selectedGL = null;
    } else {
        const glId = parseInt(glValue, 10);
        smState.selectedGL = smState.gradeLevels.find(g => Number(g.grade_level_id) === glId);
    }
    await smLoadSections();
}

async function smLoadSections() {
    if (!smState.selectedSY) {
        smShowEmptyState();
        return;
    }

    try {
        const data = await smApi.sections(smState.selectedSY.school_year_id);
        smState.sections = Array.isArray(data) ? data : [];
        const validIds = new Set(smState.sections.map(section => String(section.section_id)));
        [...smSelectedIds].forEach(id => {
            if (!validIds.has(id)) smSelectedIds.delete(id);
        });
        smPopulateAdviserSelect();

        // Filter sections dynamically by selected grade level
        smState.filteredSections = smState.selectedGL
            ? smState.sections.filter(s => Number(s.grade_level_id) === Number(smState.selectedGL.grade_level_id))
            : smState.sections;

        smRenderSections();
        smFilterTable(document.getElementById('sectionSearch')?.value || '');
    } catch (e) {
        smToast('Failed to load sections for the selected criteria.', 'error');
        smShowEmptyState();
    }
}

function smShowEmptyState() {
    smSelectedIds.clear();
    smUpdateSelectionControls();
    document.getElementById('dataArea').innerHTML = `
        <div class="sm-empty-prompt">
            <video class="mp4-surface-blend context-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="../assets/icons/fast-forward.mp4" type="video/mp4"></video>
            <h3>Select a School Year and Grade Level</h3>
        </div>`;
}

/* ════════════════════════════════
   RENDER SECTIONS
   ════════════════════════════════ */
function smRenderSections() {
    const area = document.getElementById('dataArea');
    const sections = smState.filteredSections;
    clearTimeout(smRowClickTimer);
    smLastRowClick = null;

    if (!sections.length) {
        area.innerHTML = `
            <div class="sm-empty-prompt">
                <video class="mp4-surface-blend context-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="../assets/icons/search.mp4" type="video/mp4"></video>
                <h3>No sections found</h3>
            </div>`;
        smUpdateSelectionControls();
        return;
    }

    area.innerHTML = `
        <div class="table-container">
            <table class="data-table">
                <thead>
                    <tr>
                        <th class="mf-select-column"><input type="checkbox" id="smSelectAllHeader" aria-label="Select all visible sections"></th>
                        ${smState.selectedGL ? '' : '<th>Grade Level</th>'}
                        <th>Section Name</th>
                        <th>Adviser</th>
                    </tr>
                </thead>
                <tbody id="sectionTableBody">
                    ${smRenderRows(sections)}
                </tbody>
            </table>
        </div>`;
}

function smRenderRows(sections) {
    return sections.map(s => {
        const adviser = s.adviser_name && s.adviser_name.trim() !== ','
            ? escHtml(s.adviser_name)
            : '<span style="color:var(--gray-400);font-style:italic;">Unassigned</span>';

        const gradeCol = smState.selectedGL ? '' : `<td><strong>${escHtml(s.grade_name || '—')}</strong></td>`;

        const sectionId = escHtml(s.section_id);
        const rowActions = `<div class="mf-row-action-source" hidden>
            <button class="action-btn view" data-action="view" data-id="${sectionId}" title="View details" aria-label="View details" onclick="smViewSection(${Number(s.section_id)})">View details</button>
            <button class="action-btn edit" data-action="edit" data-id="${sectionId}" title="Edit section" aria-label="Edit section" onclick="smOpenEditModal(${Number(s.section_id)})">Edit section</button>
            <button class="action-btn delete" data-action="delete" data-id="${sectionId}" title="Archive section" aria-label="Archive section" onclick="smDeleteSection(${Number(s.section_id)})">Archive section</button>
        </div>`;
        const selected = smSelectedIds.has(String(s.section_id));
        return `<tr class="mf-record-row mf-selectable sm-record-row${selected ? ' is-selected' : ''}" data-row-id="${s.section_id}">
            <td class="mf-select-cell"><input type="checkbox" data-selection-id="${sectionId}" aria-label="Select section ${escHtml(s.section_name)}"${selected ? ' checked' : ''}></td>
            ${gradeCol ? gradeCol.replace('<td>', '<td class="mf-data-cell mf-secondary-cell">') : ''}
            <td class="mf-data-cell mf-primary-cell"><div class="mf-record-value" tabindex="0" aria-label="Show actions for ${escHtml(s.section_name)}"><strong class="mf-primary-value">${escHtml(s.section_name)}</strong><div class="mf-mobile-meta"><span class="mf-meta-item mf-teacher-meta">${adviser}</span></div><button type="button" class="mf-mobile-action-toggle" data-mobile-actions-toggle aria-expanded="false" aria-label="Show actions" title="Show actions"><i class="fas fa-ellipsis-vertical" aria-hidden="true"></i></button></div>${rowActions}</td>
            <td class="mf-data-cell mf-secondary-cell">${adviser}</td>
        </tr>`;
    }).join('');
}

function smToggleMobileActions(row) {
    if (!row) return;
    const open = row.classList.toggle('mf-actions-open');
    row.querySelector('.mf-mobile-action-toggle')?.setAttribute('aria-expanded', String(open));
}

function smFilterTable(term) {
    const tableBody = document.getElementById('sectionTableBody');
    if (!tableBody) return;

    const lower = (term || '').toLowerCase();
    const base = smState.selectedGL
        ? smState.sections.filter(s => Number(s.grade_level_id) === Number(smState.selectedGL.grade_level_id))
        : smState.sections;

    const filtered = !lower
        ? base
        : base.filter(s =>
            (s.section_name || '').toLowerCase().includes(lower) ||
            (s.adviser_name || '').toLowerCase().includes(lower) ||
            (s.grade_name   || '').toLowerCase().includes(lower)
        );

    tableBody.innerHTML = smRenderRows(filtered);
    smUpdateSelectionControls();
}

function smSetupSelectionInteractions() {
    const area = document.getElementById('dataArea');
    if (!area) return;

    area.addEventListener('click', (event) => {
        const checkbox = event.target.closest('input[data-selection-id]');
        if (checkbox) {
            event.stopPropagation();
            const id = String(checkbox.dataset.selectionId || '');
            if (id) {
                if (checkbox.checked) smSelectedIds.add(id);
                else smSelectedIds.delete(id);
                smUpdateSelectionControls();
            }
            return;
        }

        const selectAll = event.target.closest('#smSelectAllHeader');
        if (selectAll) {
            event.stopPropagation();
            smSetVisibleSelection(selectAll.checked);
            return;
        }

        const actionToggle = event.target.closest('[data-mobile-actions-toggle]');
        if (actionToggle) {
            event.preventDefault();
            event.stopPropagation();
            const row = actionToggle.closest('tr.mf-record-row');
            if (row) smOpenSectionActions(event, row);
            return;
        }

        const row = event.target.closest('tr.mf-record-row');
        if (!row || event.target.closest('a, button, input, select, textarea, label')) return;

        event.preventDefault();
        event.stopPropagation();
        clearTimeout(smRowClickTimer);

        const now = performance.now();
        const doubleClick = smLastRowClick?.row === row && now - smLastRowClick.time < 450;
        smLastRowClick = { row, time: now };
        if (smSelectedIds.size > 0 || doubleClick || event.detail >= 2) {
            smSelectSectionRow(row, event.detail < 2 && !doubleClick);
            smLastRowClick = null;
            return;
        }

        const point = { clientX: event.clientX, clientY: event.clientY };
        smRowClickTimer = setTimeout(() => {
            if (row.isConnected) smOpenSectionActions(point, row);
        }, 450);
    }, true);

    document.addEventListener('change', (event) => {
        if (event.target?.id === 'smSelectAll') smSetVisibleSelection(event.target.checked);
    });

    document.getElementById('smBulkArchiveBtn')?.addEventListener('click', smArchiveSelected);
    document.getElementById('smSelectAll')?.addEventListener('click', (event) => event.stopPropagation());
}

function smOpenSectionActions(point, row) {
    window.mfOpenContextMenu?.(point, row);
}

function smSelectSectionRow(row, toggle = false) {
    const id = String(row?.dataset.rowId || '');
    if (!id) return;
    if (toggle && smSelectedIds.has(id)) smSelectedIds.delete(id);
    else smSelectedIds.add(id);
    smUpdateSelectionControls();
}

function smSetVisibleSelection(checked) {
    document.querySelectorAll('#sectionTableBody tr[data-row-id]').forEach((row) => {
        const id = String(row.dataset.rowId || '');
        if (!id) return;
        if (checked) smSelectedIds.add(id);
        else smSelectedIds.delete(id);
    });
    smUpdateSelectionControls();
}

function smUpdateSelectionControls() {
    const selected = smSelectedIds.size;
    document.body.classList.toggle('mf-selection-mode', selected > 0);
    const bulkControls = document.getElementById('mfBulkControls');
    if (bulkControls) bulkControls.setAttribute('aria-hidden', String(selected === 0));

    const visibleRows = [...document.querySelectorAll('#sectionTableBody tr[data-row-id]')];
    const visibleIds = visibleRows.map(row => String(row.dataset.rowId || '')).filter(Boolean);
    const selectedVisible = visibleIds.filter(id => smSelectedIds.has(id)).length;
    const allSelected = visibleIds.length > 0 && selectedVisible === visibleIds.length;

    const selectAll = document.getElementById('smSelectAll');
    if (selectAll) {
        selectAll.checked = allSelected;
        selectAll.indeterminate = selectedVisible > 0 && !allSelected;
    }
    const selectAllHeader = document.getElementById('smSelectAllHeader');
    if (selectAllHeader) {
        selectAllHeader.checked = allSelected;
        selectAllHeader.indeterminate = selectedVisible > 0 && !allSelected;
    }

    visibleRows.forEach((row) => {
        const isSelected = smSelectedIds.has(String(row.dataset.rowId || ''));
        row.classList.toggle('is-selected', isSelected);
        const checkbox = row.querySelector('input[data-selection-id]');
        if (checkbox) checkbox.checked = isSelected;
    });

    const archiveButton = document.getElementById('smBulkArchiveBtn');
    if (archiveButton) {
        archiveButton.disabled = selected === 0;
        archiveButton.setAttribute('aria-disabled', String(selected === 0));
        archiveButton.classList.toggle('is-visible', selected > 0);
        const label = archiveButton.querySelector('.mf-bulk-archive-label');
        if (label) label.textContent = selected ? `Archive selected (${selected})` : 'Archive selected';
    }
}

async function smArchiveSelected() {
    const ids = [...smSelectedIds];
    if (!ids.length) return;

    if (!await window.mfConfirm({
        title: `Archive ${ids.length} selected section${ids.length === 1 ? '' : 's'}?`,
        message: 'The selected sections will be hidden from the active list and kept in View archive. You can restore them later.',
        confirmLabel: 'Archive',
        intent: 'archive',
        eyebrow: 'Bulk archive'
    })) return;

    try {
        for (const id of ids) {
            const result = await smApi.deleteSection(Number(id));
            if (result?.success === false) {
                throw new Error(result.message || 'Archive failed.');
            }
        }
        smSelectedIds.clear();
        smToast(`${ids.length} section${ids.length === 1 ? '' : 's'} archived successfully.`);
        await smLoadSections();
    } catch (e) {
        smToast(e?.response?.data?.message || 'Could not archive the selected sections.', 'error');
        smUpdateSelectionControls();
    }
}

/* ════════════════════════════════
   ADD / EDIT MODALS
   ════════════════════════════════ */
function smOpenAddModal() {
    if (!smState.selectedSY) {
        smToast('Please select a school year first.', 'warning');
        return;
    }

    smState.editingId = null;
    smClearErrors();
    smPopulateAdviserSelect();

    document.getElementById('sectionModalTitle').textContent = 'Add Section';
    document.getElementById('smSaveBtnText').textContent = 'Save Section';
    document.getElementById('smSectionId').value = '';
    document.getElementById('smSectionName').value = '';
    document.getElementById('smMaxCapacity').value = 45;
    smSyncSelectPresentation('smAdviserId', '');
    document.getElementById('smCtxSY').textContent = smState.selectedSY.year_label;

    const ctxGLGroup = document.getElementById('smCtxGLGroup');
    const modalGradeGroup = document.getElementById('smModalGradeGroup');

    if (smState.selectedGL) {
        // Specific grade is selected: hide select and display context label
        ctxGLGroup.style.display = 'block';
        modalGradeGroup.style.display = 'none';
        document.getElementById('smCtxGL').textContent = smState.selectedGL.grade_name;
        smSyncSelectPresentation('smModalGradeId', smState.selectedGL.grade_level_id);
    } else {
        // "All Grade Levels" is selected: show Grade Level selector dropdown
        ctxGLGroup.style.display = 'none';
        modalGradeGroup.style.display = 'block';
        smSyncSelectPresentation('smModalGradeId', '');
    }

    smOpenModal('sectionModal');
}

function smOpenEditModal(sectionId) {
    const sec = smState.sections.find(s => Number(s.section_id) === Number(sectionId));
    if (!sec) return;

    smState.editingId = sectionId;
    smClearErrors();
    smPopulateAdviserSelect();

    document.getElementById('sectionModalTitle').textContent = 'Edit Section';
    document.getElementById('smSaveBtnText').textContent = 'Update Section';
    document.getElementById('smSectionId').value = sec.section_id;
    document.getElementById('smSectionName').value = sec.section_name;
    document.getElementById('smMaxCapacity').value = sec.max_capacity;
    smSyncSelectPresentation('smAdviserId', sec.adviser_id || '');
    document.getElementById('smCtxSY').textContent = smState.selectedSY.year_label;

    const ctxGLGroup = document.getElementById('smCtxGLGroup');
    const modalGradeGroup = document.getElementById('smModalGradeGroup');

    if (smState.selectedGL) {
        ctxGLGroup.style.display = 'block';
        modalGradeGroup.style.display = 'none';
        document.getElementById('smCtxGL').textContent = smState.selectedGL.grade_name;
        smSyncSelectPresentation('smModalGradeId', sec.grade_level_id);
    } else {
        ctxGLGroup.style.display = 'none';
        modalGradeGroup.style.display = 'block';
        smSyncSelectPresentation('smModalGradeId', sec.grade_level_id);
    }

    smOpenModal('sectionModal');
}

async function smSaveSection() {
    smClearErrors();

    const sectionId = document.getElementById('smSectionId').value;
    const name = document.getElementById('smSectionName').value.trim();
    const capacityValue = document.getElementById('smMaxCapacity').value.trim();
    const capacity = capacityValue === '' ? NaN : Number(capacityValue);
    const adviser = document.getElementById('smAdviserId').value;
    const gradeLevelId = document.getElementById('smModalGradeId').value;

    let valid = true;
    if (!gradeLevelId) {
        smSetFieldError('smModalGradeId', 'Grade level is required.');
        valid = false;
    }
    if (!name) {
        smSetFieldError('smSectionName', 'Section name is required.');
        valid = false;
    } else if (name.length > 100) {
        smSetFieldError('smSectionName', 'Section name must be 100 characters or fewer.');
        valid = false;
    }
    const duplicateName = smState.sections.find(section =>
        String(section.section_id) !== String(sectionId || '') &&
        String(section.section_name || '').trim().toLocaleLowerCase() === name.toLocaleLowerCase()
    );
    if (name && duplicateName) {
        smSetFieldError('smSectionName', 'Name already taken.');
        valid = false;
    }
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 60) {
        smSetFieldError('smMaxCapacity', 'Enter a whole number from 1 to 60.');
        valid = false;
    }
    if (adviser && smFindAdviserAssignment(adviser, sectionId ? Number(sectionId) : null)) {
        const assignment = smFindAdviserAssignment(adviser, sectionId ? Number(sectionId) : null);
        smSetFieldError('smAdviserId', `Already assigned to ${assignment.grade_name || 'another grade'} - ${assignment.section_name || 'another section'} for this school year.`);
        valid = false;
    }

    if (!valid) {
        const firstInvalid = document.querySelector('#sectionModal .setup-field.is-error input, #sectionModal .setup-field.is-error select');
        const choicesFocus = firstInvalid?.closest('.setup-field')?.querySelector('.choices__inner');
        (choicesFocus || firstInvalid)?.focus();
        return;
    }

    const payload = {
        section_name: name,
        grade_level_id: parseInt(gradeLevelId, 10),
        school_year_id: smState.selectedSY.school_year_id,
        max_capacity: capacity,
        adviser_id: adviser ? parseInt(adviser, 10) : null
    };

    const saveButton = document.querySelector('#sectionModal .setup-modal-footer .btn-primary');
    const saveLabel = document.getElementById('smSaveBtnText');
    const originalSaveLabel = saveLabel?.textContent;
    if (saveButton) saveButton.disabled = true;
    if (saveLabel) saveLabel.textContent = 'Saving...';
    try {
        if (sectionId) {
            payload.section_id = parseInt(sectionId, 10);
            await smApi.updateSection(payload);
            smToast('Section updated successfully.');
        } else {
            await smApi.createSection(payload);
            smToast('Section created successfully.');
        }
        smCloseModal();
        await smLoadSections();
    } catch (e) {
        const message = e?.response?.data?.message || 'Failed to save section.';
        if (message === 'Name already taken.') {
            smSetFieldError('smSectionName', message);
        } else if (/adviser/i.test(message)) {
            smSetFieldError('smAdviserId', message);
        } else if (/capacity|max_capacity/i.test(message)) {
            smSetFieldError('smMaxCapacity', message);
        } else {
            smToast(message, 'error');
        }
    } finally {
        if (saveButton) saveButton.disabled = false;
        if (saveLabel) saveLabel.textContent = originalSaveLabel || 'Save Section';
    }
}

async function smDeleteSection(sectionId) {
    const sec = smState.sections.find(s => Number(s.section_id) === Number(sectionId));
    if (!sec) return;

    if (!await window.mfConfirm({
        title: `Archive “${sec.section_name}”?`,
        message: 'This section will be hidden from the active list and kept in View archive. You can restore it later. Sections with enrolled learners cannot be archived.',
        confirmLabel: 'Archive',
        intent: 'archive'
    })) {
        return;
    }

    try {
        await smApi.deleteSection(sectionId);
        smToast('Section archived successfully.');
        await smLoadSections();
    } catch (e) {
        smToast(e?.response?.data?.message || 'Could not archive section. It may have existing dependencies.', 'error');
    }
}

function smViewSection(sectionId) {
    const s = smState.sections.find(sec => Number(sec.section_id) === Number(sectionId));
    if (!s) return;

    const enrolled = +s.enrolled_count || 0;
    const capacity = +s.max_capacity || 1;
    const slots    = +s.available_slots || 0;
    const pct      = Math.min(100, Math.round((enrolled / capacity) * 100));
    const fillClass = pct >= 90 ? 'high' : pct >= 60 ? 'mid' : 'low';
    const adviser  = s.adviser_name && s.adviser_name.trim() !== ',' ? escHtml(s.adviser_name) : 'Unassigned';

    document.getElementById('viewModalTitle').textContent = `Section: ${s.section_name}`;
    document.getElementById('viewModalBody').innerHTML = `
        <div style="display:flex;flex-direction:column;gap:1.25rem;">
            <div style="background:var(--gray-50);border:1px solid var(--gray-200);border-radius:0.5rem;padding:1rem 1.25rem;">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem 1.5rem;">
                    ${smDetailItem('School Year',  escHtml(smState.selectedSY?.year_label || '—'))}
                    ${smDetailItem('Grade Level',  escHtml(s.grade_name || '—'))}
                    ${smDetailItem('Section Name', escHtml(s.section_name))}
                    ${smDetailItem('Class Adviser', adviser)}
                </div>
            </div>
            <div style="background:var(--gray-50);border:1px solid var(--gray-200);border-radius:0.5rem;padding:1rem 1.25rem;">
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem 1.5rem;">
                    ${smDetailItem('Max Capacity', capacity)}
                    ${smDetailItem('Enrolled', enrolled)}
                    ${smDetailItem('Open Slots', slots)}
                </div>
                <div style="margin-top:1rem;">
                    <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--gray-400);margin-bottom:0.4rem;">Occupancy</div>
                    <div class="occupancy-bar-wrap">
                        <div class="occupancy-bar" style="height:10px;">
                            <div class="occupancy-bar-fill ${fillClass}" style="width:${pct}%"></div>
                        </div>
                        <span class="occupancy-pct" style="font-size:0.88rem;">${pct}%</span>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.getElementById('viewModalEditBtn').onclick = () => {
        smCloseViewModal();
        smOpenEditModal(sectionId);
    };

    smOpenModal('sectionViewModal');
}

function smDetailItem(label, value) {
    return `<div>
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--gray-400);margin-bottom:0.2rem;">${label}</div>
        <div style="font-size:0.92rem;color:var(--gray-800);font-weight:500;">${value}</div>
    </div>`;
}

/* ════════════════════════════════
   UI HELPERS / MODAL TOGGLES
   ════════════════════════════════ */
function smOpenModal(id) {
    const m = document.getElementById(id);
    if (m) {
        m.classList.add('show');
        m.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        if (id === 'sectionModal') window.enhanceControls?.();
    }
}

// Global functions matching inline HTML calls
window.smCloseModal = function() {
    const m = document.getElementById('sectionModal');
    if (m) {
        m.classList.remove('show');
        m.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        try { document.getElementById('smAdviserId')?._choicesInstance?.hideDropdown(); } catch (_) {}
    }
};

window.smCloseViewModal = function() {
    const m = document.getElementById('sectionViewModal');
    if (m) { m.classList.remove('show'); m.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; }
};

window.addEventListener('click', e => {
    const actionToggle = e.target.closest('#sectionTableBody [data-mobile-actions-toggle]');
    if (actionToggle) {
        e.preventDefault();
        e.stopPropagation();
        const row = actionToggle.closest('tr');
        const rect = actionToggle.getBoundingClientRect();
        window.mfOpenContextMenu?.({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }, row);
        return;
    }
    ['sectionModal', 'sectionViewModal'].forEach(id => {
        const m = document.getElementById(id);
        if (e.target === m) {
            if (id === 'sectionModal') window.smCloseModal();
            else window.smCloseViewModal();
        }
    });
});

// On touch devices a long press on the primary section value reveals row actions.
document.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    const value = e.target.closest('#sectionTableBody .mf-record-value');
    if (!value) return;
    const row = value.closest('.mf-record-row');
    if (!row) return;
    smLongPressTimer = window.setTimeout(() => {
        const rect = value.getBoundingClientRect();
        window.mfOpenContextMenu?.({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }, row);
    }, 520);
});

['pointerup', 'pointercancel', 'pointerleave'].forEach(type => {
    document.addEventListener(type, e => {
        if (smLongPressTimer) {
            window.clearTimeout(smLongPressTimer);
            smLongPressTimer = null;
        }
    }, { passive: true });
});

function smClearErrors() {
    ['smSectionName', 'smMaxCapacity', 'smModalGradeId', 'smAdviserId'].forEach(smClearFieldError);
    document.querySelectorAll('#sectionModal .setup-field').forEach(group => group.classList.remove('is-error'));
}

function smClearFieldError(inputId) {
    const input = document.getElementById(inputId);
    const group = input?.closest('.setup-field');
    if (!input || !group) return;
    input.classList.remove('error');
    input.removeAttribute('aria-invalid');
    group.classList.remove('is-error');
    const errorId = ({ smSectionName: 'errSectionName', smMaxCapacity: 'errMaxCapacity', smModalGradeId: 'errModalGradeId', smAdviserId: 'errAdviserId' })[inputId];
    const message = errorId ? document.getElementById(errorId) : null;
    if (message) message.textContent = '';
}

function smSetFieldError(inputId, message) {
    const input = document.getElementById(inputId);
    const group = input?.closest('.setup-field');
    if (!input || !group) return;
    input.classList.add('error');
    input.setAttribute('aria-invalid', 'true');
    group.classList.add('is-error');
    const errorId = ({ smSectionName: 'errSectionName', smMaxCapacity: 'errMaxCapacity', smModalGradeId: 'errModalGradeId', smAdviserId: 'errAdviserId' })[inputId];
    const error = errorId ? document.getElementById(errorId) : null;
    if (error) {
        error.textContent = message;
        error.setAttribute('role', 'alert');
        error.setAttribute('aria-live', 'polite');
    }
}

function escHtml(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 250);
    }

    const dismissBtn = toast.querySelector('button[aria-label="Dismiss"]');
    if (dismissBtn) dismissBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); dismiss(); });
    toast.addEventListener('mouseenter', () => { if (timer) { clearTimeout(timer); timer = null; } });
    toast.addEventListener('mouseleave', () => { if (!timer) timer = setTimeout(dismiss, timeoutMs); });
}

// Explicit window bindings for inline HTML event handlers
window.smOnSYChange = smOnSYChange;
window.smOnGLChange = smOnGLChange;
window.smOpenAddModal = smOpenAddModal;
window.smOpenEditModal = smOpenEditModal;
window.smSaveSection = smSaveSection;
window.smDeleteSection = smDeleteSection;
window.smViewSection = smViewSection;
window.smFilterTable = smFilterTable;
