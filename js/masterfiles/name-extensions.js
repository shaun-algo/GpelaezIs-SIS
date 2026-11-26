const API_BASE_URL = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;

const nameExtensionsApi = {
    list: async () => axios.get(`${API_BASE_URL}/name_extensions/name_extensions.php`, { params: { operation: 'getAllNameExtensions' } })
        .then(r => (Array.isArray(r.data) ? r.data : []).filter(row => String(row?.extension_name || '').trim() !== '')),
    create: async (data) => axios.post(`${API_BASE_URL}/name_extensions/name_extensions.php?operation=createNameExtension`, data).then(r => r.data),
    update: async (id, data) => axios.post(`${API_BASE_URL}/name_extensions/name_extensions.php?operation=updateNameExtension`, { ...data, extension_id: id }).then(r => r.data),
    remove: async (id) => axios.post(`${API_BASE_URL}/name_extensions/name_extensions.php?operation=deleteNameExtension`, { extension_id: id }).then(r => r.data)
};

document.addEventListener('DOMContentLoaded', () => {
    initializeMasterfile({
        key: 'name_extensions',
        navKey: 'name_extensions',
        entity: 'Name Extension',
        pageTitle: 'Name Extensions Masterfile',
        subtitle: 'Manage generational suffixes (lineage) used in learner and employee names',
        breadcrumb: 'Name Extensions',
        addLabel: 'Add Name Extension',
        primaryKey: 'extension_id',
        columns: [
            { key: 'extension_name', label: 'Extension' }
        ],
        fields: [
            {
                key: 'extension_name',
                label: 'Generational Suffix',
                type: 'text',
                required: true,
                maxLength: 10,
                pattern: "^[\\p{L}0-9\\s\\-'\\.]+$",
                patternFlags: 'u',
                patternMessage: 'Use letters, numbers, spaces, dashes, apostrophes, or periods.',
                unique: true,
                uniqueMessage: 'Name extension already taken. Choose a different extension.'
            }
        ],
        api: nameExtensionsApi
    });
});
