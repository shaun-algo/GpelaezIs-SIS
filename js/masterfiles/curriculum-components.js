/**
 * Curriculum Components Editor
 * Sidebar-tabbed, card-based curriculum configuration interface.
 * Includes modal curriculum CRUD, subject assignments, row actions,
 * subject passing marks, and simplified payloads.
 */
(function () {
    'use strict';

    /* ═══ Helpers ═══ */

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const api = {
        curricula: () => `${window.API_BASE}/curricula/curricula.php`,
        gradeLevels: () => `${window.API_BASE}/grade_levels/grade_levels.php`,
        subjects: () => `${window.API_BASE}/subjects/subjects.php`,
        subjectCategories: () => `${window.API_BASE}/subject_categories/subject_categories.php`
    };

    const MAPEH_PARENT_NAME = 'Music, Arts, Physical Education and Health (MAPEH)';
    const DEFAULT_PASSING_MARK = 75;
    const MAPEH_FIXED_SUBJECTS = [
        MAPEH_PARENT_NAME,
        'Music and Arts',
        'Physical Education and Health'
    ];

    function notify(message, type = 'success') {
        if (typeof window.showNotification === 'function') {
            window.showNotification(message, type === 'error' ? 'error' : 'success');
            return;
        }
        if (window.Swal) {
            Swal.fire({
                toast: true,
                position: 'bottom-end',
                icon: type === 'error' ? 'error' : 'success',
                title: message,
                showConfirmButton: false,
                timer: 2500,
                timerProgressBar: true
            });
        } else if (type === 'error') {
            alert(message);
        }
    }

    function setStatus(text) {
        const el = $('statusText');
        if (el) el.textContent = text || '';
    }

    function renderEmptyState(mode = 'default') {
        const el = $('cc-empty-state');
        if (!el) return;

        el.classList.toggle('cc-empty-state--loading', mode === 'loading');
        el.classList.toggle('cc-empty-state--error', mode === 'error');

        if (mode === 'loading') {
            el.innerHTML = `
                <div class="cc-empty-icon" aria-hidden="true"><i class="fas fa-circle-notch fa-spin"></i></div>
                <h3>Loading curriculum data</h3>
                <p>Preparing curricula, grade levels, and subjects.</p>
            `;
            return;
        }

        if (mode === 'error') {
            el.innerHTML = `
                <div class="cc-empty-icon" aria-hidden="true"><i class="fas fa-triangle-exclamation"></i></div>
                <h3>Curriculum data could not be loaded</h3>
                <p>Check the connection, then try loading the reference data again.</p>
                <button type="button" class="btn btn-outline btn-sm" id="cc-retry-load-btn">
                    <i class="fas fa-rotate-right"></i> Try again
                </button>
            `;
            return;
        }

        el.innerHTML = `
            <div class="cc-empty-icon" aria-hidden="true"><video class="mp4-surface-blend empty-state-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="../../assets/icons/search.mp4" type="video/mp4"></video></div>
            <h3>Select or Create a Curriculum</h3>
            <p>Choose a curriculum from the Curriculum card to begin.</p>
            <div class="cc-empty-actions">
                <button type="button" class="btn btn-primary btn-sm" data-cc-curriculum-action="add-curriculum">
                    <i class="fas fa-plus"></i> Create curriculum
                </button>
                <button type="button" class="btn btn-outline btn-sm" data-cc-open-archive>
                    <i class="fas fa-box-archive"></i> View archive
                </button>
            </div>
        `;
    }

    function visibleCurriculumSubjects() {
        return state.refs.subjects || [];
    }

    function getSubjectCategoryById(categoryId) {
        const numericId = Number(categoryId || 0);
        return state.refs.subjectCategories.find(category => Number(category.subject_category_id) === numericId) || null;
    }

    function getSubjectCategoryByCode(categoryCode) {
        const code = String(categoryCode || '').trim().toUpperCase();
        return state.refs.subjectCategories.find(category => String(category.category_code || '').toUpperCase() === code) || null;
    }

    function getSubjectCategoryForSubject(subject) {
        const fromId = getSubjectCategoryById(subject?.subject_category_id);
        if (fromId) return fromId;

        const fromName = String(subject?.category_name || '').trim();
        if (fromName) {
            const match = state.refs.subjectCategories.find(category => String(category.category_name || '').trim().toLowerCase() === fromName.toLowerCase());
            if (match) return match;
        }

        const normalized = normalizeSubjectName(subject?.subject_name);
        const inferredCode = /filipino|english|mother tongue|reading|language|mathematics|(^|[^a-z])math([^a-z]|$)|science/.test(normalized)
            ? 'FOUNDATIONAL_CORE'
            : (/gmrc|good manners|right conduct|values education|edukasyon sa pagpapakatao|makabansa/.test(normalized)
                ? 'VALUES_CULTURAL'
                : (/araling panlipunan|social studies|(^|[^a-z])ap([^a-z]|$)|epp|tle|technology|livelihood|mapeh|music|arts|physical education|health/.test(normalized)
                    ? 'SPECIALIZED_MULTIDISCIPLINARY'
                    : ''));
        return getSubjectCategoryByCode(inferredCode) || {
            subject_category_id: 0,
            category_code: 'UNCATEGORIZED',
            category_name: 'Uncategorized',
            sort_order: 9999
        };
    }

    function subjectCategorySortValue(category) {
        const value = Number(category?.sort_order);
        return Number.isFinite(value) && value >= 0 ? value : 9999;
    }

    function subjectCategoryDivider(category) {
        return `<div class="cc-subject-checklist-section-label cc-subject-category-divider" data-subject-category="${esc(category?.category_code || '')}">
            <span>${esc(category?.category_name || 'Uncategorized')}</span>
        </div>`;
    }

    function getSubjectCategoryForRow(row) {
        const subject = state.refs.subjects.find(item => Number(item.subject_id) === Number(row?.subject_id));
        return getSubjectCategoryForSubject(subject || {
            subject_name: row?.subject_name,
            subject_category_id: row?.subject_category_id,
            category_name: row?.category_name
        });
    }

    function normalizeSubjectName(name) {
        return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
    }

    function renderSubjectCategoryRowSections(rows, renderRow) {
        const groups = new Map();
        rows.forEach((row, index) => {
            const category = getSubjectCategoryForRow(row);
            const key = String(category?.subject_category_id || category?.category_code || 'uncategorized');
            if (!groups.has(key)) {
                groups.set(key, { category, rows: [] });
            }
            groups.get(key).rows.push({ row, index });
        });

        return [...groups.values()]
            .sort((a, b) => subjectCategorySortValue(a.category) - subjectCategorySortValue(b.category))
            .map(group => subjectCategoryDivider(group.category) + group.rows.map(({ row, index }) => renderRow(row, index)).join(''))
            .join('');
    }

    function isMapehRelatedSubjectName(name) {
        const normalized = normalizeSubjectName(name);
        if (!normalized) return false;
        return normalized.includes('mapeh')
            || /\bmusic\s*(and|&)\s*arts?\b/.test(normalized)
            || /\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/.test(normalized)
            || /\b(music|arts|physical education|health|pe|p\.e\.)\b/.test(normalized);
    }

    function getMapehSubjectKindByName(name) {
        const normalized = normalizeSubjectName(name);
        if (!normalized) return null;
        if (normalized.includes('mapeh') && !normalized.includes('component')) return 'parent';
        if (/\bmusic\s*(and|&)\s*arts?\b/.test(normalized)) return 'grouped';
        if (/\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/.test(normalized)) return 'grouped';
        if (/\b(music|arts|physical education|health|pe|p\.e\.)\b/.test(normalized)) return 'component';
        if (normalized.includes('mapeh')) return 'component';
        return null;
    }

    function isMapehRelatedSubjectId(subjectId) {
        const subject = state.refs.subjects.find(sub => Number(sub.subject_id) === Number(subjectId));
        return isMapehRelatedSubjectName(subject?.subject_name);
    }

    function getMapehSubjectKindById(subjectId) {
        const subject = state.refs.subjects.find(sub => Number(sub.subject_id) === Number(subjectId));
        return getMapehSubjectKindByName(subject?.subject_name);
    }

    function getGradeMapehState(gradeLevelId, extraSubjectIds = []) {
        const kinds = new Set();
        const rows = state.subjectRows.filter(row => Number(row.grade_level_id) === Number(gradeLevelId));
        rows.forEach(row => {
            const kind = getMapehSubjectKindById(row.subject_id);
            if (kind) kinds.add(kind);
        });
        extraSubjectIds.forEach(subjectId => {
            const kind = getMapehSubjectKindById(subjectId);
            if (kind) kinds.add(kind);
        });
        return {
            hasAny: kinds.size > 0,
            kinds
        };
    }

    function getMapehConflictMessage(gradeLevelId) {
        return `${gradeDisplayName(gradeLevelId)} already has a MAPEH setup. Remove the existing MAPEH parent and components before adding it again.`;
    }

    function validateMapehSelectionForGrade(gradeLevelId, subjectIds) {
        const selectedMapehIds = subjectIds.filter(isMapehRelatedSubjectId);
        if (!selectedMapehIds.length) return true;

        const existingState = getGradeMapehState(gradeLevelId);
        if (existingState.hasAny) {
            notify(getMapehConflictMessage(gradeLevelId), 'error');
            return false;
        }

        return true;
    }

    async function getOrCreateSubjectMaster(subjectName) {
        const wanted = normalizeSubjectName(subjectName);
        const existing = state.refs.subjects.find(subject => normalizeSubjectName(subject.subject_name) === wanted);
        if (existing?.subject_id) return Number(existing.subject_id);

        const res = await axios.post(`${api.subjects()}?operation=createSubject`, {
            subject_name: subjectName,
            description: ''
        });
        if (res.data?.success === false) {
            throw new Error(res.data?.message || `Failed to create ${subjectName}`);
        }
        await loadRefs();
        const createdId = Number(res.data?.subject_id || res.data?.data?.subject_id || 0);
        if (createdId) return createdId;

        const created = state.refs.subjects.find(subject => normalizeSubjectName(subject.subject_name) === wanted);
        if (created?.subject_id) return Number(created.subject_id);
        throw new Error(`Could not find ${subjectName} after creating it`);
    }

    function confirmDelete(thing) {
        return window.mfConfirm({
            title: `Archive ${thing}?`,
            message: `This ${thing} will be hidden from the active list and kept in View archive. You can restore it later.`,
            confirmLabel: 'Archive',
            intent: 'archive'
        });
    }

    /* ═══ State ═══ */

    const state = {
        curriculumId: null,
        curriculumData: null,
        refs: { curricula: [], gradeLevels: [], subjects: [], subjectCategories: [] },
        subjectRows: [],
        subjectBaselineRows: [],
        subjectDraftDirty: false,
        subjectDraftDirtyKeys: new Set(),
        selectedGradeFilter: 'all',
        activeTab: 'overview',
        modalTargetGradeId: '',
        modalSubjectSearch: '',
        modalSelectedSubjectIds: new Set(),
        modalSelectionMode: false,
        modalSubjectPassingMarks: new Map(),
        modalSubjectMeetingMinutes: new Map(),
        modalMapehPreset: null,
        modalMapehSubjectIds: new Set(),
        modalMapehPassingMarks: new Map(),
        modalEditGradeLevelId: null,
        modalEditRows: [],
        modalEditBaselineRows: [],
        modalEditSelectedSubjectIds: new Set(),
        modalEditSelectionMode: false,
        modalEditDirty: false,
        modalEditDirtyKeys: new Set(),
        modalEditDraggedIndex: null,
        modalEditDropIndex: null,
        modalEditDragClientY: 0,
        modalEditAutoScrollFrame: null,
        modalEditAutoScrollVelocity: 0,
        modalStack: [],
        activeModalId: null,
        modalReturnFocus: null,
        curriculumReturnFocus: null
    };

    let curriculumArchiveMenuObserver = null;
    let activateCurriculumTab = () => {};

    /* ═══ Tab switching ═══ */

    function wireTabs() {
        const tabs = Array.from(document.querySelectorAll('.cc-tab[data-tab]'));
        const updateWizardState = (activeTab) => {
            state.activeTab = activeTab?.dataset.tab || 'overview';
            const activeIndex = tabs.indexOf(activeTab);
            tabs.forEach((tab, index) => {
                const isActive = tab === activeTab;
                tab.classList.toggle('active', isActive);
                tab.classList.toggle('done', index < activeIndex);
                if (isActive) tab.setAttribute('aria-current', 'step');
                else tab.removeAttribute('aria-current');
            });

            document.querySelectorAll('.cc-panel').forEach(panel => panel.classList.remove('active'));
            const panel = $(`cc-panel-${activeTab?.dataset.tab}`);
            if (panel) panel.classList.add('active');
        };

        activateCurriculumTab = (tabName = 'overview') => {
            const tab = tabs.find(candidate => candidate.dataset.tab === tabName) || tabs[0];
            if (tab) updateWizardState(tab);
            syncCurriculumActionsMenu(tab?.dataset.tab || 'overview');
        };

        tabs.forEach(tab => {
            tab.addEventListener('click', async (event) => {
                const nextTab = tab.dataset.tab || 'overview';
                if (state.activeTab === 'subjects' && nextTab !== 'subjects') {
                    if (!await confirmDiscardSubjectWork()) {
                        event.preventDefault();
                        return;
                    }
                }
                updateWizardState(tab);
                syncCurriculumActionsMenu(tab.dataset.tab);
            });
        });

        updateWizardState(tabs.find(tab => tab.classList.contains('active')) || tabs[0]);
    }

    /* ═══ Data loading ═══ */

    async function loadRefs() {
        const initialLoad = !state.refs.curricula.length && !state.refs.gradeLevels.length && !state.refs.subjects.length;
        if (initialLoad) {
            renderEmptyState('loading');
            $('cc-editor').style.display = 'none';
        }
        setStatus('Loading curriculum data...');

        try {
            const [currRes, glRes, subjRes, categoryRes] = await Promise.all([
                axios.get(api.curricula(), { params: { operation: 'getAllCurricula' } }),
                axios.get(api.gradeLevels(), { params: { operation: 'getAllGradeLevels' } }),
                axios.get(api.subjects(), { params: { operation: 'getAllSubjects' } }),
                axios.get(api.subjectCategories(), { params: { operation: 'getAllSubjectCategories', active_only: 1 } })
            ]);
            state.refs.curricula = Array.isArray(currRes.data) ? currRes.data : (currRes.data?.data || []);
            state.refs.gradeLevels = Array.isArray(glRes.data) ? glRes.data : (glRes.data?.data || []);
            state.refs.subjects = Array.isArray(subjRes.data) ? subjRes.data : (subjRes.data?.data || []);
            state.refs.subjectCategories = Array.isArray(categoryRes.data) ? categoryRes.data : (categoryRes.data?.data || []);
            const availableCurriculumIds = new Set(
                state.refs.curricula.map(item => Number(item?.curriculum_id)).filter(id => id > 0)
            );
            const retainedCurriculumId = Number(state.curriculumId || 0);
            const activeCurriculum = state.refs.curricula.find(item => Number(item?.is_active) === 1);
            state.curriculumId = availableCurriculumIds.has(retainedCurriculumId)
                ? retainedCurriculumId
                : (Number(activeCurriculum?.curriculum_id) > 0 ? Number(activeCurriculum.curriculum_id) : null);
            populateCurriculumSelect();
            syncCurriculumActionsMenu();
            renderEmptyState('default');
            $('cc-empty-state').style.display = 'none';
            $('cc-editor').style.display = '';
            renderAll();
            if (state.curriculumId) {
                await loadCurriculum(state.curriculumId, {
                    activeTab: getActiveCurriculumTab(),
                    gradeFilter: state.selectedGradeFilter || 'all'
                });
            }
            setStatus('');
        } catch (err) {
            if (initialLoad) renderEmptyState('error');
            setStatus('Curriculum data could not be loaded.');
            throw err;
        }
    }

    function populateCurriculumSelect() {
        const sel = $('curriculumSelect');
        if (!sel) return;

        const seenIds = new Set();
        const curriculumOptions = [];
        state.refs.curricula.forEach((curriculum) => {
            const curriculumId = Number(curriculum?.curriculum_id);
            if (!Number.isInteger(curriculumId) || curriculumId <= 0 || seenIds.has(curriculumId)) return;
            seenIds.add(curriculumId);

            const code = String(curriculum?.curriculum_code ?? '').replace(/\s+/g, ' ').trim();
            const name = String(curriculum?.curriculum_name ?? '').replace(/\s+/g, ' ').trim();
            curriculumOptions.push({ curriculumId, code, name });
        });

        const fragment = document.createDocumentFragment();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Choose a curriculum';
        placeholder.disabled = curriculumOptions.length > 0;
        placeholder.hidden = curriculumOptions.length > 0;
        fragment.appendChild(placeholder);

        curriculumOptions.forEach(({ curriculumId, code, name }) => {
            const option = document.createElement('option');
            option.value = String(curriculumId);
            option.textContent = [code, name].filter(Boolean).join(' · ') || `Curriculum ${curriculumId}`;
            option.dataset.curriculumCode = code;
            option.dataset.curriculumName = name;
            fragment.appendChild(option);
        });

        sel.replaceChildren(fragment);
        syncCurriculumSelectValue(state.curriculumId);
    }

    function syncCurriculumSelectValue(value) {
        const sel = $('curriculumSelect');
        if (!sel) return;

        const parsedValue = Number(value);
        const normalizedValue = Number.isInteger(parsedValue) && parsedValue > 0 ? String(parsedValue) : '';
        sel.value = normalizedValue;

        const choices = sel._choicesInstance;
        if (!choices) return;

        try {
            // The selector is populated asynchronously. Refresh first so the
            // custom control cannot retain a stale choice from the old list.
            choices.refresh();
            if (normalizedValue) choices.setChoiceByValue(normalizedValue);
        } catch (error) {
            // Native select state remains authoritative if the enhancement is
            // unavailable or is still being initialized.
            console.debug('Curriculum selector enhancement refresh skipped', error);
        }
    }

    function getCurriculumArchiveToggle(menu = $('mfArchiveOptionsMenu')) {
        return (menu ? document.querySelector(`[aria-controls="${menu.id}"]`) : null)
            || menu?.closest('.mf-archive-options')?.querySelector('.mf-options-icon-btn')
            || menu?.previousElementSibling
            || null;
    }

    function closeCurriculumActionsMenu() {
        const menu = $('mfArchiveOptionsMenu');
        const trigger = getCurriculumArchiveToggle(menu);
        menu?.classList.remove('is-open');
        trigger?.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('mf-mobile-sheet-open');
        const actions = trigger?.closest('.mf-archive-options');
        if (menu && actions && menu.parentElement !== actions) actions.append(menu);
    }

    function createCurriculumMenuAction(action, icon, label) {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.dataset.ccCurriculumAction = action;
        button.innerHTML = `<i class="fas ${icon}" aria-hidden="true"></i><span>${label}</span>`;
        return button;
    }

    function getActiveCurriculumTab() {
        return document.querySelector('.cc-tab.active')?.dataset.tab || 'overview';
    }

    function getCurriculumMenuAction(tabName = getActiveCurriculumTab()) {
        return {
            curriculum: { action: 'add-curriculum', icon: 'fa-plus', label: 'Add curriculum' },
            overview: { action: 'add-curriculum', icon: 'fa-plus', label: 'Add curriculum' },
            subjects: { action: 'add-subjects', icon: 'fa-book-medical', label: 'Add subjects' }
        }[tabName] || { action: 'add-curriculum', icon: 'fa-plus', label: 'Add curriculum' };
    }

    let stepMenuPositionFrame = null;

    function positionStepMenu(menuWrap) {
        const toggle = menuWrap?.querySelector('[data-cc-step-menu-toggle]');
        const menu = menuWrap?.__ccStepMenu || menuWrap?.querySelector('.cc-step-menu-panel');
        if (!toggle || !menu || menu.hidden || !menuWrap.classList.contains('is-open')) return;

        const toggleRect = toggle.getBoundingClientRect();
        const viewportGap = 8;
        const triggerGap = 8;

        menu.classList.add('is-anchored');
        menu.style.top = `${Math.round(toggleRect.bottom + triggerGap)}px`;
        menu.style.left = `${viewportGap}px`;
        menu.style.right = 'auto';

        const menuRect = menu.getBoundingClientRect();
        const maxLeft = Math.max(viewportGap, window.innerWidth - menuRect.width - viewportGap);
        const left = Math.min(
            Math.max(viewportGap, toggleRect.right - menuRect.width),
            maxLeft
        );
        let top = toggleRect.bottom + triggerGap;

        // Keep the preferred below-trigger placement, but avoid hiding the
        // action surface below the viewport on short mobile screens.
        if (top + menuRect.height > window.innerHeight - viewportGap
            && toggleRect.top - triggerGap - menuRect.height >= viewportGap) {
            top = toggleRect.top - triggerGap - menuRect.height;
        }

        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
    }

    function scheduleStepMenuPosition() {
        if (stepMenuPositionFrame !== null) return;
        stepMenuPositionFrame = window.requestAnimationFrame(() => {
            stepMenuPositionFrame = null;
            document.querySelectorAll('.cc-step-menu.is-open').forEach(positionStepMenu);
        });
    }

    function closeStepMenus() {
        document.querySelectorAll('.cc-step-menu.is-open').forEach(menuWrap => {
            const toggle = menuWrap.querySelector('[data-cc-step-menu-toggle]');
            const menu = menuWrap.__ccStepMenu || menuWrap.querySelector('.cc-step-menu-panel');
            menuWrap.classList.remove('is-open');
            toggle?.setAttribute('aria-expanded', 'false');
            if (menu) {
                menu.hidden = true;
                menu.classList.remove('is-open', 'is-anchored');
                menu.style.removeProperty('top');
                menu.style.removeProperty('left');
                menu.style.removeProperty('right');

                // Restore the panel to its original header/table position after
                // using a body-level overlay. The placeholder keeps dynamic
                // table headers from losing the menu during re-rendering.
                const placeholder = menu.__ccStepMenuPlaceholder;
                if (placeholder?.parentNode) {
                    placeholder.replaceWith(menu);
                } else if (menuWrap.isConnected && menu.parentElement !== menuWrap) {
                    menuWrap.appendChild(menu);
                }
                delete menu.__ccStepMenuPlaceholder;
                delete menuWrap.__ccStepMenu;
            }
        });
    }

    function syncCurriculumActionsMenu(tabName = getActiveCurriculumTab()) {
        const menu = $('mfArchiveOptionsMenu');
        if (!menu) return false;

        const menuAction = getCurriculumMenuAction(tabName);
        const viewArchive = [...menu.querySelectorAll('[role="menuitem"]')]
            .find(item => !item.hasAttribute('data-cc-curriculum-action') && /view\s+archive/i.test(item.textContent));
        if (viewArchive) {
            viewArchive.classList.remove('btn', 'btn-outline');
            viewArchive.classList.add('cc-curriculum-menu-action');
            if (viewArchive.dataset.ccStyled !== 'true') {
                viewArchive.innerHTML = '<i class="fas fa-box-archive" aria-hidden="true"></i><span>View archive</span>';
                viewArchive.dataset.ccStyled = 'true';
            }
        }

        let add = menu.querySelector('[data-cc-curriculum-action]');
        if (!menuAction) {
            add?.remove();
            return true;
        }
        if (!add) {
            add = createCurriculumMenuAction(menuAction.action, menuAction.icon, menuAction.label);
            menu.insertBefore(add, viewArchive || null);
        }
        const hasCurrentContent = add.dataset.ccCurriculumAction === menuAction.action
            && add.querySelector('i')?.className === `fas ${menuAction.icon}`
            && add.querySelector('span')?.textContent === menuAction.label;
        if (!hasCurrentContent) {
            add.dataset.ccCurriculumAction = menuAction.action;
            add.innerHTML = `<i class="fas ${menuAction.icon}" aria-hidden="true"></i><span>${menuAction.label}</span>`;
        }
        return true;
    }

    function observeCurriculumArchiveMenu() {
        if (curriculumArchiveMenuObserver || !document.body || typeof MutationObserver === 'undefined') return;
        curriculumArchiveMenuObserver = new MutationObserver(() => syncCurriculumActionsMenu());
        curriculumArchiveMenuObserver.observe(document.body, { childList: true, subtree: true });
        window.setTimeout(() => syncCurriculumActionsMenu(), 0);
    }

    async function loadCurriculum(id, options = {}) {
        const requestedTab = options.activeTab || 'overview';
        const requestedGradeFilter = options.gradeFilter === undefined
            ? 'all'
            : String(options.gradeFilter || 'all');
        state.curriculumId = id ? Number(id) : null;
        state.curriculumData = state.curriculumId
            ? state.refs.curricula.find(c => Number(c.curriculum_id) === state.curriculumId) || null
            : null;
        state.selectedGradeFilter = requestedGradeFilter;
        state.subjectRows = [];
        state.subjectBaselineRows = [];
        state.subjectDraftDirty = false;
        state.subjectDraftDirtyKeys = new Set();
        syncCurriculumActionsMenu();
        hideCurriculumForm();

        if (!state.curriculumId) {
            populateCurriculumSelect();
            renderAll();
            $('cc-empty-state').style.display = 'none';
            $('cc-editor').style.display = '';
            activateCurriculumTab(requestedTab);
            return;
        }

        $('cc-empty-state').style.display = 'none';
        $('cc-editor').style.display = '';
        setStatus('Loading components...');

        state.curriculumData = state.refs.curricula.find(c => Number(c.curriculum_id) === state.curriculumId) || null;
        syncCurriculumActionsMenu();

        const p = (op) => ({ operation: op, curriculum_id: state.curriculumId });
        const [cs, cpm] = await Promise.all([
            axios.get(api.curricula(), { params: p('getCurriculumSubjects') }),
            axios.get(api.curricula(), { params: p('getPassingMarks') })
        ]);

        const subjectRows = Array.isArray(cs.data) ? cs.data : [];
        const passingRows = Array.isArray(cpm.data) ? cpm.data : [];
        const passingFor = (gradeLevelId, subjectId) => {
            const exact = passingRows.find(row =>
                Number(row.grade_level_id) === gradeLevelId && Number(row.subject_id) === subjectId
            );
            const gradeDefault = passingRows.find(row =>
                Number(row.grade_level_id) === gradeLevelId && !Number(row.subject_id)
            );
            const curriculumDefault = passingRows.find(row =>
                !Number(row.grade_level_id) && !Number(row.subject_id)
            );
            return exact || gradeDefault || curriculumDefault || null;
        };

        const fallbackSortByGrade = new Map();
        state.subjectRows = subjectRows.map(r => {
            const gradeLevelId = Number(r.grade_level_id);
            const subjectId = Number(r.subject_id);
            const passing = passingFor(gradeLevelId, subjectId);
            const rawMark = passing?.passing_mark;
            const parsedMark = Number(rawMark);
            const parsedSortOrder = Number(r.sort_order);
            const fallbackSortOrder = (fallbackSortByGrade.get(gradeLevelId) || 0) + 1;
            fallbackSortByGrade.set(gradeLevelId, fallbackSortOrder);
            return {
                grade_level_id: gradeLevelId,
                subject_id: subjectId,
                sort_order: Number.isFinite(parsedSortOrder) && parsedSortOrder > 0
                    ? parsedSortOrder
                    : fallbackSortOrder,
                passing_mark: Number.isFinite(parsedMark) ? parsedMark : DEFAULT_PASSING_MARK,
                weekly_minutes: r.weekly_minutes ?? null,
                meeting_minutes: r.meeting_minutes ?? r.weekly_minutes ?? null,
                meetings_per_week: r.meetings_per_week ?? null,
                notes: passing?.notes || null
            };
        });

        state.subjectBaselineRows = state.subjectRows.map(row => ({ ...row }));
        state.subjectDraftDirty = false;
        state.subjectDraftDirtyKeys = new Set();

        renderAll();
        activateCurriculumTab(requestedTab);
        setStatus('');
    }

    /* ═══ Render all ═══ */

    function renderAll() {
        renderOverview();
        renderSubjects();
    }

    /* ─── Overview tab ─── */

    function renderOverview() {
        const info = $('cc-curriculum-info');
        const c = state.curriculumData;

        if (info && c) {
            info.dataset.hasActions = 'true';
            info.tabIndex = 0;
            info.setAttribute('aria-label', `Show actions for ${c.curriculum_code || c.curriculum_name || 'selected curriculum'}`);
            info.innerHTML = `
                <div class="cc-info-grid">
                    <div class="cc-info-item"><span class="cc-info-label">Code</span><span class="cc-info-value">${esc(c.curriculum_code)}</span></div>
                    <div class="cc-info-item"><span class="cc-info-label">Name</span><span class="cc-info-value">${esc(c.curriculum_name)}</span></div>
                    <div class="cc-info-item"><span class="cc-info-label">Effective</span><span class="cc-info-value">${esc(c.effective_from)}${c.effective_until ? ' - ' + esc(c.effective_until) : ' - present'}</span></div>
                    <div class="cc-info-item"><span class="cc-info-label">Status</span><span class="cc-info-value"><span class="badge ${Number(c.is_active) === 1 ? 'badge-active' : 'badge-inactive'}">${Number(c.is_active) === 1 ? 'Active' : 'Inactive'}</span></span></div>
                    ${c.description ? `<div class="cc-info-item" style="grid-column:1/-1;"><span class="cc-info-label">Description</span><span class="cc-info-value" style="font-weight:400;">${esc(c.description)}</span></div>` : ''}
                </div>
                <div class="mf-row-action-source" hidden>
                    <button type="button" data-cc-curriculum-info-action="edit" data-action="edit" title="Edit curriculum" aria-label="Edit curriculum">Edit curriculum</button>
                    <button type="button" data-cc-curriculum-info-action="archive" data-action="delete" title="Archive curriculum" aria-label="Archive curriculum">Archive curriculum</button>
                </div>`;
        } else if (info) {
            info.dataset.hasActions = 'false';
            info.tabIndex = -1;
            info.setAttribute('aria-label', 'Show curriculum actions');
            info.innerHTML = `
                <div class="cc-panel-placeholder">
                    <i class="fas fa-arrow-up-right-dots" aria-hidden="true"></i>
                    <div><strong>Select a curriculum first</strong><span>Choose one from the Curriculum card to load its overview.</span></div>
                </div>`;
        }
    }

    /* ─── Subjects tab (collapsible grade cards) ─── */

    /* ─── Subjects tab (Table display + Filter + Modal) ─── */

    function getModalFocusableElements(el) {
        if (!el) return [];
        return Array.from(el.querySelectorAll(
            'a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter((node) => node.getClientRects().length > 0 && !node.hidden);
    }

    function openModal(id) {
        const el = $(id);
        if (!el) return;
        const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        state.modalStack = state.modalStack.filter(entry => entry.id !== id);
        state.modalStack.push({ id, returnFocus });
        state.activeModalId = id;
        state.modalReturnFocus = returnFocus;

        el.classList.add('show');
        el.style.display = 'flex';
        el.setAttribute('aria-hidden', 'false');
        document.body.classList.add('modal-open');

        if (!$('cc-modal-backdrop')) {
            const backdrop = document.createElement('div');
            backdrop.className = 'modal-backdrop fade show';
            backdrop.id = 'cc-modal-backdrop';
            backdrop.setAttribute('aria-hidden', 'true');
            document.body.appendChild(backdrop);
        }

        const initialFocus = el.querySelector('#cc-modal-subject-search, #cc-new-subject-name') || getModalFocusableElements(el)[0];
        const focusInitial = () => initialFocus?.focus({ preventScroll: true });
        window.requestAnimationFrame(focusInitial);
        window.setTimeout(focusInitial, 0);
    }

    function closeModal(id) {
        const el = $(id);
        if (!el) return;
        el.classList.remove('show');
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');

        const closed = state.modalStack.find(entry => entry.id === id);
        state.modalStack = state.modalStack.filter(entry => entry.id !== id);
        const next = state.modalStack.length ? state.modalStack[state.modalStack.length - 1] : null;
        const backdrop = $('cc-modal-backdrop');
        if (next) {
            state.activeModalId = next.id;
            state.modalReturnFocus = next.returnFocus;
            document.body.classList.add('modal-open');
            if (!backdrop) {
                const newBackdrop = document.createElement('div');
                newBackdrop.className = 'modal-backdrop fade show';
                newBackdrop.id = 'cc-modal-backdrop';
                newBackdrop.setAttribute('aria-hidden', 'true');
                document.body.appendChild(newBackdrop);
            }
        } else {
            state.activeModalId = null;
            state.modalReturnFocus = null;
            document.body.classList.remove('modal-open');
            backdrop?.remove();
        }

        window.requestAnimationFrame(() => closed?.returnFocus?.focus?.({ preventScroll: true }));
    }

    function clearAddSubjectSelection() {
        state.modalSubjectSearch = '';
        state.modalSelectedSubjectIds = new Set();
        state.modalSelectionMode = false;
        state.modalSubjectPassingMarks = new Map();
        state.modalSubjectMeetingMinutes = new Map();
        state.modalMapehPreset = null;
        state.modalMapehSubjectIds = new Set();
        state.modalMapehPassingMarks = new Map();
    }

    function populateNewSubjectCategoryOptions() {
        const select = $('cc-new-subject-category');
        if (!select) return;

        const categories = (state.refs.subjectCategories || [])
            .filter(category => Number(category?.is_active ?? 1) === 1 && Number(category?.is_deleted ?? 0) === 0)
            .sort((a, b) => subjectCategorySortValue(a) - subjectCategorySortValue(b));
        select.innerHTML = '<option value="">Select subject category</option>' + categories
            .map(category => `<option value="${esc(category.subject_category_id)}">${esc(category.category_name || '')}</option>`)
            .join('');
        select.disabled = categories.length === 0;
    }

    function resetNewSubjectMasterForm() {
        if ($('cc-new-subject-name')) $('cc-new-subject-name').value = '';
        if ($('cc-new-subject-category')) $('cc-new-subject-category').value = '';
        if ($('cc-new-subject-description')) $('cc-new-subject-description').value = '';
        populateNewSubjectCategoryOptions();
    }

    function resetAddSubjectDraft() {
        clearAddSubjectSelection();
        state.modalTargetGradeId = '';
        updateModalSelectedCount();
    }

    function subjectRowKey(row) {
        return `${Number(row?.grade_level_id || 0)}-${Number(row?.subject_id || 0)}`;
    }

    function comparablePassingMark(value) {
        const raw = String(value ?? '').trim();
        if (!raw) return '';
        const numeric = Number(raw);
        return Number.isFinite(numeric) ? String(numeric) : raw;
    }

    function comparableTimeValue(value) {
        const raw = String(value ?? '').trim();
        if (!raw) return '';
        const numeric = Number(raw);
        return Number.isFinite(numeric) ? String(numeric) : raw;
    }

    function getMeetingMinutesValue(row) {
        const value = row?.meeting_minutes ?? row?.weekly_minutes;
        return value === null || value === undefined || value === '' ? '' : value;
    }

    function comparableSubjectRow(row) {
        const sortOrder = Number(row?.sort_order);
        const comparableOrder = Number.isFinite(sortOrder) && sortOrder > 0 ? String(sortOrder) : '';
        return `${comparableOrder}|${comparablePassingMark(row?.passing_mark)}|${comparableTimeValue(getMeetingMinutesValue(row))}|${comparableTimeValue(row?.meetings_per_week)}|${String(row?.notes ?? '')}`;
    }

    function getDraftDirtyKeys(currentRows, baselineRows) {
        const current = new Map((currentRows || []).map(row => [subjectRowKey(row), comparableSubjectRow(row)]));
        const baseline = new Map((baselineRows || []).map(row => [subjectRowKey(row), comparableSubjectRow(row)]));
        const dirtyKeys = new Set();

        current.forEach((value, key) => {
            if (baseline.get(key) !== value) dirtyKeys.add(key);
        });
        baseline.forEach((value, key) => {
            if (!current.has(key)) dirtyKeys.add(key);
        });
        return dirtyKeys;
    }

    function isDisplayRowDirty(row, dirtyKeys) {
        const keys = row?.isMapehParentDisplay
            ? (row.mapehSubjectIds || []).map(subjectId => `${Number(row.grade_level_id)}-${Number(subjectId)}`)
            : [subjectRowKey(row)];
        return keys.some(key => dirtyKeys.has(key));
    }

    function updateSubjectDraftState() {
        state.subjectDraftDirtyKeys = getDraftDirtyKeys(state.subjectRows, state.subjectBaselineRows);
        state.subjectDraftDirty = state.subjectDraftDirtyKeys.size > 0;
    }

    function syncModalEditIndicators() {
        const modal = $('cc-year-subject-modal');
        const footer = $('cc-year-subject-modal-footer');
        modal?.classList.toggle('cc-has-unsaved', state.modalEditDirty);
        footer?.classList.toggle('cc-has-unsaved', state.modalEditDirty);
        footer?.toggleAttribute('data-unsaved', state.modalEditDirty);

        document.querySelectorAll('#cc-year-subject-modal .cc-year-subject-edit-mark, #cc-year-subject-modal .cc-year-subject-edit-time').forEach(input => {
            const row = {
                grade_level_id: input.dataset.grade,
                subject_id: input.dataset.subject,
                isMapehParentDisplay: input.hasAttribute('data-cc-edit-mapeh-parent-mark')
                    || input.hasAttribute('data-cc-edit-mapeh-parent-time'),
                mapehSubjectIds: input.hasAttribute('data-cc-edit-mapeh-parent-mark')
                    || input.hasAttribute('data-cc-edit-mapeh-parent-time')
                    ? state.modalEditRows
                        .filter(subject => Number(subject.grade_level_id) === Number(input.dataset.grade))
                        .filter(subject => isMapehRelatedSubjectId(subject.subject_id))
                        .map(subject => Number(subject.subject_id))
                    : []
            };
            input.classList.toggle('cc-field-unsaved', isDisplayRowDirty(row, state.modalEditDirtyKeys));
        });
        syncModalEditSelectionControls();
    }

    function getModalEditDisplayRows() {
        return getDisplaySubjectRows(state.modalEditRows);
    }

    function syncModalEditSelectionControls() {
        const rows = getModalEditDisplayRows();
        const visibleIds = rows.map(row => Number(row.subject_id)).filter(Boolean);
        const visibleIdSet = new Set(visibleIds);
        state.modalEditSelectedSubjectIds = new Set(
            [...state.modalEditSelectedSubjectIds].filter(subjectId => visibleIdSet.has(Number(subjectId)))
        );
        const selectedCount = visibleIds.filter(subjectId => state.modalEditSelectedSubjectIds.has(subjectId)).length;
        if (state.modalEditSelectionMode && selectedCount === 0) state.modalEditSelectionMode = false;
        $('cc-year-subject-modal')?.classList.toggle('cc-selection-mode', state.modalEditSelectionMode);
        const selectAll = $('cc-edit-select-all');
        const selectedCountLabel = $('cc-edit-selected-count');
        const removeSelected = $('cc-year-subject-modal-remove-selected');

        if (selectAll) {
            selectAll.checked = visibleIds.length > 0 && selectedCount === visibleIds.length;
            selectAll.indeterminate = selectedCount > 0 && selectedCount < visibleIds.length;
            selectAll.disabled = visibleIds.length === 0;
        }
        if (selectedCountLabel) selectedCountLabel.textContent = `${selectedCount} selected`;
        if (removeSelected) removeSelected.disabled = selectedCount === 0;
    }

    function updateModalEditDraftState() {
        state.modalEditDirtyKeys = getDraftDirtyKeys(state.modalEditRows, state.modalEditBaselineRows);
        state.modalEditDirty = state.modalEditDirtyKeys.size > 0;
        syncModalEditIndicators();
    }

    function discardSubjectDraft() {
        state.subjectRows = state.subjectBaselineRows.map(row => ({ ...row }));
        state.subjectDraftDirty = false;
        state.subjectDraftDirtyKeys = new Set();
        renderSubjects();
    }

    function hasUnsavedSubjectWork() {
        return state.subjectDraftDirty || state.modalEditDirty || hasUnsavedAddSubjectChanges();
    }

    async function confirmDiscardSubjectChanges() {
        if (!state.subjectDraftDirty) return true;
        if (typeof window.confirmUnsavedChanges === 'function') {
            return window.confirmUnsavedChanges({
                title: 'Unsaved subject changes',
                message: 'Save the staged subject assignments and passing marks before leaving Subjects?',
                confirmLabel: 'Leave without saving',
                cancelLabel: 'Stay'
            });
        }
        return window.confirm('Unsaved subject changes\n\nLeave without saving?');
    }

    async function confirmDiscardModalEditChanges() {
        if (!state.modalEditDirty) return true;
        if (typeof window.confirmUnsavedChanges === 'function') {
            return window.confirmUnsavedChanges({
                title: 'Unsaved subject edits',
                message: 'The subject list has edits that are not saved yet. Leave this edit?',
                confirmLabel: 'Leave without saving',
                cancelLabel: 'Stay'
            });
        }
        return window.confirm('Unsaved subject edits\n\nLeave without saving?');
    }

    async function confirmDiscardSubjectWork() {
        if (state.modalEditDirty) {
            if (!await confirmDiscardModalEditChanges()) return false;
            closeYearSubjectsModal();
        }
        if (state.subjectDraftDirty) {
            if (!await confirmDiscardSubjectChanges()) return false;
            discardSubjectDraft();
        }
        if (hasUnsavedAddSubjectChanges()) {
            if (!await confirmDiscardAddSubjectChanges()) return false;
            resetAddSubjectDraft();
        }
        return true;
    }

    async function requestCloseYearSubjectsModal() {
        if (!await confirmDiscardModalEditChanges()) return false;
        closeYearSubjectsModal();
        return true;
    }

    function hasUnsavedAddSubjectChanges() {
        return state.modalSelectedSubjectIds.size > 0
            || state.modalSubjectPassingMarks.size > 0
            || state.modalSubjectMeetingMinutes.size > 0
            || Boolean(state.modalMapehPreset)
            || state.modalMapehSubjectIds.size > 0;
    }

    async function confirmDiscardAddSubjectChanges() {
        if (!hasUnsavedAddSubjectChanges()) return true;

        const title = 'Discard unsaved subject assignments?';
        const message = 'Your selected subjects and passing marks have not been added to this year level. Continue without saving?';

        if (typeof window.confirmUnsavedChanges === 'function') {
            return window.confirmUnsavedChanges({
                title,
                message,
                confirmLabel: 'Discard changes',
                cancelLabel: 'Keep editing'
            });
        }

        if (window.Swal) {
            const result = await window.Swal.fire({
                icon: 'warning',
                title,
                text: message,
                showCancelButton: true,
                confirmButtonText: 'Discard changes',
                cancelButtonText: 'Keep editing',
                confirmButtonColor: '#9f2f2d',
                cancelButtonColor: '#0055a4'
            });
            return result.isConfirmed === true;
        }

        return window.confirm(`${title}\n\n${message}`);
    }

    async function requestCloseAddSubjectModal() {
        if (!await confirmDiscardAddSubjectChanges()) return false;
        resetAddSubjectDraft();
        closeModal('ccAddSubjectModal');
        return true;
    }

    function subjectDisplayName(subjectId) {
        const subject = state.refs.subjects.find(sub => Number(sub.subject_id) === Number(subjectId));
        return subject?.subject_name || 'Unassigned / Archived';
    }

    function gradeDisplayName(gradeLevelId) {
        const grade = state.refs.gradeLevels.find(gl => Number(gl.grade_level_id) === Number(gradeLevelId));
        return grade?.grade_name || 'Unknown Grade';
    }

    function subjectOrderValue(row) {
        const order = Number(row?.sort_order);
        return Number.isFinite(order) && order > 0 ? order : Number.MAX_SAFE_INTEGER;
    }

    function compareSubjectRows(a, b) {
        const categoryDifference = subjectCategorySortValue(getSubjectCategoryForRow(a))
            - subjectCategorySortValue(getSubjectCategoryForRow(b));
        if (categoryDifference !== 0) return categoryDifference;
        const orderDifference = subjectOrderValue(a) - subjectOrderValue(b);
        if (orderDifference !== 0) return orderDifference;

        const sourceA = Number(a?._ccSourceIndex);
        const sourceB = Number(b?._ccSourceIndex);
        if (Number.isFinite(sourceA) && Number.isFinite(sourceB) && sourceA !== sourceB) {
            return sourceA - sourceB;
        }
        return 0;
    }

    function assignSubjectSortOrder(rows) {
        return (rows || []).map((row, index) => ({
            ...row,
            sort_order: index + 1
        }));
    }

    function setSubjectsTableMode(mode) {
        const table = $('cc-subjects-table');
        const headerRow = table?.querySelector('thead tr');
        if (!table || !headerRow) return;

        table.dataset.displayMode = mode;
        headerRow.innerHTML = mode === 'summary'
            ? '<th>Year Level</th><th class="cc-subjects-heading-cell"><span>Subjects</span></th>'
            : '<th style="width: 180px;">Grade Level</th><th>Subject Name</th><th class="cc-subjects-heading-cell" style="width: 150px;"><span>Passing mark</span></th>';
    }

    function getSubjectsForGrade(gradeLevelId) {
        return state.subjectRows
            .filter(row => Number(row.grade_level_id) === Number(gradeLevelId))
            .map((row, index) => ({ ...row, _ccSourceIndex: index }))
            .sort(compareSubjectRows);
    }

    function getMapehParentSubjectId(rows = []) {
        const rowParent = rows.find(row => getMapehSubjectKindById(row.subject_id) === 'parent');
        if (rowParent?.subject_id) return Number(rowParent.subject_id);
        const catalogParent = state.refs.subjects.find(subject => getMapehSubjectKindByName(subject.subject_name) === 'parent');
        return Number(catalogParent?.subject_id || 0);
    }

    function getDisplaySubjectRows(rows = []) {
        const sourceRows = rows
            .map((row, index) => ({ ...row, _ccSourceIndex: index }))
            .sort(compareSubjectRows);
        const mapehRows = sourceRows.filter(row => isMapehRelatedSubjectId(row.subject_id));
        if (!mapehRows.length) return sourceRows;

        const parentRow = mapehRows.find(row => getMapehSubjectKindById(row.subject_id) === 'parent');
        const parentSubjectId = Number(parentRow?.subject_id || getMapehParentSubjectId(mapehRows) || mapehRows[0].subject_id);
        const mapehSortOrder = Math.min(...mapehRows.map(subjectOrderValue));
        const displayRow = {
            ...(parentRow || mapehRows[0]),
            subject_id: parentSubjectId,
            sort_order: mapehSortOrder === Number.MAX_SAFE_INTEGER ? null : mapehSortOrder,
            isMapehParentDisplay: true,
            mapehSubjectIds: mapehRows.map(row => Number(row.subject_id)).filter(Boolean),
            _ccSourceIndex: Math.min(...mapehRows.map(row => Number(row._ccSourceIndex)))
        };
        const nonMapehRows = sourceRows.filter(row => !isMapehRelatedSubjectId(row.subject_id));
        return [...nonMapehRows, displayRow]
            .sort(compareSubjectRows);
    }

    function renderYearSubjectsModalList(mode) {
        const gradeLevelId = state.modalEditGradeLevelId;
        const rawRows = mode === 'edit' ? state.modalEditRows : getSubjectsForGrade(gradeLevelId);
        const rows = getDisplaySubjectRows(rawRows);
        const modal = $('cc-year-subject-modal');
        const title = $('cc-year-subject-modal-title');
        const detail = $('cc-year-subject-modal-detail');
        const list = $('cc-year-subject-modal-list');
        const label = gradeDisplayName(gradeLevelId);

        modal?.classList.toggle('cc-selection-mode', mode === 'edit' && state.modalEditSelectionMode);
        if (title) title.textContent = mode === 'edit' ? `Edit ${label} subjects` : label;
        if (detail) {
            detail.toggleAttribute('hidden', mode === 'edit');
            if (mode !== 'edit') detail.textContent = `${rows.length} subject${rows.length !== 1 ? 's' : ''} assigned`;
        }
        if (list) {
            list.innerHTML = rows.length
                ? `${mode === 'edit'
                    ? `<div class="cc-subject-order-note" id="cc-year-subject-order-note" role="note">
                            <i class="fas fa-grip-vertical" aria-hidden="true"></i>
                            <div><strong>Important:</strong><span>Drag and drop subject rows to set report-card order. Click a row once to select it for removal. Set the total daily instructional minutes for the subject, then save to apply the changes.</span><span class="cc-visually-hidden" id="cc-year-subject-order-status" aria-live="polite"></span></div>
                       </div>
                       <div class="cc-year-subject-list-heading cc-edit-subject-list-heading"><label class="cc-edit-select-all"><input type="checkbox" id="cc-edit-select-all"><span>Select all</span></label><span>Subject</span><span>Passing mark</span><span>Daily min</span></div>`
                    : '<div class="cc-year-subject-list-heading"><span>Subject</span><span>Passing mark</span><span>Daily min</span></div>'}${renderSubjectCategoryRowSections(rows, (row, index) => `
                    <div class="cc-year-subject-list-item${mode === 'edit' ? ' cc-year-subject-edit-row' : ''}"${mode === 'edit' ? ` data-cc-edit-subject-row data-cc-edit-sortable-row data-display-index="${index}" data-grade="${gradeLevelId}" data-subject="${row.subject_id}" draggable="true" tabindex="0" title="Drag to reorder or click to select" aria-label="${esc(subjectDisplayName(row.subject_id))}, position ${index + 1} of ${rows.length}"` : ''}>
                        ${mode === 'edit'
                            ? `<label class="cc-edit-subject-check"><input type="checkbox" data-cc-edit-select-subject data-grade="${gradeLevelId}" data-subject="${row.subject_id}" aria-label="Select ${esc(subjectDisplayName(row.subject_id))}"${state.modalEditSelectedSubjectIds.has(Number(row.subject_id)) ? ' checked' : ''}></label>`
                            : ''}
                        <span class="cc-year-subject-list-name">${mode === 'edit' ? '<span class="cc-subject-drag-handle" aria-hidden="true" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></span>' : ''}${esc(subjectDisplayName(row.subject_id))}</span>
                        ${mode === 'edit'
                            ? `<input class="form-control cc-year-subject-edit-mark${isDisplayRowDirty(row, state.modalEditDirtyKeys) ? ' cc-field-unsaved' : ''}" type="number" min="0" max="100" step="0.01" value="${getPassingMarkValue(row.passing_mark)}" ${row.isMapehParentDisplay ? 'data-cc-edit-mapeh-parent-mark' : 'data-cc-edit-passing-mark'} data-grade="${gradeLevelId}" data-subject="${row.subject_id}" aria-label="Passing mark for ${esc(subjectDisplayName(row.subject_id))}">
                               <input class="form-control cc-year-subject-edit-time${isDisplayRowDirty(row, state.modalEditDirtyKeys) ? ' cc-field-unsaved' : ''}" type="number" min="1" max="600" step="1" value="${getMeetingMinutesValue(row)}" ${row.isMapehParentDisplay ? 'data-cc-edit-mapeh-parent-time' : 'data-cc-edit-meeting-minutes'} data-grade="${gradeLevelId}" data-subject="${row.subject_id}" aria-label="Daily instructional minutes for ${esc(subjectDisplayName(row.subject_id))}" placeholder="—">
                               <div class="mf-row-action-source" hidden><button type="button" data-action="remove-subject-item" data-cc-edit-subject-action="remove" data-grade="${gradeLevelId}" data-subject="${row.subject_id}" title="Remove subject" aria-label="Remove subject">Remove subject</button></div>`
                            : `<span class="cc-year-subject-list-mark">${getPassingMarkValue(row.passing_mark)}</span><span class="cc-year-subject-list-time">${getMeetingMinutesValue(row) ? `${esc(getMeetingMinutesValue(row))} min` : '—'}</span>`}
                    </div>
                `)}`
                : '<div class="cc-year-subject-list-empty"><i class="fas fa-folder-open" aria-hidden="true"></i><span>No subjects assigned to this year level.</span></div>';
        }
        $('cc-year-subject-modal-footer')?.toggleAttribute('hidden', mode !== 'edit');
        syncModalEditIndicators();
    }

    function getModalEditRowGroups(displayRows = getModalEditDisplayRows()) {
        const gradeLevelId = Number(state.modalEditGradeLevelId || 0);
        const usedKeys = new Set();
        const groups = displayRows.map((displayRow) => {
            const subjectIds = new Set(
                displayRow?.isMapehParentDisplay
                    ? (displayRow.mapehSubjectIds || []).map(Number)
                    : [Number(displayRow?.subject_id || 0)]
            );
            const group = state.modalEditRows.filter((row) => {
                if (Number(row.grade_level_id) !== gradeLevelId || !subjectIds.has(Number(row.subject_id))) return false;
                const key = subjectRowKey(row);
                if (usedKeys.has(key)) return false;
                usedKeys.add(key);
                return true;
            });
            return group;
        });

        // Preserve any unexpected raw rows rather than silently dropping them
        // if a future MAPEH/catalog variant is not represented by a display row.
        const remaining = state.modalEditRows.filter(row => !usedKeys.has(subjectRowKey(row)));
        if (remaining.length) groups.push(remaining);
        return groups;
    }

    function focusModalEditDisplayRow(subjectId) {
        window.requestAnimationFrame(() => {
            const row = [...document.querySelectorAll('#cc-year-subject-modal [data-cc-edit-sortable-row]')]
                .find(candidate => Number(candidate.dataset.subject) === Number(subjectId));
            row?.focus({ preventScroll: true });
        });
    }

    function activateModalEditSelectionMode(row) {
        const subjectId = Number(row?.dataset.subject || 0);
        if (!subjectId) return;

        state.modalEditSelectionMode = true;
        if (state.modalEditSelectedSubjectIds.has(subjectId)) state.modalEditSelectedSubjectIds.delete(subjectId);
        else state.modalEditSelectedSubjectIds.add(subjectId);
        renderYearSubjectsModalList('edit');

        window.requestAnimationFrame(() => {
            document.querySelector(`#cc-year-subject-modal [data-cc-edit-select-subject][data-subject="${subjectId}"]`)
                ?.focus({ preventScroll: true });
        });
    }

    function captureModalEditRowRects(subjectIds) {
        const rects = new Map();
        subjectIds.forEach(subjectId => {
            const row = [...document.querySelectorAll('#cc-year-subject-modal [data-cc-edit-sortable-row]')]
                .find(candidate => Number(candidate.dataset.subject) === Number(subjectId));
            if (row) rects.set(String(subjectId), row.getBoundingClientRect());
        });
        return rects;
    }

    function animateModalEditRowExchange(beforeRects, subjectIds) {
        if (!beforeRects?.size || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;

        window.requestAnimationFrame(() => {
            subjectIds.forEach(subjectId => {
                const before = beforeRects.get(String(subjectId));
                const row = [...document.querySelectorAll('#cc-year-subject-modal [data-cc-edit-sortable-row]')]
                    .find(candidate => Number(candidate.dataset.subject) === Number(subjectId));
                if (!before || !row) return;

                const after = row.getBoundingClientRect();
                const offsetY = Math.round(before.top - after.top);
                if (!offsetY) return;

                const animationToken = `${Date.now()}-${subjectId}`;
                row.dataset.ccExchangeToken = animationToken;
                row.style.setProperty('--cc-order-exchange-offset', `${offsetY}px`);
                row.classList.add('cc-order-exchange-active');
                window.setTimeout(() => {
                    if (row.dataset.ccExchangeToken !== animationToken) return;
                    row.classList.remove('cc-order-exchange-active');
                    row.style.removeProperty('--cc-order-exchange-offset');
                    delete row.dataset.ccExchangeToken;
                }, 390);
            });
        });
    }

    function reorderModalEditDisplayRow(fromIndex, toIndex, options = {}) {
        const displayRows = getModalEditDisplayRows();
        if (fromIndex < 0 || fromIndex >= displayRows.length || toIndex < 0 || toIndex >= displayRows.length || fromIndex === toIndex) return;

        const affectedSubjectIds = options.animate
            ? displayRows
                .map(row => Number(row?.subject_id || 0))
                .filter(Boolean)
            : [];
        const beforeRects = affectedSubjectIds.length ? captureModalEditRowRects(affectedSubjectIds) : null;
        const [movedDisplayRow] = displayRows.splice(fromIndex, 1);
        displayRows.splice(toIndex, 0, movedDisplayRow);
        const reorderedRows = getModalEditRowGroups(displayRows).flat();
        state.modalEditRows = assignSubjectSortOrder(reorderedRows);
        state.modalEditDraggedIndex = null;
        state.modalEditDropIndex = null;
        updateModalEditDraftState();
        renderYearSubjectsModalList('edit');
        animateModalEditRowExchange(beforeRects, affectedSubjectIds);

        const subjectId = Number(movedDisplayRow?.subject_id || 0);
        const orderStatus = $('cc-year-subject-order-status');
        if (orderStatus && subjectId) {
            orderStatus.textContent = `${subjectDisplayName(subjectId)} moved to position ${toIndex + 1} of ${displayRows.length}.`;
        }
        focusModalEditDisplayRow(subjectId);
    }

    function stopModalEditAutoScroll() {
        if (state.modalEditAutoScrollFrame !== null) {
            window.cancelAnimationFrame(state.modalEditAutoScrollFrame);
            state.modalEditAutoScrollFrame = null;
        }
        state.modalEditAutoScrollVelocity = 0;
    }

    function getModalEditDropTarget(clientY) {
        const list = $('cc-year-subject-modal-list');
        const rows = list ? [...list.querySelectorAll('[data-cc-edit-sortable-row]')] : [];
        if (!rows.length) return null;

        const firstRect = rows[0].getBoundingClientRect();
        if (clientY <= firstRect.top + firstRect.height / 2) {
            return { index: 0, row: rows[0], position: 'before' };
        }

        for (let index = 1; index < rows.length; index += 1) {
            const rect = rows[index].getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                return { index, row: rows[index], position: 'before' };
            }
        }

        return { index: rows.length, row: rows[rows.length - 1], position: 'after' };
    }

    function paintModalEditDropTarget(clientY) {
        const list = $('cc-year-subject-modal-list');
        const target = getModalEditDropTarget(clientY);
        if (!list || !target) return null;

        state.modalEditDropIndex = target.index;
        const targetClass = target.position === 'before' ? 'cc-drop-before' : 'cc-drop-after';
        if (target.row.classList.contains(targetClass) && target.row.dataset.dropPosition === target.position) {
            return target;
        }
        list.querySelectorAll('[data-cc-edit-sortable-row]').forEach(candidate => {
            candidate.classList.remove('cc-drop-before', 'cc-drop-after');
            candidate.removeAttribute('data-drop-position');
        });
        target.row.classList.add(targetClass);
        target.row.dataset.dropPosition = target.position;
        return target;
    }

    function updateModalEditAutoScroll(clientY) {
        const scrollContainer = document.querySelector('#cc-year-subject-modal .cc-year-subject-modal-body');
        if (!scrollContainer) return;

        const rect = scrollContainer.getBoundingClientRect();
        const edgeSize = Math.min(84, Math.max(48, rect.height * 0.18));
        const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        let velocity = 0;

        if (clientY < rect.top + edgeSize && scrollContainer.scrollTop > 0) {
            velocity = -Math.min(18, Math.max(2, (rect.top + edgeSize - clientY) * 0.32));
        } else if (clientY > rect.bottom - edgeSize && scrollContainer.scrollTop < maxScrollTop) {
            velocity = Math.min(18, Math.max(2, (clientY - (rect.bottom - edgeSize)) * 0.32));
        }

        state.modalEditAutoScrollVelocity = velocity;
        if (!velocity || state.modalEditDraggedIndex === null) {
            stopModalEditAutoScroll();
            return;
        }

        if (state.modalEditAutoScrollFrame !== null) return;
        const tick = () => {
            state.modalEditAutoScrollFrame = null;
            if (state.modalEditDraggedIndex === null || !state.modalEditAutoScrollVelocity) return;

            const currentContainer = document.querySelector('#cc-year-subject-modal .cc-year-subject-modal-body');
            if (!currentContainer) {
                stopModalEditAutoScroll();
                return;
            }

            const previousScrollTop = currentContainer.scrollTop;
            const nextScrollTop = Math.max(
                0,
                Math.min(
                    currentContainer.scrollHeight - currentContainer.clientHeight,
                    previousScrollTop + state.modalEditAutoScrollVelocity
                )
            );
            currentContainer.scrollTop = nextScrollTop;
            paintModalEditDropTarget(state.modalEditDragClientY);

            if (nextScrollTop === previousScrollTop) {
                stopModalEditAutoScroll();
                return;
            }
            state.modalEditAutoScrollFrame = window.requestAnimationFrame(tick);
        };
        state.modalEditAutoScrollFrame = window.requestAnimationFrame(tick);
    }

    function clearModalEditDragState() {
        stopModalEditAutoScroll();
        state.modalEditDraggedIndex = null;
        state.modalEditDropIndex = null;
        state.modalEditDragClientY = 0;
        document.querySelectorAll('#cc-year-subject-modal [data-cc-edit-sortable-row]').forEach(row => {
            row.classList.remove('cc-is-dragging', 'cc-drop-before', 'cc-drop-after');
            row.removeAttribute('data-drop-position');
        });
    }

    function wireModalSubjectReordering() {
        const list = $('cc-year-subject-modal-list');
        const surface = $('cc-year-subject-modal')?.querySelector('.cc-year-subject-modal-body') || list;
        if (!list || !surface) return;

        list.addEventListener('dragstart', (event) => {
            const row = event.target.closest('[data-cc-edit-sortable-row]');
            if (!row || $('cc-year-subject-modal')?.dataset.mode !== 'edit') return;
            if (event.target.closest('a, button, input, select, textarea, label')) {
                event.preventDefault();
                return;
            }

            state.modalEditDraggedIndex = Number(row.dataset.displayIndex);
            state.modalEditDropIndex = null;
            state.modalEditDragClientY = event.clientY;
            row.classList.add('cc-is-dragging');
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(state.modalEditDraggedIndex));
            }
        });

        surface.addEventListener('dragover', (event) => {
            if (state.modalEditDraggedIndex === null) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            state.modalEditDragClientY = event.clientY;
            paintModalEditDropTarget(event.clientY);
            updateModalEditAutoScroll(event.clientY);
        });

        surface.addEventListener('drop', (event) => {
            if (state.modalEditDraggedIndex === null) return;
            event.preventDefault();

            const fromIndex = Number(state.modalEditDraggedIndex);
            const target = paintModalEditDropTarget(event.clientY) || { index: state.modalEditDropIndex };
            const insertIndex = Number(target.index);
            const toIndex = insertIndex > fromIndex ? insertIndex - 1 : insertIndex;
            clearModalEditDragState();
            reorderModalEditDisplayRow(fromIndex, toIndex, { animate: true });
        });

        list.addEventListener('dragend', clearModalEditDragState);
        surface.addEventListener('dragleave', (event) => {
            if (event.relatedTarget instanceof Node && surface.contains(event.relatedTarget)) return;
            stopModalEditAutoScroll();
        });

    }

    function openYearSubjectsModal(gradeLevelId, mode = 'view') {
        state.modalEditGradeLevelId = Number(gradeLevelId);
        state.modalEditRows = mode === 'edit'
            ? getSubjectsForGrade(gradeLevelId).map(row => ({ ...row }))
            : [];
        state.modalEditBaselineRows = mode === 'edit'
            ? state.modalEditRows.map(row => ({ ...row }))
            : [];
        state.modalEditDirty = false;
        state.modalEditDirtyKeys = new Set();
        state.modalEditSelectedSubjectIds = new Set();
        state.modalEditSelectionMode = false;
        state.modalEditDraggedIndex = null;
        state.modalEditDropIndex = null;
        state.modalEditDragClientY = 0;
        stopModalEditAutoScroll();
        const modal = $('cc-year-subject-modal');
        if (modal) modal.dataset.mode = mode;
        renderYearSubjectsModalList(mode);

        openModal('cc-year-subject-modal');
    }

    function closeYearSubjectsModal() {
        closeModal('cc-year-subject-modal');
        state.modalEditGradeLevelId = null;
        state.modalEditRows = [];
        state.modalEditBaselineRows = [];
        state.modalEditDirty = false;
        state.modalEditDirtyKeys = new Set();
        state.modalEditSelectedSubjectIds = new Set();
        state.modalEditSelectionMode = false;
        state.modalEditDraggedIndex = null;
        state.modalEditDropIndex = null;
        state.modalEditDragClientY = 0;
        stopModalEditAutoScroll();
        syncModalEditIndicators();
    }

    let curriculumRowActionMenuFrame = null;

    function closeCurriculumRowActionMenu(restoreFocus = false) {
        const menu = $('ccCurriculumRowActions');
        const trigger = menu?.__ccTrigger;
        menu?.remove();
        document.body.classList.remove('mf-mobile-sheet-open');
        document.querySelectorAll('[data-cc-mobile-actions-toggle][aria-expanded="true"]').forEach(toggle => {
            toggle.setAttribute('aria-expanded', 'false');
        });
        if (restoreFocus) trigger?.focus({ preventScroll: true });
    }

    function positionCurriculumRowActionMenu() {
        const menu = $('ccCurriculumRowActions');
        const trigger = menu?.__ccTrigger;
        if (!menu || !trigger || !menu.isConnected) return;

        const triggerRect = trigger.getBoundingClientRect();
        const viewportGap = 8;
        const triggerGap = 6;
        menu.style.top = `${Math.round(triggerRect.bottom + triggerGap)}px`;
        menu.style.left = `${viewportGap}px`;

        const menuRect = menu.getBoundingClientRect();
        const maxLeft = Math.max(viewportGap, window.innerWidth - menuRect.width - viewportGap);
        const left = Math.min(Math.max(viewportGap, triggerRect.right - menuRect.width), maxLeft);
        let top = triggerRect.bottom + triggerGap;
        if (top + menuRect.height > window.innerHeight - viewportGap
            && triggerRect.top - triggerGap - menuRect.height >= viewportGap) {
            top = triggerRect.top - triggerGap - menuRect.height;
        }
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
    }

    function scheduleCurriculumRowActionMenuPosition() {
        if (curriculumRowActionMenuFrame !== null) return;
        curriculumRowActionMenuFrame = window.requestAnimationFrame(() => {
            curriculumRowActionMenuFrame = null;
            positionCurriculumRowActionMenu();
        });
    }

    function openCurriculumRowActionMenu(row, trigger, event = {}) {
        if (!row) return;

        const sourceButtons = [...row.querySelectorAll('.mf-row-action-source button[data-action]')];
        if (!sourceButtons.length) return;

        // Close a menu created by the shared archive script before opening the
        // page-owned menu, so two action surfaces cannot overlap.
        document.getElementById('mfContextMenu')?.remove();
        closeCurriculumRowActionMenu();

        const menu = document.createElement('div');
        menu.id = 'ccCurriculumRowActions';
        menu.className = 'cc-row-action-menu';
        menu.setAttribute('role', 'menu');
        menu.__ccTrigger = trigger || row.querySelector('.mf-record-value') || row;

        sourceButtons.forEach(source => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'cc-row-action-menu-item';
            item.setAttribute('role', 'menuitem');
            const actionKey = String(source.dataset.action || '').toLowerCase();
            const labels = { add: 'Add subjects', view: 'View subjects', edit: 'Edit subjects', delete: 'Archive subjects' };
            const icons = { add: 'fa-book-medical', view: 'fa-eye', edit: 'fa-pen', delete: 'fa-box-archive' };
            const icon = document.createElement('i');
            icon.className = `fas ${icons[actionKey] || 'fa-arrow-right'}`;
            icon.setAttribute('aria-hidden', 'true');
            const text = document.createElement('span');
            text.textContent = labels[actionKey] || source.getAttribute('aria-label') || source.title || 'Action';
            item.append(icon, text);
            item.addEventListener('click', () => {
                closeCurriculumRowActionMenu();
                source.click();
            });
            menu.appendChild(item);
        });

        document.body.appendChild(menu);
        if (trigger) trigger.setAttribute('aria-expanded', 'true');
        positionCurriculumRowActionMenu();
        window.requestAnimationFrame(() => {
            positionCurriculumRowActionMenu();
            menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
        });
    }

    function openSubjectRowActions(row, event = {}, trigger = null) {
        if (!row) return;
        const value = trigger || row.querySelector('.mf-record-value, .cc-year-subject-list-name') || row;
        if (typeof window.mfOpenContextMenu === 'function') {
            const rect = value.getBoundingClientRect?.() || row.getBoundingClientRect?.() || { left: 16, top: 16, width: 0, height: 0, bottom: 58 };
            window.mfOpenContextMenu({
                clientX: Number(event.clientX) || rect.left + (rect.width / 2),
                clientY: Number(event.clientY) || rect.bottom || rect.top + 32
            }, row);
            return;
        }
        openCurriculumRowActionMenu(row, value, event);
    }

    function renderSubjects() {
        const tbody = $('cc-subjects-table-body');
        if (!tbody) return;

        // Keep the main Subjects panel at the grade-level summary. Passing
        // marks and assignment changes are edited in the focused grade-level
        // dialog, so the table never falls back to the dense detail layout.
        state.selectedGradeFilter = 'all';
        setSubjectsTableMode('summary');
        if (!state.curriculumId) {
            tbody.innerHTML = '<tr><td colspan="2" class="text-center py-4 text-muted"><i class="fas fa-arrow-up" aria-hidden="true"></i> Choose a curriculum from the card above to load subject assignments.</td></tr>';
            return;
        }
        if (state.refs.gradeLevels.length === 0) {
            tbody.innerHTML = '<tr><td colspan="2" class="text-center py-4 text-muted"><i class="fas fa-exclamation-circle me-1"></i> No grade levels are available.</td></tr>';
            return;
        }

        const summaryRows = state.refs.gradeLevels.map((grade) => ({
            gradeLevelId: Number(grade.grade_level_id),
            gradeName: grade.grade_name || 'Unknown Grade',
            subjectCount: getDisplaySubjectRows(getSubjectsForGrade(grade.grade_level_id)).length
        }));

        tbody.innerHTML = summaryRows.map((row) => `
            <tr class="mf-record-row cc-subject-record cc-year-subject-row" data-cc-year-subject-row data-grade-level-id="${row.gradeLevelId}">
                <td><div class="mf-record-value cc-year-level-value" tabindex="0" aria-label="Show actions for ${esc(row.gradeName)}">
                    <span class="cc-grade-chip">${esc(row.gradeName)}</span>
                </div></td>
                <td><div class="mf-record-value cc-year-subjects-value">
                    <span class="cc-year-subject-summary"><strong class="cc-year-subject-count">${row.subjectCount}</strong> <span class="cc-year-subject-count-label">subject${row.subjectCount !== 1 ? 's' : ''}</span></span>
                    <button type="button" class="mf-mobile-action-toggle" data-cc-mobile-actions-toggle aria-expanded="false" aria-haspopup="menu" aria-label="Show actions" title="Show actions"><i class="fas fa-ellipsis-vertical" aria-hidden="true"></i></button>
                </div><div class="mf-row-action-source" hidden>
                    <button type="button" data-action="add" data-cc-subject-action="add-subjects" data-grade="${row.gradeLevelId}" title="Add subjects" aria-label="Add subjects">Add subjects</button>
                    <button type="button" data-action="view" data-cc-subject-action="view-group" data-grade="${row.gradeLevelId}" title="View subjects" aria-label="View subjects">View subjects</button>
                    <button type="button" data-action="edit" data-cc-subject-action="edit-group" data-grade="${row.gradeLevelId}" title="Edit subjects" aria-label="Edit subjects">Edit subjects</button>
                </div></td>
            </tr>
        `).join('');
    }

    function getModalAvailableSubjects() {
        const query = String(state.modalSubjectSearch || '').toLowerCase().trim();
        return visibleCurriculumSubjects()
            .filter((subject) => {
                const subjectId = Number(subject.subject_id || 0);
                if (!subjectId) return false;
                // MAPEH is offered below as a single parent choice. Its stored
                // parent/component rows are expanded only when the flow saves.
                if (isMapehRelatedSubjectId(subjectId)) return false;
                if (isSubjectAssignedToModalGrade(subjectId)) return false;
                if (!query) return true;
                return String(subject.subject_name || '').toLowerCase().includes(query);
            })
            .sort((a, b) => {
                const categoryOrder = subjectCategorySortValue(getSubjectCategoryForSubject(a)) - subjectCategorySortValue(getSubjectCategoryForSubject(b));
                return categoryOrder || String(a.subject_name || '').localeCompare(String(b.subject_name || ''));
            });
    }

    function isSubjectAssignedToModalGrade(subjectId) {
        const gradeLevelId = Number(state.modalTargetGradeId || 0);
        return Boolean(gradeLevelId) && state.subjectRows.some(row =>
            Number(row.grade_level_id) === gradeLevelId && Number(row.subject_id) === Number(subjectId)
        );
    }

    function getModalSelectableSubjects() {
        return getModalAvailableSubjects().filter(subject => !isSubjectAssignedToModalGrade(subject.subject_id));
    }

    function getModalMapehPresetChoices() {
        const gradeLevelId = Number(state.modalTargetGradeId || 0);
        if (!gradeLevelId || getGradeMapehState(gradeLevelId).hasAny) return [];
        return [
            {
                type: 'fixed',
                label: 'MAPEH (Parent)',
                description: 'Fixed setup: Music and Arts + Physical Education and Health.'
            }
        ];
    }

    function updateModalSelectedCount() {
        const countEl = $('cc-selected-subject-count');
        const saveBtn = $('ccAddSubjectModalSave');
        const modal = $('ccAddSubjectModal');
        const hasUnsaved = hasUnsavedAddSubjectChanges();
        const standardCount = Array.from(state.modalSelectedSubjectIds)
            .filter(subjectId => !isMapehRelatedSubjectId(subjectId)).length;
        const count = standardCount + (state.modalMapehPreset ? 1 : 0);
        if (state.modalSelectionMode && count === 0) state.modalSelectionMode = false;
        modal?.classList.toggle('cc-selection-mode', state.modalSelectionMode);
        if (countEl) countEl.textContent = `${count} selected`;
        modal?.classList.toggle('cc-has-unsaved', hasUnsaved);
        countEl?.classList.toggle('cc-count-unsaved', hasUnsaved);
        if (saveBtn) saveBtn.disabled = count === 0;
    }

    function updateModalSelectAllState() {
        const selectAll = $('cc-select-all-subjects');
        if (!selectAll) return;

        const visibleSubjectIds = getModalSelectableSubjects()
            .map(subject => Number(subject.subject_id || 0))
            .filter(Boolean);
        const selectedVisibleCount = visibleSubjectIds.filter(subjectId => state.modalSelectedSubjectIds.has(subjectId)).length;
        const hasVisibleSubjects = visibleSubjectIds.length > 0;

        selectAll.checked = hasVisibleSubjects && selectedVisibleCount === visibleSubjectIds.length;
        selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleSubjectIds.length;
        selectAll.disabled = !hasVisibleSubjects;
    }

    function getPassingMarkValue(value, fallback = DEFAULT_PASSING_MARK) {
        if (value === null || value === undefined || String(value).trim() === '') return fallback;
        const mark = Number(value);
        return Number.isFinite(mark) ? mark : fallback;
    }

    function isValidPassingMark(value) {
        const mark = Number(value);
        return String(value ?? '').trim() !== '' && Number.isFinite(mark) && mark >= 0 && mark <= 100;
    }

    function defaultMeetingMinutesForGrade(gradeLevelId) {
        const gradeName = gradeDisplayName(gradeLevelId);
        if (/^Grade\s+(1|2)$/i.test(gradeName)) return 40;
        if (/^Grade\s+(3|4|5|6|7|8|9|10)$/i.test(gradeName)) return 45;
        return '';
    }

    function getModalMeetingMinutesValue(subjectKey) {
        const key = String(subjectKey);
        if (!state.modalSubjectMeetingMinutes.has(key)) {
            state.modalSubjectMeetingMinutes.set(key, defaultMeetingMinutesForGrade(state.modalTargetGradeId));
        }
        const value = state.modalSubjectMeetingMinutes.get(key);
        return value === null || value === undefined ? '' : value;
    }

    function isValidMeetingMinutes(value) {
        const text = String(value ?? '').trim();
        if (text === '') return true;
        const minutes = Number(value);
        return Number.isInteger(minutes) && minutes >= 1 && minutes <= 600;
    }

    function renderMapehPresetChoice(choice) {
        const isSelected = state.modalMapehPreset === choice.type;
        const isDisabled = Boolean(state.modalMapehPreset && !isSelected);
        const checkboxId = 'cc-mapeh-preset-' + choice.type;
        const mark = getPassingMarkValue(state.modalMapehPassingMarks.get(choice.type));
        const meetingMinutes = isSelected
            ? getModalMeetingMinutesValue(choice.type)
            : defaultMeetingMinutesForGrade(state.modalTargetGradeId);
        return '<div class="cc-subject-choice cc-mapeh-parent-choice' + (isSelected ? ' is-selected' : '') + (isDisabled ? ' is-disabled' : '') + '">' +
            '<input id="' + checkboxId + '" class="cc-subject-checkbox" type="checkbox" data-cc-mapeh-preset="' + choice.type + '"' + (isSelected ? ' checked' : '') + (isDisabled ? ' disabled' : '') + '>' +
            '<label class="cc-subject-choice-body" for="' + checkboxId + '">' +
                '<span class="cc-subject-choice-title">' + esc(choice.label) + '</span>' +
                '<span class="cc-subject-choice-desc">' + esc(choice.description) + '</span>' +
            '</label>' +
            '<div class="cc-subject-mark-field"><input class="form-control cc-subject-passing-input" type="number" min="0" max="100" step="0.01" value="' + mark + '" data-cc-mapeh-preset-mark="' + choice.type + '" aria-label="Passing mark for ' + esc(choice.label) + '"' + (isSelected ? '' : ' disabled') + '></div>' +
            '<div class="cc-subject-time-field"><input class="form-control cc-subject-time-input" type="number" min="1" max="600" step="1" value="' + meetingMinutes + '" data-cc-mapeh-preset-time="' + choice.type + '" aria-label="Daily instructional minutes for ' + esc(choice.label) + '" placeholder="—"' + (isSelected ? '' : ' disabled') + '></div>' +
        '</div>';
    }

    function renderSubjectChoice(subject) {
        const subjectId = Number(subject.subject_id || 0);
        const isSelected = state.modalSelectedSubjectIds.has(subjectId);
        if (isSelected && !state.modalSubjectPassingMarks.has(subjectId)) {
            state.modalSubjectPassingMarks.set(subjectId, DEFAULT_PASSING_MARK);
        }
        const checkboxId = 'cc-subject-choice-' + subjectId;
        const passingMark = getPassingMarkValue(state.modalSubjectPassingMarks.get(subjectId));
        const meetingMinutes = isSelected
            ? getModalMeetingMinutesValue(subjectId)
            : defaultMeetingMinutesForGrade(state.modalTargetGradeId);
        return '<div class="cc-subject-choice' + (isSelected ? ' is-selected' : '') + '">' +
            '<input id="' + checkboxId + '" class="cc-subject-checkbox" type="checkbox" value="' + subjectId + '"' + (isSelected ? ' checked' : '') + '>' +
            '<label class="cc-subject-choice-body" for="' + checkboxId + '">' +
                '<span class="cc-subject-choice-title">' + esc(subject.subject_name || '') + '</span>' +
            '</label>' +
            '<div class="cc-subject-mark-field"><input id="cc-subject-passing-mark-' + subjectId + '" class="form-control cc-subject-passing-input" type="number" min="0" max="100" step="0.01" value="' + passingMark + '" data-cc-passing-mark="' + subjectId + '" aria-label="Passing mark for ' + esc(subject.subject_name || '') + '"' + (isSelected ? '' : ' disabled') + '></div>' +
            '<div class="cc-subject-time-field"><input id="cc-subject-meeting-minutes-' + subjectId + '" class="form-control cc-subject-time-input" type="number" min="1" max="600" step="1" value="' + meetingMinutes + '" data-cc-meeting-minutes="' + subjectId + '" aria-label="Daily instructional minutes for ' + esc(subject.subject_name || '') + '" placeholder="—"' + (isSelected ? '' : ' disabled') + '></div>' +
        '</div>';
    }

    function renderSubjectCategorySections(subjects, mapehChoices) {
        const sections = new Map();
        const addToSection = (category, markup) => {
            const key = String(category?.subject_category_id || category?.category_code || 'uncategorized');
            if (!sections.has(key)) sections.set(key, { category, markup: [] });
            sections.get(key).markup.push(markup);
        };

        subjects.forEach(subject => addToSection(getSubjectCategoryForSubject(subject), renderSubjectChoice(subject)));
        if (mapehChoices.length) {
            const specialized = getSubjectCategoryByCode('SPECIALIZED_MULTIDISCIPLINARY') || {
                category_code: 'SPECIALIZED_MULTIDISCIPLINARY',
                category_name: 'Specialized / Multidisciplinary Areas',
                sort_order: 3
            };
            mapehChoices.forEach(choice => addToSection(specialized, renderMapehPresetChoice(choice)));
        }

        return [...sections.values()]
            .sort((a, b) => subjectCategorySortValue(a.category) - subjectCategorySortValue(b.category))
            .map(section => subjectCategoryDivider(section.category) + section.markup.join(''))
            .join('');
    }

    function toggleModalSubjectSelectionFromRow(choice) {
        const checkbox = choice?.querySelector('.cc-subject-checkbox');
        if (!checkbox || checkbox.disabled) return;

        state.modalSelectionMode = true;
        $('ccAddSubjectModal')?.classList.add('cc-selection-mode');
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function organizeRenderedSubjectChoices(list, subjects) {
        const subjectById = new Map(subjects.map(subject => [Number(subject.subject_id), subject]));
        const specialized = getSubjectCategoryByCode('SPECIALIZED_MULTIDISCIPLINARY') || {
            category_code: 'SPECIALIZED_MULTIDISCIPLINARY',
            category_name: 'Specialized / Multidisciplinary Areas',
            sort_order: 3
        };
        const groups = new Map();
        const choices = [...list.querySelectorAll('.cc-subject-choice')];
        choices.forEach(choice => {
            const preset = choice.querySelector('[data-cc-mapeh-preset]');
            const subjectId = Number(choice.querySelector('.cc-subject-checkbox')?.value || 0);
            const category = preset ? specialized : getSubjectCategoryForSubject(subjectById.get(subjectId));
            const key = String(category?.subject_category_id || category?.category_code || 'uncategorized');
            if (!groups.has(key)) groups.set(key, { category, choices: [] });
            groups.get(key).choices.push(choice);
        });

        list.querySelectorAll('.cc-subject-checklist-section-label').forEach(label => label.remove());
        choices.forEach(choice => choice.remove());
        const fragment = document.createDocumentFragment();
        [...groups.values()]
            .sort((a, b) => subjectCategorySortValue(a.category) - subjectCategorySortValue(b.category))
            .forEach(group => {
                const divider = document.createElement('div');
                divider.className = 'cc-subject-checklist-section-label cc-subject-category-divider';
                divider.dataset.subjectCategory = String(group.category?.category_code || '');
                divider.textContent = group.category?.category_name || 'Uncategorized';
                fragment.appendChild(divider);
                group.choices.forEach(choice => fragment.appendChild(choice));
            });
        list.appendChild(fragment);
    }

    function renderModalSubjectList() {
        const list = $('cc-modal-subject-list');
        if (!list) return;

        if (!list.dataset.ccSelectionInteractionsWired) {
            list.dataset.ccSelectionInteractionsWired = 'true';
            list.addEventListener('click', (event) => {
                const choice = event.target.closest('.cc-subject-choice');
                if (!choice || event.target.closest('input, button, select, textarea, a')) return;
                event.preventDefault();
                event.stopPropagation();
                toggleModalSubjectSelectionFromRow(choice);
            });
        }

        const subjects = getModalAvailableSubjects();
        const mapehChoices = getModalMapehPresetChoices();
        if (!subjects.length && !mapehChoices.length) {
            list.innerHTML = `
                <div class="cc-subject-checklist-empty">
                    <i class="fas fa-folder-open"></i>
                    <span>No available subjects for this year level.</span>
                </div>
            `;
            updateModalSelectedCount();
            return;
        }

        list.innerHTML = `
            <div class="cc-subject-checklist-header">
                <label class="cc-checklist-select-all">
                    <input type="checkbox" id="cc-select-all-subjects" aria-label="Select all visible subjects">
                    <span>Select all</span>
                    <span id="cc-selected-subject-count" class="cc-selected-subject-count" aria-live="polite">0 selected</span>
                </label>
                <span>Subject</span>
                <span class="cc-passing-mark-heading">Passing mark</span>
                <span class="cc-meeting-min-heading">Daily min</span>
            </div>
            ${mapehChoices.length ? `
                <div class="cc-subject-checklist-section-label">Fixed MAPEH setup</div>
                ${mapehChoices.map((choice) => {
                    const isSelected = state.modalMapehPreset === choice.type;
                    const isDisabled = Boolean(state.modalMapehPreset && !isSelected);
                    const checkboxId = `cc-mapeh-preset-${choice.type}`;
                    const mark = getPassingMarkValue(state.modalMapehPassingMarks.get(choice.type));
                    const meetingMinutes = isSelected
                        ? getModalMeetingMinutesValue(choice.type)
                        : defaultMeetingMinutesForGrade(state.modalTargetGradeId);
                    return `
                        <div class="cc-subject-choice cc-mapeh-parent-choice${isSelected ? ' is-selected' : ''}${isDisabled ? ' is-disabled' : ''}">
                            <input id="${checkboxId}" class="cc-subject-checkbox" type="checkbox" data-cc-mapeh-preset="${choice.type}" ${isSelected ? 'checked' : ''}${isDisabled ? ' disabled' : ''}>
                            <label class="cc-subject-choice-body" for="${checkboxId}">
                                <span class="cc-subject-choice-title">${choice.label}</span>
                                <span class="cc-subject-choice-desc">${choice.description}</span>
                            </label>
                            <div class="cc-subject-mark-field">
                                <input class="form-control cc-subject-passing-input" type="number" min="0" max="100" step="0.01" value="${mark}" data-cc-mapeh-preset-mark="${choice.type}" aria-label="Passing mark for ${choice.label}"${isSelected ? '' : ' disabled'}>
                            </div>
                            <div class="cc-subject-time-field">
                                <input class="form-control cc-subject-time-input" type="number" min="1" max="600" step="1" value="${meetingMinutes}" data-cc-mapeh-preset-time="${choice.type}" aria-label="Daily instructional minutes for ${choice.label}" placeholder="—"${isSelected ? '' : ' disabled'}>
                            </div>
                        </div>
                    `;
                }).join('')}
            ` : ''}
            ${subjects.map((subject) => {
            const subjectId = Number(subject.subject_id || 0);
            const isSelected = state.modalSelectedSubjectIds.has(subjectId);
            if (isSelected && !state.modalSubjectPassingMarks.has(subjectId)) {
                state.modalSubjectPassingMarks.set(subjectId, DEFAULT_PASSING_MARK);
            }
            const checked = isSelected ? 'checked' : '';
            const selectedClass = isSelected ? ' is-selected' : '';
            const checkboxId = `cc-subject-choice-${subjectId}`;
            const passingMark = getPassingMarkValue(state.modalSubjectPassingMarks.get(subjectId));
            const meetingMinutes = isSelected
                ? getModalMeetingMinutesValue(subjectId)
                : defaultMeetingMinutesForGrade(state.modalTargetGradeId);
            return `
                <div class="cc-subject-choice${selectedClass}">
                    <input id="${checkboxId}" class="cc-subject-checkbox" type="checkbox" value="${subjectId}" ${checked}>
                    <label class="cc-subject-choice-body" for="${checkboxId}">
                        <span class="cc-subject-choice-title">${esc(subject.subject_name || '')}</span>
                    </label>
                    <div class="cc-subject-mark-field">
                        <input id="cc-subject-passing-mark-${subjectId}" class="form-control cc-subject-passing-input" type="number" min="0" max="100" step="0.01" value="${passingMark}" data-cc-passing-mark="${subjectId}" aria-label="Passing mark for ${esc(subject.subject_name || '')}"${isSelected ? '' : ' disabled'}>
                    </div>
                    <div class="cc-subject-time-field">
                        <input id="cc-subject-meeting-minutes-${subjectId}" class="form-control cc-subject-time-input" type="number" min="1" max="600" step="1" value="${meetingMinutes}" data-cc-meeting-minutes="${subjectId}" aria-label="Daily instructional minutes for ${esc(subject.subject_name || '')}" placeholder="—"${isSelected ? '' : ' disabled'}>
                    </div>
                </div>
            `;
        }).join('')}`;

        organizeRenderedSubjectChoices(list, subjects);
        list.querySelectorAll('.cc-subject-choice input[type="checkbox"]').forEach(input => {
            input.addEventListener('change', () => {
                const mapehType = input.dataset.ccMapehPreset;
                if (mapehType) {
                    if (input.checked) applyMapehPreset();
                    else removeMapehPreset();
                    return;
                }
                const subjectId = Number(input.value || 0);
                if (!subjectId) return;
                if (input.checked) {
                    state.modalSelectedSubjectIds.add(subjectId);
                    if (!state.modalSubjectPassingMarks.has(subjectId)) {
                        state.modalSubjectPassingMarks.set(subjectId, DEFAULT_PASSING_MARK);
                    }
                    if (!state.modalSubjectMeetingMinutes.has(String(subjectId))) {
                        state.modalSubjectMeetingMinutes.set(String(subjectId), defaultMeetingMinutesForGrade(state.modalTargetGradeId));
                    }
                } else {
                    state.modalSelectedSubjectIds.delete(subjectId);
                    state.modalSubjectPassingMarks.delete(subjectId);
                    state.modalSubjectMeetingMinutes.delete(String(subjectId));
                }
                input.closest('.cc-subject-choice')?.classList.toggle('is-selected', input.checked);
                const markInput = input.closest('.cc-subject-choice')?.querySelector('[data-cc-passing-mark]');
                if (markInput) markInput.disabled = !input.checked;
                const meetingInput = input.closest('.cc-subject-choice')?.querySelector('[data-cc-meeting-minutes]');
                if (meetingInput) meetingInput.disabled = !input.checked;
                updateModalSelectAllState();
                updateModalSelectedCount();
            });
        });
        $('cc-select-all-subjects')?.addEventListener('change', (event) => {
            const visibleSubjectIds = getModalSelectableSubjects()
                .map(subject => Number(subject.subject_id || 0))
                .filter(Boolean);

            visibleSubjectIds.forEach(subjectId => {
                if (event.target.checked) {
                    state.modalSelectedSubjectIds.add(subjectId);
                    if (!state.modalSubjectPassingMarks.has(subjectId)) {
                        state.modalSubjectPassingMarks.set(subjectId, DEFAULT_PASSING_MARK);
                    }
                    if (!state.modalSubjectMeetingMinutes.has(String(subjectId))) {
                        state.modalSubjectMeetingMinutes.set(String(subjectId), defaultMeetingMinutesForGrade(state.modalTargetGradeId));
                    }
                } else {
                    state.modalSelectedSubjectIds.delete(subjectId);
                    state.modalSubjectPassingMarks.delete(subjectId);
                    state.modalSubjectMeetingMinutes.delete(String(subjectId));
                }
            });
            renderModalSubjectList();
        });
        list.querySelectorAll('[data-cc-passing-mark]').forEach(input => {
            input.addEventListener('input', () => {
                const subjectId = Number(input.dataset.ccPassingMark || 0);
                if (subjectId) state.modalSubjectPassingMarks.set(subjectId, input.value);
                updateModalSelectedCount();
            });
        });
        list.querySelectorAll('[data-cc-meeting-minutes]').forEach(input => {
            input.addEventListener('input', () => {
                const subjectId = Number(input.dataset.ccMeetingMinutes || 0);
                if (subjectId) state.modalSubjectMeetingMinutes.set(String(subjectId), input.value);
                updateModalSelectedCount();
            });
        });
        list.querySelectorAll('[data-cc-mapeh-preset-mark]').forEach(input => {
            input.addEventListener('input', () => {
                const type = input.dataset.ccMapehPresetMark;
                if (!type) return;
                state.modalMapehPassingMarks.set(type, input.value);
                state.modalMapehSubjectIds.forEach(subjectId => {
                    if (state.modalSelectedSubjectIds.has(subjectId)) {
                        state.modalSubjectPassingMarks.set(subjectId, input.value);
                    }
                });
                updateModalSelectedCount();
            });
        });
        list.querySelectorAll('[data-cc-mapeh-preset-time]').forEach(input => {
            input.addEventListener('input', () => {
                const type = input.dataset.ccMapehPresetTime;
                if (!type) return;
                state.modalMapehSubjectIds.forEach(subjectId => {
                    if (state.modalSelectedSubjectIds.has(subjectId)) {
                        state.modalSubjectMeetingMinutes.set(String(subjectId), input.value);
                    }
                });
                updateModalSelectedCount();
            });
        });
        updateModalSelectAllState();
        updateModalSelectedCount();
    }

    function refreshModalHeaderDetail() {
        const detail = $('cc-modal-curriculum-detail');
        const gradeLevelId = Number(state.modalTargetGradeId || 0);
        if (detail) {
            detail.textContent = gradeLevelId
                ? gradeDisplayName(gradeLevelId)
                : 'Select a year level from the Subjects row first.';
        }
    }

    function openAddSubjectModal(gradeLevelId) {
        if (!state.curriculumId) {
            notify('Select a curriculum first.', 'error');
            return;
        }
        const targetGradeId = Number(gradeLevelId || 0);
        if (!targetGradeId) {
            notify('Choose a year level row first.', 'error');
            return;
        }
        if (!state.refs.gradeLevels.some(gl => Number(gl.grade_level_id) === targetGradeId)) {
            notify('Selected year level is unavailable.', 'error');
            return;
        }

        state.modalTargetGradeId = String(targetGradeId);
        clearAddSubjectSelection();
        if ($('cc-modal-subject-search')) $('cc-modal-subject-search').value = '';
        if ($('cc-new-subject-name')) $('cc-new-subject-name').value = '';
        $('cc-toggle-create-subject-btn')?.removeAttribute('hidden');
        $('ccAddSubjectModalCancel')?.removeAttribute('hidden');
        $('ccAddSubjectModalSave')?.removeAttribute('hidden');
        refreshModalHeaderDetail();
        renderModalSubjectList();

        openModal('ccAddSubjectModal');
        window.requestAnimationFrame(() => $('cc-modal-subject-search')?.focus({ preventScroll: true }));
    }

    async function saveAddSubjectModal() {
        const gradeLevelId = Number(state.modalTargetGradeId || 0);
        const subjectIds = Array.from(state.modalSelectedSubjectIds).map(Number).filter(Boolean);
        const saveButton = $('ccAddSubjectModalSave');

        if (!gradeLevelId) {
            notify('Select a grade level.', 'error');
            return;
        }
        if (!subjectIds.length) {
            notify('Select at least one subject to add.', 'error');
            return;
        }
        if (!validateMapehSelectionForGrade(gradeLevelId, subjectIds)) return;

        const invalidMark = subjectIds.find(subjectId => !isValidPassingMark(state.modalSubjectPassingMarks.get(subjectId)));
        if (invalidMark) {
            notify(`Enter a passing mark from 0 to 100 for ${subjectDisplayName(invalidMark)}.`, 'error');
            return;
        }

        const invalidMeetingMinutes = subjectIds.find(subjectId => !isValidMeetingMinutes(getModalMeetingMinutesValue(subjectId)));
        if (invalidMeetingMinutes) {
            notify(`Enter class meeting minutes from 1 to 600 for ${subjectDisplayName(invalidMeetingMinutes)}.`, 'error');
            return;
        }

        const addedRows = [];
        for (const subjectId of subjectIds) {
            const exists = state.subjectRows.some(s => Number(s.grade_level_id) === gradeLevelId && Number(s.subject_id) === subjectId);
            if (exists) continue;
            const row = {
                grade_level_id: gradeLevelId,
                subject_id: subjectId,
                passing_mark: getPassingMarkValue(state.modalSubjectPassingMarks.get(subjectId)),
                weekly_minutes: getModalMeetingMinutesValue(subjectId) === '' ? null : Number(getModalMeetingMinutesValue(subjectId)),
                meeting_minutes: getModalMeetingMinutesValue(subjectId) === '' ? null : Number(getModalMeetingMinutesValue(subjectId)),
                meetings_per_week: null,
                notes: null
            };
            state.subjectRows.push(row);
            addedRows.push(row);
        }

        updateSubjectDraftState();

        if (!addedRows.length) {
            notify('No new subjects were selected for this year level.', 'error');
            return;
        }

        const originalButtonMarkup = saveButton?.innerHTML || '';
        if (saveButton) {
            saveButton.disabled = true;
            saveButton.innerHTML = '<i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i> Saving...';
        }

        try {
            await saveSubjects({
                successMessage: `${addedRows.length} subject${addedRows.length === 1 ? '' : 's'} saved.`,
                activeTab: 'subjects'
            });
            resetAddSubjectDraft();
            closeModal('ccAddSubjectModal');
        } catch (err) {
            const addedKeys = new Set(addedRows.map(row => `${row.grade_level_id}-${row.subject_id}`));
            state.subjectRows = state.subjectRows.filter(row => !addedKeys.has(`${row.grade_level_id}-${row.subject_id}`));
            updateSubjectDraftState();
            renderSubjects();
            notify(err?.response?.data?.message || err?.message || 'Subjects could not be saved.', 'error');
        } finally {
            if (saveButton) {
                saveButton.disabled = false;
                saveButton.innerHTML = originalButtonMarkup;
            }
        }
    }

    async function quickCreateSubjectMaster() {
        const name = $('cc-new-subject-name')?.value?.trim();
        const categoryId = Number($('cc-new-subject-category')?.value || 0);
        const description = $('cc-new-subject-description')?.value?.trim() || '';

        if (!name) {
            notify('Subject name is required.', 'error');
            return;
        }
        if (name.length > 100) {
            notify('Subject name must be 100 characters or fewer.', 'error');
            return;
        }
        if (!categoryId) {
            notify('Choose a subject category.', 'error');
            return;
        }
        if (description.length > 255) {
            notify('Description must be 255 characters or fewer.', 'error');
            return;
        }
        const duplicate = state.refs.subjects.some(subject => normalizeSubjectName(subject.subject_name) === normalizeSubjectName(name));
        if (duplicate) {
            notify('Subject name already taken. Choose a different subject name.', 'error');
            return;
        }
        if (isMapehRelatedSubjectName(name)) {
            notify('MAPEH can only be added through its fixed parent and component setup.', 'error');
            return;
        }
        const res = await axios.post(`${api.subjects()}?operation=createSubject`, {
            subject_name: name,
            subject_category_id: categoryId,
            description
        });

        if (res.data?.success === false) {
            throw new Error(res.data?.message || 'Creation failed');
        }

        notify('Subject added.');
        await loadRefs();

        const createdId = Number(res.data?.subject_id || res.data?.data?.subject_id);
        if (createdId) {
            state.modalSelectedSubjectIds.add(createdId);
            state.modalSelectionMode = true;
        }
        renderModalSubjectList();

        resetNewSubjectMasterForm();
        closeModal('cc-new-subject-master-modal');
    }

    async function applyMapehPreset() {
        const gradeLevelId = Number(state.modalTargetGradeId || 0);
        const preset = MAPEH_FIXED_SUBJECTS;
        if (!gradeLevelId) {
            notify('Select a grade level first.', 'error');
            return;
        }
        if (!preset.length) return;
        if (getGradeMapehState(gradeLevelId).hasAny) {
            notify(getMapehConflictMessage(gradeLevelId), 'error');
            return;
        }

        const presetInput = document.querySelector('[data-cc-mapeh-preset="fixed"]');
        if (presetInput) presetInput.disabled = true;

        try {
            const subjectIds = [];
            for (const subjectName of preset) {
                subjectIds.push(await getOrCreateSubjectMaster(subjectName));
            }

            for (const subjectId of subjectIds) {
                if (!subjectId) continue;
                state.modalSelectedSubjectIds.add(subjectId);
            }
            state.modalMapehPreset = 'fixed';
            state.modalSelectionMode = true;
            state.modalMapehSubjectIds = new Set(subjectIds);
            const passingMark = getPassingMarkValue(state.modalMapehPassingMarks.get('fixed'));
            const meetingMinutes = defaultMeetingMinutesForGrade(gradeLevelId);
            subjectIds.forEach(subjectId => state.modalSubjectPassingMarks.set(subjectId, passingMark));
            subjectIds.forEach(subjectId => state.modalSubjectMeetingMinutes.set(String(subjectId), meetingMinutes));
            renderModalSubjectList();
            updateModalSelectedCount();
            notify('Fixed MAPEH parent setup selected. Click Add selected to save it.');
        } catch (err) {
            notify(err?.response?.data?.message || err?.message || 'Failed to apply MAPEH setup', 'error');
        } finally {
            if (presetInput?.isConnected) presetInput.disabled = false;
        }
    }

    function removeMapehPreset() {
        if (state.modalMapehPreset !== 'fixed') return;
        state.modalMapehSubjectIds.forEach(subjectId => {
            state.modalSelectedSubjectIds.delete(subjectId);
            state.modalSubjectPassingMarks.delete(subjectId);
            state.modalSubjectMeetingMinutes.delete(String(subjectId));
        });
        state.modalMapehPreset = null;
        state.modalMapehSubjectIds = new Set();
        state.modalMapehPassingMarks.delete('fixed');
        renderModalSubjectList();
    }

    /* ═══ Save helpers ═══ */

    async function saveSubjects(options = {}) {
        const seen = new Set();
        const rows = [];
        const marks = [];
        const rowsByGrade = new Map();
        state.subjectRows.forEach(row => {
            const gradeLevelId = Number(row?.grade_level_id || 0);
            if (!gradeLevelId) return;
            if (!rowsByGrade.has(gradeLevelId)) rowsByGrade.set(gradeLevelId, []);
            rowsByGrade.get(gradeLevelId).push(row);
        });
        const orderedSubjectRows = [...rowsByGrade.entries()]
            .sort(([gradeA], [gradeB]) => gradeA - gradeB)
            .flatMap(([, gradeRows]) => gradeRows.map((row, index) => ({
                ...row,
                sort_order: index + 1
            })));

        orderedSubjectRows.forEach(r => {
            const gid = Number(r.grade_level_id);
            const sid = Number(r.subject_id);
            if (!gid || !sid) return;
            if (!isValidPassingMark(r.passing_mark)) {
                throw new Error(`Enter a passing mark from 0 to 100 for ${subjectDisplayName(sid)}.`);
            }
            const meetingMinutes = getMeetingMinutesValue(r);
            if (meetingMinutes !== '' && (!Number.isInteger(Number(meetingMinutes)) || Number(meetingMinutes) < 1 || Number(meetingMinutes) > 600)) {
                throw new Error(`Enter class meeting minutes from 1 to 600 for ${subjectDisplayName(sid)}.`);
            }
            const key = `${gid}-${sid}`;
            if (!seen.has(key)) {
                seen.add(key);
                rows.push({
                    grade_level_id: gid,
                    subject_id: sid,
                    sort_order: r.sort_order,
                    weekly_minutes: getMeetingMinutesValue(r) === '' ? null : Number(getMeetingMinutesValue(r)),
                    meeting_minutes: getMeetingMinutesValue(r) === '' ? null : Number(getMeetingMinutesValue(r)),
                    meetings_per_week: r.meetings_per_week === '' || r.meetings_per_week === null || r.meetings_per_week === undefined
                        ? null
                        : Number(r.meetings_per_week),
                    notes: r.notes || null
                });
                marks.push({
                    grade_level_id: gid,
                    subject_id: sid,
                    passing_mark: Number(r.passing_mark),
                    notes: r.notes || null
                });
            }
        });

        const res = await axios.post(`${api.curricula()}?operation=saveCurriculumSubjects`, {
            curriculum_id: state.curriculumId,
            subjects: rows,
            passing_marks: marks
        });
        if (res.data?.success === false) throw new Error(res.data?.message || 'Save failed');
        const savedCurriculumId = Number(res.data?.curriculum_id || state.curriculumId);
        const detachedFromHistorical = res.data?.detached_from_historical === true;
        if (savedCurriculumId && savedCurriculumId !== Number(state.curriculumId)) {
            state.curriculumId = savedCurriculumId;
            await loadRefs();
            syncCurriculumSelectValue(savedCurriculumId);
        }
        notify(detachedFromHistorical
            ? 'Active-year settings saved. Previous school-year records were preserved.'
            : (options.successMessage || 'Subjects and passing marks saved.'));
        await loadCurriculum(savedCurriculumId, {
            activeTab: options.activeTab || 'subjects',
            gradeFilter: 'all'
        });
    }

    function editSubjectGrade(gradeLevelId, subjectId = null) {
        document.querySelector('.cc-tab[data-tab="subjects"]')?.click();
        openYearSubjectsModal(gradeLevelId, 'edit');
        if (subjectId) {
            window.requestAnimationFrame(() => document.querySelector(`[data-cc-edit-passing-mark][data-grade="${gradeLevelId}"][data-subject="${subjectId}"], [data-cc-edit-mapeh-parent-mark][data-grade="${gradeLevelId}"][data-subject="${subjectId}"], [data-cc-edit-meeting-minutes][data-grade="${gradeLevelId}"][data-subject="${subjectId}"], [data-cc-edit-mapeh-parent-time][data-grade="${gradeLevelId}"][data-subject="${subjectId}"]`)?.focus({ preventScroll: true }));
        }
    }

    function removeSubjectFromEdit(gradeLevelId, subjectId) {
        const isMapeh = isMapehRelatedSubjectId(subjectId);
        const nextRows = state.modalEditRows.filter(row => {
            if (Number(row.grade_level_id) !== Number(gradeLevelId)) return true;
            if (isMapeh) return !isMapehRelatedSubjectId(row.subject_id);
            return Number(row.subject_id) !== Number(subjectId);
        });
        if (nextRows.length === state.modalEditRows.length) return;
        const subjectName = subjectDisplayName(subjectId);
        state.modalEditSelectedSubjectIds.delete(Number(subjectId));
        state.modalEditRows = nextRows;
        updateModalEditDraftState();
        renderYearSubjectsModalList('edit');
        notify(`${isMapeh ? 'MAPEH parent and components' : subjectName} removed from this edit. Save changes to apply.`);
    }

    function removeSelectedSubjectsFromEdit() {
        const selectedIds = new Set([...state.modalEditSelectedSubjectIds].map(Number));
        if (!selectedIds.size) {
            notify('Select at least one subject to remove.', 'error');
            return;
        }

        const gradeLevelId = Number(state.modalEditGradeLevelId || 0);
        const selectedRows = getModalEditDisplayRows().filter(row => selectedIds.has(Number(row.subject_id)));
        const nextRows = state.modalEditRows.filter(row => {
            if (Number(row.grade_level_id) !== gradeLevelId) return true;
            const subjectId = Number(row.subject_id);
            return ![...selectedIds].some(selectedId => selectedId === subjectId
                || (isMapehRelatedSubjectId(selectedId) && isMapehRelatedSubjectId(subjectId)));
        });

        state.modalEditSelectedSubjectIds = new Set();
        if (nextRows.length === state.modalEditRows.length) return;
        state.modalEditRows = nextRows;
        updateModalEditDraftState();
        renderYearSubjectsModalList('edit');
        notify(`${selectedRows.length} selected subject${selectedRows.length === 1 ? '' : 's'} removed from this edit. Save changes to apply.`);
    }

    async function saveYearSubjectsModal() {
        const gradeLevelId = Number(state.modalEditGradeLevelId || 0);
        if (!gradeLevelId) return;

        for (const row of state.modalEditRows) {
            if (!isValidPassingMark(row.passing_mark)) {
                notify(`Enter a passing mark from 0 to 100 for ${subjectDisplayName(row.subject_id)}.`, 'error');
                return;
            }
        }

        const otherRows = state.subjectRows.filter(row => Number(row.grade_level_id) !== gradeLevelId);
        state.subjectRows = [...otherRows, ...state.modalEditRows.map(row => ({ ...row }))];
        updateSubjectDraftState();
        await saveSubjects({
            successMessage: `${gradeDisplayName(gradeLevelId)} subjects updated.`,
            activeTab: 'subjects'
        });
        closeYearSubjectsModal();
    }

    async function archiveSubjectItem(gradeLevelId, subjectId) {
        const subjectName = subjectDisplayName(subjectId);
        const ok = await confirmDelete(`${subjectName} assignment`);
        if (!ok) return;
        const isMapeh = isMapehRelatedSubjectId(subjectId);
        state.subjectRows = state.subjectRows.filter(row => {
            if (Number(row.grade_level_id) !== Number(gradeLevelId)) return true;
            if (isMapeh) return !isMapehRelatedSubjectId(row.subject_id);
            return Number(row.subject_id) !== Number(subjectId);
        });
        updateSubjectDraftState();
        await saveSubjects({
            successMessage: `${isMapeh ? 'MAPEH parent and components' : subjectName} assignment archived.`,
            activeTab: 'subjects'
        });
    }

    /* ═══ Curriculum CRUD ═══ */

    function showCurriculumForm(mode, data = null) {
        const modal = $('cc-curriculum-modal');
        const form = $('cc-curriculum-form');
        if (!modal || !form) return;

        state.curriculumReturnFocus = mode === 'edit'
            ? $('cc-curriculum-info')
            : getCurriculumArchiveToggle() || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        $('cc-curriculum-form-title').textContent = mode === 'edit' ? 'Edit Curriculum' : 'Create Curriculum';
        $('cc-curriculum-id').value = mode === 'edit' ? data?.curriculum_id || '' : '';
        $('cc-curriculum-code').value = data?.curriculum_code || '';
        $('cc-curriculum-name').value = data?.curriculum_name || '';
        $('cc-curriculum-description').value = data?.description || '';
        $('cc-curriculum-effective-from').value = data?.effective_from || '';
        $('cc-curriculum-effective-until').value = data?.effective_until || '';
        $('cc-curriculum-status').value = !data || Number(data.is_active) !== 0 ? '1' : '0';
        if (!state.curriculumId) {
            $('cc-empty-state').style.display = 'none';
        }

        modal.classList.add('show');
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('modal-open');
        window.requestAnimationFrame(() => $('cc-curriculum-code')?.focus({ preventScroll: true }));
    }

    function hideCurriculumForm() {
        const modal = $('cc-curriculum-modal');
        if (modal) {
            modal.classList.remove('show');
            modal.style.display = 'none';
            modal.setAttribute('aria-hidden', 'true');
        }
        $('cc-curriculum-id').value = '';
        $('cc-curriculum-code').value = '';
        $('cc-curriculum-name').value = '';
        $('cc-curriculum-description').value = '';
        $('cc-curriculum-effective-from').value = '';
        $('cc-curriculum-effective-until').value = '';
        $('cc-curriculum-status').value = '1';
        if (!state.curriculumId) {
            $('cc-empty-state').style.display = '';
        }
        if (!state.activeModalId) document.body.classList.remove('modal-open');

        const returnFocus = state.curriculumReturnFocus;
        state.curriculumReturnFocus = null;
        window.requestAnimationFrame(() => returnFocus?.focus?.({ preventScroll: true }));
    }

    function getCurriculumFormData() {
        return {
            curriculum_id: $('cc-curriculum-id').value || null,
            curriculum_code: $('cc-curriculum-code').value.trim(),
            curriculum_name: $('cc-curriculum-name').value.trim(),
            description: $('cc-curriculum-description').value.trim() || null,
            effective_from: $('cc-curriculum-effective-from').value.trim(),
            effective_until: $('cc-curriculum-effective-until').value.trim() || null,
            is_active: Number($('cc-curriculum-status').value)
        };
    }

    async function saveCurriculum() {
        const data = getCurriculumFormData();
        if (!data.curriculum_code || !data.curriculum_name || !data.effective_from) {
            notify('Code, name, and effective from year are required.', 'error');
            return;
        }

        const isEdit = !!data.curriculum_id;
        const operation = isEdit ? 'updateCurriculum' : 'createCurriculum';
        const url = `${api.curricula()}?operation=${operation}`;
        const res = await axios.post(url, data);
        if (res.data?.success === false) throw new Error(res.data?.message || 'Save failed');

        notify(res.data?.detached_from_historical
            ? 'Active-year settings saved. Previous school-year records were preserved.'
            : `Curriculum ${isEdit ? 'updated' : 'created'}.`);
        hideCurriculumForm();

        // Refresh list and load the saved curriculum
        await loadRefs();
        const newId = isEdit
            ? Number(res.data?.curriculum_id || data.curriculum_id)
            : Number(res.data?.curriculum_id);
        if (newId) {
            syncCurriculumSelectValue(newId);
            await loadCurriculum(newId);
        }
    }

    async function deleteCurriculum() {
        if (!state.curriculumId) return;
        const ok = await confirmDelete('curriculum');
        if (!ok) return;
        const res = await axios.post(`${api.curricula()}?operation=archiveCurriculum`, {
            curriculum_id: state.curriculumId
        });
        if (res.data?.success === false) throw new Error(res.data?.message || 'Archive failed');
        notify('Curriculum archived.');
        state.curriculumId = null;
        state.curriculumData = null;
        await loadRefs();
    }

    /* ═══ Event delegation ═══ */

    function wireEvents() {
        window.addEventListener('beforeunload', (event) => {
            if (!hasUnsavedSubjectWork()) return;
            event.preventDefault();
            event.returnValue = '';
        });

        document.addEventListener('click', async (event) => {
            if (!hasUnsavedSubjectWork()) return;
            const link = event.target?.closest?.('a[href]');
            if (!link || link.hasAttribute('download') || link.target === '_blank') return;
            const href = String(link.getAttribute('href') || '');
            if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
            let destination;
            try {
                destination = new URL(link.href, window.location.href);
            } catch (_) {
                return;
            }
            if (destination.href === window.location.href) return;

            event.preventDefault();
            event.stopPropagation();
            if (await confirmDiscardSubjectWork()) window.location.href = link.href;
        }, true);

        document.addEventListener('keydown', (event) => {
            const editModalRow = event.target instanceof Element ? event.target.closest('[data-cc-edit-subject-row]') : null;
            if (editModalRow && (event.key === 'Enter' || event.key === ' ') && !event.target.closest('input, button')) {
                event.preventDefault();
                activateModalEditSelectionMode(editModalRow);
                return;
            }

            const subjectRow = event.target instanceof Element ? event.target.closest('[data-cc-subject-row], [data-cc-year-subject-row]') : null;
            if (subjectRow && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                openSubjectRowActions(subjectRow, event);
                return;
            }

            const openStepMenu = document.querySelector('.cc-step-menu.is-open');
            if (event.key === 'Escape' && openStepMenu) {
                event.preventDefault();
                const toggle = openStepMenu.querySelector('[data-cc-step-menu-toggle]');
                closeStepMenus();
                toggle?.focus({ preventScroll: true });
                return;
            }

            const curriculumMenu = $('mfArchiveOptionsMenu');
            if (event.key === 'Escape' && curriculumMenu?.classList.contains('is-open')) {
                event.preventDefault();
                closeCurriculumActionsMenu();
                getCurriculumArchiveToggle(curriculumMenu)?.focus({ preventScroll: true });
                return;
            }

            const curriculumModal = $('cc-curriculum-modal');
            if (curriculumModal?.classList.contains('show')) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    hideCurriculumForm();
                    closeCurriculumActionsMenu();
                    return;
                }

                if (event.key !== 'Tab') return;
                const focusable = getModalFocusableElements(curriculumModal);
                if (!focusable.length) {
                    event.preventDefault();
                    $('cc-curriculum-modal')?.focus();
                    return;
                }

                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                const activeInside = curriculumModal.contains(document.activeElement);
                if (event.shiftKey && (!activeInside || document.activeElement === first)) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && (!activeInside || document.activeElement === last)) {
                    event.preventDefault();
                    first.focus();
                }
                return;
            }

            const modal = state.activeModalId ? $(state.activeModalId) : null;
            if (!modal || !modal.classList.contains('show')) return;

            if (event.key === 'Escape') {
                event.preventDefault();
                if (state.activeModalId === 'ccAddSubjectModal') {
                    void requestCloseAddSubjectModal();
                } else if (state.activeModalId === 'cc-year-subject-modal') {
                    void requestCloseYearSubjectsModal();
                } else {
                    closeModal(state.activeModalId);
                }
                return;
            }

            if (event.key !== 'Tab') return;
            const focusable = getModalFocusableElements(modal);
            if (!focusable.length) {
                event.preventDefault();
                modal.focus();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const activeInside = modal.contains(document.activeElement);
            if (event.shiftKey && (!activeInside || document.activeElement === first)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (!activeInside || document.activeElement === last)) {
                event.preventDefault();
                first.focus();
            }
        });

        $('ccAddSubjectModal')?.addEventListener('click', (event) => {
            if (event.target === event.currentTarget) void requestCloseAddSubjectModal();
        });

        $('cc-year-subject-modal')?.addEventListener('click', (event) => {
            if (event.target === event.currentTarget) void requestCloseYearSubjectsModal();
        });
        wireModalSubjectReordering();

        $('cc-new-subject-master-modal')?.addEventListener('click', (event) => {
            if (event.target === event.currentTarget) closeModal('cc-new-subject-master-modal');
        });

        $('cc-year-subject-modal-close')?.addEventListener('click', () => void requestCloseYearSubjectsModal());
        $('cc-year-subject-modal-cancel')?.addEventListener('click', () => void requestCloseYearSubjectsModal());
        $('cc-year-subject-modal-save')?.addEventListener('click', async () => {
            try {
                await saveYearSubjectsModal();
            } catch (err) {
                notify(err?.response?.data?.message || err?.message || 'Failed to save subject changes', 'error');
            }
        });
        $('cc-year-subject-modal-remove-selected')?.addEventListener('click', removeSelectedSubjectsFromEdit);

        $('cc-curriculum-modal')?.addEventListener('click', (event) => {
            if (event.target === event.currentTarget) hideCurriculumForm();
        });

        $('cc-curriculum-modal-close')?.addEventListener('click', hideCurriculumForm);

        document.addEventListener('click', async (event) => {
            const option = event.target.closest('[data-cc-curriculum-action]');
            if (!option || option.disabled) return;
            event.preventDefault();
            event.stopPropagation();
            closeStepMenus();
            closeCurriculumActionsMenu();

            try {
                if (option.dataset.ccCurriculumAction === 'add-curriculum') {
                    showCurriculumForm('create');
                }
            } catch (err) {
                notify(err?.response?.data?.message || err?.message || 'Curriculum action failed', 'error');
            }
        });

        document.addEventListener('click', (event) => {
            const toggle = event.target.closest('[data-cc-step-menu-toggle]');
            if (toggle) {
                event.preventDefault();
                event.stopPropagation();
                const wrap = toggle.closest('.cc-step-menu');
                const menu = wrap?.querySelector('.cc-step-menu-panel');
                if (!wrap || !menu) return;
                const open = !wrap.classList.contains('is-open');
                closeStepMenus();
                if (!open) return;

                wrap.classList.add('is-open');
                toggle.setAttribute('aria-expanded', 'true');
                menu.hidden = false;
                menu.classList.add('is-open', 'is-anchored');

                // A fixed overlay must not remain inside the table/header
                // stacking or overflow context. Portal only while open; the
                // original DOM position is restored by closeStepMenus().
                const placeholder = document.createComment('cc-step-menu-position');
                menu.replaceWith(placeholder);
                menu.__ccStepMenuPlaceholder = placeholder;
                wrap.__ccStepMenu = menu;
                document.body.appendChild(menu);
                positionStepMenu(wrap);
                window.requestAnimationFrame(() => {
                    positionStepMenu(wrap);
                    menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
                });
                return;
            }

            const archiveOption = event.target.closest('[data-cc-open-archive]');
            if (archiveOption) {
                event.preventDefault();
                event.stopPropagation();
                closeStepMenus();
                document.getElementById('masterfileArchiveButton')?.click();
                return;
            }

            if (!event.target.closest('.cc-step-menu')) closeStepMenus();
        });

        window.addEventListener('resize', scheduleStepMenuPosition, { passive: true });
        document.addEventListener('scroll', scheduleStepMenuPosition, true);
        observeCurriculumArchiveMenu();

        const openCurriculumInfoActions = (event) => {
            const target = event.target instanceof Element ? event.target : null;
            const info = target?.closest('#cc-curriculum-info');
            if (!info || info.dataset.hasActions !== 'true' || target.closest('a, button, input, select, textarea, label')) return;
            if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            const rect = info.getBoundingClientRect();
            window.mfOpenContextMenu?.({
                clientX: event.clientX || rect.left + rect.width / 2,
                clientY: event.clientY || rect.top + rect.height / 2
            }, info);
        };
        document.addEventListener('click', openCurriculumInfoActions);
        document.addEventListener('contextmenu', openCurriculumInfoActions);
        document.addEventListener('keydown', openCurriculumInfoActions);

        document.addEventListener('click', async (event) => {
            const action = event.target.closest('[data-cc-curriculum-info-action]');
            if (!action) return;
            event.preventDefault();
            event.stopPropagation();
            try {
                if (action.dataset.ccCurriculumInfoAction === 'edit' && state.curriculumData) {
                    showCurriculumForm('edit', state.curriculumData);
                } else if (action.dataset.ccCurriculumInfoAction === 'archive') {
                    await deleteCurriculum();
                }
            } catch (err) {
                notify(err?.response?.data?.message || err?.message || 'Curriculum action failed', 'error');
            }
        });

        // Curriculum select
        $('curriculumSelect')?.addEventListener('change', async (e) => {
            try {
                if (!await confirmDiscardSubjectWork()) {
                    syncCurriculumSelectValue(state.curriculumId);
                    return;
                }
                await loadCurriculum(e.target.value);
            }
            catch (err) { notify(err?.response?.data?.message || err?.message || 'Failed to load', 'error'); }
        });

        // Curriculum form save / cancel
        $('cc-curriculum-form')?.addEventListener('submit', async (event) => {
            event.preventDefault();
            try {
                await saveCurriculum();
            } catch (err) {
                notify(err?.response?.data?.message || err?.message || 'Save failed', 'error');
            }
        });
        $('cc-cancel-curriculum-btn')?.addEventListener('click', hideCurriculumForm);

        // Subjects Tab Filter & Modal Event Listeners
        $('cc-modal-subject-search')?.addEventListener('input', (e) => {
            state.modalSubjectSearch = e.target.value || '';
            renderModalSubjectList();
        });

        $('ccAddSubjectModalSave')?.addEventListener('click', saveAddSubjectModal);

        $('cc-toggle-create-subject-btn')?.addEventListener('click', () => {
            resetNewSubjectMasterForm();
            openModal('cc-new-subject-master-modal');
        });

        $('cc-save-new-subject-master-btn')?.addEventListener('click', async () => {
            try {
                await quickCreateSubjectMaster();
            } catch (err) {
                notify(err?.response?.data?.message || err?.message || 'Failed to add subject', 'error');
            }
        });

        $('ccAddSubjectModalCloseX')?.addEventListener('click', () => void requestCloseAddSubjectModal());
        $('ccAddSubjectModalCancel')?.addEventListener('click', () => void requestCloseAddSubjectModal());
        $('cc-new-subject-master-close')?.addEventListener('click', () => closeModal('cc-new-subject-master-modal'));
        $('cc-new-subject-master-cancel')?.addEventListener('click', () => closeModal('cc-new-subject-master-modal'));

        document.addEventListener('change', (event) => {
            const selectAll = event.target.closest('#cc-edit-select-all');
            if (selectAll) {
                const ids = getModalEditDisplayRows().map(row => Number(row.subject_id)).filter(Boolean);
                state.modalEditSelectedSubjectIds = selectAll.checked ? new Set(ids) : new Set();
                document.querySelectorAll('#cc-year-subject-modal [data-cc-edit-select-subject]').forEach(input => {
                    input.checked = selectAll.checked;
                });
                syncModalEditSelectionControls();
                return;
            }

            const subjectCheckbox = event.target.closest('[data-cc-edit-select-subject]');
            if (!subjectCheckbox) return;
            const subjectId = Number(subjectCheckbox.dataset.subject || 0);
            if (!subjectId) return;
            if (subjectCheckbox.checked) state.modalEditSelectedSubjectIds.add(subjectId);
            else state.modalEditSelectedSubjectIds.delete(subjectId);
            syncModalEditSelectionControls();
        });

        document.addEventListener('input', (event) => {
            const mapehInput = event.target.closest('[data-cc-edit-mapeh-parent-mark]');
            if (mapehInput) {
                state.modalEditRows
                    .filter(subject => Number(subject.grade_level_id) === Number(mapehInput.dataset.grade))
                    .filter(subject => isMapehRelatedSubjectId(subject.subject_id))
                    .forEach(subject => { subject.passing_mark = mapehInput.value; });
                updateModalEditDraftState();
                return;
            }
            const mapehTimeInput = event.target.closest('[data-cc-edit-mapeh-parent-time]');
            if (mapehTimeInput) {
                state.modalEditRows
                    .filter(subject => Number(subject.grade_level_id) === Number(mapehTimeInput.dataset.grade))
                    .filter(subject => isMapehRelatedSubjectId(subject.subject_id))
                    .forEach(subject => {
                        subject.meeting_minutes = mapehTimeInput.value;
                        subject.weekly_minutes = mapehTimeInput.value;
                    });
                updateModalEditDraftState();
                return;
            }
            const input = event.target.closest('[data-cc-edit-passing-mark]');
            const meetingInput = event.target.closest('[data-cc-edit-meeting-minutes]');
            if (!input && !meetingInput) return;
            const targetInput = input || meetingInput;
            const row = state.modalEditRows.find(subject =>
                Number(subject.grade_level_id) === Number(targetInput.dataset.grade) &&
                Number(subject.subject_id) === Number(targetInput.dataset.subject)
            );
            if (row) {
                if (input) row.passing_mark = input.value;
                if (meetingInput) {
                    row.meeting_minutes = meetingInput.value;
                    row.weekly_minutes = meetingInput.value;
                }
            }
            updateModalEditDraftState();
        });

        // Document-level delegated clicks
        document.addEventListener('click', async (e) => {
            const editAction = e.target.closest('[data-cc-edit-subject-action]');
            if (editAction) {
                if (editAction.dataset.ccEditSubjectAction === 'remove') {
                    removeSubjectFromEdit(Number(editAction.dataset.grade || 0), Number(editAction.dataset.subject || 0));
                }
                return;
            }

            const subjectAction = e.target.closest('[data-cc-subject-action]');
            if (subjectAction) {
                const action = subjectAction.dataset.ccSubjectAction;
                const gradeLevelId = Number(subjectAction.dataset.grade || 0);
                    const subjectId = Number(subjectAction.dataset.subject || 0);
                try {
                    if (action === 'add-subjects') {
                        openAddSubjectModal(gradeLevelId);
                    } else if (action === 'view-group' || action === 'view-item') {
                        openYearSubjectsModal(gradeLevelId);
                    } else if (action === 'edit-group') {
                        editSubjectGrade(gradeLevelId);
                    } else if (action === 'edit-item') {
                        editSubjectGrade(gradeLevelId, subjectId);
                    } else if (action === 'archive-item') {
                        await archiveSubjectItem(gradeLevelId, subjectId);
                    }
                } catch (err) {
                    notify(err?.response?.data?.message || err?.message || 'Subject action failed', 'error');
                }
                return;
            }

            const editModalRow = e.target.closest('[data-cc-edit-subject-row]');
            if (editModalRow && !e.defaultPrevented && Number(e.detail || 1) < 2 && !e.target.closest('a, button, input, select, textarea, label')) {
                e.preventDefault();
                e.stopPropagation();
                activateModalEditSelectionMode(editModalRow);
                return;
            }

            const subjectRow = e.target.closest('[data-cc-subject-row], [data-cc-year-subject-row]');
            if (subjectRow && !e.defaultPrevented && !e.target.closest('a, button, input, select, textarea, label')) {
                e.preventDefault();
                e.stopImmediatePropagation();
                openSubjectRowActions(subjectRow, e);
                return;
            }

            const retryLoad = e.target.closest('#cc-retry-load-btn');
            if (retryLoad) {
                retryLoad.disabled = true;
                retryLoad.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Loading...';
                loadRefs()
                    .catch(err => notify(err?.response?.data?.message || err?.message || 'Failed to load reference data', 'error'))
                    .finally(() => {
                        retryLoad.disabled = false;
                        retryLoad.innerHTML = '<i class="fas fa-rotate-right"></i> Try again';
                    });
                return;
            }

            const mobileToggle = e.target.closest('[data-cc-mobile-actions-toggle]');
            if (mobileToggle) {
                e.preventDefault();
                e.stopPropagation();
                clearTimeout(ccLongPressTimer);
                const row = mobileToggle.closest('tr');
                if (row) openSubjectRowActions(row, e, mobileToggle);
                return;
            }
        });

        document.addEventListener('pointerdown', (e) => {
            const menu = $('ccCurriculumRowActions');
            if (!menu || menu.contains(e.target) || e.target.closest('[data-cc-mobile-actions-toggle]')) return;
            closeCurriculumRowActionMenu();
        });

        document.addEventListener('keydown', (e) => {
            const menu = $('ccCurriculumRowActions');
            if (!menu) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                closeCurriculumRowActionMenu(true);
            }
        });
        window.addEventListener('resize', scheduleCurriculumRowActionMenuPosition, { passive: true });
        document.addEventListener('scroll', scheduleCurriculumRowActionMenuPosition, true);

        let ccLongPressTimer = null;
        document.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse') return;
            if (e.target.closest('[data-cc-mobile-actions-toggle]')) return;
            const value = e.target.closest('#cc-subjects-table .mf-record-value');
            if (!value) return;
            clearTimeout(ccLongPressTimer);
            ccLongPressTimer = setTimeout(() => {
                const row = value.closest('tr');
                openSubjectRowActions(row, e, value);
            }, 520);
        });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => document.addEventListener(type, () => clearTimeout(ccLongPressTimer)));

    }

    /* ═══ Init ═══ */

    document.addEventListener('DOMContentLoaded', async () => {
        wireTabs();
        wireEvents();
        try {
            await loadRefs();
        } catch (err) {
            console.error(err);
            notify('Failed to load reference data', 'error');
        }
    });
})();
