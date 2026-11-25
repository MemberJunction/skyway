/**
 * PasswordProvider: a short-lived token login must be asked for its password on every new
 * physical connection, so the provider is handed to node-postgres as a function, not resolved once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseConfig } from '@memberjunction/skyway-core';

const poolConfigs: Array<Record<string, unknown>> = [];

vi.mock('pg', () => {
    class Pool {
        constructor(config: Record<string, unknown>) {
            poolConfigs.push(config);
        }
        async connect() {
            return { release: () => undefined };
        }
        async end() {
            return undefined;
        }
    }
    return { Pool };
});

import { PostgresProvider } from '../postgres-provider';

const baseConfig: DatabaseConfig = {
    Dialect: 'postgresql',
    Server: 'db.example.com',
    Port: 5432,
    Database: 'app',
    User: 'migrator',
    Password: 'static-password',
};

describe('PostgresProvider password', () => {
    beforeEach(() => {
        poolConfigs.length = 0;
    });

    it('passes a PasswordProvider to node-postgres as the function itself, so each connection asks again', async () => {
        const provider = vi.fn(async () => 'token');
        await new PostgresProvider({ ...baseConfig, PasswordProvider: provider }).Connect();

        expect(poolConfigs).toHaveLength(1);
        expect(poolConfigs[0].password).toBe(provider);
        // Skyway never resolves it itself: node-postgres calls it when it opens a connection.
        expect(provider).not.toHaveBeenCalled();
    });

    it('uses Password when no PasswordProvider is set', async () => {
        await new PostgresProvider(baseConfig).Connect();
        expect(poolConfigs[0].password).toBe('static-password');
    });
});
