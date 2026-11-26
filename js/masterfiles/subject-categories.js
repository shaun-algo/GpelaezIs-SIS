const API_BASE_URL = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;

const subjectCategoriesApi = {
    list: async () => axios.get(`${API_BASE_URL}/subject_categories/subject_categories.php`, { params: { operation: 'getAllSubjectCategories' } }).then(r => r.data),
    create: async (data) => axios.post(`${API_BASE_URL}/subject_categories/subject_categories.php?operation=createSubjectCategory`, data).then(r => r.data),
    update: async (id, data) => axios.post(`${API_BASE_URL}/subject_categories/subject_categories.php?operation=updateSubjectCategory`, { ...data, subject_category_id: id }).then(r => r.data),
    reorder: async (order) => axios.post(`${API_BASE_URL}/subject_categories/subject_categories.php?operation=reorderSubjectCategories`, { order }).then(r => r.data),
    remove: async (id) => axios.post(`${API_BASE_URL}/subject_categories/subject_categories.php?operation=archiveSubjectCategory`, { subject_category_id: id }).then(r => r.data)
};

let subjectCategoryDragId = null;
let subjectCategoryReordering = false;

function clearSubjectCategoryDragState() {
    subjectCategoryDragId = null;
    document.querySelectorAll('#dataTableBody tr.subject-category-dragging, #dataTableBody tr.subject-category-drag-over-before, #dataTableBody tr.subject-category-drag-over-after')
        .forEach(row => row.classList.remove('subject-category-dragging', 'subject-category-drag-over-before', 'subject-category-drag-over-after'));
}

function buildSubjectCategoryOrder(allRecords, draggedId, targetId, insertAfter) {
    const records = [...(allRecords || [])];
    const fromIndex = records.findIndex(row => String(row?.subject_category_id) === String(draggedId));
    const targetIndex = records.findIndex(row => String(row?.subject_category_id) === String(targetId));
    if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return null;

    const [moved] = records.splice(fromIndex, 1);
    let nextIndex = records.findIndex(row => String(row?.subject_category_id) === String(targetId));
    if (nextIndex < 0) return null;
    if (insertAfter) nextIndex += 1;
    records.splice(nextIndex, 0, moved);
    return records.map(row => Number(row?.subject_category_id)).filter(Boolean);
}

async function saveSubjectCategoryOrder(allRecords, draggedId, targetId, insertAfter) {
    if (subjectCategoryReordering) return;
    const order = buildSubjectCategoryOrder(allRecords, draggedId, targetId, insertAfter);
    if (!order) return;

    subjectCategoryReordering = true;
    try {
        const result = await subjectCategoriesApi.reorder(order);
        if (result?.success === false) throw new Error(result.message || 'Unable to save category order.');
        showNotification('Subject category order saved.');
        await loadRecords();
    } catch (error) {
        console.error('Subject category reorder error', error);
        showNotification(error?.response?.data?.message || error.message || 'Unable to save category order.', 'error');
    } finally {
        subjectCategoryReordering = false;
        clearSubjectCategoryDragState();
    }
}

function wireSubjectCategoryDragRows(pageRows, allRecords) {
    clearSubjectCategoryDragState();
    const searchTerm = document.getElementById('searchInput')?.value?.trim() || '';
    const records = Array.isArray(allRecords) ? allRecords : [];
    const rows = [...document.querySelectorAll('#dataTableBody tr.mf-record-row[data-row-id]')];
    const canReorder = !searchTerm && pageRows?.length === records.length && rows.length === records.length;
    if (!canReorder) return;

    rows.forEach(row => {
        const id = String(row.dataset.rowId || '');
        if (!id) return;
        row.draggable = true;
        row.classList.add('subject-category-sortable-row');

        const value = row.querySelector('.mf-record-value');
        if (value && !value.querySelector('[data-subject-category-drag-handle]')) {
            const handle = document.createElement('span');
            handle.className = 'subject-category-drag-handle';
            handle.dataset.subjectCategoryDragHandle = 'true';
            handle.title = 'Drag to reorder';
            handle.setAttribute('aria-label', 'Drag to reorder category');
            handle.innerHTML = '<i class="fas fa-grip-vertical" aria-hidden="true"></i>';
            handle.addEventListener('click', event => event.stopPropagation());
            value.prepend(handle);
        }

        row.addEventListener('dragstart', event => {
            if (subjectCategoryReordering) {
                event.preventDefault();
                return;
            }
            subjectCategoryDragId = id;
            row.classList.add('subject-category-dragging');
            event.dataTransfer?.setData('text/plain', id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });

        row.addEventListener('dragover', event => {
            if (!subjectCategoryDragId || subjectCategoryDragId === id || subjectCategoryReordering) return;
            event.preventDefault();
            const insertAfter = event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
            row.classList.toggle('subject-category-drag-over-before', !insertAfter);
            row.classList.toggle('subject-category-drag-over-after', insertAfter);
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        });

        row.addEventListener('dragleave', event => {
            if (!row.contains(event.relatedTarget)) {
                row.classList.remove('subject-category-drag-over-before', 'subject-category-drag-over-after');
            }
        });

        row.addEventListener('drop', event => {
            event.preventDefault();
            if (!subjectCategoryDragId || subjectCategoryDragId === id) return;
            const rect = row.getBoundingClientRect();
            const insertAfter = event.clientY > rect.top + rect.height / 2;
            saveSubjectCategoryOrder(records, subjectCategoryDragId, id, insertAfter);
        });

        row.addEventListener('dragend', clearSubjectCategoryDragState);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initializeMasterfile({
        key: 'subject_categories',
        navKey: 'subject-categories',
        entity: 'Subject Category',
        pageTitle: 'Subject Categories',
        subtitle: '',
        breadcrumb: 'Subject Categories',
        addLabel: 'Add Category',
        primaryKey: 'subject_category_id',
        itemsPerPage: 100,
        afterTableRender: (pageRows, allRecords) => wireSubjectCategoryDragRows(pageRows, allRecords),
        columns: [
            { key: 'category_name', label: 'Category' },
            { key: 'description', label: 'Description', mobileHidden: true }
        ],
        fields: [
            {
                key: 'category_name',
                label: 'Category Name',
                type: 'text',
                required: true,
                maxLength: 150,
                unique: true,
                uniqueMessage: 'This category name already exists. Choose a different name.'
            },
            { key: 'description', label: 'Description', type: 'text', maxLength: 255 },
        ],
        api: subjectCategoriesApi
    });
});
