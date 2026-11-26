function getAppBaseUrl() {
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
    return appPrefix;
}

const API_BASE_URL = window.API_BASE || `${getAppBaseUrl()}/api`;

// Keep session cookies when applicable.
axios.defaults.withCredentials = true;
let currentUser = null;
let profileUser = null;
let viewingOtherProfile = false;
let editingAnnouncementId = null;
let profileAnnouncements = [];
let profileInfoEmployee = null;
let profileInfoPositions = [];
let profileInfoNameExtensions = [];
let profileInfoLoaded = false;
let profileInfoLoading = false;
let profileActivitiesLoading = false;
let profileActivities = [];
let profileActivitiesOffset = 0;
let profileActivitiesHasMore = false;
let profileActivityOpenId = null;
let profileNameFitFrame = 0;
const PROFILE_ACTIVITY_PAGE_SIZE = 10;

function isLearnerRole(roleName, roleId = 0, roleKey = '') {
    const normalized = String(roleName || '').trim().toLowerCase();
    const normalizedKey = String(roleKey || '').trim().toLowerCase();
    return Number(roleId) === 10
        || normalizedKey === 'learners'
        || normalized.includes('learner')
        || normalized.includes('student');
}

function canCurrentUserPostAnnouncements() {
    if (!currentUser) return false;
    return !isLearnerRole(currentUser.role_name, currentUser.role_id, currentUser.role_key);
}

function isLearnerOwnProfileView() {
    return !viewingOtherProfile
        && isLearnerRole(currentUser?.role_name, currentUser?.role_id, currentUser?.role_key);
}

function applyAnnouncementPostingPermissions() {
    if (!currentUser) return;

    if (viewingOtherProfile) {
        const composeCard = document.getElementById('composeCard');
        const modal = document.getElementById('createAnnouncementModal');
        const createBtn = document.getElementById('createAnnouncementBtn');
        const composerSection = document.querySelector('.announcement-composer-top');
        if (composeCard) composeCard.style.display = 'none';
        if (createBtn) createBtn.style.display = 'none';
        if (modal) modal.classList.remove('active');
        if (composerSection) composerSection.style.display = 'none';
        return;
    }

    if (canCurrentUserPostAnnouncements()) return;

    const composeCard = document.getElementById('composeCard');
    const modal = document.getElementById('createAnnouncementModal');
    const createBtn = document.getElementById('createAnnouncementBtn');
    if (composeCard) composeCard.style.display = 'none';
    if (createBtn) createBtn.style.display = 'none';
    if (modal) modal.classList.remove('active');

    const composerSection = document.querySelector('.announcement-composer-top');
    const postsSection = document.querySelector('.profile-posts');
    if (composerSection) composerSection.style.display = 'none';
    if (postsSection) postsSection.style.display = 'none';
}

function getRequestedProfileUserId() {
    const rawUserId = new URLSearchParams(window.location.search).get('user_id');
    const userId = Number(rawUserId);
    return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function applyProfileViewMode() {
    const options = document.querySelector('.profile-options');
    const toggle = document.getElementById('profileOptionsToggle');
    const menu = document.getElementById('profileOptionsMenu');
    const saveButton = document.getElementById('profileInfoSave');
    const privateFields = document.querySelectorAll('[data-profile-private-field]');
    const activitiesItem = menu?.querySelector('[data-profile-view="activities"]');
    const readOnlyProfile = viewingOtherProfile || isLearnerOwnProfileView();

    document.body.classList.toggle('public-profile-view', viewingOtherProfile);
    document.body.classList.toggle('learner-own-profile-view', isLearnerOwnProfileView());
    if (options) options.hidden = false;
    if (toggle) {
        toggle.disabled = false;
        toggle.setAttribute('aria-hidden', 'false');
        toggle.setAttribute(
            'aria-label',
            viewingOtherProfile ? 'Open public profile sections' : 'Open profile options'
        );
        toggle.setAttribute(
            'title',
            viewingOtherProfile ? 'Public profile sections' : 'Profile options'
        );
    }
    if (activitiesItem) {
        activitiesItem.hidden = viewingOtherProfile;
        activitiesItem.setAttribute('aria-hidden', String(viewingOtherProfile));
    }
    if (menu && viewingOtherProfile) {
        menu.hidden = true;
        menu.classList.remove('is-open');
        menu.setAttribute('aria-hidden', 'true');
    }
    if (saveButton) saveButton.hidden = readOnlyProfile;

    privateFields.forEach((field) => {
        field.hidden = viewingOtherProfile;
    });

    applyAnnouncementPostingPermissions();
}

function applyStudentRecoveryPermission() {
    const link = document.querySelector('#userDropdown [data-student-recovery]');
    if (!link || !currentUser) return;

    const roleId = Number(currentUser.role_id || 0);
    const roleKey = String(currentUser.role_key || currentUser.role_name || '').trim().toLowerCase();
    const canReview = [7, 8, 9, 11].includes(roleId)
        || roleKey === 'teacher'
        || roleKey === 'adviser'
        || roleKey === 'advisor'
        || roleKey === 'registrar'
        || roleKey === 'admin';
    link.hidden = !canReview;
    link.setAttribute('aria-hidden', String(!canReview));
}

document.addEventListener('DOMContentLoaded', () => {
    if (window.location.protocol === 'file:') {
        showNotification('Open this page via http://localhost/deped_capstone2/ so login/session works.', 'error');
        return;
    }

    // Apply public-view defaults immediately for a requested profile;
    // loadCurrentUser() will restore owner-only controls if the requested ID is the viewer.
    viewingOtherProfile = Boolean(getRequestedProfileUserId());
    applyProfileViewMode();
    initializeProfileOptions();
    initializeProfileInfo();
    initializeProfileActivities();
    initializeComposerFeatures();
    initializeComposeHandlers();
    initializeReadMoreToggle();
    initializeAnnouncementActions();
    loadCurrentUser();
    loadRoles();
    window.addEventListener('resize', scheduleProfileNameFit, { passive: true });
    scheduleProfileNameFit();
});

function initializeProfileOptions() {
    const options = document.querySelector('.profile-options');
    const toggle = document.getElementById('profileOptionsToggle');
    const menu = document.getElementById('profileOptionsMenu');
    if (!options || !toggle || !menu) return;

    const getToggleLabel = (isOpen) => {
        if (isOpen) return viewingOtherProfile ? 'Close public profile sections' : 'Close profile options';
        return viewingOtherProfile ? 'Open public profile sections' : 'Open profile options';
    };

    const closeMenu = (restoreFocus = false) => {
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', getToggleLabel(false));
        menu.classList.remove('is-open');
        menu.setAttribute('aria-hidden', 'true');
        menu.hidden = true;
        if (restoreFocus) toggle.focus();
    };

    const openMenu = () => {
        menu.hidden = false;
        menu.setAttribute('aria-hidden', 'false');
        toggle.setAttribute('aria-expanded', 'true');
        toggle.setAttribute('aria-label', getToggleLabel(true));
        requestAnimationFrame(() => {
            menu.classList.add('is-open');
            requestAnimationFrame(() => menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true }));
        });
    };

    toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const isOpen = toggle.getAttribute('aria-expanded') === 'true';
        if (isOpen) closeMenu();
        else openMenu();
    });

    menu.querySelectorAll('[data-profile-view]').forEach((item) => {
        item.addEventListener('click', (event) => {
            event.preventDefault();
            setProfileView(item.dataset.profileView);
        });
    });

    menu.addEventListener('click', () => closeMenu());

    document.addEventListener('click', (event) => {
        if (!options.contains(event.target)) closeMenu();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
            event.preventDefault();
            closeMenu(true);
        }
    });
}

function initializeProfileInfo() {
    const form = document.getElementById('profileInfoForm');
    const backButton = document.getElementById('profileInfoBackToPosts');

    if (form) form.addEventListener('submit', saveProfileInfo);
    if (backButton) backButton.addEventListener('click', () => setProfileView('posts'));
    document.querySelectorAll('[data-profile-section]').forEach((tab) => {
        tab.addEventListener('click', () => setProfileInfoSection(tab.dataset.profileSection));
    });
    setProfileInfoSection('personal');
}

function initializeProfileActivities() {
    const refreshButton = document.getElementById('profileActivitiesRefresh');
    const loadMoreButton = document.getElementById('profileActivitiesLoadMore');
    const backButton = document.getElementById('profileActivitiesBackToPosts');
    const feed = document.getElementById('profileActivitiesFeed');

    refreshButton?.addEventListener('click', () => loadProfileActivities());
    loadMoreButton?.addEventListener('click', () => loadProfileActivities({ append: true }));
    backButton?.addEventListener('click', () => setProfileView('posts'));
    feed?.addEventListener('click', (event) => {
        const row = event.target.closest('.profile-activity-row');
        const item = row?.closest('.profile-activity-item');
        const toggle = item?.querySelector('[data-profile-activity-toggle]');
        const interactive = event.target.closest('a, button, input, select, textarea');
        if (row && item && toggle && (!interactive || interactive === toggle)) {
            const id = String(toggle.dataset.profileActivityToggle || '');
            profileActivityOpenId = profileActivityOpenId === id ? null : id;
            renderProfileActivities(profileActivities);
            return;
        }
        if (event.target.closest('[data-profile-activities-retry]')) {
            void loadProfileActivities();
        }
    });
}

