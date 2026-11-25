---
"@memberjunction/skyway-core": minor
"@memberjunction/skyway-postgres": minor
"@memberjunction/skyway-sqlserver": minor
---

A database config can supply `PasswordProvider`, a function that returns the password for each new connection, for a login whose password is a short-lived token (Microsoft Entra ID, AWS RDS IAM). PostgreSQL hands it to node-postgres, which calls it every time the pool opens a physical connection; SQL Server calls it each time Skyway connects. A long migration run therefore no longer presents a token that expired after the first connection opened. `Password` is unchanged and still used when no provider is set.
