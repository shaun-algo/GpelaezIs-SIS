(() => {
    const root = document.getElementById('liswiz');
    if (!root) return;

    /* ------------------------- config / plumbing ------------------------- */

    function getAppPrefix() {
        const p = String(window.location.pathname || '/');
        for (const seg of ['/dashboard/', '/pages/', '/assets/', '/api/']) {
            if (p.includes(seg)) return p.split(seg)[0] || '';
        }
        if (p.endsWith('.html')) return p.substring(0, p.lastIndexOf('/')) || '';
        return p.endsWith('/') ? p.slice(0, -1) : p;
    }
    const isApache = String(window.location.pathname || '').includes('/deped_capstone2/');
    const API = window.API_BASE || (isApache
        ? `${getAppPrefix()}/api`
        : `${window.location.protocol}//${window.location.host}/deped_capstone2/api`);
    if (window.axios) { try { window.axios.defaults.withCredentials = true; } catch (_) {} }

    const LIB = {
        papa: `${getAppPrefix()}/assets/vendor/papaparse/papaparse.min.js`,
        xlsx: `${getAppPrefix()}/assets/vendor/xlsx/xlsx.full.min.js`
    };

    function notify(type, message) {
        if (typeof window.showNotification === 'function') return window.showNotification(message, type);
        if (type === 'error') alert(message);
        else console.log(message); // eslint-disable-line no-console
    }

    function getErrorMessage(error, fallback = 'Request failed') {
        const data = error?.response?.data;
        if (data?.message) return data.message;
        if (data?.fatal) return data.fatal;
        return error?.message || fallback;
    }

    function formatValidationErrorDetails(error) {
        const errors = error?.response?.data?.validation_errors;
        if (!Array.isArray(errors) || errors.length === 0) return '';
        return errors.slice(0, 5)
            .map((issue) => `Row ${issue.row || issue.row_number || ''}: ${issue.message || 'Invalid spreadsheet value'}`)
            .join(' | ');
    }

    function showInfoBanner({ icon = 'fa-circle-info', title = '', body = '', autoDismissMs = 3200 } = {}) {
        const existing = document.getElementById('liswiz-info-banner-bd');
        if (existing) existing.remove();
        const bd = document.createElement('div');
        bd.id = 'liswiz-info-banner-bd';
        bd.className = 'liswiz-info-banner-backdrop';
        bd.innerHTML = `<div class="liswiz-info-banner" role="status" aria-live="polite">
            <div class="lib-icon"><i class="fas ${icon}"></i></div>
            ${title ? `<div class="lib-title">${title}</div>` : ''}
            ${body ? `<div class="lib-body">${body}</div>` : ''}
            <div class="lib-dismiss">tap to dismiss</div>
        </div>`;
        document.body.appendChild(bd);
        const dismiss = () => {
            bd.classList.add('fade-out');
            bd.addEventListener('transitionend', () => bd.remove(), { once: true });
        };
        bd.addEventListener('click', dismiss);
        if (autoDismissMs > 0) setTimeout(dismiss, autoDismissMs);
    }

    const esc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

    function loadScriptOnce(src, key) {
        return new Promise((resolve, reject) => {
            const ex = document.querySelector(`script[data-lib="${key}"]`);
            if (ex) {
                if (ex.dataset.loaded === '1') return resolve();
                ex.addEventListener('load', resolve, { once: true });
                ex.addEventListener('error', reject, { once: true });
                return;
            }
            const s = document.createElement('script');
            s.src = src; s.async = true; s.dataset.lib = key;
            s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(); }, { once: true });
            s.addEventListener('error', () => reject(new Error(`Failed to load ${key}`)), { once: true });
            document.head.appendChild(s);
        });
    }
    const ensurePapa = async () => { if (!window.Papa) await loadScriptOnce(LIB.papa, 'papa'); };
    const ensureXlsx = async () => { if (!window.XLSX) await loadScriptOnce(LIB.xlsx, 'xlsx'); };

    /* --------------------- normalizers (preview parity) ------------------- */
    /* These mirror the SERVER rules exactly, so what Review shows == what commits. */

    function repairLrn(raw, cellWasNumeric = false) {
        const W = [];
        let v = String(raw ?? '').trim();
        if (!v) return { value: null, warnings: W, error: 'LRN is empty' };
        if (/^\d+(\.\d+)?E\+?\d+$/i.test(v)) {
            v = Number(v).toFixed(0);
            W.push('LRN recovered from Excel scientific notation — verify');
        }
        v = v.replace(/[\s\-]/g, '');
        if (/^\d{11}$/.test(v)) { v = '0' + v; W.push('LRN leading zero restored — verify'); }
        if (!/^\d{12}$/.test(v)) return { value: null, warnings: W, error: `LRN must be 12 digits: "${raw}"` };
        return { value: v, warnings: W };
    }

    function parseSf1Name(value) {
        const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
        if (!raw || !raw.includes(',')) return null;
        const EXT = new Map([
            ['JR', 'Jr.'], ['SR', 'Sr.'], ['II', 'II'], ['III', 'III'], ['IV', 'IV'],
            ['V', 'V'], ['VI', 'VI'], ['VII', 'VII'], ['VIII', 'VIII'], ['IX', 'IX'], ['X', 'X'],
        ]);
        let parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
        if (parts.length < 2) return null;
        let ext = '';
        parts = parts.map((p) => {
            const t = p.split(' ').filter(Boolean);
            const last = (t[t.length - 1] || '').replace(/\./g, '').toUpperCase();
            if (EXT.has(last)) { t.pop(); ext = EXT.get(last); }
            return t.join(' ');
        }).filter(Boolean);
        if (parts.length < 2) return null;
        const last_name = parts[0];
        let first_name, middle_name = '', inferred = false;
        if (parts.length >= 3) { first_name = parts[1]; middle_name = parts.slice(2).join(' '); }
        else {
            const t = parts[1].split(' ').filter(Boolean);
            if (!t.length) return null;
            if (t.length === 1) first_name = t[0];
            else { middle_name = t.pop(); first_name = t.join(' '); inferred = true; }
        }
        if (!last_name || !first_name) return null;
        return { last_name, first_name, middle_name, name_extension: ext, raw, inferred };
    }

    function normalizeDate(v) {
        const raw = String(v ?? '').trim();
        const W = [];
        if (!raw) return { value: null, warnings: W };
        const valid = (y, m, d) => {
            const dt = new Date(Date.UTC(y, m - 1, d));
            return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
        };
        const fmt = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        let m;
        if ((m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
            return valid(+m[1], +m[2], +m[3])
                ? { value: fmt(+m[1], +m[2], +m[3]), warnings: W }
                : { value: null, warnings: W, error: `Invalid date "${raw}"` };
        }
        if (/^\d{4,6}$/.test(raw)) {
            const n = +raw;
            if (n > 10000 && n < 60000) {
                const iso = new Date((n - 25569) * 86400000).toISOString().slice(0, 10);
                W.push(`Excel serial ${raw} → ${iso} — verify`);
                return { value: iso, warnings: W };
            }
            return { value: null, warnings: W, error: `Unparseable date "${raw}"` };
        }
        if ((m = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/))) {
            const a = +m[1], b = +m[2], y = +m[3];
            if (valid(y, a, b)) return { value: fmt(y, a, b), warnings: W };
            if (valid(y, b, a)) { W.push(`"${raw}" only valid as DD/MM — auto-swapped, verify`); return { value: fmt(y, b, a), warnings: W }; }
            return { value: null, warnings: W, error: `Impossible date "${raw}"` };
        }
        if ((m = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/))) {
            const a = +m[1], b = +m[2], yy = +m[3];
            const y = yy <= (new Date().getFullYear() % 100) ? 2000 + yy : 1900 + yy;
            W.push(`2-digit year "${raw}" → ${y} — verify`);
            if (valid(y, a, b)) return { value: fmt(y, a, b), warnings: W };
            if (valid(y, b, a)) return { value: fmt(y, b, a), warnings: W };
            return { value: null, warnings: W, error: `Impossible date "${raw}"` };
        }
        return { value: null, warnings: W, error: `Unparseable date "${raw}"` };
    }

    function normalizeSexPreview(v) {
        const s = String(v ?? '').trim().toUpperCase();
        return { M: 'M', MALE: 'M', F: 'F', FEMALE: 'F' }[s] ?? null;
    }

    async function decodeCsvSmart(file) {
        const buf = await file.arrayBuffer();
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
        catch (_) { text = new TextDecoder('windows-1252').decode(buf); }
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        return typeof text.normalize === 'function' ? text.normalize('NFC') : text;
    }

    /* --------------------------- header mapping --------------------------- */
    /* Staging column key ← file header variants (lowercased, squashed). */
    const HEADER_MAP = [
        ['lrn',            [/^learner reference number \(lrn\)$/, /^lrn$/, /learner reference/]],
        ['name',           [/^name of learner$/, /^name of pupils?/, /^learner'?s? name$/, /^pupil'?s? name$/, /^name$/, /^full ?name$/]],
        ['sex',            [/^sex$/, /^gender$/]],
        ['birth_date',     [/^birth ?date$/, /^date of birth$/, /^birthday$/, /^dob$/]],
        ['birth_province', [/^place of birth \(province\)$/, /place of birth/, /birth ?place/]],
        ['age_by_june',    [/^age by june/, /^age( as of)?/]],
        ['mother_tongue',  [/^mother tongue$/]],
        ['ip_group',       [/^ip \(specify ethnic group\)$/, /ethnic group/, /^ip$/, /indigenous/]],
        ['religion',       [/^religion$/]],
        ['house_street',   [/^house #?\/?street$/, /house.*street/, /street|sitio|purok/]],
        ['barangay',       [/^barangay$/, /^brgy\.?$/]],
        ['municipality',   [/^municipality$/, /municipality\s*\/?\s*city|city\s*\/?\s*municipality/]],
        ['province',       [/^province$/]],
        ['father_name',    [/^name of parents father$/, /^name of father$/, /father'?s? name/, /^father$/]],
        ['mother_name',    [/^name of parents mother$/, /^name of mother$/, /mother'?s? (maiden )?name/, /^mother$/]],
        ['guardian_name',  [/^name of guardian$/, /guardian'?s? name/, /^guardian$/]],
        ['guardian_rel',   [/^relationship to guardian$/, /guardian.*relationship|relationship.*guardian/]],
        ['contact_number', [/^contact number$/, /contact|mobile|cell ?phone|cp no/]],
        ['remarks',        [/^remark\/?s?$/, /^remarks?$/, /^status$/, /entry status/, /learner status/, /enrollment status/]],
        ['grade_level',    [/^grade level$/, /^grade$/, /year level/]],
        ['section',        [/^section$/, /section name/]]
    ];
    const FILE_META_HEADERS = [
        ['school_id',   [/^school id$/]],
        ['school_year', [/^school year$/]],
        ['school_name', [/^school name$/]]
    ];
    const norm = (h) => String(h ?? '').trim().toLowerCase()
        .replace(/\([^)]*\)/g, ' ') // strip parenthetical notes (e.g. "NAME (Last, First, Middle)")
        .replace(/\s+/g, ' ')
        .replace(/[^a-z0-9 #\/'.-]+/g, '').trim();

    const sf1MetaFields = [
        ['school_id', /^school\s*id/i],
        ['school_name', /^school\s*name/i],
        ['school_year', /^school\s*year/i],
        ['grade_level', /^grade\s*level/i],
        ['section', /^section/i]
    ];

    const sf1DataCols = [
        ['lrn', 'B'],
        ['name', 'C'],
        ['sex', 'G'],
        ['birth_date', 'H'],
        ['age_by_june', 'I'],
        ['birth_province', 'J'],
        ['mother_tongue', 'L'],
        ['ip_group', 'M'],
        ['religion', 'N'],
        ['house_street', 'O'],
        ['barangay', 'P'],
        ['municipality', 'Q'],
        ['province', 'R'],
        ['father_name', 'T'],
        ['mother_name', 'V'],
        ['guardian_name', 'X'],
        ['guardian_rel', 'Y'],
        ['contact_number', 'Z'],
        ['remarks', 'AA']
    ];

    const sf1DisplayHeaders = [
        'Learner Reference Number (LRN)', 'Name of Learner', 'Sex', 'Birth Date',
        'Age by June', 'Place of Birth (Province)', 'Mother Tongue',
        'IP (Specify ethnic group)', 'Religion', 'House #/Street', 'Barangay',
        'Municipality', 'Province', 'Name of Father', 'Name of Mother',
        'Name of Guardian', 'Relationship to Guardian', 'Contact Number', 'Remark/s',
        'Grade Level', 'Section'
    ];

    function xlsxCellText(ws, addr) {
        const c = ws?.[addr];
        if (!c) return '';
        if (c.w !== undefined && c.w !== null && String(c.w).trim() !== '') return String(c.w).trim();
        if (c.v === undefined || c.v === null) return '';
        return String(c.v).replace(/\s+/g, ' ').trim();
    }

    function findMergeContaining(merges, row, col) {
        return (merges || []).find((m) => row >= m.s.r && row <= m.e.r && col >= m.s.c && col <= m.e.c) || null;
    }

    function findSf1LabelValue(ws, merges, range, labelRegex) {
        for (let r = range.s.r; r <= Math.min(range.e.r, 12); r++) {
            for (let c = range.s.c; c <= range.e.c; c++) {
                const txt = xlsxCellText(ws, window.XLSX.utils.encode_cell({ r, c }));
                if (!txt || !labelRegex.test(txt)) continue;
                const ownMerge = findMergeContaining(merges, r, c);
                const labelEndCol = ownMerge ? ownMerge.e.c : c;
                let best = null;
                for (const m of merges || []) {
                    if (m.s.r === r && m.s.c > labelEndCol && (!best || m.s.c < best.s.c)) best = m;
                }
                const valueAddr = best
                    ? window.XLSX.utils.encode_cell({ r: best.s.r, c: best.s.c })
                    : window.XLSX.utils.encode_cell({ r, c: labelEndCol + 1 });
                return xlsxCellText(ws, valueAddr);
            }
        }
        return '';
    }

    function findRowContainingText(ws, range, regex) {
        for (let r = range.s.r; r <= range.e.r; r++) {
            for (let c = range.s.c; c <= range.e.c; c++) {
                const txt = xlsxCellText(ws, window.XLSX.utils.encode_cell({ r, c }));
                if (txt && regex.test(txt)) return r;
            }
        }
        return -1;
    }

    function parseOfficialSf1Sheet(ws) {
        if (!ws || !ws['!ref']) return null;
        const range = window.XLSX.utils.decode_range(ws['!ref']);
        const merges = ws['!merges'] || [];
        const lrnRow = findRowContainingText(ws, range, /^lrn$/i);
        if (lrnRow < 0) return null;

        const hasSf1Signals = findRowContainingText(ws, range, /school\s*form\s*1|school\s*register/i) >= 0
            || sf1MetaFields.some(([, rx]) => findSf1LabelValue(ws, merges, range, rx));
        if (!hasSf1Signals) return null;

        for (const [key, rx] of sf1MetaFields) {
            const value = findSf1LabelValue(ws, merges, range, rx);
            if (value) state.fileMeta[key] = value;
        }

        const legendRow = findRowContainingText(ws, range, /list and code of indicators/i);
        const startRow = lrnRow + 2;
        const endRow = legendRow > startRow ? legendRow - 1 : range.e.r;
        const rows = [];
        for (let r = startRow; r <= endRow; r++) {
            const out = {
                row_number: rows.length + 1,
                grade_level: state.fileMeta.grade_level || '',
                section: state.fileMeta.section || ''
            };
            for (const [key, col] of sf1DataCols) {
                const c = window.XLSX.utils.decode_col(col);
                out[key] = xlsxCellText(ws, window.XLSX.utils.encode_cell({ r, c }));
            }
            if (String(out.lrn || '').trim() || String(out.name || '').trim()) rows.push(out);
        }
        return { rows, headers: sf1DisplayHeaders };
    }

    function mapHeader(h) {
        const n = norm(h);
        if (!n) return null;
        if (/mother tongue/.test(n)) return 'mother_tongue';                // before mother_name
        for (const [key, rxs] of FILE_META_HEADERS) for (const rx of rxs) if (rx.test(n)) return `@${key}`;
        for (const [key, rxs] of HEADER_MAP) for (const rx of rxs) if (rx.test(n)) return key;
        return null;
    }

    /* ------------------------------ state --------------------------------- */

    const state = {
        step: 1,
        file: null,
        fileMeta: { school_id: null, school_year: null, school_name: null, grade_level: null, section: null },
        rows: [],               // [{row_number, lrn, name, ... , _cellNumericLrn}]
        headers: [],            // display headers (as read)
        headerToKey: new Map(), // display header -> staging key
        localIssues: [],        // client-side pre-parse issues [{row, severity, message}]
        schoolYears: [], gradeLevels: [], enrollmentTypes: [], sections: [],
        settings: {
            schoolYearId: null, defaultGradeLevelId: null, fallbackSectionId: null,
            enrollmentTypeId: null, passwordMode: 'lrn', passwordCustom: ''
        },
        importId: null,
        preview: { rows: [], summary: null, capacity: [] },
        commit: { done: false, results: [], ok: 0, skip: 0, err: 0, total: 0, finalErrorCount: null }
    };

    const $ = (id) => document.getElementById(id);
    const el = {
        fileInput: $('liswiz-file'), uploadZone: $('liswiz-upload-zone'),
        fileMeta: $('liswiz-file-meta'), step1Note: $('liswiz-step1-note'),
        review: $('liswiz-review'),
        reviewPanel: $('liswiz-review-panel'), reviewChips: $('liswiz-review-chips'),
        step2Actions: $('liswiz-step2-actions'),
        sy: $('liswiz-sy'), grade: $('liswiz-grade'), sections: $('liswiz-sections'),
        etype: $('liswiz-etype'), dup: $('liswiz-dup'),
        pwmode: $('liswiz-pwmode'), pwcustomWrap: $('liswiz-pwcustom-wrap'), pwcustom: $('liswiz-pwcustom'),
        step2Note: $('liswiz-step2-note'),
        progLabel: $('liswiz-prog-label'), prog: $('liswiz-prog'), log: $('liswiz-log'),
        resultsTable: $('liswiz-results-table'), summaryCard: $('liswiz-summary-card'),
        sumTotal: $('liswiz-sum-total'), sumOk: $('liswiz-sum-ok'),
        sumSkip: $('liswiz-sum-skip'), sumErr: $('liswiz-sum-err'),
        next1: $('liswiz-next-1'), back2: $('liswiz-back-2'), next2: $('liswiz-next-2'),
        reset: $('liswiz-reset')
    };

    function showStep(step) {
        state.step = step;
        for (let i = 1; i <= 4; i++) {
            const panel = $(`liswiz-step-${i}`);
            if (panel) panel.style.display = i === step ? 'block' : 'none';
            const si = $(`liswiz-si-${i}`);
            if (si) {
                si.classList.remove('active', 'done');
                if (i < step) si.classList.add('done');
                else if (i === step) si.classList.add('active');
            }
        }
    }

    /* ------------------------------ parsing ------------------------------- */

    async function parseFile(file) {
        state.file = file;
        state.rows = []; state.headers = []; state.headerToKey = new Map();
        state.fileMeta = { school_id: null, school_year: null, school_name: null, grade_level: null, section: null };
        state.localIssues = [];

        const name = String(file.name || '').toLowerCase();
        if (name.endsWith('.csv')) await parseCsv(file);
        else if (name.endsWith('.xlsx')) await parseXlsx(file);
        else throw new Error('Unsupported file type. Upload a .csv or .xlsx');

        if (!state.rows.length) throw new Error('No learner rows found in the file.');
    }

    async function parseCsv(file) {
        await ensurePapa();
        const text = await decodeCsvSmart(file);               // C-5 fix
        const res = window.Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: false });
        const fatal = (res.errors || []).filter((e) => !/Too(Many|Few)Fields/i.test(e.code || ''));
        if (fatal.length) throw new Error(fatal[0].message || 'Failed to parse CSV');
        const headers = Array.isArray(res.meta?.fields) ? res.meta.fields : Object.keys(res.data?.[0] || {});
        ingestFlatRows(headers, res.data || []);
    }

    async function parseXlsx(file) {
        await ensureXlsx();
        const buf = await file.arrayBuffer();
        const wb = window.XLSX.read(buf, { type: 'array' });
        const toText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

        let best = null;
        for (const sn of wb.SheetNames || []) {
            const ws = wb.Sheets[sn];
            if (!ws) continue;
            const sf1 = parseOfficialSf1Sheet(ws);
            if (sf1 && sf1.rows.length) {
                state.headers = sf1.headers;
                state.headerToKey = new Map();
                sf1DisplayHeaders.forEach((h) => {
                    const k = mapHeader(h);
                    if (k) state.headerToKey.set(h, k);
                });
                state.rows = sf1.rows;
                return;
            }
            const aoa = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
            // score each candidate header row
            let bestIdx = -1, bestScore = 0;
            for (let i = 0; i < Math.min(aoa.length, 80); i++) {
                const cells = (aoa[i] || []).map(toText).filter(Boolean);
                if (cells.length < 3) continue;
                const keys = new Set(cells.map(mapHeader).filter(Boolean));
                let score = keys.size;
                if (keys.has('lrn')) score += 2;
                if (keys.has('name')) score += 2;
                if (score > bestScore) { bestScore = score; bestIdx = i; }
            }
            if (bestIdx >= 0 && (!best || bestScore > best.score)) {
                best = { ws, aoa, headerIdx: bestIdx, score: bestScore };
            }
        }
        if (!best || best.score < 4) throw new Error('Could not locate a header row with LRN + Name columns.');

        const { aoa, headerIdx } = best;

        // SF1 header-block scan (rows above the header): School ID / SY / Grade / Section
        for (let i = 0; i < headerIdx; i++) {
            const row = aoa[i] || [];
            for (let j = 0; j < row.length; j++) {
                const label = norm(toText(row[j]));
                const val = toText(row[j + 1]) || toText(row[j + 2]);
                if (!val) continue;
                if (label === 'school id') state.fileMeta.school_id = val;
                else if (label === 'school year') state.fileMeta.school_year = val;
                else if (label === 'school name') state.fileMeta.school_name = val;
                else if (label === 'grade level' && !state.fileMeta.grade_level) state.fileMeta.grade_level = val;
                else if (label === 'section' && !state.fileMeta.section) state.fileMeta.section = val;
            }
        }

        const headers = (aoa[headerIdx] || []).map(toText);
        const dataRows = [];
        let emptyStreak = 0;
        for (let i = headerIdx + 1; i < aoa.length; i++) {
            const r = aoa[i] || [];
            const colA = toText(r[0]).toUpperCase();
            if (colA.includes('LIST AND CODE OF INDICATORS') || colA === 'INDICATOR') break; // SF1 legend
            const obj = {};
            headers.forEach((h, j) => { if (h) obj[h] = r[j] ?? ''; });
            const hasAny = Object.values(obj).some((v) => toText(v) !== '');
            if (!hasAny) { if (++emptyStreak >= 25) break; continue; }
            emptyStreak = 0;
            dataRows.push(obj);
        }
        ingestFlatRows(headers.filter(Boolean), dataRows);
    }

    function ingestFlatRows(headers, rawRows) {
        state.headers = headers;
        for (const h of headers) {
            const k = mapHeader(h);
            if (k) state.headerToKey.set(h, k);
        }
        const keyed = [];
        rawRows.forEach((r, idx) => {
            const out = { row_number: idx + 1 };
            for (const [h, k] of state.headerToKey.entries()) {
                const v = r?.[h];
                if (k.startsWith('@')) {                      // file-level meta as columns (flat template)
                    const mk = k.slice(1);
                    if (!state.fileMeta[mk] && String(v ?? '').trim() !== '') state.fileMeta[mk] = String(v).trim();
                } else if (out[k] === undefined || String(out[k] ?? '').trim() === '') {
                    out[k] = v == null ? '' : String(v);
                }
            }
            if (!String(out.grade_level ?? '').trim() && state.fileMeta.grade_level) out.grade_level = state.fileMeta.grade_level;
            if (!String(out.section ?? '').trim() && state.fileMeta.section) out.section = state.fileMeta.section;
            const hasAny = Object.keys(out).some((k) => k !== 'row_number' && String(out[k] ?? '').trim() !== '');
            if (hasAny) keyed.push(out);
        });
        // renumber post-filter so staging row_numbers are contiguous
        keyed.forEach((r, i) => { r.row_number = i + 1; });
        state.rows = keyed;
    }

    /* -------------------------- step 1 rendering -------------------------- */

    function localPreviewChecks() {
        // Client-side sanity preview (server re-validates authoritatively).
        const issues = [];
        for (const r of state.rows) {
            const lrn = repairLrn(r.lrn);
            if (lrn.error) issues.push({ row: r.row_number, severity: 'E', message: lrn.error });
            lrn.warnings.forEach((w) => issues.push({ row: r.row_number, severity: 'W', message: w }));
            if (String(r.name ?? '').trim() && !parseSf1Name(r.name)) {
                issues.push({ row: r.row_number, severity: 'E', message: `Name not in "LAST, FIRST MIDDLE" form: "${r.name}"` });
            }
            const d = normalizeDate(r.birth_date);
            if (d.error) issues.push({ row: r.row_number, severity: 'E', message: d.error });
            d.warnings.forEach((w) => issues.push({ row: r.row_number, severity: 'W', message: w }));
            if (String(r.sex ?? '').trim() && !normalizeSexPreview(r.sex)) {
                issues.push({ row: r.row_number, severity: 'E', message: `Sex must be M or F: "${r.sex}"` });
            }
        }
        state.localIssues = issues;
        return issues;
    }

    function renderStep1() {
        if (!state.file) {
            el.next1.disabled = true;
            el.fileMeta.style.display = 'none';
            el.step1Note.style.display = 'none';
            return;
        }
        const issues = localPreviewChecks();
        const errs = issues.filter((i) => i.severity === 'E').length;
        const mappedKeys = new Set(state.headerToKey.values());
        const required = ['lrn', 'name', 'sex', 'birth_date'];
        const missingReq = required.filter((k) => !mappedKeys.has(k));

        // File metadata items (only show those that have values)
        const metaItems = [];
        if (state.fileMeta.school_name) metaItems.push(['School', state.fileMeta.school_name]);
        if (state.fileMeta.school_id) metaItems.push(['School ID', state.fileMeta.school_id]);
        if (state.fileMeta.school_year) metaItems.push(['School Year', state.fileMeta.school_year]);
        if (state.fileMeta.grade_level) metaItems.push(['Grade Level', state.fileMeta.grade_level]);
        if (state.fileMeta.section) metaItems.push(['Section', state.fileMeta.section]);
        const metaHtml = metaItems.length
            ? `<div class="s1-meta-row">${metaItems.map(([k, v]) => `<span class="s1-meta-item"><span class="s1-meta-k">${esc(k)}</span> ${esc(v)}</span>`).join('')}</div>`
            : '';

        el.fileMeta.style.display = 'block';
        el.fileMeta.innerHTML = `
            <div class="s1-file-card">
                <div class="s1-file-header">
                    <div class="s1-file-icon"><i class="fas fa-file-csv"></i></div>
                    <div class="s1-file-info">
                        <div class="s1-file-name">${esc(state.file.name)}</div>
                        <div class="s1-file-detail">${state.rows.length} learner${state.rows.length !== 1 ? 's' : ''} found</div>
                    </div>
                    <button class="s1-remove-btn" id="liswiz-undo-file" type="button" title="Remove file"><i class="fas fa-xmark"></i></button>
                </div>
                ${metaHtml}
            </div>`;
        el.fileMeta.querySelector('#liswiz-undo-file')?.addEventListener('click', () => { resetAll(); }, { once: true });

        // Status note
        if (missingReq.length) {
            const labels = { lrn: 'LRN', name: 'Name', sex: 'Sex', birth_date: 'Birth Date' };
            const missingLabels = missingReq.map((k) => labels[k] || k);
            el.step1Note.className = 'liswiz-ss-status status-error';
            el.step1Note.innerHTML = `<i class="fas fa-circle-xmark"></i> Missing required column${missingReq.length > 1 ? 's' : ''}: <b>${missingLabels.map(esc).join(', ')}</b>. Please check your file and re-upload.`;
            el.step1Note.style.display = '';
        } else if (errs > 0) {
            el.step1Note.className = 'liswiz-ss-status status-warning';
            el.step1Note.innerHTML = `<i class="fas fa-triangle-exclamation"></i> ${errs} potential issue${errs > 1 ? 's' : ''} detected — full validation happens on the next step.`;
            el.step1Note.style.display = '';
        } else {
            el.step1Note.className = 'liswiz-ss-status status-success';
            el.step1Note.innerHTML = `<i class="fas fa-circle-check"></i> File looks good. Click <b>Next</b> to review and import.`;
            el.step1Note.style.display = '';
        }

        el.next1.disabled = missingReq.length > 0 || state.rows.length === 0;
    }

    /* ------------------------- lookups + settings ------------------------- */

    async function loadLookups() {
        const [sy, gl, et] = await Promise.all([
            axios.get(`${API}/school_years/school_years.php`, { params: { operation: 'getAllSchoolYears' } }).then((r) => r.data).catch(() => []),
            axios.get(`${API}/grade_levels/grade_levels.php`, { params: { operation: 'getAllGradeLevels' } }).then((r) => r.data).catch(() => []),
            axios.get(`${API}/enrollment_types/enrollment_types.php`, { params: { operation: 'getAllEnrollmentTypes' } }).then((r) => r.data).catch(() => [])
        ]);
        state.schoolYears = Array.isArray(sy) ? sy : [];
        state.gradeLevels = Array.isArray(gl) ? gl : [];
        state.enrollmentTypes = Array.isArray(et) ? et : [];

        el.sy.innerHTML = ['<option value="">— Select School Year —</option>']
            .concat(state.schoolYears.map((r) => {
                const active = Number(r.is_active) === 1;
                return `<option value="${Number(r.school_year_id)}">${esc(r.year_label)}${active ? ' (current)' : ''}</option>`;
            })).join('');
        state.settings.schoolYearId = null;

        if (el.grade) {
            const orderedGradeLevels = [...state.gradeLevels].sort((a, b) =>
                Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0)
            );
            el.grade.innerHTML = ['<option value="">— Select grade level —</option>']
                .concat(orderedGradeLevels.map((g) => `<option value="${Number(g.grade_level_id)}">${esc(g.grade_name)}</option>`)).join('');
        }
        if (el.etype && state.enrollmentTypes.length) {
            el.etype.innerHTML = state.enrollmentTypes.map((t) =>
                `<option value="${Number(t.enrollment_type_id)}">${esc(t.type_name)}</option>`).join('');
            const fresh = state.enrollmentTypes.find((t) => /^(new|new enrollee)/i.test(String(t.type_name || '').trim()));
            state.settings.enrollmentTypeId = fresh ? Number(fresh.enrollment_type_id) : Number(state.enrollmentTypes[0].enrollment_type_id);
            el.etype.value = String(state.settings.enrollmentTypeId);
        }
    }

    function normalizeLookupText(value) {
        return String(value ?? '').toLowerCase()
            .replace(/\([^)]*\)/g, ' ')
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function gradeWordToNumber(word) {
        const words = {
            one: 1, first: 1,
            two: 2, second: 2,
            three: 3, third: 3,
            four: 4, fourth: 4,
            five: 5, fifth: 5,
            six: 6, sixth: 6,
            seven: 7, seventh: 7,
            eight: 8, eighth: 8,
            nine: 9, ninth: 9,
            ten: 10, tenth: 10,
            eleven: 11, eleventh: 11,
            twelve: 12, twelfth: 12
        };
        return words[String(word || '').toLowerCase()] || null;
    }

    function romanGradeToNumber(roman) {
        const romans = {
            i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6,
            vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12
        };
        return romans[String(roman || '').toLowerCase()] || null;
    }

    function gradeCandidateLabels(value) {
        const wanted = normalizeLookupText(value);
        if (!wanted) return [];

        if (/kinder|kindergarten|prep|preparatory/.test(wanted)) return [];

        const candidates = [wanted];

        const numeric = wanted.match(/\b0*(\d{1,2})\b/);
        if (numeric) {
            const gradeNumber = Number(numeric[1]);
            if (gradeNumber > 0) {
                candidates.push(
                    String(gradeNumber),
                    `grade ${gradeNumber}`,
                    `gr ${gradeNumber}`,
                    `g ${gradeNumber}`,
                    `year ${gradeNumber}`,
                    `level ${gradeNumber}`
                );
            }
        }

        const word = wanted.match(/\b(one|first|two|second|three|third|four|fourth|five|fifth|six|sixth|seven|seventh|eight|eighth|nine|ninth|ten|tenth|eleven|eleventh|twelve|twelfth)\b/);
        if (word) {
            const gradeNumber = gradeWordToNumber(word[1]);
            if (gradeNumber) candidates.push(String(gradeNumber), `grade ${gradeNumber}`);
        }

        const roman = wanted.match(/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)\b/);
        if (roman) {
            const gradeNumber = romanGradeToNumber(roman[1]);
            if (gradeNumber) candidates.push(String(gradeNumber), `grade ${gradeNumber}`);
        }

        return [...new Set(candidates.filter(Boolean))];
    }

    function normalizeSchoolYear(value) {
        const raw = String(value ?? '').trim();
        const m = raw.match(/(\d{4})\s*[-–—]\s*(\d{4})/);
        return m ? `${m[1]}-${m[2]}` : normalizeLookupText(raw);
    }

    function findDetectedSchoolYearId() {
        const wanted = normalizeSchoolYear(state.fileMeta.school_year);
        if (!wanted) return null;
        const match = state.schoolYears.find((sy) => normalizeSchoolYear(sy.year_label) === wanted);
        return match ? Number(match.school_year_id) : null;
    }

    function findDetectedGradeLevelId() {
        const wanted = gradeCandidateLabels(state.fileMeta.grade_level || state.rows[0]?.grade_level || '');
        if (!wanted.length) return null;
        const match = state.gradeLevels.find((g) => {
            const gradeNames = gradeCandidateLabels(g.grade_name);
            return wanted.some((candidate) => gradeNames.includes(candidate));
        });
        if (match) return Number(match.grade_level_id);
        return null;
    }

    function applyDetectedSchoolYearAndGrade({ overwrite = false } = {}) {
        const schoolYearId = findDetectedSchoolYearId();
        if (schoolYearId && (overwrite || !state.settings.schoolYearId)) {
            state.settings.schoolYearId = schoolYearId;
            if (el.sy) el.sy.value = String(schoolYearId);
        }
        const gradeLevelId = findDetectedGradeLevelId();
        if (gradeLevelId && (overwrite || !state.settings.defaultGradeLevelId)) {
            state.settings.defaultGradeLevelId = gradeLevelId;
            if (el.grade) el.grade.value = String(gradeLevelId);
        }
    }

    function applyDetectedSection({ overwrite = false } = {}) {
        const wanted = normalizeLookupText(state.fileMeta.section || state.rows[0]?.section || '');
        if (!wanted || (!overwrite && state.settings.fallbackSectionId)) return false;
        const matches = state.sections.filter((s) => normalizeLookupText(s.section_name) === wanted);
        if (matches.length !== 1) return false;
        const section = matches[0];
        if (Number(section.available_slots || 0) <= 0) return false;
        state.settings.fallbackSectionId = Number(section.section_id);
        if (el.sections) el.sections.value = String(section.section_id);
        return true;
    }

    function describeDetectedSectionIssue() {
        const raw = String(state.fileMeta.section || state.rows[0]?.section || '').trim();
        if (!raw) return 'Section was not detected from the file header.';
        if (state.sectionAccessMessage) return state.sectionAccessMessage;
        if (state.sectionsError) return state.sectionsError;
        const wanted = normalizeLookupText(raw);
        const matches = state.sections.filter((s) => normalizeLookupText(s.section_name) === wanted);
        if (matches.length > 1) return `Detected section "${raw}" matched more than one section. Please make section names unique for this school year and grade level.`;
        if (matches.length === 1 && Number(matches[0].available_slots || 0) <= 0) return `Detected section "${raw}" is already full.`;
        return `Detected section "${raw}" was not found for the detected school year and grade level.`;
    }

    async function refreshDetectedSectionAccess() {
        const raw = String(state.fileMeta.section || state.rows[0]?.section || '').trim();
        state.sectionAccessMessage = '';
        state.sectionAccess = null;
        if (!raw || !state.settings.schoolYearId || !state.settings.defaultGradeLevelId) return null;
        const res = await axios.get(`${API}/sections/sections.php`, {
            params: {
                operation: 'checkSectionAccess',
                school_year_id: state.settings.schoolYearId,
                grade_level_id: state.settings.defaultGradeLevelId,
                section_name: raw
            }
        }).then((r) => r.data).catch((error) => ({
            success: false,
            message: getErrorMessage(error, 'Could not verify section access.')
        }));
        state.sectionAccess = res;
        if (res?.message) state.sectionAccessMessage = res.message;
        return res;
    }

    async function loadSections() {
        const gid = state.settings.defaultGradeLevelId;
        const syId = state.settings.schoolYearId;
        state.sections = [];
        state.sectionsError = '';
        state.settings.fallbackSectionId = null;
        if (!gid || !syId) {
            if (el.sections) el.sections.innerHTML = '<option value="">— Select grade first —</option>';
            return;
        }
        const res = await axios.get(`${API}/sections/sections.php`, {
            params: { operation: 'getSectionsByGradeLevel', grade_level_id: gid, school_year_id: syId }
        }).catch((error) => {
            state.sectionsError = getErrorMessage(error, 'Could not load sections for the detected school year and grade level.');
            return { data: [] };
        });
        const list = Array.isArray(res.data) ? res.data : [];
        list.sort((a, b) => Number(b.available_slots || 0) - Number(a.available_slots || 0));
        state.sections = list;
        // Preserve the user's previous selection if still valid
        const prevSelection = state.settings.fallbackSectionId;
        const stillValid = prevSelection && list.some((s) => Number(s.section_id) === prevSelection && Number(s.available_slots || 0) > 0);
        state.settings.fallbackSectionId = stillValid ? prevSelection : null;
        if (el.sections) {
            el.sections.innerHTML = ['<option value="">— Select Section —</option>']
                .concat(list.map((s) => {
                    const slots = Number(s.available_slots || 0);
                    return `<option value="${Number(s.section_id)}"${slots <= 0 ? ' disabled' : ''}>${esc(s.section_name)} (${slots} slot${slots !== 1 ? 's' : ''})</option>`;
                })).join('');
            if (state.settings.fallbackSectionId) {
                el.sections.value = String(state.settings.fallbackSectionId);
            }
        }
        applyDetectedSection();
    }

    /* ---------------------- server dry-run (steps 2) ----------------------- */

    async function startAndStage() {
        // 1. start (file-level assertions run server-side)
        const start = await axios.post(`${API}/learner_registration/learner_registration.php?operation=startLisImport`, {
            school_year_id: state.settings.schoolYearId,
            file_school_id: state.fileMeta.school_id,
            file_school_name: state.fileMeta.school_name,
            file_school_year: state.fileMeta.school_year,
            file_name: state.file?.name || null,
            file_size_kb: state.file?.size ? Math.round(state.file.size / 1024) : null,
            total_rows: state.rows.length,
            file_headers: state.headers
        }).then((r) => r.data);
        if (!start?.success) throw new Error(start?.message || 'Failed to start import');
        state.importId = Number(start.import_id);
        if (start.school_year_id) state.settings.schoolYearId = Number(start.school_year_id);

        // 2. stage in batches of 100
        for (let i = 0; i < state.rows.length; i += 100) {
            const batch = state.rows.slice(i, i + 100);
            const res = await axios.post(`${API}/learner_registration/learner_registration.php?operation=stageLisImportRows`, {
                import_id: state.importId, rows: batch
            }).then((r) => r.data);
            if (!res?.success) throw new Error(res?.message || 'Failed to stage rows');
        }
    }

    async function runValidation() {
        const res = await axios.post(`${API}/learner_registration/learner_registration.php?operation=validateLisImport`, {
            import_id: state.importId,
            default_grade_level_id: state.settings.defaultGradeLevelId,
            fallback_section_id: state.settings.fallbackSectionId,
            enrollment_type_id: state.settings.enrollmentTypeId
        }).then((r) => r.data);
        if (!res?.success) throw new Error(res?.message || 'Validation failed');
        const prev = await axios.get(`${API}/learner_registration/learner_registration.php`, {
            params: { operation: 'getLisImportPreview', import_id: state.importId }
        }).then((r) => r.data);
        if (!prev?.success) throw new Error(prev?.message || 'Failed to load preview');
        state.preview = { rows: prev.rows || [], summary: res.summary || null, capacity: prev.capacity || [] };
    }

    /* Column definitions matching the spreadsheet entry */
    const RV_COLUMNS = [
        { key: 'lrn',            raw: 'raw_lrn',            norm: 'norm_lrn',         label: 'LRN',                       cls: 'col-lrn' },
        { key: 'name',           raw: 'raw_name',           norm: null,               label: 'Name (Last, First Middle)', cls: 'col-name' },
        { key: 'sex',            raw: 'raw_sex',            norm: 'norm_sex',         label: 'Sex',                       cls: 'col-sex' },
        { key: 'birth_date',     raw: 'raw_birth_date',     norm: 'norm_birth_date',  label: 'Birth Date',                cls: 'col-date' },
        { key: 'age_by_june',    raw: 'raw_age_by_june',    norm: null,               label: 'Age',                       cls: 'col-age' },
        { key: 'birth_province', raw: 'raw_birth_province', norm: null,               label: 'Birth Place',               cls: 'col-place' },
        { key: 'mother_tongue',  raw: 'raw_mother_tongue',  norm: null,               label: 'Mother Tongue',             cls: '' },
        { key: 'ip_group',       raw: 'raw_ip_group',       norm: null,               label: 'IP (Ethnic)',               cls: '' },
        { key: 'religion',       raw: 'raw_religion',       norm: null,               label: 'Religion',                  cls: '' },
        { key: 'house_street',   raw: 'raw_house_street',   norm: null,               label: 'House/Street',              cls: 'col-addr' },
        { key: 'barangay',       raw: 'raw_barangay',       norm: null,               label: 'Barangay',                  cls: '' },
        { key: 'municipality',   raw: 'raw_municipality',   norm: null,               label: 'Municipality',              cls: '' },
        { key: 'province',       raw: 'raw_province',       norm: null,               label: 'Province',                  cls: '' },
        { key: 'father_name',    raw: 'raw_father_name',    norm: null,               label: 'Father',                    cls: '' },
        { key: 'mother_name',    raw: 'raw_mother_name',    norm: null,               label: 'Mother',                    cls: '' },
        { key: 'guardian_name',  raw: 'raw_guardian_name',   norm: null,               label: 'Guardian',                  cls: '' },
        { key: 'guardian_rel',   raw: 'raw_guardian_rel',    norm: null,               label: 'Relation',                  cls: '' },
        { key: 'contact_number', raw: 'raw_contact_number', norm: 'norm_contact_number', label: 'Contact',               cls: 'col-contact' },
        { key: 'remarks',        raw: 'raw_remarks',        norm: null,               label: 'Remarks',                   cls: '' }
    ];

    function describeAction(r) {
        const action = r.planned_action || '';
        const name = r.norm_last_name
            ? `${r.norm_last_name}, ${r.norm_first_name || ''}`.trim()
            : (r.raw_name || 'this learner');
        const messages = Array.isArray(r.messages) ? r.messages : [];
        const isPromotion = messages.some((m) => String(m.field || '').toLowerCase() === 'promotion');
        const sectionUpdate = messages.find((m) => m.code === 'section_transfer'
            || (String(m.field || '').toLowerCase() === 'section' && /section will be updated/i.test(m.message || '')));
        const classification = String(r.detected_entry_classification || '').toLowerCase();
        const sourceStatus = String(r.raw_remarks || '').trim().toLowerCase().replace(/[‐‑‒–—―]/g, '-');
        const lwdNote = Number(r.detected_lwd || 0) === 1
            ? ' The BoSY LWD identifier will be stored separately.'
            : '';
        if (classification === 'transfer-in') {
            return { tag: 'Transfer-In', cls: 'transfer', text: `${esc(name)} is marked Transfer-In and will be enrolled here without local promotion checks.${lwdNote}` };
        }
        if (classification === 'returnee') {
            return { tag: 'Balik-Aral', cls: 'returnee', text: `${esc(name)} is marked Returnee by the source record and will be enrolled for the new school year.${lwdNote}` };
        }
        if (classification === 'late enrollment') {
            return { tag: 'Late Enrollment', cls: 'transfer', text: `${esc(name)} is marked Late Enrollment by the source record and will remain Enrolled.${lwdNote}` };
        }
        if (['transferred out', 'transferred-out', 't/o'].includes(sourceStatus)) {
            return { tag: 'Transferred Out', cls: 'skip', text: `${esc(name)} will be marked Transferred Out. Existing history is preserved and the learner is removed from active rosters.${lwdNote}` };
        }
        if (['dropped out', 'dropped', 'drp'].includes(sourceStatus)) {
            return { tag: 'Dropped', cls: 'skip', text: `${esc(name)} will be marked Dropped. Existing history is preserved and the learner is removed from active rosters.${lwdNote}` };
        }
        if (Number(r.detected_lwd || 0) === 1) {
            return { tag: 'LWD', cls: 'update', text: `${esc(name)} will remain Enrolled and receive the BoSY LWD identifier.${lwdNote}` };
        }
        if (classification === 'promote') {
            return { tag: 'Promote', cls: 'promote', text: `${esc(name)} already exists. This entry will create the next school-year enrollment after promotion checks.` };
        }
        switch (action) {
            case 'Insert': return { tag: 'New', cls: 'insert', text: `Verified new entry. ${esc(name)} will be enrolled.` };
            case 'Update':
                if (isPromotion) return { tag: 'Promotion', cls: 'revive', text: `${esc(name)} already exists. This entry will create the next school-year enrollment.` };
                if (sectionUpdate) return {
                    tag: 'Section Transfer', cls: 'transfer',
                    text: sectionUpdate.code === 'section_transfer'
                        ? `<strong class="rv-transfer-route">${esc(sectionUpdate.from_section)} → ${esc(sectionUpdate.to_section)}</strong>Same school year and grade. Transfer pending import.`
                        : esc(sectionUpdate.message || `${name} will be moved to the imported section.`)
                };
                return { tag: 'Update', cls: 'update', text: `${esc(name)} already exists. This entry will update their record.` };
            case 'Revive': return { tag: 'Returning', cls: 'revive', text: `${esc(name)} was previously removed. This entry will restore and re-enroll.` };
            case 'Skip': {
                const noChanges = messages.some((m) => m.code === 'no_changes');
                return noChanges
                    ? { tag: 'Skipped', cls: 'skip', text: 'No changes detected. Nothing will be written.' }
                    : { tag: 'Excluded', cls: 'skip', text: 'Excluded from import.' };
            }
            default:       return { tag: action || '—', cls: 'skip', text: '' };
        }
    }

    function renderRowMessages(r) {
        const messages = Array.isArray(r.messages) ? r.messages : [];
        if (!messages.length) return '';
        return `<ul class="rv-action-messages">${messages.map((m) => {
            const sev = String(m.severity || 'I').toLowerCase();
            return `<li class="rv-msg-${sev}">${esc(m.message || '')}</li>`;
        }).join('')}</ul>`;
    }

    function renderReview({ showBanner = false } = {}) {
        const s = state.preview.summary || {};
        const transfers = state.preview.rows.filter((r) => r.planned_action === 'Update'
            && r.validation_status !== 'Error' && describeAction(r).cls === 'transfer').length;

        // Chips in toolbar
        const chips = [
            ['New', s.insert ?? 0, '#166534', '#f0fdf4'],
            ['Update', Math.max(0, Number(s.update ?? 0) - transfers), '#1d4ed8', '#eff6ff'],
            ['Section Transfer', transfers, '#0f766e', '#f0fdfa'],
            ['Promote', s.promote ?? 0, '#0369a1', '#f0f9ff'],
            ['Transfer-In', s.transfer_in ?? 0, '#7c2d12', '#fff7ed'],
            ['Balik-Aral', s.returnee ?? 0, '#9a3412', '#fff7ed'],
            ['Late Enrollment', s.late_enrollment ?? 0, '#0369a1', '#eff6ff'],
            ['LWD', s.lwd ?? 0, '#6b21a8', '#faf5ff'],
            ['Returning', s.revive ?? 0, '#7c3aed', '#f5f3ff'],
            ['Skipped', s.skip ?? 0, '#a16207', '#fefce8'],
            ['Error', s.error ?? 0, '#b91c1c', '#fef2f2']
        ].filter(([, v]) => v > 0)
            .map(([l, v, c, bg]) => `<span class="ss-review-chip" style="color:${c};background:${bg}"><b>${v}</b> ${esc(l)}</span>`)
            .join('');
        if (el.reviewChips) el.reviewChips.innerHTML = chips;

        const errors = Number(s.error ?? 0);
        const importable = Number(s.insert ?? 0) + Number(s.update ?? 0) + Number(s.revive ?? 0);
        if (showBanner) {
            const bodyText = errors > 0
                ? `${errors} row(s) have issues and will be skipped.`
                : 'Review and edit values below, then click Confirm &amp; Import.';
            showInfoBanner({
                icon: 'fa-circle-check',
                title: `${importable} learner${importable !== 1 ? 's' : ''} ready to import`,
                body: bodyText,
                autoDismissMs: 3800
            });
        }

        // Build header: action + all SF1 columns
        let thead = '<th class="col-action">Status</th>';
        RV_COLUMNS.forEach((c) => { thead += `<th class="${c.cls}">${esc(c.label)}</th>`; });

        // Build rows
        const tbody = state.preview.rows.map((r) => {
            const excluded = r.planned_action === 'Skip';
            const isError = r.validation_status === 'Error' && !excluded;
            const info = describeAction(r);
            const trCls = excluded ? 'rv-row-excluded' : isError ? 'rv-row-error' : '';

            let cells = `<td class="rv-cell-action"><span class="rv-action-tag rv-action-${info.cls}">${esc(info.tag)}</span><div class="rv-action-desc">${info.text}</div>${renderRowMessages(r)}</td>`;

            RV_COLUMNS.forEach((col) => {
                const val = (col.norm && r[col.norm]) ? r[col.norm] : (r[col.raw] || '');
                cells += `<td><input type="text" data-col="${col.key}" data-rn="${r.row_number}" value="${esc(val)}" class="${val ? 'has-value' : ''}" autocomplete="off" spellcheck="false"></td>`;
            });

            return `<tr class="${trCls}" data-row="${r.row_number}">${cells}</tr>`;
        }).join('');

        const totalCols = RV_COLUMNS.length + 1;
        el.review.innerHTML = `<table class="liswiz-spreadsheet liswiz-rv-table">
            <thead><tr>${thead}</tr></thead>
            <tbody>${tbody || `<tr><td colspan="${totalCols}" style="text-align:center;padding:2rem;color:var(--gray-500)">No rows found.</td></tr>`}</tbody>
        </table>`;

        // Show the review panel and actions
        if (el.reviewPanel) el.reviewPanel.style.display = '';
        if (el.step2Actions) el.step2Actions.style.display = '';

        // Track edits on input fields
        el.review.addEventListener('input', (e) => {
            if (e.target.tagName === 'INPUT' && e.target.dataset.col) {
                e.target.classList.toggle('has-value', e.target.value.trim() !== '');
                const rn = Number(e.target.dataset.rn);
                const col = e.target.dataset.col;
                // Store edit so it can be re-staged before import
                if (!state.editedCells) state.editedCells = {};
                if (!state.editedCells[rn]) state.editedCells[rn] = {};
                state.editedCells[rn][col] = e.target.value;
            }
        });

        const skippable = Number(s.skip ?? 0);
        el.next2.disabled = importable === 0 && skippable === 0;
    }

    /* ----------------------------- commit --------------------------------- */

    function logLine(kind, text) {
        const div = document.createElement('div');
        div.className = kind;
        div.textContent = text;
        el.log.appendChild(div);
        el.log.scrollTop = el.log.scrollHeight;
    }

    function finalImportCounts() {
        const validationSummary = state.preview.summary || {};
        const validationSkipped = Math.max(0, Number(validationSummary.skip ?? 0));
        const validationErrors = Math.max(0, Number(validationSummary.error ?? 0));
        const imported = Math.max(0, Number(state.commit.ok || 0));
        const committedSkipped = Math.max(0, Number(state.commit.skip || 0));
        const committedErrors = Math.max(0, Number(state.commit.err || 0));
        const finalizedErrors = state.commit.finalErrorCount;
        const failed = finalizedErrors !== null && Number.isFinite(Number(finalizedErrors))
            ? Math.max(0, Number(finalizedErrors))
            : validationErrors + committedErrors;

        return {
            total: Math.max(0, Number(state.commit.total || 0)) + validationSkipped + validationErrors,
            imported,
            skipped: committedSkipped + validationSkipped,
            failed
        };
    }

    async function commitAll() {
        showStep(4);
        el.log.innerHTML = '';
        el.summaryCard.style.display = 'none';
        state.commit = { done: false, results: [], ok: 0, skip: 0, err: 0, total: 0, finalErrorCount: null };

        let done = false, guard = 0;
        while (!done && guard < 500) {
            guard++;
            const res = await axios.post(`${API}/learner_registration/learner_registration.php?operation=commitLisImport`, {
                import_id: state.importId,
                chunk_size: 50,
                default_password_mode: state.settings.passwordMode,
                default_password_custom: state.settings.passwordCustom || null,
                enrollment_type_id: state.settings.enrollmentTypeId
            }).then((r) => r.data);
            if (!res?.success) throw new Error(res?.message || 'Commit failed');
            for (const r of res.results || []) {
                state.commit.results.push(r);
                state.commit.total++;
                // Look up learner name from preview data
                const pvRow = (state.preview.rows || []).find((p) => p.row_number == r.row);
                const name = pvRow?.norm_last_name
                    ? `${pvRow.norm_last_name}, ${pvRow.norm_first_name || ''}`.trim()
                    : (pvRow?.raw_name || r.lrn);
                if (r.status === 'Inserted') {
                    state.commit.ok++;
                    logLine('ok', `${name} — Successfully enrolled${r.message ? ' (' + r.message + ')' : ''}`);
                } else if (r.status === 'Updated') {
                    state.commit.ok++;
                    logLine('ok', `${name} — Record updated${r.message ? ' (' + r.message + ')' : ''}`);
                } else if (r.status === 'Skipped') {
                    state.commit.skip++;
                    logLine('warn', `${name} — Skipped: ${r.message || 'no changes needed'}`);
                } else {
                    state.commit.err++;
                    logLine('err', `${name} — Failed: ${r.message || 'unknown error'}`);
                }
            }
            const doneRows = state.commit.total;
            const remaining = Number(res.remaining || 0);
            const total = doneRows + remaining;
            const pct = total > 0 ? Math.round((doneRows / total) * 100) : 100;
            el.prog.style.width = `${pct}%`;
            el.progLabel.innerHTML = remaining > 0 ? `<i class="fas fa-spinner fa-spin"></i> Importing... ${pct}% (${doneRows}/${total})` : '<i class="fas fa-check-circle" style="color:#16a34a"></i> Import complete';
            done = !!res.done;
        }
        state.commit.done = true;

        // pull final skipped/error counts from the batch (includes validation-rejected rows)
        try {
            const fin = await axios.post(`${API}/learner_registration/learner_registration.php?operation=finalizeLisImport`, {
                import_id: state.importId
            }).then((r) => r.data);
            if (fin?.error_count != null) {
                // finalizeLisImport reports the total number of failed rows,
                // including validation failures already present before the
                // commit loop. Keep it separate so validation errors are not
                // counted twice and skipped rows are never shown as failed.
                state.commit.finalErrorCount = Math.max(0, Number(fin.error_count));
            }
        } catch (_) { /* commit already auto-finalizes */ }

        const counts = finalImportCounts();
        el.sumTotal.textContent = String(counts.total);
        el.sumOk.textContent = String(counts.imported);
        el.sumSkip.textContent = String(counts.skipped);
        el.sumErr.textContent = String(counts.failed);

        // Add header
        const summaryHeader = $('liswiz-summary-header');
        if (summaryHeader) {
            if (counts.failed === 0) {
                summaryHeader.innerHTML = '<i class="fas fa-circle-check" style="color:#16a34a"></i> Import complete';
                summaryHeader.style.color = '#16a34a';
            } else if (counts.imported > 0 || counts.skipped > 0) {
                summaryHeader.innerHTML = '<i class="fas fa-triangle-exclamation" style="color:#d97706"></i> Import Completed with Issues';
                summaryHeader.style.color = '#92400e';
            } else {
                summaryHeader.innerHTML = '<i class="fas fa-circle-xmark" style="color:#dc2626"></i> Import Failed';
                summaryHeader.style.color = '#dc2626';
            }
        }
        el.summaryCard.style.display = 'block';
    }

    /* ------------------------------ wiring --------------------------------- */

    function resetAll() {
        state.file = null; state.rows = []; state.headers = [];
        state.headerToKey = new Map(); state.importId = null;
        state.preview = { rows: [], summary: null, capacity: [] };
        state.editedCells = {};
        state.fileMeta = { school_id: null, school_year: null, school_name: null, grade_level: null, section: null };
        el.fileMeta.style.display = 'none'; el.fileMeta.innerHTML = '';
        el.step1Note.style.display = 'none'; el.step1Note.innerHTML = '';
        el.review.innerHTML = '';
        if (el.reviewPanel) el.reviewPanel.style.display = 'none';
        if (el.step2Actions) el.step2Actions.style.display = 'none';
        hideStep2Note();
        el.log.innerHTML = ''; el.summaryCard.style.display = 'none';
        el.next1.disabled = true; el.next2.disabled = true;
        if (el.fileInput) el.fileInput.value = '';
        showStep(1);
    }

    async function handleFile(file) {
        try {
            await parseFile(file);
            applyDetectedSchoolYearAndGrade({ overwrite: true });
            await loadSections();
            renderStep1();
        } catch (e) {
            notify('error', getErrorMessage(e, 'Failed to read file'));
            resetAll();
        }
    }

    function showStep2Note(html, cls) {
        el.step2Note.className = 'liswiz-ss-status' + (cls ? ' ' + cls : '');
        el.step2Note.innerHTML = html;
        el.step2Note.style.display = '';
    }

    function hideStep2Note() {
        el.step2Note.style.display = 'none';
    }

    async function goToReview() {
        // File metadata is the source of truth for assignment.
        applyDetectedSchoolYearAndGrade();
        if (!state.settings.schoolYearId) {
            const raw = String(state.fileMeta.school_year || '').trim();
            const msg = raw
                ? `Detected school year "${esc(raw)}" does not match an existing school year.`
                : 'School Year was not detected from the file header.';
            showStep2Note(`<i class="fas fa-circle-exclamation"></i> ${msg}`, 'status-error');
            showStep(2);
            el.next2.disabled = true;
            return;
        }
        if (!state.settings.defaultGradeLevelId) {
            const raw = String(state.fileMeta.grade_level || state.rows[0]?.grade_level || '').trim();
            const msg = raw
                ? `Detected grade level "${esc(raw)}" does not match an existing grade level.`
                : 'Grade Level was not detected from the file header.';
            showStep2Note(`<i class="fas fa-circle-exclamation"></i> ${msg}`, 'status-error');
            showStep(2);
            el.next2.disabled = true;
            return;
        }

        el.next1.disabled = true;
        if (el.reviewPanel) el.reviewPanel.style.display = 'none';
        if (el.step2Actions) el.step2Actions.style.display = 'none';
        showStep2Note('<i class="fas fa-spinner fa-spin"></i> Validating your data...', 'status-info');
        showStep(2);
        try {
            await loadSections();
            applyDetectedSection({ overwrite: true });
            if (!state.settings.fallbackSectionId) {
                const rawSection = String(state.fileMeta.section || state.rows[0]?.section || '').trim();
                if (!rawSection) {
                    showStep2Note(`<i class="fas fa-circle-exclamation"></i> ${esc(describeDetectedSectionIssue())}`, 'status-error');
                    el.next2.disabled = true;
                    el.next1.disabled = false;
                    return;
                }
                const access = await refreshDetectedSectionAccess();
                const icon = access?.available ? 'fa-spinner fa-spin' : 'fa-triangle-exclamation';
                const tone = access?.available ? 'status-info' : 'status-warning';
                showStep2Note(`<i class="fas ${icon}"></i> ${esc(describeDetectedSectionIssue())} Server validation will verify "${rawSection}" directly...`, tone);
            }
            await startAndStage();
            await runValidation();
            renderReview({ showBanner: true });
            hideStep2Note();
        } catch (e) {
            showStep2Note(`<i class="fas fa-triangle-exclamation"></i> ${esc(getErrorMessage(e, 'Validation failed'))}`, 'status-error');
            el.next2.disabled = true;
        } finally {
            el.next1.disabled = false;
        }
    }

    async function revalidate() {
        if (!state.importId) return;
        showStep2Note('<i class="fas fa-spinner fa-spin"></i> Rechecking with updated settings...', 'status-info');
        try {
            await runValidation();
            renderReview();
            hideStep2Note();
        } catch (e) {
            showStep2Note(`<i class="fas fa-triangle-exclamation"></i> ${esc(getErrorMessage(e, 'Validation failed'))}`, 'status-error');
        }
    }

    function bind() {
        el.uploadZone.addEventListener('click', () => el.fileInput.click());
        el.uploadZone.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
        });
        el.uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); el.uploadZone.classList.add('drag'); });
        el.uploadZone.addEventListener('dragleave', () => el.uploadZone.classList.remove('drag'));
        el.uploadZone.addEventListener('drop', async (e) => {
            e.preventDefault();
            el.uploadZone.classList.remove('drag');
            const f = e.dataTransfer?.files?.[0];
            if (f) await handleFile(f);
        });
        el.fileInput.addEventListener('change', async () => {
            const f = el.fileInput.files?.[0];
            if (f) await handleFile(f);
        });

        el.next1.addEventListener('click', () => { if (!el.next1.disabled) goToReview(); });
        el.back2.addEventListener('click', () => showStep(1));

        el.sy.addEventListener('change', async () => {
            state.settings.schoolYearId = Number(el.sy.value) || null;
            await loadSections();
            // SY change invalidates the whole batch → restart the dry-run
            if (state.importId) { state.importId = null; await goToReview(); }
        });
        el.grade?.addEventListener('change', async () => {
            state.settings.defaultGradeLevelId = Number(el.grade.value) || null;
            await loadSections();
            await revalidate();
        });
        el.sections?.addEventListener('change', async () => {
            state.settings.fallbackSectionId = Number(el.sections.value) || null;
            if (!state.importId && state.file) {
                // First time after section was missing — run full validation
                await goToReview();
            } else {
                await revalidate();
            }
        });
        el.etype?.addEventListener('change', () => {
            state.settings.enrollmentTypeId = Number(el.etype.value) || null;
        });
        el.pwmode?.addEventListener('change', () => {
            state.settings.passwordMode = el.pwmode.value || 'lrn';
            el.pwcustomWrap.style.display = state.settings.passwordMode === 'custom' ? 'block' : 'none';
        });
        el.pwcustom?.addEventListener('input', () => { state.settings.passwordCustom = el.pwcustom.value; });

        el.next2.addEventListener('click', async () => {
            if (el.next2.disabled) return;
            el.next2.disabled = true;
            try {
                // Re-stage any edited cells before committing
                if (state.editedCells && Object.keys(state.editedCells).length > 0) {
                    showStep2Note('<i class="fas fa-spinner fa-spin"></i> Applying your edits...', 'status-info');
                    const editedRows = [];
                    for (const [rn, cols] of Object.entries(state.editedCells)) {
                        const row = { row_number: Number(rn) };
                        // Get all current values from the table row
                        const tr = el.review.querySelector(`tr[data-row="${rn}"]`);
                        if (tr) {
                            tr.querySelectorAll('input[data-col]').forEach((inp) => {
                                row[inp.dataset.col] = inp.value;
                            });
                        }
                        editedRows.push(row);
                    }
                    await axios.post(`${API}/learner_registration/learner_registration.php?operation=stageLisImportRows`, {
                        import_id: state.importId, rows: editedRows
                    }).then((r) => r.data);
                    await runValidation();
                    state.editedCells = {};
                    hideStep2Note();
                }
                await commitAll();
            } catch (e) {
                const details = formatValidationErrorDetails(e);
                const message = [getErrorMessage(e, 'Import failed'), details].filter(Boolean).join(' ');
                notify('error', message);
                logLine('err', message);
            }
            finally { el.next2.disabled = false; }
        });
        el.reset?.addEventListener('click', resetAll);
    }

    (async () => {
        try {
            await loadLookups();
            bind();
            showStep(1);
        } catch (e) {
            notify('error', getErrorMessage(e, 'Failed to initialize import wizard'));
        }
    })();
})();
