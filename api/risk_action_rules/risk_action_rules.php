<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit(0);

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/audit.php';
require_once __DIR__ . '/../services/RiskActionService.php';

function risk_action_respond(array $payload, int $status = 200): void {
    http_response_code($status);
    echo json_encode($payload, JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function risk_action_json_input(): array {
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

$operation = $_GET['operation'] ?? '';
auth_enforce_roles($operation, ['admin'], ['admin']);

try {
    switch ($operation) {
        case 'getAllRiskActionRules':
            getAllRiskActionRules($conn);
            break;
        case 'getRiskActionRuleOptions':
            getRiskActionRuleOptions($conn);
            break;
        case 'createRiskActionRule':
            createRiskActionRule($conn);
            break;
        case 'updateRiskActionRule':
            updateRiskActionRule($conn);
            break;
        case 'deleteRiskActionRule':
            deleteRiskActionRule($conn);
            break;
        default:
            risk_action_respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (PDOException $e) {
    if ($conn->inTransaction()) $conn->rollBack();
    if ((string)$e->getCode() === '23000') {
        risk_action_respond(['success' => false, 'message' => 'This risk indicator already has a recommended action. Choose an indicator without one, or edit its existing action.'], 409);
    }
    error_log('Risk action rule API: ' . $e->getMessage());
    risk_action_respond(['success' => false, 'message' => 'Unable to save the risk action rule. Please try again.'], 500);
} catch (Throwable $e) {
    if ($conn->inTransaction()) $conn->rollBack();
    error_log('Risk action rule API: ' . $e->getMessage());
    risk_action_respond(['success' => false, 'message' => 'Unable to complete the risk action rule request. Please try again.'], 500);
}

function getAllRiskActionRules(PDO $conn): void {
    $stmt = $conn->prepare(
        "SELECT r.risk_action_rule_id, r.indicator_catalog_id, c.indicator_code,
                c.indicator_name, c.category AS indicator_category, c.is_fallback,
                r.risk_band, r.recommended_action, r.is_active
         FROM risk_action_rules r
         JOIN risk_indicator_catalog c ON c.indicator_catalog_id = r.indicator_catalog_id
         WHERE r.is_deleted = 0 AND c.is_deleted = 0
         ORDER BY FIELD(r.risk_band, 'high', 'medium', 'low'), c.is_fallback,
                  c.indicator_name"
    );
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$row) {
        // Display the fixed band for the indicator, never an admin-entered value.
        $row['risk_band'] = RiskActionService::fixedBandForIndicator((string)($row['indicator_code'] ?? ''));
    }
    unset($row);
    risk_action_respond($rows);
}

function getRiskActionRuleOptions(PDO $conn): void {
    $stmt = $conn->prepare(
        'SELECT indicator_catalog_id, indicator_code, indicator_name, category, is_fallback
         FROM risk_indicator_catalog c
         WHERE c.is_active = 1 AND c.is_deleted = 0
           AND NOT EXISTS (
               SELECT 1
               FROM risk_action_rules r
               WHERE r.indicator_catalog_id = c.indicator_catalog_id
                 AND r.is_deleted = 0
           )
         ORDER BY c.is_fallback, c.category, c.indicator_name'
    );
    $stmt->execute();
    risk_action_respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function validateRiskActionRuleInput(PDO $conn, array $data, ?int $ignoreRuleId = null): array {
    $indicatorId = filter_var($data['indicator_catalog_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if (!$indicatorId) {
        risk_action_respond(['success' => false, 'message' => 'Choose a risk indicator.'], 422);
    }

    $action = trim((string)($data['recommended_action'] ?? ''));
    if ($action === '') {
        risk_action_respond(['success' => false, 'message' => 'Recommended action is required.'], 422);
    }
    $actionLength = preg_match_all('/./us', $action);
    if ($actionLength === false) {
        risk_action_respond(['success' => false, 'message' => 'Recommended action contains invalid text.'], 422);
    }
    if ($actionLength > 4000) {
        risk_action_respond(['success' => false, 'message' => 'Recommended action must be 4,000 characters or fewer.'], 422);
    }

    $indicator = $conn->prepare(
        'SELECT indicator_catalog_id, indicator_code
         FROM risk_indicator_catalog
         WHERE indicator_catalog_id = :id
           AND is_active = 1
           AND is_deleted = 0
         LIMIT 1'
    );
    $indicator->bindValue(':id', (int)$indicatorId, PDO::PARAM_INT);
    $indicator->execute();
    $indicatorRow = $indicator->fetch(PDO::FETCH_ASSOC);
    if (!$indicatorRow) {
        risk_action_respond(['success' => false, 'message' => 'That risk indicator is no longer available. Refresh the page and choose another.'], 422);
    }
    $band = RiskActionService::fixedBandForIndicator((string)($indicatorRow['indicator_code'] ?? ''));
    $active = 1;

    $duplicateSql = 'SELECT risk_action_rule_id
                     FROM risk_action_rules
                     WHERE indicator_catalog_id = :indicator_id
                       AND is_deleted = 0';
    if ($ignoreRuleId !== null) $duplicateSql .= ' AND risk_action_rule_id <> :ignore_id';
    $duplicateSql .= ' LIMIT 1';
    $duplicate = $conn->prepare($duplicateSql);
    $duplicateParams = [':indicator_id' => (int)$indicatorId];
    if ($ignoreRuleId !== null) $duplicateParams[':ignore_id'] = $ignoreRuleId;
    $duplicate->execute($duplicateParams);
    if ($duplicate->fetchColumn()) {
        risk_action_respond(['success' => false, 'message' => 'This risk indicator already has a recommended action. Choose an indicator without one, or edit its existing action.'], 409);
    }

    return [(int)$indicatorId, $band, $action, $active];
}

function createRiskActionRule(PDO $conn): void {
    $data = risk_action_json_input();
    [$indicatorId, $band, $action, $active] = validateRiskActionRuleInput($conn, $data);

    $conn->beginTransaction();
    $insert = $conn->prepare(
        'INSERT INTO risk_action_rules
            (indicator_catalog_id, risk_band, recommended_action, is_active)
         VALUES (:indicator_id, :risk_band, :action, :is_active)'
    );
    $insert->execute([
        ':indicator_id' => $indicatorId,
        ':risk_band' => $band,
        ':action' => $action,
        ':is_active' => $active
    ]);
    $ruleId = (int)$conn->lastInsertId();
    audit_log($conn, 'risk_action_rules', $ruleId, 'INSERT', null, [
        'risk_action_rule_id' => $ruleId,
        'indicator_catalog_id' => $indicatorId,
        'risk_band' => $band,
        'recommended_action' => $action,
        'is_active' => 1
    ]);
    $conn->commit();
    risk_action_respond(['success' => true, 'message' => 'Risk action rule created.', 'risk_action_rule_id' => $ruleId]);
}

function updateRiskActionRule(PDO $conn): void {
    $data = risk_action_json_input();
    $ruleId = filter_var($data['risk_action_rule_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if (!$ruleId) risk_action_respond(['success' => false, 'message' => 'A valid action rule is required.'], 422);
    [$indicatorId, $band, $action, $active] = validateRiskActionRuleInput($conn, $data, (int)$ruleId);

    $conn->beginTransaction();
    $old = $conn->prepare('SELECT * FROM risk_action_rules WHERE risk_action_rule_id = :id AND is_deleted = 0 LIMIT 1 FOR UPDATE');
    $old->execute([':id' => (int)$ruleId]);
    $oldRow = $old->fetch(PDO::FETCH_ASSOC);
    if (!$oldRow) {
        $conn->rollBack();
        risk_action_respond(['success' => false, 'message' => 'This action rule no longer exists. Refresh the list.'], 404);
    }

    $update = $conn->prepare(
        'UPDATE risk_action_rules
         SET indicator_catalog_id = :indicator_id, risk_band = :risk_band,
             recommended_action = :action, is_active = :is_active
         WHERE risk_action_rule_id = :id AND is_deleted = 0'
    );
    $update->execute([
        ':indicator_id' => $indicatorId,
        ':risk_band' => $band,
        ':action' => $action,
        ':is_active' => 1,
        ':id' => (int)$ruleId
    ]);
    audit_log($conn, 'risk_action_rules', (int)$ruleId, 'UPDATE', $oldRow, [
        'risk_action_rule_id' => (int)$ruleId,
        'indicator_catalog_id' => $indicatorId,
        'risk_band' => $band,
        'recommended_action' => $action,
        'is_active' => $active
    ]);
    $conn->commit();
    risk_action_respond(['success' => true, 'message' => 'Risk action rule updated.']);
}

function deleteRiskActionRule(PDO $conn): void {
    $data = risk_action_json_input();
    $ruleId = filter_var($data['risk_action_rule_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if (!$ruleId) risk_action_respond(['success' => false, 'message' => 'A valid action rule is required.'], 422);

    $conn->beginTransaction();
    $old = $conn->prepare('SELECT * FROM risk_action_rules WHERE risk_action_rule_id = :id AND is_deleted = 0 LIMIT 1 FOR UPDATE');
    $old->execute([':id' => (int)$ruleId]);
    $oldRow = $old->fetch(PDO::FETCH_ASSOC);
    if (!$oldRow) {
        $conn->rollBack();
        risk_action_respond(['success' => false, 'message' => 'This action rule is already archived. Refresh the list.'], 404);
    }

    $delete = $conn->prepare('UPDATE risk_action_rules SET is_deleted = 1, deleted_at = NOW() WHERE risk_action_rule_id = :id');
    $delete->execute([':id' => (int)$ruleId]);
    audit_log($conn, 'risk_action_rules', (int)$ruleId, 'DELETE', $oldRow, null);
    $conn->commit();
    risk_action_respond(['success' => true, 'message' => 'Risk action rule archived.']);
}
