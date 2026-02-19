---
"@memberjunction/skyway-core": patch
---

Default database connection encryption to true

Changed the default value of `Encrypt` from `false` to `true` in `ConnectionManager`. Azure SQL and modern SQL Server deployments require encrypted connections, and the previous default caused migrations to fail with "Server requires encryption" errors. Combined with the existing `TrustServerCertificate: true` default, this works seamlessly for both Azure and local development environments.
