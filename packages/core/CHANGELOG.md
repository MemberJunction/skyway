# @memberjunction/skyway-core

## 0.5.3

### Patch Changes

- f7c7ae4: Default database connection encryption to true

  Changed the default value of `Encrypt` from `false` to `true` in `ConnectionManager`. Azure SQL and modern SQL Server deployments require encrypted connections, and the previous default caused migrations to fail with "Server requires encryption" errors. Combined with the existing `TrustServerCertificate: true` default, this works seamlessly for both Azure and local development environments.

## 0.5.2

### Patch Changes

- 0b0c016: Add README files for npm package pages

## 0.5.1

### Patch Changes

- 74ff7bd: Initial npm publish with OIDC trusted publishing
