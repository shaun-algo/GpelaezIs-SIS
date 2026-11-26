const RISK_ACTIONS_API = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;

const riskActionRulesApi = {
    list: async () => axios.get(`${RISK_ACTIONS_API}/risk_action_rules/risk_action_rules.php`, {
        params: { operation: 'getAllRiskActionRules' }
    }).then(response => response.data),
    options: async () => axios.get(`${RISK_ACTIONS_API}/risk_action_rules/risk_action_rules.php`, {
        params: { operation: 'getRiskActionRuleOptions' }
    }).then(response => response.data),
    create: async data => axios.post(`${RISK_ACTIONS_API}/risk_action_rules/risk_action_rules.php?operation=createRiskActionRule`, data).then(response => response.data),
    update: async (id, data) => axios.post(`${RISK_ACTIONS_API}/risk_action_rules/risk_action_rules.php?operation=updateRiskActionRule`, {
        ...data,
        risk_action_rule_id: id
    }).then(response => response.data),
    remove: async id => axios.post(`${RISK_ACTIONS_API}/risk_action_rules/risk_action_rules.php?operation=deleteRiskActionRule`, {
        risk_action_rule_id: id
    }).then(response => response.data)
};

const riskIndicatorField = {
    key: 'indicator_catalog_id',
    label: 'Risk Indicator',
    type: 'select',
    required: true,
    valueKey: 'indicator_catalog_id',
    labelKey: 'indicator_name',
    loadOptions: riskActionRulesApi.options,
    optionLabelKey: 'indicator_name'
};

function riskActionEscape(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
    initializeMasterfile({
        key: 'risk_action_rules',
        navKey: 'risk_action_rules',
        entity: 'Action Rule',
        pageTitle: 'Recommended Actions',
        subtitle: '',
        breadcrumb: 'Recommended Actions',
        addLabel: 'Add Recommended Action',
        primaryKey: 'risk_action_rule_id',
        beforeOpenAdd: async () => {
            const select = document.getElementById('field-indicator_catalog_id');
            if (!select) return;
            select.disabled = true;
            try {
                const options = await riskActionRulesApi.options();
                populateSelect(riskIndicatorField, options);
                if (!options.length) {
                    showNotification('Every supported risk indicator already has a recommended action.', 'info');
                }
            } catch (error) {
                populateSelect(riskIndicatorField, []);
                showNotification('Could not refresh the available risk indicators. Please try again.', 'error');
                throw error;
            } finally {
                select.disabled = false;
            }
        },
        getRecordLabel: row => `${row.indicator_name || 'Risk indicator'} · ${row.risk_band || ''}`,
        columns: [
            {
                key: 'recommended_action',
                label: 'RECOMMENDED ACTION',
                formatter: value => {
                    const text = String(value || '').trim();
                    return `<span class="risk-action-preview" title="${riskActionEscape(text)}">${riskActionEscape(text)}</span>`;
                }
            },
            { key: 'indicator_name', label: 'Risk Indicator' },
            {
                key: 'risk_band',
                label: 'Risk Band',
                formatter: value => {
                    const band = String(value || '').toLowerCase();
                    const label = band ? band[0].toUpperCase() + band.slice(1) : '—';
                    return `<span class="risk-action-band risk-action-band--${riskActionEscape(band)}">${riskActionEscape(label)}</span>`;
                }
            }
        ],
        fields: [
            riskIndicatorField,
            {
                key: 'recommended_action',
                label: 'Recommended Action',
                type: 'textarea',
                required: true,
                maxLength: 4000,
                rows: 5,
                placeholder: 'Write the recommended support action for this indicator.'
            }
        ],
        api: riskActionRulesApi
    });
});
