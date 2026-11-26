(function () {
    'use strict';

    const presets = Object.freeze({
        mist: {
            label: 'Mist',
            start: '#3e5870',
            end: '#7e9bb8',
            angle: 135
        },
        sage: {
            label: 'Sage',
            start: '#294d3b',
            end: '#6e9b7a',
            angle: 135
        },
        sand: {
            label: 'Sand',
            start: '#6f4d2d',
            end: '#b68a54',
            angle: 135
        },
        blush: {
            label: 'Blush',
            start: '#6e3545',
            end: '#b87887',
            angle: 135
        },
        lavender: {
            label: 'Lavender',
            start: '#4b3b72',
            end: '#8974bd',
            angle: 135
        },
        plain: {
            label: 'Plain',
            start: '#ffffff',
            end: '#ffffff',
            angle: 0,
            css: '#ffffff'
        }
    });

    const defaultPreset = 'plain';
    const storageKey = 'depedAnnouncementBackgrounds';
    function normalizeHex(value, fallback) {
        const normalized = String(value || '').trim().toLowerCase();
        return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : fallback;
    }

    function normalizeAngle(value, fallback = 135) {
        const angle = Number(value);
        if (!Number.isFinite(angle)) return fallback;
        return Math.min(360, Math.max(0, Math.round(angle)));
    }

    function buildAnnouncementGradient(start, end, angle) {
        return `linear-gradient(${normalizeAngle(angle)}deg, ${normalizeHex(start, presets[defaultPreset].start)} 0%, ${normalizeHex(end, presets[defaultPreset].end)} 100%)`;
    }

    function getPresetCss(preset) {
        return preset?.css || buildAnnouncementGradient(preset?.start, preset?.end, preset?.angle);
    }

    function parseAnnouncementBackground(value) {
        const raw = String(value || '').trim();
        const matchingPreset = Object.entries(presets).find(([, preset]) => getPresetCss(preset) === raw);
        if (matchingPreset) {
            const [presetName, preset] = matchingPreset;
            return {
                mode: 'preset',
                preset: presetName,
                start: preset.start,
                end: preset.end,
                angle: preset.angle,
                css: getPresetCss(preset)
            };
        }

        const match = raw.match(/^linear-gradient\(\s*(\d{1,3})deg,\s*(#[0-9a-f]{6})\s+0%,\s*(#[0-9a-f]{6})\s+100%\s*\)$/i);
        if (!match || Number(match[1]) > 360) return null;

        const start = normalizeHex(match[2], presets[defaultPreset].start);
        const end = normalizeHex(match[3], presets[defaultPreset].end);
        const angle = normalizeAngle(match[1]);
        return {
            mode: 'custom',
            preset: 'custom',
            start,
            end,
            angle,
            css: buildAnnouncementGradient(start, end, angle)
        };
    }

    function getAnnouncementBackgroundStyle(value) {
        return parseAnnouncementBackground(value)?.css || getPresetCss(presets[defaultPreset]);
    }

    function readStoredBackgrounds() {
        try {
            const stored = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
            return stored && typeof stored === 'object' ? stored : {};
        } catch (_) {
            return {};
        }
    }

    function rememberAnnouncementBackground(announcementId, value) {
        if (!announcementId) return;
        const css = getAnnouncementBackgroundStyle(value);
        const stored = readStoredBackgrounds();
        stored[String(announcementId)] = css;

        const keys = Object.keys(stored);
        if (keys.length > 200) {
            keys.slice(0, keys.length - 200).forEach((key) => delete stored[key]);
        }

        try {
            window.localStorage.setItem(storageKey, JSON.stringify(stored));
        } catch (_) {
            // Styling is an enhancement; a private browsing quota issue should not block posting.
        }
    }

    function getStoredAnnouncementBackground(announcementId) {
        if (!announcementId) return null;
        return readStoredBackgrounds()[String(announcementId)] || null;
    }

    function getAnnouncementBackgroundForAnnouncement(announcement) {
        return getAnnouncementBackgroundStyle(
            announcement?.message_background || getStoredAnnouncementBackground(announcement?.announcement_id)
        );
    }

    function updatePreview(control, css) {
        const canvas = document.getElementById('announcementMessageCanvas');
        const isPlain = parseAnnouncementBackground(css)?.preset === 'plain';
        if (canvas) {
            canvas.style.background = css;
            canvas.classList.toggle('announcement-message-canvas--plain', isPlain);
        }

        const preview = control.querySelector('#announcementMessagePreview');
        if (preview) {
            preview.style.background = css;
            preview.classList.toggle('announcement-message-preview--plain', isPlain);
            const body = document.getElementById('announcementBody');
            const previewCopy = preview.querySelector('[data-preview-copy]');
            if (previewCopy) {
                previewCopy.textContent = body?.value.trim() || 'Your message will look like this.';
            }
        }
    }

    function setBackgroundPaletteOpen(isOpen) {
        const control = document.getElementById('announcementBackgroundControl');
        const trigger = document.getElementById('announcementBackgroundToggle');
        if (control) control.hidden = !isOpen;
        if (trigger) trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    function setAnnouncementBackgroundControl(value) {
        const control = document.getElementById('announcementBackgroundControl');
        if (!control) return;

        const parsed = typeof value === 'object' && value?.css
            ? value
            : (parseAnnouncementBackground(value) || parseAnnouncementBackground(getPresetCss(presets[defaultPreset])));
        const css = parsed.css;
        const hiddenInput = control.querySelector('#messageBackground');
        const valueLabel = control.querySelector('#announcementBackgroundValue');

        if (hiddenInput) hiddenInput.value = css;
        if (valueLabel) valueLabel.textContent = presets[parsed.preset]?.label || 'Saved';

        control.querySelectorAll('[data-background-preset]').forEach((button) => {
            const selected = button.dataset.backgroundPreset === parsed.preset;
            button.classList.toggle('is-selected', selected);
            button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        });

        updatePreview(control, css);
    }

    function initializeAnnouncementBackgroundControl() {
        const control = document.getElementById('announcementBackgroundControl');
        if (!control || control.dataset.initialized === 'true') return;
        control.dataset.initialized = 'true';

        document.getElementById('announcementBackgroundToggle')?.addEventListener('click', () => {
            setBackgroundPaletteOpen(control.hidden);
        });
        document.getElementById('announcementBackgroundClose')?.addEventListener('click', () => {
            setBackgroundPaletteOpen(false);
        });

        control.querySelectorAll('[data-background-preset]').forEach((button) => {
            button.addEventListener('click', () => {
                const presetName = button.dataset.backgroundPreset;
                const preset = presets[presetName] || presets[defaultPreset];
                setAnnouncementBackgroundControl({
                    mode: 'preset',
                    preset: presetName,
                    start: preset.start,
                    end: preset.end,
                    angle: preset.angle,
                    css: getPresetCss(preset)
                });
            });
        });

        document.getElementById('announcementBody')?.addEventListener('input', () => {
            const css = control.querySelector('#messageBackground')?.value;
            updatePreview(control, getAnnouncementBackgroundStyle(css));
        });

        setAnnouncementBackgroundControl(null);
    }

    function resetAnnouncementBackgroundControl() {
        setBackgroundPaletteOpen(false);
        setAnnouncementBackgroundControl(null);
    }

    window.ANNOUNCEMENT_BACKGROUND_PRESETS = presets;
    window.getAnnouncementBackgroundStyle = getAnnouncementBackgroundStyle;
    window.isAnnouncementPlainBackground = (value) => parseAnnouncementBackground(value)?.preset === 'plain';
    window.getAnnouncementBackgroundForAnnouncement = getAnnouncementBackgroundForAnnouncement;
    window.getStoredAnnouncementBackground = getStoredAnnouncementBackground;
    window.rememberAnnouncementBackground = rememberAnnouncementBackground;
    window.initializeAnnouncementBackgroundControl = initializeAnnouncementBackgroundControl;
    window.resetAnnouncementBackgroundControl = resetAnnouncementBackgroundControl;
    window.setAnnouncementBackgroundControl = setAnnouncementBackgroundControl;
})();
