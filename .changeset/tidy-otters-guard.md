---
"@memberjunction/skyway-core": patch
---

Detect duplicate migration versions and fail before applying, instead of silently writing two history rows for the same version. Migrate, Info, and Validate now reject version collisions before any database mutation, and Repair refuses to operate when a version is duplicated.
