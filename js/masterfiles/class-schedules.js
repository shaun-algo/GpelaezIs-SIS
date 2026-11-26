/**
 * Class Schedules — DepEd Class Program
 *
 * Roles:
 *   admin           : full CRUD (Add, View, Edit, Delete) + export
 *   teacher         : read-only view of their own schedules + export
 *   learner         : read-only view of their own section's schedule + export
 *   registrar       : schedule setup and view for all permitted school years
 *
 * UI pattern:
 *   - Weekly grid showing each class block by Learning Area, section context, and time
 *   - View opens a detail modal with Edit + Delete buttons (admin/registrar/teacher only)
 *   - Edit opens the Add/Edit form modal pre-populated — no inline editing
 *   - Export produces an Excel file via SheetJS
 */

const API_BASE_URL = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;

/* ── API helpers ── */
const csApi = {
    schoolYears:    ()     => axios.get(`${API_BASE_URL}/school_years/school_years.php`,      { params: { operation: 'getAllSchoolYears' } }).then(r => r.data),
    gradeLevels:    ()     => axios.get(`${API_BASE_URL}/grade_levels/grade_levels.php`,       { params: { operation: 'getAllGradeLevels' } }).then(r => r.data),
    sections:       (syId) => axios.get(`${API_BASE_URL}/sections/sections.php`,               { params: { operation: 'getAllSections', school_year_id: syId } }).then(r => r.data),
    schedules:      (p)    => axios.get(`${API_BASE_URL}/class_schedules/class_schedules.php`, { params: { operation: 'getAllSchedules', ...p } }).then(r => r.data),
    mySchedule:     (p)    => axios.get(`${API_BASE_URL}/class_schedules/class_schedules.php`, { params: { operation: 'getMySchedule', ...p } }).then(r => r.data),
    offerings:      (p)    => axios.get(`${API_BASE_URL}/class_schedules/class_schedules.php`, { params: { operation: 'getOfferingsForSchedule', ...p } }).then(r => r.data),
    schoolSettings: ()     => axios.get(`${API_BASE_URL}/school_settings/school_settings.php`, { params: { operation: 'getAllSettings' } }).then(r => r.data?.map || {}),
    create:         (data) => axios.post(`${API_BASE_URL}/class_schedules/class_schedules.php?operation=createClassSchedule`, data).then(r => r.data),
    update:         (data) => axios.post(`${API_BASE_URL}/class_schedules/class_schedules.php?operation=updateClassSchedule`, data).then(r => r.data),
    remove:         (id)   => axios.post(`${API_BASE_URL}/class_schedules/class_schedules.php?operation=deleteClassSchedule`, { schedule_id: id }).then(r => r.data),
};

/* ── Constants ── */
const DAYS      = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LABELS = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
const GRID_START_HOUR = 7;   // 7 AM
const GRID_END_HOUR   = 18;  // Default 6 PM fallback (dynamically scales based on schedules)
const MAX_WEEKLY_SCHEDULE_ENTRIES_PER_OFFERING = 5;

/*
 * Keep the stored subject name for data integrity, but use the curriculum
 * abbreviation in schedule-facing labels. MAPEH components intentionally
 * render under the single MAPEH parent label.
 */
function csDisplaySubjectName(subjectName, subjectCode = '', areaCode = '') {
    const raw = String(subjectName ?? '').trim();
    if (!raw) return '—';

    const code = String(subjectCode ?? '').trim().toUpperCase();
    const area = String(areaCode ?? '').trim().toUpperCase();
    const name = raw.toLowerCase().replace(/\s+/g, ' ');

    if (['GMRC', 'EPP', 'MAPEH', 'TLE', 'AP'].includes(code)) return code;
    if (area === 'MAPEH') return 'MAPEH';
    if (/\bgmrc\b|good manners and right conduct/.test(name)) return 'GMRC';
    if (/\bepp\b|edukasyong pantahanan|home economics and livelihood/.test(name)) return 'EPP';
    if (/\btle\b|technology and livelihood education/.test(name)) return 'TLE';
    if (/\baraling panlipunan\b/.test(name)) return 'AP';
    if (/\bmapeh\b|\bmusic\b|\barts?\b|\bphysical education\b|\bhealth\b|\bp\.?e\.?\b/.test(name)) {
        return 'MAPEH';
    }

    return raw;
}

/* ── State ── */
let csState = {
    role: '',               // 'admin' | 'teacher' | 'learner' | 'registrar' | ''
    isReadOnly: false,      // true for teacher + learner
    schoolYears: [],
    gradeLevels: [],
    sections: [],
    offerings: [],          // cached offerings for selected section
    schedules: [],
    selectedSY: null,
    selectedGL: null,
    selectedSection: null,
    editingId: null,
    deletingId: null,
    school: {               // filled from school_settings at init
        name:      '',
        id:        '',
        head:      '',
        division:  '',
        district:  '',
        region:    '',
        address:   '',
    },
};

/* ════════════════════════════════════
   INIT
   ════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    // Wait for dashboard.js to set CURRENT_ROLE_ID / CURRENT_ROLE_NAME
    // (dashboard.js calls the session API asynchronously).
    // Poll until role is available, then boot.
    csWaitForRole(csInit);
});

function csHideReadOnlyControls() {
    const contextCard = document.getElementById('csContextCard');
    if (!contextCard) return;
    contextCard.hidden = true;
    contextCard.setAttribute('aria-hidden', 'true');
}

function csWaitForRole(cb, attempts = 0) {
    const rid  = Number(window.CURRENT_ROLE_ID  || 0);
    const rname = String(window.CURRENT_ROLE_NAME || '');
    if (rid > 0 || rname) {
        cb(rid, rname);
    } else if (attempts < 30) {
        setTimeout(() => csWaitForRole(cb, attempts + 1), 150);
    } else {
        // Fallback: proceed with no role (page will enforce read-only).
        cb(0, '');
    }
}

async function csInit(roleId, roleName) {
    // Derive normalized role key
    const rn = roleName.toLowerCase();
    let rk = '';
    if (rn.includes('admin'))                                      rk = 'admin';
    else if (rn.includes('teacher'))                               rk = 'teacher';
    else if (rn.includes('learner') || rn.includes('student') || roleId === 10) rk = 'learner';
    else if (rn.includes('registrar'))                             rk = 'registrar';
    else if (roleId === 9)                                         rk = 'teacher';
    else if (roleId === 8)                                         rk = 'admin';
    else if (roleId === 7 || roleId === 11)                        rk = 'registrar';

    csState.role       = rk;
    csState.isReadOnly = (rk === 'learner' || rk === 'teacher');
    document.querySelectorAll('[data-cs-admin]').forEach((item) => { item.hidden = csState.isReadOnly; });
    const printScheduleBtn = document.getElementById('csPrintScheduleBtn');
    if (printScheduleBtn) printScheduleBtn.hidden = !['teacher', 'learner'].includes(rk);
    const contextCard = document.getElementById('csContextCard');
    if (contextCard) {
        contextCard.hidden = csState.isReadOnly;
        contextCard.setAttribute('aria-hidden', String(csState.isReadOnly));
    }
    if (csState.isReadOnly) csHideReadOnlyControls();
    
    // Set role on body element for CSS targeting
    document.body.setAttribute('data-user-role', rk);

    // Load school settings (silently — don't block on failure)
    try {
        const m = await csApi.schoolSettings();
        csState.school.name     = m.school_name     || m.schoolName     || '';
        csState.school.id       = m.school_id       || m.schoolId       || '';
        csState.school.head     = m.school_head     || m.school_head_name || m.principal_name || '';
        csState.school.division = m.division        || m.school_division || '';
        csState.school.district = m.district        || m.school_district || '';
        csState.school.region   = m.region          || m.school_region   || '';
        csState.school.address  = m.address         || m.school_address  || '';
    } catch (_) { /* settings unavailable — exports will omit them gracefully */ }

    const sideForm = document.getElementById('sideForm');
    const formEditFields = document.getElementById('formEditFields');
    const formReadOnlyNote = document.getElementById('formReadOnlyNote');
    const layout = document.querySelector('#dataArea .cs-layout');

    if (rk === 'learner' || roleId === 10) {
        // Learners: hide side form, auto-load their own section only, grid fills width
        // Never allow fall-through to admin/registrar paths which call getAllSchedules
        if (sideForm) sideForm.style.display = 'none';
        if (layout) layout.style.gridTemplateColumns = '1fr';
        await csLoadLearnerSchedule();
        return; // hard stop — no further role branches
    } else if (rk === 'teacher') {
        // Read-only teacher assignments for the active school year.
        if (sideForm) sideForm.style.display = 'none';
        if (layout) layout.style.gridTemplateColumns = '1fr';
        await csLoadReadOnlySchedule();
    } else {
        // Admin and registrar: show the full schedule setup form.
        if (sideForm) sideForm.style.display = '';
        if (formEditFields) formEditFields.style.display = '';
        if (formReadOnlyNote) formReadOnlyNote.style.display = 'none';
        await csLoadMasterfiles();
    }
}

/* ── Active school year schedule for read-only roles ── */
async function csLoadReadOnlySchedule() {
    csShowLoading();
    csState.selectedGL = null;
    csState.selectedSection = null;
    csState.offerings = [];

    try {
        // The API resolves the active school year and ignores historical
        // school-year filters for view-only roles.
        const data = await csApi.schedules({ _: Date.now() });
        csState.schedules = Array.isArray(data) ? data : [];
        const first = csState.schedules[0];
        csState.selectedSY = first
            ? { school_year_id: first.school_year_id, year_label: first.year_label, is_active: 1 }
            : null;
        csRenderTable();
    } catch (_) {
        csState.schedules = [];
        csToast('Failed to load the active school year schedule.', 'error');
        csShowInfo('Could not load the active school year schedule. Please refresh the page or contact support.');
    }
}

/* ── Learner auto-load ── */
async function csLoadLearnerSchedule() {
    csShowLoading();
    try {
        const data = await csApi.mySchedule({ _: Date.now() });
        csState.schedules = Array.isArray(data) ? data : [];

        // Derive context from first row
        if (csState.schedules.length) {
            const first = csState.schedules[0];
            csState.selectedSY      = { year_label: first.year_label };
            csState.selectedSection = { section_name: first.section_name, section_id: first.section_id };
            csState.selectedGL      = { grade_name: first.grade_name };
        }
        csRenderTable();
    } catch (e) {
        const status = e?.response?.status;
        if (status === 404) {
            csShowInfo('No schedule found for your section in the current school year. Please check back later.');
        } else if (status === 403) {
            csShowInfo('Your account is not linked to a learner profile. Please contact the administrator.');
        } else {
            csToast('Failed to load your schedule.', 'error');
            csShowInfo('Could not load schedule. Please refresh the page or contact support.');
        }
    }
}

/* ── Masterfile load (admin/registrar) ── */
async function csLoadMasterfiles() {
    try {
        const [syData, glData] = await Promise.all([csApi.schoolYears(), csApi.gradeLevels()]);
        csState.schoolYears = Array.isArray(syData) ? syData.filter(s => !s.is_deleted) : [];
        csState.gradeLevels = Array.isArray(glData) ? glData.filter(g => !g.is_deleted) : [];
        csPopulateSYSelect();

        const activeSY = csState.schoolYears.find(s => s.is_active == 1);
        if (activeSY) {
            const sySel = document.getElementById('formSY') || document.getElementById('filterSY');
            if (sySel) {
                sySel.value = activeSY.school_year_id;
                csSyncEnhancedSelect(sySel);
            }
            await csOnSYChange();
        }
    } catch (e) {
        csToast('Failed to load masterfile data.', 'error');
    }
}

/* ════════════════════════════════════
   CASCADING FILTERS
   ════════════════════════════════════ */
function csSetSelectDisabled(select, disabled) {
    if (!select) return;
    select.disabled = Boolean(disabled);
    const choices = select._choicesInstance;
    if (!choices) return;
    if (select.disabled) choices.disable();
    else choices.enable();
}

function csSyncEnhancedSelect(select) {
    const choices = select?._choicesInstance;
    if (!choices) return;
    try {
        choices.refresh();
        if (select.disabled) choices.disable();
        else choices.enable();
    } catch (_) { /* Choices may still be initializing. */ }
}

