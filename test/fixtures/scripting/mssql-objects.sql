-- Objects whose scripts sqltoolsservice (SMO) captured in docs/reference/mssql-scripts.json.
-- Run, after the tables of test/fixtures/mssql/01-schema.sql, in a database of its own:
-- by tools/sts-script-probe.js to capture the reference, and by
-- test/drivers/mssql/scriptObjects.integration.test.ts to compare the driver with it.
-- Changing an object here means capturing again. The server login [yast_oe_probe_login] must exist.
CREATE SCHEMA [probe]
GO
CREATE SCHEMA [odd ]] schema] AUTHORIZATION [dbo]
GO
CREATE TABLE [probe].[odd ]] table] ([col ]] one] int NOT NULL, [select] int NULL, [Mixed Case] nvarchar(20) NULL)
GO
CREATE TABLE [probe].[special] (id int NOT NULL, version rowversion, doubled AS (id * 2), area geography NULL, note nvarchar(max) NULL)
GO
CREATE TABLE [probe].[temporal] (
    id int NOT NULL PRIMARY KEY, v int NULL,
    valid_from datetime2 GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
    valid_to datetime2 GENERATED ALWAYS AS ROW END HIDDEN NOT NULL,
    PERIOD FOR SYSTEM_TIME (valid_from, valid_to))
    WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = [probe].[temporal_history]))
GO
CREATE TABLE [probe].[temporal_visible] (
    id int NOT NULL PRIMARY KEY, v int NULL,
    valid_from datetime2 GENERATED ALWAYS AS ROW START NOT NULL,
    valid_to datetime2 GENERATED ALWAYS AS ROW END NOT NULL,
    PERIOD FOR SYSTEM_TIME (valid_from, valid_to))
    WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = [probe].[temporal_visible_history]))
