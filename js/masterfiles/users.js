function getApiBaseUrl() {
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
    return `${appPrefix}/api`;
}

// Reuse the dashboard base so LAN/device access keeps the current host,
// port, and deployment folder instead of using a hard-coded API URL.
const API_BASE_URL = String(window.API_BASE || getApiBaseUrl()).replace(/\/+$/, '');

if (window.axios) {
    try {
        window.axios.defaults.withCredentials = true;
    } catch (_) {
        // ignore
    }
}

const usersApi = {
    list: async () => axios.get(`${API_BASE_URL}/users/users.php`, { params: { operation: 'getAllUsers' } }).then(r => r.data),
    create: async (data) => axios.post(`${API_BASE_URL}/users/users.php?operation=createUser`, data).then(r => r.data),
    update: async (id, data) => axios.post(`${API_BASE_URL}/users/users.php?operation=updateUser`, { ...data, user_id: id }).then(r => r.data),
    remove: async (id) => axios.post(`${API_BASE_URL}/users/users.php?operation=deleteUser`, { user_id: id }).then(r => r.data),
};

const rolesApi = {
    list: async () => axios.get(`${API_BASE_URL}/roles/roles.php`, { params: { operation: 'getAllRoles' } }).then(r => r.data.filter(role => !/learner|student/i.test(role.role_name)))
};
const positionsApi = {
    list: async () => axios.get(`${API_BASE_URL}/positions/positions.php`, { params: { operation: 'getAllPositions' } }).then(r => r.data)
};
const nameExtensionsApi = {
    list: async () => axios.get(`${API_BASE_URL}/name_extensions/name_extensions.php`, { params: { operation: 'getAllNameExtensions', _: Date.now() } })
        .then(r => {
            const rows = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.rows) ? r.data.rows : (Array.isArray(r.data?.data) ? r.data.data : []));
            return rows.filter(option => String(option?.extension_name || '').trim() !== '');
        })
};

function formatEmployeeFullName(row) {
    const first = (row?.first_name || '').trim();
    const middle = (row?.middle_name || '').trim();
    const last = (row?.last_name || '').trim();
    const ext = (row?.name_extension || '').trim();
    return [first, middle, last, ext].filter(Boolean).join(' ');
}

function maskEmployeeNumber(value) {
    const s = String(value ?? '').trim();
    if (!s) return '';

    const first2 = s.slice(0, 2);
    const next2 = s.slice(2, 4);
    const last1 = s.slice(-1);

    if (s.length <= 4) {
        return `${first2}**${last1}`;
    }

    return `${first2}**${next2}**${last1}`;
}

function computeAge(isoDate) {
    if (!isoDate) return null;
    const birth = new Date(isoDate);
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const monthDiff = now.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
        age -= 1;
    }
    return age;
}

function todayIso() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function setCurrentUserSelect(field, options, record) {
    populateSelect(field, options);
    const select = document.getElementById(`field-${field.key}`);
    if (!select) return;

    const value = record?.[field.key];
    if (value === null || value === undefined || String(value).trim() === '') {
        select.value = '';
        return;
    }

    const valueText = String(value);
    let option = Array.from(select.options).find(item => String(item.value) === valueText);
    if (!option) {
        option = document.createElement('option');
        option.value = valueText;
        option.textContent = String(record?.[field.optionLabelKey] || record?.[field.viewDisplayKey] || valueText);
        select.appendChild(option);
    }
    select.value = valueText;
}

async function refreshCurrentUserReferenceSelections(record) {
    const roleField = {
        key: 'role_id',
        label: 'System Role',
        valueKey: 'role_id',
        labelKey: 'role_name',
        optionLabelKey: 'role_name',
        viewDisplayKey: 'role_name'
    };
    const positionField = {
        key: 'position_id',
        label: 'Work Position',
        valueKey: 'position_id',
        labelKey: 'position_name',
        optionLabelKey: 'position_name',
        viewDisplayKey: 'position_name'
    };
    const [roles, positions] = await Promise.all([rolesApi.list(), positionsApi.list()]);
    setCurrentUserSelect(roleField, roles, record);
    setCurrentUserSelect(positionField, positions, record);
}

const EMPLOYEE_NAME_PATTERN = "^[\\p{L}\\s\\-'\\.]+$";
const EMPLOYEE_NAME_PATTERN_FLAGS = 'u';

