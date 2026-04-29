/**
 * @module @memberjunction/skyway-sqlserver
 *
 * SQL Server provider for the Skyway migration engine.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { Skyway } from '@memberjunction/skyway-core';
 * import { SqlServerProvider } from '@memberjunction/skyway-sqlserver';
 *
 * const provider = new SqlServerProvider({
 *   Server: 'localhost',
 *   Database: 'my_app',
 *   User: 'sa',
 *   Password: 'secret',
 * });
 *
 * const skyway = new Skyway({
 *   Database: { Server: 'localhost', Database: 'my_app', User: 'sa', Password: 'secret' },
 *   Migrations: { Locations: ['./migrations'] },
 *   Provider: provider,
 * });
 *
 * const result = await skyway.Migrate();
 * await skyway.Close();
 * ```
 *
 * @packageDocumentation
 */

export { SqlServerProvider } from './sqlserver-provider';
