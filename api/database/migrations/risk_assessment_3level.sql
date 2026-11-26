-- Migration: Align risk_levels with 0-100 3-level scoring
-- Low = 0-39, Medium = 40-59, High = 60-100

UPDATE risk_levels
SET risk_name = 'Medium',
    description = 'Score 40-59: early warning; learner needs advisory support and closer monitoring.',
    color_code = '#d97706'
WHERE risk_name = 'Moderate' AND is_deleted = 0;

UPDATE risk_levels
SET description = 'Score 0-39: learner is on track; routine monitoring only.',
    color_code = '#166534'
WHERE risk_name = 'Low' AND is_deleted = 0;

UPDATE risk_levels
SET description = 'Score 60-100: multiple failing subjects, chronic absence, severe grade decline or very low checklist completion; active intervention required.',
    color_code = '#b91c1c'
WHERE risk_name = 'High' AND is_deleted = 0;
