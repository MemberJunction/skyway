-- Tests: GO batch separator handling (SQL Server splits on GO),
-- multiple statements in one file, ALTER TABLE ADD COLUMN, FK, UNIQUE.
CREATE TABLE categories (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(50) NOT NULL UNIQUE
);
GO

ALTER TABLE widgets ADD category_id INT NULL;
GO

ALTER TABLE widgets ADD CONSTRAINT FK_widgets_categories
    FOREIGN KEY (category_id) REFERENCES categories(id);
GO

INSERT INTO categories (name) VALUES ('hardware');
INSERT INTO categories (name) VALUES ('software');
