<?php

/** SF1 age guidance uses the current calendar year, independently of enrollment settings. */
function getImportAgeWarning(string $birthDate, $rawAge, ?DateTimeImmutable $today = null): ?string {
    $timezone = new DateTimeZone('Asia/Manila');
    $today = ($today ?? new DateTimeImmutable('now', $timezone))->setTimezone($timezone);
    $reference = new DateTimeImmutable('first friday of june ' . $today->format('Y'), $timezone);
    $birth = DateTimeImmutable::createFromFormat('!Y-m-d', $birthDate, $timezone);
    if (!$birth || $birth->format('Y-m-d') !== $birthDate || $birth > $reference) return null;

    $enteredAge = trim((string)$rawAge);
    if ($enteredAge === '') return null;
    $fileAge = (int)preg_replace('/\D/', '', $enteredAge);
    $age = $birth->diff($reference)->y;
    // Allow a one-year difference for files using a different age cutoff.
    if ($fileAge <= 0 || abs($age - $fileAge) <= 1) return null;

    return "Age column says {$fileAge}; the birth date gives age {$age} as of "
        . $reference->format('F j, Y')
        . ' (first Friday of June in the current year). Please check the SF1 age and birth date.';
}