function csPopulateSYSelect() {
    const html = !csState.schoolYears.length
        ? '<option value="">— No school years —</option>'
        : '<option value="">— Select School Year —</option>' +
            csState.schoolYears.map(sy =>
                `<option value="${sy.school_year_id}">${escHtml(sy.year_label)}${sy.is_active == 1 ? ' (Active)' : ''}</option>`
            ).join('');
    ['formSY', 'filterSY'].forEach(id => {
        const sel = document.getElementById(id);
        if (sel) {
            sel.innerHTML = html;
            csSyncEnhancedSelect(sel);
        }
    });
}


async function csOnSYChange() {
    const sySel  = document.getElementById('formSY') || document.getElementById('filterSY');
    const glSel  = document.getElementById('formGL') || document.getElementById('filterGL');
    const secSel = document.getElementById('formSection') || document.getElementById('filterSection');
    const classSel = document.getElementById('csClassId');

    const syId = parseInt(sySel.value, 10);

    if (!syId) {
        if (glSel) { csSetSelectDisabled(glSel, true); glSel.innerHTML = '<option value="">— Select School Year First —</option>'; }
        if (secSel) { csSetSelectDisabled(secSel, true); secSel.innerHTML = '<option value="">— Select Grade Level First —</option>'; }
        if (classSel) { csSetSelectDisabled(classSel, true); classSel.innerHTML = '<option value="">— Select Section First —</option>'; }
        csState.selectedSY = csState.selectedGL = csState.selectedSection = null;
        csState.offerings = [];
        csShowEmptyState();
        return;
    }

    csState.selectedSY = csState.schoolYears.find(s => s.school_year_id === syId);

    try {
        const data = await csApi.sections(syId);
        csState.sections = Array.isArray(data) ? data : [];
    } catch (_) { csState.sections = []; }

    const usedGLIds = new Set(csState.sections.map(s => s.grade_level_id));
    if (glSel) {
        csSetSelectDisabled(glSel, false);
        glSel.innerHTML = '<option value="all">— All Grade Levels —</option>' +
            csState.gradeLevels
                .filter(g => usedGLIds.has(g.grade_level_id))
                .sort((a, b) => Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0))
                .map(g => `<option value="${g.grade_level_id}">${escHtml(g.grade_name)}</option>`).join('');
        glSel.value = 'all';
        csSyncEnhancedSelect(glSel);
    }
    csState.selectedGL = null;

    if (secSel) {
        csSetSelectDisabled(secSel, true);
        secSel.innerHTML = '<option value="">— Select Grade Level First —</option>';
    }
    csState.selectedSection = null;
    csState.offerings = [];

    // Keep formSY and filterSY in sync
    ['formSY', 'filterSY'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el !== sySel) {
            el.value = sySel.value;
            csSyncEnhancedSelect(el);
        }
    });

    await csLoadSchedules();
}

async function csOnGLChange() {
    const glSel  = document.getElementById('formGL') || document.getElementById('filterGL');
    const secSel = document.getElementById('formSection') || document.getElementById('filterSection');
    const classSel = document.getElementById('csClassId');
    const val = glSel ? glSel.value : '';

    if (classSel) { csSetSelectDisabled(classSel, true); classSel.innerHTML = '<option value="">— Select Section First —</option>'; }

    if (val === 'all' || !val) {
        csState.selectedGL = csState.selectedSection = null;
        csState.offerings = [];
        if (secSel) { csSetSelectDisabled(secSel, true); secSel.innerHTML = '<option value="">— Select Grade Level First —</option>'; }
        await csLoadSchedules();
        return;
    }

    const glId = parseInt(val, 10);
    csState.selectedGL = csState.gradeLevels.find(g => g.grade_level_id === glId);

    const forGL = csState.sections.filter(s => s.grade_level_id === glId);
    if (secSel) {
        csSetSelectDisabled(secSel, forGL.length === 0);
        secSel.innerHTML = forGL.length === 0
            ? '<option value="">— No sections for this grade —</option>'
            : '<option value="">— Select Section —</option>' +
              forGL.map(s => `<option value="${s.section_id}">${escHtml(s.section_name)}</option>`).join('');
    }
    csState.selectedSection = null;
    csState.offerings = [];

    // Keep formGL and filterGL in sync
    ['formGL', 'filterGL'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el !== glSel) {
            el.value = glSel.value;
            csSyncEnhancedSelect(el);
        }
    });

    await csLoadSchedules();
}

async function csOnSectionChange() {
    const secSel = document.getElementById('formSection') || document.getElementById('filterSection');
    const id = parseInt(secSel.value, 10);
    csState.selectedSection = id ? csState.sections.find(s => s.section_id === id) : null;

    // Keep formSection and filterSection in sync
    ['formSection', 'filterSection'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el !== secSel) {
            el.value = secSel.value;
            csSyncEnhancedSelect(el);
        }
    });

    await Promise.all([csLoadOfferings(), csLoadSchedules()]);
}

async function csLoadOfferings() {
    const classSel = document.getElementById('csClassId');
    if (!classSel) return;

    if (!csState.selectedSection || !csState.selectedSY) {
        csSetSelectDisabled(classSel, true);
        classSel.innerHTML = '<option value="">— Select Section First —</option>';
        csState.offerings = [];
        return;
    }

    classSel.innerHTML = '<option value="">— Loading... —</option>';
    csSetSelectDisabled(classSel, true);
    try {
        const data = await csApi.offerings({
            school_year_id: csState.selectedSY.school_year_id,
            section_id: csState.selectedSection.section_id,
        });
        const list = Array.isArray(data) ? data : [];
        csState.offerings = list;
        if (!list.length) {
            classSel.innerHTML = '<option value="">— No class offerings with weekly days remaining —</option>';
            csSetSelectDisabled(classSel, true);
            return;
        }
        classSel.innerHTML = '<option value="">— Select Offering —</option>' +
            list.map(o => {
                return `<option value="${o.class_id}">${escHtml(csDisplaySubjectName(o.subject_name, o.subject_code, o.area_code))}</option>`;
            }).join('');
        csSetSelectDisabled(classSel, false);
        csOnScheduleTypeChange();
    } catch (_) {
        classSel.innerHTML = '<option value="">— Failed to load offerings —</option>';
        csSetSelectDisabled(classSel, true);
        csToast('Could not load class offerings.', 'error');
    }
}

function csSelectedScheduleType() {
    return document.getElementById('csScheduleType')?.value === 'fixed_activity'
        ? 'fixed_activity'
        : 'class';
}

function csOnScheduleTypeChange() {
    const type = csSelectedScheduleType();
    const classWrap = document.getElementById('formOfferingWrap');
    const activityWrap = document.getElementById('formActivityWrap');
    const classSel = document.getElementById('csClassId');
    const activityInput = document.getElementById('csActivityName');
    const isActivity = type === 'fixed_activity';

    if (classWrap) classWrap.hidden = isActivity;
    if (activityWrap) activityWrap.hidden = !isActivity;
    if (classSel) {
        classSel.required = !isActivity;
        csSetSelectDisabled(classSel, isActivity || !csState.selectedSection || !csState.selectedSY);
    }
    if (activityInput) activityInput.required = isActivity;
}

function csOnOfferingChange() {
    if (csSelectedScheduleType() !== 'class') return;
    const classId = document.getElementById('csClassId')?.value;
    const offering = csState.offerings.find(item => Number(item.class_id) === Number(classId));
    const expectedMinutes = Number(offering?.meeting_minutes || 0);
    const start = document.getElementById('csStartTime')?.value;
    if (!offering || expectedMinutes <= 0 || !start) return;

    const startMinutes = csTimeToMinutes(start);
    const endMinutes = startMinutes + expectedMinutes;
    if (endMinutes >= 24 * 60) return;
    const end = document.getElementById('csEndTime');
    if (end) {
        end.value = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
    }
}

async function csLoadSchedules() {
    if (!csState.selectedSY) { csShowEmptyState(); return; }

    const params = {
        school_year_id: csState.selectedSY.school_year_id,
        _: Date.now() // prevent browser caching of schedule data
    };
    if (csState.selectedGL)      params.grade_level_id = csState.selectedGL.grade_level_id;
    if (csState.selectedSection) params.section_id     = csState.selectedSection.section_id;

    csShowLoading();
    try {
        const data = await csApi.schedules(params);
        csState.schedules = Array.isArray(data) ? data : [];
        csRenderTable();
    } catch (e) {
        csToast('Failed to load schedules.', 'error');
        csShowEmptyState();
    }
}

function csResetFilters() {
    const sySel = document.getElementById('formSY') || document.getElementById('filterSY');
    const glSel = document.getElementById('formGL') || document.getElementById('filterGL');
    const secSel = document.getElementById('formSection') || document.getElementById('filterSection');
    const classSel = document.getElementById('csClassId');

    if (sySel) { sySel.value = ''; csSetSelectDisabled(sySel, false); csSyncEnhancedSelect(sySel); }
    if (glSel) { glSel.value = ''; csSetSelectDisabled(glSel, true); glSel.innerHTML = '<option value="">— Select School Year First —</option>'; }
    if (secSel) { secSel.value = ''; csSetSelectDisabled(secSel, true); secSel.innerHTML = '<option value="">— Select Grade Level First —</option>'; }
    if (classSel) { classSel.value = ''; csSetSelectDisabled(classSel, true); classSel.innerHTML = '<option value="">— Select Section First —</option>'; }

    csState.selectedSY = csState.selectedGL = csState.selectedSection = null;
    csState.sections = [];
    csState.offerings = [];
    csState.schedules = [];
    csResetForm();
    csShowEmptyState();
}

/* ════════════════════════════════════
   RENDERING — Weekly Grid + Side Form Context
   ════════════════════════════════════ */
function csRenderTable() {
    const gridWrap = document.getElementById('gridWrap');
    const scheds   = csState.schedules;
    const canEdit  = !csState.isReadOnly && !!csState.selectedSection;
    let sectionTitle = '';

    // Teacher and learner views intentionally receive the plain table only.
    // Admins and registrars retain the selected-section context above their
    // editable grid.
    if (!csState.isReadOnly && csState.selectedSection) {
        const gradeName = csState.selectedGL?.grade_name || scheds[0]?.grade_name || '';
        const sectionName = csState.selectedSection.section_name || scheds[0]?.section_name || '';
        sectionTitle = `<div class="cs-section-title">${escHtml(`${gradeName} ${sectionName}`.trim().toUpperCase())}</div>`;
    }

    if (gridWrap) {
        gridWrap.innerHTML = sectionTitle
            + `<div class="cs-schedule-desktop">${csBuildGridHtml(scheds, canEdit)}</div>`
            + `<div class="cs-schedule-mobile">${csBuildMobileScheduleHtml(scheds, canEdit)}</div>`;
    }
}

function csScheduleEmptyStateHtml() {
    const role = String(csState.role || '').toLowerCase();
    if (role === 'learner') {
        return `<div class="cs-grid-empty">
            <video class="mp4-surface-blend context-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="../assets/icons/calendar.mp4" type="video/mp4"></video>
            <strong>No schedule available yet</strong><br>
            Your section schedule has not been posted for the current school year.
        </div>`;
    }
    if (role === 'teacher') {
        return `<div class="cs-grid-empty">
            <video class="mp4-surface-blend context-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="../assets/icons/calendar.mp4" type="video/mp4"></video>
            <strong>No assigned schedules yet</strong><br>
            Your class schedules will appear here once they are set up.
        </div>`;
    }
    if (csState.selectedSection) {
        return `<div class="cs-grid-empty">
            <video class="mp4-surface-blend context-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="../assets/icons/calendar.mp4" type="video/mp4"></video>
            <strong>No schedule entries</strong><br>
            No classes have been scheduled for this section yet.
        </div>`;
    }
    return `<div class="cs-grid-empty">
        <video class="mp4-surface-blend context-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="../assets/icons/calendar.mp4" type="video/mp4"></video>
        <strong>No section selected</strong><br>
        Select a school year, grade level, and section to view the weekly schedule.
    </div>`;
}

