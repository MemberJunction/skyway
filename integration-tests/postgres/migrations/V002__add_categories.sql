-- Tests: ALTER TABLE ADD COLUMN, FK reference, UNIQUE constraint.
CREATE TABLE categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

ALTER TABLE widgets ADD COLUMN category_id INTEGER REFERENCES categories(id);

INSERT INTO categories (name) VALUES ('hardware');
INSERT INTO categories (name) VALUES ('software');
