# PSGC lookup retirement

The application now treats LIS-imported birthplace and address text as the
source of truth. The former `geo_provinces`, `geo_cities_municipalities`,
`geo_barangays`, and `geo_name_aliases` tables were removed from the cloned
database first, validated, and then removed from `gsis`.

The former `/api/geo/*.php` HTTP handlers and the PSGC lookup importer are
retired. Do not run the old importer or seed files against the production
database. The historical migration file
`api/database/migrations/add_geo_lookup_tables.sql` is intentionally a no-op
so fresh deployments do not recreate the retired tables.

Address values should be supplied through the active LIS import or the text
fields in the learner/profile forms:

- birthplace: `learners.birth_province_text`
- current address: `learner_addresses.province_text`,
  `city_municipality_text`, and `barangay_text`

The nullable legacy `*_id` columns remain as a compatibility shell in this
pass, but the active application no longer reads or writes them as geographic
references.