function csBuildGridHtml(scheds, canEdit, hideSectionBadge = false) {
    // Teachers show all of their permitted schedules across sections.
    const isTeacherView = csState.role === 'teacher' && !csState.selectedSection;
    const isAllScheduleView = isTeacherView;
    
    if ((!csState.selectedSection && !isAllScheduleView) || !Array.isArray(scheds) || !scheds.length) {
        return csScheduleEmptyStateHtml();
    }

    // Dynamically calculate hour range so afternoon/evening classes past 4 PM are flexible and never cut off
    let gridStartHour = GRID_START_HOUR;
    let gridEndHour   = 18; // Default 6:00 PM (18:00) to comfortably show 4 PM–6 PM classes

    if (Array.isArray(scheds) && scheds.length > 0) {
        scheds.forEach(s => {
            if (s.start_time) {
                const sm = csTimeToMinutes(s.start_time);
                const sh = Math.floor(sm / 60);
                if (sh < gridStartHour) gridStartHour = Math.max(6, sh);
            }
            if (s.end_time) {
                const em = csTimeToMinutes(s.end_time);
                const eh = Math.ceil(em / 60);
                if (eh > gridEndHour) gridEndHour = Math.min(22, eh);
            }
        });
    }

    // Keep the hourly grid, but split rows at actual schedule boundaries too.
    // Hour-only rows caused a later class (for example 3:30–5:00 PM) to be
    // dropped when an earlier class on the same day already occupied 3:00 PM.
    const timePointSet = new Set();
    for (let h = gridStartHour; h <= gridEndHour; h++) timePointSet.add(h * 60);
    scheds.forEach(s => {
        const startMins = csTimeToMinutes(s.start_time);
        const endMins = csTimeToMinutes(s.end_time);
        if (startMins >= gridStartHour * 60 && startMins <= gridEndHour * 60) timePointSet.add(startMins);
        if (endMins >= gridStartHour * 60 && endMins <= gridEndHour * 60) timePointSet.add(endMins);
    });
    const timePoints = [...timePointSet].sort((a, b) => a - b);
    const timeRows = timePoints.slice(0, -1);
    const fmtTimePoint = mins => {
        const hour = Math.floor(mins / 60);
        const minute = mins % 60;
        return csFormatTime(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    };

    const thRow = ['Time', ...DAYS].map(d => `<th>${d === 'Time' ? d : d}</th>`).join('');

    // Build placement map with rows split at schedule start/end times so
    // adjacent classes inside one hour each get a visible table cell.
    const slotStart = {}; // { day: { rowIndex: { schedule_id, rowspan } } }
    const slotSpan  = {}; // { day: { rowIndex: true } } cells consumed by rowspan

    DAYS.forEach(day => {
        slotStart[day] = {};
        slotSpan[day] = {};
        const dayScheds = scheds.filter(s => s.day_of_week === day);
        // Sort by start time so earlier schedules claim rows first
        dayScheds.sort((a, b) => csTimeToMinutes(a.start_time) - csTimeToMinutes(b.start_time));
        dayScheds.forEach(s => {
            const startMins = csTimeToMinutes(s.start_time);
            const endMins   = csTimeToMinutes(s.end_time);
            const startRow = timePoints.indexOf(startMins);
            const endRow = timePoints.indexOf(endMins);
            if (startRow < 0 || endRow <= startRow) return;

            const span = endRow - startRow;
            const hasOccupiedRow = Array.from({ length: span }, (_, offset) => slotSpan[day][startRow + offset]).some(Boolean);
            if (!hasOccupiedRow) {
                slotStart[day][startRow] = {
                    schedule_id: s.schedule_id,
                    rowspan: span
                };
                for (let r = startRow; r < endRow; r++) {
                    slotSpan[day][r] = true;
                }
            }
        });
    });

    const rows = timeRows.map((mins, rowIndex) => {
        const timeLabel = fmtTimePoint(mins);
        const cells = DAYS.map(day => {
            // This cell is covered by a rowspan that started earlier
            if (slotSpan[day][rowIndex] && !slotStart[day][rowIndex]) {
                return '';
            }

            const slot = slotStart[day][rowIndex];
            if (slot) {
                const s = scheds.find(x => x.schedule_id === slot.schedule_id);
                if (s) {
                    const rowspan   = slot.rowspan > 1 ? ` rowspan="${slot.rowspan}"` : '';
                    const timeRange = `${csFormatTime(s.start_time)} – ${csFormatTime(s.end_time)}`;
                    const o = csState.offerings.find(x => x.class_id === s.class_id) || {};
                    const isActivity = s.schedule_type === 'fixed_activity';
                    const title   = escHtml(isActivity
                        ? (s.activity_name || 'Manual entry')
                        : csDisplaySubjectName(s.subject_name || o.subject_name, s.subject_code || o.subject_code, s.area_code || o.area_code));
                    const actions = canEdit ? `
                        <span class="cs-block-actions">
                            <button type="button" onclick="event.stopPropagation(); csDeleteSchedule(${s.schedule_id})" title="Remove schedule" aria-label="Remove schedule entry"><i class="fas fa-xmark"></i></button>
                        </span>` : '';
                    // Show section badge when teacher views all their classes (no specific section filtered)
                    const showSectionBadge = !isActivity && !hideSectionBadge && !csState.selectedSection && s.section_name;
                    const sectionLabel = escHtml(s.grade_name && s.section_name
                        ? `${s.grade_name} – ${s.section_name}`
                        : (s.section_name || 'Unknown'));
                    const sectionBadge = showSectionBadge
                        ? `<span class="cs-section-label">${sectionLabel}</span>`
                        : '';
                    const teacherLabel = csState.role !== 'teacher' && !isActivity && s.teacher_name
                        ? `<span class="cs-teacher-label">${escHtml(s.teacher_name)}</span>`
                        : '';
                    const blockClick = canEdit ? ` onclick="csEditFromGrid(${s.schedule_id})" title="Click to edit"` : '';
                    const blockStyle = canEdit ? '' : ' style="cursor:default;"';
                    return `<td${rowspan}><div class="cs-grid-block${canEdit ? ' cs-grid-block--editable' : ''}${isActivity ? ' cs-grid-block--activity' : ''}"${blockClick}${blockStyle}>
                        ${actions}
                        <b>${title}</b>
                        ${sectionBadge}
                        ${teacherLabel}
                        <small>${timeRange}</small>
                    </div></td>`;
                }
            }

            return '<td></td>';
        }).join('');
        return `<tr><td class="timecol">${timeLabel}</td>${cells}</tr>`;
    }).join('');

    return `<table class="cs-grid-table"><thead><tr>${thRow}</tr></thead><tbody>${rows}</tbody></table>`;
}

function csBuildMobileScheduleHtml(scheds, canEdit) {
    const isTeacherView = csState.role === 'teacher' && !csState.selectedSection;
    const isAllScheduleView = isTeacherView;

    if ((!csState.selectedSection && !isAllScheduleView) || !Array.isArray(scheds) || !scheds.length) {
        return csScheduleEmptyStateHtml();
    }

    const showTeacher = csState.role !== 'teacher';
    const daySections = DAYS.map(day => {
        const dayScheds = scheds
            .filter(s => s.day_of_week === day)
            .sort((a, b) => csTimeToMinutes(a.start_time) - csTimeToMinutes(b.start_time));

        const entries = dayScheds.map(s => {
            const isActivity = s.schedule_type === 'fixed_activity';
            const title = escHtml(isActivity
                ? (s.activity_name || 'Manual entry')
                : csDisplaySubjectName(s.subject_name, s.subject_code, s.area_code));
            const timeRange = `${csFormatTime(s.start_time)} – ${csFormatTime(s.end_time)}`;
            const sectionLabel = !isActivity && !csState.selectedSection && s.section_name
                ? `<span class="cs-mobile-entry-section">${escHtml(s.grade_name && s.section_name ? `${s.grade_name} – ${s.section_name}` : s.section_name)}</span>`
                : '';
            const teacherLabel = showTeacher && !isActivity
                ? `<span class="cs-mobile-entry-teacher">${escHtml(s.teacher_name || '—')}</span>`
                : '';
            const actions = canEdit ? `
                <span class="cs-mobile-entry-actions">
                    <button type="button" onclick="event.stopPropagation(); csDeleteSchedule(${s.schedule_id})" title="Remove schedule" aria-label="Remove schedule entry"><i class="fas fa-xmark"></i></button>
                </span>` : '';
            const click = canEdit ? ` onclick="csEditFromGrid(${s.schedule_id})" title="Click to edit"` : '';

            return `<article class="cs-mobile-entry${canEdit ? ' cs-mobile-entry--editable' : ''}${isActivity ? ' cs-mobile-entry--activity' : ''}"${click}>
                <time class="cs-mobile-entry-time">${timeRange}</time>
                <div class="cs-mobile-entry-main">
                    ${actions}
                    <b class="cs-mobile-entry-title">${title}</b>
                    ${sectionLabel}
                </div>
                <div class="cs-mobile-entry-teacher-cell">${teacherLabel}</div>
            </article>`;
        }).join('');

        const dayContent = entries.length
            ? `<div class="cs-mobile-day-list">${entries}</div>`
            : '<div class="cs-mobile-day-empty"><video class="mp4-surface-blend context-empty-video cs-mobile-day-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="../assets/icons/calendar.mp4" type="video/mp4"></video><span>No classes scheduled.</span></div>';

        return `<section class="cs-mobile-day">
            <h3 class="cs-mobile-day-title">${DAY_LABELS[day]}</h3>
            <div class="cs-mobile-entry-columns" aria-hidden="true">
                <span>Time</span><span>Subject</span>${showTeacher ? '<span>Teacher</span>' : ''}
            </div>
            ${dayContent}
        </section>`;
    }).join('');

    return daySections || `<div class="cs-grid-empty"><video class="mp4-surface-blend context-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="../assets/icons/calendar.mp4" type="video/mp4"></video><strong>No schedule entries.</strong></div>`;
}

function csTimeToMinutes(t) {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
}

/* ════════════════════════════════════
   VIEW MODAL
   ════════════════════════════════════ */
function csViewSchedule(scheduleId) {
    const s = csState.schedules.find(x => x.schedule_id === scheduleId);
    if (!s) return;

    const isActivity = s.schedule_type === 'fixed_activity';
    const title = isActivity
        ? (s.activity_name || 'Manual activity')
        : csDisplaySubjectName(s.subject_name, s.subject_code, s.area_code);

    document.getElementById('viewModalTitle').textContent = `${title} — ${DAY_LABELS[s.day_of_week]}`;

    const mins = csDurationMins(s.start_time, s.end_time);

    const details = `
        ${isActivity
            ? csDetailItem('Description', escHtml(s.activity_name || 'Manual activity'))
            : csDetailItem('Subject', escHtml(csDisplaySubjectName(s.subject_name, s.subject_code, s.area_code)))}
        ${csDetailItem('Section',     escHtml(s.section_name))}
        ${csDetailItem('Grade Level', escHtml(s.grade_name))}
        ${!isActivity && csState.role !== 'teacher' ? csDetailItem('Teacher', escHtml(s.teacher_name || '')) : ''}
        ${isActivity ? csDetailItem('Type', 'Manual activity') : ''}
        ${csDetailItem('Day',         DAY_LABELS[s.day_of_week])}
        ${csDetailItem('Time',        `${csFormatTime(s.start_time)} – ${csFormatTime(s.end_time)} (${mins} min)`)}
        ${csDetailItem('School Year', escHtml(s.year_label))}
    `;

    document.getElementById('viewModalBody').innerHTML = `
        <div class="cs-view-summary">
            <div class="cs-detail-grid">
                ${details}
            </div>
        </div>`;

    const editBtn   = document.getElementById('viewModalEditBtn');
    const deleteBtn = document.getElementById('viewModalDeleteBtn');

    if (csState.isReadOnly) {
        if (editBtn)   editBtn.style.display   = 'none';
        if (deleteBtn) deleteBtn.style.display = 'none';
    } else {
        if (editBtn)   editBtn.style.display   = '';
        if (deleteBtn) deleteBtn.style.display = '';
        editBtn.onclick   = () => { csCloseViewModal(); csEditFromGrid(scheduleId); };
        deleteBtn.onclick = () => csDeleteSchedule(scheduleId);
    }

    csOpenModal('scheduleViewModal');
}

function csDetailItem(label, value) {
    return `<div class="cs-detail-item">
        <div class="cs-detail-label">${label}</div>
        <div class="cs-detail-value">${value}</div>
    </div>`;
}

/* ════════════════════════════════════
   SIDE FORM — Schedule entry
   ════════════════════════════════════ */

function csSetFormMsg(text, type) {
    const el = document.getElementById('csFormMsg');
    if (!el) return;
    el.className = 'msg' + (type ? ' ' + type : '');
    if (!text) {
        el.style.display = 'none';
        el.innerHTML = '';
    } else {
        el.style.display = '';
        el.innerHTML = escHtml(text).replace(/\n/g, '<br>');
    }
}

function csGetSelectedDays() {
    const input = document.getElementById('csDayOfWeek');
    return String(input?.value || '')
        .split(',')
        .map(d => d.trim())
        .filter(d => DAYS.includes(d));
}

function csSetSelectedDays(days) {
    const selectedDays = [...new Set((Array.isArray(days) ? days : [days]).filter(d => DAYS.includes(d)))];
    const input = document.getElementById('csDayOfWeek');
    if (input) input.value = selectedDays.join(',');

    document.querySelectorAll('#csDayBoxes .cs-day-box').forEach(btn => {
        const isSelected = selectedDays.includes(btn.dataset.day);
        btn.classList.toggle('selected', isSelected);
        btn.setAttribute('aria-pressed', String(isSelected));
    });
}

function csSelectDay(day) {
    if (!day) {
        csSetSelectedDays([]);
        return;
    }

    if (csState.editingId) {
        csSetSelectedDays([day]);
        return;
    }

    const selectedDays = csGetSelectedDays();
    const nextDays = selectedDays.includes(day)
        ? selectedDays.filter(d => d !== day)
        : [...selectedDays, day];
    csSetSelectedDays(nextDays);
}

function csResetForm() {
    csState.editingId = null;
    csClearErrors();
    document.getElementById('csScheduleId').value = '';
    const typeSel = document.getElementById('csScheduleType');
    if (typeSel) typeSel.value = 'class';
    const classSel = document.getElementById('csClassId');
    if (classSel) {
        classSel.value = '';
        csSyncEnhancedSelect(classSel);
    }
    document.getElementById('csStartTime').value = '07:30';
    document.getElementById('csEndTime').value = '08:30';
    const activityInput = document.getElementById('csActivityName');
    if (activityInput) activityInput.value = '';
    csSetSelectedDays([]);
    document.getElementById('csSaveBtnText').textContent = 'Save Schedule Entry';
    csSetFormMsg('', '');
    csOnScheduleTypeChange();
}

async function csEditFromGrid(scheduleId) {
    if (csState.isReadOnly) {
        csViewSchedule(scheduleId);
        return;
    }
    if (!csState.selectedSection) {
        csToast('Please select a section first.', 'warning');
        return;
    }

    const s = csState.schedules.find(x => x.schedule_id === scheduleId);
    if (!s) return;

    csState.editingId = scheduleId;
    csClearErrors();
    csSetFormMsg('', '');

    document.getElementById('csSaveBtnText').textContent = 'Update Schedule Entry';
    document.getElementById('csScheduleId').value = s.schedule_id;
    const typeSel = document.getElementById('csScheduleType');
    if (typeSel) typeSel.value = s.schedule_type === 'fixed_activity' ? 'fixed_activity' : 'class';
    document.getElementById('csStartTime').value = s.start_time;
    document.getElementById('csEndTime').value = s.end_time;
    const activityInput = document.getElementById('csActivityName');
    if (activityInput) activityInput.value = s.activity_name || '';
    csSetSelectedDays([s.day_of_week]);
    csOnScheduleTypeChange();

    // Ensure the offering list contains this class_id.
    if (s.schedule_type !== 'fixed_activity' && s.class_id && !csState.offerings.some(o => o.class_id === s.class_id)) {
        await csLoadOfferings();
    }
    const classSel = document.getElementById('csClassId');
    if (classSel && s.schedule_type !== 'fixed_activity') {
        classSel.value = s.class_id ? String(s.class_id) : '';
        csSyncEnhancedSelect(classSel);
    }
}

function csFindConflicts(selectedDays, classId, startTime, endTime, excludeScheduleId, scheduleType = 'class') {
    const offering = classId ? csState.offerings.find(o => String(o.class_id) === String(classId)) : null;
    const teacherId = scheduleType === 'class' ? offering?.teacher_id : null;
    const conflicts = [];
    const sStart = csTimeToMinutes(startTime);
    const sEnd   = csTimeToMinutes(endTime);
    const requestedMinutes = Math.max(0, sEnd - sStart);
    const dailyLimitMinutes = scheduleType === 'class' ? Number(offering?.meeting_minutes || 0) : 0;

    for (const day of selectedDays) {
        if (scheduleType === 'class' && classId && dailyLimitMinutes > 0) {
            const existingDailyMinutes = csState.schedules
                .filter(s => !excludeScheduleId || s.schedule_id != excludeScheduleId)
                .filter(s => s.schedule_type !== 'fixed_activity')
                .filter(s => s.class_id == classId && s.day_of_week === day)
                .reduce((total, s) => total + Math.max(0, csDurationMins(s.start_time, s.end_time)), 0);
            if (existingDailyMinutes + requestedMinutes > dailyLimitMinutes) {
                conflicts.push({
                    day,
                    type: 'daily_limit',
                    message: `${DAY_LABELS[day]} has ${existingDailyMinutes} of ${dailyLimitMinutes} daily minutes for this subject. Adding ${requestedMinutes} more would exceed the daily allowance.`
                });
            }
        }

        for (const s of csState.schedules) {
            if (excludeScheduleId && s.schedule_id == excludeScheduleId) continue;
            if (s.day_of_week !== day) continue;

            const eStart = csTimeToMinutes(s.start_time);
            const eEnd   = csTimeToMinutes(s.end_time);

            // Section time-slot overlap: same section cannot have two items at once
            if (csState.selectedSection &&
                s.section_id == csState.selectedSection.section_id &&
                sStart < eEnd && sEnd > eStart) {
                const existingName = String(
                    s.schedule_type === 'fixed_activity'
                        ? (s.activity_name || 'Manual activity')
                        : (csDisplaySubjectName(s.subject_name, s.subject_code, s.area_code) || 'Schedule')
                );
                conflicts.push({
                    day,
                    type: 'section',
                    message: `${DAY_LABELS[day]} ${csFormatTime(startTime)} – ${csFormatTime(endTime)} overlaps with ${existingName} in this section.`
                });
                break;
            }

            // Exact duplicate slot for the same class offering
            if (scheduleType === 'class' && s.class_id == classId && sStart === eStart && sEnd === eEnd) {
                conflicts.push({
                    day,
                    type: 'duplicate',
                    message: `${DAY_LABELS[day]} ${csFormatTime(s.start_time)} – ${csFormatTime(s.end_time)} already exists for this class offering.`
                });
                break;
            }

            // Teacher time overlap
            if (teacherId && s.teacher_id == teacherId && sStart < eEnd && sEnd > eStart) {
                conflicts.push({
                    day,
                    type: 'teacher',
                    message: `${DAY_LABELS[day]} ${csFormatTime(startTime)} – ${csFormatTime(endTime)} overlaps with ${csDisplaySubjectName(s.subject_name, s.subject_code, s.area_code)} (same teacher).`
                });
                break;
            }
        }
    }
    return conflicts;
}

async function csSaveSchedule() {
    csClearErrors();
    csSetFormMsg('', '');

    if (!csState.selectedSection || !csState.selectedSY) {
        csSetFormMsg('Please select a school year and section before saving.', 'err');
        return;
    }

    const scheduleId   = document.getElementById('csScheduleId').value;
    const scheduleType = csSelectedScheduleType();
    const classId      = document.getElementById('csClassId')?.value || '';
    const activityName = document.getElementById('csActivityName')?.value.trim() || '';
    const selectedDays = csGetSelectedDays();
    const startTime    = document.getElementById('csStartTime').value;
    const endTime      = document.getElementById('csEndTime').value;

    let valid = true;
    if (scheduleType === 'class' && !classId) { csSetErr('errClassId', 'Please select a class offering.'); valid = false; }
    if (scheduleType === 'fixed_activity' && !activityName) { csSetErr('errActivityName', 'Enter a description such as Lunch or Flag Ceremony.'); valid = false; }
    if (activityName.length > 100) { csSetErr('errActivityName', 'Description must be 100 characters or fewer.'); valid = false; }
    if (!selectedDays.length){ csSetErr('errDayOfWeek',  'Please select at least one day.'); valid = false; }
    if (!startTime){ csSetErr('errStartTime',  'Start time is required.'); valid = false; }
    if (!endTime)  { csSetErr('errEndTime',    'End time is required.'); valid = false; }
    if (startTime && endTime && endTime <= startTime) {
        csSetErr('errEndTime', 'End time must be after start time.'); valid = false;
    }
    if (!valid) return;

    if (scheduleType === 'class') {
        const selectedOffering = csState.offerings.find(
            offering => Number(offering.class_id) === Number(classId)
        );
        const dailyLimitMinutes = Number(selectedOffering?.meeting_minutes || 0);
        const actualMinutes = csDurationMins(startTime, endTime);
        if (dailyLimitMinutes > 0 && actualMinutes > dailyLimitMinutes) {
            csSetErr('errEndTime', `This schedule uses ${actualMinutes} minutes, but the subject daily allowance is ${dailyLimitMinutes} minutes.`);
            csSetFormMsg('Shorten this schedule or increase the subject daily minutes in Curriculum.', 'err');
            return;
        }
    }

    // Always refresh schedules from the server just before conflict checking
    // to avoid false positives from stale in-memory data (e.g. after a delete).
    await csLoadSchedules();

    let daysToSave = scheduleId ? [selectedDays[0]] : selectedDays;
    const conflicts = csFindConflicts(
        daysToSave,
        scheduleType === 'class' ? classId : null,
        startTime,
        endTime,
        scheduleId ? parseInt(scheduleId, 10) : null,
        scheduleType
    );
    if (conflicts.length) {
        const conflictDays = new Set(conflicts.map(c => c.day));
        const okDays = daysToSave.filter(d => !conflictDays.has(d));
        const lines = conflicts.map(c => `• ${c.message}`).join('\n');

        if (scheduleId || okDays.length === 0) {
            csSetFormMsg(`Cannot save because of conflicts:\n${lines}`, 'err');
            csToast('Scheduling conflict detected. Please review the form message.', 'warning');
            return;
        }

        const proceed = typeof window.showConfirmationDialog === 'function'
            ? await window.showConfirmationDialog({
                title: 'Some days are already in use',
                message: `Save this schedule only for ${okDays.map(d => DAY_LABELS[d]).join(', ')}? The conflicting days will be skipped.\n\n${lines}`,
                confirmText: 'Save available days',
                cancelText: 'Review setup',
                tone: 'primary',
                icon: 'fa-calendar-check'
            })
            : false;
        if (!proceed) return;
        daysToSave = okDays;
    }

    if (!scheduleId && scheduleType === 'class') {
        const selectedOffering = csState.offerings.find(
            offering => Number(offering.class_id) === Number(classId)
        );
        const existingWeeklyDays = new Set(csState.schedules
            .filter(schedule => schedule.schedule_type !== 'fixed_activity')
            .filter(schedule => Number(schedule.class_id) === Number(classId))
            .map(schedule => schedule.day_of_week)
            .filter(Boolean));
        const weeklyDaysAfterSave = new Set(existingWeeklyDays);
        daysToSave.forEach(day => weeklyDaysAfterSave.add(day));
        if (weeklyDaysAfterSave.size > MAX_WEEKLY_SCHEDULE_ENTRIES_PER_OFFERING) {
            const remaining = Math.max(0, MAX_WEEKLY_SCHEDULE_ENTRIES_PER_OFFERING - existingWeeklyDays.size);
            csSetErr(
                'errClassId',
                `This class offering has ${existingWeeklyDays.size} of 5 weekly days. You can add ${remaining} more day${remaining === 1 ? '' : 's'}.`
            );
            csToast('The class offering is limited to 5 scheduled days per week.', 'warning');
            return;
        }
    }

    const payload = {
        schedule_type:   scheduleType,
        activity_name:   scheduleType === 'fixed_activity' ? activityName : null,
        start_time:      startTime,
        end_time:        endTime,
        school_year_id:  csState.selectedSY.school_year_id,
        section_id:      csState.selectedSection.section_id,
        class_id:        scheduleType === 'class' ? parseInt(classId, 10) : null,
    };

    try {
        if (scheduleId) {
            payload.schedule_id = parseInt(scheduleId, 10);
            payload.day_of_week = selectedDays[0];
            await csApi.update(payload);
            csSetFormMsg('Schedule updated successfully.', 'ok');
            csToast('Schedule updated.');
        } else {
            for (const day of daysToSave) {
                await csApi.create({ ...payload, day_of_week: day });
            }
            const dayCount = daysToSave.length;
            csSetFormMsg(`${dayCount} schedule ${dayCount === 1 ? 'entry' : 'entries'} saved.`, 'ok');
            csToast(dayCount === 1 ? 'Schedule added.' : `${dayCount} schedules added.`);
        }
        csResetForm();
        await Promise.all([
            csLoadSchedules(),
            scheduleType === 'class' ? csLoadOfferings() : Promise.resolve()
        ]);
    } catch (e) {
        const msg = e?.response?.data?.message || 'Failed to save schedule.';
        csSetFormMsg(msg, 'err');
        csToast(msg, 'error');
    }
}

async function csDeleteSchedule(scheduleId) {
    const numericScheduleId = Number(scheduleId);
    if (!Number.isInteger(numericScheduleId) || numericScheduleId <= 0 || csState.deletingId) return;

    const s = csState.schedules.find(x => Number(x.schedule_id) === numericScheduleId);
    if (!s || Number(s.is_deleted || 0) === 1) {
        csToast('This schedule entry is no longer active. The schedule will be refreshed.', 'warning');
        await csLoadSchedules();
        return;
    }

    const name = s.schedule_type === 'fixed_activity'
        ? (s.activity_name || 'Manual activity')
        : `${csDisplaySubjectName(s.subject_name, s.subject_code, s.area_code)} — ${s.teacher_name || 'Unassigned teacher'}`;

    const confirmed = typeof window.showConfirmationDialog === 'function'
        ? await window.showConfirmationDialog({
            title: 'Remove this schedule entry?',
            message: `Remove “${name}” from the active schedule for ${DAY_LABELS[s.day_of_week]} at ${csFormatTime(s.start_time)} – ${csFormatTime(s.end_time)}?`,
            confirmText: 'Remove schedule',
            cancelText: 'Keep schedule',
            tone: 'danger',
            icon: 'fa-calendar-xmark'
        })
        : false;
    if (!confirmed) return;

    csState.deletingId = numericScheduleId;
    const viewDeleteButton = document.getElementById('viewModalDeleteBtn');
    if (viewDeleteButton) {
        viewDeleteButton.disabled = true;
        viewDeleteButton.setAttribute('aria-busy', 'true');
    }

    try {
        const result = await csApi.remove(numericScheduleId);
        if (result?.success === false) throw new Error(result.message || 'Could not remove this schedule entry.');
        csToast('Schedule entry removed.');
        csCloseViewModal();
        await Promise.all([csLoadSchedules(), csLoadOfferings()]);
    } catch (e) {
        csToast(e?.response?.data?.message || e?.message || 'Could not remove schedule entry.', 'error');
    } finally {
        csState.deletingId = null;
        if (viewDeleteButton) {
            viewDeleteButton.disabled = false;
            viewDeleteButton.removeAttribute('aria-busy');
        }
    }
}


/* ════════════════════════════════════
   EXPORT HELPERS (currently unused while UI is focused on scheduling)
   ════════════════════════════════════ */

function csSlug(str) {
    return String(str || '').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

function csMeta() {
    const sc = csState.school;
    const sectionMap = new Map();
    csState.schedules.forEach(s => {
        const sectionName = String(s.section_name || '').trim();
        if (!sectionName) return;
        const gradeName = String(s.grade_name || '').trim();
        const label = [gradeName, sectionName].filter(Boolean).join(' ');
        sectionMap.set(String(s.section_id || label), label || sectionName);
    });
    if (csState.selectedSection?.section_name) {
        const gradeName = String(csState.selectedGL?.grade_name || csState.schedules[0]?.grade_name || '').trim();
        const label = [gradeName, String(csState.selectedSection.section_name).trim()].filter(Boolean).join(' ');
        sectionMap.set(String(csState.selectedSection.section_id || label), label || String(csState.selectedSection.section_name).trim());
    }
    const sections = [...sectionMap.values()].filter(Boolean);
    return {
        schoolName : String(sc.name || '').trim(),
        head       : sc.head     || '',
        division   : sc.division || '',
        district   : sc.district || '',
        region     : sc.region   || '',
        section    : csState.selectedSection?.section_name || '',
        grade      : csState.selectedGL?.grade_name        || (csState.schedules[0]?.grade_name || ''),
        sections,
        sectionDisplay: sections.join(', '),
        sy         : csState.selectedSY?.year_label        || '',
        adviser    : (() => {
            const sec = csState.sections?.find(s => s.section_id === csState.selectedSection?.section_id);
            return sec?.adviser_name || '';
        })(),
    };
}

async function csTryFetchAsDataUrl(url) {
    try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return null;
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            res.blob().then(b => reader.readAsDataURL(b));
        });
    } catch (_) { return null; }
}