function setProfileInfoSection(section) {
    const activeSection = section === 'work' ? 'work' : 'personal';

    document.querySelectorAll('[data-profile-section]').forEach((tab) => {
        const isActive = tab.dataset.profileSection === activeSection;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
    });

    document.querySelectorAll('[data-profile-section][role="tab"]').forEach((tab) => {
        const panelId = tab.getAttribute('aria-controls');
        const panel = panelId ? document.getElementById(panelId) : null;
        if (panel) panel.hidden = tab.dataset.profileSection !== activeSection;
    });
}

function setProfileView(view) {
    const normalizedView = viewingOtherProfile
        ? (view === 'profile-info' ? 'profile-info' : 'posts')
        : (view === 'profile-info' || view === 'activities' ? view : 'posts');
    const isPosts = normalizedView === 'posts';
    const isProfileInfo = normalizedView === 'profile-info';
    const isActivities = normalizedView === 'activities';
    const profileInfoPanel = document.getElementById('profileInfoPanel');
    const activitiesPanel = document.getElementById('profileActivitiesPanel');
    const composer = document.querySelector('.announcement-composer-top');
    const posts = document.querySelector('.profile-posts');

    if (profileInfoPanel) {
        profileInfoPanel.hidden = !isProfileInfo;
        profileInfoPanel.setAttribute('aria-hidden', String(!isProfileInfo));
    }
    if (activitiesPanel) {
        activitiesPanel.hidden = !isActivities;
        activitiesPanel.setAttribute('aria-hidden', String(!isActivities));
    }
    if (composer) composer.hidden = !isPosts;
    if (posts) posts.hidden = !isPosts;

    document.querySelectorAll('[data-profile-view]').forEach((item) => {
        item.setAttribute('aria-current', item.dataset.profileView === normalizedView ? 'page' : 'false');
    });

    if (isProfileInfo && !profileInfoLoaded && !profileInfoLoading) {
        loadProfileInfo();
    }
    if (isActivities && !profileActivitiesLoading) {
        loadProfileActivities();
    }
}

async function loadProfileInfo() {
    if (viewingOtherProfile) {
        loadPublicProfileInfo();
        return;
    }

    if (isLearnerOwnProfileView()) {
        fillProfileInfoForm(currentUser);
        setProfileInfoEditable(false);
        setProfileInfoStatus('Learner account details are view-only. Contact school staff for corrections.', 'empty');
        profileInfoLoaded = true;
        return;
    }

    profileInfoLoading = true;
    setProfileInfoStatus('Loading profile information...', 'loading');

    try {
        const response = await axios.get(`${API_BASE_URL}/employees/employees.php?operation=getMyEmployee`);
        if (!response.data?.success) {
            throw new Error(response.data?.message || 'Unable to load profile information.');
        }

        profileInfoEmployee = response.data.data || null;
        if (!profileInfoEmployee) {
            fillProfileInfoForm({
                ...currentUser,
                employee_number: currentUser?.username || '',
                role_name: currentUser?.role_name || ''
            });
            setProfileInfoEditable(false);
            setProfileInfoStatus('No employee profile is linked to this account yet.', 'empty');
            profileInfoLoaded = true;
            return;
        }

        await Promise.all([loadProfileInfoPositions(), loadProfileInfoNameExtensions()]);
        fillProfileInfoForm(profileInfoEmployee);
        setProfileInfoEditable(true);
        setProfileInfoStatus('', '');
        profileInfoLoaded = true;
    } catch (error) {
        console.error('Error loading profile information:', error);
        fillProfileInfoForm({
            ...currentUser,
            employee_number: currentUser?.username || '',
            role_name: currentUser?.role_name || ''
        });
        setProfileInfoEditable(false);
        setProfileInfoStatus('Profile information is temporarily unavailable. Please try again later.', 'error');
    } finally {
        profileInfoLoading = false;
    }
}

function loadPublicProfileInfo() {
    if (!profileUser) return;

    fillProfileInfoForm(profileUser);
    setProfileInfoEditable(false);
    setProfileInfoStatus('Only public profile details are shown.', 'empty');
    profileInfoLoaded = true;
}

const PROFILE_ACTIVITY_ENTITIES = {
    announcements: 'announcement',
    attendance: 'attendance record',
    class_offerings: 'class offering',
    class_schedules: 'class schedule',
    civil_statuses: 'civil status',
    education_levels: 'education level',
    employees: 'employee profile',
    enrollments: 'enrollment',
    enrollment_types: 'enrollment type',
    emergency_contacts: 'emergency contact',
    family_members: 'family member',
    family_relationships: 'family relationship',
    final_grades: 'final grade',
    general_averages: 'general average',
    grade_levels: 'grade level',
    grades: 'grade record',
    grading_periods: 'grading period',
    honor_levels: 'honor level',
    indigenous_groups: 'indigenous group',
    interventions: 'intervention',
    intervention_statuses: 'intervention status',
    learners: 'learner',
    learner_statuses: 'learner status',
    mother_tongues: 'mother tongue',
    name_extensions: 'name extension',
    notification_types: 'notification type',
    positions: 'position',
    religions: 'religion',
    report_cards: 'report card',
    risk_assessments: 'risk assessment',
    risk_indicators: 'risk indicator',
    risk_levels: 'risk level',
    roles: 'role',
    school_settings: 'school setting',
    school_years: 'school year',
    sections: 'section',
    subject_codes: 'subject code',
    subjects: 'subject',
    users: 'user account'
};

function setProfileActivitiesState(markup) {
    const feed = document.getElementById('profileActivitiesFeed');
    if (feed) feed.innerHTML = markup;
}

function parseProfileActivityValues(values) {
    if (!values) return null;
    if (typeof values === 'object') return values;
    try {
        const parsed = JSON.parse(values);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
        return null;
    }
}