document.addEventListener('DOMContentLoaded', async () => {
    const me = await axios.get(`${API_BASE_URL}/auth/me.php`).then(r => r.data.data);
    initializeMasterfile({
        key: 'users', navKey: 'users', entity: 'User', pageTitle: 'User Management',
        subtitle: '',
        breadcrumb: 'Users', addLabel: 'Add User', primaryKey: 'user_id', enableView: true,
        beforeOpenEdit: refreshCurrentUserReferenceSelections,
        hideActions: me.role_key === 'registrar',
        columns: [
            {
                key: 'full_name',
                label: 'Full Name',
                formatter: (_v, row) => {
                    const name = formatEmployeeFullName(row) || 'Profile not yet added';
                    if (!row?.user_id) return mfEscapeAttr(name);
                    const href = `${window.APP_BASE || ''}/pages/profile.html?user_id=${encodeURIComponent(row.user_id)}`;
                    const approvedBadgeMarkup = typeof renderDeveloperApprovedBadgeMarkup === 'function'
                        ? renderDeveloperApprovedBadgeMarkup(row)
                        : '';
                    return `<a class="profile-user-link profile-user-link--name" href="${mfEscapeAttr(href)}">${mfEscapeAttr(name)}${approvedBadgeMarkup}</a>`;
                }
            },
            { key: 'employee_number', label: 'Employee #' },
            { key: 'role_name', label: 'System Role' },
        ],
        validate(payload) {
            const errors = {};
            const record = MF_RECORDS.find(row => String(row.user_id) === String(MF_CURRENT_ID));
            const profileKeys = ['employee_number', 'first_name', 'middle_name', 'last_name', 'name_extension', 'date_of_birth', 'gender', 'contact_number', 'email', 'address', 'position_id', 'date_hired'];
            const needsProfile = !MF_CURRENT_ID || record?.employee_id || profileKeys.some(key => payload[key] != null && String(payload[key]).trim() !== '');
            if (needsProfile) {
                for (const [key, label] of [['employee_number', 'Employee number'], ['first_name', 'First name'], ['last_name', 'Last name']]) {
                    if (!String(payload[key] || '').trim()) errors[key] = `${label} is required.`;
                }
            }
            if (payload.date_of_birth && payload.date_hired && payload.date_hired < payload.date_of_birth) errors.date_hired = 'Date hired cannot be earlier than birth date.';
            return Object.keys(errors).length ? errors : null;
        },
        fieldSections: [
            {
                title: 'Account Details',
                fields: [
                    { key: 'role_id', label: 'System Role', type: 'select', required: true, valueKey: 'role_id', labelKey: 'role_name', optionLabelKey: 'role_name', viewDisplayKey: 'role_name', loadOptions: rolesApi.list },
                    { key: 'is_active', label: 'Account Status', type: 'text', readonly: true, hideOnAdd: true, displayTransform: value => Number(value) === 1 ? 'Active' : 'Inactive' },
                ]
            },
            {
                title: 'Employment Details',
                fields: [
                    {
                        key: 'employee_number',
                        label: 'Employee #',
                        type: 'text',
                        maxLength: 50,
                        pattern: '^[A-Za-z0-9\\-_.]+$',
                        patternMessage: 'Employee number may only contain letters, numbers, dashes, underscores, and periods.'
                    },
                    {
                        key: 'position_id',
                        label: 'Work Position',
                        type: 'select',
                        valueKey: 'position_id',
                        labelKey: 'position_name',
                        optionLabelKey: 'position_name',
                        viewDisplayKey: 'position_name',
                        loadOptions: async () => await positionsApi.list()
                    },
                    {
                        key: 'date_hired',
                        label: 'Date Hired',
                        type: 'text',
                        placeholder: 'MM/DD/YYYY',
                        mask: 'date',
                        transform: (value) => {
                            const s = String(value || '').trim();
                            if (!s) return null;
                            const [m, d, y] = s.split('/');
                            if (!m || !d || !y) return s;
                            const mm = m.padStart(2, '0');
                            const dd = d.padStart(2, '0');
                            const yyyy = y.length === 2 ? `20${y}` : y;
                            return `${yyyy}-${mm}-${dd}`;
                        },
                        displayTransform: (value) => {
                            const s = String(value || '').trim();
                            if (!s) return '';
                            const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                            if (isoMatch) return `${isoMatch[2]}/${isoMatch[3]}/${isoMatch[1]}`;
                            return s;
                        },
                        validate(value) {
                            if (!value) return null;
                            if (value > todayIso()) return 'Date hired cannot be in the future.';
                            return null;
                        }
                    }
                ]
            },
            {
                title: 'Personal Information',
                fields: [
                    {
                        key: 'last_name',
                        label: 'Last Name',
                        type: 'text',
                        maxLength: 100,
                        pattern: EMPLOYEE_NAME_PATTERN,
                        patternFlags: EMPLOYEE_NAME_PATTERN_FLAGS,
                        patternMessage: 'Last name may only contain letters, spaces, dashes, apostrophes, and periods.'
                    },
                    {
                        key: 'first_name',
                        label: 'First Name',
                        type: 'text',
                        maxLength: 100,
                        pattern: EMPLOYEE_NAME_PATTERN,
                        patternFlags: EMPLOYEE_NAME_PATTERN_FLAGS,
                        patternMessage: 'First name may only contain letters, spaces, dashes, apostrophes, and periods.'
                    },
                    {
                        key: 'middle_name',
                        label: 'Middle Name',
                        type: 'text',
                        maxLength: 100,
                        pattern: EMPLOYEE_NAME_PATTERN,
                        patternFlags: EMPLOYEE_NAME_PATTERN_FLAGS,
                        patternMessage: 'Middle name may only contain letters, spaces, dashes, apostrophes, and periods.'
                    },
                    {
                        key: 'name_extension',
                        label: 'Name Extension',
                        type: 'select',
                        valueKey: 'extension_name',
                        labelKey: 'extension_name',
                        loadOptions: nameExtensionsApi.list
                    },
                    {
                        key: 'date_of_birth',
                        label: 'Birth Date',
                        type: 'text',
                        placeholder: 'MM/DD/YYYY',
                        mask: 'date',
                        transform: (value) => {
                            const s = String(value || '').trim();
                            if (!s) return null;
                            const [m, d, y] = s.split('/');
                            if (!m || !d || !y) return s;
                            const mm = m.padStart(2, '0');
                            const dd = d.padStart(2, '0');
                            const yyyy = y.length === 2 ? `20${y}` : y;
                            return `${yyyy}-${mm}-${dd}`;
                        },
                        displayTransform: (value) => {
                            const s = String(value || '').trim();
                            if (!s) return '';
                            const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                            if (isoMatch) return `${isoMatch[2]}/${isoMatch[3]}/${isoMatch[1]}`;
                            return s;
                        },
                        validate(value) {
                            if (!value) return null;
                            if (value > todayIso()) return 'Birth date cannot be in the future.';
                            const age = computeAge(value);
                            if (age === null) return null;
                            if (age < 18) return 'Employee must be at least 18 years old.';
                            if (age > 100) return 'Birth date appears unrealistic.';
                            return null;
                        }
                    },
                    {
                        key: 'gender',
                        label: 'Gender',
                        type: 'select',
                        valueKey: 'value',
                        labelKey: 'label',
                        loadOptions: async () => ([
                            { value: 'Male', label: 'Male' },
                            { value: 'Female', label: 'Female' },
                            { value: 'Other', label: 'Other' }
                        ])
                    }
                ]
            },
            {
                title: 'Contact Information',
                fields: [
                    {
                        key: 'contact_number',
                        label: 'Contact #',
                        type: 'text',
                        maxLength: 20,
                        validate(value) {
                            if (!value) return null;
                            const digits = String(value).replace(/\D/g, '');
                            const valid =
                                /^09\d{9}$/.test(digits) ||
                                /^639\d{9}$/.test(digits) ||
                                /^9\d{9}$/.test(digits);
                            if (!valid) return 'Contact number must be a valid PH mobile number.';
                            return null;
                        }
                    },
                    {
                        key: 'email',
                        label: 'Email Address',
                        placeholder: 'firstname.lastname@deped.gov.ph',
                        helpText: 'Use your DepEd email if available for consistent school communication. Other valid email addresses are accepted.',
                        type: 'email',
                        maxLength: 150,
                        pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
                        patternMessage: 'Please enter a valid email address.'
                    },
                    { key: 'address', label: 'Address', type: 'text' }
                ]
            }
        ],
        api: usersApi
    });
});

function accountStatusBadge(value) {
    const active = Number(value) === 1;
    return `<span class="status-badge ${active ? 'active' : 'inactive'}">${active ? 'Active' : 'Inactive'}</span>`;
}
