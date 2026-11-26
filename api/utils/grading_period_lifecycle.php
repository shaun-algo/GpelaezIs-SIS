<?php

/**
 * Keep grading-period status synchronized with the configured school
 * calendar. The end date is inclusive: a period remains open on its end date
 * and closes on the following day. Rows marked as manual are excluded from
 * the automatic pass so an administrator can reopen or lock a period for
 * controlled testing and correction; status_mode comes from the grading-
 * period status-control migration.
 */
function sync_automatic_grading_period_statuses(PDO $conn, ?string $today = null): void {
    $today = $today ?: date('Y-m-d');
    $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $today);
    if (!$parsed || $parsed->format('Y-m-d') !== $today) {
        throw new InvalidArgumentException('Invalid lifecycle date');
    }

    // An inactive/deleted school year can never expose an open *automatic*
    // period. Administrator-manual periods are intentionally left alone so
    // an admin can reopen a period for controlled testing or correction.
    $inactive = $conn->prepare(
        "UPDATE grading_periods gp
         INNER JOIN school_years sy ON sy.school_year_id = gp.school_year_id
         SET gp.status = 'Locked'
         WHERE (sy.is_active = 0 OR sy.is_deleted = 1)
           AND gp.is_deleted = 0
           AND gp.status_mode = 'automatic'
           AND gp.status <> 'Locked'"
    );
    $inactive->execute();

    // Date-configured periods use an inclusive [start, end] interval. This
    // also opens the next period as soon as its configured start date arrives.
    $automatic = $conn->prepare(
        "UPDATE grading_periods gp
         INNER JOIN school_years sy ON sy.school_year_id = gp.school_year_id
         SET gp.status = CASE
             WHEN :today_before < gp.date_start THEN 'Locked'
             WHEN :today_after > gp.date_end THEN 'Locked'
             ELSE 'Open'
         END
         WHERE gp.is_deleted = 0
           AND sy.is_active = 1
           AND sy.is_deleted = 0
           AND gp.status_mode = 'automatic'
           AND gp.date_start IS NOT NULL
           AND gp.date_end IS NOT NULL"
    );
    $automatic->execute([
        ':today_before' => $today,
        ':today_after' => $today,
    ]);
}
