<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/name_extension_errors.php';
require_once __DIR__ . '/../utils/family_member_name.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function bindFamilyNullable(PDOStatement $stmt, string $parameter, $value): void {
    $stmt->bindValue($parameter, $value, $value === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
}

$operation = $_GET['operation'] ?? '';
$session = auth_enforce_roles($operation, ['admin', 'registrar'], ['admin', 'registrar']);
try {
    switch ($operation) {
        case 'getAllFamilyMembers': getAllFamilyMembers($conn); break;
        case 'createFamilyMember': createFamilyMember($conn); break;
        case 'updateFamilyMember': updateFamilyMember($conn); break;
        case 'deleteFamilyMember': deleteFamilyMember($conn); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (ApplicationIntegrityException $e) {
    if ($conn->inTransaction()) $conn->rollBack();
    respond(['success' => false, 'message' => $e->getMessage()], $e->getCode());
} catch (Exception $e) {
    if ($conn->inTransaction()) $conn->rollBack();
    if (is_name_extension_fk_violation($e)) {
        respond(name_extension_fk_error_payload(), 422);
    }
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function familyMemberInput(PDO $conn, array $data): array {
    $extension = $data['name_extension'] ?? null;
    if (family_member_clean_name_part($extension) === null && array_key_exists('name_extension_id', $data)) {
        $extensionId = filter_var($data['name_extension_id'], FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($extensionId) {
            $lookup = $conn->prepare('SELECT extension_name FROM name_extensions WHERE extension_id = :id AND is_deleted = 0 LIMIT 1');
            $lookup->bindValue(':id', $extensionId, PDO::PARAM_INT);
            $lookup->execute();
            $extension = $lookup->fetchColumn() ?: null;
        }
    }

    return family_member_prepare_name(
        $conn,
        $data['full_name'] ?? ($data['full_name_raw'] ?? null),
        $data['first_name'] ?? null,
        $data['middle_name'] ?? null,
        $data['last_name'] ?? null,
        $extension
    );
}

function requireFamilyMemberName(array $prepared): void {
    if (!($prepared['valid'] ?? false)) {
        $message = (string)($prepared['message'] ?? 'Provide a valid family member name.');
        if (str_starts_with($message, 'Name extension')) {
            $payload = name_extension_fk_error_payload();
            $payload['message'] = $message;
            $payload['errors']['name_extension'] = $message;
            respond($payload, 422);
        }
        respond(['success' => false, 'message' => $message, 'errors' => ['full_name' => $message]], 422);
    }
}

function getAllFamilyMembers(PDO $conn): void {
    $sql = "SELECT fm.family_member_id, fm.learner_id, fm.full_name, fm.full_name_raw,
                   fm.first_name, fm.middle_name, fm.last_name, fm.name_extension,
                   fm.relationship,
                   fm.date_of_birth, fm.occupation, fm.contact_number, fm.monthly_income,
                   CONCAT(l.last_name, ', ', l.first_name) AS learner_name
            FROM family_members fm
            JOIN learners l ON fm.learner_id = l.learner_id
            WHERE fm.is_deleted = 0
            ORDER BY fm.family_member_id DESC";
    $stmt = $conn->prepare($sql);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$row) {
        // Legacy rows may only have full_name. Derive structured values for
        // the editor without rewriting ambiguous historical values.
        $parsed = family_member_parse_name($row['full_name'] ?? null);
        foreach (['first_name', 'middle_name', 'last_name', 'name_extension'] as $field) {
            if (($row[$field] ?? null) === null) $row[$field] = $parsed[$field] ?? null;
        }
        $row['family_relationship_id'] = $row['relationship'];
        $row['relationship_name'] = $row['relationship'];
    }
    respond($rows);
}

function createFamilyMember(PDO $conn): void {
    $data = getJsonInput();
    $relationship = trim((string)($data['relationship'] ?? ($data['relationship_name'] ?? '')));
    if (empty($data['learner_id']) || $relationship === '') {
        respond(['success' => false, 'message' => 'Learner, family name, and relationship are required'], 422);
    }
    $name = familyMemberInput($conn, $data);
    requireFamilyMemberName($name);
    $isGuardian = !empty($data['is_guardian']);
    $conn->beginTransaction();
    app_integrity_validate_single_guardian($conn, (int)$data['learner_id'], $isGuardian);
    $stmt = $conn->prepare('INSERT INTO family_members
        (learner_id, full_name, full_name_raw, first_name, middle_name, last_name, name_extension,
         relationship, date_of_birth, occupation, contact_number, monthly_income, is_guardian)
        VALUES (:learner_id, :full_name, :full_name_raw, :first_name, :middle_name, :last_name, :name_extension,
                :relationship, :date_of_birth, :occupation, :contact_number, :monthly_income, :is_guardian)');
    $stmt->bindValue(':learner_id', $data['learner_id'], PDO::PARAM_INT);
    $stmt->bindValue(':full_name', $name['full_name']);
    bindFamilyNullable($stmt, ':full_name_raw', $name['full_name_raw']);
    bindFamilyNullable($stmt, ':first_name', $name['first_name']);
    bindFamilyNullable($stmt, ':middle_name', $name['middle_name']);
    bindFamilyNullable($stmt, ':last_name', $name['last_name']);
    bindFamilyNullable($stmt, ':name_extension', $name['name_extension']);
    $stmt->bindValue(':relationship', $relationship);
    $stmt->bindValue(':date_of_birth', $data['date_of_birth'] ?? null);
    $stmt->bindValue(':occupation', $data['occupation'] ?? null);
    $stmt->bindValue(':contact_number', $data['contact_number'] ?? null);
    $stmt->bindValue(':monthly_income', $data['monthly_income'] ?? null);
    $stmt->bindValue(':is_guardian', $isGuardian ? 1 : 0, PDO::PARAM_INT);
    $stmt->execute();
    $familyMemberId = (int)$conn->lastInsertId();
    $conn->commit();
    respond(['success' => true, 'message' => 'Family member created', 'family_member_id' => $familyMemberId]);
}

function updateFamilyMember(PDO $conn): void {
    $data = getJsonInput();
    $relationship = trim((string)($data['relationship'] ?? ($data['relationship_name'] ?? '')));
    if (empty($data['family_member_id']) || empty($data['learner_id']) || $relationship === '') {
        respond(['success' => false, 'message' => 'Family member ID, learner, family name, and relationship are required'], 422);
    }
    $name = familyMemberInput($conn, $data);
    requireFamilyMemberName($name);
    $isGuardian = !empty($data['is_guardian']);
    $conn->beginTransaction();
    app_integrity_validate_single_guardian($conn, (int)$data['learner_id'], $isGuardian, (int)$data['family_member_id']);
    $stmt = $conn->prepare('UPDATE family_members SET
        learner_id = :learner_id, full_name = :full_name, full_name_raw = :full_name_raw,
        first_name = :first_name, middle_name = :middle_name, last_name = :last_name,
        name_extension = :name_extension, relationship = :relationship,
        date_of_birth = :date_of_birth, occupation = :occupation, contact_number = :contact_number,
        monthly_income = :monthly_income, is_guardian = :is_guardian
        WHERE family_member_id = :family_member_id');
    $stmt->bindValue(':learner_id', $data['learner_id'], PDO::PARAM_INT);
    $stmt->bindValue(':full_name', $name['full_name']);
    bindFamilyNullable($stmt, ':full_name_raw', $name['full_name_raw']);
    bindFamilyNullable($stmt, ':first_name', $name['first_name']);
    bindFamilyNullable($stmt, ':middle_name', $name['middle_name']);
    bindFamilyNullable($stmt, ':last_name', $name['last_name']);
    bindFamilyNullable($stmt, ':name_extension', $name['name_extension']);
    $stmt->bindValue(':relationship', $relationship);
    $stmt->bindValue(':date_of_birth', $data['date_of_birth'] ?? null);
    $stmt->bindValue(':occupation', $data['occupation'] ?? null);
    $stmt->bindValue(':contact_number', $data['contact_number'] ?? null);
    $stmt->bindValue(':monthly_income', $data['monthly_income'] ?? null);
    $stmt->bindValue(':is_guardian', $isGuardian ? 1 : 0, PDO::PARAM_INT);
    $stmt->bindValue(':family_member_id', $data['family_member_id'], PDO::PARAM_INT);
    $stmt->execute();
    $conn->commit();
    respond(['success' => true, 'message' => 'Family member updated']);
}

function deleteFamilyMember(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['family_member_id'])) {
        respond(['success' => false, 'message' => 'Family member ID is required'], 422);
    }
    $stmt = $conn->prepare('UPDATE family_members SET is_deleted = 1, deleted_at = NOW() WHERE family_member_id = :family_member_id');
    $stmt->bindValue(':family_member_id', $data['family_member_id'], PDO::PARAM_INT);
    $stmt->execute();
    respond(['success' => true, 'message' => 'Family member deleted']);
}
?>
