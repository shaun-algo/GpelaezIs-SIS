(() => {
    'use strict';

    const button = document.getElementById('learnerImportGuideButton');
    const dialog = document.getElementById('learnerImportGuide');
    if (!button || !dialog) return;

    button.addEventListener('click', () => {
        if (!dialog.open) {
            dialog.showModal();
            dialog.querySelector('.learner-import-guide-body').scrollTop = 0;
        }
    });

    dialog.querySelectorAll('[data-close-import-guide]').forEach(closeButton => {
        closeButton.addEventListener('click', () => dialog.close());
    });

    dialog.addEventListener('close', () => button.focus());
})();
