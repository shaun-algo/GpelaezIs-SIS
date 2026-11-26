// ===========================
// Reported Posts Module
// ===========================

(function initializeReportedPostsModule() {
    let reportsRequestId = 0;
    let currentReportsView = 'active';

    function formatTimeAgoFromSeconds(seconds) {
        const elapsed = Number(seconds);
        if (!Number.isFinite(elapsed) || elapsed < 60) return 'Just now';

        const minutes = Math.floor(elapsed / 60);
        if (minutes < 60) return `${minutes} min ago`;

        const hours = Math.floor(elapsed / 3600);
        if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;

        const days = Math.floor(elapsed / 86400);
        if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;

        const weeks = Math.floor(days / 7);
        if (days < 30) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;

        const months = Math.floor(days / 30);
        if (days < 365) return `${months} month${months === 1 ? '' : 's'} ago`;

        const years = Math.floor(days / 365);
        return `${years} yr${years === 1 ? '' : 's'} ago`;
    }

    function formatReportTime(value) {
        const parsed = new Date(String(value || '').replace(' ', 'T'));
        if (Number.isNaN(parsed.getTime())) return 'Unknown time';
        const seconds = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
        return formatTimeAgoFromSeconds(seconds);
    }

    function getReporterInitials(name) {
        if (typeof getAccountInitials === 'function') return getAccountInitials(name);
        const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
        return parts.length > 1
            ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
            : (parts[0] || 'U').slice(0, 2).toUpperCase();
    }

    function splitAnnouncementSentences(value) {
        const normalized = String(value || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return [];

        if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
            try {
                const segmented = Array.from(
                    new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(normalized),
                    (part) => String(part.segment || '').trim()
                ).filter(Boolean);
                if (segmented.length) return segmented;
            } catch (_) {
                // Fall through to the lightweight sentence parser below.
            }
        }

        return (normalized.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [])
            .map((sentence) => sentence.trim())
            .filter(Boolean);
    }

    function getAnnouncementPreview(value, sentenceLimit = 2) {
        const sentences = splitAnnouncementSentences(value);
        const visibleSentences = sentences.slice(0, sentenceLimit);
        return {
            text: visibleSentences.join(' '),
            isTruncated: sentences.length > sentenceLimit
        };
    }

    function formatReportedPostDate(value) {
        const parsed = new Date(String(value || '').replace(' ', 'T'));
        if (Number.isNaN(parsed.getTime())) return '';
        return parsed.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    function isReportedPostExpired(value) {
        const parsed = new Date(String(value || '').replace(' ', 'T'));
        return Boolean(value) && !Number.isNaN(parsed.getTime()) && parsed < new Date();
    }

    function getReportedPostBackground(post) {
        if (typeof getAnnouncementBackgroundForAnnouncement === 'function') {
            return getAnnouncementBackgroundForAnnouncement(post);
        }

        const raw = String(post?.message_background || '').trim();
        if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
        if (/^linear-gradient\(\s*\d{1,3}deg,\s*#[0-9a-f]{6}\s+0%,\s*#[0-9a-f]{6}\s+100%\s*\)$/i.test(raw)) return raw;
        return '#ffffff';
    }

    function getReportedPostAttachmentName(value) {
        const path = String(value || '').split(/[?#]/, 1)[0];
        const name = path.split('/').pop() || 'Attachment';
        try {
            return decodeURIComponent(name);
        } catch (_) {
            return name;
        }
    }

    function renderReportedPostPreview(post) {
        const title = String(post?.title || 'Untitled post').trim() || 'Untitled post';
        const body = String(post?.body || '').trim();
        const posterName = String(post?.poster_name || 'Unknown poster').trim() || 'Unknown poster';
        const posterGender = typeof normalizeAccountGender === 'function'
            ? normalizeAccountGender(post?.poster_gender)
            : (String(post?.poster_gender || '').toLowerCase() === 'female'
                ? 'female'
                : String(post?.poster_gender || '').toLowerCase() === 'male' ? 'male' : 'neutral');
        const authorInitials = getReporterInitials(posterName);
        const posterPresenceAccount = {
            ...post,
            is_online: post?.poster_is_online,
            last_seen_seconds_ago: post?.poster_last_seen_seconds_ago,
            last_login_seconds_ago: post?.poster_last_login_seconds_ago
        };
        const authorAvatarMarkup = typeof renderPresenceAvatarMarkup === 'function'
            ? renderPresenceAvatarMarkup({
                initials: authorInitials,
                genderClass: `gender-${posterGender}`,
                account: posterPresenceAccount,
                avatarClass: 'author-avatar',
                ariaLabel: `${posterName} profile`
            })
            : `<div class="author-avatar gender-${escapeHtml(posterGender)}" aria-hidden="true">${escapeHtml(authorInitials)}</div>`;
        const targetAudience = String(post?.target_role_name || 'Everyone');
        const audienceLabel = targetAudience === 'Everyone' ? 'Everyone' : 'Custom audience';
        const audienceIcon = targetAudience === 'Everyone' ? 'fa-earth-americas' : 'fa-users';
        const postedAt = formatReportTime(post?.published_at);
        const expiresAt = formatReportedPostDate(post?.expires_at);
        const isExpired = isReportedPostExpired(post?.expires_at);
        const isPinned = ['1', 'true'].includes(String(post?.is_pinned).toLowerCase());
        const messageBackground = getReportedPostBackground(post);
        const isPlainBackground = typeof isAnnouncementPlainBackground === 'function'
            ? isAnnouncementPlainBackground(messageBackground)
            : String(messageBackground).trim().toLowerCase() === '#ffffff';
        const bodyMarkup = escapeHtml(body || 'No content available.').replace(/\n/g, '<br>');
        const attachmentUrl = String(post?.attachment_url || '').trim();
        const attachmentMarkup = attachmentUrl
            ? `
                <div class="announcement-attachment">
                    <i class="fas fa-paperclip" aria-hidden="true"></i>
                    <div class="attachment-info">
                        <strong>Attachment</strong>
                        <small>${escapeHtml(getReportedPostAttachmentName(attachmentUrl))}</small>
                    </div>
                    <a href="${escapeHtml(attachmentUrl)}"
                       class="btn btn-sm btn-outline"
                       target="_blank"
                       rel="noopener noreferrer"
                       download
                       aria-label="Download attachment">
                        <i class="fas fa-download" aria-hidden="true"></i>
                    </a>
                </div>
            `
            : '';

        return `
            <article class="announcement-card announcement-report-post-preview${isExpired ? ' expired' : ''}${isPinned ? ' pinned' : ''}">
                <div class="announcement-header">
                            <div class="announcement-author">
                        ${authorAvatarMarkup}
                        <div class="author-info">
                            <h4 class="author-name">${escapeHtml(posterName)}</h4>
                            <div class="announcement-meta">
                                <span class="announcement-time">${escapeHtml(postedAt)}</span>
                                ${typeof getAccountPresenceLabel === 'function' && getAccountPresenceLabel(posterPresenceAccount) !== 'Active' ? `<span class="account-presence-label">${escapeHtml(getAccountPresenceLabel(posterPresenceAccount))}</span>` : ''}
                                <span class="announcement-audience-icon" title="${escapeHtml(audienceLabel)}" aria-label="${escapeHtml(audienceLabel)}">
                                    <i class="fas ${audienceIcon}" aria-hidden="true"></i>
                                </span>
                                ${isPinned ? '<span class="pin-badge"><i class="fas fa-thumbtack" aria-hidden="true"></i>Pinned</span>' : ''}
                                ${isExpired ? '<span class="expired-badge"><i class="fas fa-times-circle" aria-hidden="true"></i>Expired</span>' : ''}
                            </div>
                        </div>
                    </div>
                </div>
                <div class="announcement-body">
                    <h3 class="announcement-title">${escapeHtml(title)}</h3>
                    <div class="announcement-content${isPlainBackground ? ' announcement-content--plain' : ''}"
                         style="background: ${escapeHtml(messageBackground)};">
                        <div class="announcement-copy">${bodyMarkup}</div>
                    </div>
                    ${attachmentMarkup}
                </div>
                ${expiresAt ? `
                    <div class="announcement-footer">
                        <div class="announcement-expiry">
                            <i class="fas fa-calendar-times" aria-hidden="true"></i>
                            Expires: ${escapeHtml(expiresAt)}
                        </div>
                    </div>
                ` : ''}
            </article>
        `;
    }

    function renderReporterStack(reports) {
        const reporterList = Array.isArray(reports) ? reports : [];
        const visibleReports = reporterList.slice(0, 3);
        const remainingCount = Math.max(0, reporterList.length - visibleReports.length);
        const avatars = visibleReports.map((report) => {
            const reporterName = String(report.reporter_name || 'Unknown user');
            const genderClass = typeof normalizeAccountGender === 'function'
                ? `gender-${normalizeAccountGender(report.reporter_gender)}`
                : 'gender-neutral';
            const accessibleName = escapeHtml(reporterName);
            const reporterAccount = {
                last_login: report.reporter_last_login,
                last_seen_at: report.reporter_last_seen_at,
                last_seen_seconds_ago: report.reporter_last_seen_seconds_ago,
                last_login_seconds_ago: report.reporter_last_login_seconds_ago,
                is_online: report.reporter_is_online
            };
            const reporterPresence = typeof getAccountPresence === 'function'
                ? getAccountPresence(reporterAccount)
                : { isOnline: false };
            const reporterPresenceLabel = typeof getAccountPresenceLabel === 'function'
                ? getAccountPresenceLabel(reporterAccount)
                : '';

            return `
                <span class="user-avatar announcement-reporter-avatar presence-avatar ${genderClass}"
                      data-presence-state="${reporterPresence.isOnline ? 'online' : 'offline'}"
                      aria-hidden="true"
                      title="${accessibleName}${reporterPresenceLabel ? ` · ${escapeHtml(reporterPresenceLabel)}` : ''}">${escapeHtml(getReporterInitials(reporterName))}<span class="presence-indicator" aria-hidden="true"></span></span>
            `;
        }).join('');
        const overflow = remainingCount > 0
            ? `<span class="announcement-reporter-avatar announcement-reporter-avatar--overflow" aria-hidden="true">+${remainingCount}</span>`
            : '';

        return `
            <div class="announcement-reporter-stack" aria-hidden="true">
                ${avatars}${overflow}
            </div>
        `;
    }

    function isRemovedPost(report) {
        return report?.is_deleted === true || String(report?.is_deleted) === '1';
    }

    function isResolvedPost(report) {
        return String(report?.review_resolution || '') === 'no_issue';
    }

    function parseReportDate(value) {
        const rawValue = String(value || '').trim();
        if (!rawValue) return null;
        const parsed = new Date(rawValue.replace(' ', 'T'));
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    function getReportCaseActivityDate(post, postReports) {
        const activityDates = (Array.isArray(postReports) ? postReports : [])
            .flatMap((report) => [report?.reviewed_at, report?.reported_at])
            .map(parseReportDate)
            .filter(Boolean);
        const publishedDate = parseReportDate(post?.published_at);
        if (publishedDate) activityDates.push(publishedDate);
        return activityDates.sort((first, second) => second.getTime() - first.getTime())[0] || null;
    }

    function getReportDateGroupLabel(value) {
        const date = value instanceof Date ? value : parseReportDate(value);
        if (!date) return 'Date unavailable';

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const dayDifference = Math.floor((todayStart.getTime() - dateStart.getTime()) / 86400000);

        if (dayDifference < 0) return 'Later';
        if (dayDifference === 0) return 'Today';
        if (dayDifference === 1) return 'Yesterday';
        if (dayDifference <= 7) return 'This week';
        if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return 'This month';
        if (date.getFullYear() === now.getFullYear() - 1) return 'Last year';
        if (date.getFullYear() === now.getFullYear()) {
            return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        }
        return String(date.getFullYear());
    }

    function groupReportedPostsByDate(postGroups) {
        const dateGroups = new Map();
        (Array.isArray(postGroups) ? postGroups : []).forEach((postGroup) => {
            const activityDate = getReportCaseActivityDate(postGroup.post, postGroup.reports);
            const label = getReportDateGroupLabel(activityDate);
            if (!dateGroups.has(label)) dateGroups.set(label, { label, cases: [], sortTime: 0 });
            const group = dateGroups.get(label);
            group.cases.push({ ...postGroup, activityTime: activityDate?.getTime() || 0 });
            group.sortTime = Math.max(group.sortTime, activityDate?.getTime() || 0);
        });

        return [...dateGroups.values()]
            .sort((first, second) => second.sortTime - first.sortTime)
            .map((group) => ({
                ...group,
                cases: group.cases.sort((first, second) => second.activityTime - first.activityTime)
            }));
    }

    function reportDateGroupId(label) {
        return `announcementReportDate-${String(label || 'date')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')}`;
    }

    function updateReportedPostsView(view) {
        currentReportsView = ['removed', 'resolved'].includes(view) ? view : 'active';
        const title = document.getElementById('reportedPostsTitle');
        const backButton = document.querySelector('[data-reports-back]');

        if (title) {
            title.textContent = currentReportsView === 'removed'
                ? 'Removed posts'
                : currentReportsView === 'resolved' ? 'Resolved reports' : 'Reported posts';
        }
        if (backButton) backButton.hidden = currentReportsView === 'active';
    }

    function positionReportActionMenu(menu, trigger, event) {
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
        const triggerRect = trigger.getBoundingClientRect();
        const anchorX = event.clientX > 0 ? event.clientX : triggerRect.left + triggerRect.width / 2;
        const anchorY = event.clientY > 0 ? event.clientY : triggerRect.top + triggerRect.height / 2;
        const margin = 12;

        Object.assign(menu.style, {
            position: 'fixed',
            inset: 'auto',
            left: '0px',
            top: '0px',
            right: 'auto',
            bottom: 'auto',
            width: `${Math.min(224, viewportWidth - margin * 2)}px`,
            minWidth: '0',
            minHeight: '0',
            maxHeight: `${Math.max(120, viewportHeight - margin * 2)}px`,
            padding: '0.5rem',
            borderBottom: '1px solid var(--app-line)',
            overflowY: 'auto',
            overflowX: 'hidden',
            borderRadius: '0.75rem',
            animation: 'none',
            zIndex: '22'
        });

        const menuRect = menu.getBoundingClientRect();
        let left = anchorX + 10;
        if (left + menuRect.width > viewportWidth - margin) left = anchorX - menuRect.width - 10;
        left = Math.max(margin, Math.min(left, viewportWidth - menuRect.width - margin));

        let top = anchorY + 10;
        if (top + menuRect.height > viewportHeight - margin) top = anchorY - menuRect.height - 10;
        top = Math.max(margin, Math.min(top, viewportHeight - menuRect.height - margin));

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }

    function renderReportedPosts(reports, view = currentReportsView) {
        const list = document.getElementById('announcementReportsList');
        if (!list) return;

        const showingRemoved = view === 'removed';
        const showingResolved = view === 'resolved';
        const groups = new Map();
        (Array.isArray(reports) ? reports : []).filter((report) => {
            if (showingRemoved) return isRemovedPost(report);
            if (showingResolved) return !isRemovedPost(report) && isResolvedPost(report);
            return !isRemovedPost(report) && !isResolvedPost(report);
        }).forEach((report) => {
            const key = String(report.announcement_id || '');
            if (!key) return;
            if (!groups.has(key)) groups.set(key, { post: report, reports: [] });
            groups.get(key).reports.push(report);
        });

        if (!groups.size) {
            list.innerHTML = `
                <div class="announcement-reports-empty" role="status">
                    <span class="announcement-reports-empty__icon announcement-reports-empty__video" aria-hidden="true"><video class="mp4-surface-blend empty-state-video" autoplay loop muted playsinline preload="metadata" aria-hidden="true"><source src="../assets/icons/search.mp4" type="video/mp4"></video></span>
                    <h3>${showingRemoved ? 'No removed posts' : showingResolved ? 'No resolved reports' : 'No active reports to review'}</h3>
                    <p>${showingRemoved
                        ? 'Posts removed from the school feed will appear here with their report details.'
                        : showingResolved
                            ? 'Reports marked as no issue found will appear here.'
                            : 'New reports will appear here with the post and the people who submitted them.'}</p>
                </div>
            `;
            return;
        }

        const renderReportCase = ({ post, reports: postReports }) => {
            const postId = Number(post.announcement_id || 0);
            const postTitle = String(post.title || 'Untitled post');
            const posterName = String(post.poster_name || 'Unknown poster');
            const isRemoved = isRemovedPost(post);
            const postBody = String(post.body || '').trim();
            const postPreview = getAnnouncementPreview(postBody);
            const postPreviewMarkup = `${escapeHtml(postPreview.text).replace(/\n/g, '<br>')}${postPreview.isTruncated ? '<span class="announcement-report-post__ellipsis" aria-label="More content follows">....</span>' : ''}`;
            const reporterStack = renderReporterStack(postReports);
            const reportPostData = escapeHtml(JSON.stringify({
                announcement_id: post.announcement_id,
                title: post.title,
                body: post.body,
                poster_name: post.poster_name,
                poster_gender: post.poster_gender,
                poster_last_login: post.poster_last_login,
                poster_last_seen_at: post.poster_last_seen_at,
                poster_last_seen_seconds_ago: post.poster_last_seen_seconds_ago,
                poster_last_login_seconds_ago: post.poster_last_login_seconds_ago,
                poster_is_online: post.poster_is_online,
                published_at: post.published_at,
                expires_at: post.expires_at,
                attachment_url: post.attachment_url,
                is_pinned: post.is_pinned,
                message_background: post.message_background,
                target_role_name: post.target_role_name
            }));
            const isResolved = isResolvedPost(post);
            const reviewedState = isResolved
                ? '<span class="announcement-report-case__state is-resolved">Resolved · no issue found</span>'
                : '';
            const reportReasonsMarkup = postReports.map((report) => `
                <article class="announcement-report-reason-detail">
                    <div class="announcement-report-reason-detail__meta">
                        <strong>${escapeHtml(String(report.reporter_name || 'Unknown user'))}</strong>
                        <time datetime="${escapeHtml(String(report.reported_at || ''))}">${escapeHtml(formatReportTime(report.reported_at))}</time>
                    </div>
                    <p>${escapeHtml(String(report.report_reason || 'Reason not provided'))}</p>
                </article>
            `).join('');
            const removedState = isRemoved
                ? '<span class="announcement-report-case__state is-removed">Removed</span>'
                : '';
            const reportStateMarkup = `${removedState}${reviewedState}`;
            const reportStateLine = reportStateMarkup
                ? `<p class="announcement-report-post__attribution">${reportStateMarkup}</p>`
                : '';
            const menuId = `announcementReportActions-${postId}`;

            return `
                <article class="announcement-report-case${isRemoved ? ' is-removed' : ''}" data-report-case data-announcement-id="${postId}">
                    <div class="announcement-menu announcement-report-case__menu">
                        <div class="announcement-action-menu announcement-report-action-menu"
                             id="${menuId}"
                             data-report-action-menu
                             role="menu"
                             hidden>
                            <button type="button" role="menuitem" data-report-view-post data-report-post="${reportPostData}">
                                <i class="fas fa-eye announcement-action-icon" aria-hidden="true"></i>
                                View post
                            </button>
                            ${isRemoved ? '' : `
                                <button type="button" role="menuitem" class="is-danger" data-report-remove-post>
                                    <i class="fas fa-trash-can announcement-action-icon" aria-hidden="true"></i>
                                    Remove post
                                </button>
                            `}
                            ${!isRemoved && !isResolved ? `
                                <button type="button" role="menuitem" data-report-resolve>
                                    <i class="fas fa-circle-check announcement-action-icon" aria-hidden="true"></i>
                                    Mark resolved — no issue found
                                </button>
                            ` : ''}
                        </div>
                    </div>
                    <div class="announcement-report-case__details" data-report-details>
                        <section class="announcement-report-post"
                                 aria-labelledby="announcementReportPost-${postId}"
                                 role="button"
                                 tabindex="0"
                                 aria-haspopup="menu"
                                 aria-expanded="false"
                                 aria-controls="${menuId}"
                                 aria-label="Post actions for ${escapeHtml(postTitle)}"
                                 data-report-card-toggle>
                            <p class="announcement-report-post__byline" id="announcementReportPost-${postId}">
                                <span>Posted by ${escapeHtml(posterName)}</span>
                                <time datetime="${escapeHtml(String(post.published_at || ''))}">${escapeHtml(formatReportTime(post.published_at))}</time>
                            </p>
                            <h4>${escapeHtml(postTitle)}</h4>
                            <p class="announcement-report-post__body">${postPreviewMarkup}</p>
                            ${reportStateLine}
                        </section>
                        <section class="announcement-reporters"
                                 aria-labelledby="announcementReporters-${postId}"
                                 role="button"
                                 tabindex="0"
                                 aria-haspopup="dialog"
                                 aria-expanded="false"
                                 aria-controls="announcementReportReasonsDialog"
                                 aria-label="View all ${postReports.length} report ${postReports.length === 1 ? 'reason' : 'reasons'}"
                                 data-report-reasons-trigger>
                            <div class="announcement-reporters__header">
                                <p class="announcement-report-label" id="announcementReporters-${postId}">Reports</p>
                                ${reporterStack}
                            </div>
                        </section>
                    </div>
                    <div class="announcement-report-reasons-data" data-report-reasons hidden>${reportReasonsMarkup}</div>
                </article>
            `;
        };

        list.innerHTML = groupReportedPostsByDate([...groups.values()]).map(({ label, cases }) => {
            const groupId = reportDateGroupId(label);
            return `
                <section class="announcement-report-date-group" aria-labelledby="${groupId}">
                    <h2 class="announcement-report-date-heading" id="${groupId}">${escapeHtml(label)}</h2>
                    <div class="announcement-report-date-list">
                        ${cases.map(renderReportCase).join('')}
                    </div>
                </section>
            `;
        }).join('');
    }

    async function loadReportedPosts(view = currentReportsView) {
        const list = document.getElementById('announcementReportsList');
        if (!list) return;

        updateReportedPostsView(view);
        const requestId = ++reportsRequestId;
        list.classList.add('is-loading');
        try {
            const response = await axios.get(`${window.API_BASE}/announcements/announcements.php`, {
                params: {
                    operation: 'getAnnouncementReports',
                    limit: 250,
                    view: currentReportsView,
                    _: Date.now()
                }
            });
            if (requestId !== reportsRequestId) return;
            if (!response.data?.success) {
                throw new Error(response.data?.message || 'Unable to load post feedback');
            }
            renderReportedPosts(response.data.data?.reports || [], currentReportsView);
        } catch (error) {
            if (requestId === reportsRequestId) {
                const message = error.response?.data?.message || error.message || 'Unable to load post feedback.';
                list.innerHTML = `
                    <div class="announcement-reports-empty announcement-reports-empty--error" role="alert">
                        <span class="announcement-reports-empty__icon" aria-hidden="true"><i class="fas fa-triangle-exclamation"></i></span>
                        <h3>Post feedback is unavailable</h3>
                        <p>${escapeHtml(message)}</p>
                        <button type="button" class="btn btn-outline btn-sm" onclick="loadReportedPosts()">Try again</button>
                    </div>
                `;
            }
        } finally {
            if (requestId === reportsRequestId) {
                list.classList.remove('is-loading');
            }
        }
    }

    async function removeReportedPost(announcementId, item, button) {
        const confirmed = await window.showConfirmationDialog({
            title: 'Remove this post?',
            message: 'This post will be removed from the school feed and will no longer be visible to users.',
            confirmText: 'Remove post',
            cancelText: 'Keep post',
            icon: 'fa-trash-can'
        });
        if (!confirmed) return;
        if (button) {
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
        }

        try {
            const response = await axios.post(
                `${window.API_BASE}/announcements/announcements.php?operation=deleteAnnouncement`,
                { announcement_id: announcementId }
            );
            if (!response.data?.success) {
                throw new Error(response.data?.message || 'Unable to remove post');
            }
            item?.classList.add('is-removed');
            await loadReportedPosts(currentReportsView);
            showNotification('Post removed from the school feed.', 'success');
        } catch (error) {
            if (button) {
                button.disabled = false;
                button.removeAttribute('aria-busy');
            }
            showNotification(error.response?.data?.message || error.message || 'Unable to remove post.', 'error');
        }
    }

    async function resolveReportedPost(announcementId, item, button) {
        if (button) {
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
        }

        try {
            const response = await axios.post(
                `${window.API_BASE}/announcements/announcements.php?operation=resolveAnnouncementReports`,
                { announcement_id: announcementId, resolution: 'no_issue' }
            );
            if (!response.data?.success) {
                throw new Error(response.data?.message || 'Unable to resolve this report');
            }
            item?.classList.add('is-resolved');
            await loadReportedPosts('active');
            showNotification('Report resolved. No issue was found.', 'success');
        } catch (error) {
            if (button) {
                button.disabled = false;
                button.removeAttribute('aria-busy');
            }
            showNotification(error.response?.data?.message || error.message || 'Unable to resolve this report.', 'error');
        }
    }

    function initialize() {
        const list = document.getElementById('announcementReportsList');
        if (!list || list.dataset.bound === '1') return;

        const syncMenuSheetState = () => {
            document.body.classList.toggle(
                'announcement-sheet-open',
                Boolean(document.querySelector('[data-reports-view-menu]:not([hidden])'))
            );
        };
        const viewMenu = document.querySelector('[data-reports-view-menu]');
        const reasonsDialog = document.getElementById('announcementReportReasonsDialog');
        const reasonsDialogBody = document.getElementById('announcementReportReasonsBody');
        const postDialog = document.getElementById('announcementReportPostDialog');
        const postDialogBody = document.getElementById('announcementReportPostBody');
        let activeReasonsTrigger = null;
        let activePostTrigger = null;
        const closeReportedPostMenus = (except = null) => {
            list.querySelectorAll('[data-report-action-menu]:not([hidden])').forEach((menu) => {
                if (menu === except) return;
                menu.hidden = true;
                const menuRoot = menu.closest('.announcement-menu');
                menuRoot?.closest('[data-report-case]')?.querySelector('[data-report-card-toggle]')?.setAttribute('aria-expanded', 'false');
                menuRoot?.closest('[data-report-case]')?.classList.remove('has-open-action-menu');
            });
            if (viewMenu && viewMenu !== except && !viewMenu.hidden) {
                viewMenu.hidden = true;
                viewMenu.closest('.announcement-reports-view-menu')?.classList.remove('is-open');
                document.querySelector('[data-reports-view-toggle]')?.setAttribute('aria-expanded', 'false');
            }
            syncMenuSheetState();
        };

        list.dataset.bound = '1';
        list.addEventListener('click', (event) => {
            const reasonsTrigger = event.target.closest('[data-report-reasons-trigger]');
            if (reasonsTrigger) {
                const card = reasonsTrigger.closest('[data-report-case]');
                const reasonsData = card?.querySelector('[data-report-reasons]');
                if (!reasonsDialog || !reasonsDialogBody || !reasonsData) return;

                closeReportedPostMenus();
                activeReasonsTrigger = reasonsTrigger;
                reasonsDialogBody.innerHTML = reasonsData.innerHTML;
                reasonsTrigger.setAttribute('aria-expanded', 'true');
                reasonsDialog.showModal();
                return;
            }

            const toggle = event.target.closest('[data-report-card-toggle]');
            if (toggle) {
                event.preventDefault();
                event.stopPropagation();
                const menu = toggle.closest('[data-report-case]')?.querySelector('[data-report-action-menu]');
                if (!menu) return;
                const opening = menu.hidden;
                closeReportedPostMenus(menu);
                menu.hidden = !opening;
                toggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
                toggle.closest('[data-report-case]')?.classList.toggle('has-open-action-menu', opening);
                if (opening) positionReportActionMenu(menu, toggle, event);
                syncMenuSheetState();
                return;
            }

            const viewPost = event.target.closest('[data-report-view-post]');
            if (viewPost) {
                if (!postDialog || !postDialogBody) return;

                let post = null;
                try {
                    post = JSON.parse(viewPost.dataset.reportPost || 'null');
                } catch (_) {
                    post = null;
                }
                if (!post) return;

                closeReportedPostMenus();
                activePostTrigger = viewPost;
                postDialogBody.innerHTML = renderReportedPostPreview(post);
                postDialog.showModal();
                return;
            }

            const removePost = event.target.closest('[data-report-remove-post]');
            if (removePost) {
                const item = removePost.closest('[data-report-case]');
                const announcementId = Number(item?.dataset.announcementId || 0);
                if (announcementId) {
                    closeReportedPostMenus();
                    void removeReportedPost(announcementId, item, removePost);
                }
            }

            const resolveReport = event.target.closest('[data-report-resolve]');
            if (resolveReport) {
                const item = resolveReport.closest('[data-report-case]');
                const announcementId = Number(item?.dataset.announcementId || 0);
                if (announcementId) {
                    closeReportedPostMenus();
                    void resolveReportedPost(announcementId, item, resolveReport);
                }
            }
        });

        list.addEventListener('keydown', (event) => {
            const reasonsTrigger = event.target.closest('[data-report-reasons-trigger]');
            if (reasonsTrigger && ['Enter', ' '].includes(event.key)) {
                event.preventDefault();
                reasonsTrigger.click();
                return;
            }

            const toggle = event.target.closest('[data-report-card-toggle]');
            if (!toggle || !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            toggle.click();
        });

        if (reasonsDialog) {
            reasonsDialog.addEventListener('click', (event) => {
                if (event.target === reasonsDialog || event.target.closest('[data-close-report-reasons]')) {
                    reasonsDialog.close();
                }
            });
            reasonsDialog.addEventListener('close', () => {
                activeReasonsTrigger?.setAttribute('aria-expanded', 'false');
                if (activeReasonsTrigger?.isConnected) activeReasonsTrigger.focus();
                activeReasonsTrigger = null;
            });
        }

        if (postDialog) {
            postDialog.addEventListener('click', (event) => {
                if (event.target === postDialog || event.target.closest('[data-close-report-post]')) {
                    postDialog.close();
                }
            });
            postDialog.addEventListener('close', () => {
                if (activePostTrigger?.isConnected) activePostTrigger.focus();
                activePostTrigger = null;
            });
        }

        document.addEventListener('click', (event) => {
            const viewToggle = event.target.closest('[data-reports-view-toggle]');
            if (viewToggle) {
                event.preventDefault();
                const menu = document.querySelector('[data-reports-view-menu]');
                if (!menu) return;
                const opening = menu.hidden;
                closeReportedPostMenus(menu);
                menu.hidden = !opening;
                viewToggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
                viewToggle.closest('.announcement-reports-view-menu')?.classList.toggle('is-open', opening);
                syncMenuSheetState();
                return;
            }

            const viewSwitch = event.target.closest('[data-report-view-switch]');
            if (viewSwitch) {
                const requestedView = viewSwitch.dataset.reportViewSwitch;
                const nextView = ['removed', 'resolved'].includes(requestedView) ? requestedView : 'active';
                closeReportedPostMenus();
                void loadReportedPosts(nextView);
                return;
            }

            if (event.target.closest('[data-reports-back]')) {
                closeReportedPostMenus();
                void loadReportedPosts('active');
                return;
            }

            if (!event.target.closest('#announcementReportsList .announcement-menu, #reportedPostsViewMenu')) {
                closeReportedPostMenus();
            }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeReportedPostMenus();
        });

        void loadReportedPosts();
    }

    window.loadReportedPosts = loadReportedPosts;
    document.addEventListener('DOMContentLoaded', initialize);
})();
