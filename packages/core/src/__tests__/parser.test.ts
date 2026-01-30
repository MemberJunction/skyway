import { describe, it, expect } from 'vitest';
import { ParseMigrationFilename } from '../migration/parser';

const ROOT = '/migrations';

describe('ParseMigrationFilename', () => {
  describe('versioned migrations (V)', () => {
    it('parses a standard versioned migration', () => {
      const info = ParseMigrationFilename(`${ROOT}/V202601200000__Add_Users.sql`, ROOT);
      expect(info.Type).toBe('versioned');
      expect(info.Version).toBe('202601200000');
      expect(info.Description).toBe('Add Users');
      expect(info.Filename).toBe('V202601200000__Add_Users.sql');
    });

    it('handles lowercase v prefix', () => {
      const info = ParseMigrationFilename(`${ROOT}/v202601200000__Add_Table.sql`, ROOT);
      expect(info.Type).toBe('versioned');
      expect(info.Version).toBe('202601200000');
    });

    it('captures only numeric digits as version (not v3.1.x description parts)', () => {
      const info = ParseMigrationFilename(`${ROOT}/V202601200000__v3.1.x__Add_Table.sql`, ROOT);
      expect(info.Version).toBe('202601200000');
      expect(info.Description).toBe('v3.1.x  Add Table');
    });

    it('preserves single-word descriptions', () => {
      const info = ParseMigrationFilename(`${ROOT}/V1__Init.sql`, ROOT);
      expect(info.Description).toBe('Init');
    });

    it('converts underscores to spaces in description', () => {
      const info = ParseMigrationFilename(`${ROOT}/V1__Add_User_Table.sql`, ROOT);
      expect(info.Description).toBe('Add User Table');
    });
  });

  describe('baseline migrations (B)', () => {
    it('parses a baseline migration', () => {
      const info = ParseMigrationFilename(`${ROOT}/B202601122300__v3.0_Baseline.sql`, ROOT);
      expect(info.Type).toBe('baseline');
      expect(info.Version).toBe('202601122300');
      expect(info.Description).toBe('v3.0 Baseline');
    });

    it('handles lowercase b prefix', () => {
      const info = ParseMigrationFilename(`${ROOT}/b1__Init.sql`, ROOT);
      expect(info.Type).toBe('baseline');
    });
  });

  describe('repeatable migrations (R)', () => {
    it('parses a repeatable migration', () => {
      const info = ParseMigrationFilename(`${ROOT}/R__RefreshMetadata.sql`, ROOT);
      expect(info.Type).toBe('repeatable');
      expect(info.Version).toBeNull();
      expect(info.Description).toBe('RefreshMetadata');
    });

    it('handles lowercase r prefix', () => {
      const info = ParseMigrationFilename(`${ROOT}/r__Refresh.sql`, ROOT);
      expect(info.Type).toBe('repeatable');
    });

    it('converts underscores to spaces in description', () => {
      const info = ParseMigrationFilename(`${ROOT}/R__Update_Views.sql`, ROOT);
      expect(info.Description).toBe('Update Views');
    });
  });

  describe('script path', () => {
    it('computes relative script path from migration root', () => {
      const info = ParseMigrationFilename('/workspace/MJ/migrations/v3/V1__Init.sql', '/workspace/MJ/migrations');
      expect(info.ScriptPath).toBe('v3/V1__Init.sql');
    });

    it('uses filename only when file is at root', () => {
      const info = ParseMigrationFilename(`${ROOT}/V1__Init.sql`, ROOT);
      expect(info.ScriptPath).toBe('V1__Init.sql');
    });
  });

  describe('invalid filenames', () => {
    it('throws MigrationParseError for non-matching filenames', () => {
      expect(() => ParseMigrationFilename(`${ROOT}/random.sql`, ROOT)).toThrow();
    });

    it('throws for filenames missing double underscore', () => {
      expect(() => ParseMigrationFilename(`${ROOT}/V1_Init.sql`, ROOT)).toThrow();
    });

    it('throws for filenames with no .sql extension', () => {
      expect(() => ParseMigrationFilename(`${ROOT}/V1__Init.txt`, ROOT)).toThrow();
    });
  });
});
