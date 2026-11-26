const API_BASE_URL = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;

const subjectsApi = {
    list: async () => axios.get(`${API_BASE_URL}/subjects/subjects.php`, { params: { operation: 'getAllSubjects' } }).then(r => r.data),
    categories: async () => axios.get(`${API_BASE_URL}/subject_categories/subject_categories.php`, { params: { operation: 'getAllSubjectCategories', active_only: 1 } }).then(r => r.data),
    create: async (data) => axios.post(`${API_BASE_URL}/subjects/subjects.php?operation=createSubject`, data).then(r => r.data),
    update: async (id, data) => axios.post(`${API_BASE_URL}/subjects/subjects.php?operation=updateSubject`, { ...data, subject_id: id }).then(r => r.data),
    remove: async (id) => axios.post(`${API_BASE_URL}/subjects/subjects.php?operation=archiveSubject`, { subject_id: id }).then(r => r.data)
};

document.addEventListener('DOMContentLoaded', () => {
    initializeMasterfile({
        key: 'subjects',
        navKey: 'subjects',
        entity: 'Subject',
        pageTitle: 'Subject Catalog',
        subtitle: '',
        breadcrumb: 'Subjects',
        addLabel: 'Add Subject',
        primaryKey: 'subject_id',
        columns: [
            { key: 'subject_name', label: 'Subject Name' },
            { key: 'category_name', label: 'Category', formatter: value => value || 'Uncategorized' },
            { key: 'description', label: 'Description', mobileHidden: true }
        ],
        fields: [
            {
                key: 'subject_name',
                label: 'Subject Name',
                type: 'text',
                required: true,
                maxLength: 100,
                unique: true,
                uniqueMessage: 'Subject name already taken. Choose a different subject name.'
            },
            {
                key: 'subject_category_id',
                label: 'Subject Category',
                type: 'select',
                required: true,
                valueKey: 'subject_category_id',
                labelKey: 'category_name',
                loadOptions: () => subjectsApi.categories(),
                helpText: 'This category controls the divider where the subject appears in Curriculum Setup.'
            },
            { key: 'description', label: 'Description', type: 'text', maxLength: 255 }
        ],
        api: subjectsApi
    });
});
