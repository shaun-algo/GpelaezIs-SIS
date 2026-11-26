/**
 * LIS Spreadsheet Entry Module
 * Provides an Excel-like inline spreadsheet for pasting/typing learner data
 * directly, with validation and import to the same backend as the file upload wizard.
 */
(() => {
    const root = document.getElementById('liswiz');
    if (!root) return;

    /* ─── Config / helpers ─── */

    function getAppPrefix() {
        const p = String(window.location.pathname || '/');
        for (const seg of ['/dashboard/', '/pages/', '/assets/', '/api/']) {
            if (p.includes(seg)) return p.split(seg)[0] || '';
        }
        if (p.endsWith('.html')) return p.substring(0, p.lastIndexOf('/')) || '';
        return p.endsWith('/') ? p.slice(0, -1) : p;
    }
    const isApache = String(window.location.pathname || '').includes('/deped_capstone2/');
    const API = window.API_BASE || (isApache
        ? `${getAppPrefix()}/api`
        : `${window.location.protocol}//${window.location.host}/deped_capstone2/api`);

    const esc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

    function notify(type, message) {
        if (typeof window.showNotification === 'function') return window.showNotification(message, type);
        if (type === 'error') alert(message);
        else console.log(message);
    }

    function getErrorMessage(error, fallback = 'Request failed') {
        const data = error?.response?.data;
        if (data?.message) return data.message;
        return error?.message || fallback;
    }

    function getValidationErrors(error) {
        const data = error?.response?.data;
        return Array.isArray(data?.validation_errors) ? data.validation_errors : [];
    }

    function showInfoBanner({ icon = 'fa-circle-info', title = '', body = '', autoDismissMs = 3200 } = {}) {
        const existing = document.getElementById('liswiz-info-banner-bd');
        if (existing) existing.remove();
        const bd = document.createElement('div');
        bd.id = 'liswiz-info-banner-bd';
        bd.className = 'liswiz-info-banner-backdrop';
        bd.innerHTML = `<div class="liswiz-info-banner" role="status" aria-live="polite">
            <div class="lib-icon"><i class="fas ${icon}"></i></div>
            ${title ? `<div class="lib-title">${title}</div>` : ''}
            ${body ? `<div class="lib-body">${body}</div>` : ''}
            <div class="lib-dismiss">tap to dismiss</div>
        </div>`;
        document.body.appendChild(bd);
        const dismiss = () => {
            bd.classList.add('fade-out');
            bd.addEventListener('transitionend', () => bd.remove(), { once: true });
        };
        bd.addEventListener('click', dismiss);
        if (autoDismissMs > 0) setTimeout(dismiss, autoDismissMs);
    }

    /* ─── Undo-stack-aware value setter ─── */

    function setInputValue(input, value) {
        input.focus();
        input.select();
        // execCommand keeps the native undo stack intact (Cmd/Ctrl+Z works)
        const ok = document.execCommand('insertText', false, value);
        if (!ok) {
            // Fallback for browsers that dropped execCommand support
            input.value = value;
            input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
        }
        input.classList.toggle('has-value', input.value.trim() !== '');
    }

    /* ─── SF1 Template columns ─── */

    const COLUMNS = [
        { key: 'lrn',            label: 'LRN',                          placeholder: '12-digit LRN',     colClass: 'col-lrn' },
        { key: 'last_name',      label: 'Last Name',                    placeholder: 'DELA CRUZ',        colClass: 'col-last-name' },
        { key: 'first_name',     label: 'First Name',                   placeholder: 'JUAN',             colClass: 'col-first-name' },
        { key: 'middle_name',    label: 'Middle Name',                  placeholder: 'M',                colClass: 'col-middle-name' },
        { key: 'sex',            label: 'Sex',                          placeholder: 'M/F',              colClass: 'col-sex' },
        { key: 'birth_date',     label: 'Birth Date',                   placeholder: '00/00/0000',       colClass: 'col-date' },
        { key: 'age_by_june',    label: 'Age',                          placeholder: '',                 colClass: 'col-age' },
        { key: 'birth_province', label: 'Birth Place (Province)',       placeholder: '',                 colClass: 'col-place' },
        { key: 'mother_tongue',  label: 'Mother Tongue',                placeholder: '',                 colClass: '' },
        { key: 'ip_group',       label: 'IP (Ethnic Group)',            placeholder: '',                 colClass: '' },
        { key: 'religion',       label: 'Religion',                     placeholder: '',                 colClass: '' },
        { key: 'house_street',   label: 'House #/Street/Sitio',         placeholder: '',                 colClass: 'col-addr' },
        { key: 'barangay',       label: 'Barangay',                     placeholder: '',                 colClass: '' },
        { key: 'municipality',   label: 'Municipality/City',            placeholder: '',                 colClass: '' },
        { key: 'province',       label: 'Province',                     placeholder: '',                 colClass: '' },
        { key: 'father_name',    label: 'Father Name',                  placeholder: '',                 colClass: '' },
        { key: 'mother_name',    label: 'Mother Name (Maiden)',         placeholder: '',                 colClass: '' },
        { key: 'guardian_name',  label: 'Guardian Name',                placeholder: '',                 colClass: '' },
        { key: 'guardian_rel',   label: 'Guardian Relationship',        placeholder: '',                 colClass: '' },
        { key: 'contact_number', label: 'Contact Number',               placeholder: '',                 colClass: 'col-contact' },
        { key: 'remarks',        label: 'Remarks',                      placeholder: '',                 colClass: '' }
    ];

    function formatBirthDateValue(value) {
        const raw = String(value ?? '').trim();
        const iso = raw.match(/^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/);
        if (iso) return `${iso[2].padStart(2, '0')}/${iso[3].padStart(2, '0')}/${iso[1]}`;

        const separated = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
        if (separated) return `${separated[1].padStart(2, '0')}/${separated[2].padStart(2, '0')}/${separated[3]}`;

        const digits = raw.replace(/\D/g, '').slice(0, 8);
        return digits
            .replace(/^(\d{2})(\d)/, '$1/$2')
            .replace(/^(\d{2}\/\d{2})(\d)/, '$1/$2');
    }

    function normalizeBirthDateInput(input) {
        if (!input) return;
        const raw = input.value;
        const selectionStart = Number.isFinite(input.selectionStart) ? input.selectionStart : raw.length;
        const digitsBeforeCaret = raw.slice(0, selectionStart).replace(/\D/g, '').length;
        const formatted = formatBirthDateValue(raw);
        input.value = formatted;

        if (typeof input.setSelectionRange === 'function') {
            const caret = Math.min(
                formatted.length,
                digitsBeforeCaret + (digitsBeforeCaret > 2 ? 1 : 0) + (digitsBeforeCaret > 4 ? 1 : 0)
            );
            input.setSelectionRange(caret, caret);
        }
    }

    function buildImportName(row) {
        const last = String(row.last_name || '').trim();
        const given = [row.first_name, row.middle_name]
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .join(' ');
        return last ? `${last}, ${given}` : given;
    }

    const DEFAULT_ROW_COUNT = 20;

    /* ─── State ─── */

    const state = {
        gradeLevels: [],
        sections: [],
        schoolYears: [],
        selectedGradeId: null,
        selectedSectionId: null,
        selectedSchoolYearId: null,
        importing: false
    };

    /* ─── DOM refs ─── */

    const $ = (id) => document.getElementById(id);
    const el = {
        headerRow: $('liswiz-ss-header-row'),
        body: $('liswiz-ss-body'),
        wrap: $('liswiz-spreadsheet-wrap'),
        sySelect: $('liswiz-ss-sy'),
        gradeSelect: $('liswiz-ss-grade'),
        sectionSelect: $('liswiz-ss-section'),
        importBtn: $('liswiz-ss-import'),
        addRowsBtn: $('liswiz-ss-add-rows'),
        deleteRowsBtn: $('liswiz-ss-delete-rows'),
        rowCount: $('liswiz-ss-row-count'),
        status: $('liswiz-ss-status'),
        modeUpload: $('liswiz-mode-upload'),
        modeSpreadsheet: $('liswiz-mode-spreadsheet'),
        // Wizard steps
        ssStep1: $('ss-wiz-step-1'),
        ssStep2: $('ss-wiz-step-2'),
        ssStep3: $('ss-wiz-step-3'),
        ssStepIndicator: $('ss-step-indicator'),
        ssNext1: $('ss-next-1'),
        ssBack2: $('ss-back-2'),
        ssStep1Status: $('ss-step1-status'),
        ssProgressArea: $('ss-import-progress-area')
    };

    /* ─── Tab switching ─── */

    function wireTopTabs() {
        const tabs = root.querySelectorAll('.liswiz-top-tabs .liswiz-tab');
        const uploadStepIndicator = $('liswiz-step-indicator');
        const stepPanels = ['liswiz-step-1', 'liswiz-step-2', 'liswiz-step-3', 'liswiz-step-4'];
        tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                const mode = tab.dataset.mode;
                tabs.forEach((t) => t.classList.toggle('active', t === tab));
                if (el.modeUpload) el.modeUpload.style.display = mode === 'upload' ? 'block' : 'none';
                if (el.modeSpreadsheet) el.modeSpreadsheet.style.display = mode === 'spreadsheet' ? 'block' : 'none';
                // Show appropriate step indicator
                if (uploadStepIndicator) uploadStepIndicator.style.display = mode === 'upload' ? 'flex' : 'none';
                if (el.ssStepIndicator) el.ssStepIndicator.style.display = mode === 'spreadsheet' ? 'flex' : 'none';
                // Reset upload wizard view when switching to spreadsheet
                if (mode === 'spreadsheet') {
                    stepPanels.forEach((id) => {
                        const panel = $(id);
                        if (panel) panel.style.display = id === 'liswiz-step-1' ? 'block' : 'none';
                    });
                }
            });
        });
    }

    /* ─── Spreadsheet wizard step navigation ─── */

    function showSSStep(stepNum) {
        const steps = [el.ssStep1, el.ssStep2, el.ssStep3];
        steps.forEach((s, i) => { if (s) s.style.display = (i + 1 === stepNum) ? 'block' : 'none'; });
        // Update step indicator
        for (let i = 1; i <= 3; i++) {
            const pill = $(`ss-si-${i}`);
            if (pill) {
                pill.classList.remove('active', 'done');
                if (i === stepNum) pill.classList.add('active');
                else if (i < stepNum) pill.classList.add('done');
            }
        }
    }

    function checkStep1Ready() {
        const hasSy = !!state.selectedSchoolYearId;
        const hasGrade = !!state.selectedGradeId;
        const hasSection = !!state.selectedSectionId;
        if (el.ssNext1) el.ssNext1.disabled = !(hasSy && hasGrade && hasSection);

        // Keep the settings step quiet until there is a useful validation or
        // loading message to show. The disabled Next button already communicates
        // that all three settings are required.
        if (!hasSy || !hasGrade || !hasSection) hideStep1Status();
    }

    function showStep1Status(type, html) {
        if (el.ssStep1Status) {
            el.ssStep1Status.style.display = 'block';
            el.ssStep1Status.className = `liswiz-ss-status status-${type}`;
            el.ssStep1Status.innerHTML = html;
        }
    }

    function hideStep1Status() {
        if (el.ssStep1Status) {
            el.ssStep1Status.style.display = 'none';
            el.ssStep1Status.innerHTML = '';
        }
    }

    /* ─── Render spreadsheet ─── */

    function renderHeader() {
        let html = '<th class="col-row-num"><input type="checkbox" id="liswiz-ss-select-all" class="liswiz-ss-chk" title="Select all"></th>';
        for (const col of COLUMNS) {
            html += `<th class="${col.colClass}">${esc(col.label)}</th>`;
        }
        el.headerRow.innerHTML = html;
    }

    function addRows(count) {
        const existingRows = el.body.querySelectorAll('tr').length;
        for (let i = 0; i < count; i++) {
            const rowNum = existingRows + i + 1;
            const tr = document.createElement('tr');
            tr.dataset.row = rowNum;
            let cells = `<td class="row-num-cell"><input type="checkbox" class="liswiz-ss-chk liswiz-ss-row-chk" data-row="${rowNum}"></td>`;
            for (const col of COLUMNS) {
                const dateAttrs = col.key === 'birth_date'
                    ? ' inputmode="numeric" maxlength="10" data-date-mask="mdy"'
                    : '';
                cells += `<td><input type="text" data-col="${col.key}" placeholder="${esc(col.placeholder)}" autocomplete="off" spellcheck="false"${dateAttrs}></td>`;
            }
            tr.innerHTML = cells;
            el.body.appendChild(tr);
        }
        updateRowNumbers();
        checkImportReady();
    }

    function updateRowNumbers() {
        const rows = el.body.querySelectorAll('tr');
        rows.forEach((tr, idx) => {
            tr.dataset.row = idx + 1;
            const chk = tr.querySelector('.liswiz-ss-row-chk');
            if (chk) chk.dataset.row = idx + 1;
        });
    }

    function clearAll() {
        el.body.innerHTML = '';
        addRows(DEFAULT_ROW_COUNT);
        hideStatus();
        el.importBtn.disabled = true;
        const selectAll = $('liswiz-ss-select-all');
        if (selectAll) selectAll.checked = false;
        updateDeleteBtn();
        updateRowCount();
        // Reset to step 2 (data entry) so user can import more with same settings
        showSSStep(2);
    }

    function resetToStep1() {
        el.body.innerHTML = '';
        addRows(DEFAULT_ROW_COUNT);
        hideStatus();
        el.importBtn.disabled = true;
        state.selectedGradeId = null;
        state.selectedSectionId = null;
        state.selectedSchoolYearId = null;
        if (el.sySelect) el.sySelect.value = '';
        if (el.gradeSelect) el.gradeSelect.value = '';
        if (el.sectionSelect) el.sectionSelect.innerHTML = '<option value="">-- Select Section --</option>';
        const selectAll = $('liswiz-ss-select-all');
        if (selectAll) selectAll.checked = false;
        updateDeleteBtn();
        updateRowCount();
        if (el.ssProgressArea) el.ssProgressArea.innerHTML = '';
        showSSStep(1);
        checkStep1Ready();
    }

    /* ─── Paste handling (Excel-like multi-row paste) ─── */

    function wirePasteHandler() {
        el.body.addEventListener('paste', (e) => {
            const target = e.target;
            if (target.tagName !== 'INPUT') return;

            const text = (e.clipboardData || window.clipboardData).getData('text');
            if (!text) return;

            // Detect multi-cell paste (tabs or multiple lines)
            const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
            if (lines.length <= 1 && !text.includes('\t')) return; // single value, let default work

            e.preventDefault();

            const targetRow = target.closest('tr');
            const targetCol = target.dataset.col;
            const startRowIdx = Array.from(el.body.children).indexOf(targetRow);
            const startColIdx = COLUMNS.findIndex((c) => c.key === targetCol);

            // Ensure enough rows exist
            const rowsNeeded = startRowIdx + lines.length;
            const currentRows = el.body.querySelectorAll('tr').length;
            if (rowsNeeded > currentRows) {
                addRows(rowsNeeded - currentRows);
            }

            const allRows = el.body.querySelectorAll('tr');
            for (let r = 0; r < lines.length; r++) {
                const cells = lines[r].split('\t');
                const row = allRows[startRowIdx + r];
                if (!row) break;
                for (let c = 0; c < cells.length; c++) {
                    const colIdx = startColIdx + c;
                    if (colIdx >= COLUMNS.length) break;
                    const input = row.querySelector(`input[data-col="${COLUMNS[colIdx].key}"]`);
                    if (input) setInputValue(input, cells[c].trim());
                }
            }
            checkImportReady();
        });
    }

    function wireInputTracking() {
        el.body.addEventListener('input', (e) => {
            if (e.target.tagName === 'INPUT' && e.target.dataset.col) {
                if (e.target.dataset.col === 'birth_date') normalizeBirthDateInput(e.target);
                e.target.classList.toggle('has-value', e.target.value.trim() !== '');
                checkImportReady();
            }
        });
    }

    /* ─── Checkbox selection ─── */

    function wireCheckboxes() {
        // Select-all header checkbox
        el.headerRow.addEventListener('change', (e) => {
            if (e.target.id === 'liswiz-ss-select-all') {
                const checked = e.target.checked;
                el.body.querySelectorAll('.liswiz-ss-row-chk').forEach((chk) => {
                    chk.checked = checked;
                    chk.closest('tr').classList.toggle('ss-row-selected', checked);
                });
                updateDeleteBtn();
            }
        });

        // Individual row checkboxes (delegated)
        el.body.addEventListener('change', (e) => {
            if (e.target.classList.contains('liswiz-ss-row-chk')) {
                e.target.closest('tr').classList.toggle('ss-row-selected', e.target.checked);
                // Update select-all state
                const allChks = el.body.querySelectorAll('.liswiz-ss-row-chk');
                const allChecked = Array.from(allChks).every((c) => c.checked);
                const selectAll = $('liswiz-ss-select-all');
                if (selectAll) selectAll.checked = allChecked;
                updateDeleteBtn();
            }
        });
    }

    function getSelectedRows() {
        return Array.from(el.body.querySelectorAll('.liswiz-ss-row-chk:checked')).map((chk) => chk.closest('tr'));
    }

    function updateDeleteBtn() {
        const count = el.body.querySelectorAll('.liswiz-ss-row-chk:checked').length;
        if (el.deleteRowsBtn) {
            el.deleteRowsBtn.disabled = count === 0;
            el.deleteRowsBtn.innerHTML = count > 0
                ? `<i class="fas fa-trash"></i> Delete ${count} Row${count > 1 ? 's' : ''}`
                : '<i class="fas fa-trash"></i> Delete Selected';
        }
    }

    function deleteSelectedRows() {
        const selected = getSelectedRows();
        if (!selected.length) return;
        selected.forEach((tr) => tr.remove());
        // Ensure at least a few empty rows remain
        const remaining = el.body.querySelectorAll('tr').length;
        if (remaining < 5) addRows(5 - remaining);
        updateRowNumbers();
        // Reset select-all
        const selectAll = $('liswiz-ss-select-all');
        if (selectAll) selectAll.checked = false;
        updateDeleteBtn();
        checkImportReady();
    }

    /* ─── Data extraction ─── */

    function getFilledRows() {
        const rows = [];
        el.body.querySelectorAll('tr').forEach((tr) => {
            const data = {};
            let hasData = false;
            COLUMNS.forEach((col) => {
                const input = tr.querySelector(`input[data-col="${col.key}"]`);
                const val = input ? input.value.trim() : '';
                data[col.key] = val;
                if (val) hasData = true;
            });
            if (hasData) {
                // The API staging contract still receives raw_name. Keep the
                // visible fields separate while recombining only at submit.
                data.name = buildImportName(data);
                data.row_number = parseInt(tr.dataset.row, 10);
                rows.push(data);
            }
        });
        return rows;
    }

    function checkImportReady() {
        const rows = getFilledRows();
        const hasGrade = !!state.selectedGradeId;
        const hasSection = !!state.selectedSectionId;
        el.importBtn.disabled = rows.length === 0 || !hasGrade || !hasSection || state.importing;
        updateRowCount(rows.length);
    }

    function updateRowCount(count) {
        if (!el.rowCount) return;
        if (count === undefined) count = getFilledRows().length;
        el.rowCount.textContent = count === 0
            ? 'No learners entered'
            : `${count} learner${count !== 1 ? 's' : ''} entered`;
    }

    /* ─── Status display ─── */

    function showStatus(type, html) {
        el.status.style.display = 'block';
        el.status.className = `liswiz-ss-status status-${type}`;
        el.status.innerHTML = html;
    }

    function hideStatus() {
        el.status.style.display = 'none';
        el.status.innerHTML = '';
        el.status.className = 'liswiz-ss-status';
    }

    /* ─── Client-side pre-validation ─── */

    function preValidate(rows) {
        const issues = [];
        for (const r of rows) {
            const rn = r.row_number;
            // LRN check
            const lrn = String(r.lrn || '').replace(/[\s\-]/g, '');
            if (!lrn) {
                issues.push({ row: rn, col: 'lrn', msg: 'LRN is required' });
            } else if (!/^\d{12}$/.test(lrn) && !/^\d{11}$/.test(lrn)) {
                issues.push({ row: rn, col: 'lrn', msg: 'LRN must be 12 digits' });
            }
            // Separate name fields are recombined into the existing import
            // contract as "Last, First Middle" before staging.
            if (!String(r.last_name || '').trim()) {
                issues.push({ row: rn, col: 'last_name', msg: 'Last name is required' });
            }
            if (!String(r.first_name || '').trim()) {
                issues.push({ row: rn, col: 'first_name', msg: 'First name is required' });
            }
            // Sex check
            const sex = String(r.sex || '').toUpperCase();
            if (sex && !['M', 'F', 'MALE', 'FEMALE'].includes(sex)) {
                issues.push({ row: rn, col: 'sex', msg: 'Sex must be M or F' });
            }
            // Birth date - basic check
            if (r.birth_date && !/^\d{2}\/\d{2}\/\d{4}$/.test(r.birth_date)) {
                issues.push({ row: rn, col: 'birth_date', msg: 'Birth date must use 00/00/0000 format' });
            }
            // Match staging column capacity before the API insert.
            const age = String(r.age_by_june || '').trim();
            if (age.length > 10) {
                issues.push({ row: rn, col: 'age_by_june', msg: 'Age must be 10 characters or fewer' });
            }
        }
        return issues;
    }

    function highlightErrors(issues) {
        // Clear previous errors
        el.body.querySelectorAll('input.has-error').forEach((inp) => inp.classList.remove('has-error'));
        for (const issue of issues) {
            const rowNumber = issue.row || issue.row_number;
            const column = issue.col || issue.column;
            const row = el.body.querySelector(`tr[data-row="${rowNumber}"]`);
            if (!row) continue;
            const input = row.querySelector(`input[data-col="${column}"]`);
            if (input) input.classList.add('has-error');
        }
    }

    function showRecoverableImportError(message, issues = []) {
        if (issues.length > 0) highlightErrors(issues);
        logLine('err', esc(message || 'Import failed. Please review the highlighted cells and try again.'));
        for (const issue of issues.slice(0, 8)) {
            logLine('err', `Row ${esc(issue.row || issue.row_number || '')}: ${esc(issue.message || 'Invalid spreadsheet value')}`);
        }
        setProgressLabel('<i class="fas fa-circle-xmark" style="color:#dc2626"></i> Validation failed');
        const summaryEl = $('ss-import-summary');
        if (!summaryEl) return;
        summaryEl.style.display = 'block';
        summaryEl.innerHTML = `
            <div class="liswiz-summary-card">
                <div class="liswiz-summary-header failed">
                    <i class="fas fa-circle-xmark"></i> Import Needs Correction
                </div>
                <p class="ss-import-error-copy">${esc(message || 'Please review the highlighted cells and try again.')}</p>
                <div class="ss-action-bar">
                    <button class="btn btn-secondary" type="button" id="liswiz-ss-back-error"><i class="fas fa-arrow-left"></i> Back to Spreadsheet</button>
                </div>
            </div>`;
        const backBtn = $('liswiz-ss-back-error');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                showSSStep(2);
                showStatus('error', `<i class="fas fa-circle-exclamation"></i> ${esc(message || 'Please correct the highlighted cells.')}`);
            });
        }
    }

    /* ─── Import logic ─── */

    async function doImport() {
        if (state.importing) return;
        const rows = getFilledRows();
        if (!rows.length) {
            showStatus('error', '<i class="fas fa-circle-exclamation"></i> No data to import. Please fill in at least one row.');
            return;
        }
        if (!state.selectedSchoolYearId || !state.selectedGradeId || !state.selectedSectionId) {
            showStatus('error', '<i class="fas fa-circle-exclamation"></i> Settings incomplete. Go back and select School Year, Grade Level, and Section.');
            return;
        }

        // Client pre-validation
        const issues = preValidate(rows);
        highlightErrors(issues);

        if (issues.length > 0) {
            const errorRows = [...new Set(issues.map((i) => i.row))];
            showStatus('error', `<i class="fas fa-circle-exclamation"></i> <b>${issues.length} issue(s) in ${errorRows.length} row(s).</b> Fix the highlighted cells and try again.`);
            return;
        }

        state.importing = true;
        el.importBtn.disabled = true;

        // Switch to step 3 (import progress)
        showSSStep(3);
        showImportProgress();
        logLine('info', 'Validating learner data...');

        try {
            const syId = state.selectedSchoolYearId;

            // 1. Start import
            const startRes = await axios.post(`${API}/learner_registration/learner_registration.php?operation=startLisImport`, {
                school_year_id: syId,
                file_school_id: null,
                file_school_name: null,
                file_school_year: null,
                file_name: 'Spreadsheet Entry',
                file_size_kb: 0,
                total_rows: rows.length,
                file_headers: COLUMNS.map((c) => c.label)
            }).then((r) => r.data);

            if (!startRes?.success) throw new Error(startRes?.message || 'Failed to start import');
            const importId = Number(startRes.import_id);

            // 2. Stage rows in batches
            for (let i = 0; i < rows.length; i += 100) {
                const batch = rows.slice(i, i + 100);
                const stageRes = await axios.post(`${API}/learner_registration/learner_registration.php?operation=stageLisImportRows`, {
                    import_id: importId,
                    rows: batch
                }).then((r) => r.data);
                if (!stageRes?.success) throw new Error(stageRes?.message || 'Failed to stage rows');
            }

            // 3. Validate
            const valRes = await axios.post(`${API}/learner_registration/learner_registration.php?operation=validateLisImport`, {
                import_id: importId,
                default_grade_level_id: state.selectedGradeId,
                fallback_section_id: state.selectedSectionId,
                school_year_id: syId
            }).then((r) => r.data);

            if (!valRes?.success) throw new Error(valRes?.message || 'Validation failed');

            const preview = await axios.get(`${API}/learner_registration/learner_registration.php`, {
                params: { operation: 'getLisImportPreview', import_id: importId }
            }).then((r) => r.data);
            if (!preview?.success) throw new Error(preview?.message || 'Failed to load validation details');

            const summary = valRes.summary || {};
            const previewRows = preview.rows || [];
            const errors = Number(summary.error ?? 0);
            const importable = Number(summary.insert ?? 0) + Number(summary.update ?? 0) + Number(summary.revive ?? 0);

            if (importable === 0) {
                logLine('err', `All ${errors} row(s) failed validation. No learners can be imported.`);
                for (const r of previewRows) {
                    if (r.validation_status === 'Error') {
                        const msgs = (r.messages || []).filter((m) => m.severity === 'E').map((m) => m.message).join('; ');
                        const name = r.norm_last_name ? `${r.norm_last_name}, ${r.norm_first_name || ''}`.trim() : (r.raw_name || `Row ${r.row_number}`);
                        logLine('err', `${esc(name)} — ${esc(msgs || 'Validation error')}`);
                    }
                }
                updateProgress(100);
                setProgressLabel('<i class="fas fa-circle-xmark" style="color:#dc2626"></i> Validation failed');
                renderImportResult({
                    total: errors + Number(summary.skip ?? 0),
                    imported: 0,
                    skipped: Number(summary.skip ?? 0),
                    failed: errors
                }, previewRows);
                markRowErrors(previewRows);
                state.importing = false;
                el.importBtn.disabled = false;
                return;
            }

            if (errors > 0) {
                logLine('warn', `${errors} row(s) have issues and will be skipped.`);
                for (const r of previewRows) {
                    if (r.validation_status !== 'Error') continue;
                    const msgs = (r.messages || []).filter((m) => m.severity === 'E').map((m) => m.message).join('; ');
                    const name = r.norm_last_name ? `${r.norm_last_name}, ${r.norm_first_name || ''}`.trim() : (r.raw_name || `Row ${r.row_number}`);
                    logLine('err', `${esc(name)} — ${esc(msgs || 'Validation error')}`);
                }
                markRowErrors(previewRows);
            }
            for (const r of previewRows) {
                const transfer = (r.messages || []).find((m) => m.code === 'section_transfer');
                if (transfer && r.validation_status !== 'Error') {
                    const name = r.raw_name || `Row ${r.row_number}`;
                    logLine('info', `${esc(name)} — Section Transfer: ${esc(transfer.from_section)} → ${esc(transfer.to_section)} (pending import)`);
                }
                if (r.validation_status !== 'Warning') continue;
                const msgs = (r.messages || []).filter((m) => m.severity === 'W' || m.severity === 'I').map((m) => m.message).join('; ');
                if (!msgs) continue;
                const name = r.norm_last_name ? `${r.norm_last_name}, ${r.norm_first_name || ''}`.trim() : (r.raw_name || `Row ${r.row_number}`);
                logLine('warn', `${esc(name)} — ${esc(msgs)}`);
            }
            logLine('ok', `${importable} learner(s) validated successfully. Importing...`);
            setProgressLabel(`<i class="fas fa-spinner fa-spin"></i> Importing ${importable} learner(s)...`);

            // 4. Commit
            let commitOk = 0, commitSkip = 0, commitErr = 0, commitTotal = 0;
            let done = false, guard = 0;
            while (!done && guard < 500) {
                guard++;
                const res = await axios.post(`${API}/learner_registration/learner_registration.php?operation=commitLisImport`, {
                    import_id: importId,
                    chunk_size: 50,
                    default_password_mode: 'lrn',
                    default_password_custom: null,
                    enrollment_type_id: null
                }).then((r) => r.data);
                if (!res?.success) throw new Error(res?.message || 'Commit failed');
                for (const r of res.results || []) {
                    commitTotal++;
                    const pvRow = previewRows.find((p) => p.row_number == r.row);
                    const name = pvRow?.norm_last_name
                        ? `${pvRow.norm_last_name}, ${pvRow.norm_first_name || ''}`.trim()
                        : (pvRow?.raw_name || r.lrn);
                    if (r.status === 'Inserted') {
                        commitOk++;
                        logLine('ok', `${esc(name)} — Successfully enrolled${r.message ? ' (' + esc(r.message) + ')' : ''}`);
                    } else if (r.status === 'Updated') {
                        commitOk++;
                        logLine('ok', `${esc(name)} — Record updated${r.message ? ' (' + esc(r.message) + ')' : ''}`);
                    } else if (r.status === 'Skipped') {
                        commitSkip++;
                        logLine('warn', `${esc(name)} — Skipped: ${esc(r.message || 'no changes needed')}`);
                    } else {
                        commitErr++;
                        logLine('err', `${esc(name)} — Failed: ${esc(r.message || 'unknown error')}`);
                    }
                }
                const remaining = Number(res.remaining || 0);
                const total = commitTotal + remaining;
                const pct = total > 0 ? Math.round((commitTotal / total) * 100) : 100;
                updateProgress(pct);
                done = !!res.done;
            }

            // 5. Finalize
            try {
                await axios.post(`${API}/learner_registration/learner_registration.php?operation=finalizeLisImport`, {
                    import_id: importId
                });
            } catch (_) { /* ok */ }

            updateProgress(100);
            setProgressLabel('<i class="fas fa-circle-check" style="color:#16a34a"></i> Import complete');
            const counts = finalImportCounts({
                imported: commitOk,
                skipped: commitSkip,
                failed: commitErr,
                committedTotal: commitTotal,
                validationSkipped: Number(summary.skip ?? 0),
                validationErrors: errors
            });
            renderImportResult(counts, previewRows);

        } catch (e) {
            showRecoverableImportError(getErrorMessage(e, 'Import failed'), getValidationErrors(e));
        } finally {
            state.importing = false;
            el.importBtn.disabled = false;
        }
    }

    /* ─── Import progress UI ─── */

    function showImportProgress() {
        const target = el.ssProgressArea || el.status;
        target.innerHTML = `
            <div class="ss-import-progress">
                <div class="liswiz-prog-label" id="ss-prog-label"><i class="fas fa-spinner fa-spin"></i> Preparing import...</div>
                <div class="liswiz-progress"><div id="ss-prog-bar"></div></div>
                <div class="liswiz-log" id="ss-import-log"></div>
                <div id="ss-import-summary" style="display:none;"></div>
            </div>`;
    }

    function setProgressLabel(html) {
        const lbl = $('ss-prog-label');
        if (lbl) lbl.innerHTML = html;
    }

    function updateProgress(pct) {
        const bar = $('ss-prog-bar');
        if (bar) bar.style.width = `${pct}%`;
    }

    function logLine(type, text) {
        const log = $('ss-import-log');
        if (!log) return;
        const div = document.createElement('div');
        div.className = type;
        div.innerHTML = text;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
    }

    function finalImportCounts({ imported, skipped, failed, committedTotal, validationSkipped, validationErrors }) {
        const committed = Math.max(0, Number(committedTotal || 0));
        const importedCount = Math.max(0, Number(imported || 0));
        const skippedCount = Math.max(0, Number(skipped || 0)) + Math.max(0, Number(validationSkipped || 0));
        const failedCount = Math.max(0, Number(failed || 0)) + Math.max(0, Number(validationErrors || 0));
        return {
            total: committed + Math.max(0, Number(validationSkipped || 0)) + Math.max(0, Number(validationErrors || 0)),
            imported: importedCount,
            skipped: skippedCount,
            failed: failedCount
        };
    }

    function markRowErrors(previewRows) {
        el.body.querySelectorAll('input.has-error').forEach((inp) => inp.classList.remove('has-error'));
        for (const r of previewRows) {
            if (r.validation_status !== 'Error') continue;
            const row = el.body.querySelector(`tr[data-row="${r.row_number}"]`);
            if (!row) continue;
            const firstInput = row.querySelector('input');
            if (firstInput) firstInput.classList.add('has-error');
        }
    }

    function renderImportResult(counts, previewRows) {
        const summaryEl = $('ss-import-summary');
        if (!summaryEl) return;

        const { imported: ok, skipped: skip, failed: errors, total } = counts;

        const isFullSuccess = errors === 0 && skip === 0;
        const headerClass = isFullSuccess ? 'success' : (ok > 0 ? 'partial' : 'failed');
        const headerIcon = isFullSuccess ? 'fa-circle-check' : (ok > 0 ? 'fa-triangle-exclamation' : 'fa-circle-xmark');
        const headerText = isFullSuccess ? 'Import Successful' : (ok > 0 ? 'Import Completed with Issues' : 'Import Failed');
        const sectionName = getSelectedSectionName();

        summaryEl.style.display = 'block';
        summaryEl.innerHTML = `
            <div class="liswiz-summary-card">
                <div class="liswiz-summary-header ${headerClass}">
                    <i class="fas ${headerIcon}"></i> ${headerText}
                </div>
                <div class="liswiz-summary">
                    <div class="item"><div class="label">Total</div><div class="val">${total}</div></div>
                    <div class="item"><div class="label">Imported</div><div class="val" style="color:#16a34a">${ok}</div></div>
                    <div class="item"><div class="label">Skipped</div><div class="val" style="color:#d97706">${skip}</div></div>
                    <div class="item"><div class="label">Failed</div><div class="val" style="color:#dc2626">${errors}</div></div>
                </div>
                ${ok > 0 && sectionName ? `<div class="ss-import-enrolled-note"><i class="fas fa-check-circle"></i> Learners have been enrolled to <b>${esc(sectionName)}</b>.</div>` : ''}
                <div class="ss-action-bar">
                    <button class="btn btn-secondary" type="button" id="liswiz-ss-start-over"><i class="fas fa-arrow-rotate-left"></i> Start Over</button>
                    <button class="btn btn-primary" type="button" id="liswiz-ss-reset-after"><i class="fas fa-plus"></i> Import More (Same Section)</button>
                </div>
            </div>`;

        const resetBtn = $('liswiz-ss-reset-after');
        if (resetBtn) resetBtn.addEventListener('click', clearAll);
        const startOverBtn = $('liswiz-ss-start-over');
        if (startOverBtn) startOverBtn.addEventListener('click', resetToStep1);
    }

    function getSelectedSectionName() {
        const opt = el.sectionSelect?.selectedOptions?.[0];
        return opt ? opt.textContent : '';
    }

    /* ─── Lookups ─── */

    async function loadLookups() {
        const [sy, gl] = await Promise.all([
            axios.get(`${API}/school_years/school_years.php`, { params: { operation: 'getAllSchoolYears' } }).then((r) => r.data).catch(() => []),
            axios.get(`${API}/grade_levels/grade_levels.php`, { params: { operation: 'getAllGradeLevels' } }).then((r) => r.data).catch(() => [])
        ]);
        state.schoolYears = Array.isArray(sy) ? sy : [];
        state.gradeLevels = Array.isArray(gl) ? gl : [];

        // No default selection — user must explicitly choose
        state.selectedSchoolYearId = null;

        // Populate school year select (no default)
        if (el.sySelect) {
            el.sySelect.innerHTML = ['<option value="">-- Select School Year --</option>']
                .concat(state.schoolYears.map((r) => {
                    const active = Number(r.is_active) === 1;
                    return `<option value="${Number(r.school_year_id)}">${esc(r.year_label)}${active ? ' (current)' : ''}</option>`;
                })).join('');
        }

        // Populate grade select (no default)
        if (el.gradeSelect) {
            const orderedGradeLevels = [...state.gradeLevels].sort((a, b) =>
                Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0)
            );
            el.gradeSelect.innerHTML = ['<option value="">-- Select Grade Level --</option>']
                .concat(orderedGradeLevels.map((g) => `<option value="${Number(g.grade_level_id)}">${esc(g.grade_name)}</option>`)).join('');
        }
        if (el.sectionSelect) {
            el.sectionSelect.innerHTML = '<option value="">-- Select Section --</option>';
        }
        checkStep1Ready();
    }

    async function loadSections(gradeId) {
        state.sections = [];
        state.selectedSectionId = null;
        if (!gradeId || !state.selectedSchoolYearId) {
            el.sectionSelect.innerHTML = '<option value="">-- Select Section --</option>';
            checkStep1Ready();
            checkImportReady();
            return;
        }
        el.sectionSelect.innerHTML = '<option value="">Loading...</option>';
        const res = await axios.get(`${API}/sections/sections.php`, {
            params: {
                operation: 'getSectionsByGradeLevel',
                grade_level_id: gradeId,
                school_year_id: state.selectedSchoolYearId,
                import_scope: 1
            }
        }).catch((error) => {
            showStep1Status('error', `<i class="fas fa-circle-exclamation"></i> ${esc(getErrorMessage(error, 'Could not load sections.'))}`);
            return { data: [] };
        });
        const list = Array.isArray(res.data) ? res.data : [];
        list.sort((a, b) => Number(b.available_slots || 0) - Number(a.available_slots || 0));
        state.sections = list;

        if (list.length === 0) {
            el.sectionSelect.innerHTML = '<option value="">-- No sections available --</option>';
            const access = await axios.get(`${API}/sections/sections.php`, {
                params: {
                    operation: 'checkSectionAccess',
                    grade_level_id: gradeId,
                    school_year_id: state.selectedSchoolYearId
                }
            }).then((r) => r.data).catch((error) => ({
                message: getErrorMessage(error, 'No sections found for this grade and school year.')
            }));
            showStep1Status('warning', `<i class="fas fa-triangle-exclamation"></i> ${esc(access?.message || 'No sections found for this grade and school year. Create sections first or select a different grade.')}`);
        } else {
            el.sectionSelect.innerHTML = ['<option value="">-- Select Section --</option>']
                .concat(list.map((s) => {
                    const slots = Number(s.available_slots || 0);
                    return `<option value="${Number(s.section_id)}"${slots <= 0 ? ' disabled' : ''}>${esc(s.section_name)} (${slots} slot${slots !== 1 ? 's' : ''} available)</option>`;
                })).join('');
        }
        checkStep1Ready();
        checkImportReady();
    }

    /* ─── Event wiring ─── */

    function bind() {
        wireTopTabs();
        wirePasteHandler();
        wireInputTracking();
        wireCheckboxes();

        // Step 1 settings
        el.sySelect?.addEventListener('change', async () => {
            state.selectedSchoolYearId = Number(el.sySelect.value) || null;
            // If grade is already selected, reload sections with new SY
            if (state.selectedGradeId) {
                await loadSections(state.selectedGradeId);
            }
            checkStep1Ready();
        });

        el.gradeSelect?.addEventListener('change', async () => {
            state.selectedGradeId = Number(el.gradeSelect.value) || null;
            state.selectedSectionId = null;
            await loadSections(state.selectedGradeId);
        });

        el.sectionSelect?.addEventListener('change', () => {
            state.selectedSectionId = Number(el.sectionSelect.value) || null;
            checkStep1Ready();
            checkImportReady();
        });

        // Step 1 → Step 2
        el.ssNext1?.addEventListener('click', () => {
            if (!state.selectedSchoolYearId || !state.selectedGradeId || !state.selectedSectionId) {
                showStep1Status('error', '<i class="fas fa-circle-exclamation"></i> Please select School Year, Grade Level, and Section before proceeding.');
                return;
            }
            showSSStep(2);
            showInfoBanner({
                icon: 'fa-table-cells',
                title: 'Enter Learner Information',
                body: 'Fill in rows manually or paste directly from Excel.',
                autoDismissMs: 3200
            });
        });

        // Step 2 → Step 1 (Back)
        el.ssBack2?.addEventListener('click', () => {
            showSSStep(1);
        });

        el.addRowsBtn?.addEventListener('click', () => addRows(10));
        el.deleteRowsBtn?.addEventListener('click', deleteSelectedRows);
        el.importBtn?.addEventListener('click', doImport);
    }

    /* ─── Init ─── */

    async function init() {
        try {
            renderHeader();
            addRows(DEFAULT_ROW_COUNT);
            await loadLookups();
            bind();
            // Start on step 1
            showSSStep(1);
        } catch (e) {
            console.error('Spreadsheet entry init error:', e);
        }
    }

    // Wait for DOM then init
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