async function csResolveLogos() {
    // APP_BASE is intentionally an empty string when the app is deployed at
    // the domain root (for example on InfinityFree). Do not use `||` here or
    // root deployments incorrectly fall back to /deped_capstone2.
    const configuredBase = typeof window.APP_BASE === 'string'
        ? window.APP_BASE
        : '/deped_capstone2';
    const base = new URL(configuredBase || '/', window.location.origin).href.replace(/\/$/, '');
    const left   = `${base}/assets/img/logo/Seal_of_the_Department_of_Education_of_the_Philippines.png`;
    const right  = `${base}/assets/img/logo/logo.png`;
    const [l, r] = await Promise.all([csTryFetchAsDataUrl(left), csTryFetchAsDataUrl(right)]);
    return { left: l || left, right: r || right };
}

async function csEnsureHtml2Pdf() {
    if (window.html2pdf) return window.html2pdf;
    await new Promise((resolve, reject) => {
        const tag = 'script[data-cs-html2pdf="1"]';
        const existing = document.querySelector(tag);
        if (existing) {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', () => reject(new Error('PDF library failed to load')), { once: true });
            return;
        }
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
        s.async = true;
        s.dataset.csHtml2pdf = '1';
        s.onload  = resolve;
        s.onerror = () => reject(new Error('Failed to load PDF library'));
        document.head.appendChild(s);
    });
    if (!window.html2pdf) throw new Error('PDF library unavailable');
    return window.html2pdf;
}

