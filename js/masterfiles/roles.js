function getApiBaseUrl() {
    // dashboard.js resolves the API relative to the current application origin
    // (including a non-standard LAN port such as :8081). Use that value first
    // so this page cannot silently fall back to Apache on port 80.
    if (window.API_BASE) {
        return window.API_BASE;
    }

    const isApacheServed = String(window.location.pathname || '').includes('/deped_capstone2/');
    if (!isApacheServed) {
        return `${window.location.origin}/api`;
    }

    const pathname = String(window.location.pathname || '/');
    let appPrefix = '';
    if (pathname.includes('/dashboard/')) {
        appPrefix = pathname.split('/dashboard/')[0] || '';
    } else if (pathname.includes('/pages/')) {
        appPrefix = pathname.split('/pages/')[0] || '';
    } else if (pathname.includes('/assets/')) {
        appPrefix = pathname.split('/assets/')[0] || '';
    } else if (pathname.includes('/api/')) {
        appPrefix = pathname.split('/api/')[0] || '';
    } else if (pathname.endsWith('.html')) {
        appPrefix = pathname.substring(0, pathname.lastIndexOf('/')) || '';
    } else {
        appPrefix = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    }
    if (appPrefix === '/') appPrefix = '';
    return `${window.location.origin}${appPrefix}/api`;
}


const API_BASE_URL = getApiBaseUrl();

if (window.axios) {
    try {
        window.axios.defaults.withCredentials = true;
    } catch (_) {
        // ignore
    }
}

const rolesApi = {
    list: async () => axios.get(`${API_BASE_URL}/roles/roles.php`, { params: { operation: 'getAllRoles' } }).then(r => r.data),
    create: async (data) => axios.post(`${API_BASE_URL}/roles/roles.php?operation=createRole`, data).then(r => r.data),
    update: async (id, data) => axios.post(`${API_BASE_URL}/roles/roles.php?operation=updateRole`, { ...data, role_id: id }).then(r => r.data),
    remove: async (id) => axios.post(`${API_BASE_URL}/roles/roles.php?operation=archiveRole`, { role_id: id }).then(r => r.data)
};

document.addEventListener('DOMContentLoaded', () => {
    initializeMasterfile({
        key: 'roles',
        navKey: 'roles',
        entity: 'Role',
        pageTitle: 'Role Management',
        subtitle: 'Manage system roles and access labels',
        breadcrumb: 'Roles',
        disableAdd: true,
        primaryKey: 'role_id',
        columns: [
            { key: 'role_name', label: 'Role Name' }
        ],
        fields: [
            {
                key: 'role_name',
                label: 'Role Name',
                type: 'text',
                required: true,
                maxLength: 50,
                unique: true,
                uniqueMessage: 'Role name already taken. Choose a different role name.',
                helpText: 'Authorization seed. Keep the exact spelling; only letter case may be changed.'
            }
        ],
        validate(payload) {
            const record = MF_RECORDS.find(row => String(row.role_id) === String(MF_CURRENT_ID));
            const expected = {
                7: 'registrar',
                8: 'admin',
                9: 'teacher',
                10: 'learners',
                11: 'registrar'
            }[Number(record?.role_id)];
            if (expected && String(payload.role_name || '').trim().toLowerCase() !== expected) {
                return { role_name: `This seed must remain "${expected}"; letter case may vary, but the spelling cannot change.` };
            }
            return null;
        },
        api: rolesApi
    });
});
