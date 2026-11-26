(function () {
    'use strict';

    const DEFAULT_ITEM_SELECTOR = '.honors-print-sheet, .risk-print-sheet, .cs-print-sheet, .co-teacher-print-sheet';

    function getFitStyle(document) {
        let style = document.getElementById('printPreviewFitStyle');
        if (style) return style;

        style = document.createElement('style');
        style.id = 'printPreviewFitStyle';
        style.textContent = `
            @media screen {
                html.print-preview-fit-mode {
                    min-height: 100%;
                    overflow: auto;
                    background: #e5e9ee;
                }
                html.print-preview-fit-mode body {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: flex-start;
                    width: 100%;
                    min-width: 0;
                    min-height: 100%;
                    margin: 0;
                    padding: 14px 10px 24px;
                    gap: 18px;
                    overflow: auto;
                    background: #e5e9ee;
                    touch-action: pan-x pan-y pinch-zoom;
                }
                html.print-preview-fit-mode .honors-print-pages,
                html.print-preview-fit-mode .risk-print-page,
                html.print-preview-fit-mode .cs-print-page,
                html.print-preview-fit-mode .co-teacher-print-page {
                    display: contents;
                }
                html.print-preview-fit-mode .print-preview-fit-shell {
                    position: relative;
                    flex: 0 0 auto;
                    width: calc(var(--print-preview-page-width) * var(--print-preview-page-scale));
                    height: calc(var(--print-preview-page-height) * var(--print-preview-page-scale));
                    margin: 0 auto;
                    overflow: visible;
                    background: transparent;
                }
                html.print-preview-fit-mode .print-preview-fit-shell > .honors-print-sheet,
                html.print-preview-fit-mode .print-preview-fit-shell > .risk-print-sheet,
                html.print-preview-fit-mode .print-preview-fit-shell > .cs-print-sheet,
                html.print-preview-fit-mode .print-preview-fit-shell > .co-teacher-print-sheet {
                    position: absolute;
                    top: 0;
                    left: 0;
                    margin: 0;
                    transform: scale(var(--print-preview-page-scale));
                    transform-origin: top left;
                }
            }
            @media print {
                html.print-preview-fit-mode {
                    background: #fff;
                }
                html.print-preview-fit-mode body {
                    display: block;
                    min-height: 0;
                    padding: 0;
                    overflow: visible;
                    background: #fff;
                }
                html.print-preview-fit-mode .honors-print-pages,
                html.print-preview-fit-mode .risk-print-page,
                html.print-preview-fit-mode .cs-print-page,
                html.print-preview-fit-mode .co-teacher-print-page {
                    display: block;
                }
                html.print-preview-fit-mode .print-preview-fit-shell {
                    display: contents;
                    width: auto !important;
                    height: auto !important;
                }
                html.print-preview-fit-mode .print-preview-fit-shell > .honors-print-sheet,
                html.print-preview-fit-mode .print-preview-fit-shell > .risk-print-sheet,
                html.print-preview-fit-mode .print-preview-fit-shell > .cs-print-sheet,
                html.print-preview-fit-mode .print-preview-fit-shell > .co-teacher-print-sheet {
                    position: static !important;
                    margin: 0 !important;
                    top: auto !important;
                    left: auto !important;
                    transform: none !important;
                    transform-origin: initial;
                }
                html.print-preview-fit-mode .print-preview-fit-shell > .honors-print-sheet:not(.print-preview-last),
                html.print-preview-fit-mode .print-preview-fit-shell > .risk-print-sheet:not(.print-preview-last),
                html.print-preview-fit-mode .print-preview-fit-shell > .cs-print-sheet:not(.print-preview-last),
                html.print-preview-fit-mode .print-preview-fit-shell > .co-teacher-print-sheet:not(.print-preview-last) {
                    break-after: page;
                    page-break-after: always;
                }
                html.print-preview-fit-mode .print-preview-fit-shell > .honors-print-sheet.print-preview-last,
                html.print-preview-fit-mode .print-preview-fit-shell > .risk-print-sheet.print-preview-last,
                html.print-preview-fit-mode .print-preview-fit-shell > .cs-print-sheet.print-preview-last,
                html.print-preview-fit-mode .print-preview-fit-shell > .co-teacher-print-sheet.print-preview-last {
                    break-after: auto;
                    page-break-after: auto;
                }
            }
        `;
        document.head?.appendChild(style);
        return style;
    }

    function fitPrintPreviewDocument(frame, itemSelector = DEFAULT_ITEM_SELECTOR) {
        const previewDocument = frame?.contentDocument;
        const documentRoot = previewDocument?.documentElement;
        if (!previewDocument || !documentRoot || !previewDocument.body) return;

        const items = Array.from(previewDocument.querySelectorAll(itemSelector));
        if (!items.length) return;

        getFitStyle(previewDocument);

        items.forEach((item, index) => {
            item.classList.toggle('print-preview-last', index === items.length - 1);
            let shell = item.parentElement?.classList.contains('print-preview-fit-shell')
                ? item.parentElement
                : null;

            if (!shell) {
                shell = previewDocument.createElement('div');
                shell.className = 'print-preview-fit-shell';
                item.parentNode?.insertBefore(shell, item);
                shell.appendChild(item);
            }

            const sourceWidth = Number(item.offsetWidth || item.scrollWidth || shell.dataset.previewWidth || 0);
            const sourceHeight = Number(item.offsetHeight || item.scrollHeight || shell.dataset.previewHeight || 0);
            if (!sourceWidth || !sourceHeight) return;

            shell.dataset.previewWidth = String(sourceWidth);
            shell.dataset.previewHeight = String(sourceHeight);

            documentRoot.classList.add('print-preview-fit-mode');
            const frameRect = frame.getBoundingClientRect?.() || {};
            const hostRect = frame.parentElement?.getBoundingClientRect?.() || {};
            const viewportWidth = Number(frameRect.width || frame.clientWidth || hostRect.width || 0);
            const viewportHeight = Number(frameRect.height || frame.clientHeight || hostRect.height || 0);
            // If the modal is still hidden, wait for the visible-layout pass
            // instead of falling back to the paper's own width. That fallback
            // makes the preview render at 100% and appear permanently zoomed.
            if (!viewportWidth || !viewportHeight) return;
            const widthScale = (viewportWidth - 20) / sourceWidth;
            const heightScale = (viewportHeight - 20) / sourceHeight;
            const scale = Math.min(1, Math.max(0.12, Math.min(widthScale, heightScale)));

            shell.style.setProperty('--print-preview-page-width', `${sourceWidth}px`);
            shell.style.setProperty('--print-preview-page-height', `${sourceHeight}px`);
            shell.style.setProperty('--print-preview-page-scale', String(scale));

            // Keep the fit deterministic even when the generated document's
            // responsive rules win the cascade inside the embedded frame.
            shell.style.width = `${sourceWidth * scale}px`;
            shell.style.height = `${sourceHeight * scale}px`;
            item.style.position = 'absolute';
            item.style.top = '0';
            item.style.left = '0';
            item.style.margin = '0';
            item.style.transform = `scale(${scale})`;
            item.style.transformOrigin = 'top left';
        });
    }

    function installPrintPreviewFit(frame, itemSelector) {
        if (!frame || frame.dataset.printPreviewFitInstalled === 'true') return;

        const fit = () => {
            fitPrintPreviewDocument(frame, itemSelector || DEFAULT_ITEM_SELECTOR);
        };

        const fitAfterLayout = () => {
            fit();
            window.requestAnimationFrame(fit);
        };

        frame.addEventListener('load', fitAfterLayout);
        window.addEventListener('resize', fit, { passive: true });

        if (window.ResizeObserver) {
            const observer = new ResizeObserver(fit);
            observer.observe(frame);
            frame._printPreviewFitObserver = observer;
        }

        frame.dataset.printPreviewFitInstalled = 'true';
        fit();
    }

    window.installPrintPreviewFit = installPrintPreviewFit;
    window.fitPrintPreviewDocument = fitPrintPreviewDocument;
    window.refitPrintPreviewFrame = (frame, itemSelector) => {
        if (!frame) return;
        const fit = () => fitPrintPreviewDocument(frame, itemSelector || frame.dataset?.printPreviewItems || DEFAULT_ITEM_SELECTOR);
        window.requestAnimationFrame(() => {
            fit();
            window.requestAnimationFrame(fit);
        });
        window.setTimeout(fit, 360);
    };

    function initializePrintPreviewFits() {
        document.querySelectorAll('iframe[data-print-preview-items]').forEach((frame) => {
            installPrintPreviewFit(frame, frame.dataset.printPreviewItems);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializePrintPreviewFits);
    } else {
        initializePrintPreviewFits();
    }
})();
