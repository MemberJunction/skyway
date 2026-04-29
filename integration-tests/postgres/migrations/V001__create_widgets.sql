-- Minimal schema exercising common PG types: SERIAL identity, TIMESTAMP default,
-- BOOLEAN default, TEXT, and an INSERT to verify post-migration state.
CREATE TABLE widgets (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    in_stock BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO widgets (name, description) VALUES ('alpha', 'first widget');
INSERT INTO widgets (name, description) VALUES ('beta', 'second widget');
