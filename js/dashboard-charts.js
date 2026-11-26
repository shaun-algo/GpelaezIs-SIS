// ===========================
// Dashboard Charts JavaScript
// Using Chart.js
// ===========================

document.addEventListener('DOMContentLoaded', function() {
    wireDashboardButtons();

    // If metrics are already loaded by dashboard.js, use them; else fetch locally
    if (window.dashboardMetrics) {
        initializeCharts(window.dashboardMetrics);
    } else {
        fetchMetricsAndInit();
    }
});

function wireDashboardButtons() {
    // Admin dashboard embedded "Generate Report" button
    const overviewGenerateBtn = document.querySelector('#dashboard-overviewSection .page-header > button.btn.btn-primary');
    if (overviewGenerateBtn) {
        overviewGenerateBtn.addEventListener('click', () => {
            window.location.href = '../pages/analytics/dashboard-overview.html';
        });
    }

    // Admin dashboard embedded "View All Notifications" button
    const overviewViewAllBtn = document.querySelector('#dashboard-overviewSection .alerts-card .btn.btn-outline.btn-block');
    if (overviewViewAllBtn) {
        overviewViewAllBtn.addEventListener('click', () => {
            window.location.href = '../pages/notifications.html';
        });
    }

    // Admin dashboard embedded "Quick Actions"
    const quickActionButtons = Array.from(document.querySelectorAll('#dashboard-overviewSection .quick-actions-card .quick-actions > button'));
    if (quickActionButtons.length) {
        quickActionButtons.forEach((button) => {
            const label = String(button.textContent || '').trim().toLowerCase();
            button.addEventListener('click', () => {
                if (label.includes('learner') || label.includes('student')) {
                    window.location.href = '../pages/masterfiles/learners.html';
                    return;
                }
                if (label.includes('enrollment')) {
                    window.location.href = '../pages/enrollments.html';
                    return;
                }
                if (label.includes('report')) {
                    window.location.href = '../pages/analytics/dashboard-overview.html';
                    return;
                }
                if (label.includes('analytics')) {
                    window.location.href = '../pages/analytics/dashboard-overview.html';
                }
            });
        });
    }

}

// Listen for shared metrics from dashboard.js
document.addEventListener('dashboard:metrics', function(event) {
    initializeCharts(event.detail);
});

// ===========================
// Initialize All Charts
// ===========================