async function csWaitForImages(container, timeoutMs = 6000) {
    const imgs = Array.from(container.querySelectorAll('img'));
    if (!imgs.length) return;
    const start = Date.now();
    await Promise.all(imgs.map(img => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise(resolve => {
            const done = () => resolve();
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
            const poll = () => {
                if ((img.complete && img.naturalWidth > 0) || (Date.now() - start) > timeoutMs) resolve();
                else setTimeout(poll, 150);
            };
            poll();
        });
    }));
}

function csDocCss() {
    return `
    *{box-sizing:border-box;margin:0;padding:0;}
    /* .cs-doc wraps the whole document in both print-window and PDF mount */
    .cs-doc{font-family:Arial,Helvetica,sans-serif;font-size:10pt;
            color:#1a1a1a;background:#fff;padding:14mm 16mm 18mm;
            width:100%;max-width:794px;}

    /* ── Letterhead ── */
    .lh{display:flex;align-items:center;gap:14px;
        padding-bottom:8px;margin-bottom:0;}
    .lh img{width:60px;height:60px;object-fit:contain;flex-shrink:0;}
    .lh-mid{flex:1;text-align:center;line-height:1.3;}
    .lh-republic{font-size:7.5pt;letter-spacing:.5px;color:#555;}
    .lh-dept{font-size:10.5pt;font-weight:700;color:#0055A4;}
    .lh-school{font-size:12pt;font-weight:800;color:#1a1a1a;text-transform:uppercase;letter-spacing:.15px;margin-top:2px;}
    .lh-div,.lh-dist{font-size:8pt;color:#555;}

    /* ── Title block ── */
    .title-block{background:#0055A4;color:#fff;text-align:center;
                 padding:9px 12px 7px;margin:0 0 10px;
                 -webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .title-block h1{font-size:13pt;font-weight:700;text-transform:uppercase;
                    letter-spacing:.6px;}
    .title-block .sy{font-size:9pt;margin-top:2px;opacity:.9;font-weight:500;}

    /* ── Context block ── */
    .meta-block{display:flex;justify-content:center;align-items:center;flex-wrap:wrap;
                gap:4px 22px;margin:10px 0 14px;text-align:center;}
    .meta-primary{font-size:11pt;font-weight:800;color:#1a1a1a;}
    .meta-secondary{font-size:9pt;color:#4b5563;}

    /* ── Day heading ── */
    .day-head,.section-head{font-size:9.5pt;font-weight:700;text-transform:uppercase;
              letter-spacing:.5px;background:#0055A4;color:#fff;
              padding:5px 10px;margin:14px 0 0;
              -webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .section-head{background:#e7eef7;color:#004482;border-bottom:2px solid #0055A4;
                  -webkit-print-color-adjust:exact;print-color-adjust:exact;}

    /* ── Table ── */
    table{width:100%;border-collapse:collapse;font-size:9.5pt;
          margin-bottom:2px;page-break-inside:auto;}
    thead tr{background:#004482;color:#fff;
             -webkit-print-color-adjust:exact;print-color-adjust:exact;}
    th{font-weight:700;padding:5px 8px;text-align:center;
       font-size:8.5pt;border:1px solid #004482;}
    td{border:1px solid #c8c8c8;padding:5px 8px;vertical-align:middle;}
    tbody tr:nth-child(even) td{background:#f4f8ff;
        -webkit-print-color-adjust:exact;print-color-adjust:exact;}
    td.c{text-align:center;}
    td.mono{font-family:'Courier New',monospace;white-space:nowrap;text-align:center;}
    tr.total-row td{font-weight:700;background:#dce8f7;color:#004482;
                    text-align:center;border-top:2px solid #0055A4;
                    -webkit-print-color-adjust:exact;print-color-adjust:exact;}

    /* ── Signatures ── */
    .sigs{display:grid;grid-template-columns:1fr 1fr;gap:60px;margin-top:40px;}
    .sig-block{text-align:center;}
    .sig-prepared{font-size:8pt;color:#555;margin-bottom:30px;}
    .sig-name{font-weight:700;font-size:10pt;border-bottom:2px solid #0055A4;
              padding-bottom:3px;min-height:26px;display:flex;
              align-items:flex-end;justify-content:center;color:#004482;}
    .sig-role{font-size:8pt;margin-top:4px;color:#555;}
    .sig-date{font-size:8pt;margin-top:14px;text-align:left;color:#555;}

    /* ── Print window ── */
    body{margin:0;padding:0;background:#fff;}
    @media print{
        @page{margin:12mm 15mm;size:A4 portrait;}
        .cs-doc{padding:0;}
        .day-head{page-break-before:auto;}
    }`;
}

/* ═══════════════════════════════════════════════════════════
   DOCUMENT GENERATOR
   Both Print (new window) and Export (HTML download) use the
   same csGenerateDocument() to build the styled HTML body.
   type: 'program' | 'teacher' | 'learner'
   ═══════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────
   SHARED DOCUMENT BUILDER
   Builds a complete DepEd-styled HTML document body
   for all three export types.
   type: 'program' | 'teacher' | 'learner'
   ───────────────────────────────────────────────────── */
