/* Shared unsaved-changes confirmation template for pages with editable state. */
(() => {
    if (typeof window.confirmUnsavedChanges === 'function') return;

    window.confirmUnsavedChanges = async ({
        title = 'Unsaved changes',
        message = 'Save your changes before leaving? Unsaved changes will be lost.',
        confirmLabel = 'Leave without saving',
        cancelLabel = 'Stay',
        beforeOpen = null
    } = {}) => {
        const sidebarWasOpen = Boolean(
            document.body?.classList.contains('sidebar-open')
            || document.body?.classList.contains('sidebar-profile-sheet-open')
            || document.querySelector('.sidebar.show')
        );

        if (typeof beforeOpen === 'function') {
            await beforeOpen();
        }

        const closeSidebarAfterStay = () => {
            if (!sidebarWasOpen) return;
            if (typeof window.closeDashboardSidebar === 'function') {
                window.closeDashboardSidebar();
                return;
            }
            document.querySelector('.sidebar')?.classList.remove('show');
            document.body?.classList.remove('sidebar-open', 'sidebar-profile-sheet-open');
            window.closeSidebarProfileMenu?.();
        };

        if (typeof window.Swal !== 'undefined' && typeof window.Swal.fire === 'function') {
            const result = await window.Swal.fire({
                icon: 'warning',
                title,
                text: message,
                showCancelButton: true,
                confirmButtonText: confirmLabel,
                cancelButtonText: cancelLabel,
                confirmButtonColor: '#b42318',
                cancelButtonColor: '#0f4f82',
                reverseButtons: true,
                focusCancel: true,
                allowOutsideClick: false,
                heightAuto: false,
                target: document.body,
                zIndex: 2147483647,
                customClass: {
                    container: 'app-unsaved-dialog-layer',
                    popup: 'app-unsaved-dialog',
                    title: 'app-unsaved-dialog__title',
                    htmlContainer: 'app-unsaved-dialog__message',
                    actions: 'app-unsaved-dialog__actions',
                    confirmButton: 'app-unsaved-dialog__confirm',
                    cancelButton: 'app-unsaved-dialog__cancel'
                }
            });
            const confirmed = result.isConfirmed === true;
            if (!confirmed) closeSidebarAfterStay();
            return confirmed;
        }

        const confirmed = window.confirm(`${title}\n\n${message}\n\n${confirmLabel}?`);
        if (!confirmed) closeSidebarAfterStay();
        return confirmed;
    };
})();
