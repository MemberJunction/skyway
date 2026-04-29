-- Minimal schema exercising common SQL Server types: IDENTITY, NVARCHAR,
-- BIT default, DATETIME2 default, and an INSERT to verify post-migration state.
CREATE TABLE widgets (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(100) NOT NULL,
    description NVARCHAR(MAX),
    in_stock BIT NOT NULL DEFAULT 1,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

INSERT INTO widgets (name, description) VALUES ('alpha', 'first widget');
INSERT INTO widgets (name, description) VALUES ('beta', 'second widget');