async function csGenerateDocument(type) {
    const m      = csMeta();
    const scheds = csState.schedules;
    const logos  = await csResolveLogos();

    const logoImg = (src, alt) =>
        `<img src="${src}" alt="${alt}" style="width:64px;height:64px;object-fit:contain;flex-shrink:0;">`;

    const letterhead = () => `
        <div class="lh">
            ${logoImg(logos.left,  'DepEd Logo')}
            <div class="lh-mid">
                <div class="lh-republic">Republic of the Philippines</div>
                <div class="lh-dept">Department of Education</div>
                ${m.schoolName ? `<div class="lh-school">${escHtml(m.schoolName)}</div>` : ''}
                ${m.division ? `<div class="lh-div">${escHtml(m.division)}</div>` : ''}
                ${m.district ? `<div class="lh-dist">${escHtml(m.district)}</div>` : ''}
            </div>
            ${logoImg(logos.right, 'DepEd Seal')}
        </div>
        <div class="meta-block">
            ${m.sectionDisplay ? `<span class="meta-primary">${escHtml(m.sectionDisplay)}</span>` : ''}
            ${m.sy ? `<span class="meta-secondary">School Year ${escHtml(m.sy)}</span>` : ''}
        </div>`;

    const dayTableHtml = (day, rows, cols) => {
        const total = rows.reduce((s, r) => s + csDurationMins(r.start_time, r.end_time), 0);
        const trs   = rows.map((s, i) => `<tr>${cols.map(c => c.fn(s, i)).join('')}</tr>`).join('');
        const thRow = cols.map(c => `<th ${c.w ? `style="width:${c.w}"` : ''}>${c.label}</th>`).join('');
        return `
            <div class="day-head">${DAY_LABELS[day]}</div>
            <table>
                <thead><tr>${thRow}</tr></thead>
                <tbody>
                    ${trs}
                    <tr class="total-row">
                        <td colspan="${cols.length - 3}">Total No. of Minutes</td>
                        <td>${total}</td>
                        <td colspan="2"></td>
                    </tr>
                </tbody>
            </table>`;
    };

    const sigs = (leftLabel, leftName, leftRole, rightLabel, rightName, rightRole) => `
        <div class="sigs">
            <div class="sig-block">
                <div class="sig-prepared">${leftLabel}</div>
                <div class="sig-name">${escHtml(leftName  || '')}</div>
                <div class="sig-role">${leftRole}</div>
                <div class="sig-date">Date: ____________________</div>
            </div>
            <div class="sig-block">
                <div class="sig-prepared">${rightLabel}</div>
                <div class="sig-name">${escHtml(rightName || '')}</div>
                <div class="sig-role">${rightRole}</div>
                <div class="sig-date">Date: ____________________</div>
            </div>
        </div>`;

    let body = '';

    /* ────── CLASS PROGRAM ────── */
    if (type === 'program') {
        const cols = [
            { label: 'No.',       w: '30px',  fn: (s, i) => `<td class="c">${i + 1}</td>` },
            { label: 'Time In',   w: '80px',  fn: (s)    => `<td class="mono">${escHtml(csFormatTime(s.start_time))}</td>` },
            { label: 'Time Out',  w: '80px',  fn: (s)    => `<td class="mono">${escHtml(csFormatTime(s.end_time))}</td>` },
            { label: 'Min',       w: '42px',  fn: (s)    => `<td class="c">${csDurationMins(s.start_time, s.end_time)}</td>` },
            { label: 'Learning Area / Subject', fn: (s) => `<td>${escHtml(csDisplaySubjectName(s.subject_name, s.subject_code, s.area_code))}</td>` },
            { label: 'Teacher',   w: '155px', fn: (s)    => `<td>${escHtml(s.teacher_name)}</td>` },
        ];
        const daysHtml = DAYS.filter(d => scheds.some(s => s.day_of_week === d)).map(day => {
            const rows = scheds.filter(s => s.day_of_week === day).sort((a, b) => a.start_time.localeCompare(b.start_time));
            return dayTableHtml(day, rows, cols);
        }).join('');

        body = letterhead()
            + `<div class="title-block"><h1>Class Program</h1><div class="sy">School Year ${escHtml(m.sy)}</div></div>`
            + daysHtml
            + sigs('Prepared by:', m.adviser, 'Class Adviser',
                   'Noted by:', m.head, 'School Principal / Head');
    }

    /* ────── TEACHER'S SCHEDULE ────── */
    else if (type === 'teacher') {
        const sectionMap = new Map();
        scheds.forEach(s => {
            const grade = String(s.grade_name || '').trim();
            const section = String(s.section_name || '').trim();
            const key = String(s.section_id || `${grade}||${section}`);
            if (!sectionMap.has(key)) sectionMap.set(key, {
                name: [grade, section].filter(Boolean).join(' — '),
                rows: []
            });
            sectionMap.get(key).rows.push(s);
        });

        const cols = [
            { label: 'No.',       w: '28px',  fn: (s, i) => `<td class="c">${i + 1}</td>` },
            { label: 'Day',       w: '72px',  fn: (s)    => `<td>${escHtml(DAY_LABELS[s.day_of_week] || s.day_of_week)}</td>` },
            { label: 'Time In',   w: '75px',  fn: (s)    => `<td class="mono">${escHtml(csFormatTime(s.start_time))}</td>` },
            { label: 'Time Out',  w: '75px',  fn: (s)    => `<td class="mono">${escHtml(csFormatTime(s.end_time))}</td>` },
            { label: 'Min',       w: '38px',  fn: (s)    => `<td class="c">${csDurationMins(s.start_time, s.end_time)}</td>` },
            { label: 'Subject',               fn: (s)    => `<td>${escHtml(s.schedule_type === 'fixed_activity' ? (s.activity_name || 'Manual entry') : csDisplaySubjectName(s.subject_name, s.subject_code, s.area_code))}</td>` },
        ];

        let teacherBlocks = '';
        sectionMap.forEach(({ name, rows }) => {
            const sorted = [...rows].sort((a, b) =>
                DAYS.indexOf(a.day_of_week) - DAYS.indexOf(b.day_of_week) || a.start_time.localeCompare(b.start_time));
            const total = sorted.reduce((sum, r) => sum + csDurationMins(r.start_time, r.end_time), 0);
            const trs   = sorted.map((s, i) => `<tr>${cols.map(c => c.fn(s, i)).join('')}</tr>`).join('');
            const thRow = cols.map(c => `<th ${c.w ? `style="width:${c.w}"` : ''}>${c.label}</th>`).join('');
            teacherBlocks += `
                <table>
                    <thead><tr>${thRow}</tr></thead>
                    <tbody>
                        ${trs}
                        <tr class="total-row">
                            <td colspan="${cols.length - 3}">Total No. of Minutes</td>
                            <td>${total}</td><td colspan="2"></td>
                        </tr>
                    </tbody>
                </table>`;
        });

        body = letterhead()
            + `<div class="title-block"><h1>Class Schedule</h1><div class="sy">School Year ${escHtml(m.sy)}</div></div>`
            + teacherBlocks
            + sigs('Prepared by:', m.adviser, 'Class Adviser',
                   'Approved by:', m.head, 'School Principal / Head');
    }

    /* ────── LEARNER'S SCHEDULE ────── */
    else if (type === 'learner') {
        const cols = [
            { label: 'No.',       w: '30px',  fn: (s, i) => `<td class="c">${i + 1}</td>` },
            { label: 'Time In',   w: '80px',  fn: (s)    => `<td class="mono">${escHtml(csFormatTime(s.start_time))}</td>` },
            { label: 'Time Out',  w: '80px',  fn: (s)    => `<td class="mono">${escHtml(csFormatTime(s.end_time))}</td>` },
            { label: 'Min',       w: '42px',  fn: (s)    => `<td class="c">${csDurationMins(s.start_time, s.end_time)}</td>` },
            { label: 'Learning Area / Subject', fn: (s) => `<td>${escHtml(csDisplaySubjectName(s.subject_name, s.subject_code, s.area_code))}</td>` },
        ];
        const daysHtml = DAYS.filter(d => scheds.some(s => s.day_of_week === d)).map(day => {
            const rows = scheds.filter(s => s.day_of_week === day).sort((a, b) => a.start_time.localeCompare(b.start_time));
            return dayTableHtml(day, rows, cols);
        }).join('');

        body = letterhead()
            + `<div class="title-block"><h1>Class Schedule</h1><div class="sy">School Year ${escHtml(m.sy)}</div></div>`
            + daysHtml
            + sigs('Prepared by:', m.adviser, 'Class Adviser',
                   'Noted by:', m.head, 'School Principal / Head');
    }

    // Wrap in .cs-doc so padding/sizing works both in print-window body
    // and when mounted as a div for html2canvas/html2pdf
    body = `<div class="cs-doc cs-print-sheet">${body}</div>`;
    return { body, m };
}

/* ═══════════════════════════════════════════════════════════
   SHARED PDF RENDERER
   Mounts the generated HTML off-screen and saves as .pdf via
   html2pdf.js (same library used by report-cards.js).
   ═══════════════════════════════════════════════════════════ */
async function csSavePdf(body, filename, btnEl) {
    const origHtml = btnEl?.innerHTML || '';
    if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating PDF\u2026'; }

    try {
        const lib = await csEnsureHtml2Pdf();

        const fullHtml = `<!DOCTYPE html><html lang="en"><head>
            <meta charset="UTF-8">
            <style>${csDocCss()}</style>
        </head><body>${body}</body></html>`;

        const parsed      = new DOMParser().parseFromString(fullHtml, 'text/html');
        const inlineStyle = parsed.querySelector('style')?.textContent || '';
        const bodyHtml    = parsed.body?.innerHTML || '';

        // Wrap mount in a zero-size clip container so it is invisible to the
        // user but still in the compositing tree — html2canvas requires the
        // element to be rendered (not visibility:hidden / z-index:-1 / off at
        // left:-9999px) otherwise it captures a blank canvas.
        const wrapper = document.createElement('div');
        wrapper.style.cssText =
            'position:absolute;top:0;left:0;width:0;height:0;overflow:hidden;pointer-events:none;';

        const mount = document.createElement('div');
        mount.style.cssText = 'width:794px;background:#fff;';
        mount.innerHTML = `<style>${inlineStyle}</style>${bodyHtml}`;

        wrapper.appendChild(mount);
        document.body.appendChild(wrapper);

        await csWaitForImages(mount);
        // Two rAF passes: layout then paint.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        await lib()
            .set({
                filename,
                margin: 0,
                image:  { type: 'jpeg', quality: 0.98 },
                html2canvas: {
                    scale: 2,
                    useCORS: true,
                    allowTaint: true,
                    backgroundColor: '#ffffff',
                    scrollX: 0,
                    scrollY: 0,
                    logging: false,
                    width: 794,
                },
                jsPDF: { unit: 'px', format: [794, 1123], orientation: 'portrait', hotfixes: ['px_scaling'] },
                pagebreak: { mode: ['css', 'legacy'], avoid: ['.day-head', '.meta-block', '.lh', '.sigs'] },
            })
            .from(mount)
            .save();

        wrapper.remove();
        csToast('PDF downloaded successfully.');
    } catch (err) {
        csToast('PDF export failed: ' + (err?.message || 'unknown error'), 'error');
    } finally {
        if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = origHtml; }
    }
}