// Ensure API_BASE is set (same-origin)
if (!window.API_BASE) {
    const pathname = String(window.location.pathname || '/');
    let appPrefix = '';

    if (pathname.includes('/dashboard/')) {
        appPrefix = pathname.split('/dashboard/')[0] || '';
    } else if (pathname.includes('/pages/')) {
        appPrefix = pathname.split('/pages/')[0] || '';
    } else if (pathname.includes('/api/')) {
        appPrefix = pathname.split('/api/')[0] || '';
    } else {
        const parts = pathname.split('/').filter(Boolean);
        appPrefix = parts.length ? `/${parts[0]}` : '';
    }

    if (appPrefix === '/') appPrefix = '';

    const isApacheServed = pathname.includes('/deped_capstone2/');
    window.API_BASE = isApacheServed
        ? `${appPrefix}/api`
        : `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;
}

async function fetchMetricsAndInit() {
    try {
        const response = await axios.get(`${window.API_BASE}/dashboard/metrics.php`, {
            params: { _cb: Date.now() }
        });
        if (response.data?.success) {
            initializeCharts(response.data.data);
        }
    } catch (err) {
        console.error('Unable to load metrics for charts', err);
    }
}

function initializeCharts(metrics) {
    updateEmbeddedDashboardSummary(metrics);
    createEnrollmentChart(metrics?.enrollmentTrend, 'enrollmentChartOverview');
    createGradeDistributionChart(metrics?.gradeDistribution, 'gradeDistributionChartOverview');
    createPerformanceChart(metrics?.performance, 'performanceChartOverview');
}

function updateEmbeddedDashboardSummary(metrics) {
    const stats = metrics?.stats || {};
    const enrollment = metrics?.enrollmentStats || {};
    const schoolYear = stats.schoolYear || '—';
    const setText = (id, value) => {
        const node = document.getElementById(id);
        if (node) node.textContent = String(value ?? '');
    };

    setText('totalStudentsEnrollment', stats.totalStudents ?? 0);
    setText('newEnrollments', enrollment.newEnrollments ?? 0);
    setText('dropoutRate', `${Number(enrollment.dropoutRate || 0).toFixed(2)}%`);
    setText('dashboardSchoolYear', schoolYear);
    setText('currentSchoolYear', schoolYear);
    setText('enrollmentLearnerTrend', 'Current school year');
    setText('dashboardLearnerTrend', 'Current school year');
    setText('dashboardTeacherTrend', 'Active teacher accounts');
    setText('dashboardClassTrend', 'Current school year');
    setText(
        'embeddedNewEnrollmentTrend',
        `Last ${Number(enrollment.newEnrollmentWindowDays || 30)} days`
    );
    setText(
        'embeddedDropoutTrend',
        `${Number(enrollment.droppedEnrollments || 0).toLocaleString()} dropped of ${Number(enrollment.enrollmentRecords || 0).toLocaleString()} records`
    );
}

function destroyChartIfExists(canvas) {
    if (!canvas || !window.Chart || typeof Chart.getChart !== 'function') {
        return;
    }
    const existing = Chart.getChart(canvas);
    if (existing) {
        existing.destroy();
    }
}

// ===========================
// Enrollment Trend Chart
// ===========================

function createEnrollmentChart(dataset, canvasId = 'enrollmentChart') {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    destroyChartIfExists(ctx);

    const labels = Array.isArray(dataset?.labels) ? dataset.labels : [];
    const dataPoints = Array.isArray(dataset?.data) ? dataset.data : [];

    const data = {
        labels,
        datasets: [{
            label: 'New Enrollments',
            data: dataPoints,
            borderColor: '#0055A4',
            backgroundColor: 'rgba(0, 85, 164, 0.1)',
            borderWidth: 2,
            tension: 0.4,
            fill: true,
            pointBackgroundColor: '#0055A4',
            pointBorderColor: '#fff',
            pointHoverBackgroundColor: '#fff',
            pointHoverBorderColor: '#0055A4',
            pointRadius: 4,
            pointHoverRadius: 6
        }]
    };

    new Chart(ctx, {
        type: 'line',
        data: data,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    padding: 12,
                    titleFont: {
                        size: 14
                    },
                    bodyFont: {
                        size: 13
                    },
                    callbacks: {
                        label: function(context) {
                            return 'Enrolled: ' + context.parsed.y + ' students';
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: false,
                    grid: {
                        borderDash: [5, 5]
                    },
                    ticks: {
                        font: {
                            size: 12
                        }
                    }
                },
                x: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        font: {
                            size: 12
                        }
                    }
                }
            }
        }
    });
}

// ===========================
// Grade Distribution Chart
// ===========================

function createGradeDistributionChart(dataset, canvasId = 'gradeDistributionChart') {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    destroyChartIfExists(ctx);

    const labels = Array.isArray(dataset?.labels) ? dataset.labels : [];
    const dataPoints = Array.isArray(dataset?.data) ? dataset.data : [];

    const data = {
        labels,
        datasets: [{
            label: 'Number of Students',
            data: dataPoints,
            backgroundColor: '#A4D65E',
            borderColor: '#8BC244',
            borderWidth: 1,
            borderRadius: 6,
            barThickness: 40
        }]
    };

    new Chart(ctx, {
        type: 'bar',
        data: data,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    padding: 12,
                    titleFont: {
                        size: 14
                    },
                    bodyFont: {
                        size: 13
                    },
                    callbacks: {
                        label: function(context) {
                            return 'Students: ' + context.parsed.y;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: {
                        borderDash: [5, 5]
                    },
                    ticks: {
                        font: {
                            size: 12
                        },
                        stepSize: 20
                    }
                },
                x: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        font: {
                            size: 12
                        }
                    }
                }
            }
        }
    });
}

// ===========================
// Performance Distribution Chart
// ===========================

function createPerformanceChart(dataset, canvasId = 'performanceChart') {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    destroyChartIfExists(ctx);

    const labels = Array.isArray(dataset?.labels) ? dataset.labels : [];
    const dataPoints = Array.isArray(dataset?.data) ? dataset.data : [];

    const data = {
        labels,
        datasets: [{
            data: dataPoints,
            backgroundColor: [
                '#0055A4', // Outstanding - DepEd Blue
                '#A4D65E', // Very Satisfactory - DepEd Green
                '#FFD700', // Satisfactory - Gold
                '#FFA500', // Fairly Satisfactory - Orange
                '#FF6B6B', // Did Not Meet - Red
                '#94A3B8'  // No Grade
            ],
            borderWidth: 2,
            borderColor: '#fff'
        }]
    };

    new Chart(ctx, {
        type: 'pie',
        data: data,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        padding: 15,
                        font: {
                            size: 12
                        },
                        generateLabels: function(chart) {
                            const data = chart.data;
                            if (data.labels.length && data.datasets.length) {
                                return data.labels.map((label, i) => {
                                    const value = data.datasets[0].data[i];
                                    const total = data.datasets[0].data.reduce((a, b) => a + b, 0);
                                    const percentage = total ? ((value / total) * 100).toFixed(1) : '0.0';

                                    return {
                                        text: `${label}: ${percentage}%`,
                                        fillStyle: data.datasets[0].backgroundColor[i],
                                        hidden: false,
                                        index: i
                                    };
                                });
                            }
                            return [];
                        }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    padding: 12,
                    titleFont: {
                        size: 14
                    },
                    bodyFont: {
                        size: 13
                    },
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = context.parsed;
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = total ? ((value / total) * 100).toFixed(1) : '0.0';
                            return `${label}: ${value} students (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
}

// ===========================
// API Data Loading Functions
// ===========================

async function loadEnrollmentData() {
    try {
        return null;
    } catch (error) {
        console.error('Error loading enrollment data:', error);
        return null;
    }
}

async function loadGradeDistributionData() {
    try {
        return null;
    } catch (error) {
        console.error('Error loading grade distribution data:', error);
        return null;
    }
}

async function loadPerformanceData() {
    try {
        return null;
    } catch (error) {
        console.error('Error loading performance data:', error);
        return null;
    }
}

// Export functions
window.chartUtils = {
    loadEnrollmentData,
    loadGradeDistributionData,
    loadPerformanceData,
    createEnrollmentChart,
    createGradeDistributionChart,
    createPerformanceChart
};