GO
CREATE VIEW [probe].[v_customers] AS SELECT id, name FROM dbo.customers
GO
CREATE VIEW [probe].[odd ]] view] AS SELECT [col ]] one] FROM [probe].[odd ]] table]
GO
CREATE PROCEDURE [probe].[p_hello] @name nvarchar(20) = N'x' AS SELECT @name AS name
GO
CREATE FUNCTION [probe].[f_scalar] (@a int) RETURNS int AS BEGIN RETURN @a + 1 END
GO
CREATE FUNCTION [probe].[f_table] (@a int) RETURNS TABLE AS RETURN SELECT @a AS a
GO
CREATE TYPE [probe].[phone] FROM varchar(20) NOT NULL
GO
CREATE TYPE [probe].[amount] FROM decimal(12, 3) NULL
GO
CREATE TYPE [probe].[line_items] AS TABLE (
    id int NOT NULL PRIMARY KEY CLUSTERED,
    label nvarchar(50) NULL DEFAULT (N'x'),
    qty int NOT NULL CHECK (qty > 0),
    price [probe].[amount] NULL,
    INDEX ix_label NONCLUSTERED (label DESC)
)
GO
CREATE SEQUENCE [probe].[seq_full] AS bigint START WITH 10 INCREMENT BY 5 MINVALUE 1 MAXVALUE 1000 CYCLE CACHE 20
GO
CREATE SEQUENCE [probe].[seq_default]
GO
CREATE SEQUENCE [probe].[seq_small] AS smallint START WITH -5 INCREMENT BY -1 NO CACHE
GO
CREATE TABLE [probe].[all_types] (
    c_bigint bigint NULL, c_int int NULL, c_smallint smallint NULL, c_tinyint tinyint NULL,
    c_bit bit NULL, c_decimal decimal(18, 4) NULL, c_numeric numeric(5, 0) NULL,
    c_money money NULL, c_smallmoney smallmoney NULL, c_float float NULL, c_float24 float(24) NULL,
    c_real real NULL, c_date date NULL, c_time time(3) NULL, c_datetime datetime NULL,
    c_datetime2 datetime2(3) NULL, c_dto datetimeoffset NULL, c_smalldatetime smalldatetime NULL,
    c_char char(10) NULL, c_varchar varchar(50) NULL, c_varcharmax varchar(max) NULL,
    c_nchar nchar(5) NULL, c_nvarchar nvarchar(40) NULL, c_nvarcharmax nvarchar(max) NULL,
    c_text text NULL, c_ntext ntext NULL, c_binary binary(16) NULL, c_varbinary varbinary(100) NULL,
    c_varbinarymax varbinary(max) NULL, c_image image NULL, c_guid uniqueidentifier NULL,
    c_xml xml NULL, c_variant sql_variant NULL, c_hierarchy hierarchyid NULL,
    c_geometry geometry NULL, c_geography geography NULL,
    c_collated varchar(20) COLLATE French_CI_AS NULL,
    c_phone [probe].[phone] NULL, c_amount [probe].[amount] NULL,
    c_sparse int SPARSE NULL, c_rowguid uniqueidentifier ROWGUIDCOL NOT NULL DEFAULT (newsequentialid())
)
GO
CREATE TABLE [probe].[parent] (
    id bigint IDENTITY(100, 5) NOT NULL,
    code char(3) NOT NULL,
    qty int NOT NULL CONSTRAINT DF_parent_qty DEFAULT ((1)),
    price decimal(10, 2) NULL DEFAULT (0),
    total AS (qty * price) PERSISTED,
    label AS (code + N'-' + CONVERT(nvarchar(20), id)),
    created datetime2(0) NOT NULL DEFAULT (getdate()),
    CONSTRAINT PK_parent PRIMARY KEY NONCLUSTERED (id DESC, code ASC),
    CONSTRAINT UQ_parent_code UNIQUE (code),
    CONSTRAINT CK_parent_qty CHECK (qty >= 0),
    CHECK (price IS NULL OR price >= 0)
)
GO
CREATE CLUSTERED INDEX [CIX_parent_created] ON [probe].[parent] (created)
GO
CREATE TABLE [probe].[child] (
    child_id int NOT NULL CONSTRAINT PK_child PRIMARY KEY,
    parent_id bigint NULL,
    parent_code char(3) NULL,
    note nvarchar(200) NULL,
    status tinyint NOT NULL,
    CONSTRAINT FK_child_parent FOREIGN KEY (parent_id, parent_code)
        REFERENCES [probe].[parent] (id, code) ON DELETE CASCADE ON UPDATE SET NULL
)
GO
ALTER TABLE [probe].[child] WITH NOCHECK ADD CONSTRAINT [FK_child_parent_nocheck]
    FOREIGN KEY (parent_id, parent_code) REFERENCES [probe].[parent] (id, code)
GO
ALTER TABLE [probe].[child] NOCHECK CONSTRAINT [FK_child_parent_nocheck]
GO
ALTER TABLE [probe].[child] WITH NOCHECK ADD CONSTRAINT [CK_child_status] CHECK (status < 10)
GO
CREATE UNIQUE NONCLUSTERED INDEX [IX_child_note] ON [probe].[child] (note DESC) INCLUDE (status) WHERE note IS NOT NULL
GO
CREATE NONCLUSTERED INDEX [IX_child_status] ON [probe].[child] (status, parent_id) WITH (FILLFACTOR = 80)
GO
CREATE TRIGGER [probe].[trg_child_ins] ON [probe].[child] AFTER INSERT, UPDATE AS BEGIN SET NOCOUNT ON; END
GO
CREATE TRIGGER [probe].[trg_child_disabled] ON [probe].[child] FOR DELETE AS SET NOCOUNT ON
GO
DISABLE TRIGGER [probe].[trg_child_disabled] ON [probe].[child]
GO
CREATE VIEW [probe].[v_child]
WITH SCHEMABINDING
AS
SELECT child_id, note FROM [probe].[child]
GO
CREATE TRIGGER [probe].[trg_v_child] ON [probe].[v_child] INSTEAD OF INSERT AS SET NOCOUNT ON
GO
CREATE TRIGGER [trg_ddl_probe] ON DATABASE FOR CREATE_SEQUENCE AS SET NOCOUNT ON
GO
CREATE PROCEDURE [probe].[p_params]
    @id int,
    @name nvarchar(50) = N'none',
    @amount decimal(10, 2) = 1.5,
    @result int OUTPUT,
    @items [probe].[line_items] READONLY
