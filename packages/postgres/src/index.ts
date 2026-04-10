/**
 * @module @memberjunction/skyway-postgres
 *
 * PostgreSQL provider for the Skyway migration engine.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { Skyway } from '@memberjunction/skyway-core';
 * import { PostgresProvider } from '@memberjunction/skyway-postgres';
 *
 * const provider = new PostgresProvider({
 *   Dialect: 'postgresql',
 *   Server: 'localhost',
 *   Database: 'my_app',
 *   User: 'postgres',
 *   Password: 'secret',
 * });
 *
 * const skyway = new Skyway({
 *   Database: { Dialect: 'postgresql', Server: 'localhost', Database: 'my_app', User: 'postgres', Password: 'secret' },
 *   Migrations: { Locations: ['./migrations-pg'] },
 *   Provider: provider,
 * });
 *
 * const result = await skyway.Migrate();
 * await skyway.Close();
 * ```
 *
 * @packageDocumentation
 */

export { PostgresProvider } from './postgres-provider';
