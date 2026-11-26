-- Migration: Add DepEd 2019 transmutation table (SF9 quarterly grade mapping)
-- Target: MariaDB/MySQL

CREATE TABLE IF NOT EXISTS deped_transmutation_table (
  transmutation_id INT NOT NULL AUTO_INCREMENT,
  initial_grade_from DECIMAL(5,2) NOT NULL,
  initial_grade_to DECIMAL(5,2) NOT NULL,
  quarterly_grade DECIMAL(5,2) NOT NULL,
  PRIMARY KEY (transmutation_id),
  UNIQUE KEY uq_transmutation_range (initial_grade_from, initial_grade_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO deped_transmutation_table (initial_grade_from, initial_grade_to, quarterly_grade) VALUES
(60.00,60.99,75.00),(61.00,61.99,76.00),(62.00,62.99,77.00),(63.00,63.99,78.00),(64.00,64.99,79.00),
(65.00,65.99,80.00),(66.00,66.99,81.00),(67.00,67.99,82.00),(68.00,68.99,83.00),(69.00,69.99,84.00),
(70.00,70.99,85.00),(71.00,71.99,86.00),(72.00,72.99,87.00),(73.00,73.99,88.00),(74.00,74.99,89.00),
(75.00,75.99,90.00),(76.00,76.99,90.00),(77.00,77.99,91.00),(78.00,78.99,91.00),(79.00,79.99,92.00),
(80.00,80.99,92.00),(81.00,81.99,93.00),(82.00,82.99,93.00),(83.00,83.99,94.00),(84.00,84.99,94.00),
(85.00,85.99,95.00),(86.00,86.99,95.00),(87.00,87.99,96.00),(88.00,88.99,96.00),(89.00,89.99,97.00),
(90.00,90.99,97.00),(91.00,91.99,98.00),(92.00,92.99,98.00),(93.00,93.99,99.00),(94.00,94.99,99.00),
(95.00,95.99,100.00),(96.00,96.99,100.00),(97.00,97.99,100.00),(98.00,98.99,100.00),(99.00,99.99,100.00),
(100.00,100.00,100.00)
ON DUPLICATE KEY UPDATE quarterly_grade = VALUES(quarterly_grade);