function csCalendarDocCss() {
    return `
    :root{--calendar-blue:#0055a4;--calendar-ink:#152235;--calendar-line:#b7c5d6;--calendar-soft:#eef5fc;}
    *{box-sizing:border-box;}
    html,body{margin:0;padding:0;background:#fff;color:var(--calendar-ink);font-family:Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    body{font-size:10pt;}
    img{display:block;}
    .cs-calendar-page{width:100%;max-width:1123px;margin:0 auto;background:#fff;}
    .cs-calendar-sheet{width:1123px;min-height:794px;padding:18px 18px 24px;background:#fff;}
    .cs-calendar-letterhead{display:grid;grid-template-columns:58px minmax(0,1fr) 58px;align-items:center;gap:12px;padding-bottom:4px;}
    .cs-calendar-letterhead img{width:58px;height:58px;object-fit:contain;}
    .cs-calendar-letterhead img:last-child{justify-self:end;}
    .cs-calendar-headtext{text-align:center;line-height:1.22;min-width:0;}
    .cs-calendar-republic{font-size:8pt;color:#526274;letter-spacing:.04em;}
    .cs-calendar-dept{font-size:10pt;font-weight:700;color:var(--calendar-blue);}
    .cs-calendar-school{margin-top:2px;font-size:12pt;font-weight:800;letter-spacing:.01em;text-transform:uppercase;overflow-wrap:anywhere;}
    .cs-calendar-location{font-size:7.5pt;color:#526274;}
    .cs-calendar-title{text-align:center;margin:12px 0 6px;font-size:15pt;font-weight:800;letter-spacing:.04em;text-transform:uppercase;}
    .cs-calendar-context{display:flex;justify-content:center;align-items:center;flex-wrap:wrap;gap:3px 18px;margin:0 0 12px;text-align:center;line-height:1.25;}
    .cs-calendar-context strong{font-size:11pt;}
    .cs-calendar-context span{font-size:9pt;color:#526274;}
    .cs-calendar-section{break-inside:avoid;page-break-inside:avoid;margin-top:10px;}
    .cs-calendar-grid{width:100%;table-layout:fixed;border-collapse:collapse;border:1px solid var(--calendar-line);font-size:9pt;}
    .cs-calendar-grid th,.cs-calendar-grid td{border:1px solid var(--calendar-line);}
    .cs-calendar-grid thead th{height:32px;padding:6px 4px;background:var(--calendar-blue);color:#fff;text-align:center;font-size:9pt;font-weight:800;letter-spacing:.04em;text-transform:uppercase;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .cs-calendar-grid thead th:first-child{width:78px;}
    .cs-calendar-grid td{height:30px;padding:3px 2px;background:#fff;vertical-align:top;}
    .cs-calendar-grid td.calendar-time{width:78px;padding:4px 3px;background:#f6f9fc;color:#4c6075;text-align:center;vertical-align:middle;font-family:'Courier New',monospace;font-size:8pt;font-weight:700;white-space:nowrap;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .cs-calendar-grid td.calendar-empty{background:#fbfdff;}
    .cs-calendar-event{height:100%;min-height:30px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:4px 2px;border:0;border-radius:0;background:transparent;overflow:hidden;line-height:1.15;text-align:center;}
    .cs-calendar-event--activity{background:transparent;}
    .cs-calendar-event strong{display:block;color:#12385e;font-size:10pt;font-weight:800;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .cs-calendar-event--activity strong{color:#735307;}
    .cs-calendar-event span{display:block;color:#50667b;font-size:8pt;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .cs-calendar-event small{display:block;color:#526274;font-size:8pt;text-align:center;white-space:nowrap;}
    .cs-calendar-empty{padding:18px;text-align:center;color:#526274;font-style:italic;border:1px solid var(--calendar-line);}
    @media print{
        @page{size:A4 landscape;margin:10mm;}
        html,body{background:#fff;}
        .cs-calendar-page{max-width:none;}
        .cs-calendar-sheet{width:100%;min-height:0;padding:0;}
        .cs-calendar-section{break-inside:avoid;page-break-inside:avoid;}
    }`;
}

function csCalendarTimePoints(scheds) {
    const valid = scheds.filter(s => s.start_time && s.end_time);
    if (!valid.length) return [];
    const first = Math.min(...valid.map(s => csTimeToMinutes(s.start_time)));
    const last  = Math.max(...valid.map(s => csTimeToMinutes(s.end_time)));
    const start = Math.max(6 * 60, Math.floor(first / 60) * 60);
    const end   = Math.min(22 * 60, Math.ceil(last / 60) * 60);
    const points = new Set();
    for (let mins = start; mins <= end; mins += 60) points.add(mins);
    valid.forEach(s => {
        const startMins = csTimeToMinutes(s.start_time);
        const endMins = csTimeToMinutes(s.end_time);
        if (startMins >= start && startMins <= end) points.add(startMins);
        if (endMins >= start && endMins <= end) points.add(endMins);
    });
    return [...points].sort((a, b) => a - b);
}

function csCalendarEntryLabel(schedule, role) {
    const isActivity = schedule.schedule_type === 'fixed_activity';
    const title = isActivity
        ? (schedule.activity_name || 'Manual entry')
        : csDisplaySubjectName(schedule.subject_name, schedule.subject_code, schedule.area_code);
    const secondary = role === 'learner' && !isActivity && schedule.teacher_name
        ? schedule.teacher_name
        : '';
    return { title, secondary, isActivity };
}

function csBuildCalendarGridHtml(scheds, role) {
    const rows = Array.isArray(scheds) ? [...scheds] : [];
    if (!rows.length) return '<div class="cs-calendar-empty">No schedule entries.</div>';

    const timePoints = csCalendarTimePoints(rows);
    if (timePoints.length < 2) return '<div class="cs-calendar-empty">No schedule entries.</div>';

    const slotStart = Object.fromEntries(DAYS.map(day => [day, {}]));
    const slotSpan = Object.fromEntries(DAYS.map(day => [day, {}]));
    DAYS.forEach(day => {
        const dayRows = rows
            .filter(s => s.day_of_week === day)
            .sort((a, b) => csTimeToMinutes(a.start_time) - csTimeToMinutes(b.start_time));
        dayRows.forEach(schedule => {
            const startRow = timePoints.indexOf(csTimeToMinutes(schedule.start_time));
            const endRow = timePoints.indexOf(csTimeToMinutes(schedule.end_time));
            if (startRow < 0 || endRow <= startRow) return;
            const span = endRow - startRow;
            const occupied = Array.from({ length: span }, (_, offset) => slotSpan[day][startRow + offset]).some(Boolean);
            if (occupied) return;
            slotStart[day][startRow] = { schedule, rowspan: span };
            for (let index = startRow; index < endRow; index += 1) slotSpan[day][index] = true;
        });
    });

    const formatPoint = mins => csFormatTime(`${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`);
    const head = `<thead><tr><th>Time</th>${DAYS.map(day => `<th>${DAY_LABELS[day].slice(0, 3)}</th>`).join('')}</tr></thead>`;
    const body = timePoints.slice(0, -1).map((mins, rowIndex) => {
        const cells = DAYS.map(day => {
            if (slotSpan[day][rowIndex] && !slotStart[day][rowIndex]) return '';
            const slot = slotStart[day][rowIndex];
            if (!slot) return '<td class="calendar-empty"></td>';
            const { schedule, rowspan } = slot;
            const { title, secondary, isActivity } = csCalendarEntryLabel(schedule, role);
            const range = `${csFormatTime(schedule.start_time)} – ${csFormatTime(schedule.end_time)}`;
            return `<td rowspan="${rowspan}"><div class="cs-calendar-event${isActivity ? ' cs-calendar-event--activity' : ''}">
                <strong>${escHtml(title)}</strong>
                ${secondary ? `<span>${escHtml(secondary)}</span>` : ''}
                <small>${escHtml(range)}</small>
            </div></td>`;
        }).join('');
        return `<tr><td class="calendar-time">${formatPoint(mins)}</td>${cells}</tr>`;
    }).join('');

    return `<table class="cs-calendar-grid">${head}<tbody>${body}</tbody></table>`;
}

async function csGenerateCalendarDocument(type) {
    const m = csMeta();
    const logos = await csResolveLogos();
    const title = 'Class Schedule';
    const role = type === 'learner' ? 'learner' : 'teacher';
    const sectionDisplay = String(m.sectionDisplay || '');
    const logo = (src, alt) => `<img src="${src}" alt="${alt}">`;
    const sectionGroups = type === 'teacher'
        ? [...new Map(csState.schedules.map(s => {
            const grade = String(s.grade_name || '').trim();
            const section = String(s.section_name || '').trim();
            return [String(s.section_id || `${grade}||${section}`), { label: [grade, section].filter(Boolean).join(' — '), rows: [] }];
        })).entries()]
        : [];

    if (type === 'teacher') {
        sectionGroups.forEach(([key, group]) => {
            group.rows = csState.schedules.filter(s => String(s.section_id || `${s.grade_name || ''}||${s.section_name || ''}`) === key);
        });
    }

    const calendars = type === 'teacher'
        ? sectionGroups.map(([, group]) => `<section class="cs-calendar-section">
            ${csBuildCalendarGridHtml(group.rows, role)}
        </section>`).join('')
        : `<section class="cs-calendar-section">${csBuildCalendarGridHtml(csState.schedules, role)}</section>`;

    const body = `<div class="cs-calendar-sheet cs-print-sheet">
        <header class="cs-calendar-letterhead">
            ${logo(logos.left, 'DepEd Seal')}
            <div class="cs-calendar-headtext">
                <div class="cs-calendar-republic">Republic of the Philippines</div>
                <div class="cs-calendar-dept">Department of Education</div>
                ${m.schoolName ? `<div class="cs-calendar-school">${escHtml(m.schoolName)}</div>` : ''}
                ${m.division ? `<div class="cs-calendar-location">${escHtml(m.division)}</div>` : ''}
            </div>
            ${logo(logos.right, 'School Logo')}
        </header>
        <h1 class="cs-calendar-title">${title}</h1>
        <div class="cs-calendar-context">
            ${sectionDisplay ? `<strong>${escHtml(sectionDisplay)}</strong>` : ''}
            ${m.sy ? `<span>School Year ${escHtml(m.sy)}</span>` : ''}
        </div>
        ${calendars}
    </div>`;
    return { body: `<main class="cs-calendar-page">${body}</main>`, m };
}

/* ── Print: shared preview modal → browser print dialog ── */
function csOpenSchedulePrintPreview() {
    const type = csState.role === 'learner' ? 'learner' : 'teacher';
    csPrintExport(type);
}

function csOpenPrintPreviewModal() {
    const modal = document.getElementById('csPrintModal');
    if (!modal) return;
    modal.classList.add('show');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    const frame = document.getElementById('csPrintFrame');
    window.refitPrintPreviewFrame?.(frame, frame?.dataset?.printPreviewItems);
}

function csClosePrintPreview() {
    const modal = document.getElementById('csPrintModal');
    const frame = document.getElementById('csPrintFrame');
    modal?.classList.remove('active', 'show');
    if (modal) modal.style.display = '';
    modal?.setAttribute('aria-hidden', 'true');
    if (frame) {
        frame.onload = null;
        frame.srcdoc = '';
    }
}

function csPrintPreview() {
    const frame = document.getElementById('csPrintFrame');
    if (!frame?.contentWindow) return;
    frame.contentWindow.focus();
    frame.contentWindow.print();
}

async function csPrintExport(type) {
    if (!csState.schedules.length) { csToast('No schedule data to print.', 'warning'); return; }
    const frame = document.getElementById('csPrintFrame');
    if (!frame) { csToast('Schedule preview is unavailable.', 'error'); return; }

    try {
        const { body, m } = await csGenerateCalendarDocument(type);
        const previewStyle = `${csCalendarDocCss()}
            @media screen {
                html, body { background:#e3e8ee; }
                body { padding:18px; }
                .cs-calendar-page { width:100%; max-width:1123px; margin:0 auto; }
                .cs-calendar-sheet { width:1123px; min-height:794px; margin:0 auto 18px; box-shadow:0 2px 14px rgba(23,39,58,.22); }
            }
            @media print {
                html, body { background:#fff; }
                body { padding:0; }
                .cs-calendar-page { width:100%; max-width:none; }
                .cs-calendar-sheet { width:100%; min-height:0; margin:0; box-shadow:none; }
            }`;
        frame.srcdoc = `<!doctype html><html lang="en"><head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.5, maximum-scale=5, user-scalable=yes">
            <title>${escHtml(m.schoolName || 'Schedule')} ${escHtml(m.sectionDisplay || '')}</title>
            <style>${previewStyle}</style>
        </head><body>${body}</body></html>`;
        csOpenPrintPreviewModal();
    } catch (err) {
        csToast('Schedule preview failed: ' + (err?.message || 'unknown error'), 'error');
    }
}

/* ── Export: all three types → browser PDF via html2canvas + jsPDF ── */
async function csExportClassProgram() {
    if (!csState.schedules.length) { csToast('No schedule data to export.', 'warning'); return; }
    document.getElementById('exportMenu')?.classList.remove('open');
    const btn = document.getElementById('exportToggle');
    const { body, m } = await csGenerateDocument('program');
    await csSavePdf(body, `ClassProgram_${csSlug(m.section)}_${csSlug(m.sy)}.pdf`, btn);
}

async function csExportTeacherSchedule() {
    if (!csState.schedules.length) { csToast('No schedule data to export.', 'warning'); return; }
    document.getElementById('exportMenu')?.classList.remove('open');
    const btn = document.getElementById('exportToggle');
    const { body, m } = await csGenerateDocument('teacher');
    await csSavePdf(body, `TeacherSchedule_${csSlug(m.section)}_${csSlug(m.sy)}.pdf`, btn);
}

async function csExportLearnerSchedule() {
    if (!csState.schedules.length) { csToast('No schedule data to export.', 'warning'); return; }
    document.getElementById('exportMenu')?.classList.remove('open');
    const btn = document.getElementById('exportToggle');
    const { body, m } = await csGenerateDocument('learner');
    await csSavePdf(body, `LearnerSchedule_${csSlug(m.section)}_${csSlug(m.sy)}.pdf`, btn);
}