function profileActivityValue(values, ...keys) {
    for (const key of keys) {
        const value = values?.[key];
        if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
    return '';
}

function profileActivityPersonName(values) {
    const displayName = profileActivityValue(values, 'display_name', 'person_name', 'employee_name', 'learner_name');
    if (displayName) return String(displayName).trim();

    return [values?.first_name, values?.middle_name, values?.last_name, values?.name_extension]
        .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function profileActivityQuoted(value) {
    const text = String(value || '').trim();
    return text ? `“${text}”` : '';
}

function profileActivityRoleLabel(value) {
    return String(value || '')
        .trim()
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function profileActivityArticle(value) {
    return /^[aeiou]/i.test(String(value || '').trim()) ? 'an' : 'a';
}

function profileActivityFieldLabel(field) {
    const labels = {
        is_active: 'account status',
        role_id: 'role',
        role_name: 'role',
        target_role_id: 'audience',
        title: 'title',
        body: 'post content',
        is_pinned: 'pinned status',
        username: 'username',
        first_name: 'first name',
        middle_name: 'middle name',
        last_name: 'last name',
        position_id: 'position',
        date_hired: 'date hired',
        email: 'email',
        contact_number: 'contact number'
    };
    if (labels[field]) return labels[field];
    return String(field || 'value')
        .replace(/_id$/, '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
        .toLowerCase();
}

function profileActivityDisplayValue(value) {
    if (value === null || value === undefined || String(value).trim() === '') return 'blank';
    if (typeof value === 'boolean') return value ? 'enabled' : 'disabled';
    return String(value).trim();
}

function profileActivityChangedFields(oldValues, newValues) {
    if (!oldValues || !newValues) return [];
    const keys = new Set([...Object.keys(oldValues), ...Object.keys(newValues)]);
    return [...keys]
        .filter((key) => JSON.stringify(oldValues[key]) !== JSON.stringify(newValues[key]))
        .map((field) => ({
            field,
            oldValue: oldValues[field],
            newValue: newValues[field]
        }));
}

function humanizeProfileActivityEntity(tableName) {
    const normalized = String(tableName || '').trim().toLowerCase();
    if (PROFILE_ACTIVITY_ENTITIES[normalized]) return PROFILE_ACTIVITY_ENTITIES[normalized];

    return normalized
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
        .trim() || 'record';
}

function getProfileActivityPresentation(activity) {
    const action = String(activity?.action || '').trim().toUpperCase();
    const tableName = String(activity?.table_name || '').trim().toLowerCase();
    const oldValues = parseProfileActivityValues(activity?.old_values);
    const newValues = parseProfileActivityValues(activity?.new_values);
    const values = newValues || oldValues || {};
    const entity = humanizeProfileActivityEntity(tableName);
    const article = profileActivityArticle(entity);
    const activityName = profileActivityPersonName(values) || profileActivityPersonName(oldValues);
    const title = profileActivityValue(newValues, 'title') || profileActivityValue(oldValues, 'title');
    const roleName = profileActivityRoleLabel(
        profileActivityValue(newValues, 'role_name') || profileActivityValue(oldValues, 'role_name')
    ) || 'staff';
    const username = profileActivityValue(newValues, 'username') || profileActivityValue(oldValues, 'username');
    const changedFields = profileActivityChangedFields(oldValues, newValues);

    if (action === 'LOGIN') {
        const loginSucceeded = String(activity?.status || '').toUpperCase() === 'SUCCESS';
        return {
            message: loginSucceeded
                ? 'You signed in'
                : 'Someone tried to sign in using your account, but it did not go through',
            icon: 'fa-arrow-right-to-bracket',
            tone: loginSucceeded ? 'is-recorded' : 'is-reported',
            entity: 'Sign-in'
        };
    }

    if (action === 'LOGOUT') {
        return { message: 'You signed out', icon: 'fa-arrow-right-from-bracket', tone: 'is-recorded', entity: 'Sign-out' };
    }

    if (action === 'PASSWORD_CHANGE') {
        return { message: 'You changed your password', icon: 'fa-key', tone: 'is-updated', entity: 'Password' };
    }

    if (action === 'PASSWORD_RESET') {
        return { message: 'You reset your password', icon: 'fa-key', tone: 'is-updated', entity: 'Password' };
    }

    if (tableName === 'account_deactivation_requests' && action === 'DEACTIVATION_REQUEST') {
        return { message: 'You requested account deactivation', icon: 'fa-user-slash', tone: 'is-reported', entity: 'Account security' };
    }

    if (tableName === 'account_deactivation_requests' && action === 'DEACTIVATION_REQUEST_REVIEW') {
        return { message: 'You reviewed an account deactivation request', icon: 'fa-user-check', tone: 'is-updated', entity: 'Account security' };
    }

    if (tableName === 'users' && action === 'ACCOUNT_DEACTIVATED') {
        return { message: 'You deactivated an account after an approved request', icon: 'fa-user-slash', tone: 'is-removed', entity: 'Account security' };
    }

    if (tableName === 'users' && action === 'ACCOUNT_REACTIVATED') {
        return { message: 'You reactivated a user account', icon: 'fa-user-check', tone: 'is-added', entity: 'Account security' };
    }

    if (tableName === 'account_deactivation_requests' && action === 'ACCOUNT_REACTIVATION') {
        return { message: 'You tried to reactivate a user account, but it did not go through', icon: 'fa-user-check', tone: 'is-reported', entity: 'Account security' };
    }

    if (tableName === 'announcements' && ['INSERT', 'CREATE'].includes(action)) {
        return {
            message: `You posted${title ? ` ${profileActivityQuoted(title)}` : ' a post'}`,
            icon: 'fa-bullhorn', tone: 'is-posted', entity: 'Post'
        };
    }

    if (tableName === 'announcements' && action === 'REPORT') {
        return {
            message: `You reported${title ? ` the post ${profileActivityQuoted(title)}` : ' a post'}`,
            icon: 'fa-flag', tone: 'is-reported', entity: 'Reported post'
        };
    }

    if (tableName === 'announcements' && action === 'REPORT_REVIEW') {
        return {
            message: `You reviewed${title ? ` the report for ${profileActivityQuoted(title)}` : ' a post report'}`,
            icon: 'fa-clipboard-check', tone: 'is-updated', entity: 'Post report'
        };
    }

    if (tableName === 'announcements' && action === 'UPDATE') {
        return {
            message: `You updated your post${title ? ` ${profileActivityQuoted(title)}` : ''}`,
            icon: 'fa-pen', tone: 'is-updated', entity: 'Post'
        };
    }

    if (tableName === 'announcements' && action === 'DELETE') {
        return {
            message: `You removed your post${title ? ` ${profileActivityQuoted(title)}` : ''}`,
            icon: 'fa-trash-can', tone: 'is-removed', entity: 'Post'
        };
    }

    if (tableName === 'users') {
        const accountName = activityName || username || 'the staff account';
        if (['INSERT', 'CREATE'].includes(action)) {
            return {
                message: `You added ${accountName}${roleName ? ` as ${roleName}` : ''}`,
                icon: 'fa-user-plus', tone: 'is-added', entity: 'Staff account'
            };
        }

        if (action === 'UPDATE') {
            const roleChange = changedFields.find(({ field }) => ['role_id', 'role_name'].includes(field));
            if (roleChange) {
                const oldRole = profileActivityRoleLabel(profileActivityValue(oldValues, 'role_name') || profileActivityDisplayValue(roleChange.oldValue));
                const newRole = profileActivityRoleLabel(profileActivityValue(newValues, 'role_name') || profileActivityDisplayValue(roleChange.newValue));
                return {
                    message: `You updated ${accountName}'s role from ${oldRole} to ${newRole}`,
                    icon: 'fa-user-pen', tone: 'is-updated', entity: 'Role'
                };
            }
            return {
                message: `You updated ${accountName}'s account`,
                icon: 'fa-user-pen', tone: 'is-updated', entity: 'Staff account'
            };
        }

        if (action === 'DELETE') {
            return {
                message: `You removed ${accountName}'s account`,
                icon: 'fa-user-minus', tone: 'is-removed', entity: 'Staff account'
            };
        }
    }

    if (tableName === 'roles') {
        const oldRole = profileActivityRoleLabel(profileActivityValue(oldValues, 'role_name'));
        const newRole = profileActivityRoleLabel(profileActivityValue(newValues, 'role_name'));
        if (['INSERT', 'CREATE'].includes(action)) {
            return { message: `You added the ${newRole} role`, icon: 'fa-user-tag', tone: 'is-added', entity: 'Role' };
        }
        if (action === 'UPDATE') {
            return {
                message: oldRole && newRole
                    ? `You updated the role value from ${oldRole} to ${newRole}`
                    : `You updated the ${newRole || oldRole || 'role'} value`,
                icon: 'fa-pen', tone: 'is-updated', entity: 'Role'
            };
        }
        if (action === 'DELETE') {
            return { message: `You removed the ${oldRole || 'role'} role`, icon: 'fa-trash-can', tone: 'is-removed', entity: 'Role' };
        }
    }

    if (activityName) {
        if (['INSERT', 'CREATE'].includes(action)) {
            return { message: `You added ${profileActivityQuoted(activityName)} as ${article} ${entity}`, icon: 'fa-plus', tone: 'is-added', entity };
        }
        if (action === 'UPDATE') {
            const firstChange = changedFields.find(({ field }) => !['updated_at', 'created_at'].includes(field));
            const changeText = firstChange
                ? `: ${profileActivityFieldLabel(firstChange.field)} changed to ${profileActivityDisplayValue(firstChange.newValue)}`
                : '';
            return { message: `You updated ${profileActivityQuoted(activityName)}${changeText}`, icon: 'fa-pen', tone: 'is-updated', entity };
        }
        if (action === 'DELETE') {
            return { message: `You removed ${profileActivityQuoted(activityName)} ${entity.toLowerCase()}`, icon: 'fa-trash-can', tone: 'is-removed', entity };
        }
    }

    if (['INSERT', 'CREATE'].includes(action)) {
        return { message: `You added ${article} ${entity}`, icon: 'fa-plus', tone: 'is-added', entity };
    }

    if (action === 'UPDATE') {
        return { message: `You updated ${article} ${entity}`, icon: 'fa-pen', tone: 'is-updated', entity };
    }

    if (action === 'DELETE') {
        return { message: `You removed ${article} ${entity}`, icon: 'fa-trash-can', tone: 'is-removed', entity };
    }

    return { message: `You changed ${article} ${entity}`, icon: 'fa-clock-rotate-left', tone: 'is-recorded', entity };
}

function parseProfileActivityDate(value) {
    if (!value || typeof value !== 'string') return null;
    const parsed = new Date(value.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatProfileActivityTime(value) {
    const date = parseProfileActivityDate(value);
    if (!date) return 'Recently';

    if (typeof formatNotificationTime === 'function') {
        const relative = formatNotificationTime(value);
        if (relative) return relative;
    }

    return date.toLocaleString('en-PH', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

function profileActivityDayLabel(date) {
    if (!date) return 'Earlier activity';
    const today = new Date();
    const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const days = Math.max(0, Math.round((startToday - startDate) / 86400000));
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days <= 7) return '1 week ago';
    if (days <= 30) return '1 month ago';

    const years = today.getFullYear() - date.getFullYear();
    if (years >= 1) return `${years} year${years === 1 ? '' : 's'} ago`;
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function groupProfileActivities(activities) {
    const groups = new Map();
    activities.forEach((activity) => {
        const date = parseProfileActivityDate(activity?.action_time);
        const label = profileActivityDayLabel(date);
        if (!groups.has(label)) groups.set(label, { label, records: [], sortTime: 0 });
        const group = groups.get(label);
        group.records.push(activity);
        if (date) group.sortTime = Math.max(group.sortTime, date.getTime());
    });

    return [...groups.values()]
        .sort((first, second) => second.sortTime - first.sortTime)
        .map((group) => ({
            ...group,
            records: group.records.sort((first, second) => (parseProfileActivityDate(second?.action_time)?.getTime() || 0) - (parseProfileActivityDate(first?.action_time)?.getTime() || 0))
        }));
}

function profileActivityBrowserAndDevice(userAgent) {
    const value = String(userAgent || '');
    let browser = 'a browser';
    if (/Edg\//i.test(value)) browser = 'Edge';
    else if (/Chrome\//i.test(value)) browser = 'Chrome';
    else if (/Firefox\//i.test(value)) browser = 'Firefox';
    else if (/Safari\//i.test(value)) browser = 'Safari';

    let device = 'an unknown device';
    if (/iPhone/i.test(value)) device = 'iPhone';
    else if (/iPad/i.test(value)) device = 'iPad';
    else if (/Android/i.test(value)) device = 'Android';
    else if (/Windows/i.test(value)) device = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(value)) device = 'Mac';
    else if (/Linux/i.test(value)) device = 'Linux';
    return `${browser} on ${device}`;
}

function profileActivityStatusLabel(activity) {
    const status = String(activity?.status || '').trim().toUpperCase();
    if (status === 'SUCCESS') return 'Completed';
    if (status === 'FAILURE' || status === 'DENIED') return 'Did not go through';
    return 'Recorded';
}

function renderProfileActivityDetails(activity, presentation) {
    const action = String(activity?.action || '').trim().toUpperCase();
    const status = String(activity?.status || '').trim().toUpperCase();
    const when = formatProfileActivityTime(activity?.action_time);
    const browser = activity?.user_agent ? ` using ${profileActivityBrowserAndDevice(activity.user_agent)}` : '';
    let note = 'If this was unfamiliar or a mistake, review your account activity and contact the school office.';

    if (action === 'REPORT') {
        note = 'You sent this post to the school team for review. If this was unfamiliar or a mistake, contact the school office.';
    } else if (action === 'LOGIN' && status !== 'SUCCESS') {
        note = 'If that was not you, <a class="profile-activity-security-link" href="profile-security.html">click here</a> to change your password and review your account.';
    } else if (action === 'DELETE') {
        note = 'This removed a record or post. If this was unfamiliar or a mistake, contact the school office.';
    } else if (action === 'PASSWORD_CHANGE' || action === 'PASSWORD_RESET') {
        note = 'If this was unfamiliar, <a class="profile-activity-security-link" href="profile-security.html">click here</a> to review your password security.';
    } else if (action === 'ACCOUNT_REACTIVATED') {
        note = 'The user account was restored to active status and can sign in again.';
    } else if (action === 'ACCOUNT_REACTIVATION') {
        note = 'The reactivation attempt did not go through. Review the account request and try again if appropriate.';
    } else if (status === 'FAILURE' || status === 'DENIED') {
        note = 'This did not go through. If you did not expect it, review your account activity or contact the school office.';
    }

    return `<div class="profile-activity-details">
        <div class="profile-activity-detail-section"><h3>What happened</h3><p>${escapeHtml(presentation.message)}</p></div>
        <div class="profile-activity-detail-section"><h3>When &amp; where</h3><p>${escapeHtml(`${when}${browser}`)}</p></div>
        <div class="profile-activity-detail-section"><h3>Note</h3><p>${note}</p></div>
    </div>`;
}

function renderProfileActivities(activities) {
    const list = Array.isArray(activities) ? activities : [];

    if (!list.length) {
        setProfileActivitiesState(`
            <div class="profile-activity-state profile-activity-state--empty">
                <i class="fas fa-clipboard-check" aria-hidden="true"></i>
                <h3>No activity yet</h3>
                <p>Changes and posts made from your account will appear here.</p>
            </div>
        `);
        updateProfileActivitiesLoadMoreButton();
        return;
    }

    const groups = groupProfileActivities(list);
    setProfileActivitiesState(groups.map((group) => `
        <section class="profile-activity-day-group" aria-labelledby="profile-activity-day-${slugifyProfileActivityLabel(group.label)}">
            <h3 class="profile-activity-day-heading" id="profile-activity-day-${slugifyProfileActivityLabel(group.label)}">${escapeHtml(group.label)}</h3>
            <div class="profile-activity-day-list">${group.records.map(renderProfileActivityItem).join('')}</div>
        </section>
    `).join(''));

    updateProfileActivitiesLoadMoreButton();
}

function renderProfileActivityItem(activity) {
        const presentation = getProfileActivityPresentation(activity);
        const date = parseProfileActivityDate(activity.action_time);
        const datetime = date ? date.toISOString() : '';
        const activityId = String(Number(activity.audit_id || 0) || `${activity.action || 'activity'}-${activity.action_time || ''}`);
        const isOpen = profileActivityOpenId === activityId;

        return `
            <article class="profile-activity-item ${presentation.tone}${isOpen ? ' is-open' : ''}" role="listitem">
                <div class="profile-activity-row" aria-label="${escapeHtml(`${presentation.message}. ${isOpen ? 'Hide details' : 'Show details'}`)}">
                    <div class="profile-activity-copy">
                        <p class="profile-activity-message">${escapeHtml(presentation.message)}</p>
                        <div class="profile-activity-meta">
                            <time${datetime ? ` datetime="${escapeHtml(datetime)}"` : ''}>${escapeHtml(formatProfileActivityTime(activity.action_time))}</time>
                            <span>${escapeHtml(profileActivityStatusLabel(activity))}</span>
                        </div>
                    </div>
                    <button type="button" class="profile-activity-toggle" data-profile-activity-toggle="${escapeHtml(activityId)}" aria-label="${isOpen ? 'Hide activity details' : 'Show activity details'}" aria-expanded="${String(isOpen)}">
                        <i class="fas fa-chevron-${isOpen ? 'up' : 'down'}" aria-hidden="true"></i>
                    </button>
                </div>
                ${isOpen ? renderProfileActivityDetails(activity, presentation) : ''}
            </article>
        `;
}

function slugifyProfileActivityLabel(value) {
    return String(value || 'activity').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'activity';
}

function updateProfileActivitiesLoadMoreButton() {
    const button = document.getElementById('profileActivitiesLoadMore');
    if (!button) return;

    button.hidden = !profileActivitiesHasMore;
    button.disabled = profileActivitiesLoading;
    button.innerHTML = profileActivitiesLoading
        ? '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>Loading</span>'
        : '<i class="fas fa-chevron-down" aria-hidden="true"></i><span>Load more</span>';
}

async function loadProfileActivities({ append = false } = {}) {
    const feed = document.getElementById('profileActivitiesFeed');
    if (viewingOtherProfile) return;
    if (!feed || profileActivitiesLoading) return;
    if (append && !profileActivitiesHasMore) return;

    profileActivitiesLoading = true;
    const refreshButton = document.getElementById('profileActivitiesRefresh');
    if (refreshButton) {
        refreshButton.disabled = true;
        refreshButton.setAttribute('aria-busy', 'true');
    }
    if (!append) {
        profileActivities = [];
        profileActivitiesOffset = 0;
        profileActivitiesHasMore = false;
        profileActivityOpenId = null;
        setProfileActivitiesState(`
            <div class="profile-activity-state profile-activity-state--loading">
                <i class="fas fa-spinner fa-spin" aria-hidden="true"></i>
                <h3>Loading your activity</h3>
                <p>Checking your account history.</p>
            </div>
        `);
    }
    updateProfileActivitiesLoadMoreButton();

    try {
        const response = await axios.get(`${API_BASE_URL}/audit_logs/audit_logs.php`, {
            params: {
                operation: 'getMyAuditLogs',
                limit: PROFILE_ACTIVITY_PAGE_SIZE,
                offset: profileActivitiesOffset,
                _: Date.now()
            }
        });
        if (!response.data?.success) {
            throw new Error(response.data?.message || 'Unable to load activity.');
        }

        const page = Array.isArray(response.data?.data) ? response.data.data : [];
        profileActivities = append ? [...profileActivities, ...page] : page;
        profileActivitiesOffset = profileActivities.length;
        profileActivitiesHasMore = Boolean(response.data?.has_more);
        renderProfileActivities(profileActivities);
    } catch (error) {
        console.error('Error loading profile activities:', error);
        if (!append || !profileActivities.length) {
            setProfileActivitiesState(`
                <div class="profile-activity-state profile-activity-state--error">
                    <i class="fas fa-circle-exclamation" aria-hidden="true"></i>
                    <h3>Unable to load activity</h3>
                    <p>Please try again later.</p>
                    <button type="button" class="profile-activity-retry" data-profile-activities-retry>Try again</button>
                </div>
            `);
        } else {
            profileActivitiesHasMore = true;
        }
    } finally {
        profileActivitiesLoading = false;
        if (refreshButton) {
            refreshButton.disabled = false;
            refreshButton.removeAttribute('aria-busy');
        }
        updateProfileActivitiesLoadMoreButton();
    }
}

async function loadProfileInfoPositions() {
    try {
        const response = await axios.get(`${API_BASE_URL}/positions/positions.php?operation=getAllPositions`);
        profileInfoPositions = Array.isArray(response.data)
            ? response.data
            : (Array.isArray(response.data?.data) ? response.data.data : []);
    } catch (error) {
        profileInfoPositions = [];
        console.error('Error loading profile positions:', error);
    }
}

async function loadProfileInfoNameExtensions() {
    try {
        const response = await axios.get(`${API_BASE_URL}/name_extensions/name_extensions.php?operation=getAllNameExtensions`);
        const rows = Array.isArray(response.data)
            ? response.data
            : (Array.isArray(response.data?.data) ? response.data.data : []);
        profileInfoNameExtensions = rows.filter((row) => String(row?.extension_name || '').trim() !== '');
    } catch (error) {
        profileInfoNameExtensions = [];
        console.error('Error loading profile name extensions:', error);
    }
}

function fillProfileInfoForm(row) {
    if (!row) return;

    setInputValue('profileFirstName', row.first_name || '');
    setInputValue('profileMiddleName', row.middle_name || '');
    setInputValue('profileLastName', row.last_name || '');
    const nameExtensionSelect = document.getElementById('profileNameExtension');
    if (nameExtensionSelect) {
        while (nameExtensionSelect.options.length > 1) nameExtensionSelect.remove(1);
        profileInfoNameExtensions.forEach((extension) => {
            const option = document.createElement('option');
            option.value = extension.extension_name;
            option.textContent = extension.extension_name;
            nameExtensionSelect.appendChild(option);
        });
        const extensionValue = String(row.name_extension || '').trim();
        if (extensionValue && !Array.from(nameExtensionSelect.options).some((option) => option.value === extensionValue)) {
            const option = document.createElement('option');
            option.value = extensionValue;
            option.textContent = extensionValue;
            nameExtensionSelect.appendChild(option);
        }
        syncProfileInfoChoice('profileNameExtension', extensionValue);
    }
    setInputValue('profileDateOfBirth', row.date_of_birth || '');
    const genderSelect = document.getElementById('profileGender');
    if (genderSelect) {
        const genderValue = String(row.gender || '').trim();
        const normalizedGender = normalizeProfileGender(genderValue);
        const matchingGender = Array.from(genderSelect.options).find((option) => (
            genderValue && normalizeProfileGender(option.value) === normalizedGender
        ));
        syncProfileInfoChoice('profileGender', matchingGender ? matchingGender.value : '');
    }
    setInputValue('profileContactNumber', row.contact_number || '');
    setInputValue('profileEmail', row.email || '');
    setInputValue('profileAddress', row.address || '');
    setInputValue('profileEmployeeNumber', row.employee_number || row.username || '');
    setInputValue('profileDateHired', row.date_hired || '');
    setInputValue('profileWorkRole', row.role_name || currentUser?.role_name || '');

    const positionSelect = document.getElementById('profilePosition');
    if (positionSelect) {
        while (positionSelect.options.length > 1) positionSelect.remove(1);
        profileInfoPositions.forEach((position) => {
            const option = document.createElement('option');
            option.value = position.position_id;
            option.textContent = position.position_name;
            positionSelect.appendChild(option);
        });

        const positionValue = row.position_id || '';
        if (positionValue && !Array.from(positionSelect.options).some((option) => option.value === String(positionValue))) {
            const option = document.createElement('option');
            option.value = positionValue;
            option.textContent = row.position_name || 'Current position';
            positionSelect.appendChild(option);
        }
        syncProfileInfoChoice('profilePosition', positionValue);
    }
}

function syncProfileInfoChoice(id, value) {
    const select = document.getElementById(id);
    if (!select) return;

    select.value = value ?? '';
    if (select._choicesInstance) {
        try {
            select._choicesInstance.setChoiceByValue(String(value ?? ''));
        } catch (error) {
            console.warn(`Unable to sync enhanced select ${id}:`, error);
        }
    }
}

function setProfileInfoEditable(enabled) {
    const form = document.getElementById('profileInfoForm');
    const saveButton = document.getElementById('profileInfoSave');
    if (!form) return;

    const forceReadOnly = isLearnerOwnProfileView() || viewingOtherProfile;
    const editable = Boolean(enabled) && !forceReadOnly;
    const readOnlyFields = new Set(['profileEmployeeNumber', 'profileWorkRole']);
    form.querySelectorAll('input, textarea, select').forEach((field) => {
        if (readOnlyFields.has(field.id)) {
            field.readOnly = field.tagName !== 'SELECT';
            field.disabled = field.tagName === 'SELECT';
            if (field.tagName === 'SELECT') lockProfileInfoChoice(field);
            return;
        }
        field.disabled = !editable;
        if (field.tagName !== 'SELECT') field.readOnly = !editable;
        if (field.tagName === 'SELECT') {
            if (editable) unlockProfileInfoChoice(field);
            else lockProfileInfoChoice(field);
        }
    });

    if (saveButton) {
        saveButton.disabled = !editable;
        saveButton.hidden = forceReadOnly;
    }

    const applyChoiceLock = () => form.querySelectorAll('select').forEach((field) => {
        if (editable && !readOnlyFields.has(field.id)) unlockProfileInfoChoice(field);
        else lockProfileInfoChoice(field);
    });
    window.requestAnimationFrame(applyChoiceLock);
    window.setTimeout(applyChoiceLock, 100);
}

function lockProfileInfoChoice(select) {
    if (!select) return;
    const instance = select._choicesInstance;
    instance?.disable?.();
    const choices = instance?.containerOuter?.element || select.closest('.choices');
    if (!choices) return;

    choices.classList.add('is-disabled');
    choices.setAttribute('aria-disabled', 'true');
    choices.setAttribute('tabindex', '-1');
    choices.querySelectorAll('.choices__input, [tabindex]').forEach((el) => {
        el.setAttribute('tabindex', '-1');
        if ('disabled' in el) el.disabled = true;
    });
    instance?.hideDropdown?.(true);
}

function unlockProfileInfoChoice(select) {
    if (!select) return;
    const instance = select._choicesInstance;
    instance?.enable?.();
    const choices = instance?.containerOuter?.element || select.closest('.choices');
    if (!choices) return;

    choices.classList.remove('is-disabled');
    choices.removeAttribute('aria-disabled');
    choices.removeAttribute('tabindex');
    choices.querySelectorAll('.choices__input, [tabindex="-1"]').forEach((el) => {
        if (el.classList.contains('choices__input')) el.disabled = false;
        if (el.getAttribute('tabindex') === '-1') el.removeAttribute('tabindex');
    });
}

function setProfileInfoStatus(message, type = '') {
    const status = document.getElementById('profileInfoStatus');
    if (!status) return;

    status.className = `profile-info-status${type ? ` profile-info-status--${type}` : ''}`;
    status.textContent = message;
    status.hidden = !message;
}

async function saveProfileInfo(event) {
    event.preventDefault();
    if (viewingOtherProfile || isLearnerOwnProfileView()) return;
    if (!profileInfoEmployee?.employee_id) return;

    const saveButton = document.getElementById('profileInfoSave');
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>Saving...</span>';
    }
    setProfileInfoStatus('Saving your profile information...', 'loading');

    const getValue = (id) => String(document.getElementById(id)?.value || '').trim();
    const payload = {
        employee_id: profileInfoEmployee.employee_id,
        first_name: getValue('profileFirstName'),
        middle_name: getValue('profileMiddleName'),
        last_name: getValue('profileLastName'),
        name_extension: getValue('profileNameExtension'),
        date_of_birth: getValue('profileDateOfBirth'),
        gender: getValue('profileGender'),
        contact_number: getValue('profileContactNumber'),
        email: getValue('profileEmail'),
        address: getValue('profileAddress'),
        position_id: getValue('profilePosition'),
        date_hired: getValue('profileDateHired')
    };

    try {
        const response = await axios.post(
            `${API_BASE_URL}/employees/employees.php?operation=updateMyEmployee`,
            payload,
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (!response.data?.success) {
            throw new Error(response.data?.message || 'Unable to save profile information.');
        }

        profileInfoEmployee = { ...profileInfoEmployee, ...payload };
        const selectedPosition = document.getElementById('profilePosition')?.selectedOptions?.[0];
        if (selectedPosition) profileInfoEmployee.position_name = selectedPosition.textContent;

        if (currentUser) {
            currentUser.first_name = payload.first_name;
            currentUser.name_extension = payload.name_extension;
            currentUser.last_name = payload.last_name;
            currentUser.gender = payload.gender;
            const fullName = profileDisplayName(currentUser);
            const initials = getInitials(fullName || currentUser.username || 'U');
            setProfileName(fullName, currentUser);
            document.querySelectorAll('#profileAvatar, .compose-avatar, .composer-author .author-avatar').forEach((avatar) => {
                avatar.classList.remove('gender-male', 'gender-female', 'gender-other', 'gender-neutral');
                avatar.classList.add(`gender-${normalizeProfileGender(currentUser.gender)}`);
                avatar.textContent = initials;
                avatar.setAttribute('aria-label', `${fullName} profile`);
            });
            setText('composerUserName', fullName);
        }

        setProfileInfoStatus('Profile information saved.', 'success');
    } catch (error) {
        console.error('Error saving profile information:', error);
        setProfileInfoStatus(error.response?.data?.message || error.message || 'Unable to save profile information.', 'error');
    } finally {
        if (saveButton) {
            saveButton.disabled = !profileInfoEmployee?.employee_id;
            saveButton.innerHTML = '<i class="fas fa-save" aria-hidden="true"></i><span>Save changes</span>';
        }
    }
}

function initializeComposerFeatures() {
    window.initializeAnnouncementBackgroundControl?.();
    const titleInput = document.getElementById('announcementTitle');
    const bodyTextarea = document.getElementById('announcementBody');
    const titleCounter = document.getElementById('titleCounter');
    const contentCounter = document.getElementById('contentCounter');

    if (titleInput && titleCounter) {
        titleInput.addEventListener('input', (e) => {
            const length = e.target.value.length;
            titleCounter.textContent = length;
            titleCounter.classList.remove('warning', 'danger');
            if (length > 180) titleCounter.classList.add('warning');
            if (length > 195) titleCounter.classList.add('danger');
        });
    }

    if (bodyTextarea && contentCounter) {
        bodyTextarea.addEventListener('input', (e) => {
            contentCounter.textContent = e.target.value.length;
        });
    }

    const advancedToggle = document.getElementById('advancedToggle');
    const advancedOptions = document.getElementById('advancedOptions');

    if (advancedToggle && advancedOptions) {
        advancedToggle.addEventListener('click', () => {
            const isVisible = advancedOptions.style.display === 'block';
            advancedOptions.style.display = isVisible ? 'none' : 'block';
            advancedToggle.classList.toggle('active');
        });
    }
}

function initializeComposeHandlers() {
    const composeCard = document.getElementById('composeCard');
    const composeField = document.getElementById('composeField');
    const closeBtn = document.getElementById('closeAnnouncementModal');
    const cancelBtn = document.getElementById('cancelAnnouncementBtn');
    const modal = document.getElementById('createAnnouncementModal');
    const form = document.getElementById('createAnnouncementForm');

    if (composeCard) {
        composeCard.addEventListener('click', openComposeModal);
        composeCard.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openComposeModal();
            }
        });
    }

    if (composeField) {
        composeField.addEventListener('click', (event) => {
            event.stopPropagation();
            openComposeModal();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => modal.classList.remove('active'));
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => modal.classList.remove('active'));
    }

    if (modal) {
        modal.addEventListener('click', (event) => {
            if (event.target === modal) {
                modal.classList.remove('active');
            }
        });
    }

    if (form) {
        form.addEventListener('submit', handleAnnouncementSubmit);
    }
}

function initializeReadMoreToggle() {
    const feed = document.getElementById('profileAnnouncementsFeed');
    if (!feed) return;

    feed.addEventListener('click', (event) => {
        const toggleBtn = event.target.closest('.announcement-readmore');
        if (!toggleBtn) return;
        const content = toggleBtn.closest('.announcement-content');
        if (!content) return;

        const isExpanded = content.dataset.expanded === 'true';
        content.dataset.expanded = isExpanded ? 'false' : 'true';
        toggleBtn.textContent = isExpanded ? 'Read more' : 'Read less';
    });
}

function closeAnnouncementMenus(except = null) {
    document.querySelectorAll('.announcement-action-menu:not([hidden])').forEach((menu) => {
        if (menu === except) return;
        menu.hidden = true;
        menu.closest('.announcement-menu')?.querySelector('.announcement-menu-toggle')?.setAttribute('aria-expanded', 'false');
    });
    document.body.classList.toggle('announcement-sheet-open', Boolean(document.querySelector('.announcement-action-menu:not([hidden])')));
}

function initializeAnnouncementActions() {
    const feed = document.getElementById('profileAnnouncementsFeed');
    if (!feed) return;

    feed.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-announcement-menu-toggle]');
        if (toggle) {
            event.preventDefault();
            event.stopPropagation();
            const menu = toggle.closest('.announcement-menu')?.querySelector('.announcement-action-menu');
            if (!menu) return;
            const opening = menu.hidden;
            closeAnnouncementMenus(menu);
            menu.hidden = !opening;
            toggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
            document.body.classList.toggle('announcement-sheet-open', opening);
            return;
        }

        const action = event.target.closest('[data-announcement-action]');
        if (!action) return;
        event.preventDefault();
        const card = action.closest('.announcement-card');
        const announcementId = card?.dataset.id;
        if (!announcementId) return;
        closeAnnouncementMenus();

        const actionName = action.dataset.announcementAction;
        if (actionName === 'pin') pinAnnouncement(announcementId, Number(action.dataset.pinned) === 1);
        if (actionName === 'edit') editAnnouncement(announcementId);
        if (actionName === 'delete') deleteAnnouncement(announcementId);
        if (actionName === 'hide') hideAnnouncement(announcementId, card);
        if (actionName === 'report') reportAnnouncement(announcementId);
    });

    document.addEventListener('click', (event) => {
        if (!event.target.closest('.announcement-menu')) closeAnnouncementMenus();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeAnnouncementMenus();
    });
}

async function hideAnnouncement(announcementId, card) {
    try {
        const response = await axios.post(`${API_BASE_URL}/announcements/announcements.php?operation=hideAnnouncement`, { announcement_id: announcementId });
        if (!response.data?.success) throw new Error(response.data?.message || 'Failed to hide announcement');
        card?.remove();
        showNotification('Announcement hidden.', 'success');
    } catch (error) {
        showNotification(error.response?.data?.message || error.message || 'Unable to hide announcement.', 'error');
    }
}

async function reportAnnouncement(announcementId) {
    const confirmed = await window.showConfirmationDialog({
        title: 'Report announcement?',
        message: 'This announcement will be sent to administrators for review.',
        confirmText: 'Report announcement',
        cancelText: 'Cancel',
        tone: 'primary',
        icon: 'fa-flag'
    });
    if (!confirmed) return;
    try {
        const response = await axios.post(`${API_BASE_URL}/announcements/announcements.php?operation=reportAnnouncement`, { announcement_id: announcementId });
        if (!response.data?.success) throw new Error(response.data?.message || 'Failed to report announcement');
        showNotification('Announcement reported.', 'success');
    } catch (error) {
        showNotification(error.response?.data?.message || error.message || 'Unable to report announcement.', 'error');
    }
}

function openComposeModal() {
    if (viewingOtherProfile) return;

    const modal = document.getElementById('createAnnouncementModal');
    const form = document.getElementById('createAnnouncementForm');
    if (!modal || !form) return;

    editingAnnouncementId = null;
    modal.classList.add('active');
    form.reset();
    window.resetAnnouncementBackgroundControl?.();

    const titleCounter = document.getElementById('titleCounter');
    const contentCounter = document.getElementById('contentCounter');
    if (titleCounter) titleCounter.textContent = '0';
    if (contentCounter) contentCounter.textContent = '0';
}

async function loadCurrentUser() {
    try {
        const response = await axios.get(`${API_BASE_URL}/auth/me.php`);
        if (!response.data?.success) return;
        currentUser = response.data.data;

        const requestedProfileUserId = getRequestedProfileUserId();
        profileUser = currentUser;

        viewingOtherProfile = Boolean(
            requestedProfileUserId
            && String(requestedProfileUserId) !== String(currentUser.user_id)
        );

        if (viewingOtherProfile) {
            const profileResponse = await axios.get(
                `${API_BASE_URL}/profile/profile.php?operation=getPublicProfile&user_id=${encodeURIComponent(requestedProfileUserId)}`
            );
            if (!profileResponse.data?.success || !profileResponse.data?.data) {
                throw new Error(profileResponse.data?.message || 'Profile not found.');
            }
            profileUser = profileResponse.data.data;
        }

        applyProfileViewMode();

        const displayUser = profileUser || currentUser;
        const fullName = profileDisplayName(displayUser);
        const roleName = displayUser.role_name || 'User';

        setProfileName(fullName, displayUser);
        setText('profileRole', roleName);
        const profilePresence = typeof getAccountPresenceLabel === 'function'
            ? getAccountPresenceLabel(displayUser)
            : '';
        setText('profilePresence', profilePresence);
        const profilePresenceNode = document.getElementById('profilePresence');
        if (profilePresenceNode) {
            profilePresenceNode.classList.toggle('is-online', getAccountPresence(displayUser).isOnline);
        }
        setText('detailFullName', fullName);
        setText('detailRole', roleName);
        setText('detailUsername', viewingOtherProfile ? '-' : (currentUser.username || '-'));
        setText('detailUserId', viewingOtherProfile ? '-' : String(currentUser.user_id || '-'));
        setText('composerUserName', fullName);

        const initials = getInitials(fullName || currentUser.username || 'U');
        const genderClass = `gender-${normalizeProfileGender(displayUser.gender)}`;
        document.querySelectorAll('#profileAvatar, .compose-avatar, .composer-author .author-avatar').forEach((avatar) => {
            avatar.classList.remove('gender-male', 'gender-female', 'gender-other', 'gender-neutral');
            avatar.classList.add(genderClass);
            avatar.textContent = initials;
            avatar.setAttribute('aria-label', `${fullName} profile`);
            if (typeof applyAccountPresence === 'function') {
                applyAccountPresence(avatar, displayUser);
            }
        });

        applyAnnouncementPostingPermissions();
        applyStudentRecoveryPermission();

        loadUserAnnouncements();
    } catch (error) {
        console.error('Error loading user:', error);
        if (getRequestedProfileUserId()) {
            viewingOtherProfile = true;
            profileUser = null;
            applyProfileViewMode();
            setProfileName('Profile unavailable');
            setText('profileRole', 'This profile could not be loaded.');
            const feed = document.getElementById('profileAnnouncementsFeed');
            if (feed) {
                feed.innerHTML = '<div class="empty-state"><i class="fas fa-user-slash"></i><h3>Profile unavailable</h3><p>This profile may no longer be active.</p></div>';
            }
        }
    }
}

async function loadRoles() {
    try {
        const response = await axios.get(`${API_BASE_URL}/roles/roles.php?operation=getAllRoles`);
        const roles = response.data;
        const select = document.getElementById('targetRole');
        if (!select || !roles || roles.length === 0) return;

        while (select.options.length > 1) {
            select.remove(1);
        }

        roles.forEach((role) => {
            const option = document.createElement('option');
            option.value = role.role_id;
            option.textContent = role.role_name;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading roles:', error);
    }
}

async function loadUserAnnouncements() {
    const feed = document.getElementById('profileAnnouncementsFeed');
    if (!feed) return;
    if (!currentUser) return;

    if (!viewingOtherProfile && !canCurrentUserPostAnnouncements()) {
        // Learners do not have a posting surface.
        feed.innerHTML = '';
        return;
    }

    try {
        const response = await axios.get(`${API_BASE_URL}/announcements/announcements.php?operation=getAllAnnouncements`);
        const announcements = Array.isArray(response.data) ? response.data : [];
        const targetUser = profileUser || currentUser;
        const userPosts = announcements.filter((item) => String(item.posted_by) === String(targetUser?.user_id));
        profileAnnouncements = userPosts;
        const profileAccountCelebration = createProfileAccountCelebration(targetUser);

        if (userPosts.length === 0) {
            feed.innerHTML = profileAccountCelebration;
            return;
        }

        feed.innerHTML = `${userPosts.map((announcement) => createAnnouncementCard(announcement)).join('')}${profileAccountCelebration}`;
    } catch (error) {
        console.error('Error loading announcements:', error);
        feed.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-circle-exclamation"></i>
                <h3>Unable to load posts</h3>
                <p>Please try again later.</p>
            </div>
        `;
    }
}

function createAnnouncementCard(announcement) {
    const publishedDate = new Date(announcement.published_at);
    const isExpired = announcement.expires_at && new Date(announcement.expires_at) < new Date();
    const isPinned = announcement.is_pinned == 1;
    const canManage = !viewingOtherProfile && canCurrentUserManageAnnouncement(announcement);

    const timeLabel = announcement.seconds_ago !== undefined
        ? formatTimeAgoFromSeconds(announcement.seconds_ago, publishedDate)
        : formatTimeAgo(publishedDate);

    const authorName = announcement.first_name && announcement.last_name
        ? `${announcement.first_name} ${announcement.last_name}`
        : announcement.posted_by_name || 'System';
    const authorInitials = getInitials(authorName);
    const authorGenderClass = `gender-${normalizeProfileGender(announcement.gender)}`;

    const targetAudience = announcement.target_role_name || 'Everyone';
    const audienceLabel = targetAudience === 'Everyone' ? 'Everyone' : 'Custom audience';
    const audienceIcon = targetAudience === 'Everyone' ? 'fa-earth-americas' : 'fa-users';
    const audienceMarkup = `<span class="announcement-audience-icon" title="${audienceLabel}" aria-label="${audienceLabel}"><i class="fas ${audienceIcon}" aria-hidden="true"></i></span>`;
    const pinnedMarkup = isPinned ? '<span class="pin-badge"><i class="fas fa-thumbtack"></i>Pinned</span>' : '';
    const menuOptionsMarkup = canManage
        ? `<button type="button" data-announcement-action="pin" data-pinned="${isPinned ? '0' : '1'}"><i class="fas fa-thumbtack announcement-action-icon" aria-hidden="true"></i>${isPinned ? 'Unpin' : 'Pin'}</button><button type="button" data-announcement-action="edit"><i class="fas fa-pen-to-square announcement-action-icon" aria-hidden="true"></i>Edit</button><button type="button" data-announcement-action="delete" class="is-danger"><i class="fas fa-trash-can announcement-action-icon" aria-hidden="true"></i>Delete</button>`
        : '<button type="button" data-announcement-action="hide"><i class="fas fa-eye-slash announcement-action-icon" aria-hidden="true"></i>Hide</button><button type="button" data-announcement-action="report"><i class="fas fa-triangle-exclamation announcement-action-icon" aria-hidden="true"></i>Report</button>';
    const menuMarkup = viewingOtherProfile
        ? ''
        : `<div class="announcement-menu"><button type="button" class="announcement-menu-toggle" data-announcement-menu-toggle aria-expanded="false" aria-label="Post options"><i class="fas fa-ellipsis-vertical" aria-hidden="true"></i></button><div class="announcement-action-menu" hidden>${menuOptionsMarkup}</div></div>`;
    const profileLink = Number(announcement.posted_by) > 0
        ? `profile.html?user_id=${encodeURIComponent(announcement.posted_by)}`
        : '';
    const authorAvatarBody = typeof renderPresenceAvatarMarkup === 'function'
        ? renderPresenceAvatarMarkup({
            initials: authorInitials,
            genderClass: authorGenderClass,
            account: announcement,
            avatarClass: 'author-avatar',
            ariaLabel: `${authorName} profile`
        })
        : `<div class="author-avatar ${authorGenderClass}">${escapeHtml(authorInitials)}</div>`;
    const authorAvatarMarkup = profileLink
        ? `<a class="profile-user-link profile-user-link--avatar" href="${profileLink}" aria-label="View ${escapeHtml(authorName)}'s profile">${authorAvatarBody}</a>`
        : authorAvatarBody;
    const approvedBadgeMarkup = typeof renderDeveloperApprovedBadgeMarkup === 'function'
        ? renderDeveloperApprovedBadgeMarkup(announcement)
        : '';
    const authorNameMarkup = profileLink
        ? `<a class="profile-user-link profile-user-link--name" href="${profileLink}">${escapeHtml(authorName)}${approvedBadgeMarkup}</a>`
        : escapeHtml(authorName);
    const presenceLabel = typeof getAccountPresenceLabel === 'function'
        ? getAccountPresenceLabel(announcement)
        : '';
    const bodyText = announcement.body || '';
    const maxLength = 280;
    const isLongContent = bodyText.length > maxLength;
    const shortContent = escapeHtml(bodyText.slice(0, maxLength)).replace(/\n/g, '<br>');
    const fullContent = escapeHtml(bodyText).replace(/\n/g, '<br>');
    const contentHtml = isLongContent
        ? `
            <span class="announcement-content-short">${shortContent}</span>
            <span class="announcement-content-ellipsis">...</span>
            <span class="announcement-content-full">${fullContent}</span>
            <button class="announcement-readmore" type="button">Read more</button>
        `
        : fullContent;
    const messageBackground = typeof getAnnouncementBackgroundForAnnouncement === 'function'
        ? getAnnouncementBackgroundForAnnouncement(announcement)
        : '#ffffff';
    const isPlainBackground = typeof isAnnouncementPlainBackground === 'function'
        ? isAnnouncementPlainBackground(messageBackground)
        : messageBackground.trim().toLowerCase() === '#ffffff';
    const messageBackgroundClass = isPlainBackground ? ' announcement-content--plain' : '';
    const messageStyle = ` style="background: ${escapeHtml(messageBackground)};"`;

    return `
        <div class="announcement-card ${isExpired ? 'expired' : ''} ${isPinned ? 'pinned' : ''}" data-id="${announcement.announcement_id}">
            <div class="announcement-header">
                <div class="announcement-author">
                    ${authorAvatarMarkup}
                    <div class="author-info">
                        <h4 class="author-name">${authorNameMarkup}</h4>
                        <div class="announcement-meta">
                            <span class="announcement-time">${timeLabel}</span>
                            ${presenceLabel && presenceLabel !== 'Active' ? `<span class="account-presence-label">${escapeHtml(presenceLabel)}</span>` : ''}
                            ${audienceMarkup}
                            ${pinnedMarkup}
                            ${isExpired ? '<span class="expired-badge"><i class="fas fa-times-circle"></i> Expired</span>' : ''}
                        </div>
                    </div>
                </div>
                ${menuMarkup}
            </div>
            <div class="announcement-body">
                <h3 class="announcement-title">${escapeHtml(announcement.title)}</h3>
                <div class="announcement-content${messageBackgroundClass}"${messageStyle} ${isLongContent ? 'data-expanded="false"' : ''}>
                    ${contentHtml}
                </div>
            </div>
            <div class="announcement-footer">
                ${announcement.expires_at ? `
                    <div class="announcement-expiry">
                        <i class="fas fa-calendar-times"></i>
                        Expires: ${formatDate(new Date(announcement.expires_at))}
                    </div>
                ` : ''}
            </div>
        </div>
    `;
}

function canCurrentUserManageAnnouncement(announcement) {
    if (viewingOtherProfile) return false;

    // Prefer backend-provided ownership flag when available.
    if (['1', 'true'].includes(String(announcement?.is_owner).toLowerCase())) return true;

    if (!currentUser) return false;

    // Fallback for older payloads: compare IDs.
    return String(currentUser.user_id) === String(announcement?.posted_by);
}

async function handleAnnouncementSubmit(event) {
    event.preventDefault();

    if (viewingOtherProfile) {
        showNotification('You can view this profile, but you cannot post here.', 'error');
        return;
    }

    if (!canCurrentUserPostAnnouncements()) {
        showNotification('Learners are not allowed to post announcements.', 'error');
        return;
    }

    const form = event.target;
    const formData = new FormData(form);
    const selectedBackground = document.getElementById('messageBackground')?.value || '#ffffff';
    const payload = {
        title: formData.get('title'),
        body: formData.get('body'),
        target_role_id: formData.get('target_role_id') || null,
        expires_at: formData.get('expires_at') || null,
        message_background: selectedBackground,
        is_pinned: 0
    };

    if (!payload.title || !payload.body) {
        showNotification('Please fill in all required fields.', 'error');
        return;
    }

    const submitBtn = document.getElementById('submitAnnouncementBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Posting...';

    try {
        const isEditing = Boolean(editingAnnouncementId);
        const url = isEditing
            ? `${API_BASE_URL}/announcements/announcements.php?operation=updateAnnouncement`
            : `${API_BASE_URL}/announcements/announcements.php?operation=createAnnouncement`;
        const data = isEditing ? { ...payload, announcement_id: editingAnnouncementId } : payload;

        const response = await axios.post(url, data, { headers: { 'Content-Type': 'application/json' } });

        if (response.data?.success) {
            const savedAnnouncementId = response.data.announcement?.announcement_id || editingAnnouncementId;
            window.rememberAnnouncementBackground?.(savedAnnouncementId, selectedBackground);
            showNotification(isEditing ? 'Announcement updated.' : 'Announcement posted.', 'success');
            document.getElementById('createAnnouncementModal').classList.remove('active');
            form.reset();
            window.resetAnnouncementBackgroundControl?.();
            editingAnnouncementId = null;
            loadUserAnnouncements();
        } else {
            showNotification(response.data?.message || 'Failed to post announcement', 'error');
        }
    } catch (error) {
        const message = error.response?.data?.message || error.message || 'An error occurred while posting the announcement.';
        showNotification(message, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Post';
    }
}

async function pinAnnouncement(announcementId, isPinned) {
    const announcement = profileAnnouncements.find((item) => String(item.announcement_id) === String(announcementId));
    if (!announcement || !canCurrentUserManageAnnouncement(announcement)) {
        showNotification('Not authorized to manage this announcement.', 'error');
        return;
    }
    try {
        const response = await axios.post(
            `${API_BASE_URL}/announcements/announcements.php?operation=pinAnnouncement`,
            { announcement_id: announcementId, is_pinned: isPinned },
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (response.data?.success) {
            showNotification(response.data.message, 'success');
            loadUserAnnouncements();
        } else {
            showNotification(response.data?.message || 'Failed to update pin status', 'error');
        }
    } catch (error) {
        showNotification('An error occurred while updating pin status.', 'error');
    }
}

window.pinAnnouncement = pinAnnouncement;

async function deleteAnnouncement(announcementId) {
    const announcement = profileAnnouncements.find((item) => String(item.announcement_id) === String(announcementId));
    if (!announcement || !canCurrentUserManageAnnouncement(announcement)) {
        showNotification('Not authorized to manage this announcement.', 'error');
        return;
    }
    const confirmed = await window.showConfirmationDialog({
        title: 'Delete announcement?',
        message: 'This action cannot be undone. The announcement will be permanently removed from the school feed.',
        confirmText: 'Delete announcement',
        cancelText: 'Keep announcement',
        icon: 'fa-trash-can'
    });
    if (!confirmed) return;

    try {
        const response = await axios.post(
            `${API_BASE_URL}/announcements/announcements.php?operation=deleteAnnouncement`,
            { announcement_id: announcementId },
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (response.data?.success) {
            showNotification('Announcement deleted.', 'success');
            loadUserAnnouncements();
        } else {
            showNotification(response.data?.message || 'Failed to delete announcement', 'error');
        }
    } catch (error) {
        showNotification('An error occurred while deleting the announcement.', 'error');
    }
}

window.deleteAnnouncement = deleteAnnouncement;

async function editAnnouncement(announcementId) {
    const announcement = profileAnnouncements.find((item) => String(item.announcement_id) === String(announcementId));
    if (!announcement) {
        showNotification('Announcement not found.', 'error');
        return;
    }

    if (!canCurrentUserManageAnnouncement(announcement)) {
        showNotification('Not authorized to manage this announcement.', 'error');
        return;
    }

    const modal = document.getElementById('createAnnouncementModal');
    if (!modal) return;

    editingAnnouncementId = announcementId;
    modal.classList.add('active');

    setInputValue('announcementTitle', announcement.title);
    setInputValue('announcementBody', announcement.body);
    setInputValue('targetRole', announcement.target_role_id || '');
    setInputValue('expiresAt', formatDateTimeLocal(announcement.expires_at));
    window.setAnnouncementBackgroundControl?.(
        announcement.message_background || window.getStoredAnnouncementBackground?.(announcement.announcement_id)
    );

    const titleCounter = document.getElementById('titleCounter');
    const contentCounter = document.getElementById('contentCounter');
    if (titleCounter) titleCounter.textContent = (announcement.title || '').length;
    if (contentCounter) contentCounter.textContent = (announcement.body || '').length;

    const advancedOptions = document.getElementById('advancedOptions');
    const advancedToggle = document.getElementById('advancedToggle');
    if (advancedOptions && advancedToggle) {
        advancedOptions.style.display = 'block';
        advancedToggle.classList.add('active');
    }
}

window.editAnnouncement = editAnnouncement;

function formatTimeAgoFromSeconds(seconds, fallbackDate) {
    const elapsed = Number(seconds);
    if (!Number.isFinite(elapsed) || elapsed < 60) return 'Just now';

    const minutes = Math.floor(elapsed / 60);
    if (minutes < 60) return `${minutes} min ago`;

    const hours = Math.floor(elapsed / 3600);
    if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;

    const days = Math.floor(elapsed / 86400);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;

    const weeks = Math.floor(days / 7);
    if (days < 30) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;

    const months = Math.floor(days / 30);
    if (days < 365) return `${months} month${months === 1 ? '' : 's'} ago`;

    const years = Math.floor(days / 365);
    return `${years} yr${years === 1 ? '' : 's'} ago`;
}

function formatTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);

    return formatTimeAgoFromSeconds(Math.max(0, diffSecs), date);
}

function formatDate(date) {
    return date.toLocaleString('en-US', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function createProfileAccountCelebration(user) {
    const accountCreatedDate = formatProfileAccountCreatedDate(
        user?.account_created_at || user?.created_at
    );
    const startedOn = accountCreatedDate
        ? `Started on ${escapeHtml(accountCreatedDate)}`
        : 'Started date unavailable';
    const accountHeading = viewingOtherProfile
        ? profileDisplayName(user)
        : 'Your Account';

    return `
        <div class="announcements-empty announcements-empty--profile announcements-empty--profile-celebration" role="status" aria-live="polite">
            <div class="announcements-empty__frame">
                <div class="announcements-empty__icon" aria-hidden="true">
                    <video class="mp4-surface-blend empty-state-video empty-state-video--large" autoplay loop muted playsinline preload="metadata" aria-hidden="true">
                        <source src="../assets/icons/confetti.mp4" type="video/mp4">
                    </video>
                </div>
                <div class="announcements-empty__copy">
                    <h3>${escapeHtml(accountHeading)}</h3>
                    <p class="profile-account-created">${startedOn}</p>
                </div>
            </div>
        </div>
    `;
}

function formatProfileAccountCreatedDate(value) {
    const rawValue = String(value || '').trim();
    if (!rawValue) return '';

    // Database timestamps are returned as YYYY-MM-DD HH:MM:SS. Reading the
    // date portion directly keeps the displayed calendar day stable across
    // browsers and timezone settings.
    const dateParts = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const date = dateParts
        ? new Date(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3]))
        : new Date(rawValue);

    if (Number.isNaN(date.getTime())) return '';

    return date.toLocaleDateString('en-US', {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric'
    });
}

function getInitials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'U';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function profileDisplayName(user) {
    const firstName = String(user?.first_name || '').trim();
    const lastName = String(user?.last_name || '').trim();
    return `${firstName} ${lastName}`.trim() || String(user?.full_name || '').trim() || String(user?.username || '').trim() || 'User';
}

function setProfileName(value, user = null) {
    const name = String(value || '').trim() || 'User';
    setText('profileName', name);
    const profileName = document.getElementById('profileName');
    if (profileName) {
        profileName.title = name;
        window.applyDeveloperApprovedBadge?.(profileName, user);
    }
    scheduleProfileNameFit();
}

function scheduleProfileNameFit() {
    if (profileNameFitFrame) return;
    const requestFrame = window.requestAnimationFrame || ((callback) => window.setTimeout(callback, 0));
    profileNameFitFrame = requestFrame(() => {
        profileNameFitFrame = 0;
        fitProfileNameToRow();
    });
}

function fitProfileNameToRow() {
    const profileName = document.getElementById('profileName');
    if (!profileName) return;

    profileName.style.removeProperty('font-size');
    if (profileName.clientWidth <= 0 || profileName.scrollWidth <= profileName.clientWidth) return;

    const isMobile = window.matchMedia?.('(max-width: 560px)').matches;
    const minimumSize = isMobile ? 11 : 15;
    let fontSize = Number.parseFloat(window.getComputedStyle(profileName).fontSize) || 24;
    let attempts = 0;

    while (profileName.scrollWidth > profileName.clientWidth && fontSize > minimumSize && attempts < 40) {
        fontSize = Math.max(minimumSize, fontSize - 0.5);
        profileName.style.fontSize = `${fontSize}px`;
        attempts += 1;
    }
}

function normalizeProfileGender(gender) {
    const value = String(gender || '').trim().toLowerCase();
    if (value === 'm' || value === 'male' || value === 'man' || value === 'boy') return 'male';
    if (value === 'f' || value === 'female' || value === 'woman' || value === 'girl') return 'female';
    if (value) return 'other';
    return 'neutral';
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function setInputValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value ?? '';
}

function formatDateTimeLocal(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    const pad = (num) => String(num).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showNotification(message, type = 'info') {
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
            .gov-toast--info{border:0}
            .gov-toast--info .gov-toast__icon{color:var(--gray-500)}
        `;
        document.head.appendChild(style);
    };

    ensureGovToastStyles();
    document.querySelectorAll('.gov-toast').forEach((el) => el.remove());

    const normalizedType = type === 'success' || type === 'error' || type === 'info' ? type : 'info';
    const title = normalizedType === 'success' ? 'Completed' : normalizedType === 'error' ? 'Action Required' : 'Notice';
    const iconClass = normalizedType === 'success' ? 'fa-circle-check' : normalizedType === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info';

    const toast = document.createElement('div');
    toast.className = `gov-toast gov-toast--${normalizedType}`;
    toast.innerHTML = `
        <div class="gov-toast__content">
            <i class="fas ${iconClass} gov-toast__icon"></i>
            <div class="gov-toast__text">
                <div class="gov-toast__title">${title}</div>
                <div class="gov-toast__message">${message}</div>
            </div>
            <button type="button" class="gov-toast__dismiss" aria-label="Dismiss">&times;</button>
        </div>
    `;

    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    const dismiss = toast.querySelector('.gov-toast__dismiss');
    if (dismiss) {
        dismiss.addEventListener('click', () => toast.remove());
    }

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 250);
    }, 4000);
}