AS
BEGIN
    SET NOCOUNT ON;
    SELECT @result = @id;
END
GO
-- A comment before the definition.
CREATE   PROCEDURE [probe].[p_noparams] AS SELECT 1 AS one
GO
SET QUOTED_IDENTIFIER OFF
GO
CREATE PROCEDURE [probe].[p_quoted_off] AS SELECT "text" AS t
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE FUNCTION [probe].[f_multi] (@from int, @to int = 10)
RETURNS @t TABLE (n int NOT NULL)
AS
BEGIN
    INSERT @t VALUES (@from);
    RETURN;
END
GO
CREATE SYNONYM [probe].[syn_child] FOR [probe].[child]
GO
CREATE USER [probe_user] WITHOUT LOGIN WITH DEFAULT_SCHEMA = [probe]
GO
CREATE ROLE [probe_role] AUTHORIZATION [dbo]
GO
ALTER ROLE [probe_role] ADD MEMBER [probe_user]
GO
CREATE APPLICATION ROLE [probe_app] WITH PASSWORD = N'Probe_Pass_1!', DEFAULT_SCHEMA = [probe]
GO
CREATE TABLE [probe].[idx_more] (
    id int NOT NULL,
    a varchar(10) NULL,
    b int NULL,
    pcode char(3) NULL FOREIGN KEY REFERENCES [probe].[parent] (code) ON DELETE SET NULL,
    twice AS (id * 2) PERSISTED NOT NULL,
    CONSTRAINT PK_idx_more PRIMARY KEY CLUSTERED (id) WITH (FILLFACTOR = 90, PAD_INDEX = ON),
    CONSTRAINT CK_idx_more_b CHECK (b <> 13)
)
GO
ALTER TABLE [probe].[idx_more] NOCHECK CONSTRAINT [CK_idx_more_b]
GO
CREATE NONCLUSTERED INDEX [IX_inc] ON [probe].[idx_more] (b) INCLUDE (a)
GO
CREATE NONCLUSTERED INDEX [IX_filter] ON [probe].[idx_more] (b) WHERE b > 0
GO
CREATE UNIQUE NONCLUSTERED INDEX [UX_b] ON [probe].[idx_more] (b DESC, id) WITH (IGNORE_DUP_KEY = ON, STATISTICS_NORECOMPUTE = ON, ALLOW_PAGE_LOCKS = OFF)
GO
CREATE NONCLUSTERED INDEX [IX_comp] ON [probe].[idx_more] (a) WITH (DATA_COMPRESSION = PAGE)
GO
CREATE VIEW [probe].[v_indexed] WITH SCHEMABINDING AS SELECT id, b FROM [probe].[idx_more]
GO
CREATE UNIQUE CLUSTERED INDEX [UCX_v_indexed] ON [probe].[v_indexed] (id)
GO
CREATE OR ALTER PROCEDURE [probe].[p_create_or_alter] AS SELECT 3 AS three
GO
/* A block comment
   before the definition. */
create proc [probe].[p_lower] @a varchar(max), @b varbinary(16) = NULL, @c datetime2(3) = '2024-01-01', @d float = 1e3, @e [probe].[phone] = '555' OUTPUT
as select @a as a
GO
CREATE VIEW [probe].[v_trailing] AS SELECT 1 AS one   


GO
CREATE SCHEMA [probe_owned] AUTHORIZATION [probe_user]
GO
CREATE ROLE [probe_role_owned] AUTHORIZATION [probe_user]
GO
CREATE USER [probe_login_user] FOR LOGIN [yast_oe_probe_login] WITH DEFAULT_SCHEMA = [dbo]
GO