/* ════════════════════════════════════
   DEPED OFFICIAL PREVIEW SHEET
   Mirrors the official DepEd class program format — shown below the
   builder table, formatted for print. Uses only DB-saved schedules.
   ════════════════════════════════════ */
function csRenderPreviewSheet(scheds) {
    const section = csState.selectedSection?.section_name || '';
    const grade   = csState.selectedGL?.grade_name        || (scheds[0]?.grade_name || '');
    const sy      = csState.selectedSY?.year_label        || '';

    // Build per-day tables
    const daysWithData = DAYS.filter(d => scheds.some(s => s.day_of_week === d));

    if (!daysWithData.length) return ''; // nothing to preview yet

    const dayTablesHtml = daysWithData.map(day => {
        const rows = scheds.filter(s => s.day_of_week === day)
                           .sort((a, b) => a.start_time.localeCompare(b.start_time));
        const totalMins = rows.reduce((sum, s) => sum + csDurationMins(s.start_time, s.end_time), 0);

        const tBody = rows.map((s, i) => {
            const mins = csDurationMins(s.start_time, s.end_time);
            return `<tr>
                <td class="center mono">${i + 1}</td>
                <td class="center mono">${csFormatTime(s.start_time)}</td>
                <td class="center mono">${csFormatTime(s.end_time)}</td>
                <td class="center">${mins}</td>
                <td>${escHtml(csDisplaySubjectName(s.subject_name, s.subject_code, s.area_code))}</td>
                <td>${escHtml(s.teacher_name)}</td>
            </tr>`;
        }).join('');

        return `<div style="margin-bottom:28px;">
            <div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;color:#1C2A3D;border-bottom:2px solid #000;padding-bottom:4px;">
                ${DAY_LABELS[day]}
            </div>
            <table class="cs-preview-table">
                <thead>
                    <tr>
                        <th class="center" style="width:32px;">No.</th>
                        <th class="center" style="width:80px;">Time In</th>
                        <th class="center" style="width:80px;">Time Out</th>
                        <th class="center" style="width:52px;">Min</th>
                        <th>Learning Area / Subject</th>
                        <th style="width:160px;">Teacher</th>
                    </tr>
                </thead>
                <tbody>
                    ${tBody}
                    <tr class="total-row">
                        <td colspan="3" class="center" style="font-weight:700;">TOTAL</td>
                        <td class="center" style="font-weight:700;">${totalMins}</td>
                        <td colspan="2"></td>
                    </tr>
                </tbody>
            </table>
        </div>`;
    }).join('');

    return `<div class="cs-preview-wrap" id="csPreviewWrap">
        <div class="cs-preview-sheet">
            <div class="cs-preview-header">
                <div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#5A6B82;font-family:monospace;">Republic of the Philippines · Department of Education</div>
                <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:700;margin:6px 0 2px;text-transform:uppercase;letter-spacing:.5px;">Class Program</h2>
                <div style="font-size:13px;font-weight:600;margin-bottom:2px;">${escHtml(grade)} — ${escHtml(section)}</div>
                <div style="font-size:12px;color:#3A4A60;">School Year ${escHtml(sy)}</div>
            </div>
            <div style="margin:18px 0 20px;">
                ${dayTablesHtml}
            </div>
            <div class="cs-preview-signatures">
                <div class="cs-sig-block">
                    <div style="font-size:11px;color:#555;margin-bottom:36px;">Prepared by:</div>
                    <div class="cs-sig-line">Class Adviser</div>
                </div>
                <div class="cs-sig-block">
                    <div style="font-size:11px;color:#555;margin-bottom:36px;">Noted by:</div>
                    <div class="cs-sig-line">School Principal</div>
                </div>
            </div>
        </div>
    </div>`;
}

/* ════════════════════════════════════
   MODAL UTILITIES
   ════════════════════════════════════ */
function csOpenModal(id) {
    const m = document.getElementById(id);
    if (m) { m.classList.add('active'); document.body.style.overflow = 'hidden'; }
}
function csCloseModal() {
    const m = document.getElementById('scheduleModal');
    if (m) m.classList.remove('active');
    document.body.style.overflow = '';
}
function csCloseViewModal() {
    const m = document.getElementById('scheduleViewModal');
    if (m) m.classList.remove('active');
    document.body.style.overflow = '';
}

document.addEventListener('click', e => {
    if (e.target?.id === 'scheduleViewModal') csCloseViewModal();
    if (e.target?.id === 'csPrintModal') csClosePrintPreview();
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        csCloseViewModal();
        csClosePrintPreview();
    }
});

document.getElementById('csClosePrintPreview')?.addEventListener('click', csClosePrintPreview);
document.getElementById('csClosePrintPreviewFooter')?.addEventListener('click', csClosePrintPreview);
document.getElementById('csPrintPreviewBtn')?.addEventListener('click', csPrintPreview);

function csClearErrors() {
    document.querySelectorAll('#sideForm .cs-err').forEach(el => el.textContent = '');
    document.querySelectorAll('#sideForm .form-control').forEach(el => {
        el.classList.remove('error');
        el.setAttribute('aria-invalid', 'false');
    });
    document.querySelectorAll('#csDayBoxes .cs-day-box').forEach(el => el.classList.remove('error'));
    const dayBoxes = document.getElementById('csDayBoxes');
    dayBoxes?.classList.remove('error');
    dayBoxes?.setAttribute('aria-invalid', 'false');
}
function csSetErr(id, msg) {
    const el = document.getElementById(id);
    if (el) el.textContent = msg;
    // Also mark the matching control
    const ctrl = document.getElementById(id.replace('err', 'cs'));
    if (ctrl) {
        ctrl.classList.add('error');
        ctrl.setAttribute('aria-invalid', 'true');
    }
    if (id === 'errDayOfWeek') {
        const dayBoxes = document.getElementById('csDayBoxes');
        dayBoxes?.classList.add('error');
        dayBoxes?.setAttribute('aria-invalid', 'true');
    }
}

/* ════════════════════════════════════
   STATE DISPLAY HELPERS
   ════════════════════════════════════ */
function csShowEmptyState() {
    const gridWrap = document.getElementById('gridWrap');
    if (gridWrap) {
        const isTeacher = csState.role === 'teacher';
        const isLearner = csState.role === 'learner';
        const message = isTeacher
            ? '<strong>Loading your schedule...</strong><br>Please wait while we load your assigned classes.'
            : isLearner
            ? '<strong>Loading your section schedule...</strong><br>Please wait while we check the current school year.'
            : '<strong>Select a School Year and Section</strong><br>Use the side form to choose a section and view its weekly schedule.';
            
        const icon = isTeacher
            ? '<i class="fas fa-spinner fa-spin" style="font-size:1.6rem;display:block;margin-bottom:0.5rem;"></i>'
            : '<video class="mp4-surface-blend context-empty-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="../assets/icons/calendar.mp4" type="video/mp4"></video>';
        
        gridWrap.innerHTML = `
            <div class="cs-grid-empty">
                ${icon}
                ${message}
            </div>`;
    }
}

function csShowLoading() {
    const gridWrap = document.getElementById('gridWrap');
    if (gridWrap) {
        gridWrap.innerHTML = `
            <div class="cs-grid-empty">
                <i class="fas fa-spinner fa-spin" style="font-size:1.6rem;display:block;margin-bottom:0.5rem;"></i>
                <strong>Loading schedule...</strong>
            </div>`;
    }
}

function csShowInfo(msg) {
    const gridWrap = document.getElementById('gridWrap');
    if (gridWrap) {
        gridWrap.innerHTML = `
            <div class="cs-grid-empty">
                <i class="fas fa-circle-info" style="font-size:1.6rem;display:block;margin-bottom:0.5rem;"></i>
                <strong>${escHtml(msg)}</strong>
            </div>`;
    }
}

/* ════════════════════════════════════
   TIME HELPERS
   ════════════════════════════════════ */
function csDurationMins(start, end) {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    return (eh * 60 + em) - (sh * 60 + sm);
}

function csFormatTime(t) {
    const [h, m] = t.split(':').map(Number);
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12  = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/* ════════════════════════════════════
   TOAST  (gov-toast style)
   ════════════════════════════════════ */
function escHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function csToast(message, type = 'success') {
    const ensureStyles = () => {
        if (document.getElementById('govToastStyles')) return;
        const s = document.createElement('style');
        s.id = 'govToastStyles';
        s.textContent = `
            .gov-toast{position:fixed;bottom:80px;right:20px;background:var(--gray-50);border:0;box-shadow:var(--shadow-sm);border-radius:6px;padding:.9rem 1rem;z-index:10001;min-width:300px;max-width:400px;opacity:0;transform:translateX(30px);transition:opacity .25s,transform .25s}
            .gov-toast.show{opacity:1;transform:translateX(0)}
            .gov-toast__content{display:flex;align-items:flex-start;gap:.7rem}
            .gov-toast__icon{font-size:1.05rem;margin-top:.05rem}
            .gov-toast__text{flex:1;min-width:0}
            .gov-toast__title{font-size:.75rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--gray-600);line-height:1.15}
            .gov-toast__message{font-size:.88rem;color:var(--gray-900);line-height:1.35;word-break:break-word}
            .gov-toast__dismiss{background:transparent;border:none;color:var(--gray-400);font-size:1rem;cursor:pointer;line-height:1}
            .gov-toast--success{border:0}
            .gov-toast--success .gov-toast__icon{color:var(--gray-500)}
            .gov-toast--error{border:0}
            .gov-toast--error .gov-toast__icon{color:var(--color-danger,#c0392b)}
            .gov-toast--warning{border:0}
            .gov-toast--warning .gov-toast__icon{color:#d97706}
            .gov-toast--info{border:0}
            .gov-toast--info .gov-toast__icon{color:var(--gray-500)}`;
        document.head.appendChild(s);
    };
    ensureStyles();
    document.querySelectorAll('.gov-toast').forEach(el => el.remove());

    const valid = ['success','error','warning','info'];
    const t = valid.includes(type) ? type : 'info';
    const title   = t === 'success' ? 'Done' : t === 'error' ? 'Error' : t === 'warning' ? 'Notice' : 'Info';
    const icon    = t === 'success' ? 'fa-circle-check' : t === 'error' ? 'fa-triangle-exclamation' : t === 'warning' ? 'fa-circle-exclamation' : 'fa-circle-info';

    const el = document.createElement('div');
    el.className = `gov-toast gov-toast--${t}`;
    el.innerHTML = `<div class="gov-toast__content">
        <i class="fas ${icon} gov-toast__icon"></i>
        <div class="gov-toast__text">
            <div class="gov-toast__title">${title}</div>
            <div class="gov-toast__message">${escHtml(message)}</div>
        </div>
        <button class="gov-toast__dismiss" aria-label="Dismiss">&times;</button>
    </div>`;

    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));

    const ms = (t === 'error' || t === 'warning') ? 8000 : 4000;
    let timer = setTimeout(dismiss, ms);

    function dismiss() {
        clearTimeout(timer); timer = null;
        el.classList.remove('show');
        setTimeout(() => el.remove(), 260);
    }
    el.querySelector('.gov-toast__dismiss').addEventListener('click', () => dismiss());
    el.addEventListener('mouseenter', () => { clearTimeout(timer); timer = null; });
    el.addEventListener('mouseleave', () => { if (!timer) timer = setTimeout(dismiss, ms); });
}

/* ════════════════════════════════════
   WINDOW BINDINGS (for inline handlers)
   ════════════════════════════════════ */
window.csOnSYChange       = csOnSYChange;
window.csOnGLChange       = csOnGLChange;
window.csOnSectionChange  = csOnSectionChange;
window.csLoadSchedules    = csLoadSchedules;
window.csResetFilters     = csResetFilters;
window.csResetForm        = csResetForm;
window.csSelectDay        = csSelectDay;
window.csEditFromGrid     = csEditFromGrid;
window.csSaveSchedule     = csSaveSchedule;
window.csDeleteSchedule   = csDeleteSchedule;
window.csViewSchedule     = csViewSchedule;
window.csCloseModal             = csCloseModal;
window.csCloseViewModal         = csCloseViewModal;
