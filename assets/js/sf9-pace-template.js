(function (window) {
    'use strict';

    const TEMPLATE_PATHS = [
        '../sample_pages/sf9/SF9_descriptive-SY2026-2027.html',
        '../sf9/SF9_descriptive-SY2026-2027.html'
    ];
    let templateHtml = '';
    let templatePromise = null;

    function load() {
        if (templateHtml) return Promise.resolve(templateHtml);
        if (templatePromise) return templatePromise;

        templatePromise = TEMPLATE_PATHS.reduce((promise, path) => promise.catch(() => {
            const templateUrl = new URL(path, window.location.href);
            return fetch(templateUrl.href, { cache: 'no-cache' }).then((response) => {
                if (!response.ok) throw new Error(`Unable to load the Grade 1 PACE form (${response.status}).`);
                return response.text();
            });
        }), Promise.reject(new Error('Unable to load the Grade 1 PACE form (404).')))
            .then((html) => {
                templateHtml = html;
                return html;
            })
            .catch((error) => {
                templatePromise = null;
                throw error;
            });
        return templatePromise;
    }

    function termPeriodId(data, termNumber) {
        const periods = Array.isArray(data?.quarters) ? data.quarters : [];
        const matchingPeriod = periods.find((period, index) =>
            Number(period?.quarter ?? period?.period_no ?? index + 1) === Number(termNumber)
        ) || periods[Number(termNumber) - 1];
        return Number(matchingPeriod?.grading_period_id || 0);
    }

    function attachRatingField(cell, { area, competency, termNumber, skill = '', catalogKey, periodId, savedRatings, editable }) {
        cell.removeAttribute('contenteditable');
        const savedValue = savedRatings.get(`${periodId}:${catalogKey}`) || '';
        cell.textContent = /^[A-E]$/.test(savedValue) ? savedValue : '';
        if (!editable || !periodId || !catalogKey) return;
        cell.dataset.paceRating = 'true';
        cell.dataset.catalogKey = catalogKey;
        cell.dataset.gradingPeriodId = String(periodId);
        cell.setAttribute('contenteditable', 'true');
        cell.setAttribute('role', 'textbox');
        cell.setAttribute('aria-label', `${area}, ${competency}, Term ${termNumber}${skill ? `, ${skill}` : ''} rating A to E`);
        cell.setAttribute('spellcheck', 'false');
        cell.setAttribute('tabindex', '0');
    }

    function appendPages(documentHtml, data, options = {}) {
        if (!templateHtml) return documentHtml;

        const generatedDocument = new DOMParser().parseFromString(documentHtml, 'text/html');
        const sourceDocument = new DOMParser().parseFromString(templateHtml, 'text/html');
        const sourceStyle = Array.from(sourceDocument.querySelectorAll('style'))
            .map((style) => style.textContent || '').join('\n');
        const paceCssStart = sourceStyle.indexOf('/* ---------- PACE ---------- */');
        const paceCssEnd = sourceStyle.indexOf('/* ---------- Class summary ---------- */', paceCssStart);
        const paceCss = paceCssStart >= 0
            ? sourceStyle.slice(paceCssStart, paceCssEnd >= 0 ? paceCssEnd : undefined)
            : '';
        const rootCss = sourceStyle.match(/:root\s*\{[^}]*\}/)?.[0] || '';
        const style = generatedDocument.createElement('style');
        style.dataset.sf9PaceTemplate = 'true';
        style.textContent = `${rootCss}\n${paceCss}\n.pace-page{break-before:page;page-break-before:always;}\n@media print{.pace-page td.c.L[contenteditable]{background:var(--L)!important}.pace-page td.c.S[contenteditable]{background:var(--S)!important}.pace-page td.c.R[contenteditable]{background:var(--R)!important}.pace-page td.c.W[contenteditable]{background:var(--W)!important}}`;
        generatedDocument.head.appendChild(style);

        const main = generatedDocument.querySelector('main');
        const learner = data?.learner || {};
        const enrollment = data?.enrollment || {};
        const learnerName = String(learner?.name || learner?.learner_name || '').trim();
        const fullName = learnerName || [
            learner?.last_name,
            learner?.first_name,
            learner?.middle_name,
            learner?.name_extension,
        ].filter(Boolean).join(' ');
        const savedRatings = new Map((Array.isArray(data?.pace_ratings) ? data.pace_ratings : []).map((rating) => [
            `${Number(rating.grading_period_id || 0)}:${String(rating.catalog_key || '')}`,
            String(rating.rating_code || '').toUpperCase(),
        ]));
        const requestedPeriodId = options.editablePeriodId === undefined || options.editablePeriodId === null
            ? null
            : Number(options.editablePeriodId || 0);
        const allowEditing = options.editable !== false;
        const pacePages = Array.from(sourceDocument.querySelectorAll('main > section.page.pace-page.grp-pace'));
        let paceTableIndex = 0;
        let competencyTableIndex = 0;

        pacePages.forEach((sourcePage) => {
            const page = sourcePage.cloneNode(true);
            const area = String(page.querySelector('.sect-title')?.textContent || 'PACE').replace(/\s+/g, ' ').trim();
            const idFields = Array.from(page.querySelectorAll('.idrow .ln'));
            [String(learner?.lrn || ''), fullName, String(enrollment?.section || enrollment?.section_name || '')].forEach((value, index) => {
                if (idFields[index]) idFields[index].textContent = value;
            });
            page.querySelectorAll('[contenteditable]').forEach((field) => field.removeAttribute('contenteditable'));

            page.querySelectorAll('table.pace').forEach((table) => {
                paceTableIndex += 1;
                const termHeaders = Array.from(table.querySelectorAll('thead th.t')).map((header, index) => {
                    return Number(header.textContent.match(/\d+/)?.[0] || index + 1);
                });
                let competencyNumber = '0';
                let competencyText = '';
                let competencyRowNumber = 0;
                Array.from(table.querySelectorAll('tbody tr')).forEach((row) => {
                    if (row.classList.contains('sub')) {
                        competencyNumber = '0';
                        competencyText = '';
                        competencyRowNumber = 0;
                        return;
                    }
                    const numberCell = row.querySelector('td.no');
                    const textCell = row.querySelector('td.tx');
                    if (numberCell?.textContent.trim() && numberCell.textContent.trim() !== competencyNumber) {
                        competencyNumber = numberCell.textContent.trim();
                        competencyRowNumber = 0;
                    }
                    if (textCell?.textContent.trim()) competencyText = textCell.textContent.replace(/\s+/g, ' ').trim();
                    competencyRowNumber += 1;
                    const ratingCells = Array.from(row.querySelectorAll('td.c'));
                    ratingCells.forEach((cell, columnIndex) => {
                        const skillCode = ['L', 'S', 'R', 'W'].find((code) => cell.classList.contains(code));
                        if (!skillCode) return;
                        const termNumber = termHeaders[columnIndex] || columnIndex + 1;
                        const periodId = termPeriodId(data, termNumber);
                        const catalogKey = `g1_pace_p${paceTableIndex}_n${competencyNumber}_r${competencyRowNumber}_${skillCode}`;
                        const skillNames = { L: 'Listening', S: 'Speaking', R: 'Reading', W: 'Copying and Guided Writing' };
                        attachRatingField(cell, {
                            area,
                            competency: competencyText || `competency ${competencyNumber}`,
                            termNumber,
                            skill: skillNames[skillCode],
                            catalogKey,
                            periodId,
                            savedRatings,
                            editable: allowEditing && (requestedPeriodId === null || requestedPeriodId === periodId),
                        });
                    });
                });
            });

            page.querySelectorAll('table.lc').forEach((table) => {
                competencyTableIndex += 1;
                let termNumber = 0;
                let competencyNumber = '0';
                let competencyText = '';
                let competencyRowNumber = 0;
                Array.from(table.querySelectorAll('tbody tr')).forEach((row) => {
                    if (row.classList.contains('termrow')) {
                        termNumber = Number(row.textContent.match(/\d+/)?.[0] || 0);
                        competencyNumber = '0';
                        competencyText = '';
                        competencyRowNumber = 0;
                        return;
                    }
                    if (row.classList.contains('sub')) {
                        competencyNumber = '0';
                        competencyText = '';
                        competencyRowNumber = 0;
                        return;
                    }
                    const numberCell = row.querySelector('td.no');
                    const textCell = row.querySelector('td.tx');
                    if (numberCell?.textContent.trim() && numberCell.textContent.trim() !== competencyNumber) {
                        competencyNumber = numberCell.textContent.trim();
                        competencyRowNumber = 0;
                    }
                    if (textCell?.textContent.trim()) competencyText = textCell.textContent.replace(/\s+/g, ' ').trim();
                    competencyRowNumber += 1;
                    const ratingCell = row.querySelector('td.rt:not(.blank)');
                    if (!ratingCell || !termNumber) return;
                    const periodId = termPeriodId(data, termNumber);
                    const catalogKey = `g1_pace_lc${competencyTableIndex}_n${competencyNumber}_r${competencyRowNumber}`;
                    attachRatingField(ratingCell, {
                        area,
                        competency: competencyText || `competency ${competencyNumber}`,
                        termNumber,
                        catalogKey,
                        periodId,
                        savedRatings,
                        editable: allowEditing && (requestedPeriodId === null || requestedPeriodId === periodId),
                    });
                });
            });

            main?.appendChild(page);
        });

        return `<!DOCTYPE html>\n${generatedDocument.documentElement.outerHTML}`;
    }

    function createPaceDocument(data, options = {}) {
        if (!templateHtml) return '';
        const scaffold = new DOMParser().parseFromString(templateHtml, 'text/html');
        const main = scaffold.querySelector('main');
        if (!main) return '';
        Array.from(scaffold.body.children).forEach((child) => {
            if (child !== main) child.remove();
        });
        main.replaceChildren();
        return appendPages(scaffold.documentElement.outerHTML, data, options);
    }

    window.Sf9PaceTemplate = Object.freeze({
        load,
        appendPages,
        createPaceDocument,
    });
})(window);
