(function exposeAcademicCalendarDatePicker() {
    const MONTHS = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    function parseDate(value) {
        const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return null;
        const year = Number(match[1]);
        const month = Number(match[2]) - 1;
        const day = Number(match[3]);
        const date = new Date(0);
        date.setFullYear(year, month, day);
        date.setHours(12, 0, 0, 0);
        if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
        return { year, month, day };
    }

    function todayIso() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }

    function formatDisplay(value) {
        const parsed = parseDate(value);
        return parsed ? `${MONTHS[parsed.month]} ${parsed.day}, ${parsed.year}` : '';
    }

    function parseMonth(value) {
        const match = String(value || '').trim().match(/^(\d{4})-(\d{2})$/);
        if (!match) return null;
        const year = Number(match[1]);
        const month = Number(match[2]) - 1;
        return month >= 0 && month < 12 ? { year, month } : null;
    }

    function formatMonthDisplay(value) {
        const parsed = parseMonth(value);
        return parsed ? `${MONTHS[parsed.month]} ${parsed.year}` : '';
    }

    function calendarDate(year, month, day = 1) {
        const date = new Date(0);
        date.setFullYear(year, month, day);
        date.setHours(12, 0, 0, 0);
        return date;
    }

    function attach(inputOrId, initialOptions = {}) {
        const input = typeof inputOrId === 'string'
            ? document.getElementById(inputOrId)
            : inputOrId;
        if (!input) return null;
        if (input._academicCalendarDatePicker) return input._academicCalendarDatePicker;

        const options = { ...initialOptions };
        const wrapper = input.closest('.form-group, .setup-field') || input.parentElement;
        const trigger = document.createElement('button');
        const picker = document.createElement('div');
        const fieldLabel = String(options.label || input.getAttribute('aria-label') || 'date');
        const placeholder = String(options.placeholder || `Choose ${fieldLabel.toLowerCase()}`);
        const state = { year: new Date().getFullYear(), month: null, view: 'months', open: false };
        const monthOnly = options.monthOnly === true;

        input.type = 'hidden';
        input.classList.add('academic-date-value');
        input.removeAttribute('required');

        trigger.type = 'button';
        trigger.className = 'academic-date-trigger form-control';
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-label', `Choose ${fieldLabel}`);
        trigger.innerHTML = '<span class="academic-date-trigger-value"></span><i class="fas fa-calendar-alt" aria-hidden="true"></i>';

        picker.className = 'academic-date-picker';
        picker.setAttribute('role', 'dialog');
        picker.setAttribute('aria-label', `Choose ${fieldLabel}`);
        picker.hidden = true;

        input.insertAdjacentElement('afterend', trigger);
        wrapper?.appendChild(picker);

        const getBound = (key) => {
            const value = typeof options[key] === 'function' ? options[key]() : options[key];
            return parseDate(value);
        };

        const isAllowed = (isoDate) => {
            const min = getBound('min');
            const max = getBound('max');
            if (min && isoDate < `${min.year}-${String(min.month + 1).padStart(2, '0')}-${String(min.day).padStart(2, '0')}`) return false;
            if (max && isoDate > `${max.year}-${String(max.month + 1).padStart(2, '0')}-${String(max.day).padStart(2, '0')}`) return false;
            if (typeof options.isDateAllowed === 'function' && !options.isDateAllowed(isoDate)) return false;
            return true;
        };

        const isYearAllowed = (year) => {
            const min = getBound('min');
            const max = getBound('max');
            return (!min || year >= min.year) && (!max || year <= max.year);
        };

        const isMonthAllowed = (year, month) => {
            const min = getBound('min');
            const max = getBound('max');
            const key = year * 12 + month;
            return (!min || key >= min.year * 12 + min.month) && (!max || key <= max.year * 12 + max.month);
        };

        const updateDisplay = () => {
            const value = trigger.querySelector('.academic-date-trigger-value');
            const formatted = monthOnly ? formatMonthDisplay(input.value) : formatDisplay(input.value);
            if (value) value.textContent = formatted || placeholder;
            trigger.classList.toggle('has-value', Boolean(formatted));
        };

        const positionPicker = () => {
            if (!state.open || picker.hidden) return;
            const margin = 12;
            const width = Math.max(240, Math.min(320, window.innerWidth - margin * 2));
            const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
            picker.style.position = 'fixed';
            picker.style.width = `${width}px`;
            picker.style.maxHeight = `${Math.max(220, viewportHeight - margin * 2)}px`;
            picker.style.overflowY = 'auto';
            const rect = trigger.getBoundingClientRect();
            const height = picker.offsetHeight;
            const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
            let top = rect.bottom + 8;
            if (top + height > viewportHeight - margin) top = rect.top - height - 8;
            top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
            picker.style.left = `${left}px`;
            picker.style.top = `${top}px`;
        };

        const close = (restoreFocus = false) => {
            if (!state.open) return;
            state.open = false;
            picker.hidden = true;
            picker.removeAttribute('style');
            wrapper?.appendChild(picker);
            trigger.setAttribute('aria-expanded', 'false');
            wrapper?.classList.remove('is-academic-date-open');
            if (restoreFocus && !trigger.disabled) trigger.focus();
        };

        const render = () => {
            if (!state.open) return;
            const selected = monthOnly ? parseMonth(input.value) : parseDate(input.value);
            const min = getBound('min');
            const max = getBound('max');
            const previousYearDisabled = Boolean(min && state.year <= min.year);
            const nextYearDisabled = Boolean(max && state.year >= max.year);
            const yearControls = `
                <button class="academic-date-nav" type="button" data-academic-date-action="previous-year" aria-label="Previous year"${previousYearDisabled ? ' disabled' : ''}><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
                <strong class="academic-date-year">${state.year}</strong>
                <button class="academic-date-nav" type="button" data-academic-date-action="next-year" aria-label="Next year"${nextYearDisabled ? ' disabled' : ''}><i class="fas fa-chevron-right" aria-hidden="true"></i></button>`;

            if (state.view === 'months') {
                const months = MONTHS.map((name, index) => ({ name, index }))
                    .filter(item => isMonthAllowed(state.year, item.index))
                    .map(item => `<button type="button" data-academic-month="${item.index}" aria-pressed="${selected?.year === state.year && selected.month === item.index}" class="${selected?.year === state.year && selected.month === item.index ? 'is-current' : ''}">${item.name}</button>`)
                    .join('');
                picker.innerHTML = `
                    <div class="academic-date-picker-header">${yearControls}<button class="academic-date-close" type="button" data-academic-date-action="close" aria-label="Close date picker"><i class="fas fa-times" aria-hidden="true"></i></button></div>
                    <p class="academic-date-picker-hint">Choose a month</p>
                    <div class="academic-date-month-grid" role="group" aria-label="Months in ${state.year}">${months || '<p class="academic-date-picker-hint">No dates available in this year.</p>'}</div>`;
            } else {
                const daysInMonth = calendarDate(state.year, state.month + 1, 0).getDate();
                const firstWeekday = calendarDate(state.year, state.month, 1).getDay();
                const blanks = Array.from({ length: firstWeekday }, () => '<span class="academic-date-empty" aria-hidden="true"></span>').join('');
                const days = Array.from({ length: daysInMonth }, (_, index) => {
                    const day = index + 1;
                    const iso = `${state.year}-${String(state.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const selectedDay = selected?.year === state.year && selected.month === state.month && selected.day === day;
                    const disabled = !isAllowed(iso);
                    return `<button type="button" data-academic-date="${iso}" aria-pressed="${selectedDay}"${disabled ? ' disabled' : ''} class="${selectedDay ? 'is-selected' : ''}">${day}</button>`;
                }).join('');
                picker.innerHTML = `
                    <div class="academic-date-picker-header">${yearControls}<button class="academic-date-close" type="button" data-academic-date-action="close" aria-label="Close date picker"><i class="fas fa-times" aria-hidden="true"></i></button></div>
                    <div class="academic-date-month-heading"><button type="button" data-academic-date-action="months" aria-label="Choose another month"><i class="fas fa-chevron-left" aria-hidden="true"></i> Months</button><strong>${MONTHS[state.month]}</strong></div>
                    <div class="academic-date-day-grid" role="group" aria-label="Days in ${MONTHS[state.month]} ${state.year}">${WEEKDAYS.map(day => `<span class="academic-date-weekday" aria-hidden="true">${day}</span>`).join('')}${blanks}${days}</div>`;
            }
            positionPicker();
        };

        const open = () => {
            if (trigger.disabled) return;
            if (state.open) {
                close();
                return;
            }
            const selected = monthOnly ? parseMonth(input.value) : parseDate(input.value);
            const min = getBound('min');
            const max = getBound('max');
            state.year = selected?.year ?? min?.year ?? max?.year ?? new Date().getFullYear();
            state.month = selected?.month ?? null;
            state.view = 'months';
            state.open = true;
            trigger.setAttribute('aria-expanded', 'true');
            wrapper?.classList.add('is-academic-date-open');
            document.body.appendChild(picker);
            picker.hidden = false;
            render();
            picker.querySelector('[data-academic-month].is-current, [data-academic-month]')?.focus({ preventScroll: true });
        };

        picker.addEventListener('click', (event) => {
            const action = event.target.closest('[data-academic-date-action]')?.dataset.academicDateAction;
            if (action) {
                if (action === 'close') close(true);
                if (action === 'previous-year' && isYearAllowed(state.year - 1)) {
                    state.year -= 1;
                    render();
                }
                if (action === 'next-year' && isYearAllowed(state.year + 1)) {
                    state.year += 1;
                    render();
                }
                if (action === 'months') {
                    state.view = 'months';
                    render();
                }
                return;
            }

            const monthButton = event.target.closest('[data-academic-month]');
            if (monthButton) {
                state.month = Number(monthButton.dataset.academicMonth);
                if (monthOnly) {
                    if (!isMonthAllowed(state.year, state.month)) return;
                    input.value = `${state.year}-${String(state.month + 1).padStart(2, '0')}`;
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    updateDisplay();
                    close(true);
                    return;
                }
                state.view = 'days';
                render();
                picker.querySelector('[data-academic-date]')?.focus({ preventScroll: true });
                return;
            }

            const dayButton = event.target.closest('[data-academic-date]');
            if (!dayButton || dayButton.disabled || !isAllowed(dayButton.dataset.academicDate)) return;
            input.value = dayButton.dataset.academicDate;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            updateDisplay();
            close(true);
        });
        picker.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                close(true);
            }
        });

        trigger.addEventListener('click', open);
        input.addEventListener('change', updateDisplay);
        document.addEventListener('pointerdown', (event) => {
            if (state.open && !picker.contains(event.target) && event.target !== trigger && !trigger.contains(event.target)) close();
        });
        window.addEventListener('resize', positionPicker);
        document.addEventListener('scroll', positionPicker, true);

        const api = {
            input,
            trigger,
            picker,
            setOptions(nextOptions = {}) {
                Object.assign(options, nextOptions);
                updateDisplay();
                if (state.open) render();
                return api;
            },
            setValue(value) {
                input.value = String(value || '').slice(0, 10);
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return api;
            },
            refresh() {
                updateDisplay();
                if (state.open) render();
                return api;
            },
            getValue() {
                return String(input.value || '');
            },
            close
        };
        input._academicCalendarDatePicker = api;
        updateDisplay();
        return api;
    }

    window.AcademicCalendarDatePicker = { attach, formatDisplay, todayIso };
})();
