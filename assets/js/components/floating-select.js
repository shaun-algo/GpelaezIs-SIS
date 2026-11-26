(() => {
    const instances = new WeakMap();
    let activeInstance = null;

    function getAssociatedLabel(select) {
        const label = Array.from(select.labels || []).find(item => item.textContent.trim());
        return (select.getAttribute('aria-label') || label?.textContent || 'Select an option')
            .replace(/\s*\*\s*$/, '')
            .trim();
    }

    function close(instance, restoreFocus = false) {
        if (!instance) return;
        instance.menu.hidden = true;
        instance.host.appendChild(instance.menu);
        instance.trigger.setAttribute('aria-expanded', 'false');
        if (activeInstance === instance) activeInstance = null;
        if (restoreFocus && !instance.trigger.disabled) {
            instance.trigger.focus({ preventScroll: true });
        }
    }

    function position(instance) {
        if (activeInstance !== instance || instance.menu.hidden) return;

        const margin = 10;
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const rect = instance.trigger.getBoundingClientRect();
        const width = Math.max(0, Math.min(rect.width, viewportWidth - margin * 2));
        const maxHeight = Math.max(100, Math.min(320, viewportHeight - margin * 2));

        instance.menu.style.width = `${width}px`;
        instance.menu.style.maxHeight = `${maxHeight}px`;
        const menuHeight = Math.min(instance.menu.scrollHeight, maxHeight);
        const below = viewportHeight - rect.bottom - margin;
        const above = rect.top - margin;
        let top = rect.bottom + 6;
        if (menuHeight > below && above > below) top = rect.top - menuHeight - 6;
        top = Math.max(margin, Math.min(top, viewportHeight - menuHeight - margin));
        const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));

        instance.menu.style.left = `${left}px`;
        instance.menu.style.top = `${top}px`;
    }

    function refresh(instance) {
        if (!instance) return;
        const { select, menu } = instance;
        menu.replaceChildren();

        Array.from(select.options).forEach(option => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'mf-floating-select-option';
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', String(option.selected));
            item.disabled = option.disabled;
            item.textContent = option.textContent.trim();
            item.dataset.value = option.value;
            item.addEventListener('click', () => {
                if (select.disabled || option.disabled) return;
                select.value = option.value;
                select.dispatchEvent(new Event('input', { bubbles: true }));
                select.dispatchEvent(new Event('change', { bubbles: true }));
                instance.sync();
                close(instance, true);
            });
            menu.appendChild(item);
        });

        if (activeInstance === instance) position(instance);
    }

    function createFloatingSelect(select, config = {}) {
        if (!(select instanceof HTMLSelectElement)) return null;
        const existing = instances.get(select);
        if (existing) {
            existing.refresh();
            existing.sync();
            return existing;
        }

        const host = select.parentElement;
        if (!host) return null;

        const wasRequired = select.required;
        const label = getAssociatedLabel(select);
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.id = `${select.id || 'floating-select'}-floating-trigger`;
        trigger.className = `form-control mf-floating-select-trigger ${config.triggerClass || ''}`.trim();
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-label', label);

        const text = document.createElement('span');
        text.className = 'mf-floating-select-value';
        const chevron = document.createElement('i');
        chevron.className = 'fas fa-chevron-down';
        chevron.setAttribute('aria-hidden', 'true');
        trigger.append(text, chevron);

        const menu = document.createElement('div');
        menu.id = `${select.id || 'floating-select'}-floating-options`;
        menu.className = 'mf-floating-select-menu';
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', label);
        menu.hidden = true;
        trigger.setAttribute('aria-controls', menu.id);

        host.classList.add('mf-floating-select-host');
        select.classList.add('mf-floating-select-native');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');
        select.required = false;
        const associatedLabels = Array.from(select.labels || []);
        associatedLabels.forEach(item => { item.htmlFor = trigger.id; });
        select.insertAdjacentElement('beforebegin', trigger);

        const instance = {
            select,
            host,
            trigger,
            text,
            menu,
            label,
            placeholderText: String(config.placeholderText || select.options[0]?.textContent || `Select ${label}`),
            wasRequired: Boolean(config.required ?? wasRequired),
            refresh: () => refresh(instance),
            sync: () => {
                const selected = select.selectedOptions?.[0];
                const isPlaceholder = !select.value && instance.wasRequired;
                text.textContent = selected?.textContent?.trim() || instance.placeholderText;
                trigger.classList.toggle('is-placeholder', isPlaceholder);
                trigger.disabled = select.disabled;
                trigger.classList.toggle('is-invalid', select.classList.contains('error'));
                trigger.setAttribute('aria-invalid', String(select.classList.contains('error')));
                trigger.setAttribute('aria-label', `${label}: ${text.textContent}`);
                const selectedValue = String(select.value ?? '');
                menu.querySelectorAll('[role="option"]').forEach(item => {
                    item.setAttribute('aria-selected', String(item.dataset.value === selectedValue));
                });
            },
            open: () => {
                if (trigger.disabled) return;
                if (activeInstance === instance) {
                    close(instance);
                    return;
                }
                if (activeInstance) close(activeInstance);
                refresh(instance);
                document.body.appendChild(menu);
                menu.hidden = false;
                instance.sync();
                trigger.setAttribute('aria-expanded', 'true');
                activeInstance = instance;
                position(instance);
                const selected = Array.from(menu.querySelectorAll('[role="option"]'))
                    .find(item => item.dataset.value === String(select.value ?? '') && !item.disabled);
                const first = selected || menu.querySelector('[role="option"]:not(:disabled)');
                first?.focus({ preventScroll: true });
                first?.scrollIntoView({ block: 'nearest' });
            },
        };

        trigger.addEventListener('click', () => {
            if (activeInstance === instance) close(instance);
            else instance.open();
        });
        trigger.addEventListener('keydown', event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            instance.open();
            const options = Array.from(menu.querySelectorAll('[role="option"]:not(:disabled)'));
            const currentIndex = options.indexOf(document.activeElement);
            const targetIndex = currentIndex < 0
                ? (event.key === 'ArrowUp' ? options.length - 1 : 0)
                : (event.key === 'ArrowUp'
                    ? Math.max(0, currentIndex - 1)
                    : Math.min(options.length - 1, currentIndex + 1));
            const target = options[targetIndex];
            target?.focus({ preventScroll: true });
        });
        menu.addEventListener('keydown', event => {
            const options = Array.from(menu.querySelectorAll('[role="option"]:not(:disabled)'));
            const index = options.indexOf(document.activeElement);
            let nextIndex = index;
            if (event.key === 'ArrowDown') nextIndex = Math.min(options.length - 1, index + 1);
            else if (event.key === 'ArrowUp') nextIndex = Math.max(0, index - 1);
            else if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = options.length - 1;
            else if (event.key === 'Escape') {
                event.preventDefault();
                close(instance, true);
                return;
            } else return;
            event.preventDefault();
            options[nextIndex]?.focus({ preventScroll: true });
            options[nextIndex]?.scrollIntoView({ block: 'nearest' });
        });

        select.addEventListener('change', instance.sync);
        select.addEventListener('input', instance.sync);
        const observer = new MutationObserver(() => {
            instance.refresh();
            instance.sync();
        });
        observer.observe(select, {
            attributes: true,
            childList: true,
            subtree: true,
            attributeFilter: ['class', 'disabled', 'label', 'selected', 'value'],
        });

        instances.set(select, instance);
        refresh(instance);
        instance.sync();
        return instance;
    }

    document.addEventListener('pointerdown', event => {
        if (!activeInstance) return;
        const path = event.composedPath?.() || [];
        if (path.includes(activeInstance.trigger) || path.includes(activeInstance.menu)) return;
        close(activeInstance);
    }, true);

    document.addEventListener('focusin', event => {
        if (!activeInstance) return;
        const path = event.composedPath?.() || [];
        if (path.includes(activeInstance.trigger) || path.includes(activeInstance.menu)) return;
        close(activeInstance);
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && activeInstance) {
            event.preventDefault();
            close(activeInstance, true);
        }
    });

    document.addEventListener('scroll', () => {
        if (activeInstance) position(activeInstance);
    }, true);
    window.addEventListener('resize', () => {
        if (activeInstance) position(activeInstance);
    });

    window.createFloatingSelect = createFloatingSelect;
    window.syncFloatingSelect = select => instances.get(select)?.sync();
})();
