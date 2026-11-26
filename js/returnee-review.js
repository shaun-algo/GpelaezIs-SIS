(function () {
    'use strict';
    const API = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;
    const api = `${API}/returnee_cases/returnee_cases.php`;
    const state = { rows: [] };
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    function statusClass(value) { return String(value || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, ''); }

    function renderRows() {
        const body = $('rrRows');
        if (!state.rows.length) {
            body.innerHTML = '<tr><td colspan="6" class="rr-empty">No imported Returnee enrollments match this filter.</td></tr>';
            $('rrCount').textContent = '0 records';
            return;
        }
        $('rrCount').textContent = `${state.rows.length} record${state.rows.length === 1 ? '' : 's'}`;
        body.innerHTML = state.rows.map((row) => `<tr>
            <td><div class="rr-learner"><strong>${esc(row.learner_name || 'Unnamed learner')}</strong><span>LRN ${esc(row.lrn || '—')}</span></div></td>
            <td><div class="rr-target"><strong>${esc(row.year_label || '—')} · ${esc(row.grade_name || '—')}</strong><span>${esc(row.enrollment_date || 'Date not recorded')}</span></div></td>
            <td>${esc(row.section_name || 'No section')}</td>
            <td><span class="rr-source-chip">${esc(row.enrollment_type_name || 'Balik-Aral')}</span></td>
            <td><span class="rr-status rr-status--${statusClass(row.enrollment_status)}">${esc(row.enrollment_status || '—')}</span></td>
            <td><button class="btn btn-secondary btn-sm rr-view-btn" type="button" data-enrollment-id="${Number(row.enrollment_id)}"><i class="fas fa-eye"></i> View</button></td>
        </tr>`).join('');
        body.querySelectorAll('.rr-view-btn').forEach((button) => button.addEventListener('click', () => openEnrollment(Number(button.dataset.enrollmentId))));
    }

    async function loadRows() {
        $('rrRows').innerHTML = '<tr><td colspan="6" class="rr-empty">Loading records…</td></tr>';
        try {
            const response = await axios.get(api, { params: { operation: 'getReturneeEnrollments', status: $('rrStatus').value, q: $('rrSearch').value.trim(), limit: 100, _: Date.now() }, withCredentials: true });
            if (!response.data?.success) throw new Error(response.data?.message || 'Could not load returnee enrollments.');
            state.rows = response.data.rows || [];
            renderRows();
        } catch (error) {
            $('rrRows').innerHTML = `<tr><td colspan="6" class="rr-empty">${esc(error.response?.data?.message || error.message || 'Could not load records.')}</td></tr>`;
        }
    }

    async function openEnrollment(enrollmentId) {
        try {
            const response = await axios.get(api, { params: { operation: 'getReturneeEnrollment', enrollment_id: enrollmentId, _: Date.now() }, withCredentials: true });
            if (!response.data?.success) throw new Error(response.data?.message || 'Could not open enrollment.');
            const row = response.data.enrollment;
            $('rrModalTitle').textContent = row.learner_name || 'Returnee enrollment';
            $('rrModalMeta').textContent = `LRN ${row.lrn || '—'} · Enrollment #${row.enrollment_id}`;
            $('rrSummary').innerHTML = `<strong>${esc(row.year_label || '—')} · ${esc(row.grade_name || '—')}</strong><br>Entry classification: <strong>${esc(row.entry_classification || 'Returnee')}</strong> · Enrollment status: <strong>${esc(row.enrollment_status || '—')}</strong><br>Source enrollment type: ${esc(row.enrollment_type_name || 'Balik-Aral')}`;
            $('rrHistory').innerHTML = (response.data.history || []).map((item) => `<div class="rr-prior-row"><strong>${esc(item.year_label || '—')}</strong><span>${esc(item.grade_name || '—')}</span><span>${esc(item.section_name || '—')}</span><span>${esc(item.entry_classification || item.enrollment_type_name || '—')}</span><span>${esc(item.enrollment_status || '—')}</span></div>`).join('') || '<div class="rr-empty">No enrollment history found.</div>';
            $('rrModal').hidden = false;
            document.body.classList.add('modal-open');
        } catch (error) {
            if (typeof window.showNotification === 'function') window.showNotification(error.response?.data?.message || error.message || 'Could not open enrollment.', 'error');
        }
    }

    function closeModal() { $('rrModal').hidden = true; document.body.classList.remove('modal-open'); }
    $('rrStatus').addEventListener('change', loadRows);
    $('rrRefresh').addEventListener('click', loadRows);
    let timer;
    $('rrSearch').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(loadRows, 250); });
    $('rrClose').addEventListener('click', closeModal); $('rrDone').addEventListener('click', closeModal);
    $('rrModal').addEventListener('click', (event) => { if (event.target === $('rrModal')) closeModal(); });
    loadRows();
})();
